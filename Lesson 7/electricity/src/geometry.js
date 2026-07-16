/**
 * Rotation geometry — pure mechanics, no LLM, no decisions.
 *
 * A tile's shape is described by the SET of edges its cable exits, using the
 * clockwise edge order EDGES = [top, right, bottom, left]. A single 90-degree
 * clockwise rotation maps each edge to the next index (top->right->bottom->left
 * ->top). We rotate the current edge-set up to 3 times and check whether it
 * becomes set-equal to the target.
 *
 * This is a SAFETY-NET CHECKER the orchestrator MAY call to confirm its own
 * reasoning. It reports a fact (how many CW rotations align the two shapes, or
 * -1 if they are not rotations of each other). It never chooses what to do next.
 */

import { EDGES } from "./config.js";

/** Rotates one edge 90 degrees clockwise. */
const rotateEdgeCW = (edge) => {
  const i = EDGES.indexOf(edge);
  if (i === -1) throw new Error(`Unknown edge: ${edge}`);
  return EDGES[(i + 1) % EDGES.length];
};

/** Rotates a whole edge-set 90 degrees clockwise, returning a new sorted Set-array. */
export const rotateEdgesCW = (edges) => edges.map(rotateEdgeCW);

/** Order-independent equality of two edge lists. */
const sameSet = (a, b) => {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((e) => sa.has(e));
};

/**
 * How many 90-degree clockwise rotations turn `current` into `target`?
 * @param {string[]} current - edges of the tile as it is now
 * @param {string[]} target  - edges of the same tile in the solved layout
 * @returns {number} 0..3 rotations, or -1 if the shapes are not rotations of each other
 */
export const rotationsToAlign = (current, target) => {
  let edges = [...current];
  for (let n = 0; n < EDGES.length; n++) {
    if (sameSet(edges, target)) return n;
    edges = rotateEdgesCW(edges);
  }
  return -1;
};
