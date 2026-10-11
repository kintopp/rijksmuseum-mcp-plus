#!/usr/bin/env node
// Render a claude.ai "visualize" widget to a static PNG for docs/research-scenarios.md.
// Shared claude.ai transcripts hide interactive visuals, so each scenario carries a still.
//
// Input is the show_widget tool input ({title, widget_code}) saved as JSON from the
// conversation API (chat_messages[].content[] where name === "visualize:show_widget").
//
//   node scripts/render-widget.mjs <widget.json> <out.png> [--width 776]
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const widthIdx = args.indexOf("--width");
const width = widthIdx >= 0 ? Number(args.splice(widthIdx, 2)[1]) : 776;
const [inPath, outPath] = args;
if (!inPath || !outPath) {
  console.error("usage: render-widget.mjs <widget.json> <out.png> [--width 776]");
  process.exit(2);
}

const { widget_code: code } = JSON.parse(readFileSync(inPath, "utf8"));

// Light-theme approximation of the host design system the widget code assumes:
// CSS variables, the SVG text/shape classes and the c-{ramp} colour classes
// (50 fill, 600 stroke, 800 title, 600 subtitle; direct-child selectors as in the host).
const RAMPS = {
  purple: ["#EEEDFE", "#534AB7", "#3C3489"], teal: ["#E1F5EE", "#0F6E56", "#085041"],
  coral: ["#FAECE7", "#993C1D", "#712B13"], pink: ["#FBEAF0", "#993556", "#72243E"],
  gray: ["#F1EFE8", "#5F5E5A", "#444441"], blue: ["#E6F1FB", "#185FA5", "#0C447C"],
  green: ["#EAF3DE", "#3B6D11", "#27500A"], amber: ["#FAEEDA", "#854F0B", "#633806"],
  red: ["#FCEBEB", "#A32D2D", "#791F1F"],
};
const rampCss = Object.entries(RAMPS).map(([k, [fill, stroke, text]]) =>
  `.c-${k}>rect,.c-${k}>circle,.c-${k}>ellipse,.c-${k}>polygon,rect.c-${k},circle.c-${k},ellipse.c-${k}{fill:${fill};stroke:${stroke};stroke-width:.5px}` +
  `.c-${k}>.t,.c-${k}>.th{fill:${text}}.c-${k}>.ts{fill:${stroke}}`).join("\n");

const html = `<!doctype html><html data-mode="light"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css">
<style>
:root{--surface-0:#faf9f5;--surface-1:#f5f4ef;--surface-2:#ffffff;
--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#898781;
--text-accent:#185FA5;--text-danger:#A32D2D;--text-success:#3B6D11;--text-warning:#854F0B;
--bg-accent:#E6F1FB;--bg-danger:#FCEBEB;--bg-success:#EAF3DE;--bg-warning:#FAEEDA;
--border:#e1e0d9;--border-strong:#c3c2b7;--border-stronger:#898781;
--border-accent:#85B7EB;--border-danger:#F09595;--border-success:#97C459;--border-warning:#EF9F27;
--font-sans:system-ui,-apple-system,"Segoe UI",sans-serif;--font-voice:Georgia,serif;--font-mono:ui-monospace,Menlo,monospace;
--radius:8px;--pad-sm:8px;--pad-md:12px;--pad-lg:16px;--pad-xl:24px;--gap-xs:4px;--gap-sm:8px;--gap-md:12px;--gap-lg:16px;--gap-xl:24px;
--p:var(--text-primary);--s:var(--text-secondary);--t:var(--text-muted);--bg2:var(--surface-1);--b:var(--border);color-scheme:light}
body{margin:0;padding:20px 48px;background:#fff;color:var(--text-primary);font:14px/1.5 var(--font-sans)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
svg{overflow:visible}
svg text{font-family:var(--font-sans)}
.t{font-size:14px;fill:var(--p)}.ts{font-size:12px;fill:var(--s)}.th{font-size:14px;font-weight:500;fill:var(--p)}
.box{fill:var(--surface-1);stroke:var(--border-strong);stroke-width:.5px}
.arr{stroke:var(--s);stroke-width:1.5px;fill:none}
.leader{stroke:var(--t);stroke-width:.5px;stroke-dasharray:3 3;fill:none}
${rampCss}
</style></head><body><main id="root">${code}</main></body></html>`;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2, colorScheme: "light" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.locator("body").screenshot({ path: outPath });
await browser.close();
if (errors.length) {
  console.error(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
console.error(`wrote ${outPath}`);
