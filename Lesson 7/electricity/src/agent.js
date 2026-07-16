/**
 * Orchestrator agent — the DECISION MAKER.
 *
 * It runs a Function-Calling loop over the Responses API. The model is given
 * four tools (all pure mechanics) and, through the system prompt, the knowledge
 * it needs to plan the puzzle itself:
 *   - inspect_target_board  : what the solved layout looks like (delegated to vision)
 *   - inspect_current_board : what my board looks like right now (delegated to vision)
 *   - rotations_to_align    : safety-net geometry check (0..3 CW rotations, or -1)
 *   - rotate                : perform ONE 90-degree clockwise rotation on a cell
 *
 * The loop itself is dumb mechanics: send history -> if the model asked for
 * tools, run them and append results -> repeat until the model stops asking.
 * All reasoning (which tiles differ, how many rotations, when solved) lives in
 * the model, guided by SYSTEM_PROMPT — never in if/else branches here.
 */

import { AI_API_KEY, RESPONSES_API_ENDPOINT, EXTRA_API_HEADERS } from "../../config.js";
import { MODELS, PATHS } from "./config.js";
import { getBoardImage, getTargetImage, rotate } from "./hub.js";
import { describeBoard } from "./vision.js";
import { rotationsToAlign } from "./geometry.js";

const MAX_TURNS = 40; // mechanics: hard stop so a confused model can't loop forever

const SYSTEM_PROMPT = `You are solving the "electricity" puzzle. A 3x3 grid holds nine
cable tiles. Each tile's cable exits some of its four edges: top, right, bottom, left.

There is a fixed TARGET layout (the solved picture, identical for everyone) and YOUR
current board, which contains the very same nine shapes in the same cells — but some
tiles are ROTATED away from the target. Your job: rotate tiles until your board matches
the target exactly. When solved, the rotate tool's response contains a flag (a FLG field
or a message announcing success) — report it and stop.

ROTATION RULE: the only move is a single 90-degree CLOCKWISE rotation of one cell. Under
a clockwise turn the edges map: top->right, right->bottom, bottom->left, left->top. To
turn a tile counter-clockwise once, rotate it clockwise three times.

CELL ADDRESSING: cells are "RxC", row x column, 1-indexed from the top-left. So "1x1" is
top-left, "1x3" top-right, "3x1" bottom-left, "3x3" bottom-right.

STRATEGY:
1. Call inspect_target_board once to learn the goal edges for every cell.
2. Call inspect_current_board to see your board's current edges.
3. For each cell, compare current edges to target edges. Decide how many clockwise
   rotations are needed. You may reason it yourself; you may ALSO call rotations_to_align
   with the two edge lists to double-check your count (it returns 0..3, or -1 if the two
   shapes are not rotations of each other).
4. Apply the needed rotations with the rotate tool, one call per 90-degree turn.
5. After acting, inspect_current_board again to verify every cell now matches the target.
   Keep going until the rotate response yields the flag.

EDGE-CASE KNOWLEDGE:
- The current and target versions of a cell always have the SAME number of edges (only
  rotation differs). If rotations_to_align returns -1, or the edge counts differ, then the
  vision read is probably wrong for that tile — re-inspect the board and re-evaluate rather
  than trusting the bad read.
- Tiles that are fully symmetric under rotation (a straight piece read identically, a cross)
  may already match with 0 rotations; don't rotate a cell that already equals its target.
- Prefer to verify with a fresh inspect_current_board before concluding you are done.`;

// ── Tool definitions (what the model sees) ─────────────────────

const TOOLS = [
  {
    type: "function",
    name: "inspect_target_board",
    description:
      "Look at the solved TARGET layout and return, for each of the 9 cells, the edges its cable connects to. Call this once at the start.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "inspect_current_board",
    description:
      "Look at YOUR board as it is right now and return, for each of the 9 cells, the edges its cable currently connects to. Call this to see progress and to verify the solution.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "rotations_to_align",
    description:
      "Safety-net geometry check. Given a cell's current edges and its target edges, returns how many 90-degree CLOCKWISE rotations align them (0..3), or -1 if they are not rotations of each other (which signals a vision misread).",
    parameters: {
      type: "object",
      properties: {
        current: {
          type: "array",
          description: "the cell's current edges",
          items: { type: "string", enum: ["top", "right", "bottom", "left"] },
        },
        target: {
          type: "array",
          description: "the cell's target edges",
          items: { type: "string", enum: ["top", "right", "bottom", "left"] },
        },
      },
      required: ["current", "target"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "rotate",
    description:
      "Perform ONE 90-degree clockwise rotation of a single cell on your board, then return the hub's response verbatim. The response contains the flag when the whole board is solved.",
    parameters: {
      type: "object",
      properties: {
        cell: { type: "string", description: 'cell to rotate, "RxC" like "2x3"' },
      },
      required: ["cell"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ── Tool handlers (what actually runs) ─────────────────────────

const toolHandlers = {
  inspect_target_board: async () => {
    await getTargetImage(PATHS.targetPng);
    const board = await describeBoard(PATHS.targetPng, { tilesDir: "workspace/tiles-target" });
    return board;
  },
  inspect_current_board: async () => {
    await getBoardImage(PATHS.boardPng);
    const board = await describeBoard(PATHS.boardPng, { tilesDir: "workspace/tiles-current" });
    return board;
  },
  rotations_to_align: async ({ current, target }) => ({
    rotations: rotationsToAlign(current, target),
  }),
  rotate: async ({ cell }) => rotate(cell),
};

// ── The Function-Calling loop (mechanics only) ─────────────────

const callModel = async (input) => {
  const body = {
    model: MODELS.orchestrator,
    instructions: SYSTEM_PROMPT,
    input,
    tools: TOOLS,
    reasoning: { effort: "medium" },
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
  if (data.error) throw new Error(`Orchestrator error: ${data.error.message}`);
  return data;
};

/**
 * Runs the orchestrator until it stops requesting tools (or MAX_TURNS is hit).
 * Returns the model's final text.
 */
export const runAgent = async () => {
  const input = [{ role: "user", content: "Solve the electricity puzzle. Begin." }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const data = await callModel(input);

    // Carry the model's own output (messages + reasoning + tool calls) into history.
    input.push(...data.output);

    const calls = data.output.filter((item) => item.type === "function_call");

    if (calls.length === 0) {
      const message = data.output.find((item) => item.type === "message");
      const text = message?.content?.map((c) => c.text).join("") ?? "";
      console.log(`\n[final] ${text}`);
      return text;
    }

    // Execute every requested tool and feed the results back.
    for (const call of calls) {
      const args = call.arguments ? JSON.parse(call.arguments) : {};
      let result;
      try {
        result = await toolHandlers[call.name](args);
      } catch (e) {
        result = { error: e.message };
      }

      const preview = JSON.stringify(result);
      console.log(`[tool] ${call.name}(${call.arguments || ""}) -> ${preview.slice(0, 200)}`);

      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }
  }

  throw new Error(`Reached MAX_TURNS (${MAX_TURNS}) without a final answer`);
};
