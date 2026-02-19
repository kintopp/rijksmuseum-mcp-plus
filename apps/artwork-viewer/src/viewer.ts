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
} from 'https://unpkg.com/@modelcontextprotocol/ext-apps@1.0.1/app-with-deps';

declare const OpenSeadragon: typeof import('openseadragon');

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
}

// App state
let currentData: ArtworkImageData | null = null;
let viewer: OpenSeadragon.Viewer | null = null;
let currentRotation = 0;
let isFlipped = false;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let visibilityObserver: IntersectionObserver | null = null;

const app = new App(
  { name: 'Rijksmuseum Artwork Viewer', version: '1.0.0' },
  { tools: { listChanged: false } },
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

  // Parse artwork data from JSON content blocks
  let data: ArtworkImageData | null = null;

  // Try each text content block for valid JSON
  if (result.content) {
    for (const block of result.content) {
      if (block?.type === 'text' && block.text.startsWith('{')) {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed.iiifInfoUrl) {
            data = parsed as ArtworkImageData;
            break;
          }
        } catch {
          // Not valid JSON, continue
        }
      }
    }
  }

  if (data) {
    currentData = data;
    renderViewer(data);
    updateModelContext(data);
  } else {
    showError('No image available', 'Could not find IIIF image data in the tool result.');
  }
};

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
}

app.onhostcontextchanged = applyHostContext;

app.onteardown = async () => {
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
}

function toggleFullscreen(): void {
  const container = document.querySelector('.main');
  if (!container) return;

  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    container.requestFullscreen();
  }
}

function updateFullscreenButton(): void {
  const btn = document.getElementById('fullscreen');
  if (btn) {
    btn.textContent = document.fullscreenElement ? '⊠' : '⊞';
    btn.title = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
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
          <h1 class="copyable" data-copy="${escapeHtml(data.title)}" title="Click to copy">${escapeHtml(data.title)}</h1>
          <div class="external-links">
            <a href="${collectionUrl}" data-external-url="${collectionUrl}">Rijksmuseum</a>
          </div>
        </div>
        <div class="metadata">
          <span class="copyable" data-copy="${escapeHtml(data.creator)}" title="Click to copy">${escapeHtml(data.creator)}</span>
          <span>${escapeHtml(data.date)}</span>
          <span class="copyable" data-copy="${escapeHtml(data.objectNumber)}" title="Click to copy">${escapeHtml(data.objectNumber)}</span>
        </div>
      </header>

      <div class="content">
        <div id="openseadragon-viewer"></div>
        <div class="image-controls">
          <button id="show-shortcuts" title="Keyboard Shortcuts">?</button>
          <button id="zoom-in" title="Zoom In">+</button>
          <button id="zoom-out" title="Zoom Out">&minus;</button>
          <button id="reset-view" title="Reset View">Reset</button>
          <button id="rotate-left" title="Rotate Left">&#8634;</button>
          <button id="rotate-right" title="Rotate Right">&#8635;</button>
          <button id="flip-h" title="Flip Horizontal">&#8660;</button>
        </div>
        <div id="shortcuts-overlay" class="shortcuts-overlay hidden">
          <div class="shortcuts-content">
            <div class="shortcuts-header">Keyboard Shortcuts</div>
            <div class="shortcuts-list">
              <div class="shortcut-row"><kbd>&#8679;&uarr;</kbd> / <kbd>&#8679;&darr;</kbd><span>Zoom in / out</span></div>
              <div class="shortcut-row"><kbd>+</kbd> / <kbd>&minus;</kbd><span>Zoom in / out</span></div>
              <div class="shortcut-row"><kbd>0</kbd><span>Reset view</span></div>
              <div class="shortcut-row"><kbd>&larr;</kbd> <kbd>&uarr;</kbd> <kbd>&rarr;</kbd> <kbd>&darr;</kbd><span>Pan</span></div>
              <div class="shortcut-row"><kbd>R</kbd><span>Rotate right</span></div>
              <div class="shortcut-row"><kbd>&#8679;R</kbd><span>Rotate left</span></div>
              <div class="shortcut-row"><kbd>&#8679;F</kbd><span>Flip horizontal</span></div>
              <div class="shortcut-row"><kbd>f</kbd><span>Fullscreen</span></div>
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
    prefixUrl:
      'https://cdn.jsdelivr.net/npm/openseadragon@6/build/openseadragon/images/',
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
    gestureSettingsMouse: { scrollToZoom: true },
  });

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
        htmlEl.title = 'Copied!';
        setTimeout(() => { htmlEl.title = 'Click to copy'; }, 1500);
      }
    });
  });

  // Zoom/rotate controls
  document
    .getElementById('zoom-in')
    ?.addEventListener('click', () => viewer?.viewport.zoomBy(1.5));
  document
    .getElementById('zoom-out')
    ?.addEventListener('click', () => viewer?.viewport.zoomBy(0.67));
  document.getElementById('reset-view')?.addEventListener('click', resetView);
  document.getElementById('rotate-left')?.addEventListener('click', () => rotateBy(-90));
  document.getElementById('rotate-right')?.addEventListener('click', () => rotateBy(90));
  document.getElementById('flip-h')?.addEventListener('click', toggleFlip);

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

    switch (e.key) {
      case '?':
        shortcutsOverlay?.classList.toggle('hidden');
        break;
      case 'Escape':
        shortcutsOverlay?.classList.add('hidden');
        break;
      case 'ArrowUp':
        if (e.shiftKey) {
          e.preventDefault();
          viewer?.viewport.zoomBy(1.5);
        }
        break;
      case 'ArrowDown':
        if (e.shiftKey) {
          e.preventDefault();
          viewer?.viewport.zoomBy(1 / 1.5);
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
        toggleFlip();
        break;
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
        viewer?.setMouseNavEnabled(entry.isIntersecting);
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
