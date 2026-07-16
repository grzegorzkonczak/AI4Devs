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
import { postJson } from "./net.js";
import { initRun, getRunDir, logEvent, saveBoard, saveImage } from "./log.js";

const MAX_TURNS = 60; // mechanics: hard stop so a confused model can't loop forever

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
1. Call inspect_target_board once to learn the goal edges for every cell. Keep these
   numbers; the target never changes.
2. Call inspect_current_board once to see your board's current edges.
3. Build a plan for the WHOLE board in one pass: for each of the nine cells, compare its
   current edges to its target edges and decide how many clockwise rotations it needs. You
   may reason it yourself; you may ALSO call rotations_to_align with the two edge lists to
   double-check each count (it returns 0..3, or -1 if the shapes are not rotations of each
   other). A cell that already matches needs 0 rotations — leave it alone.
4. Execute the whole plan with the rotate tool: one call per 90-degree turn (a cell needing
   3 turns gets three rotate calls). You do NOT need to re-inspect between individual
   rotations — rotation is deterministic, so you already know what each turn does.
5. Only AFTER applying the full plan, call inspect_current_board ONCE to verify every cell
   now matches the target. If some cells are still off, plan and rotate again, then verify
   again. Keep going until a rotate response yields the flag.

IMPORTANT ON RESPONSES: every rotate call returns {"message":"Done"} while the puzzle is
unsolved — that only confirms the move was accepted, it is NOT success. The board is solved
only when a rotate response contains a flag (a FLG field, or text announcing the flag).
Report that flag and stop.

EDGE-CASE KNOWLEDGE:
- The current and target versions of a cell ALWAYS have the same number of edges (only
  rotation differs). The vision reader occasionally misses the short third leg of a tee and
  reports it as a two-edge straight. So if a cell's current edge-count differs from its
  target edge-count (or rotations_to_align returns -1), trust the TARGET's edge-count and
  treat the current read as noise: re-inspect that board once and re-plan. Do not endlessly
  re-inspect after every rotation — that wastes calls and can hit rate limits.
- A straight piece looks identical after a 180-degree turn and a cross after any turn; such
  cells may already match with 0 rotations. Never rotate a cell that already equals target.
- Verify with a single fresh inspect_current_board before concluding you are done.`;

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

let inspectSeq = 0;

/** Downloads a board, describes it, and archives PNG + JSON for later analysis. */
const inspectAndArchive = async (getImage, srcPath, label) => {
  await getImage(srcPath);
  await saveImage(label, srcPath);
  const board = await describeBoard(srcPath, { tilesDir: `${getRunDir()}/tiles-${label}` });
  await saveBoard(label, board);
  return board;
};

const toolHandlers = {
  inspect_target_board: async () => inspectAndArchive(getTargetImage, PATHS.targetPng, "target"),
  inspect_current_board: async () =>
    inspectAndArchive(getBoardImage, PATHS.boardPng, `current-${String(++inspectSeq).padStart(2, "0")}`),
  rotations_to_align: async ({ current, target }) => ({
    rotations: rotationsToAlign(current, target),
  }),
  rotate: async ({ cell }) => rotate(cell),
};

/**
 * Diagnostic capture of the board AFTER the agent stops. If the puzzle was
 * solved, this board equals the hub's TRUE target — so diffing it against the
 * agent's original vision target read reveals any misread that the solve masked.
 */
export const captureFinalBoard = async () => {
  const board = await inspectAndArchive(getBoardImage, PATHS.boardPng, "final");
  await logEvent({ type: "final_capture", board });
  return board;
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

  const data = await postJson(
    RESPONSES_API_ENDPOINT,
    { Authorization: `Bearer ${AI_API_KEY}`, ...EXTRA_API_HEADERS },
    body
  );
  if (data.error) throw new Error(`Orchestrator error: ${data.error.message}`);
  return data;
};

/**
 * Runs the orchestrator until it stops requesting tools (or MAX_TURNS is hit).
 * Returns the model's final text.
 */
export const runAgent = async () => {
  const dir = await initRun();
  console.log(`[log] artifacts -> ${dir}`);
  await logEvent({ type: "run_start" });
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
      await logEvent({ type: "final_message", turn, text });
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
      await logEvent({ type: "tool_call", turn, name: call.name, args, result });

      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }
  }

  await logEvent({ type: "max_turns" });
  throw new Error(`Reached MAX_TURNS (${MAX_TURNS}) without a final answer`);
};
