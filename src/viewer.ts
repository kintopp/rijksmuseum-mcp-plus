/**
 * Generates a self-contained HTML page with an OpenSeadragon IIIF deep-zoom viewer.
 * Loads OpenSeadragon from CDN — no server-side image proxying.
 */
export function getViewerHtml(iiifId: string, title: string = "Artwork"): string {
  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle} — Rijksmuseum Viewer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a1a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #header { padding: 12px 20px; background: #111; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 16px; }
    #header h1 { font-size: 16px; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #header a { color: #90caf9; text-decoration: none; font-size: 13px; }
    #header a:hover { text-decoration: underline; }
    #viewer { width: 100%; height: calc(100vh - 49px); }
    .openseadragon-container { background: #1a1a1a !important; }
  </style>
</head>
<body>
  <div id="header">
    <h1>${escapedTitle}</h1>
    <a href="https://iiif.micr.io/${iiifId}/full/max/0/default.jpg" target="_blank" rel="noopener">Full image ↗</a>
  </div>
  <div id="viewer"></div>

  <script src="https://cdn.jsdelivr.net/npm/openseadragon@4/build/openseadragon/openseadragon.min.js"></script>
  <script>
    OpenSeadragon({
      id: "viewer",
      tileSources: "https://iiif.micr.io/${iiifId}/info.json",
      showNavigator: true,
      navigatorPosition: "BOTTOM_RIGHT",
      navigatorSizeRatio: 0.15,
      showZoomControl: true,
      showHomeControl: true,
      showFullPageControl: true,
      showRotationControl: true,
      gestureSettingsMouse: { scrollToZoom: true },
      animationTime: 0.5,
      springStiffness: 10,
      maxZoomPixelRatio: 3,
      prefixUrl: "https://cdn.jsdelivr.net/npm/openseadragon@4/build/openseadragon/images/",
    });
  </script>
</body>
</html>`;
}
