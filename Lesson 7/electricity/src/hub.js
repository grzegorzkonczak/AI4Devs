/**
 * Hub client — pure mechanics.
 * Fetches board images and sends single 90-degree clockwise rotations.
 * Reports the hub's response faithfully; makes no decisions.
 */

import { writeFile } from "fs/promises";
import { HUB } from "./config.js";

/**
 * Downloads a PNG to a local path. Returns the path.
 * @param {string} url
 * @param {string} outPath
 */
export const downloadImage = async (url, outPath) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Image download failed (${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buf);
  return outPath;
};

/**
 * Fetches the current personal board and saves it locally.
 * @param {string} outPath
 */
export const getBoardImage = (outPath) => downloadImage(HUB.boardUrl, outPath);

/**
 * Fetches the static solved-target reference and saves it locally.
 * @param {string} outPath
 */
export const getTargetImage = (outPath) => downloadImage(HUB.targetUrl, outPath);

/**
 * Resets the personal board to its initial randomized state.
 */
export const resetBoard = async () => {
  const res = await fetch(`${HUB.boardUrl}?reset=1`);
  if (!res.ok) throw new Error(`Reset failed (${res.status})`);
  return true;
};

/**
 * Sends ONE 90-degree clockwise rotation of a single cell.
 * Returns the hub's parsed response verbatim (may contain the flag when solved).
 * @param {string} cell - e.g. "2x3" (row x col, 1-indexed from top-left)
 */
export const rotate = async (cell) => {
  const res = await fetch(HUB.verifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: HUB.apiKey,
      task: HUB.task,
      answer: { rotate: cell },
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: res.status, ...data };
};
