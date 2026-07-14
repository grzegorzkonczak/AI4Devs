# Walkthrough: 01_05_confirmation

**Lesson 5 — Managing Model Limits and Control**  
**Example:** File & Email Agent with Human-in-the-Loop Confirmation

---

## Lesson Context

Lesson 5's theme is **production limits and control**. The first major section covers the **Control** principle:

> Confirmation MUST contain all details and MUST happen deterministically through code — pressing a button — NOT through an LLM deciding whether the user approved.

This example is the direct implementation of that principle. An agent that can send real emails must ask the user before doing so, and the user confirms by pressing a physical key — not by typing "yes" which the LLM would interpret.

The lesson also introduces the **trust mechanism** — requiring confirmation for every single action becomes annoying in practice. Once a user has reviewed and approved a tool, they should be able to mark it as trusted for the session, skipping future prompts.

---

## Project Structure

```
app.js                 ← entry point
src/
  agent.js             ← agent loop with confirmTool hook
  repl.js              ← REPL + terminal confirmation UI + trust mechanism
  config.js            ← env guard for RESEND keys + model settings
  native/
    tools.js           ← send_email tool + whitelist validation
    resend.js          ← Resend API REST client
  mcp/
    client.js          ← MCP stdio client (identical to prior examples)
  helpers/
    api.js             ← chat() wrapper (familiar)
    logger.js          ← colored terminal logger (NEW)
    stats.js           ← token usage tracker (NEW)
    shutdown.js        ← graceful SIGINT/SIGTERM handler (NEW)
workspace/
  whitelist.json       ← allowed email addresses and domain patterns
```

---

## New JS / Node.js Concepts

### `new Set()`
A Set is like an array but ensures all values are unique. No duplicates allowed.
```js
const trustedTools = new Set()
trustedTools.add("send_email")   // adds value
trustedTools.has("send_email")   // true
trustedTools.clear()             // empties the set
```
Used here to track which tools the user has trusted for the session.

### Closures capturing mutable state
`createConfirmationHandler(rl, trustedTools)` returns an inner function that **still has access** to `trustedTools` even after the outer function finishes. When that inner function calls `trustedTools.add(...)`, it modifies the same Set that `runRepl` can see.
```js
const createConfirmationHandler = (rl, trustedTools) => async (toolName, args) => {
  // trustedTools is captured — lives as long as this function lives
  if (trustedTools.has(toolName)) return true
  // ...
  trustedTools.add(toolName)  // modifies shared state
}
```

### ANSI escape codes (terminal colors)
`\x1b[32m` = start green, `\x1b[0m` = reset to default. The `colors` object maps readable names to these codes.
```js
const colors = { green: "\x1b[32m", reset: "\x1b[0m" }
console.log(`${colors.green}Success${colors.reset}`)
```

### Signal handling: `process.on("SIGINT", handler)`
Ctrl+C in the terminal sends a `SIGINT` signal. By default Node.js exits immediately. Registering a handler lets us run cleanup (close connections, log stats) before exit.
```js
process.on("SIGINT", handler)   // Ctrl+C
process.on("SIGTERM", handler)  // system shutdown request
```

### Module-level singleton state (`stats.js`)
```js
let totalTokens = { input: 0, output: 0, requests: 0 }
export const recordUsage = (usage) => { totalTokens.input += usage.input_tokens }
```
Because ES modules are cached (loaded once), `totalTokens` is shared across the entire app. Every call from `api.js` updates the same object.

### `.split("@")[1]` — splitting strings
```js
"alice@aidevs.pl".split("@")  // → ["alice", "aidevs.pl"]
"alice@aidevs.pl".split("@")[1]  // → "aidevs.pl"
```

### `.slice(1)` — remove first character
```js
"@aidevs.pl".slice(1)  // → "aidevs.pl"
```

### `.some()` — array check
Returns `true` if at least one element satisfies the condition. Stops early.
```js
["a", "b", "c"].some(x => x === "b")  // true
```

### `.padEnd(n)` — string padding for UI alignment
```js
"Alice".padEnd(52)  // "Alice" + 47 spaces → total 52 chars wide
```
Used in `formatEmailConfirmation` to align the table columns.

---

## Startup: `app.js`

```js
mcpClient = await createMcpClient()
const mcpTools = await listMcpTools(mcpClient)
rl = createReadline()
const shutdown = onShutdown(async () => { logStats(); rl?.close(); closeMcpClient(mcpClient) })
await runRepl({ mcpClient, mcpTools, rl })
```

Familiar: connect MCP → discover tools → start REPL.

**`onShutdown(cleanup)`** — registers SIGINT/SIGTERM handlers and returns the handler function. The handler is also awaited at the end of `main()` so graceful shutdown can be triggered by either Ctrl+C OR by the REPL's `exit` command.

---

## REPL: `repl.js`

```js
let conversation = createConversation()
const trustedTools = new Set()
const confirmTool = createConfirmationHandler(rl, trustedTools)
```

`confirmTool` is a function created by the factory. It closes over `trustedTools` (shared Set) and `rl` (readline for user input).

### Trust mechanism flow:
1. User types a message → agent calls `send_email`
2. Agent checks: is `send_email` in `TOOLS_REQUIRING_CONFIRMATION`?
3. YES → calls `confirmTool("send_email", args)` → handler shows terminal UI
4. User presses:
   - **Y** → returns `true` → email is sent
   - **T** → `trustedTools.add("send_email")`, returns `true` → email sent; next call auto-approved
   - **N** → returns `false` → agent gets `{ success: false, rejected: true }` → tells user it was cancelled

### Special REPL commands:
| Command | Effect |
|---------|--------|
| `exit` | Quit |
| `clear` | Reset conversation history, trust list, token stats |
| `untrust` | Clear trust list only |

---

## Agent Loop: `agent.js`

Critical change vs. Lesson 4: `confirmTool` is injected as a parameter:

```js
export const run = async (query, { mcpClient, mcpTools, conversationHistory = [], confirmTool }) => {
```

Inside `runTool`:
```js
if (TOOLS_REQUIRING_CONFIRMATION.has(toolName) && confirmTool) {
  const confirmed = await confirmTool(toolName, args)
  if (!confirmed) {
    return { type: "function_call_output", call_id: toolCall.call_id,
      output: JSON.stringify({ success: false, error: "User rejected the action", rejected: true })
    }
  }
}
```

**Why `confirmTool` is injected, not imported**  
`agent.js` is generic — it knows nothing about readline or terminal UI. The REPL owns the UI concern. By passing `confirmTool` as a callback, the same agent loop could be used in a web app (where confirmation is an HTTP response), Telegram bot, etc. This is **dependency injection via function parameters** — the agent depends on the capability without owning the implementation.

Tools run **sequentially** (not parallel with `Promise.all`) because each one might need to pause and wait for user confirmation:
```js
const results = []
for (const tc of toolCalls) {
  const result = await runTool(mcpClient, tc, confirmTool)
  results.push(result)
}
```

---

## Native Tool: `tools.js`

### Whitelist validation
```js
const isEmailAllowed = (email, whitelist) => {
  const normalized = email.toLowerCase()
  const domain = normalized.split("@")[1]          // "alice@aidevs.pl" → "aidevs.pl"

  return whitelist.some(pattern => {
    const p = pattern.toLowerCase()
    if (p.startsWith("@")) return domain === p.slice(1)  // domain match: "@aidevs.pl"
    return normalized === p                               // exact match: "alice@aidevs.pl"
  })
}
```

Whitelist in `workspace/whitelist.json`:
```json
{
  "allowed_recipients": [
    "alice@aidevs.pl",
    "@yourdomain.com"
  ]
}
```

If validation fails → handler returns `{ success: false, error: "not in whitelist..." }` without touching Resend API. Model gets this and informs the user.

---

## Resend API: `resend.js`

Simple REST call to `https://api.resend.com/emails`:
```js
const body = {
  from: RESEND_FROM,
  to: recipients,
  subject,
  ...(html && { html }),        // conditional spread — only include if truthy
  ...(text && { text }),
  ...(replyTo && { reply_to: replyTo }),
}
```
Returns `{ id: "..." }` on success, throws on error.

---

## Full Execution Flow

```
1. app.js: connect MCP → discover tools → create readline
2. runRepl(): create trustedTools Set, create confirmTool handler
3. User: "Send an email to alice@aidevs.pl saying hello"
4. run(): messages = [...history, { role: "user", content: query }]
5. chat() → LLM calls send_email({ to: ["alice@aidevs.pl"], subject: "Hello", body: "Hi!" })
6. runTool() → checks TOOLS_REQUIRING_CONFIRMATION → yes
7. confirmTool("send_email", args) → REPL shows terminal UI

   Path A (Y pressed):
   → confirmed = true → validateRecipients() → sendEmail() via Resend
   → { success: true, id: "..." } → LLM: "Email sent!"

   Path B (N pressed):
   → confirmed = false → { success: false, rejected: true }
   → LLM: "Email was cancelled."

   Path C (T pressed):
   → trustedTools.add("send_email") → confirmed = true → send
   → Next time: auto-approved, UI skipped
```

---

## Key Architecture Insight

**Why file-based whitelist?**  
Security rules don't belong hardcoded in the agent instructions (the LLM could be convinced to ignore them). They belong in **deterministic code** that the LLM cannot override. `whitelist.json` + the validation function in `tools.js` enforce the rule programmatically — the model never even gets a chance to call the API with a non-whitelisted address.

**Why confirmation via button press?**  
The lesson says: "Zatwierdzenie bądź odrzucenie akcji MUSI być deterministyczne i odbywać się przez kod, a nie decyzję LLM." If you typed "yes" in free text, the agent loop would have to interpret it — introducing ambiguity. Pressing Y/N is deterministic.

---

## Token Stats

`stats.js` tracks cumulative totals per session. Displayed on exit:
```
📊 Stats: 4 requests, 1200 input tokens, 340 output tokens
```

Useful for understanding real usage — especially relevant to the lesson's discussion of token costs in production.
