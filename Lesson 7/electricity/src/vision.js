/**
 * Vision subagent — a delegated worker the orchestrator hands tiles to.
 *
 * It does NOT reason about the puzzle. Its only job: look at each cropped tile
 * and report, faithfully, which edges the thick cable connects to. That report
 * (structured JSON) is the "communication" sent back to the orchestrator.
 *
 * Uses the OpenAI Responses API with image input + Structured Outputs so every
 * tile comes back as clean, typed JSON.
 */

import { readFile } from "fs/promises";
import { AI_API_KEY, RESPONSES_API_ENDPOINT, EXTRA_API_HEADERS } from "../../config.js";
import { MODELS, PATHS, EDGES } from "./config.js";
import { cropTiles } from "./image.js";
import { postJson } from "./net.js";

const SAMPLES = 1; // clean inset crops read deterministically; one sample suffices

const INSTRUCTIONS = `You are a vision analyst for a 3x3 electrical wiring puzzle.
You are shown ONE tile: a solid black cable shape on a white background, cleanly
cropped (no grid frame). Just outside the four sides are small GRAY reference
letters — T (top), B (bottom), L (left), R (right). These letters are NOT part of
the cable; use them only to name the sides correctly and avoid orientation mistakes.

The cable exits through some of the four sides. Trace each straight arm of the black
shape from the center outward and see which labeled side it reaches. Report exactly
those sides. Look carefully: a "tee" has a SHORT third stub in addition to its main
bar — do not overlook it. Do not confuse a side with its opposite (T vs B, L vs R) —
the gray letters are there precisely to prevent that.

Report:
- description: one short sentence naming which labeled sides the cable reaches.
- edges: the list of sides the cable reaches, as full words (subset of
  top/right/bottom/left, matching the T/R/B/L labels).
- shape: straight (2 opposite sides), elbow (2 adjacent sides), tee (3 sides),
  cross (4 sides), end (1 side), or empty (no cable).

Be precise: the number of edges must match the shape (straight/elbow=2, tee=3,
cross=4, end=1, empty=0).`;

const TILE_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "one short sentence describing the cable shape and its exits",
    },
    edges: {
      type: "array",
      items: { type: "string", enum: ["top", "right", "bottom", "left"] },
    },
    shape: {
      type: "string",
      enum: ["straight", "elbow", "tee", "cross", "end", "empty"],
    },
  },
  required: ["description", "edges", "shape"],
  additionalProperties: false,
};

const toDataUrl = async (path) => {
  const buf = await readFile(path);
  return `data:image/png;base64,${buf.toString("base64")}`;
};

/**
 * Reads a single tile ONCE via the vision model. Returns { edges, shape, description }.
 */
const readTileOnce = async (cell, dataUrl) => {
  const body = {
    model: MODELS.vision,
    instructions: INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `Tile ${cell}. Which edges does the thick cable connect to?` },
          { type: "input_image", image_url: dataUrl, detail: "high" },
        ],
      },
    ],
    text: {
      format: { type: "json_schema", name: "tile", schema: TILE_SCHEMA, strict: true },
    },
  };

  const data = await postJson(
    RESPONSES_API_ENDPOINT,
    { Authorization: `Bearer ${AI_API_KEY}`, ...EXTRA_API_HEADERS },
    body
  );
  if (data.error) throw new Error(`Vision error (${cell}): ${data.error.message}`);

  const message = data.output.find((item) => item.type === "message");
  const text = message?.content?.[0]?.text;
  if (!text) throw new Error(`Vision returned no content for ${cell}`);

  const parsed = JSON.parse(text);
  return { edges: parsed.edges, shape: parsed.shape, description: parsed.description };
};

/** Canonical key for an edge-set, order-independent, in clockwise order. */
const edgeKey = (edges) => EDGES.filter((e) => edges.includes(e)).join(",");

/**
 * Classifies a tile by reading it SAMPLES times and taking the majority
 * edge-set. This is reliability mechanics: the model occasionally drops a
 * short third leg (a tee read as a straight), and voting cancels that noise.
 * Returns { cell, edges, shape, description }.
 */
const classifyTile = async (cell, path) => {
  const dataUrl = await toDataUrl(path);

  const reads = await Promise.all(
    Array.from({ length: SAMPLES }, () => readTileOnce(cell, dataUrl))
  );

  const tally = new Map();
  for (const r of reads) {
    const key = edgeKey(r.edges);
    const entry = tally.get(key) ?? { count: 0, read: r };
    entry.count += 1;
    tally.set(key, entry);
  }

  let winner = null;
  for (const entry of tally.values()) {
    if (!winner || entry.count > winner.count) winner = entry;
  }

  const { edges, shape, description } = winner.read;
  return { cell, edges, shape, description };
};

/**
 * Delegated task: describe a whole board.
 * Crops the board into 9 tiles and classifies each (in parallel).
 *
 * @param {string} pngPath - board image on disk
 * @param {object} [opts]
 * @param {string} [opts.tilesDir] - where to write tile crops
 * @returns {Promise<Record<string, {edges:string[], shape:string, description:string}>>}
 */
export const describeBoard = async (pngPath, { tilesDir = PATHS.tilesDir } = {}) => {
  const { tiles } = await cropTiles(pngPath, tilesDir);

  const results = await Promise.all(tiles.map((t) => classifyTile(t.cell, t.path)));

  const board = {};
  for (const r of results) {
    board[r.cell] = { edges: r.edges, shape: r.shape, description: r.description };
  }
  return board;
};
