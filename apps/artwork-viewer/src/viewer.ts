/**
 * Rijksmuseum Artwork Viewer — MCP App Client
 *
 * Interactive IIIF deep-zoom viewer for Rijksmuseum artworks.
 * Renders inline in Claude Desktop chat via MCP Apps.
 *
 * Lifecycle:
 *   ontoolinputpartial → loading with partial objectNumber
 *   ontoolinput        → loading with full objectNumber
 *   ontoolresult       → parse JSON, initialize OpenSeadragon with IIIF3 tile source
 *   onhostcontextchanged → apply theme, fonts, safe areas
 *   onteardown         → save zoom/pan state
 */

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from '@modelcontextprotocol/ext-apps/app-with-deps';

import OpenSeadragon from 'openseadragon';

// Data structure matching the JSON returned by get_artwork_image tool
interface ArtworkImageData {
  iiifId: string;
  iiifInfoUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  objectNumber: string;
  title: string;
  creator: string;
  date: string;
  license: string | null;
  physicalDimensions: string | null;
  collectionUrl: string;
  viewUUID?: string;
}

// App state
let currentData: ArtworkImageData | null = null;
let viewer: OpenSeadragon.Viewer | null = null;
let currentRotation = 0;
let isFlipped = false;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let visibilityObserver: IntersectionObserver | null = null;
let currentDisplayMode: 'inline' | 'fullscreen' | 'pip' = 'inline';
let viewUUID: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// seedObjectNumber is set ONLY on host-initiated mounts; in-viewer j/l updates
// the index but never the seed, so `k` always returns to the host's artwork.
type RelatedPeer = { objectNumber: string; iiifId: string; relationship: string };
let seedObjectNumber: string | null = null;
let viewerRelatedObjects: RelatedPeer[] = [];
let viewerRelatedIndex = -1; // -1 = on seed; 0..n-1 = on a sibling

// Selection mode state
let selectMode = false;
let selectionTracker: OpenSeadragon.MouseTracker | null = null;
let dragStart: OpenSeadragon.Point | null = null;
let selectionOverlay: HTMLDivElement | null = null;
let userHighlightEl: HTMLElement | null = null;

const HIGHLIGHT_STROKE = 'rgba(59,130,246,0.8)';
const HIGHLIGHT_FILL = 'rgba(59,130,246,0.12)';

const app = new App(
  { name: 'Rijksmuseum Artwork Viewer', version: '1.0.0' },
  { tools: { listChanged: false }, availableDisplayModes: ['inline', 'fullscreen'] },
  { autoResize: true }
);

// ── Lifecycle handlers ──────────────────────────────────────────────

app.ontoolinputpartial = (params) => {
  const args = params.arguments as { objectNumber?: string } | undefined;
  const objectNumber = args?.objectNumber || '...';
  showLoading(`Loading artwork: ${objectNumber}`);
  app.sendLog({ level: 'info', data: `Partial input: ${objectNumber}` });
};

app.ontoolinput = (params) => {
  const args = params.arguments as { objectNumber?: string } | undefined;
  const objectNumber = args?.objectNumber || 'unknown';
  showLoading(`Fetching image: ${objectNumber}`);
  app.sendLog({ level: 'info', data: `Full input received: ${objectNumber}` });
};

app.ontoolresult = (result) => {
  app.sendLog({ level: 'info', data: 'Tool result received' });

  if (result.isError) {
    showError('Error loading artwork', result.content?.[0]?.text || 'Unknown error');
    return;
  }

  const data = parseArtworkImageResult(result);
  if (data) {
    applyMountedArtwork(data, { isSeed: true });
    void fetchRelatedObjectsForCurrent(data.objectNumber);
  } else {
    showError('No image available', 'Could not find IIIF image data in the tool result.');
  }
};

// Extracts ArtworkImageData from a get_artwork_image result. Prefers
// structuredContent (post-v0.18 default); falls back to JSON in text blocks
// for clients with STRUCTURED_CONTENT=false.
function parseArtworkImageResult(
  result: { structuredContent?: unknown; content?: { type?: string; text?: string }[] },
): ArtworkImageData | null {
  const sc = result.structuredContent as Record<string, unknown> | undefined;
  if (sc && typeof sc.iiifInfoUrl === 'string') {
    return sc as unknown as ArtworkImageData;
  }
  for (const block of result.content ?? []) {
    if (block?.type === 'text' && block.text?.startsWith('{')) {
      try {
        const parsed = JSON.parse(block.text);
        if (parsed.iiifInfoUrl) return parsed as ArtworkImageData;
      } catch { /* try next block */ }
    }
  }
  return null;
}

// Mount an artwork into the viewer. `isSeed: true` for host-initiated mounts
// (resets the j/k/l anchor); `false` for in-viewer navigation, which preserves
// the seed so `k` always returns the user to the artwork the host originally
// mounted.
function applyMountedArtwork(data: ArtworkImageData, opts: { isSeed: boolean }): void {
  currentData = data;
  if (opts.isSeed) {
    seedObjectNumber = data.objectNumber;
    viewerRelatedIndex = -1;
  }
  renderViewer(data);
  updateModelContext(data);
  if (data.viewUUID) {
    viewUUID = data.viewUUID;
    startPolling();
  }
}

function applyHostContext(
  params: Parameters<NonNullable<typeof app.onhostcontextchanged>>[0]
): void {
  if (params.theme) {
    applyDocumentTheme(params.theme);
  }
  if (params.styles?.variables) {
    applyHostStyleVariables(params.styles.variables);
  }
  if (params.styles?.css?.fonts) {
    applyHostFonts(params.styles.css.fonts);
  }
  if (params.safeAreaInsets) {
    const { top, right, bottom, left } = params.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
  if (params.displayMode) {
    currentDisplayMode = params.displayMode;
    updateFullscreenButton();
  }
}

app.onhostcontextchanged = applyHostContext;

app.onteardown = async () => {
  stopPolling();
  teardownSelectionTracker();
  const state: Record<string, unknown> = {};
  if (currentData) {
    state.objectNumber = currentData.objectNumber;
  }
  if (viewer) {
    state.zoom = viewer.viewport.getZoom();
    state.center = viewer.viewport.getCenter();
    state.rotation = currentRotation;
    state.flipped = isFlipped;
  }
  return state;
};

// ── Viewer actions ──────────────────────────────────────────────────

function rotateBy(degrees: number): void {
  if (!viewer) return;
  currentRotation = (currentRotation + degrees + 360) % 360;
  viewer.viewport.setRotation(currentRotation);
}

function toggleFlip(): void {
  if (!viewer) return;
  isFlipped = !isFlipped;
  viewer.viewport.setFlip(isFlipped);
}

function resetView(): void {
  if (!viewer) return;
  currentRotation = 0;
  isFlipped = false;
  viewer.viewport.setRotation(0);
  viewer.viewport.setFlip(false);
  viewer.viewport.goHome();
  clearAllOverlays();
}

function setNavButtonsEnabled(enabled: boolean): void {
  const prev = document.getElementById('prev-related') as HTMLButtonElement | null;
  const next = document.getElementById('next-related') as HTMLButtonElement | null;
  if (prev) prev.disabled = !enabled;
  if (next) next.disabled = !enabled;
}

async function fetchRelatedObjectsForCurrent(objectNumber: string): Promise<void> {
  viewerRelatedObjects = [];
  setNavButtonsEnabled(false);
  try {
    const result = await app.callServerTool({
      name: 'get_artwork_details',
      arguments: { objectNumber },
    });
    if (result.isError) return;
    const sc = result.structuredContent as
      | { relatedObjects?: { objectNumber: string | null; iiifId: string | null; relationship: string }[] }
      | undefined;
    const peers = (sc?.relatedObjects ?? []).filter(
      (r): r is RelatedPeer => !!r.objectNumber && !!r.iiifId,
    );
    viewerRelatedObjects = peers;
    setNavButtonsEnabled(peers.length > 0);
  } catch {
    /* keep buttons disabled, fail silent */
  }
}

async function navigateRelated(direction: 'prev' | 'next'): Promise<void> {
  if (viewerRelatedObjects.length === 0) return;
  const len = viewerRelatedObjects.length;
  if (viewerRelatedIndex === -1) {
    viewerRelatedIndex = direction === 'next' ? 0 : len - 1;
  } else {
    viewerRelatedIndex = direction === 'next'
      ? (viewerRelatedIndex + 1) % len
      : (viewerRelatedIndex - 1 + len) % len;
  }
  await mountArtwork(viewerRelatedObjects[viewerRelatedIndex].objectNumber);
}

async function returnToSeed(): Promise<void> {
  if (!seedObjectNumber || viewerRelatedIndex === -1) return;
  viewerRelatedIndex = -1;
  await mountArtwork(seedObjectNumber);
}

async function mountArtwork(objectNumber: string): Promise<void> {
  try {
    const result = await app.callServerTool({
      name: 'get_artwork_image',
      arguments: { objectNumber },
    });
    if (result.isError) return;
    const data = parseArtworkImageResult(result);
    if (data) applyMountedArtwork(data, { isSeed: false });
  } catch {
    /* fail silent — user keeps current view */
  }
}

async function toggleFullscreen(): Promise<void> {
  const target = currentDisplayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  try {
    const result = await app.requestDisplayMode({ mode: target });
    currentDisplayMode = result.mode;
    updateFullscreenButton();
  } catch {
    // Host doesn't support display mode changes — try browser fullscreen as fallback
    const container = document.querySelector('.main');
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen().catch(() => {});
    }
  }
}

function updateFullscreenButton(): void {
  const btn = document.getElementById('fullscreen');
  if (btn) {
    const isFs = currentDisplayMode === 'fullscreen' || !!document.fullscreenElement;
    btn.textContent = isFs ? '⊠' : '⊞';
    btn.title = isFs ? 'Exit Fullscreen' : 'Fullscreen';
  }
}

// ── Selection mode ───────────────────────────────────────────────

function toggleSelectMode(): void {
  if (!viewer) return;
  selectMode = !selectMode;
  viewer.setMouseNavEnabled(!selectMode);
  updateSelectButton();

  if (selectMode) {
    setupSelectionTracker();
  } else {
    teardownSelectionTracker();
  }
}

function updateSelectButton(): void {
  const btn = document.getElementById('select-mode');
  if (btn) {
    btn.textContent = '☐';
    btn.title = selectMode ? 'Exit Select Mode (i)' : 'Select Region (i)';
    btn.classList.toggle('active', selectMode);
  }
  // Change cursor on the OSD canvas
  const canvas = document.getElementById('openseadragon-viewer');
  if (canvas) canvas.style.cursor = selectMode ? 'crosshair' : '';
}

function setupSelectionTracker(): void {
  if (!viewer || selectionTracker) return;

  selectionTracker = new OpenSeadragon.MouseTracker({
    element: viewer.canvas,
    pressHandler: onSelectionPress,
    dragHandler: onSelectionDrag,
    releaseHandler: onSelectionRelease,
  });
}

function teardownSelectionTracker(): void {
  if (selectionTracker) {
    selectionTracker.destroy();
    selectionTracker = null;
  }
  dragStart = null;
  removeSelectionPreview();
}

interface SelectionRegion {
  x: number; y: number; w: number; h: number;
  pctX: number; pctY: number; pctW: number; pctH: number;
}

function computeSelectionRegion(
  a: OpenSeadragon.Point, b: OpenSeadragon.Point,
  imgWidth: number, imgHeight: number
): SelectionRegion {
  const x1 = Math.max(0, Math.min(a.x, b.x));
  const y1 = Math.max(0, Math.min(a.y, b.y));
  const x2 = Math.min(imgWidth, Math.max(a.x, b.x));
  const y2 = Math.min(imgHeight, Math.max(a.y, b.y));
  return {
    x: x1, y: y1, w: x2 - x1, h: y2 - y1,
    pctX: (x1 / imgWidth) * 100, pctY: (y1 / imgHeight) * 100,
    pctW: ((x2 - x1) / imgWidth) * 100, pctH: ((y2 - y1) / imgHeight) * 100,
  };
}

function onSelectionPress(event: OpenSeadragon.MouseTrackerEvent): void {
  if (!viewer || !event.position) return;
  dragStart = viewer.viewport.viewerElementToImageCoordinates(event.position);
  removeSelectionPreview();
}

function onSelectionDrag(event: OpenSeadragon.MouseTrackerEvent): void {
  if (!viewer || !dragStart || !event.position || !currentData) return;
  const dragEnd = viewer.viewport.viewerElementToImageCoordinates(event.position);
  const r = computeSelectionRegion(dragStart, dragEnd, currentData.width, currentData.height);

  if (r.pctW < 0.5 || r.pctH < 0.5) return; // too small to show

  const rect = viewer.viewport.imageToViewportRectangle(
    new OpenSeadragon.Rect(r.x, r.y, r.w, r.h)
  );
  showSelectionPreview(rect);
}

function onSelectionRelease(event: OpenSeadragon.MouseTrackerEvent): void {
  if (!viewer || !dragStart || !event.position || !currentData) {
    dragStart = null;
    return;
  }

  const dragEnd = viewer.viewport.viewerElementToImageCoordinates(event.position);
  const r = computeSelectionRegion(dragStart, dragEnd, currentData.width, currentData.height);

  dragStart = null;
  removeSelectionPreview();

  if (r.pctW < 1 || r.pctH < 1) return; // too small — accidental click

  // Remove previous user highlight (only one at a time)
  clearUserHighlight();

  const region = `pct:${r.pctX.toFixed(1)},${r.pctY.toFixed(1)},${r.pctW.toFixed(1)},${r.pctH.toFixed(1)}`;
  userHighlightEl = addRegionOverlay(region, 'Highlight', HIGHLIGHT_STROKE, HIGHLIGHT_FILL);
  toggleSelectMode();
  sendSelectionToChat(region);
}

function showSelectionPreview(rect: OpenSeadragon.Rect): void {
  if (!viewer) return;

  if (!selectionOverlay) {
    selectionOverlay = document.createElement('div');
    selectionOverlay.className = 'selection-preview';
    selectionOverlay.style.border = `2px dashed ${HIGHLIGHT_STROKE}`;
    selectionOverlay.style.background = HIGHLIGHT_FILL;
    selectionOverlay.style.pointerEvents = 'none';
    viewer.addOverlay({ element: selectionOverlay, location: rect });
  } else {
    viewer.updateOverlay(selectionOverlay, rect);
  }
}

function removeSelectionPreview(): void {
  if (selectionOverlay && viewer) {
    viewer.removeOverlay(selectionOverlay);
    selectionOverlay = null;
  }
}

function clearUserHighlight(): void {
  if (userHighlightEl && viewer) {
    viewer.removeOverlay(userHighlightEl);
    const idx = overlayElements.indexOf(userHighlightEl);
    if (idx >= 0) overlayElements.splice(idx, 1);
    userHighlightEl = null;
  }
}

async function sendSelectionToChat(region: string): Promise<void> {
  if (!currentData) return;
  const { objectNumber, title } = currentData;
  const message = `[Highlight: region ${region} on "${title}" (${objectNumber})]`;
  try {
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: message }],
    });
    app.sendLog({ level: 'info', data: `Highlight sent: ${region}` });
  } catch {
    // sendMessage may not be supported — update model context as fallback
    app.updateModelContext({
      content: [{ type: 'text', text: `Highlight: region ${region} on ${objectNumber}` }],
    });
    app.sendLog({ level: 'info', data: `Highlight added to context: ${region}` });
  }
}

// ── Rendering ───────────────────────────────────────────────────────

function renderViewer(data: ArtworkImageData): void {
  const appEl = document.getElementById('app');
  if (!appEl) return;

  const collectionUrl = sanitizeUrl(data.collectionUrl);

  appEl.innerHTML = `
    <div class="main">
      <header class="header">
        <div class="header-title-row">
          <h1 class="copyable" data-copy="${escapeHtml(data.title)}" data-tooltip="Click to copy">${escapeHtml(data.title)}</h1>
          <div class="external-links">
            <a href="${collectionUrl}" data-external-url="${collectionUrl}">Rijksmuseum</a>
          </div>
        </div>
        <div class="metadata">
          <span class="copyable" data-copy="${escapeHtml(data.creator)}" data-tooltip="Click to copy">${escapeHtml(data.creator)}</span>
          <span>${escapeHtml(data.date)}</span>
          <span class="copyable" data-copy="${escapeHtml(data.objectNumber)}" data-tooltip="Click to copy">${escapeHtml(data.objectNumber)}</span>
        </div>
      </header>

      <div class="content">
        <div id="openseadragon-viewer"></div>
        <div class="image-controls">
          <button id="show-shortcuts" title="Keyboard Shortcuts (?)">?</button>
          <button id="zoom-in" title="Zoom In (+)">+</button>
          <button id="zoom-out" title="Zoom Out (-)">&minus;</button>
          <button id="reset-view" title="Reset / return to seed (0 / k)">Reset</button>
          <button id="prev-related" title="Previous related (j)" disabled>&#9664;</button>
          <button id="next-related" title="Next related (l)" disabled>&#9654;</button>
          <button id="select-mode" title="Select Region (i)">&#9744;</button>
        </div>
        <div id="shortcuts-overlay" class="shortcuts-overlay hidden">
          <div class="shortcuts-content">
            <div class="shortcuts-header">Keyboard Shortcuts</div>
            <div class="shortcuts-list">
              <div class="shortcut-row"><kbd>&#8679;&uarr;</kbd> / <kbd>&#8679;&darr;</kbd><span>Zoom in / out</span></div>
              <div class="shortcut-row"><kbd>+</kbd> / <kbd>&minus;</kbd><span>Zoom in / out</span></div>
              <div class="shortcut-row"><kbd>0</kbd> / <kbd>k</kbd><span>Reset view / return to seed</span></div>
              <div class="shortcut-row"><kbd>&larr;</kbd> <kbd>&uarr;</kbd> <kbd>&rarr;</kbd> <kbd>&darr;</kbd><span>Pan</span></div>
              <div class="shortcut-row"><kbd>j</kbd> / <kbd>l</kbd><span>Previous / next related artwork</span></div>
              <div class="shortcut-row"><kbd>r</kbd> / <kbd>&#8679;r</kbd><span>Rotate right / left</span></div>
              <div class="shortcut-row"><kbd>h</kbd><span>Flip horizontal</span></div>
              <div class="shortcut-row"><kbd>f</kbd><span>Fullscreen</span></div>
              <div class="shortcut-row"><kbd>i</kbd><span>Draw highlight</span></div>
              <div class="shortcut-row"><kbd>Esc</kbd><span>Exit fullscreen / cancel</span></div>
              <div class="shortcut-row"><kbd>?</kbd><span>This help</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="footer">
        <span class="license">${(() => {
          const lic = formatLicense(data.license);
          return lic ? `<a href="${sanitizeUrl(lic.url)}" data-external-url="${sanitizeUrl(lic.url)}">${escapeHtml(lic.label)}</a>` : '';
        })()}</span>
        <span class="dimensions">${data.physicalDimensions ? escapeHtml(capitalize(data.physicalDimensions)) : ''}</span>
      </div>
    </div>
  `;

  initializeViewer(data.iiifInfoUrl);
  attachEventListeners();
  setupVisibilityObserver();

  requestAnimationFrame(() => {
    const mainEl = document.querySelector('.main');
    if (mainEl) {
      const rect = mainEl.getBoundingClientRect();
      app.sendSizeChanged({ width: rect.width, height: rect.height });
    }
  });
}

function initializeViewer(iiifInfoUrl: string): void {
  if (viewer) {
    viewer.destroy();
    viewer = null;
  }

  const container = document.getElementById('openseadragon-viewer');
  if (!container) return;

  // Use IIIF3 tile source — iiif.micr.io fully supports IIIF Image API 3
  viewer = OpenSeadragon({
    element: container,
    prefixUrl: '',
    tileSources: iiifInfoUrl,
    crossOriginPolicy: 'Anonymous' as const,
    showNavigationControl: false,
    showNavigator: true,
    navigatorPosition: 'BOTTOM_RIGHT',
    navigatorSizeRatio: 0.12,
    animationTime: 0.4,
    blendTime: 0.1,
    constrainDuringPan: true,
    maxZoomPixelRatio: 3,
    minZoomImageRatio: 0.8,
    visibilityRatio: 0.5,
    gestureSettingsMouse: { scrollToZoom: true, clickToZoom: false, dblClickToZoom: false },
  });

  // Prevent browser scroll-into-view shift when OSD canvas receives focus
  viewer.canvas.addEventListener('focus', () => { window.scrollTo(0, 0); }, true);

  viewer.addHandler('open-failed', () => {
    const viewerContainer = document.getElementById('openseadragon-viewer');
    if (viewerContainer) {
      viewerContainer.innerHTML = `
        <div class="image-error">
          <p>Image could not be loaded</p>
          <p><a href="${sanitizeUrl(iiifInfoUrl)}" target="_blank">View IIIF info</a></p>
        </div>
      `;
    }
  });
}

function attachEventListeners(): void {
  // External links via app.openLink() for sandboxed iframe
  document.querySelectorAll('a[data-external-url]').forEach((link) => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const url = (link as HTMLAnchorElement).dataset.externalUrl;
      if (url) {
        app.sendLog({ level: 'info', data: `Opening: ${url}` });
        const result = await app.openLink({ url });
        if (result.isError) {
          app.sendLog({ level: 'error', data: `Failed to open: ${url}` });
        }
      }
    });
  });

  // Click-to-copy on metadata fields
  document.querySelectorAll('.copyable').forEach((el) => {
    el.addEventListener('click', async () => {
      const htmlEl = el as HTMLElement;
      const text = htmlEl.dataset.copy;
      if (!text) return;
      if (await copyToClipboard(text)) {
        htmlEl.dataset.tooltip = 'Copied!';
        setTimeout(() => { htmlEl.dataset.tooltip = 'Click to copy'; }, 1500);
      }
    });
  });

  // Rotate (r / Shift+r) and fullscreen (f) are keyboard-only — no toolbar icons.
  document
    .getElementById('zoom-in')
    ?.addEventListener('click', () => viewer?.viewport.zoomBy(1.5));
  document
    .getElementById('zoom-out')
    ?.addEventListener('click', () => viewer?.viewport.zoomBy(0.67));
  document.getElementById('reset-view')?.addEventListener('click', resetView);
  document.getElementById('prev-related')?.addEventListener('click', () => void navigateRelated('prev'));
  document.getElementById('next-related')?.addEventListener('click', () => void navigateRelated('next'));
  document.getElementById('select-mode')?.addEventListener('click', toggleSelectMode);

  // Shortcuts overlay
  const shortcutsOverlay = document.getElementById('shortcuts-overlay');
  document.getElementById('show-shortcuts')?.addEventListener('click', () => {
    shortcutsOverlay?.classList.toggle('hidden');
  });
  shortcutsOverlay?.addEventListener('click', (e) => {
    if (e.target === shortcutsOverlay) shortcutsOverlay.classList.add('hidden');
  });

  // Keyboard shortcuts — remove previous handler to prevent accumulation
  if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
  keydownHandler = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    let handled = true;
    switch (e.key) {
      case '?':
        shortcutsOverlay?.classList.toggle('hidden');
        break;
      case 'Escape':
        shortcutsOverlay?.classList.add('hidden');
        if (selectMode) toggleSelectMode();
        else if (currentDisplayMode === 'fullscreen') toggleFullscreen();
        break;
      case 'ArrowUp':
        if (e.shiftKey) {
          viewer?.viewport.zoomBy(1.5);
        } else {
          handled = false;
        }
        break;
      case 'ArrowDown':
        if (e.shiftKey) {
          viewer?.viewport.zoomBy(1 / 1.5);
        } else {
          handled = false;
        }
        break;
      case 'r':
      case 'R':
        rotateBy(e.shiftKey ? -90 : 90);
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'F':
      case 'h':
        toggleFlip();
        break;
      case 'i':
        toggleSelectMode();
        break;
      case '0':
        resetView();
        break;
      case 'j':
        void navigateRelated('prev');
        break;
      case 'k':
        void returnToSeed();
        break;
      case 'l':
        void navigateRelated('next');
        break;
      default:
        handled = false;
        break;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', keydownHandler);
}

function setupVisibilityObserver(): void {
  if (visibilityObserver) visibilityObserver.disconnect();

  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!selectMode) viewer?.setMouseNavEnabled(entry.isIntersecting);
      }
    },
    { threshold: 0.1 }
  );
  visibilityObserver.observe(mainEl);
}

function updateModelContext(data: ArtworkImageData): void {
  const contextText = [
    `Viewing artwork: ${data.title}`,
    `Creator: ${data.creator}`,
    `Date: ${data.date}`,
    `Object number: ${data.objectNumber}`,
    `Image size: ${data.width}x${data.height}`,
  ].join('. ');

  app.updateModelContext({
    content: [{ type: 'text', text: contextText }],
  });
}

// ── Viewer navigation (polling + overlays) ──────────────────────

interface ViewerCommand {
  action: 'navigate' | 'add_overlay' | 'clear_overlays';
  region?: string;
  label?: string;
  color?: string;
}

const OVERLAY_STROKE = 'rgba(255,100,0,0.7)';
const OVERLAY_FILL = 'rgba(255,100,0,0.1)';
const overlayElements: HTMLElement[] = [];

function startPolling(): void {
  stopPolling();
  const caps = app.getHostCapabilities();
  if (!caps?.serverTools) {
    app.sendLog({ level: 'info', data: 'Polling skipped: serverTools not supported' });
    return;
  }
  pollTimer = setInterval(pollForCommands, 500);
  app.sendLog({ level: 'info', data: `Polling started for ${viewUUID}` });
}

function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollForCommands(): Promise<void> {
  if (!viewUUID) return;
  try {
    const result = await app.callServerTool({
      name: 'poll_viewer_commands',
      arguments: { viewUUID },
    });
    if (result.isError) return;
    const data = result.structuredContent as { commands?: ViewerCommand[] } | undefined;
    let commands: ViewerCommand[] = [];
    if (data?.commands) {
      commands = data.commands;
    } else {
      const textContent = result.content?.find((b: { type: string }) => b.type === 'text') as { text: string } | undefined;
      if (textContent) {
        try { commands = JSON.parse(textContent.text)?.commands ?? []; } catch { /* not JSON */ }
      }
    }
    if (commands.length) processCommands(commands);
  } catch { /* retry next interval */ }
}

function processCommands(commands: ViewerCommand[]): void {
  for (const cmd of commands) {
    switch (cmd.action) {
      case 'navigate':
        if (cmd.region) navigateToRegion(cmd.region);
        break;
      case 'add_overlay':
        if (cmd.region) addRegionOverlay(cmd.region, cmd.label, cmd.color);
        break;
      case 'clear_overlays':
        clearAllOverlays();
        break;
    }
  }
}

function navigateToRegion(region: string): void {
  if (region === 'full') { viewer?.viewport.goHome(); return; }
  const rect = iiifRegionToViewportRect(region);
  if (rect) viewer!.viewport.fitBounds(rect);
}

function iiifRegionToViewportRect(region: string): OpenSeadragon.Rect | null {
  if (!viewer || !currentData) return null;
  const { width, height } = currentData;

  const pctMatch = region.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  if (pctMatch) {
    const [, px, py, pw, ph] = pctMatch.map(Number);
    // Convert IIIF percentages to pixel coordinates, then use OSD's internal conversion
    return viewer.viewport.imageToViewportRectangle(new OpenSeadragon.Rect(
      (px / 100) * width,
      (py / 100) * height,
      (pw / 100) * width,
      (ph / 100) * height
    ));
  }

  const pxMatch = region.match(/^(\d+),(\d+),(\d+),(\d+)$/);
  if (pxMatch) {
    const [, x, y, w, h] = pxMatch.map(Number);
    return viewer.viewport.imageToViewportRectangle(new OpenSeadragon.Rect(x, y, w, h));
  }

  if (region === 'square') {
    const side = Math.min(width, height);
    const sx = (width - side) / 2;
    const sy = (height - side) / 2;
    return viewer.viewport.imageToViewportRectangle(new OpenSeadragon.Rect(sx, sy, side, side));
  }

  return null;
}

function addRegionOverlay(region: string, label?: string, color?: string, fill?: string): HTMLElement | null {
  const rect = iiifRegionToViewportRect(region);
  if (!rect || !viewer) return null;

  const el = document.createElement('div');
  el.className = 'region-overlay';
  const c = color || OVERLAY_STROKE;
  el.style.border = `2px solid ${c}`;
  if (fill) {
    el.style.background = fill;
  } else {
    // Derive low-opacity fill from rgba colors; use fixed fallback for named/hex colors
    const rgbaMatch = c.match(/^(rgba?\([^)]+,\s*)[0-9.]+\)$/);
    el.style.background = rgbaMatch ? `${rgbaMatch[1]}0.1)` : OVERLAY_FILL;
  }

  if (label) {
    const labelEl = document.createElement('span');
    labelEl.className = 'region-label';
    labelEl.textContent = label;
    el.appendChild(labelEl);
  }

  viewer.addOverlay({ element: el, location: rect });
  overlayElements.push(el);
  return el;
}

function clearAllOverlays(): void {
  for (const el of overlayElements) viewer?.removeOverlay(el);
  overlayElements.length = 0;
  userHighlightEl = null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function showLoading(message: string): void {
  const appEl = document.getElementById('app');
  if (!appEl) return;
  appEl.innerHTML = `
    <div class="loading">
      <div class="loading-spinner"></div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function showError(title: string, message: string): void {
  const appEl = document.getElementById('app');
  if (!appEl) return;
  appEl.innerHTML = `
    <div class="error">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatLicense(uri: string | null): { label: string; url: string } | null {
  if (!uri) return null;
  const lower = uri.toLowerCase();
  if (lower.includes('publicdomain/zero'))
    return { label: 'CC0 1.0', url: uri };
  if (lower.includes('publicdomain'))
    return { label: 'Public Domain Mark 1.0', url: uri };
  if (lower.includes('inc'))
    return { label: 'In Copyright', url: uri };
  return { label: 'License', url: uri };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function copyToClipboard(text: string): Promise<boolean> {
  // Try modern Clipboard API first
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* blocked in sandboxed iframe */ }
  // Fallback: hidden textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return url;
    }
  } catch {
    // Invalid URL
  }
  return '#';
}

// ── Dev mode mock ───────────────────────────────────────────────────

function loadDevMock(): void {
  console.info('[dev] No MCP host — loading mock artwork');
  const mockData: ArtworkImageData = {
    iiifId: 'PJEZO',
    iiifInfoUrl: 'https://iiif.micr.io/PJEZO/info.json',
    thumbnailUrl: '',
    width: 14645,
    height: 12158,
    objectNumber: 'SK-C-5',
    title: 'The Night Watch',
    creator: 'Rembrandt van Rijn',
    date: '1642',
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    physicalDimensions: 'height 379.5 cm x width 453.5 cm x weight 337 kg x weight 170 kg',
    collectionUrl: 'https://www.rijksmuseum.nl/en/collection/SK-C-5',
  };
  currentData = mockData;
  renderViewer(mockData);
}

// ── Connect ─────────────────────────────────────────────────────────

if (import.meta.env.DEV && window === window.parent) {
  // Not inside an iframe → standalone browser preview, skip MCP connect entirely
  loadDevMock();
} else {
  (async () => {
    try {
      await app.connect();
      app.sendLog({ level: 'info', data: 'Connected to MCP host' });

      const context = app.getHostContext();
      if (context) {
        applyHostContext(context);
      }
    } catch (error) {
      console.error('Failed to connect:', error);
      showError('Connection failed', 'Could not connect to the MCP host');
    }
  })();
}
