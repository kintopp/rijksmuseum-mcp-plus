#!/usr/bin/env node
// Blind LLM judge for skill-ab.mjs results. Per prompt, every answer (all arms and runs)
// is shuffled under neutral labels and scored together by one judge call, so scores are
// relative within a prompt. Each prompt is judged in two orders (shuffled, then reversed)
// to dampen position bias; scores are averaged.
//
//   node scripts/bench/skill-judge.mjs <results dir>... [--model opus]
//
// Several dirs pool their sessions (e.g. an earlier none/current run plus a later slim run).

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RUBRIC = `Score each answer 1-10 on:
- breadth: how many genuinely different routes into the collection the investigation took (look at the tool trace, not just the prose)
- originality: unexpected but defensible angles, connections or questions a curator would find fresh, versus the obvious first answer
- grounding: claims tied to specific catalogue evidence (object numbers, counts, quoted fields) rather than general knowledge
- critical: awareness of what the data can and cannot show (coverage gaps, cataloguing biases, false negatives)
- overall: how useful this would be to a researcher asking the question`;

function parseArgs(argv) {
  const opts = { dirs: [], model: "opus" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") opts.model = argv[++i];
    else opts.dirs.push(path.resolve(argv[i]));
  }
  return opts;
}

const trace = (calls) => calls.filter((c) => c.tool !== "Read")
  .map((c) => `  ${c.tool} ${JSON.stringify(c.input).slice(0, 220)}`).join("\n");

function shuffle(xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function judge(question, items, model) {
  const body = items.map((s, i) => `<answer label="${String.fromCharCode(65 + i)}">\n<tool_trace>\n${trace(s.calls)}\n</tool_trace>\n<final_answer>\n${s.answer}\n</final_answer>\n</answer>`).join("\n\n");
  const prompt = `You are an expert museum researcher evaluating answers produced by AI research assistants with access to the Rijksmuseum collection database. All had the same tools.\n\n<question>\n${question}\n</question>\n\n${body}\n\n${RUBRIC}\n\nReply with ONLY a JSON object mapping each label to {"breadth":n,"originality":n,"grounding":n,"critical":n,"overall":n}, no prose.`;
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", model, "--output-format", "json", "--tools", "", "--setting-sources", "", "--no-session-persistence"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => {
      try {
        const text = JSON.parse(out).result;
        resolve(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
      } catch (e) { reject(new Error(`judge parse failed: ${e.message}\n${out.slice(0, 500)}`)); }
    });
    child.stdin.end(prompt);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const questions = Object.fromEntries(JSON.parse(readFileSync(new URL("./open-prompts.json", import.meta.url), "utf8")).map((p) => [p.id, p.prompt]));
  const sessions = opts.dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".json") && f.includes("__"))
    .map((f) => JSON.parse(readFileSync(path.join(d, f), "utf8"))));
  const byPrompt = Object.groupBy(sessions, (s) => s.prompt);
  const DIMS = ["breadth", "originality", "grounding", "critical", "overall"];

  const scored = [];
  await Promise.all(Object.entries(byPrompt).map(async ([pid, items]) => {
    const order = shuffle(items);
    const [a, b] = await Promise.all([judge(questions[pid], order, opts.model), judge(questions[pid], [...order].reverse(), opts.model)]);
    order.forEach((s, i) => {
      const sa = a[String.fromCharCode(65 + i)], sb = b[String.fromCharCode(65 + order.length - 1 - i)];
      scored.push({ prompt: pid, arm: s.arm, run: s.run, ...Object.fromEntries(DIMS.map((k) => [k, (sa[k] + sb[k]) / 2])), ...s.metrics, cost: s.cost });
    });
    console.error(`judged ${pid}`);
  }));

  writeFileSync(path.join(opts.dirs.at(-1), "judged.json"), JSON.stringify(scored, null, 2));
  const cols = [...DIMS, "calls", "distinctSignatures", "objectNumbersCited", "cost"];
  const arms = [...new Set(scored.map((s) => s.arm))];
  const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
  console.log(["arm", "n", ...cols].join("\t"));
  for (const arm of arms) {
    const rows = scored.filter((s) => s.arm === arm);
    console.log([arm, rows.length, ...cols.map((c) => mean(rows.map((r) => r[c])).toFixed(c === "cost" ? 3 : 2))].join("\t"));
  }
  console.log("\nper prompt (overall / originality):");
  for (const pid of Object.keys(byPrompt)) {
    console.log(`  ${pid}\t` + arms.map((arm) => {
      const rows = scored.filter((s) => s.prompt === pid && s.arm === arm);
      return `${arm} ${mean(rows.map((r) => r.overall)).toFixed(1)}/${mean(rows.map((r) => r.originality)).toFixed(1)}`;
    }).join("\t"));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
