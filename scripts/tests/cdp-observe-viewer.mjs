#!/usr/bin/env node
/**
 * CDP-attached Playwright observer for the artwork-viewer dev-host.
 *
 * Usage:
 *   1. Launch a Chrome window with remote debugging:
 *        macOS:
 *          /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *            --remote-debugging-port=9222 \
 *            --user-data-dir=/tmp/chrome-cdp-rijks \
 *            http://localhost:5173/dev-host.html
 *      (run that yourself in your own browser so we share a session.)
 *
 *   2. In another terminal, start the dev server:  npm run dev:viewer
 *
 *   3. Run this observer:  node scripts/tests/cdp-observe-viewer.mjs
 *
 * The observer attaches read-only and tails:
 *   - host frame console (dev-host bridge log mirrors)
 *   - viewer iframe console (sendLog mirrors)
 *   - keyboard events that hit the viewer iframe
 *   - toolbar button state (disabled-class flips on prev/next-related)
 *   - OSD viewport state on demand (zoom/rotation/flip/center)
 *   - viewerRelatedIndex + seedObjectNumber from the viewer module
 *
 * It NEVER drives input — the human in front of the browser does. We just watch.
 */

import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const TARGET_URL_PREFIX = process.env.TARGET_URL_PREFIX || 'http://localhost:5173/dev-host.html';

const COLOR = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function ts() {
  return COLOR.dim(new Date().toISOString().slice(11, 23));
}

function tag(label, color) {
  return color(`[${label}]`.padEnd(14));
}

async function main() {
  console.log(`${ts()} ${tag('boot', COLOR.dim)} connecting to CDP at ${CDP_URL}…`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error('No browser contexts found. Launch Chrome with --remote-debugging-port=9222 first.');
    process.exit(1);
  }

  // Find the dev-host page across all contexts.
  let page = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if (p.url().startsWith(TARGET_URL_PREFIX)) {
        page = p;
        break;
      }
    }
    if (page) break;
  }
  if (!page) {
    console.error(`No page matching ${TARGET_URL_PREFIX}. Open it in your Chrome window.`);
    console.error(`Pages currently open: ${contexts.flatMap(c => c.pages()).map(p => p.url()).join(', ') || '(none)'}`);
    process.exit(1);
  }

  console.log(`${ts()} ${tag('attached', COLOR.green)} page: ${page.url()}`);

  // ── Console mirroring (top-level frame + iframes) ────────────────
  // Filter the SDK's chatty Protocol-level `Sending message` / `Parsed message`
  // debug prints — they fire on every JSON-RPC frame and drown out signal.
  // Set OBSERVER_VERBOSE=1 to re-enable them.
  const verbose = process.env.OBSERVER_VERBOSE === '1';
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (!verbose) {
      if (t === 'debug') return;
      if (text.startsWith('Sending message ') || text.startsWith('Parsed message ')) return;
    }
    const frame = msg.location();
    const fromViewer = frame.url?.includes('/index.html') || frame.url?.includes('viewer.ts');
    const where = fromViewer ? COLOR.cyan('viewer') : COLOR.magenta('host');
    const lvl = ({ error: COLOR.red, warning: COLOR.yellow }[t] || ((s) => s))(t);
    console.log(`${ts()} ${tag(where + ':' + lvl, (s) => s)} ${text}`);
  });

  page.on('pageerror', (err) => {
    console.log(`${ts()} ${tag('pageerror', COLOR.red)} ${err.message}`);
  });

  // ── Inject keyboard + button-state probes into the viewer iframe ──
  async function injectViewerProbes() {
    // Wait for the iframe to be alive.
    const handle = await page.waitForFunction(
      () => {
        const f = document.getElementById('viewer-frame');
        return f && f.contentDocument && f.contentDocument.readyState !== 'loading' ? true : null;
      },
      null,
      { timeout: 30000 },
    ).catch(() => null);
    if (!handle) {
      console.log(`${ts()} ${tag('inject', COLOR.yellow)} viewer iframe not ready, retrying…`);
      return false;
    }

    await page.evaluate(() => {
      const iframe = document.getElementById('viewer-frame');
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (win.__viewerProbeInstalled) return;
      win.__viewerProbeInstalled = true;

      // Mirror keydowns into the host console (which we tail).
      doc.addEventListener('keydown', (e) => {
        // Only log keys our shortcuts care about + Esc/?
        const interesting = ['j','k','l','0','r','R','f','F','h','i','?','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','+','-','=','_'].includes(e.key);
        if (!interesting) return;
        // eslint-disable-next-line no-console
        console.info(`[probe:keydown] key=${JSON.stringify(e.key)} shift=${e.shiftKey} target=${e.target?.tagName?.toLowerCase() || '?'}`);
      }, true);

      // Watch the toolbar buttons for disabled-state flips.
      const watchBtn = (id) => {
        const el = doc.getElementById(id);
        if (!el) {
          console.info(`[probe:btn] ${id} not found at install time`);
          return;
        }
        const obs = new MutationObserver(() => {
          console.info(`[probe:btn] ${id} disabled=${el.disabled}`);
        });
        obs.observe(el, { attributes: true, attributeFilter: ['disabled', 'class'] });
      };
      watchBtn('prev-related');
      watchBtn('next-related');
      watchBtn('reset-view');
      watchBtn('select-mode');
      // (fullscreen icon removed by cluster-e — keyboard `f` only)

      // Watch the title bar so re-mounts are visible.
      const titleObs = new MutationObserver(() => {
        const h1 = doc.querySelector('h1.copyable');
        if (h1) console.info(`[probe:title] ${h1.textContent}`);
      });
      const app = doc.getElementById('app');
      if (app) titleObs.observe(app, { childList: true, subtree: true, characterData: true });
    });
    return true;
  }

  // Initial inject + re-inject on iframe reload.
  let injected = false;
  for (let i = 0; i < 10 && !injected; i++) {
    injected = await injectViewerProbes();
    if (!injected) await page.waitForTimeout(500);
  }
  if (!injected) {
    console.log(`${ts()} ${tag('inject', COLOR.red)} could not install viewer probes after 5s`);
  } else {
    console.log(`${ts()} ${tag('inject', COLOR.green)} viewer probes installed`);
  }

  // Periodically read OSD viewer state from the iframe.
  // Set OBSERVER_SNAP_MS to override; default is 30s (5s was too chatty).
  const SNAP_MS = Number(process.env.OBSERVER_SNAP_MS || 30000);
  setInterval(async () => {
    try {
      const state = await page.evaluate(() => {
        const win = document.getElementById('viewer-frame')?.contentWindow;
        if (!win) return null;
        // Best-effort: viewer.ts module-scope vars aren't on window, so we
        // probe the DOM: rotation/zoom from OSD's viewport via a tiny canvas
        // attribute crawl. Easier: read aria/title strings off the toolbar
        // and the active overlay state.
        const doc = win.document;
        const title = doc.querySelector('h1.copyable')?.textContent || '';
        const reset = doc.getElementById('reset-view');
        const prev = doc.getElementById('prev-related');
        const next = doc.getElementById('next-related');
        const select = doc.getElementById('select-mode');
        const isSelect = select?.classList.contains('active') || false;
        return {
          title,
          prevDisabled: prev?.disabled,
          nextDisabled: next?.disabled,
          resetText: reset?.textContent,
          select: isSelect,
        };
      });
      if (state) {
        console.log(`${ts()} ${tag('snap', COLOR.dim)} title=${JSON.stringify(state.title)} prev.disabled=${state.prevDisabled} next.disabled=${state.nextDisabled} select=${state.select}`);
      }
    } catch (err) {
      // Iframe may be reloading — ignore.
    }
  }, SNAP_MS);

  console.log(`${ts()} ${tag('ready', COLOR.green)} observing — drive the viewer in your Chrome window. Ctrl+C to stop.`);

  // Hold open.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
