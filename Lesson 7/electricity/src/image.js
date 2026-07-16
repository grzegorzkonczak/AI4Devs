/**
 * Image preprocessing — pure mechanics.
 *
 * 1. Auto-detects the 3x3 grid square via the largest connected dark component
 *    (grid border + cables form one blob, separate from title/icons/labels).
 * 2. Crops into 9 tiles, binarizes (removes beige texture) and upscales each,
 *    so the vision subagent sees a clean black-on-white cable piece.
 *
 * The grid is rendered at a fixed size (289x289) but positioned differently
 * per image, so detection — not hardcoded coordinates — is required.
 */

import sharp from "sharp";
import { mkdir } from "fs/promises";
import { GRID } from "./config.js";

const DARK = 110; // grayscale threshold: below = cable/border, above = background

/**
 * Finds the bounding box of the largest 4-connected component of dark pixels.
 * @param {Buffer} data - raw grayscale pixels (length w*h)
 */
const detectGridBbox = (data, w, h) => {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null;
  let bestCount = 0;

  for (let start = 0; start < w * h; start++) {
    if (seen[start] || data[start] >= DARK) continue;

    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minx = w, miny = h, maxx = 0, maxy = 0, count = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx - x) / w;
      count++;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;

      // 4-neighbours
      if (x + 1 < w) { const n = idx + 1; if (!seen[n] && data[n] < DARK) { seen[n] = 1; stack[sp++] = n; } }
      if (x - 1 >= 0) { const n = idx - 1; if (!seen[n] && data[n] < DARK) { seen[n] = 1; stack[sp++] = n; } }
      if (y + 1 < h) { const n = idx + w; if (!seen[n] && data[n] < DARK) { seen[n] = 1; stack[sp++] = n; } }
      if (y - 1 >= 0) { const n = idx - w; if (!seen[n] && data[n] < DARK) { seen[n] = 1; stack[sp++] = n; } }
    }

    if (count > bestCount) {
      bestCount = count;
      best = { x0: minx, y0: miny, x1: maxx, y1: maxy };
    }
  }

  if (!best) throw new Error("No grid detected in image");
  return best;
};

/**
 * Detects the grid and crops it into 9 cleaned tile PNGs.
 * @param {string} pngPath - source board image
 * @param {string} outDir  - directory for tile_RxC.png files
 * @returns {Promise<{ bbox: object, tiles: {cell:string, path:string}[] }>}
 */
export const cropTiles = async (pngPath, outDir) => {
  await mkdir(outDir, { recursive: true });

  const CONTENT = 200; // binarized cable rendered at this size
  const MARGIN = 34; // white margin around it, holds the edge labels
  const CANVAS = CONTENT + 2 * MARGIN;

  /**
   * SVG overlay that writes T/B/L/R just outside each edge of the cable content.
   * The letters are gray (not black) and sit in the margin, never touching the
   * cable — they give the vision model an absolute orientation reference so it
   * can't confuse an elbow with its rotation (the one shape it misread).
   */
  const LABELS_SVG = Buffer.from(`<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
    <style>text{font-family:sans-serif;font-weight:bold;fill:#8a8a8a}</style>
    <text x="${CANVAS / 2}" y="26" font-size="26" text-anchor="middle">T</text>
    <text x="${CANVAS / 2}" y="${CANVAS - 10}" font-size="26" text-anchor="middle">B</text>
    <text x="16" y="${CANVAS / 2 + 9}" font-size="26" text-anchor="middle">L</text>
    <text x="${CANVAS - 16}" y="${CANVAS / 2 + 9}" font-size="26" text-anchor="middle">R</text>
  </svg>`);

  const { data, info } = await sharp(pngPath)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bbox = detectGridBbox(data, info.width, info.height);
  const cw = (bbox.x1 - bbox.x0) / GRID;
  const ch = (bbox.y1 - bbox.y0) / GRID;
  // Inset each cell to drop the thin grid frame lines that sit on the cell
  // boundaries. The thick cable still reaches the inset edge, so edge-contact is
  // preserved, but the frame no longer pollutes the tile (it was causing the
  // vision model to miss stubs / hallucinate edges).
  const insetX = cw * 0.12;
  const insetY = ch * 0.12;

  const tiles = [];

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const left = Math.round(bbox.x0 + c * cw + insetX);
      const top = Math.round(bbox.y0 + r * ch + insetY);
      const width = Math.round(bbox.x0 + (c + 1) * cw - insetX) - left;
      const height = Math.round(bbox.y0 + (r + 1) * ch - insetY) - top;

      const cell = `${r + 1}x${c + 1}`;
      const path = `${outDir}/tile_${cell}.png`;

      // 1) Binarize the cable to CONTENT x CONTENT (pure black on white).
      const content = await sharp(pngPath)
        .extract({ left, top, width, height })
        .grayscale()
        .threshold(DARK) // drops beige texture
        .resize(CONTENT, CONTENT, { kernel: "nearest" })
        .toBuffer();

      // 2) Add a white margin and stamp T/B/L/R just outside each edge, so the
      //    vision model has an absolute orientation reference (fixes elbows).
      await sharp(content)
        .extend({ top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, background: "#ffffff" })
        .composite([{ input: LABELS_SVG, top: 0, left: 0 }])
        .png()
        .toFile(path);

      tiles.push({ cell, path });
    }
  }

  return { bbox, tiles };
};
