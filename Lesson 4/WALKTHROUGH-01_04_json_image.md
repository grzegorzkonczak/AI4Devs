# Walkthrough: 01_04_json_image

## Lesson context

This example appears in **"Wsparcie multimodalności oraz załączników"**, section **"Generowanie i wzbogacanie instrukcji oraz referencje"**.

Key lesson insight: structured JSON prompts are useful *for organizing our thinking as much as for the model* — a JSON template separates what to draw (subject) from how to draw it (style rules), making both easier to manage and reuse across many generations.

---

## Important upfront: what hasn't changed

`app.js`, `src/agent.js`, `src/repl.js`, `src/mcp/client.js`, `src/native/gemini.js` — all essentially identical to `image_editing`. Same REPL, same persistent history, same MCP filesystem tools, same Gemini backends, same tool routing.

Focus only on what's new.

---

## What IS new

```
workspace/
├── template.json            ← ✨ the star of this example
├── character-template.json  ← ✨ second template, more complex
├── prompts/                 ← ✨ versioned prompt files land here
├── example.md               ← usage examples for users
├── input/                   ← reference images
└── reference/               ← reference images for style learning
```

Plus: `src/config.js` has a completely different system prompt.
And: `analyze_image` drops the forced-format parser from `image_editing`.

---

## The core new concept: JSON template as prompt

`workspace/template.json` is 130 lines defining a visual style — line work, color palette (exact hex codes), composition rules, lighting, edge treatment, technical settings, and a negative prompt list. **Everything except the subject is locked.**

```json
{
  "subject": {
    "main": "",         ← ONLY these two get filled in per generation
    "details": "",      ←
    "orientation": "three-quarter view, facing slightly left",   ← locked
    "position": "centered horizontally and vertically",           ← locked
    "scale": "occupies 60% of frame height"                       ← locked
  },
  "style": { ... },           ← locked
  "color_palette": { ... },   ← locked (with exact hex codes)
  "composition": { ... },     ← locked
  "lighting": { ... },        ← locked
  "technical": {
    "resolution": "2k",       ← agent reads this to set image_size
    "aspect_ratio": "16:9"    ← agent reads this to set aspect_ratio
  },
  "negative_prompt": [ ... ]  ← passed to Gemini as exclusion list
}
```

The agent's workflow per generation:
```
1. MCP: copy template.json → workspace/prompts/dragon_1720615200000.json
2. MCP: edit ONLY "subject.main" and "subject.details" in that copy
3. MCP: read the complete JSON back from disk
4. Native: pass full JSON text as prompt to create_image
```

**Why this is token-efficient:** Without this pattern the model would either carry the full style spec permanently in context (expensive repeated input tokens), or regenerate it each time (risk of style drift + expensive output tokens).

With the pattern:
- The model's output per generation = just the subject fields (a few dozen tokens)
- Style rules live on disk, fetched once via MCP read
- Every generation inherits the same style automatically

**Changing the style = edit one JSON file.** No code change, no prompt change.

---

## Two templates, two different purposes

**`template.json`** — pencil sketch / watercolor style. Simple. Fills in `main` and `details` only.

**`character-template.json`** — cinematic CGI character key-art. Has an extra section:

```json
{
  "intent": "Generate a consistent 'character presentation card'...",
  "fill_in_rules": {
    "subject_main_rules": "Write 3–8 words naming the subject only...",
    "forbidden_words": "cinematic, filmic, studio, green rim, teal..."
  },
  "subject": { ... },
  ...
}
```

`fill_in_rules` is **instructions for the AI agent on how to fill in the subject fields** — what words are allowed, what's forbidden. This is a prompt inside a template. The template teaches the model how to use it correctly.

More advanced version of the same idea: the template doesn't just lock style, it also guides the agent writing the subject.

---

## `src/config.js` — the instructions

The system prompt looks rigid and step-by-step:
```
1. COPY template → workspace/prompts/{name}_{timestamp}.json
2. EDIT subject only
3. READ prompt file
4. GENERATE with settings from template
5. REPORT path
```

Compare to `image_editing` which was more principle-based. **Why is this acceptable?** Because the steps genuinely don't vary regardless of what subject the user asks for. The only variable is the subject — the process is always copy → edit → read → generate.

This is the edge case where rigid workflow instructions are correct even inside an agent — when the process truly doesn't need to adapt.

The rule `COPY FIRST: Always create a new prompt file, never edit template.json directly` ensures the master template stays pristine. Every generation gets its own versioned JSON in `workspace/prompts/`. You can look back at any generation and see exactly what prompt produced it.

---

## `analyze_image` — subtle difference from `image_editing`

In `image_editing`, analysis used forced text format + `parseAnalysisReport()` to get a structured `{ verdict: "retry" }` — because the agent needed to act on it with a binary decision.

Here, `analyze_image` returns raw analysis text:
```js
return {
  success: true,
  image_path,
  original_prompt,
  aspects_checked: aspects,
  analysis    // ← raw text, not parsed into structured fields
}
```

**Why?** No explicit retry loop in the instructions here. The agent reads the raw analysis and decides what to do on its own. The structured parsing from `image_editing` was only necessary because the model needed to make a programmatic branch (retry or accept). Raw text is fine when the model interprets it itself.

---

## Full execution of one user request

User types: `"a phoenix rising from flames"`

```
Step 1: MCP fs_manage copy   template.json → workspace/prompts/phoenix_1720615200000.json
Step 2: MCP fs_write edit    subject.main = "phoenix"
                             subject.details = "rising from flames, wings spread..."
Step 3: MCP fs_read          workspace/prompts/phoenix_1720615200000.json → full 130-line JSON string
Step 4: native create_image  prompt = <full JSON text>
                             aspect_ratio = "16:9"  (read from technical.aspect_ratio)
                             image_size = "2k"      (read from technical.resolution)
                             → Gemini generates → saved to workspace/output/phoenix_1720615300000.jpg
Step 5: agent responds       "Generated. Prompt saved to workspace/prompts/phoenix_1720615200000.json"
```

---

## Key takeaways

1. **JSON template as prompt** — separates *what* (subject) from *how* (style). Consistent output. Change style by editing one file.
2. **Copy-then-edit** — never touch the master template. Each generation gets its own versioned file with full prompt history.
3. **`fill_in_rules` inside a template** — a "prompt about how to use the prompt". The template teaches the agent to fill it in correctly.
4. **Rigid instructions are sometimes right** — when the process genuinely doesn't vary, step-by-step instructions are acceptable even in an agent context.
5. **Structured output parsing is optional** — only add it when you need to act on the result programmatically. Raw text works fine when the model interprets it itself.
