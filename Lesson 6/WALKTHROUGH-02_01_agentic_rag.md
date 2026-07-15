# Walkthrough: 02_01_agentic_rag

**Lesson:** S02E01 — Zarządzanie kontekstem w konwersacji (Context Management in Conversation)  
**Example:** `02_01_agentic_rag`  
**Theme:** Agentic RAG — LLM-driven document search with persistent conversation history

---

## What this is (lesson context)

Classic RAG is deterministic: embed query → find nearest vectors → inject. **Agentic RAG** lets the LLM decide *what to search*, *how to refine when it fails*, and *when it has found enough*.

The lesson motivates this with a vivid example: ask an agent about "context window management techniques" and it initially searches English keywords on Polish documents → gets nothing → observes the failure → retries with Polish keywords autonomously. No code changed. Just the agent adapting from observation.

This example implements that: a REPL where you ask questions about AI_devs course materials and an agent navigates the files itself.

---

## File map

```
app.js                      ← entry point: confirm → MCP → REPL
mcp.json                    ← MCP server config (files-mcp, FS_ROOT=".")
src/
  config.js                 ← model + reasoning + search instructions (CORE)
  repl.js                   ← REPL loop with persistent conversation state
  agent.js                  ← agent loop (carries conversationHistory across turns)
  mcp/client.js             ← MCP client (same pattern as Lesson 3)
  helpers/
    api.js                  ← chat() + extractors incl. new extractReasoning
    logger.js               ← colored terminal logger (boilerplate)
    stats.js                ← token tracker (boilerplate)
    shutdown.js             ← SIGINT/SIGTERM handler (boilerplate)
demo/example.md             ← pre-run conversation (read without spending tokens)
```

---

## app.js — Entry point

```
banner → confirmRun() → createMcpClient() → listMcpTools() → createReadline() → onShutdown() → runRepl()
```

**`confirmRun()`** asks "do you want to proceed?" before spending tokens. You can read `demo/example.md` first to understand what the agent does for free.

**`rl?.close()`** — `?.` is **optional chaining**: calls `.close()` only if `rl` is not null/undefined. Equivalent to `if (rl) rl.close()`.

---

## mcp.json — MCP server config

```json
{ "files": { "command": "npx", "args": ["tsx", "../mcp/files-mcp/src/index.ts"],
    "env": { "FS_ROOT": "." } } }
```

Same `files-mcp` from Lesson 3. **`FS_ROOT: "."`** sandboxes the agent to the project directory — it can only see files inside `02_01_agentic_rag/`. Put lesson markdowns in `workspace/` and the agent can navigate them.

---

## src/config.js — ⭐ Core of the example

```js
export const api = {
  model: resolveModelForProvider("gpt-5.2"),
  maxOutputTokens: 16384,
  reasoning: { effort: "medium", summary: "auto" },
  instructions: `...`
}
```

### 1. `resolveModelForProvider("gpt-5.2")`
From root `config.js`. If using OpenRouter: prepends `"openai/"` → `"openai/gpt-5.2"`. If OpenAI: returns as-is. Same code works for both providers, no `if/else` at call site.

### 2. `reasoning: { effort: "medium", summary: "auto" }` — NEW
Activates the model's internal reasoning (extended thinking / chain-of-thought) before generating the visible response.
- `effort`: how much compute to use — `"low"`, `"medium"`, `"high"`
- `summary: "auto"`: API returns a summary of the reasoning chain so we can log it

Why reasoning here? Agentic RAG requires planning search strategy, deciding when enough is found, synthesising across documents. More thinking = better decisions.

The API returns `"reasoning"` items in `response.output` alongside `"message"` and `"function_call"` items. `extractReasoning()` in `api.js` pulls those out for logging.

### 3. The instructions — the whole point of the lesson

The system prompt encodes a **search strategy** in four phases:

```
Scan:   explore folder structure + file names before searching
Deepen: iterative multi-phase search:
  1. Search initial keywords + synonyms (at least 3-5 angles)
  2. Read the most promising fragments
  3. Collect NEW terminology discovered while reading
  4. Run follow-up searches with those new terms
  5. Repeat until no new terms emerge
Explore: look for related aspects (cause/effect, part/whole, problem/solution...)
Verify:  before answering, check you have enough for key questions (definitions,
         limits, edge cases, steps, exceptions) — if gaps remain, deepen more
```

**Key insight from the lesson**: these instructions are *generic on purpose*. They describe a search *process*, not the subject matter. They would work equally well for legal documents, a codebase, or a recipe database. The only context-specific line is:

> *"Your knowledge base consists of AI_devs course materials stored as S01*.md files. The content is written in Polish — use Polish keywords when searching."*

Everything else is universal. This is what the lesson means by "system prompt as a map, not a full description of the territory."

**Compared to previous examples**: Lesson 4 and 5 system prompts described goals + rules. This one encodes an *algorithm* — a multi-step process for how to think. The lesson notes this resembles designing generic software components: flexible, not over-specific.

---

## src/helpers/api.js — chat() + extractors

### New: `reasoning` parameter
```js
if (reasoning) body.reasoning = reasoning;
```
Simply passes the reasoning config to the API body.

### New: `...EXTRA_API_HEADERS` spread in object literal
```js
headers: {
  "Content-Type": "application/json",
  Authorization: `Bearer ${AI_API_KEY}`,
  ...EXTRA_API_HEADERS      // ← merges object's key-value pairs in
}
```
`...obj` inside `{}` merges that object's entries. For OpenAI `EXTRA_API_HEADERS = {}` so nothing changes. For OpenRouter it adds `HTTP-Referer` and `X-Title` headers. Same concept as `...rest` in function params but for objects.

### New: `extractReasoning()`
```js
export const extractReasoning = (response) =>
  response.output
    .filter(item => item.type === "reasoning")
    .flatMap(item => item.summary ?? [])
    .map(s => s.text)
    .filter(Boolean)
```

**`flatMap`** — new method. It's `map` + `flat` in one: if `.map()` returns arrays, `.flatMap()` merges them into a single flat array.
```js
[[1,2],[3,4]].flatMap(x => x)  // → [1, 2, 3, 4]
```
Each reasoning item may have multiple summary entries → `flatMap` collapses the nested arrays.

**`?? []`** — nullish coalescing: if `item.summary` is null/undefined, use `[]` instead.

---

## src/agent.js — Agent loop with conversation history

### New: `conversationHistory` parameter
```js
export const run = async (query, { mcpClient, mcpTools, conversationHistory = [] }) => {
  const messages = [...conversationHistory, { role: "user", content: query }]
  // ...agent loop...
  return { response: text, conversationHistory: messages }
}
```

**`conversationHistory = []`** — default parameter: if not passed, starts as empty array.

**`[...conversationHistory, { role: "user", content: query }]`** — spread creates a NEW array (doesn't mutate the original) with all prior history plus the new user message.

**Critical difference from previous examples**: every prior `run()` started fresh. Here the caller passes in the full prior history, and `run()` returns the updated history. The REPL stores it and passes it back next question. Follow-up questions work naturally without re-explaining context.

### Parallel tool execution (familiar from Lesson 4)
```js
const runTools = (mcpClient, toolCalls) =>
  Promise.all(toolCalls.map(tc => runTool(mcpClient, tc)))
```
All tool calls fire in parallel — useful when the LLM fires multiple searches at once.

### Error resilience in `runTool`
```js
} catch (error) {
  return { type: "function_call_output", call_id: toolCall.call_id,
           output: JSON.stringify({ error: error.message }) }
}
```
Failed tool = error returned to LLM as JSON, not a crash. The LLM decides what to do next.

---

## src/repl.js — REPL

```js
let conversation = createConversation()  // { history: [] }

// each turn:
const result = await run(input, { ..., conversationHistory: conversation.history })
conversation.history = result.conversationHistory  // save updated history

// 'clear' command:
conversation = createConversation()
resetStats()
```

**`clear`** resets history and token stats — start a new topic without restarting the process.

**`.catch(() => "exit")`** on the readline question — if readline closes (Ctrl+D), the promise rejects. `.catch` converts the rejection to the string `"exit"` which hits the exit branch cleanly.

---

## New concepts introduced

| Concept | Where | Notes |
|---------|-------|-------|
| `reasoning: { effort, summary }` | `config.js`, `api.js` | Enables extended thinking; API returns reasoning summaries |
| `extractReasoning()` | `api.js` | Extracts `"reasoning"` output items from response |
| `flatMap()` | `api.js` | map + flat in one; new Array method |
| `...spread` in object literal | `api.js` | Merges object entries: `{ ...obj }` |
| `conversationHistory` parameter | `agent.js` | Persistent multi-turn conversation across REPL questions |
| Default parameter `= []` | `agent.js` | If arg missing, use default value |
| `resolveModelForProvider()` | `config.js` | OpenAI/OpenRouter transparent model name resolution |
| Search strategy as system prompt | `config.js` | Generic algorithm, not subject-specific instructions |

---

## Connection to the lesson

The lesson argues: **system prompt = map, not territory**. The agent doesn't need everything upfront — it discovers through tools. The instructions encode *how to navigate*, not *what is there*. Minimum necessary context injected upfront (language hint), universal strategy for the rest.

Reasoning is enabled because search planning benefits from thinking. Conversation history is persistent because context management is the lesson's topic — the agent itself is the demonstration.

---

*Saved: 2026-07-15*
