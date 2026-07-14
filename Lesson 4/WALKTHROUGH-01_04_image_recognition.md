# Walkthrough: 01_04_image_recognition

## Lesson context

This example appears in lesson **"Wsparcie multimodalności oraz załączników"**, section **"Dopasowanie procesu rozpoznawania obrazu z LLM"**.

The key pedagogical point: when data is dynamic (categories can change, new descriptions can appear), you need an **agent** — not a workflow. Agent instructions should describe the **goal and reasoning rules**, NOT step-by-step procedures. This distinction shapes the entire architecture.

---

## File map — who talks to whom

```
app.js
 ├── src/mcp/client.js      ← connects to MCP server (stdio child process)
 ├── src/agent.js           ← agent loop
 │    ├── src/api.js        ← OpenAI Responses API wrapper
 │    ├── src/mcp/client.js ← calls MCP tools
 │    └── src/native/tools.js ← routes native tools
 │         └── src/native/vision.js ← OpenAI vision call
 └── src/helpers/
      ├── logger.js         ← colored terminal output (boilerplate)
      ├── stats.js          ← token counter (boilerplate)
      └── response.js       ← response text extractor (boilerplate)

src/config.js               ← model name + system prompt (instructions)
../../config.js (root)      ← env loading, API keys, provider switching (boilerplate)
mcp.json                    ← which MCP server to spawn and how
```

---

## Step-by-step execution

### `app.js` — entry point (DETERMINISTIC)

```js
mcpClient = await createMcpClient()       // spawn MCP server process
const mcpTools = await listMcpTools(mcpClient)  // ask it what tools it has
const result = await run(CLASSIFICATION_QUERY, { mcpClient, mcpTools })
```

Three things: spawn MCP → get tools → run agent. The `try/finally` ensures `mcpClient.close()` always runs even on crash — good practice when holding external connections.

---

### `mcp.json` — MCP server config (DETERMINISTIC, config only)

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["tsx", "../mcp/files-mcp/src/index.ts"],
      "env": { "FS_ROOT": "." }
    }
  }
}
```

Tells the app: to get filesystem tools, run this TypeScript server as a child process. `FS_ROOT: "."` sandboxes it to the current directory. The server itself declares its own tools — this file only says how to start it.

---

### `src/mcp/client.js` — MCP connection (DETERMINISTIC, MCP layer)

```js
const transport = new StdioClientTransport({
  command: serverConfig.command,   // "npx"
  args: serverConfig.args,         // ["tsx", "../mcp/files-mcp/src/index.ts"]
  ...
})
await client.connect(transport)
```

**This is where MCP actually happens.** Transport is **stdio** — the client spawns a child process and communicates via stdin/stdout. The `@modelcontextprotocol/sdk` handles the protocol. You call:
- `client.listTools()` → what tools does this server offer?
- `client.callTool({ name, arguments })` → execute one

```js
export const mcpToolsToOpenAI = (mcpTools) =>
  mcpTools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false
  }))
```

Adapter: converts MCP tool format → OpenAI Responses API format. `strict: false` because MCP tool schemas are often flexible and don't satisfy strict mode.

> **Boilerplate**: The `__filename`/`__dirname` reconstruction at the top appears in every ESM file that needs path operations. ESM doesn't have these variables by default (unlike CommonJS), so you reconstruct them from `import.meta.url`.

---

### `src/config.js` — model config + system prompt (DETERMINISTIC, but critical LLM design)

```js
export const api = {
  model: resolveModelForProvider("gpt-5.2"),
  instructions: `You are an autonomous classification agent...`
}
```

The instructions are the most important design decision in the project. Structure:

```
## GOAL      → what to achieve, not how
## PROCESS   → very light starting guidance ("read knowledge/ first")
## REASONING → 5 rules for handling edge cases
```

No "step 1, step 2, step 3" — that would be a workflow. Instead: goals + reasoning principles + freedom to figure out the sequence. The `RECOVERY` rule is notable: *"Mistakes can be corrected by moving files"* — tells the agent the environment is reversible, so it shouldn't be paralyzed by uncertainty.

---

### `../../config.js` (root) — env loading and provider switching (BOILERPLATE)

Shared infrastructure across all course examples. Does:
- Loads `.env` file (uses `process.loadEnvFile` in Node 24+, falls back to manual parsing)
- Reads `AI_PROVIDER` env var → supports `openai` or `openrouter`
- Exports `AI_API_KEY`, `RESPONSES_API_ENDPOINT`, `resolveModelForProvider()`

You won't write this yourself — it's the course author's shared utility. Most interesting part: `resolveModelForProvider()` auto-prefixes model names with `openai/` when using OpenRouter.

---

### `src/api.js` — OpenAI API wrapper (LLM CALL)

⚠️ **New concept: OpenAI Responses API** — not Chat Completions.

```js
const response = await fetch(RESPONSES_API_ENDPOINT, {   // /v1/responses
  body: JSON.stringify({
    model,
    input,         // ← "input", not "messages"
    tools,
    instructions   // ← system prompt as separate field
  })
})
```

Comparison with Chat Completions API (`/v1/chat/completions`):

| Chat Completions | Responses API |
|---|---|
| `messages: [...]` | `input: [...]` |
| `choices[0].message.tool_calls` | `output[]` items with `type: "function_call"` |
| Tool result: `{ role: "tool", tool_call_id, content }` | `{ type: "function_call_output", call_id, output }` |
| Tool def: `{ type: "function", function: { name, ... } }` | `{ type: "function", name, description, parameters }` (flatter) |
| System prompt in messages array | `instructions` separate field |

The Responses API is newer. Everything else (agent loop logic, tool routing) is identical in concept.

---

### `src/agent.js` — agent loop (LLM + DETERMINISTIC mixed)

```js
const tools = [...mcpToolsToOpenAI(mcpTools), ...nativeTools]
```

**Deterministic.** Combines both tool sets into one flat array. The model sees them equally — it doesn't know or care which are MCP vs native.

```js
for (let step = 1; step <= MAX_STEPS; step++) {
  const response = await chat({ input: messages, tools })   // ← LLM CALL
  const toolCalls = extractToolCalls(response)

  if (toolCalls.length === 0) {
    return { response: extractText(response) }              // ← done
  }

  messages.push(...response.output)                         // grow history
  const results = await runTools(mcpClient, toolCalls)      // DETERMINISTIC
  messages.push(...results)                                  // grow history
}
```

`MAX_STEPS = 100` is generous — classifying many images takes many tool calls (list dir, read knowledge files, read images, copy files...).

**Important:** `runTools` uses `Promise.all` — all tool calls in one step run **in parallel**. If the model calls 3 filesystem tools at once, they execute simultaneously.

The routing:
```js
const result = isNativeTool(toolCall.name)
  ? await executeNativeTool(toolCall.name, args)   // local JS function
  : await callMcpTool(mcpClient, toolCall.name, args)  // → MCP server over stdio
```

`isNativeTool` just checks if the name is a key in `nativeHandlers`. Simple string lookup.

---

### `src/native/tools.js` + `src/native/vision.js` — vision tool (LLM CALL inside a tool)

```js
export const nativeTools = [{
  type: "function",
  name: "understand_image",
  description: "Analyze an image and answer questions about it...",
  parameters: {
    properties: {
      image_path: { type: "string" },
      question: { type: "string" }
    }
  }
}]
```

When the model calls `understand_image`:
1. Read image from disk → buffer → base64 **(deterministic)**
2. Detect MIME type from file extension **(deterministic)**
3. Call `vision()` **(LLM call)** → returns description text

`vision.js` makes a **second, nested OpenAI Responses API call** with `type: "input_image"` in the content array. Same pattern used in our Lesson 4 exercise — a nested LLM call inside a tool.

**Why native instead of MCP?** Because it needs the OpenAI API key and makes a direct HTTP call. The MCP server is a separate process — keeping this in the main process is simpler.

---

### `src/helpers/` — pure boilerplate

- **`logger.js`** — colored terminal output. No logic. Boilerplate.
- **`stats.js`** — accumulates token usage across all API calls. Module-level variable (`let totalTokens`). Useful for knowing cost. Boilerplate.
- **`response.js`** — extracts plain text from Responses API output. Needed because the response structure is deeply nested (`output[].content[].text`). Boilerplate.

---

## What's new vs Lesson 3/4

| Concept | Lesson 3/4 | This example |
|---|---|---|
| API used | Chat Completions `/v1/chat/completions` | Responses API `/v1/responses` |
| Tool format | `function.name`, nested | `name` flat on tool object |
| Tool results | `role: "tool"` | `type: "function_call_output"` |
| MCP | Not used | MCP over stdio (child process) |
| Tool routing | All native | Native + MCP, auto-routed by name |
| Parallel tools | Sequential | `Promise.all` |
| System prompt | `role: "system"` in messages | `instructions` separate field |

The core loop concept is identical — call model → execute tools → feed results back → repeat. The differences are API format and the MCP layer on top.

---

## Key takeaways

1. **MCP via stdio** = spawn a server as a child process, talk over stdin/stdout. The SDK handles the protocol. You just call `listTools()` and `callTool()`.
2. **Responses API** is newer than Chat Completions. Different field names, same concept.
3. **Mixed tool routing**: combining MCP + native tools in one array is clean — the model picks by name, your code routes by checking `isNativeTool()`.
4. **Agent instructions** should be goal-oriented and principle-based, not step-by-step. Steps = workflow. Principles = agent.
5. **`Promise.all` for tools** = parallel execution when multiple tools are called in one step.
