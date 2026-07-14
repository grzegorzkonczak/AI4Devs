# Walkthrough: 01_05_agent

**Lesson 5 — Managing Model Limits and Production Architecture**  
**Example:** Full production-grade Agent API server

---

## Lesson Context

The lesson describes this as a demonstration of what a production AI agent application looks like end-to-end:

> *"Naszym zadaniem będzie: przygotowanie minimalnej struktury bazy danych, zaprojektowanie interfejsu API, wsparcie dwóch różnych providerów, stworzenie interfejsu dla narzędzi i MCP, podłączenie monitorowania, deployment przez GitHub Actions"*

Key lesson reference: the app directly implements concepts from sections:
- **Kontrola** (Control) → agent status machine, waiting/resume
- **Wydajność** (Performance) → context pruning, summarization, streaming
- **Limity tokenów** → `utils/tokens.ts`, `utils/pruning.ts`
- **Bezpieczeństwo** → API key hashing, rate limiting
- **Monitorowanie** → event system + Langfuse integration
- **Stabilność** → graceful shutdown, timeout middleware
- **Wspólny interfejs** (Unified provider interface) → `providers/` abstraction layer

> *"100% kodu źródłowego zostało wygenerowane przez Opus 4.5/4.6 w ciągu niespełna 3 godzin"*

**First TypeScript example.** TypeScript = JavaScript + type annotations. Compiled to JS (see `dist/`). The types don't change behavior — they add editor intelligence and catch errors at compile time.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     HTTP API (Hono)                          │
│  POST /api/chat/completions   GET /api/chat/agents/:id       │
│  POST /api/chat/agents/:id/deliver  GET /api/mcp/servers     │
├────────────┬────────────────────────────────────────────────┤
│ Middleware │  bearerAuth → rateLimiter → injectRuntime       │
├────────────┴──────────────┬─────────────────────────────────┤
│   chat.service.ts          │  chat.turn.ts (session setup)   │
├───────────────────────────┴─────────────────────────────────┤
│              runtime/runner.ts (agent loop)                  │
│  LLM call → tool dispatch → sync/MCP/delegate/defer         │
│  context pruning + summarization                            │
├────────────┬──────────────┬──────────────┬──────────────────┤
│  providers │     tools    │     mcp      │     events       │
│ OpenAI     │ calculator   │ stdio/HTTP   │ emitter          │
│ Gemini     │ delegate     │ OAuth        │ event-logger     │
│ (common    │ MCP tools    │              │ langfuse         │
│ interface) │              │              │                  │
├────────────┴──────────────┴──────────────┴──────────────────┤
│              repositories (database layer)                   │
│    users   sessions   agents   items   (Drizzle + SQLite)    │
├─────────────────────────────────────────────────────────────┤
│             workspace/agents/*.agent.md                      │
│              Agent templates (markdown files)                │
└─────────────────────────────────────────────────────────────┘
```

---

## New JS / Node.js / TypeScript Concepts

### TypeScript
JavaScript with type annotations. Types are stripped at runtime. `interface`, `type`, generics `<T>` are TypeScript-only syntax. The `dist/` folder contains the compiled `.js` output — that's what actually runs.

### Hono (HTTP framework)
Modern, lightweight alternative to Express. `app.use(middleware)` registers middleware, `app.route('/api', routes)` mounts route groups. The `<AppEnv>` generic tells Hono what custom variables requests carry.

### `timer.unref()`
A Node.js timer keeps the process alive. `.unref()` says: "don't keep the process alive just for this timer." Used on shutdown timeout — if everything finishes first, let the process exit cleanly.

### `AsyncIterable` / `for await`
An object you can loop over asynchronously, receiving values one at a time as they arrive:
```ts
for await (const event of provider.stream(request)) {
  if (event.type === 'text_delta') process.stdout.write(event.delta)
}
```
Used for SSE streaming — browser sees tokens appear in real time.

### Drizzle ORM
Maps TypeScript objects to SQLite tables. Schema defined in code; Drizzle generates migrations. `mode: 'json'` auto-serializes complex fields.

### `gray-matter`
Parses YAML frontmatter from markdown files:
```ts
const { data, content } = matter(fileContent)
// data = { name: "alice", tools: [...] }
// content = "You are Alice..."
```

### `crypto.subtle.digest('SHA-256', data)`
Built-in Node.js Web Crypto API. Hashes data to bytes; convert to hex with `Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2,'0')).join('')`.

### TypeScript discriminated unions
```ts
type Result = { ok: true; agent: Agent } | { ok: false; error: string }
if (result.ok) { /* result.agent available */ }
else { /* result.error available */ }
```
TypeScript narrows the type based on the discriminant (`ok`).

---

## Layer 1: Entry Point & HTTP Server — `src/index.ts` + `src/lib/app.ts`

**Startup sequence:**
```ts
await initRuntime()   // wire all components (see Layer 2)
const server = serve({ fetch: app.fetch, port, hostname })
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
```

**Middleware stack** (every `/api/*` request traverses top to bottom):
```
requestId()        → unique ID per request (for log correlation)
HTTP logger        → log method/path/status/duration
secureHeaders()    → security headers (X-Frame-Options etc.)
cors()             → allow cross-origin requests
bodyLimit()        → reject bodies over 1MB
timeout()          → fail after 60s
injectRuntime      → attach RuntimeContext to request vars
bearerAuth         → hash Bearer token, look up user in DB
rateLimiter        → reject if user over request limit
```

This is the lesson's "typowe techniki znane z klasycznych aplikacji" (typical techniques from classic apps) applied to an AI API.

**Graceful shutdown with force-exit deadline:**
```ts
const forceTimer = setTimeout(() => { process.exit(1) }, config.shutdownTimeoutMs)
forceTimer.unref()        // don't keep process alive for this timer
server.close(async () => {  // stop accepting new connections, drain in-flight
  await shutdownRuntime()
  process.exit(0)
})
```

---

## Layer 2: Runtime Init — `src/lib/runtime.ts`

Creates all components once on startup, packages them into `RuntimeContext`:

```ts
// 1. Register providers (whichever API keys are present)
if (config.openaiApiKey) registerProvider(createOpenAIProvider(...))
if (config.geminiApiKey) registerProvider(createGeminiProvider(...))

// 2. Database
const repositories = await createSQLiteRepositories({ url: config.databaseUrl })

// 3. Built-in tools
const tools = createToolRegistry()
tools.register(calculatorTool)
tools.register(delegateTool)

// 4. MCP connections from .mcp.json
const mcpManager = await createMcpManager(cwd, baseUrl)

// 5. Agent templates from workspace/
const agentNames = await listAgentNames(config.workspacePath)

// 6. Event emitter + subscribers
const events = createEventEmitter()
subscribeEventLogger(events)    // → stdout
subscribeLangfuse(events)       // → cloud dashboard (if keys present)

// 7. Package and store
runtime = createContext(events, repositories, tools, mcpManager)
```

`injectRuntime` middleware attaches this to every request. Routes access everything via `ctx.repositories`, `ctx.tools`, `ctx.mcp`, `ctx.events`.

**Langfuse:** Optional observability platform. When keys are in `.env`, every event the runner emits (LLM calls, tool calls, agent lifecycle) gets forwarded to the dashboard — token counts, durations, errors, all without touching business logic. Lesson section: "Monitorowanie i logowanie aplikacji."

---

## Layer 3: Agent Templates — `workspace/agents/*.agent.md`

Agents are **markdown files with YAML frontmatter**:

```markdown
---
name: alice
tools:
  - calculator
  - delegate
  - files__fs_read
  - files__fs_write
  - files__fs_search
---

You are Alice, a helpful AI assistant...
```

The frontmatter (`---...---`) is structured config. The body is the system prompt.

**Read fresh on every request** — no caching:
```ts
const template = await loadAgentTemplate(filePath)  // disk read
```
Edit the file → next request gets the new behavior. No server restart.

**Tool naming conventions:**
- `calculator`, `delegate` → built-in tool registry
- `web_search` → provider-native (OpenAI web_search_preview / Gemini google_search)
- `files__fs_read` → MCP tool (server=files, tool=fs_read, separated by `__`)

**Alice → Bob delegation setup:**
- Alice has `delegate` tool + `files__*` tools (file system + math)
- Bob has only `web_search` (research specialist)
- Alice's system prompt: "Delegate web research tasks to bob"
- This creates a two-agent team: Alice orchestrates, Bob researches

---

## Layer 4: Domain Model (Agent State Machine) — `src/domain/agent.ts`

Pure TypeScript — no side effects, just data types and transition functions.

**Agent status machine:**
```
pending → running → completed
pending → running → waiting → running → completed
pending → running → failed
pending → running → cancelled
```

Each transition is a pure function returning `{ ok: true, agent } | { ok: false, error }`:
```ts
function startAgent(agent: Agent): TransitionResult {
  if (agent.status !== 'pending') return { ok: false, error: `Cannot start: ${agent.status}` }
  return { ok: true, agent: { ...agent, status: 'running', startedAt: new Date() } }
}
```

**`waiting` status** — completely new vs Lesson 4. Agent pauses mid-run waiting for an external tool result. HTTP response returns `202 Accepted` with `waitingFor`. Later: `POST /api/chat/agents/:id/deliver` resumes it.

**Agent hierarchy fields:**
```ts
rootAgentId: AgentId     // the top-level agent that started this chain
parentId?: AgentId       // Alice's ID (for Bob)
sourceCallId?: CallId    // the specific function_call that spawned Bob
depth: number            // 0=Alice, 1=Bob, 2=Bob's child if any
```

State machine approach prevents illegal transitions — calling `startAgent()` on a running agent returns an error instead of silently corrupting state.

---

## Layer 5: Event System — `src/events/`

Observer pattern applied to agent lifecycle. The runner emits events; subscribers react.

**17 event types covering:** agent lifecycle, turn lifecycle, LLM generation, tool execution, batch operations, streaming.

**EventContext on every event:**
```ts
interface EventContext {
  traceId: TraceId       // same across entire conversation (for Langfuse correlation)
  sessionId: SessionId
  agentId: AgentId
  rootAgentId: AgentId
  depth: number
}
```

**Wildcard listener:**
```ts
emitter.emit(event.type, event)  // fires specific listeners
emitter.emit('*', event)         // fires catch-all listeners
```
`subscribeEventLogger` uses `onAny()` to catch everything for stdout logging.

**Payloads are self-contained** — `generation.completed` includes full input/output/usage. Subscribers never need to call back into the runner. They're fully decoupled.

**Why this matters:** The lesson says "zapisywać i monitorować wszystkie zdarzenia" (log and monitor all events). By emitting events from the runner and subscribing Langfuse, the entire LLM interaction history is observable from outside the agent loop — without any monitoring code inside the business logic.

---

## Layer 6: Provider Abstraction — `src/providers/`

Common interface for OpenAI and Gemini:
```ts
interface Provider {
  name: string
  generate(request: ProviderRequest): Promise<ProviderResponse>
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>
}
```

Both providers implement this. The runner calls `provider.generate()` — doesn't know which provider it is. Adapters in `providers/openai/adapter.ts` and `providers/gemini/adapter.ts` handle translation.

**Model routing:** `"openai:gpt-4.1"` → `resolveProvider()` → `{ provider: openaiInstance, model: "gpt-4.1" }`.

**Web search as native:** `{ type: 'web_search' }` is translated to:
- OpenAI: `web_search_preview` tool
- Gemini: `google_search` tool

**SSE streaming:** `stream()` returns an `AsyncIterable<ProviderStreamEvent>`. The route handler pipes these events to the HTTP response as Server-Sent Events.

Lesson: "Wspólny interfejs dla wielu providerów" — this is the direct implementation.

---

## Layer 7: The Runner — `src/runtime/runner.ts`

The agent loop — familiar core, dramatically extended.

**Tool dispatch (three categories):**
```
function_call received:
  ├── MCP tool? (has __)       → callMcpTool() immediately → store result → continue
  ├── sync tool? (in registry) → execute() immediately → store result → continue
  ├── agent tool? (type=agent) → handleDelegation() → spawn child → wait for child
  └── unknown tool?            → add to waitingFor → pause, return waiting status
```

**Context pruning (before every LLM call):**
```ts
if (needsPruning(items, task, contextWindow, threshold)) {
  const pruneResult = pruneConversation(items, ...)
  // drop oldest items, keep: task description + recent turns

  if (enableSummarization && pruneResult.droppedItems.length > 0) {
    summary = await generateSummary(provider, model, droppedItems)
    // store in session.summary, inject at top of next context:
    input.unshift({ role: 'system', content: `[Context Summary]\n\n${summary}` })
  }
}
```

Token estimation: `chars / 3.5` — the lesson's chars/4 heuristic, slightly conservative.

**What's new vs Lesson 4:**
| Lesson 4 examples | 01_05_agent |
|-------------------|-------------|
| In-memory messages[] | Persisted to SQLite |
| Single user | Multi-user via sessionId |
| Always runs to completion | Can pause (waiting status) |
| No token tracking | Pruning + summarization |
| No events | 17 rich event types |
| One provider hardcoded | Provider abstraction |
| Tools run immediately | sync / MCP / agent / deferred |

---

## Layer 8: Multi-Agent Delegation — `delegate` tool + `handleDelegation()`

Alice calls `delegate({ agent: "bob", task: "Find current price of gold" })`.

Runner intercepts in `handleTurnResponse()`:
```ts
if (tool.type === 'agent') {
  // Depth guard: max 5 levels deep
  if (exec.depth + 1 > MAX_AGENT_DEPTH) return { type: 'error', ... }

  // Load Bob's template from disk
  const template = await getAgent("bob")

  // Create Bob in database (linked to Alice via parentId + sourceCallId)
  const child = await runtime.repositories.agents.create({
    parentId: parent.id,
    sourceCallId: callId,
    depth: exec.depth + 1,
    ...
  })

  // Add task as Bob's first message
  await runtime.repositories.items.create(child.id, { role: 'user', content: task })

  // Run Bob recursively — same runner, different agent
  const childResult = await runAgentInternal(child.id, ...)

  // Bob's result → back to Alice as function_call_output
}
```

Full delegation chain saved in DB: Alice → Bob → result → Alice. The `traceId` is shared, so Langfuse shows the full nested trace.

---

## Layer 9: Database — `src/repositories/sqlite/schema.ts`

Four tables with Drizzle ORM:

**`users`** — API key hashes (SHA-256, never plain text)

**`sessions`** — conversation threads
- `summary` field: accumulated LLM summary when context is pruned

**`agents`** — every agent run (including delegated children)
- `status` enum: `pending | running | waiting | completed | failed | cancelled`
- `waitingFor` JSON: `[{ callId, type, name }]` — what the agent is waiting for
- `rootAgentId`, `parentId`, `sourceCallId`, `depth` — full hierarchy

**`items`** — conversation entries (polymorphic)
- `type` enum: `message | function_call | function_call_output | reasoning`
- Stores ALL conversation history persistently per agent

**SHA-256 API key hashing (`middleware/auth.ts`):**
```ts
const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(apiKey))
const hex = Array.from(new Uint8Array(hashBuffer))
  .map(b => b.toString(16).padStart(2, '0')).join('')
```
Database stores only the hash. If DB is leaked, raw keys can't be recovered.

---

## Layer 10: Repository Pattern

All DB access through repository objects — never direct SQL in routes or runner:
```ts
runtime.repositories.agents.create(...)
runtime.repositories.items.listByAgent(agentId)
runtime.repositories.sessions.update(session)
```

Two implementations:
- `repositories/sqlite/` — real Drizzle SQLite
- `repositories/memory.ts` — in-memory (no DB URL needed, used for testing)

Both implement the same interface. Swapping = zero code changes in runner or routes. Same dependency injection principle as `confirmTool` in 01_05_confirmation, applied to the data layer.

---

## Layer 11: MCP with OAuth — `src/mcp/`

Extends Lesson 4's stdio-only MCP with HTTP MCP + OAuth 2.1:

```json
"remote": { "transport": "http", "url": "https://mcp-server.example.com/mcp" }
```

**OAuth flow:**
1. Server connects → gets `401` → status = `auth_required`
2. `GET /api/mcp/remote/auth` → returns `authorizationUrl`
3. User opens URL in browser → authorizes
4. Browser redirects to `/mcp/remote/callback` (public endpoint, no auth)
5. Callback exchanges code → stores tokens in `.mcp.oauth.json`
6. Connection established; tokens survive restarts

---

## Full Concept Index

| Concept | Status | Location |
|---------|--------|----------|
| TypeScript | 🆕 New | Entire codebase |
| Hono (HTTP framework) | 🆕 New | `lib/app.ts` |
| Drizzle ORM + SQLite | 🆕 New | `repositories/sqlite/` |
| YAML frontmatter (gray-matter) | 🆕 New | `workspace/loader.ts` |
| Agent state machine | 🆕 New | `domain/agent.ts` |
| Event emitter (observer pattern) | 🆕 New | `events/` |
| Langfuse tracing | 🆕 New | `lib/langfuse-subscriber.ts` |
| Provider abstraction | 🆕 New | `providers/` |
| AsyncIterable / SSE streaming | 🆕 New | `providers/types.ts`, `routes/chat.ts` |
| Multi-agent delegation | 🆕 New | `runtime/runner.ts` `handleDelegation()` |
| Context pruning + summarization | 🆕 New | `utils/pruning.ts`, `utils/summarization.ts` |
| SHA-256 API key hashing | 🆕 New | `middleware/auth.ts` |
| Repository pattern | 🆕 New | `repositories/` |
| Rate limiting | 🆕 New | `middleware/rate-limit.ts` |
| `timer.unref()` | 🆕 New | `index.ts` |
| MCP OAuth 2.1 | 🆕 New | `mcp/oauth.ts` |
| Agent loop | ♻️ Expanded | `runtime/runner.ts` |
| MCP stdio client | ♻️ Expanded | `mcp/client.ts` |
| SIGINT/SIGTERM graceful shutdown | ♻️ Expanded | `index.ts` |
| Token estimation (chars/4) | ♻️ Expanded | `utils/tokens.ts` |
| Tool definitions + handlers | ♻️ Familiar | `tools/` |
| Native tools + MCP routing | ♻️ Familiar | `runtime/runner.ts` |

---

## Key Lesson Connections

| Lesson concept | Where implemented |
|---------------|-------------------|
| Heartbeat / observability | Event system → Langfuse |
| Wznawianie zadań (task resumption) | `waiting` status, `deliver` endpoint |
| Limity zapytań (rate limits) | `middleware/rate-limit.ts` |
| Zarządzanie kontekstem (context mgmt) | `utils/pruning.ts`, summarization |
| Wspólny interfejs providerów (common interface) | `providers/` abstraction |
| Brak frameworków AI (no AI frameworks) | No LangChain — pure fetch + adapters |
| Logowanie i monitorowanie (logging + monitoring) | `events/` + Langfuse |
| Bezpieczeństwo API (API security) | SHA-256 hashing, bearerAuth |
| Wielowątkowość (concurrency) | sessionId-based, agents table |
