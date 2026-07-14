# Walkthrough: 01_04_image_guidance

## Lesson context

Section **"Grafiki referencyjne do sterowania zachowaniem modelu"**.

The lesson point: reference images let you control composition, pose, and framing without changing the text style at all. Combined with the JSON template from `json_image`, you can generate many characters in the same style AND the same pose consistently.

The lesson itself notes: *"kod agenta w większości pozostaje niezmieniony"* — agent code is mostly unchanged from previous examples. The changes are `config.js`, `template.json`, and the `workspace/reference/` folder.

---

## What hasn't changed

REPL, agent loop, MCP setup, Gemini integration — identical to `json_image`. Only focus on what's new.

---

## The new concept: reference image as structural guide

`workspace/reference/` contains:
```
walking-pose.png
running-pose.png
```

Simple pose silhouettes — showing body position. When passed to Gemini alongside the JSON text prompt, Gemini uses the image for **structure** (where limbs are, how weight is distributed) while applying the text prompt's style rules to create something new.

This is NOT "copy this image". It's "use this image's composition and body language, but render it as this character in this art style."

The `template.json` has a new section documenting this intention explicitly:

```json
"pose_reference": {
  "source": "workspace/reference/walking-pose.png",
  "usage": "Use as pose guidance only - match body position, stance, and gesture",
  "interpretation": "Character should match the walking pose exactly but rendered in the cell-shaded style"
}
```

This section isn't just documentation — it's part of the prompt passed to Gemini. Gemini reads it and understands: "the image I received is a pose guide, not a style template."

---

## Pose selection logic in `config.js` (DETERMINISTIC rules, LLM applies judgment)

The system prompt gives the agent a matching algorithm:

```
1. Explicit:  "running knight"           → running-pose.png
2. Inferred:  "warrior charging battle"  → infer running → running-pose.png
3. Default:   pose unclear/neutral       → walking-pose.png
4. Missing:   "sitting"                  → sitting-pose.png doesn't exist → STOP, ask user to add it
```

The logic itself is deterministic (fixed rules), but the **inference** step (deciding "charging = running") is LLM reasoning. This is a good example of the two working together — you write the rules, the model applies judgment to ambiguous cases.

The hard stop rule `NO POSE = NO IMAGE` is important: rather than guessing or generating a wrong pose, the agent refuses cleanly and asks the user to supply the missing reference. A guard rail in instructions, not code.

---

## Code refactor: definition/handler split

Previous examples had one big `native/tools.js` with everything. Here it's split:

```
src/native/
├── tools.js                  ← thin registry only
├── create-image/
│   ├── definition.js         ← tool schema (what the model sees)
│   ├── handler.js            ← execution logic
│   └── gemini.js             ← Gemini API calls
├── analyze-image/
│   ├── definition.js
│   └── handler.js
└── shared/
    └── image-files.js        ← loadReferenceImages, saveGeneratedImage (used by both)
```

`tools.js` is now just a registry:
```js
export const nativeTools = [createImageDefinition, analyzeImageDefinition]
export const nativeHandlers = {
  create_image: createImage,
  analyze_image: analyzeImage
}
```

Nothing functionally changed — it's a structural refactor. `shared/image-files.js` extracts file operations used by both tools (read images from disk, write output) to avoid duplication.

This is the natural refactor path: start with one file, split when it gets too large. Definition and handler stay close together in the same folder.

---

## Full execution

User types: `"a cyberpunk hacker with neon implants"`

```
Step 1: MCP list           workspace/reference/ → [walking-pose.png, running-pose.png]
         agent decides:    "neutral pose → use walking-pose.png"
Step 2: MCP copy           template.json → prompts/cyberpunk_hacker_172062xxx.json
Step 3: MCP edit           subject.main = "cyberpunk hacker"
                           subject.details = "neon implants on arms and face, dark jacket"
Step 4: MCP read           prompts/cyberpunk_hacker_172062xxx.json → full JSON string
Step 5: native create_image  prompt = <JSON text>
                             reference_images = ["workspace/reference/walking-pose.png"]  ← NEW
                             aspect_ratio = "3:4", image_size = "2k"
                             → Gemini receives JSON prompt + pose image → generates
Step 6: agent responds     "Generated. Saved to workspace/output/cyberpunk_hacker_172xxx.jpg"
```

---

## Key takeaways

1. **Reference image = structural guide, not style template.** Gemini uses it for body position only — style comes from the text prompt.
2. **`pose_reference` section in template.json** documents the image's role explicitly, as part of the prompt itself. Gemini reads this and knows how to interpret the reference.
3. **Inference + hard stop**: agent infers pose from ambiguous descriptions, but refuses cleanly when a required pose file doesn't exist.
4. **Definition/handler split** is a natural refactor as tools grow. Start combined, split when needed. `shared/` for code used by multiple handlers.
5. **`json_image` + `image_guidance` together** = the full "consistent character" stack: locked style (JSON template) + locked pose (reference image) = repeatable results across any subject.
