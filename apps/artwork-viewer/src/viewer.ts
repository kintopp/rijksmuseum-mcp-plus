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
  collectionUrl: string;
}

// App state
let currentData: ArtworkImageData | null = null;
let viewer: OpenSeadragon.Viewer | null = null;
let currentRotation = 0;
let isFlipped = false;

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

// ── Rendering ───────────────────────────────────────────────────────

function renderViewer(data: ArtworkImageData): void {
  const appEl = document.getElementById('app');
  if (!appEl) return;

  const collectionUrl = sanitizeUrl(data.collectionUrl);

  appEl.innerHTML = `
    <div class="main">
      <header class="header">
        <div class="header-title-row">
          <h1>${escapeHtml(data.title)}</h1>
          <div class="external-links">
            <a href="${collectionUrl}" data-external-url="${collectionUrl}">Rijksmuseum</a>
          </div>
        </div>
        <div class="metadata">
          <span>${escapeHtml(data.creator)}</span>
          <span>${escapeHtml(data.date)}</span>
          <span>${escapeHtml(data.objectNumber)}</span>
        </div>
      </header>

      <div class="content">
        <div id="openseadragon-viewer"></div>
        <div class="image-controls">
          <button id="show-shortcuts" title="Keyboard Shortcuts">?</button>
          <button id="zoom-in" title="Zoom In">+</button>
          <button id="zoom-out" title="Zoom Out">&minus;</button>
          <button id="reset-view" title="Reset View">Reset</button>
          <span class="control-separator"></span>
          <button id="rotate-left" title="Rotate Left">&#8634;</button>
          <button id="rotate-right" title="Rotate Right">&#8635;</button>
          <span class="control-separator"></span>
          <button id="flip-h" title="Flip Horizontal">&#8660;</button>
        </div>
        <div id="shortcuts-overlay" class="shortcuts-overlay hidden">
          <div class="shortcuts-content">
            <div class="shortcuts-header">Keyboard Shortcuts</div>
            <div class="shortcuts-list">
              <div class="shortcut-row"><kbd>+</kbd> / <kbd>&minus;</kbd><span>Zoom in / out</span></div>
              <div class="shortcut-row"><kbd>0</kbd><span>Reset view</span></div>
              <div class="shortcut-row"><kbd>&larr;</kbd> <kbd>&uarr;</kbd> <kbd>&rarr;</kbd> <kbd>&darr;</kbd><span>Pan</span></div>
              <div class="shortcut-row"><kbd>R</kbd><span>Rotate right</span></div>
              <div class="shortcut-row"><kbd>&#8679;R</kbd><span>Rotate left</span></div>
              <div class="shortcut-row"><kbd>F</kbd><span>Flip horizontal</span></div>
              <div class="shortcut-row"><kbd>?</kbd><span>This help</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="footer">
        <span>${escapeHtml(data.objectNumber)}</span>
        <span class="dimensions">${data.width} &times; ${data.height} px</span>
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
      'https://cdn.jsdelivr.net/npm/openseadragon@4.1.1/build/openseadragon/images/',
    tileSources: iiifInfoUrl,
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
          <p><a href="${iiifInfoUrl}" target="_blank">View IIIF info</a></p>
        </div>
      `;
    }
  });
}

function attachEventListeners(): void {
  // External links via app.openLink() for sandboxed iframe
  document.querySelectorAll('.external-links a').forEach((link) => {
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

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    switch (e.key) {
      case '?':
        shortcutsOverlay?.classList.toggle('hidden');
        break;
      case 'Escape':
        shortcutsOverlay?.classList.add('hidden');
        break;
      case 'r':
      case 'R':
        rotateBy(e.shiftKey ? -90 : 90);
        break;
      case 'f':
      case 'F':
        toggleFlip();
        break;
    }
  });
}

function setupVisibilityObserver(): void {
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        viewer?.setMouseNavEnabled(entry.isIntersecting);
      }
    },
    { threshold: 0.1 }
  );
  observer.observe(mainEl);
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

// ── Connect ─────────────────────────────────────────────────────────

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
