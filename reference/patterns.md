# Patterns Reference

Recurring architectural patterns for building LLM-powered applications. Each pattern includes what it solves, the core structure, and where it's been seen.

---

## 1. Agent Loop (Function Calling)

**What it solves:** Letting the model autonomously decide which tools to call and when to stop, rather than hardcoding a sequence of steps.

**Structure:**
```js
const messages = [{ role: 'user', content: query }]

for (let step = 0; step < MAX_STEPS; step++) {
  const response = await llm({ input: messages, tools })  // LLM decides what to do

  if (response has no tool calls) {
    return response.text   // model is done
  }

  messages.push(...response.output)                  // append model's tool requests
  const results = await executeTools(response.toolCalls)
  messages.push(...results)                          // append tool results
  // loop — model sees results and decides next action
}
```

**Key insight:** The model sees its own tool call history as part of the conversation. This is how it "knows" what it has already done and what to do next.

**Seen in:** Lesson 3 `proxy.js`, Lesson 4 exercise `agent.js`, `image_recognition/src/agent.js`, `image_editing/src/agent.js`

---

## 2. Tool Definition + Handler Map

**What it solves:** Clean separation between what the model sees (the definition/schema) and what actually runs (the handler function). Adding a new tool is always two things: one entry in definitions, one in handlers.

**Structure:**
```js
// definitions — what the model sees, determines when/how it calls the tool
export const nativeTools = [
  {
    type: 'function',
    name: 'do_something',
    description: 'Clear description of what this does and when to use it',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '...' }
      },
      required: ['input']
    }
  }
]

// handlers — what actually runs when the model calls the tool
export const nativeHandlers = {
  async do_something({ input }) {
    // actual logic here
    return { result: '...' }
  }
}

// routing helpers
export const isNativeTool = (name) => name in nativeHandlers
export const executeNativeTool = async (name, args) => nativeHandlers[name](args)
```

**Seen in:** `native/tools.js` in image_recognition, image_editing; `tools.js` in Lesson 3, Lesson 4 exercise

---

## 3. Native + MCP Tool Routing

**What it solves:** Mixing tools that run in the same process (native) with tools that run in an external MCP server — while the model sees them all as one unified toolset.

**Structure:**
```js
// at setup: combine both tool lists into one array
const tools = [...mcpToolsToOpenAI(mcpTools), ...nativeTools]

// at execution: route by name
const result = isNativeTool(toolCall.name)
  ? await executeNativeTool(toolCall.name, args)   // runs locally
  : await callMcpTool(mcpClient, toolCall.name, args)  // goes to child process over stdio
```

The model never knows or cares which side a tool is on. It just calls by name.

**When to use MCP vs native:**
- **Native**: needs API keys from your process, tight integration, simple logic
- **MCP**: reusable across projects (filesystem, databases), runs in isolation, can be shared with other tools (Claude Desktop, Cursor, etc.)

**Seen in:** `agent.js` in image_recognition, image_editing

---

## 4. Nested LLM Call Inside a Tool

**What it solves:** Some tools need their own LLM call — e.g. analysing an image, or translating text. The outer agent loop uses one model; the tool uses another (or the same) model for a specific sub-task.

**Structure:**
```js
// outer agent loop — uses model A (e.g. GPT for reasoning)
const agentResponse = await chat({ input: messages, tools })

// inside a tool handler — uses model B (e.g. GPT vision for image analysis)
async function analyze_image({ image_path }) {
  const base64 = await readFile(image_path).toString('base64')
  const result = await visionLLM({ imageBase64: base64, question: analysisPrompt })  // nested LLM call
  return parseResult(result)
}
```

**Key insight:** These are independent API calls. The outer model doesn't see the nested LLM call — it only sees the tool's return value. This keeps the outer context lean.

**Seen in:** `image_recognition` (`understand_image` calls GPT vision), `image_editing` (`analyze_image` calls GPT vision, `create_image` calls Gemini)

---

## 5. Two LLM Providers in One Agent

**What it solves:** Different models are best at different things. Use the best tool for each job within the same application.

**Common split:**
- **GPT / Claude** → reasoning, planning, text generation, decision making (agent loop)
- **Gemini image model / GPT-Image-1** → image generation and editing
- **GPT vision / Gemini vision** → image analysis and quality checks

**Structure:** Each provider has its own wrapper function with its own API endpoint, auth, and response parsing. The agent loop and tools just call these wrappers — they don't know or care about the underlying provider.

```js
// agent loop uses GPT
const response = await chat({ input: messages, tools })  // → OpenAI Responses API

// create_image tool uses Gemini
const image = await generateImage(prompt)  // → Gemini Interactions API

// analyze_image tool uses GPT vision
const analysis = await vision({ imageBase64, question })  // → OpenAI Responses API
```

**Seen in:** `image_editing` (GPT for agent + analysis, Gemini for generation)

---

## 6. Persistent Conversation History (REPL)

**What it solves:** Multi-turn interactive agents where each user message should have context from previous turns.

**Structure:**
```js
// REPL maintains history across turns
let history = []

while (true) {
  const userInput = await rl.question('You: ')
  if (userInput === 'exit') break
  if (userInput === 'clear') { history = []; continue }

  const result = await run(userInput, { conversationHistory: history })
  history = result.conversationHistory  // ← full message array returned, stored here
  console.log('Assistant:', result.response)
}

// agent.js prepends history to each new turn
const messages = [...conversationHistory, { role: 'user', content: query }]
// ... at end of run, return full messages array
return { response: text, conversationHistory: messages }
```

**Key insight:** OpenAI's API is stateless — you must send the full conversation every time. The REPL is just a loop that stores and re-passes the accumulated messages.

**Seen in:** `image_editing/src/repl.js` + `agent.js`

---

## 7. Structured Output via Forced Text Format + Parser

**What it solves:** Getting machine-readable structured data from an LLM call without using JSON schema mode — more reliable for vision models and complex outputs.

**Structure:**
```js
// Step 1: force the LLM to respond in a specific labeled format
const prompt = `
Analyze the image and respond EXACTLY in this format:

VERDICT: ACCEPT or RETRY
SCORE: <1-10>
BLOCKING_ISSUES:
- <issue or "none">
NEXT_PROMPT_HINT:
- <hint or "none">
`

const rawText = await vision({ imageBase64, question: prompt })

// Step 2: parse deterministically with regex
const extractTaggedValue = (text, tag) => {
  const match = text.match(new RegExp(`^${tag}:\\s*(.+)$`, 'im'))
  return match?.[1]?.trim() ?? ''
}

const verdict = extractTaggedValue(rawText, 'VERDICT')  // → "ACCEPT"
const score = parseInt(extractTaggedValue(rawText, 'SCORE'))  // → 8
```

**When to use this vs JSON schema mode:**
- Use JSON schema when the model reliably follows it (text-only models usually do)
- Use forced format + parser when JSON schema is unreliable (vision models, complex outputs)

**Seen in:** `image_editing/src/native/tools.js` (`analyze_image` + `parseAnalysisReport`)

---

## 8. Self-Evaluation Loop (Generate → Analyze → Retry)

**What it solves:** Automatically improving output quality through iterative refinement — generate something, evaluate it, retry if it doesn't meet the bar.

**Structure:**
```
Instructions to the model (NOT application code):

1. Generate the output
2. Call analyze tool on the result
3. If verdict is RETRY → revise your approach and generate again, incorporating the blocking issues
4. If verdict is ACCEPT, or after N retries → return final result to user
```

**Critical point:** The retry loop exists in the **system prompt instructions**, not in application code. The agent.js loop just executes whatever tool calls the model makes. This means:
- The model decides what to change between retries (not a fixed algorithm)
- You can adjust retry behavior by changing the instructions, not the code
- The loop terminates when the model decides to stop calling tools

**Seen in:** `image_editing/src/config.js` (instructions steps 4–7)

---

## 9. Goal-Oriented System Prompt (Agent vs Workflow)

**What it solves:** Agents need flexible instructions that guide reasoning — not step-by-step procedures that would make them brittle workflows.

**Workflow-style prompt (rigid, bad for agents):**
```
1. List all files in the images/ folder
2. For each file, read the knowledge/ folder
3. Compare each image to each knowledge file
4. Copy the image to the matching folder
```

**Agent-style prompt (flexible, correct):**
```
## GOAL
Classify images in images/ into categories defined by knowledge/ files.

## REASONING RULES
- Only match when ALL stated criteria are satisfied
- If multiple profiles match, copy to all matching folders
- If no match possible, place in unclassified/
- Mistakes can be corrected by moving files

## PROCESS
Read knowledge files first, then process images incrementally.
```

**Key difference:** The agent prompt describes *what* to achieve and *how to reason*, not *what steps to take*. This lets the model adapt its sequence dynamically based on what it finds.

**Seen in:** `image_recognition/src/config.js`, `image_editing/src/config.js`

---

## 10. Reference Files (Runtime Knowledge via MCP)

**What it solves:** Separating agent behavior rules from the code. Instead of baking rules into the system prompt, the agent reads them from files at runtime.

**Structure:**
```
System prompt instruction:
"Read workspace/style-guide.md before your first image action."

Agent execution:
1. Agent calls MCP fs_read("workspace/style-guide.md")
2. Gets current style rules from disk
3. Uses those rules for the rest of the task
```

**Why this matters:**
- Changing style/behavior = edit a file, not a code deployment
- Multiple agents can share the same knowledge files
- Files can be versioned, previewed, and edited by non-developers

**Seen in:** `image_editing` (style-guide.md), `image_recognition` (knowledge/ folder)

---

## 12. JSON Template as Prompt (Copy-then-Edit)

**What it solves:** Generating consistent output across many runs without the model rewriting the full specification each time. Separates *what* (variable subject) from *how* (locked style rules).

**Structure:**
```
workspace/
├── template.json          ← master template, never touched
└── prompts/
    ├── dragon_172061520.json   ← copy for generation 1
    └── phoenix_172062100.json  ← copy for generation 2
```

```js
// Agent workflow (driven by system prompt instructions):
// 1. MCP copy:  template.json → prompts/{subject}_{timestamp}.json
// 2. MCP edit:  only the "subject" section in the copy
// 3. MCP read:  get the full JSON back as a string
// 4. Native:    pass the full JSON string as the prompt to the image model
```

**The template structure:**
```json
{
  "subject": {
    "main": "",       ← agent fills this in
    "details": ""     ← agent fills this in
  },
  "style": { ... },          ← locked, never touched
  "color_palette": { ... },  ← locked, with exact hex codes
  "technical": {
    "resolution": "2k",      ← agent reads to set image_size param
    "aspect_ratio": "16:9"   ← agent reads to set aspect_ratio param
  },
  "negative_prompt": [ ... ] ← locked
}
```

**Advanced variant — `fill_in_rules`:** Add instructions directly to the template telling the agent how to fill in the subject fields (allowed words, forbidden words, format). The template teaches the model to use it correctly.

```json
{
  "fill_in_rules": {
    "subject_main_rules": "Write 3-8 words naming the subject only. No style words.",
    "forbidden_words": "cinematic, filmic, dramatic, glowing, bokeh..."
  },
  "subject": { ... }
}
```

**Why it's token-efficient:**
- Agent output per generation = a few dozen tokens (just the subject)
- Style rules live on disk, fetched once via MCP read
- No risk of style drift — the locked sections never change

**Key rule:** Always copy first, never edit the master template. Each generation gets its own versioned file — full prompt history for free.

**Seen in:** `01_04_json_image` (`workspace/template.json`, `workspace/character-template.json`)

---

## 11. Parallel Tool Execution

**What it solves:** When the model requests multiple tools in one step, running them in parallel instead of sequentially saves significant time.

**Structure:**
```js
// Instead of:
for (const call of toolCalls) {
  const result = await runTool(call)  // sequential, slow
}

// Do this:
const results = await Promise.all(
  toolCalls.map(call => runTool(call))  // parallel, fast
)
```

**When the model requests multiple tools in one step** (e.g. read 3 files at once), `Promise.all` runs all of them simultaneously. The results are all pushed back to the conversation at once.

**Seen in:** `agent.js` `runTools()` function in image_recognition, image_editing

---

## 14. Image Style Anchor (`image-style.txt`)

**What it solves:** Keeping generated images visually consistent across multiple `create_image` calls in a single document. Models have no memory across tool calls — the anchor file is the shared style memory.

**Structure:**
```
System prompt instruction:
"Before generating the first image, write a style definition to workspace/image-style.txt.
 Include this definition verbatim in every subsequent create_image prompt."

Agent workflow:
1. Decides on style (e.g. "minimalist sketch, ink lines, white background")
2. fs_write("workspace/image-style.txt", styleDefinition)
3. fs_read("workspace/image-style.txt") before each new image
4. Pastes content verbatim into create_image prompt
```

**Example content of `image-style.txt`:**
```
- Medium: minimalist instructional sketch (clean line drawing)
- Rendering: thin-to-medium charcoal/ink lines, no shading, no textures
- Palette: black ink lines on pure white background (#ffffff)
- Detail level: simplified human figure with clear limb angles
- Framing: full-body, centered, consistent scale across poses
```

**Why it works:** Each `create_image` call is independent — there's no shared memory. By forcing the model to read and paste the style spec, style consistency is enforced through the file system, not through model memory.

**Rule from instructions:** *"Style consistency > individual image quality. A cohesive set of simple images beats a mixed set of polished ones."*

**Seen in:** `01_04_reports` (`workspace/image-style.txt`, instructions in `src/config.js`)

---

## 15. HTML Template as Agent Design System

**What it solves:** Preventing inconsistent CSS and wasted tokens when an agent generates document HTML. Pre-build the entire design system once; the agent only writes `<body>` content using known CSS classes.

**Structure:**
```
workspace/
├── template.html      ← master: complete HTML+CSS, never edited
├── style-guide.md     ← explains components and when to use each
└── html/
    └── {document}.html  ← agent clones template, edits body only
```

**Agent instructions:**
```
1. Read workspace/template.html — clone to workspace/html/{name}.html
2. Read workspace/style-guide.md — understand available components
3. Never edit template.html directly
4. In the copy: preserve <head> and all <style> — modify only <body>
5. Each printed page = one <div class="page"> element
```

**Pre-built components the agent can use without writing any CSS:**
- `.page` → one A4 page, handles page-break
- `.metrics` / `.metric` → KPI cards (big number + label)
- `.note` → highlighted info box
- `.status-success/warning/error` → colored status indicator
- `.grid-2` / `.grid-3` → column layouts
- `.page-header` / `.page-footer` → per-page header and footer

**Result:** Consistent dark-theme PDF output, zero CSS written by the agent, no broken styles.

**Seen in:** `01_04_reports` (`workspace/template.html`, `workspace/style-guide.md`, instructions in `src/config.js`)


**What it solves:** Controlling the composition, pose, or framing of generated images without changing the style. Passing a reference image tells the generation model *how to arrange* the subject — while the text prompt still controls *what it looks like*.

**Structure:**
```
workspace/
├── reference/
│   ├── walking-pose.png    ← pose silhouette or sketch
│   └── running-pose.png
└── prompts/
    └── character_172xxx.json   ← versioned JSON prompt
```

```js
// Agent selects pose based on user description:
// "knight charging" → inferred: running → running-pose.png
// "neutral/unclear"  → default: walking-pose.png
// "sitting" → sitting-pose.png doesn't exist → STOP, ask user to add it

// Tool call:
await create_image({
  prompt: fullJsonString,
  reference_images: ['workspace/reference/running-pose.png'],  // ← the guide
  aspect_ratio: '3:4',
  image_size: '2k'
})
```

**Document the image's role inside the template.json:**
```json
"pose_reference": {
  "source": "workspace/reference/walking-pose.png",
  "usage": "Use as pose guidance only - match body position, stance, and gesture",
  "interpretation": "Match the pose exactly but render in the defined art style"
}
```

This section travels with the JSON prompt to the generation model. The model reads it and knows: "this image is a structural guide, not a style template."

**Pose selection logic (in system prompt):**
```
1. Explicit request  → match directly
2. Inferred intent   → reason about what pose fits (LLM judgment)
3. Unclear/neutral   → default to walking
4. Required file missing → refuse and ask user to add it
```

Rule 4 is the key safety guard: never generate with a wrong pose. Hard stop > bad output.

**Combined with JSON Template (Pattern 12):** Together they produce fully reproducible character images — locked style from the JSON template, locked pose from the reference image.

**Seen in:** `01_04_image_guidance` (`workspace/reference/`, `src/config.js`, `workspace/template.json`)

---

## 16. Adaptive Audio Loading (Inline vs Upload)

**What it solves:** Gemini's 20MB inline limit for audio. Small files go inline as base64; large files must be uploaded to Gemini Files API first and referenced by URI. A single loader function hides this from all callers.

**Structure:**
```js
const loadAudio = async (audioPath) => {
  if (isYouTubeUrl(audioPath))
    return { fileUri: audioPath, mimeType: "video/mp4" }     // YouTube: URL passes through

  const buffer = await readFile(join(PROJECT_ROOT, audioPath))
  const mimeType = getAudioMimeType(audioPath)

  if (buffer.length > 20 * 1024 * 1024) {
    const uploaded = await uploadAudioFile(buffer, mimeType, ...)
    return { fileUri: uploaded.fileUri, mimeType }            // large → upload
  }
  return { audioBase64: buffer.toString("base64"), mimeType } // small → inline
}

// All callers spread the result transparently:
const audio = await loadAudio(path)
await processAudio({ ...audio, prompt: "..." })
```

The `processAudio()` function handles both shapes:
```js
if (fileUri) {
  parts.push({ file_data: { file_uri: fileUri, mime_type: mimeType } })
} else {
  parts.push({ inline_data: { data: audioBase64, mime_type: mimeType } })
}
```

**Same principle applies to images** — though the image examples always fit inline.

**Seen in:** `native/tools.js` + `native/gemini.js` in `01_04_audio`

---

## 17. Structured Output via Gemini Response Schema

**What it solves:** Getting structured JSON back from Gemini's multimodal models (audio, vision) — equivalent to OpenAI's structured output mode.

**Structure:**
```js
const body = {
  contents: [{ parts: [{ text: prompt }, audioPart] }],
  generation_config: {
    response_mime_type: "application/json",
    response_schema: {
      type: "OBJECT",
      properties: {
        summary:  { type: "STRING" },
        segments: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              speaker:   { type: "STRING" },
              timestamp: { type: "STRING" },
              content:   { type: "STRING" }
            },
            required: ["speaker", "timestamp", "content"]
          }
        }
      },
      required: ["summary", "segments"]
    }
  }
}

// Always comes back as a JSON string — parse it:
const text = data.candidates?.[0]?.content?.parts?.[0]?.text
return JSON.parse(text)  // → typed object matching the schema
```

**Adding optional fields conditionally with spread:**
```js
const schema = {
  type: "OBJECT",
  properties: {
    content: { type: "STRING" },
    ...(includeTimestamps && { timestamp: { type: "STRING" } }),
    ...(detectEmotions   && { emotion: { type: "STRING", enum: ["happy","sad","neutral"] } })
  }
}
```
`...(cond && { key: val })` — if `cond` is falsy, evaluates to `...false` which JS silently ignores. If truthy, spreads the field into the object. No `if` blocks needed.

**Seen in:** `native/gemini.js` `transcribeAudio()` + `analyzeAudio()` in `01_04_audio`

---

## 18. Start + End Frame Video Generation

**What it solves:** Controlling where a generated video ends up, not just where it starts. Without an end frame, the video model decides the final state. With both frames defined, you control the exact beginning and ending — the model only needs to figure out the motion between them.

**Structure:**
```
Step 1: create_image(template_json, 16:9)         → frame_start.jpg
Step 2: create_image(end_state_prompt,
          reference_images: [frame_start])         → frame_end.jpg   (same character!)
Step 3: image_to_video(motion_prompt,
          start_image: frame_start,
          end_image: frame_end)                    → video.mp4
```

**Why generate end frame FROM start frame?**

A fresh independent generation of "the same character" will have subtle visual differences. By passing the start frame as a reference when generating the end frame, Gemini keeps the character visually identical — only the pose and state change.

End frame prompt example:
```
"Same fox character with identical fur colors and markings, now landed in a fluffy snowdrift.
 Fox is partially buried in snow up to chest, snow particles floating. Keep exact same art style."
```

**When to skip the reference:**
- Character transforms completely (caterpillar → butterfly)
- Scene changes entirely (day → night, different location)
- User explicitly asks for a dramatic change

**Longer video by chaining clips:** Kling is limited to 10 seconds, but the last frame of clip 1 can be the start frame of clip 2 — concatenation (not shown in this example) is the only missing piece.

**Seen in:** `01_04_video_generation` (`src/config.js` instructions, `native/tools.js` `image_to_video` handler)

---

## 19. Human-in-the-Loop Confirmation (Injected Callback)

**What it solves:** An agent that can take real-world irreversible actions (send email, delete files, make payments) must pause and get explicit human approval before executing. The check must be **deterministic code** — not LLM interpretation of "yes/no" text.

**Structure:**
```
agent.js:
  const TOOLS_REQUIRING_CONFIRMATION = new Set(["send_email", "delete_file"])

  if (TOOLS_REQUIRING_CONFIRMATION.has(toolName) && confirmTool) {
    const confirmed = await confirmTool(toolName, args)
    if (!confirmed) return { success: false, rejected: true }
  }

repl.js:
  const trustedTools = new Set()
  const confirmTool = createConfirmationHandler(rl, trustedTools)
  // confirmTool is injected into agent.run()

  // createConfirmationHandler returns a closure:
  async (toolName, args) => {
    if (trustedTools.has(toolName)) return true          // auto-approve if trusted
    // show full UI with all action details
    const answer = await rl.question("Your choice: ")
    if (answer === "t") { trustedTools.add(toolName); return true }  // trust for session
    return answer === "y"
  }
```

**Why inject `confirmTool` as a parameter?**  
`agent.js` is generic — it doesn't own the UI. Different callers (REPL, HTTP endpoint, Telegram bot) provide their own implementation. This is **dependency injection via function parameters** — the agent loop depends on the capability without owning the implementation.

**Trust mechanism:** Once the user presses T, the tool is added to `trustedTools` (a Set). All subsequent calls skip the prompt for that session. `untrust` command clears the set. In production: persist trust between sessions, invalidate if tool schema/name changes (especially for MCP tools that can update silently).

**Tool runs sequentially when confirmation is needed:**
```js
for (const tc of toolCalls) {
  const result = await runTool(...)  // NOT Promise.all — each might pause for input
  results.push(result)
}
```

**Seen in:** `agent.js` + `repl.js` in `01_05_confirmation`

---

## 20. File-Based Security Rules (Whitelist)

**What it solves:** Security constraints that must be enforced at the code level — not in LLM instructions (which can be bypassed or hallucinated around). A whitelist file + validation function is deterministic; system prompt rules are not.

**Structure:**
```
workspace/whitelist.json:
{
  "allowed_recipients": [
    "alice@aidevs.pl",
    "@yourdomain.com"        ← domain pattern: all addresses on this domain
  ]
}

native/tools.js:
const isEmailAllowed = (email, whitelist) => {
  const domain = email.toLowerCase().split("@")[1]
  return whitelist.some(pattern => {
    if (pattern.startsWith("@")) return domain === pattern.slice(1)
    return email.toLowerCase() === pattern.toLowerCase()
  })
}

// If validation fails → return { success: false, error: "not in whitelist" }
// LLM never gets a chance to reach the API
```

**Why not in system prompt?** The LLM could be instructed by malicious input to "ignore the whitelist" (prompt injection). Code-level validation cannot be overridden.

**Seen in:** `native/tools.js` in `01_05_confirmation`

---

## 21. Agent State Machine

**What it solves:** An agent that can pause mid-run (waiting for an external tool result, a human decision, or a child agent) needs a formal state model — not just a boolean "done/not-done". Illegal transitions (e.g. starting an already-running agent) must be caught.

**States:**
```
pending → running → completed
pending → running → waiting → running → completed
pending → running → failed
pending → running → cancelled
```

**Structure (pure functions, no side effects):**
```ts
// Each transition returns { ok: true, agent } | { ok: false, error }
function startAgent(agent: Agent): TransitionResult {
  if (agent.status !== 'pending') return { ok: false, error: `Cannot start: ${agent.status}` }
  return { ok: true, agent: { ...agent, status: 'running', startedAt: new Date() } }
}

function waitForMany(agent: Agent, waiting: WaitingFor[]): TransitionResult {
  if (agent.status !== 'running') return { ok: false, error: ... }
  return { ok: true, agent: { ...agent, status: 'waiting', waitingFor: waiting } }
}
```

**`waiting` state enables:**
- HTTP API returns `202 Accepted` with `waitingFor` list
- External caller later POSTs to `/api/chat/agents/:id/deliver`
- Agent resumes with the delivered result

**Seen in:** `domain/agent.ts` in `01_05_agent`

---

## 22. Event-Driven Observability (Observer Pattern)

**What it solves:** LLM calls, tool executions, and agent lifecycle events need to be logged and monitored — but logging/tracing code shouldn't be scattered throughout business logic.

**Structure:**
```ts
// Runner emits events at key points:
runtime.events.emit({ type: 'tool.called', ctx, callId, name, arguments })
runtime.events.emit({ type: 'generation.completed', ctx, model, input, output, usage, durationMs })
runtime.events.emit({ type: 'agent.completed', ctx, durationMs, usage })

// Subscribers react independently:
subscribeEventLogger(events)  // → structured stdout logs
subscribeLangfuse(events)     // → Langfuse cloud dashboard

// Subscribe to all events with wildcard:
events.onAny((event) => { ... })
// Subscribe to specific type:
events.on('tool.called', (event) => { ... })
```

**EventContext on every event:**
```ts
interface EventContext {
  traceId: TraceId       // shared across entire conversation (for correlation)
  sessionId, agentId, rootAgentId, depth
}
```

**Rule:** Payloads are self-contained — `generation.completed` includes full input/output/usage. Subscribers never call back into the runner. They receive everything they need in the event.

**Seen in:** `events/` + `lib/event-logger.ts` + `lib/langfuse-subscriber.ts` in `01_05_agent`

---

## 23. Provider Abstraction (Common Interface)

**What it solves:** Different LLM providers (OpenAI, Gemini) have different API formats, authentication, tool definitions, and streaming protocols. Business logic shouldn't know which provider it's using.

**Structure:**
```ts
// Common interface:
interface Provider {
  generate(request: ProviderRequest): Promise<ProviderResponse>
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>
}

// Model routing: "openai:gpt-4.1" → resolveProvider() → { provider, model }
const { provider, model } = resolveProvider(agent.config.model)
const response = await provider.generate({ model, instructions, input, tools })
// ↑ same call whether OpenAI or Gemini
```

**Input/output are normalized to common types.** Adapters handle all translation:
- OpenAI: Responses API format (`input` array, `output` array)
- Gemini: Interactions API format (`contents`, `candidates`)

**Web search as native:** `{ type: 'web_search' }` → OpenAI: `web_search_preview` tool / Gemini: `google_search` tool. Translated by each adapter.

**Lesson:** "Wspólny interfejs dla wielu providerów" — this is the direct implementation.

**Seen in:** `providers/` in `01_05_agent`

---

## 24. Multi-Agent Delegation (Agent Spawning)

**What it solves:** Complex tasks benefit from specialized agents. Alice orchestrates, Bob researches. The parent agent calls `delegate({ agent: "bob", task: "..." })` — the runner spawns Bob as a child agent and feeds his result back to Alice.

**Structure:**
```
Alice calls: delegate({ agent: "bob", task: "Find price of gold" })
  ↓
runner.handleDelegation():
  1. Depth guard: exec.depth + 1 <= MAX_AGENT_DEPTH (5)
  2. Load bob.agent.md from disk
  3. Create Bob in DB: { parentId: alice.id, sourceCallId, depth: 1, traceId: same }
  4. Create Bob's first message: { role: "user", content: task }
  5. Run Bob recursively (same runner)
  6. Bob completes → result stored as function_call_output for Alice's call
  7. Alice continues with Bob's result
```

**Hierarchy stored in DB:**
```ts
{ rootAgentId: alice.id, parentId: alice.id, sourceCallId: callId, depth: 1 }
```

**Depth guard prevents infinite recursion** — hard limit in code, not in prompt.

**traceId shared across parent+child** → Langfuse shows full nested trace.

**Seen in:** `runtime/runner.ts` `handleDelegation()` + `tools/definitions/delegate.ts` in `01_05_agent`

---

## 25. Context Pruning + Summarization

**What it solves:** Long conversations exceed the model's context window. When estimated tokens pass a threshold, old items are dropped. To preserve information, the dropped items are summarized by the LLM and injected back as a system message.

**Structure:**
```ts
// Before every LLM call:
if (needsPruning(items, task, model.contextWindow, model.pruning.threshold)) {
  const pruneResult = pruneConversation(items, task, contextWindow, pruning)
  // keeps: task description + most recent turns
  // drops: middle of conversation

  if (enableSummarization && pruneResult.droppedItems.length > 0) {
    summary = await generateSummary(provider, model, droppedItems, session.summary)
    await repositories.sessions.update({ ...session, summary })
  }

  prunedItems = pruneResult.items
}

// Inject summary at top of context:
if (session.summary) {
  input.unshift({
    type: 'message',
    role: 'system',
    content: `[Context Summary — Earlier conversation was compacted]\n\n${session.summary}`,
  })
}
```

**Token estimation:**
```ts
const CHARS_PER_TOKEN = 3.5  // lesson's "chars/4" heuristic, slightly conservative
estimateTokens(text) = Math.ceil(text.length / 3.5)
```

**Lesson:** "wstępna estymacja tokenów poprzez zastosowanie uproszczenia chars / 4" and "można uruchamiać akcje związane z kompresją już przy około 30% zużycia."

**Seen in:** `utils/pruning.ts`, `utils/summarization.ts`, `utils/tokens.ts` in `01_05_agent`

---

## 26. Agent-as-Markdown Template

**What it solves:** Agent behavior should be configurable without code changes. Markdown files are human-readable, version-controllable, and editable by non-developers.

**Structure:**
```markdown
---
name: alice
model: openai:gpt-4.1
tools:
  - calculator
  - delegate
  - files__fs_read
---

You are Alice, a helpful AI assistant...
```

YAML frontmatter (between `---`) = config. Body = system prompt.

**Read fresh on every request** — edit file, next request picks it up immediately. No restart.

**Tool naming convention:**
- `calculator` → built-in tool registry
- `web_search` → provider-native
- `files__fs_read` → MCP: server=files, tool=fs_read (double underscore separator)

**Seen in:** `workspace/agents/*.agent.md` + `workspace/loader.ts` in `01_05_agent`

---

## 27. Repository Pattern (Swappable Data Layer)

**What it solves:** Business logic (runner, routes) should not depend on a specific database. Swapping from SQLite to PostgreSQL, or using in-memory storage for tests, should require zero changes to business logic.

**Structure:**
```ts
// Interface:
interface ItemRepository {
  create(agentId: AgentId, data: NewItemData): Promise<Item>
  listByAgent(agentId: AgentId): Promise<Item[]>
  // ...
}

// Two implementations, same interface:
createSQLiteRepositories({ url })  // production: Drizzle + SQLite
createMemoryRepositories()          // testing: in-memory Maps
```

```ts
// Business logic only touches the interface — never the implementation:
const items = await runtime.repositories.items.listByAgent(agent.id)
```

**Seen in:** `repositories/` in `01_05_agent`

---

## 28. System Prompt as Search Algorithm (Agentic RAG)

**What it solves:** An agent searching documents needs a strategy for *how* to search — not just permission to call search tools. Without a strategy, the agent searches once with the literal query and gives up if it finds nothing. With a strategy, it adapts, deepens, and verifies coverage.

**Structure:**
```
System prompt encodes the algorithm, not the subject matter:

SCAN:   explore structure first — folder hierarchy, file names, headings
DEEPEN (iterative):
  1. Search with initial keywords + synonyms (3-5 angles minimum)
  2. Read most promising fragments from results
  3. Collect NEW terms discovered while reading (new terminology, section names, etc.)
  4. Search again with those newly discovered terms
  5. Repeat until no significant new terms emerge
EXPLORE: for each topic, investigate related angles (cause/effect, part/whole,
          problem/solution, limitations/workarounds, requirements/config)
VERIFY:  before answering, check coverage: definitions, numbers, edge cases, steps, exceptions
         — if gaps remain, go back to DEEPEN
```

**Critical design choice — generic instructions + minimal specific context:**
```
// Generic (stays forever):
"Scan folder hierarchies, search with synonyms, iteratively discover new terms..."

// Minimal specific (just what the agent MUST know upfront):
"Your knowledge base consists of AI_devs course materials stored as S01*.md files.
 The content is written in Polish — use Polish keywords when searching."
```

The lesson compares this to designing generic software components: flexible enough for any subject domain, not so abstract it becomes useless.

**Why reasoning helps here:** Agentic search requires planning (what to search next?) and meta-cognition (have I found enough?). Enabling `reasoning: { effort: "medium" }` lets the model think before acting — especially valuable for the VERIFY phase.

**Seen in:** `src/config.js` instructions in `02_01_agentic_rag`

