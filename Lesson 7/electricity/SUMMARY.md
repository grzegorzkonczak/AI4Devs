# Electricity Puzzle — Agentic Solution (Lesson 7 exercise)

**Outcome:** ✅ Solved. Flag: `FLG:ROTATEIT`

A multi-agent solution to the "electricity" grid puzzle. The design keeps to the
course principle throughout: **the LLM makes decisions, code handles mechanics.**

---

## 1. The puzzle

- A **3×3 grid** of cable tiles. Each tile's cable exits some of its four edges
  (`top`, `right`, `bottom`, `left`): straight (2 opposite), elbow (2 adjacent),
  tee (3), cross (4).
- A fixed **target** image (`solved_electricity.png`, same for everyone) shows the
  solved layout. Your **personal board** has the *same nine shapes in the same
  cells* — only **rotated** differently.
- The only move is a single **90° clockwise** rotation of one cell, sent as one
  POST to the hub (`answer: { rotate: "RxC" }`, row×col, 1-indexed).
- The hub replies `{message:"Done"}` per accepted move, and returns the **flag**
  in the rotate response once the whole board matches the target.

---

## 2. Architecture (multi-agent, delegation + communication)

```
        app.js  (entry: optional --reset, then hand off)
          │
          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  agent.js — ORCHESTRATOR (gpt-5.2, reasoning)             │
   │  Function-Calling loop. Owns ALL reasoning:               │
   │  which tiles differ, how many rotations, when solved.     │
   │                                                            │
   │  tools (all pure mechanics, never decide):                │
   │   • inspect_target_board  ─┐ delegate to vision subagent  │
   │   • inspect_current_board ─┘                              │
   │   • rotations_to_align     → geometry.js (safety check)   │
   │   • rotate                 → hub.js (one CW turn)         │
   └──────────────────────────────────────────────────────────┘
          │ delegates board-reading
          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  vision.js — VISION SUBAGENT (gpt-4.1, image input)      │
   │  Reports FACTS only: for each of 9 tiles, which edges     │
   │  the cable reaches. No puzzle reasoning.                  │
   │    image.js  → detect grid + crop 9 clean tiles          │
   │    net.js    → POST with 429/503 retry (self-paces TPM)  │
   └──────────────────────────────────────────────────────────┘
```

### The decision/mechanics split (course principle)

| In code (mechanics) | In the LLM (reasoning) |
|---|---|
| Fetch/crop/threshold images | Which tiles differ from target |
| Retry on 429/503, self-pace to TPM | How many rotations each tile needs |
| `rotations_to_align` = geometry fact (0–3 or −1) | Whether a −1 means "vision misread → re-inspect" |
| `rotate` returns hub response **verbatim** | Recognising the flag and stopping |
| Loop until model stops asking; `MAX_TURNS` guard | Planning, verifying, deciding "done" |

No `if/else` ever decides the agent's next move. Edge-case knowledge (e.g. "a tee
stub may be missed; current & target keep the same edge-count") lives in the
**system prompt** as reasoning, not as a branch.

---

## 3. Files

| File | Role | LLM? |
|---|---|---|
| `app.js` | Entry point; optional `--reset`, then `runAgent()` | — |
| `src/agent.js` | Orchestrator: Function-Calling loop, 4 tools, system prompt | ✅ decides |
| `src/vision.js` | Vision subagent: crop + classify 9 tiles (Structured Outputs) | ✅ reports |
| `src/image.js` | Grid auto-detect (flood-fill largest dark blob) + inset crop | — |
| `src/geometry.js` | `rotationsToAlign(cur,tgt)` → 0–3 or −1 (CW edge-index shift) | — |
| `src/hub.js` | Download board/target, reset, rotate — pure mechanics | — |
| `src/net.js` | `postJson` with 429/503 backoff (self-paces to rate limit) | — |
| `src/config.js` | Hub URLs/key, model IDs, `EDGES` (clockwise), paths | — |
| `smoke-vision.js` | Diagnostic: describe both boards + edge-count cross-check | — |

### Key mechanics worth remembering
- **Rotation math:** `EDGES = [top,right,bottom,left]` in clockwise order, so one
  90° CW turn = shift each edge one index forward. `rotationsToAlign` rotates the
  current set 0–3 times until it set-equals the target (or −1 if not a rotation).
- **Grid detection:** the grid renders at a fixed 289×289 but is positioned
  differently per image (board 800×450, target 598×422) → hardcoded crop is
  impossible. The largest 4-connected dark component = the grid.
- **Responses API image input:** `content:[{type:"input_text"},{type:"input_image",
  image_url:dataUrl,detail:"high"}]`; Structured Outputs via
  `text.format:{type:"json_schema",strict:true}`.

---

## 4. Troubleshooting journey (3 runs)

The interesting part. Vision looked reliable in the smoke test, but the live agent
failed twice before the real bug surfaced.

### Run 1 — spiral to `MAX_TURNS`
- **Symptom:** tile `1x2` flip-flopped between `tee [left,right,bottom]` and
  `straight [left,right]` across inspections we never rotated. One misread made the
  model rotate a *correct* tile, breaking it → more misreads → spiral. Also hit the
  **30k TPM rate limit**, and the 429s surfaced as tool errors that corrupted the
  board read.
- **Diagnosis:** a tee can never lose a leg by rotation — so the "straight" reads
  were vision **dropping the short third stub**.

### Run 2 — my first fixes made it *worse*
- Added **majority-vote** (3 samples/tile) + **429 retry**. The retry was right,
  but majority-vote **backfired**: sampling the *same image* 3× gives *correlated*
  errors (3 identical wrong reads still vote wrong) **and** tripled tokens → the
  rate-limit spiral got worse. Still failed at `MAX_TURNS`.
- **Lesson:** voting only helps against *independent* noise. This was *systematic*
  error, so voting couldn't fix it.

### Run 3 — look at what the model actually sees → success
- Downloaded the images and **rendered the cropped tiles**. The crop included the
  **grid frame lines** on every cell boundary. gpt-4.1 couldn't reliably "ignore
  the thin frame" as instructed — frame lines got read as edges or cluttered the
  shape enough to hide a stub. **This was the real bug — a preprocessing issue, not
  model quality or prompt wording.**
- **Fix:** **inset each cell crop by 12%** so the frame lines are physically
  removed while the thick cable still reaches the (inset) edge. Verified locally
  that every tile became unambiguous. Reverted to a **single** vision sample
  (clean tiles read deterministically; ⅓ the tokens).
- **Result:** stable reads → model planned once, rotated a batch, verified once,
  and got the flag. No rate-limit issues.

### Takeaways
1. **When a vision agent misbehaves, render exactly what it sees.** Two runs were
   spent guessing at the model/prompt; five minutes of looking at the crop found
   the real cause.
2. **Voting fixes random noise, not systematic error** — and it multiplies cost.
3. **Retries on 429/503 are legit mechanics** and self-pace to the rate limit —
   but they can't rescue a design that fires too many calls per minute. Fix the
   *need* to loop (reliable inputs), don't just paper over it.
4. **Keep the decision/mechanics boundary clean:** the tool reporting `-1` and the
   prompt interpreting it ("vision misread → re-inspect") is exactly the split the
   course asks for.

---

## 5. How to run

```bash
cd ~/AI4Devs/"Lesson 7"/electricity
npm install                 # sharp
node smoke-vision.js        # optional: verify crop + vision
node app.js --reset         # randomize board, then solve
node app.js                 # solve from current state
```
