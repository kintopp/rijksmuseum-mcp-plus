/**
 * Dev host for the artwork viewer — exercises the full MCP App protocol
 * locally so cluster-e UX (j/k/l navigation, related-buttons, fullscreen,
 * sendMessage) can be tested in a plain browser without claude.ai or
 * Claude Desktop.
 *
 * Iframes the production viewer (index.html) and uses AppBridge to answer
 * its tool calls with canned fixtures.
 */

import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { ArtworkImageData } from './viewer';

interface Fixture {
  objectNumber: string;
  iiifId: string;
  width: number;
  height: number;
  title: string;
  creator: string;
  date: string;
  license: string;
  physicalDimensions: string;
  related: { objectNumber: string; iiifId: string; relationship: string }[];
}

// Real fixtures sourced from the local vocabulary DB.
// SK-A-1115 (Battle of Waterloo) has 4 cluster-e in-scope peers ('production
// stadia') with distinct IIIF ids so navigating with j/l visibly swaps the
// image. SK-A-135 (Merry Drinker) has zero in-scope peers — the production-
// behaviour peerless case under cluster-e's filter.
const FIXTURES: Record<string, Fixture> = {
  'SK-A-1115': {
    objectNumber: 'SK-A-1115',
    iiifId: 'GebpD',
    width: 8106,
    height: 5399,
    title: 'The Battle of Waterloo',
    creator: 'Jan Willem Pieneman',
    date: '1824',
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    physicalDimensions: 'h 567 cm x w 823 cm',
    related: [
      { objectNumber: 'RP-T-1964-99',   iiifId: 'fXPEE', relationship: 'production stadia' },
      { objectNumber: 'RP-T-1964-101A', iiifId: 'IFifs', relationship: 'production stadia' },
      { objectNumber: 'RP-T-1964-102A', iiifId: 'cOJsQ', relationship: 'production stadia' },
      { objectNumber: 'RP-T-1964-103',  iiifId: 'hkPWp', relationship: 'production stadia' },
    ],
  },
  // Peers — they each carry their own real iiifId so the OSD tile source
  // actually changes between mounts.
  'RP-T-1964-99': {
    objectNumber: 'RP-T-1964-99',
    iiifId: 'fXPEE',
    width: 7266,
    height: 5090,
    title: 'Study for The Battle of Waterloo',
    creator: 'Jan Willem Pieneman',
    date: 'ca. 1824',
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    physicalDimensions: 'h 30 cm x w 48.3 cm',
    related: [
      { objectNumber: 'SK-A-1115', iiifId: 'GebpD', relationship: 'production stadia' },
    ],
  },
  'RP-T-1964-101A': {
    objectNumber: 'RP-T-1964-101A',
    iiifId: 'IFifs',
    width: 7252,
    height: 5102,
    title: 'Study for The Battle of Waterloo',
    creator: 'Jan Willem Pieneman',
    date: 'ca. 1824',
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    physicalDimensions: 'h 27.3 cm x w 37.8 cm',
    related: [
      { objectNumber: 'SK-A-1115', iiifId: 'GebpD', relationship: 'production stadia' },
    ],
  },
  'RP-T-1964-102A': {
    objectNumber: 'RP-T-1964-102A',
    iiifId: 'cOJsQ',
    width: 7258,
    height: 5130,
    title: 'Study for The Battle of Waterloo',
    creator: 'Jan Willem Pieneman',
    date: 'c. 1824',
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    physicalDimensions: 'h 29.9 cm x w 48.3 cm',
    related: [
      { objectNumber: 'SK-A-1115', iiifId: 'GebpD', relationship: 'production stadia' },
    ],
  },
  'RP-T-1964-103': {
    objectNumber: 'RP-T-1964-103',
    iiifId: 'hkPWp',
    width: 7386,
    height: 5118,
    title: 'Study for The Battle of Waterloo',
    creator: 'Jan Willem Pieneman',
    date: 'ca. 1824',
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    physicalDimensions: 'h 29.7 cm x w 48 cm',
    related: [
      { objectNumber: 'SK-A-1115', iiifId: 'GebpD', relationship: 'production stadia' },
    ],
  },
  // Peerless real artwork — has no peers in cluster-e's three in-scope
  // relationship types ('different example' / 'production stadia' / 'pendant').
  'SK-A-135': {
    objectNumber: 'SK-A-135',
    iiifId: 'CgrHr',
    width: 4639,
    height: 5551,
    title: 'The Merry Drinker',
    creator: 'Frans Hals',
    date: 'c. 1628 – c. 1630',
    license: 'http://creativecommons.org/publicdomain/zero/1.0/',
    physicalDimensions: 'h 81 cm x w 66.5 cm',
    related: [],
  },
};

const VIEW_UUID = 'dev-host-uuid-0001';

let bridge: AppBridge | null = null;
let currentDisplayMode: 'inline' | 'fullscreen' | 'pip' = 'inline';
let setupRun = 0;
let setupDocument: Document | null = null;
let setupInProgressDocument: Document | null = null;

const logEl = document.getElementById('log') as HTMLDivElement;
const stateDisplayModeEl = document.getElementById('state-display-mode') as HTMLElement;
const statePeersEl = document.getElementById('state-peers') as HTMLElement;
const stateLastToolEl = document.getElementById('state-last-tool') as HTMLElement;
const iframe = document.getElementById('viewer-frame') as HTMLIFrameElement;

function log(kind: 'tool' | 'lifecycle' | 'note' | 'error', message: string): void {
  const row = document.createElement('div');
  row.className = `row ${kind}`;
  const time = document.createElement('time');
  time.textContent = new Date().toISOString().slice(11, 23);
  const body = document.createElement('span');
  body.textContent = message;
  row.appendChild(time);
  row.appendChild(body);
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
  // Mirror to console so Playwright's console listener picks it up.
  // eslint-disable-next-line no-console
  console.info(`[dev-host:${kind}] ${message}`);
}

function fixtureToArtworkResult(f: Fixture): ArtworkImageData {
  // viewUUID intentionally omitted — its presence triggers viewer.ts startPolling()
  // which spams poll_viewer_commands every few seconds and drowns out the messages
  // we actually care about while testing.
  return {
    iiifId: f.iiifId,
    iiifInfoUrl: `https://iiif.micr.io/${f.iiifId}/info.json`,
    thumbnailUrl: `https://iiif.micr.io/${f.iiifId}/full/200,/0/default.jpg`,
    width: f.width,
    height: f.height,
    objectNumber: f.objectNumber,
    title: f.title,
    creator: f.creator,
    date: f.date,
    license: f.license,
    physicalDimensions: f.physicalDimensions,
    collectionUrl: `https://www.rijksmuseum.nl/en/collection/${f.objectNumber}`,
  };
}

function makeArtworkToolResult(objectNumber: string): {
  isError: boolean;
  content: { type: 'text'; text: string }[];
  structuredContent: ReturnType<typeof fixtureToArtworkResult>;
} | { isError: true; content: { type: 'text'; text: string }[] } {
  const f = FIXTURES[objectNumber];
  if (!f) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown objectNumber in dev fixtures: ${objectNumber}` }],
    };
  }
  const sc = fixtureToArtworkResult(f);
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(sc, null, 2) }],
    structuredContent: sc,
  };
}

function makeArtworkDetailsResult(objectNumber: string): {
  isError: boolean;
  content: { type: 'text'; text: string }[];
  structuredContent: { relatedObjects: { objectNumber: string; iiifId: string; relationship: string }[] };
} | { isError: true; content: { type: 'text'; text: string }[] } {
  const f = FIXTURES[objectNumber];
  if (!f) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown objectNumber: ${objectNumber}` }],
    };
  }
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(f.related, null, 2) }],
    structuredContent: { relatedObjects: f.related },
  };
}

async function setupBridge(): Promise<void> {
  if (bridge) {
    await bridge.close().catch(() => {});
    bridge = null;
  }

  bridge = new AppBridge(
    null, // manual handlers, no real MCP client
    { name: 'rijksmuseum-mcp-plus dev-host', version: '0.0.0' },
    { openLinks: {}, serverTools: {}, logging: {} },
  );

  const initialized = new Promise<void>((resolve) => {
    bridge!.oninitialized = () => {
      log('lifecycle', 'view initialized');
      resolve();
    };
  });

  bridge.oncalltool = async (params) => {
    const name = params.name;
    const args = (params.arguments as Record<string, unknown>) ?? {};
    // Silence poll_viewer_commands — high-frequency keepalive that adds nothing
    // for UX testing.
    if (name === 'poll_viewer_commands') {
      return { isError: false, content: [{ type: 'text', text: '{}' }], structuredContent: {} };
    }
    stateLastToolEl.textContent = `${name}(${JSON.stringify(args)})`;
    log('tool', `← ${name} ${JSON.stringify(args)}`);

    if (name === 'get_artwork_image' || name === 'remount_viewer') {
      const objectNumber = String(args.objectNumber ?? '');
      const r = makeArtworkToolResult(objectNumber);
      if (!('structuredContent' in r)) return r;
      const peerCount = FIXTURES[objectNumber]?.related.length ?? 0;
      statePeersEl.textContent = String(peerCount);
      return r;
    }
    if (name === 'get_artwork_details') {
      const objectNumber = String(args.objectNumber ?? '');
      return makeArtworkDetailsResult(objectNumber);
    }
    if (name === 'navigate_viewer' || name === 'poll_viewer_commands') {
      return {
        isError: false,
        content: [{ type: 'text', text: '{}' }],
        structuredContent: {},
      };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `Unhandled tool in dev-host: ${name}` }],
    };
  };

  bridge.onrequestdisplaymode = async ({ mode }) => {
    currentDisplayMode = mode;
    stateDisplayModeEl.textContent = mode;
    log('lifecycle', `displayMode → ${mode}`);
    return { mode };
  };

  bridge.onupdatemodelcontext = async (params) => {
    log('lifecycle', `updateModelContext: ${JSON.stringify(params).slice(0, 120)}`);
    return {};
  };

  bridge.onmessage = async (params) => {
    log('lifecycle', `sendMessage: ${JSON.stringify(params).slice(0, 200)}`);
    return {};
  };

  bridge.onopenlink = async ({ url }) => {
    log('lifecycle', `openLink: ${url}`);
    return {};
  };

  bridge.onloggingmessage = (params) => {
    const data = typeof params.data === 'string' ? params.data : JSON.stringify(params.data);
    log('note', `viewer log [${params.level}]: ${data}`);
  };

  if (!iframe.contentWindow) {
    log('error', 'iframe.contentWindow is null');
    return;
  }
  const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
  await bridge.connect(transport);
  log('lifecycle', 'bridge connected');
  await initialized;
}

async function mount(objectNumber: string): Promise<void> {
  if (!bridge) {
    log('error', 'bridge not ready');
    return;
  }
  const r = makeArtworkToolResult(objectNumber);
  if (!('structuredContent' in r)) {
    log('error', `cannot mount: ${objectNumber}`);
    return;
  }
  log('lifecycle', `mounting ${objectNumber}`);
  await bridge.sendToolInputPartial({ arguments: { objectNumber: objectNumber.slice(0, 3) } });
  await bridge.sendToolInput({ arguments: { objectNumber } });
  await bridge.sendToolResult({
    isError: false,
    content: r.content,
    structuredContent: r.structuredContent,
  });
}

async function setupBridgeAndAutoMount(): Promise<void> {
  const frameDocument = iframe.contentDocument;
  if (!frameDocument) return;
  if (setupDocument === frameDocument || setupInProgressDocument === frameDocument) return;

  setupInProgressDocument = frameDocument;
  const run = ++setupRun;
  try {
    await setupBridge();
    if (run !== setupRun) return;
    setupDocument = frameDocument;
    // Auto-mount the seed so the viewer is immediately usable when the page loads.
    await mount('SK-A-1115');
  } finally {
    if (setupInProgressDocument === frameDocument) setupInProgressDocument = null;
  }
}

function bindControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-mount]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.mount;
      if (action === 'seed') void mount('SK-A-1115');
      else if (action === 'peerless') void mount('SK-A-135');
      else if (action === 'reload') iframe.src = iframe.dataset.src ?? './index.html';
    });
  });
}

iframe.addEventListener('load', async () => {
  await setupBridgeAndAutoMount();
});

bindControls();
iframe.src = iframe.dataset.src ?? './index.html';

// Surface uncaught errors in the bridge log so they're visible without devtools.
window.addEventListener('error', (e) => log('error', `window error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log('error', `unhandled rejection: ${String(e.reason)}`));

// Expose a probe object for the Playwright observer to read viewer state
// out of the iframe. Same-origin so cross-frame property access is allowed.
declare global {
  interface Window {
    __devHost: {
      bridge: () => AppBridge | null;
      mount: (objectNumber: string) => Promise<void>;
      iframe: () => HTMLIFrameElement;
      log: (msg: string) => void;
    };
  }
}
window.__devHost = {
  bridge: () => bridge,
  mount,
  iframe: () => iframe,
  log: (msg: string) => log('note', msg),
};
