# Walkthrough: 01_04_image_editing

## Lesson context

This example appears in lesson **"Wsparcie multimodalności oraz załączników"**, section **"Iteracyjne generowanie oraz edycja obrazów"**.

The key pedagogical point: when an agent generates an image, it can't automatically see the result. So you equip the agent with a dedicated image analysis tool — and let the **agent** decide whether to retry, what to change, and when to stop.

This is the workflow-vs-agent distinction again: you could hardcode `for (let i = 0; i < 3; i++) { generate(); analyze(); }` — that's a workflow. Here, the **model decides** whether to retry. That's an agent.

---

## File map

```
app.js
 ├── src/repl.js             ← interactive terminal loop
 │    └── src/agent.js      ← agent loop (+ conversation history returned)
 │         ├── src/api.js   ← OpenAI Responses API (same as image_recognition)
 │         ├── src/mcp/client.js ← filesystem tools via MCP (same as before)
 │         └── src/native/tools.js ← TWO tools: create_image + analyze_image
 │              ├── src/native/gemini.js  ← Gemini image generation (NEW)
 │              └── src/native/vision.js  ← GPT vision for quality check
 └── src/helpers/ ← logger, stats, shutdown (boilerplate)

src/config.js   ← model + instructions with structured workflow steps
mcp.json        ← same files-mcp server as before
workspace/
 ├── input/     ← source images for editing
 ├── output/    ← generated images land here
 └── style-guide.md ← the agent reads this before its first image action
```

---

## What's genuinely new vs `image_recognition`

| Concept | image_recognition | image_editing |
|---|---|---|
| Run mode | One-shot, exits | **REPL — interactive, stays alive** |
| Conversation | Single task | **Persistent history across turns** |
| Image generation | No | **Gemini API (2 backends)** |
| Self-evaluation | No | **generate → analyze → retry loop** |
| LLM providers | GPT only | **GPT (agent + analysis) + Gemini (generation)** |
| Structured output parsing | No | **Yes — forced text format + deterministic parser** |

---

## Step-by-step execution

### `app.js` — entry point (DETERMINISTIC)

Two things new vs image_recognition:

```js
await confirmRun()   // asks "are you sure? this costs tokens"
```

**Boilerplate** — a cost-warning prompt before running. Image generation is significantly more expensive than text.

```js
const shutdown = onShutdown(async () => {
  logStats()
  rl?.close()
  if (mcpClient) await mcpClient.close()
})
await runRepl({ mcpClient, mcpTools, rl })
await shutdown()
```

`onShutdown` registers handlers for `SIGINT` (Ctrl+C) and `SIGTERM` so the app cleans up gracefully even if interrupted. **Boilerplate** for any long-running interactive process.

---

### `src/repl.js` — interactive loop (DETERMINISTIC)

```js
let history = []

while (true) {
  const input = await rl.question("You: ").catch(() => "exit")

  if (input.toLowerCase() === "exit") break
  if (input.toLowerCase() === "clear") {
    history = []
    resetStats()
    continue
  }

  const result = await run(input, { mcpClient, mcpTools, conversationHistory: history })
  history = result.conversationHistory   // ← persist history across turns
  console.log(`\nAssistant: ${result.response}\n`)
}
```

**New concept: persistent conversation history.**

In `image_recognition` each `run()` started fresh. Here `history` accumulates — so the agent remembers previous messages. If you say "now make it darker" it knows what "it" refers to because it has the prior exchange in context.

`clear` resets history — starts a fresh conversation without restarting the server or reconnecting MCP.

---

### `src/agent.js` — agent loop (LLM + DETERMINISTIC)

Almost identical to `image_recognition` with one key difference:

```js
export const run = async (query, { mcpClient, mcpTools, conversationHistory = [] }) => {
  const messages = [...conversationHistory, { role: "user", content: query }]
  // ...
  if (toolCalls.length === 0) {
    messages.push(...response.output)
    return { response: text, conversationHistory: messages }  // ← returns full history
  }
```

Instead of just returning the final text, it returns the **entire message array** including all tool calls and results. The REPL stores this and passes it back next turn. That's how memory works across turns — the model sees the full conversation each time.

---

### `src/config.js` — instructions with structured workflow (CRITICAL LLM DESIGN)

The instructions tell the agent a specific loop:

```
1. Determine the exact filename in workspace/input (if editing)
2. If ambiguous → ask the user first
3. Generate or edit the image
4. Run analyze_image on the result
5. If RETRY → make focused retry based on blocking issues
6. Stop at ACCEPT or after two retries
```

Steps 4–6 are **instructions to the model, not code**. There's no retry loop in `agent.js`. The model reads the verdict from `analyze_image` and decides to retry autonomously. This is the agent pattern — the model controls its own iteration.

Also: `Read workspace/style-guide.md before your first image action` — the agent is instructed to ground itself in a file before acting. The file contains visual style rules. The agent fetches it via MCP filesystem tools on its own.

---

### `src/native/tools.js` — two native tools (LLM + DETERMINISTIC mixed)

**Tool 1: `create_image`** — generate or edit images

```js
parameters: {
  prompt: "...",
  output_name: "...",
  reference_images: [],    // empty = generate from scratch; non-empty = edit
  aspect_ratio: "...",     // optional
  image_size: "..."        // optional
}
```

Handler flow:
1. If `reference_images` empty → `generateImage(prompt)` **(Gemini LLM call)**
2. If 1 reference → `editImage(prompt, base64, mime)` **(Gemini LLM call)**
3. If multiple references → `editImageWithReferences(prompt, images)` **(Gemini LLM call)**
4. Take returned base64 → write to `workspace/output/<name>_<timestamp>.png` **(deterministic)**
5. Return saved file path so agent knows where to find it

---

**Tool 2: `analyze_image`** — self-evaluation

```js
parameters: {
  image_path: "workspace/output/...",
  original_prompt: "...",
  check_aspects: ["prompt_adherence", "visual_artifacts", "anatomy", ...]
}
```

Handler flow:
1. Read image from disk → base64 **(deterministic)**
2. Build detailed analysis prompt with aspects to check **(deterministic)**
3. Call `vision()` with image + prompt **(GPT LLM call)**
4. Parse returned text with `parseAnalysisReport()` **(deterministic)**
5. Return structured verdict object

**New concept: structured output via forced text format + deterministic parser.**

The analysis prompt forces GPT vision to respond in this exact format:
```
VERDICT: ACCEPT or RETRY
SCORE: <1-10>
BLOCKING_ISSUES:
- <item>
MINOR_ISSUES:
- <item>
NEXT_PROMPT_HINT:
- <hint>
```

Then `parseAnalysisReport()` extracts fields with regex:
```js
const extractTaggedValue = (text, tag) => {
  const match = text.match(new RegExp(`^${tag}:\\s*(.+)$`, "im"))
  return match?.[1]?.trim() ?? ""
}
// extractTaggedValue(text, "VERDICT") → "ACCEPT"
```

Why not JSON schema / structured outputs? You could. But vision models sometimes struggle with strict JSON schema mode. A clearly formatted text with unambiguous labels is often more reliable — and you can parse it deterministically yourself.

---

### `src/native/gemini.js` — image generation (LLM CALL, different provider)

**New concept: two providers in one agent, two different APIs.**

The agent loop uses GPT (Responses API) for reasoning and analysis. Image generation uses **Gemini** — completely different API, different endpoint, different response format.

Two backends are supported:

**Backend 1 — Gemini native API:**
```js
POST https://generativelanguage.googleapis.com/v1beta/interactions
{
  model: "gemini-3.1-flash-image-preview",
  input: prompt,                       // text only = generate
  // OR
  input: [{ type: "text", text: prompt }, { type: "image", data: base64 }],
  response_modalities: ["IMAGE"]
}
```

**Backend 2 — OpenRouter:**
```js
POST https://openrouter.ai/api/v1/chat/completions
{
  model: "google/gemini-3.1-flash-image-preview",
  messages: [{ role: "user", content: [text + images] }],
  modalities: ["image", "text"]
}
```

Same underlying model, different endpoint, different request/response shape. `requestImage()` abstracts both behind one interface. Auto-selects based on which API key is present.

Response always comes back as base64 image data — extracted differently per backend but normalized to `{ data, mimeType }` for the caller.

---

### `src/native/vision.js` — quality analysis (LLM CALL)

Identical to `image_recognition`. GPT via Responses API, image as base64 `input_image`. No changes.

---

## The full execution of one user request

User types: *"Restyle workspace/input/photo.jpeg to match workspace/style-guide.md"*

1. **REPL** receives input, appends to history, calls `run()`
2. **Step 1** → GPT decides to read `style-guide.md` first → MCP `fs_read` **(MCP tool)**
3. **Step 2** → GPT calls `create_image` with source image as reference **(Gemini API)**
4. Gemini returns base64 → saved to `workspace/output/result_1234567890.jpg`
5. **Step 3** → GPT calls `analyze_image` with the output path **(GPT vision)**
6. Vision returns analysis text → parsed → `{ verdict: "retry", blockingIssues: [...] }`
7. **Step 4** → GPT reads issues, calls `create_image` again with revised prompt **(Gemini)**
8. **Step 5** → calls `analyze_image` again **(GPT vision)**
9. Verdict: `accept` → agent returns final message
10. **REPL** stores updated history, prints `Assistant: Done! Image saved to...`

---

## Key takeaways

1. **REPL + persistent history** = multi-turn conversation. Pass full `messages` array out of `run()`, store in REPL, pass back next turn.
2. **Self-evaluation loop lives in the system prompt, not in code.** The model manages retry logic autonomously. "Max 2 retries" is an instruction, not a for-loop.
3. **Two LLM providers in one agent** is normal — GPT for reasoning, Gemini for image generation. Each does what it's best at.
4. **Structured text format + parser** is a valid alternative to JSON schema mode — especially for vision models. Force the format, parse deterministically.
5. **Style guide as a runtime file** — change the style by changing the file, not the code. The agent reads it on each run via MCP.
