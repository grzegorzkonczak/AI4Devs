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
import { MODELS, PATHS } from "./config.js";
import { cropTiles } from "./image.js";

const INSTRUCTIONS = `You are a vision analyst for a 3x3 electrical wiring puzzle.
You are shown ONE tile, cropped and cleaned to black shapes on a white background.

A THICK black cable runs through the tile and exits through some of the four edges:
top, right, bottom, left. The thin lines exactly along the border are the grid
frame — IGNORE them. Only report an edge if the THICK cable actually reaches and
crosses that edge.

Report:
- description: one short sentence about the cable shape and where it exits.
- edges: the list of edges the thick cable connects to (subset of top/right/bottom/left).
- shape: straight (2 opposite edges), elbow (2 adjacent edges), tee (3 edges),
  cross (4 edges), end (1 edge), or empty (no cable).

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
 * Classifies a single tile image via the vision model. Returns { cell, edges, shape, description }.
 */
const classifyTile = async (cell, path) => {
  const dataUrl = await toDataUrl(path);

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

  const res = await fetch(RESPONSES_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
      ...EXTRA_API_HEADERS,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Vision error (${cell}): ${data.error.message}`);

  const message = data.output.find((item) => item.type === "message");
  const text = message?.content?.[0]?.text;
  if (!text) throw new Error(`Vision returned no content for ${cell}`);

  const parsed = JSON.parse(text);
  return { cell, edges: parsed.edges, shape: parsed.shape, description: parsed.description };
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
