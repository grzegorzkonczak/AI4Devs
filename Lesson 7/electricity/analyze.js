/**
 * Post-run analysis — turns the captured artifacts into a verdict.
 *
 * Decisive test: once solved, the FINAL board equals the hub's TRUE target.
 * So comparing board-final.json (truth) against board-target.json (what vision
 * claimed the goal was) reveals any target misread that a lucky solve masked.
 * Also prints each cell's read timeline and the rotations actually sent.
 *
 * Usage on the droplet (after a run):
 *   node analyze.js                 # analyzes the newest runlog/run-*
 *   node analyze.js runlog/run-...  # analyzes a specific run
 */

import { readdir, readFile } from "fs/promises";
import { rotationsToAlign } from "./src/geometry.js";

const CELLS = ["1x1", "1x2", "1x3", "2x1", "2x2", "2x3", "3x1", "3x2", "3x3"];

const pickRunDir = async () => {
  if (process.argv[2]) return process.argv[2];
  const runs = (await readdir("runlog")).filter((d) => d.startsWith("run-")).sort();
  if (!runs.length) throw new Error("No runlog/run-* directories found");
  return `runlog/${runs[runs.length - 1]}`;
};

const loadJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const loadBoards = async (dir) => {
  const files = (await readdir(dir)).filter((f) => f.startsWith("board-") && f.endsWith(".json"));
  files.sort(); // board-current-01, ...-02, board-final, board-target — labels sort sensibly enough
  const boards = {};
  for (const f of files) {
    const label = f.slice("board-".length, -".json".length);
    boards[label] = await loadJson(`${dir}/${f}`);
  }
  return boards;
};

const edges = (board, cell) => board?.[cell]?.edges ?? null;
const fmt = (e) => (e ? `[${e.join(",")}]` : "—");

const main = async () => {
  const dir = await pickRunDir();
  console.log(`Analyzing ${dir}\n`);

  const boards = await loadBoards(dir);
  const target = boards.target;
  const final = boards.final;

  if (!target) throw new Error("board-target.json missing");
  if (!final) {
    console.log("board-final.json missing — run did not capture a final board.");
  }

  // 1) CONSISTENCY TEST: vision's target read vs its read of the solved board.
  //    Both are the SAME solved orientation, so the reads SHOULD match. If they
  //    disagree, vision misread at least one of them — the tile PNGs are the only
  //    true ground truth (do not trust either vision read to grade the other).
  if (final) {
    console.log("=== TARGET READ vs FINAL READ (same solved tile, read twice) ===");
    console.log("A mismatch means vision was INCONSISTENT — check the tile PNGs (ground truth).\n");
    let disagreements = 0;
    for (const cell of CELLS) {
      const t = edges(target, cell);
      const f = edges(final, cell);
      const off = t && f ? rotationsToAlign(t, f) : null;
      const match = t && f && off === 0;
      if (!match) disagreements++;
      const note =
        off === null ? "?" :
        off === 0 ? "consistent" :
        off === -1 ? "DIFFERENT SHAPE (gross misread — inspect PNG)" :
        `INCONSISTENT by ${off} CW rotation(s) — inspect tiles-target vs tiles-final PNG`;
      console.log(`  ${cell}: target-read ${fmt(t).padEnd(26)} final-read ${fmt(f).padEnd(26)} ${note}`);
    }
    console.log(
      disagreements
        ? `\n=> ${disagreements} cell(s) read inconsistently (almost always elbows). The solve still succeeded because the HUB is ground truth and the stop-condition lives in the LLM — NOT a coincidence. Open the named PNGs to see the true orientation.`
        : "\n=> Vision read every cell consistently between target and final. Clean solve."
    );
  }

  // 2) Rotations actually sent, per cell.
  console.log("\n=== ROTATIONS SENT (from events.jsonl) ===");
  const rotates = {};
  try {
    const lines = (await readFile(`${dir}/events.jsonl`, "utf8")).trim().split("\n");
    for (const line of lines) {
      const ev = JSON.parse(line);
      if (ev.type === "tool_call" && ev.name === "rotate") {
        const cell = ev.args?.cell;
        rotates[cell] = (rotates[cell] ?? 0) + 1;
      }
    }
    for (const cell of CELLS) if (rotates[cell]) console.log(`  ${cell}: ${rotates[cell]} rotation(s)  (${rotates[cell] % 4} net)`);
  } catch {
    console.log("  events.jsonl not found");
  }

  // 3) Per-cell read timeline across every inspection.
  console.log("\n=== PER-CELL READ TIMELINE ===");
  const labels = Object.keys(boards).sort();
  for (const cell of CELLS) {
    const series = labels.map((l) => `${l}=${fmt(edges(boards[l], cell))}`).join("  ");
    console.log(`  ${cell}: ${series}`);
  }
};

main().catch((e) => {
  console.error("Analysis failed:", e.message);
  process.exit(1);
});
