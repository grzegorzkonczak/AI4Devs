/**
 * Entry point for the electricity puzzle agent.
 *
 * Thin wiring only: optionally reset the board (node app.js --reset), then hand
 * control to the orchestrator, which decides everything from there.
 *
 * Run on the droplet:
 *   node app.js            # solve from the current board state
 *   node app.js --reset    # randomize the board first, then solve
 */

import { runAgent, captureFinalBoard } from "./src/agent.js";
import { resetBoard } from "./src/hub.js";

const main = async () => {
  if (process.argv.includes("--reset")) {
    console.log("Resetting board to a fresh randomized state...");
    await resetBoard();
  }

  console.log("Starting orchestrator...\n");
  const final = await runAgent();

  // Diagnostic: capture the board as it stands after the agent stops. If solved,
  // this equals the hub's TRUE target and can be diffed against the agent's
  // original vision target read to expose any misread the solve masked.
  console.log("\nCapturing final board state for analysis...");
  try {
    await captureFinalBoard();
  } catch (e) {
    console.error("Final capture failed:", e.message);
  }

  console.log("\nDone.");
  return final;
};

main().catch((e) => {
  console.error("\nAgent failed:", e.message);
  process.exit(1);
});
