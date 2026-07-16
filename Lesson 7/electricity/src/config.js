/**
 * Central config for the electricity puzzle agent.
 * Reuses the shared Lesson 7/config.js for API key + endpoints.
 */

import { resolveModelForProvider } from "../../config.js";

// ── Hub (course task server) ───────────────────────────────────

export const HUB = {
  apiKey: "4abb691a-12aa-4546-82c5-1b6ba1c19f60",
  task: "electricity",
  verifyUrl: "https://hub.ag3nts.org/verify",
  // Personal, mutable board (rotates as we send requests). Key goes in the path.
  boardUrl: "https://hub.ag3nts.org/data/4abb691a-12aa-4546-82c5-1b6ba1c19f60/electricity.png",
  // Static reference showing the solved target layout (same for everyone).
  targetUrl: "https://hub.ag3nts.org/i/solved_electricity.png",
};

// ── Models ─────────────────────────────────────────────────────

export const MODELS = {
  // Vision subagent: classifies each cropped tile.
  vision: resolveModelForProvider("gpt-4.1"),
  // Orchestrator: spatial planning benefits from a reasoning model.
  orchestrator: resolveModelForProvider("gpt-5.2"),
};

// ── Board geometry ─────────────────────────────────────────────

export const GRID = 3; // 3x3
export const EDGES = ["top", "right", "bottom", "left"]; // clockwise order

// Local working files.
export const PATHS = {
  boardPng: "workspace/board.png",
  targetPng: "workspace/target.png",
  targetJson: "workspace/target.json",
  tilesDir: "workspace/tiles",
};
