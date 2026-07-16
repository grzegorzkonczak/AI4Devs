/**
 * Run instrumentation — diagnostics only, no effect on agent behavior.
 *
 * Captures, per run, everything needed to reconstruct the true physical board
 * state and compare it against what the vision model claimed:
 *   - full board PNG + 9 cropped tile PNGs at every inspection
 *   - the untruncated vision reads (board-<label>.json)
 *   - an event log of every tool call and its result (events.jsonl)
 *
 * This lets us diff vision's claim against the actual pixels and settle whether
 * a solve was real reasoning or a lucky misread.
 */

import { mkdir, writeFile, appendFile, copyFile } from "fs/promises";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

let runDir = null;

/** Creates a fresh timestamped run directory and returns it. */
export const initRun = async () => {
  runDir = `runlog/run-${stamp()}`;
  await mkdir(runDir, { recursive: true });
  return runDir;
};

export const getRunDir = () => runDir;

/** Appends one JSON event (with timestamp) to events.jsonl. */
export const logEvent = async (event) => {
  if (!runDir) return;
  await appendFile(`${runDir}/events.jsonl`, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
};

/** Saves the untruncated vision read for a whole board. */
export const saveBoard = async (label, board) => {
  if (!runDir) return;
  await writeFile(`${runDir}/board-${label}.json`, JSON.stringify(board, null, 2));
};

/** Copies the full board PNG for a given inspection label. */
export const saveImage = async (label, srcPath) => {
  if (!runDir) return;
  await copyFile(srcPath, `${runDir}/full-${label}.png`);
};
