#!/usr/bin/env node
/**
 * Insight Trimmer TUI — review and delete stale insights from INSIGHTS.md.
 *
 * Usage: node scripts/insights-tui.mjs [path]
 *   Default path: offline/INSIGHTS.md (relative to project root)
 *
 * Keys: ←/→ navigate, d delete, q quit (saves), past-end saves and exits
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = process.argv[2] || resolve(__dirname, '..', 'offline', 'INSIGHTS.md');

// ─── Parse ────────────────────────────────────────────────────────────────────

const raw = readFileSync(filePath, 'utf-8');
const lines = raw.split('\n');

// File header = everything before the first session or insight heading.
let headerEndIdx = lines.findIndex(l => /^## Session:/.test(l) || /^### \d+\./.test(l));
if (headerEndIdx === -1) {
  console.log('No insight entries found.');
  process.exit(0);
}
const fileHeader = lines.slice(0, headerEndIdx).join('\n').replace(/\n+$/, '');

/** @typedef {{ sessionHeader: string|null, heading: string, body: string, deleted: boolean }} Insight */
/** @type {Insight[]} */
const insights = [];

let currentSessionHeader = null;
let isFirstInSession = true;

for (let i = headerEndIdx; i < lines.length; i++) {
  const line = lines[i];

  // Session header: ## Session: ...
  if (/^## Session:/.test(line)) {
    // Collect the session header block (## Session + **Insights Captured**)
    // Stop before the next ### or ## and strip trailing blank lines
    let block = line;
    let j = i + 1;
    while (j < lines.length && !/^### \d+\./.test(lines[j]) && !/^## Session:/.test(lines[j])) {
      block += '\n' + lines[j];
      j++;
    }
    // Strip trailing blank lines from the block
    currentSessionHeader = block.replace(/\n+$/, '');
    isFirstInSession = true;
    i = j - 1; // will be incremented by for loop
    continue;
  }

  // Insight heading: ### N. ...
  if (/^### \d+\./.test(line)) {
    // Collect everything from this heading through the next --- separator
    let body = '';
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j] === '---') {
        body += '\n---';
        break;
      }
      body += '\n' + lines[j];
      j++;
    }
    insights.push({
      sessionHeader: isFirstInSession ? currentSessionHeader : null,
      heading: line,
      body,
      deleted: false,
    });
    isFirstInSession = false;
    // Skip past the --- and any trailing blank line
    i = j;
    if (i + 1 < lines.length && lines[i + 1] === '') i++;
  }
}

if (insights.length === 0) {
  console.log('No insight entries found.');
  process.exit(0);
}

// ─── Display ──────────────────────────────────────────────────────────────────

let cursor = 0;
let deletionCount = 0;

function render() {
  const entry = insights[cursor];
  const total = insights.length;
  const tag = entry.deleted ? ' [DELETED]' : '';

  // Clear screen and move to top
  process.stdout.write('\x1b[2J\x1b[H');

  // Show session header if present
  let display = '';
  if (entry.sessionHeader) {
    display += entry.sessionHeader + '\n';
  }
  display += entry.heading + entry.body;

  process.stdout.write(display + '\n\n');

  // Status bar
  const remaining = insights.filter(e => !e.deleted).length;
  const status = `[${cursor + 1}/${total}]${tag}  ${remaining} remaining  ←/→ navigate  d delete/undelete  q quit`;
  process.stdout.write(`\x1b[7m ${status} \x1b[0m\n`);
}

// ─── Keypress handling ────────────────────────────────────────────────────────

function saveAndExit() {
  if (deletionCount === 0) {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log('No changes made.');
    process.exit(0);
  }

  // Reconstruct file
  const remaining = insights.filter(e => !e.deleted);

  if (remaining.length === 0) {
    // Keep just the file header (trimmed of trailing session headers)
    const trimmed = fileHeader.replace(/\n## Session:[\s\S]*$/, '').trimEnd();
    writeFileSync(filePath, trimmed + '\n');
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(`Deleted all ${deletionCount} insights. File saved.`);
    process.exit(0);
  }

  // Reconstruct: every block separated by \n\n (blank line)
  let output = fileHeader;
  let activeSession = null;

  for (const entry of remaining) {
    const session = findSessionHeader(entry);
    if (session && session !== activeSession) {
      activeSession = session;
      // Re-count insights in this session
      const sessionInsights = remaining.filter(e => findSessionHeader(e) === session);
      const count = sessionInsights.length;
      const updatedHeader = session.replace(
        /\*\*Insights Captured:\*\* \d+/,
        `**Insights Captured:** ${count}`
      );
      output += '\n\n' + updatedHeader;
    }

    // Re-number within session
    const sessionInsights = remaining.filter(e => findSessionHeader(e) === activeSession);
    const idx = sessionInsights.indexOf(entry) + 1;
    const renumberedHeading = entry.heading.replace(/^### \d+\./, `### ${idx}.`);

    output += '\n\n' + renumberedHeading + entry.body;
  }

  output += '\n';

  writeFileSync(filePath, output);
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(`Deleted ${deletionCount} insight(s), ${remaining.length} remaining. File saved.`);
  process.exit(0);
}

/**
 * Walk backwards from an entry to find its session header string.
 * The session header is stored on the first insight of each session;
 * subsequent insights in the same session have sessionHeader = null.
 */
function findSessionHeader(entry) {
  const idx = insights.indexOf(entry);
  for (let i = idx; i >= 0; i--) {
    if (insights[i].sessionHeader) return insights[i].sessionHeader;
  }
  return null;
}

function onKey(data) {
  const key = data.toString();

  // q → save and exit
  if (key === 'q' || key === 'Q') {
    saveAndExit();
    return;
  }

  // Ctrl+C → exit without saving
  if (key === '\x03') {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log('Aborted (no changes saved).');
    process.exit(0);
  }

  // d → toggle delete on current entry
  if (key === 'd' || key === 'D') {
    const entry = insights[cursor];
    if (entry.deleted) {
      entry.deleted = false;
      deletionCount--;
    } else {
      entry.deleted = true;
      deletionCount++;
      // Advance to next non-deleted, or stay if at end
      const next = insights.findIndex((e, i) => i > cursor && !e.deleted);
      if (next !== -1) {
        cursor = next;
      } else {
        // Try previous non-deleted
        const prev = insights.findLastIndex((e, i) => i < cursor && !e.deleted);
        if (prev !== -1) cursor = prev;
        // else stay (all deleted — user can still undelete)
      }
    }
    render();
    return;
  }

  // Arrow keys (escape sequences)
  if (key === '\x1b[C' || key === 'l') {
    // Right arrow → next
    if (cursor >= insights.length - 1) {
      saveAndExit(); // past the end
      return;
    }
    cursor++;
    render();
    return;
  }

  if (key === '\x1b[D' || key === 'h') {
    // Left arrow → previous
    if (cursor > 0) {
      cursor--;
      render();
    }
    return;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!process.stdin.isTTY) {
  console.error('Error: This script requires an interactive terminal.');
  process.exit(1);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf-8');
process.stdin.on('data', onKey);

render();
