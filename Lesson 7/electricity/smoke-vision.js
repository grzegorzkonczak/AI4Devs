/**
 * Smoke test — validates image.js (crop) + vision.js (classify) end to end.
 * Downloads the current board and the target, describes both, prints per-tile
 * JSON, and cross-checks that each cell has the SAME edge-count in both
 * (they must, since only rotation differs — a mismatch flags a vision misread).
 *
 * Run on the droplet:  node smoke-vision.js
 */

import { getBoardImage, getTargetImage } from "./src/hub.js";
import { describeBoard } from "./src/vision.js";
import { PATHS } from "./src/config.js";

const show = (label, board) => {
  console.log(`\n=== ${label} ===`);
  for (const cell of Object.keys(board).sort()) {
    const t = board[cell];
    console.log(`  ${cell}: [${t.edges.join(", ").padEnd(24)}] ${t.shape.padEnd(8)} — ${t.description}`);
  }
};

const main = async () => {
  console.log("Downloading board + target...");
  await getBoardImage(PATHS.boardPng);
  await getTargetImage(PATHS.targetPng);

  console.log("Describing current board (9 tiles)...");
  const current = await describeBoard(PATHS.boardPng, { tilesDir: "workspace/tiles-current" });
  show("CURRENT", current);

  console.log("\nDescribing target board (9 tiles)...");
  const target = await describeBoard(PATHS.targetPng, { tilesDir: "workspace/tiles-target" });
  show("TARGET", target);

  console.log("\n=== EDGE-COUNT CROSS-CHECK (should all match) ===");
  let mismatches = 0;
  for (const cell of Object.keys(current).sort()) {
    const a = current[cell].edges.length;
    const b = target[cell]?.edges.length ?? -1;
    const ok = a === b;
    if (!ok) mismatches++;
    console.log(`  ${cell}: current=${a} target=${b} ${ok ? "ok" : "MISMATCH <-- vision misread?"}`);
  }
  console.log(mismatches ? `\n${mismatches} mismatch(es) — inspect those tiles.` : "\nAll edge-counts match. Vision looks reliable.");
};

main().catch((e) => {
  console.error("Smoke test failed:", e.message);
  process.exit(1);
});
