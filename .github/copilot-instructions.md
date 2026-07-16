# Copilot Instructions

---

## 🧠 CORE PRINCIPLE — Read this before every exercise

This is a course about **building agentic AI applications**. Every exercise solution must demonstrate the LLM making decisions — not your code making decisions on its behalf.

### The fundamental boundary

| Belongs in **code** (mechanics) | Belongs in **LLM** (reasoning) |
|---|---|
| Retry loops on 429/503 | What to try next after a failure |
| Stop making calls you know will fail | Whether to change strategy |
| Parse and return API responses faithfully | Interpret what a response means |
| Expose capabilities as tools | Decide which tool to call and when |
| Short-circuit to avoid wasted calls | Decide what constitutes success |

**If you find yourself writing an `if/else` that decides what the agent does next — stop. That decision belongs in the LLM's instructions.**

### The tool contract
A tool has exactly two responsibilities:
1. **Report facts** — return what happened faithfully (errors, hints, status codes, flags)
2. **Handle pure mechanics** — retries, deduplication, avoiding provably-pointless calls

A tool must NOT: interpret results, choose a next action, or stop the agent loop based on its own judgment.

### Where reasoning goes
Agent reasoning lives in the **system prompt** (`instructions` / `agentConfig`). When you discover a new edge case (e.g. budget exhaustion means "your prompt was ambiguous"), encode that knowledge in the system prompt so the LLM can reason about it — not as a hard `if` branch in a tool handler.

### Canonical examples
- ✅ **Railway (Lesson 5)**: LLM reads `help` docs, deduces the correct call sequence, executes it. No hardcoded steps.
- ✅ **Categorize (Lesson 6)**: Tool returns `outOfBudget: true`. System prompt explains what it means. LLM decides whether to rethink the prompt or reset. Tool doesn't decide for it.
- ❌ Bad: tool detects "insufficient funds" and picks a recovery strategy itself
- ❌ Bad: hardcoded `if result.failed → retry with different params` in the agent loop

---

## Project overview

This is the **AI_devs 4: Builders** course workspace — a Node.js project for building hands-on exercises that integrate LLM APIs (OpenAI, Anthropic, Gemini) into application logic. Each lesson lives in its own `Lesson N/` directory containing a Markdown lesson file and exercise data files.

The companion reference implementation is at: https://github.com/i-am-alice/4th-devs

## Repository layout

```
Lesson 1/   — lesson notes + exercise data (people.csv, JSON with suspects.txt)
Lesson 2/   — lesson notes + exercise data + solution.js
Lesson 3/   — lesson notes + MCP server (server.js, fs-tools.js) + exercise solution (proxy.js) + SUMMARY.md
index.js    — root entry point (placeholder)
package.json
```

Each lesson's exercise code lives alongside the lesson data in its `Lesson N/` directory.

## Environment — IMPORTANT

**Two-machine workflow via GitHub:**
- **Windows machine** (here): edit files, commit, push to GitHub. Copilot CLI runs here.
- **Droplet** (`209.38.202.11`): pull from GitHub, run all `node` commands. Accessed via DigitalOcean browser console.
- **GitHub repo**: `https://github.com/grzegorzkonczak/AI4Devs.git` — the bridge between machines.

**Typical workflow:**
1. Edit/create files on Windows with Copilot CLI
2. Commit and push: `git add . && git commit -m "..." && git push origin main`
3. On droplet: `cd ~/AI4Devs && git pull` to get latest
4. Run: `cd "Lesson N/example-folder" && node solution.js`

**Windows details:**
- Corporate network, heavily firewalled (SSH port 22 blocked, but SSH over port 443 via `ssh.github.com` works)
- Git remote uses SSH with personal key: `git@github-personal:grzegorzkonczak/AI4Devs.git`
- SSH config at `~/.ssh/config` routes `github-personal` → `ssh.github.com:443`
- Use PowerShell/cmd for local file operations only — never for running node

**Droplet details:**
- Ubuntu at `209.38.202.11`, accessed via DigitalOcean browser console
- All `node` commands, `npm install`, and server runs happen here
- Use **bash syntax** for all droplet commands
- Use **nano** for file editing on the droplet (but prefer editing on Windows + git pull)
- `OPENAI_API_KEY` set in `~/.bashrc`; shared `node_modules` at `~/AI4Devs/node_modules`

See `Lesson 3/SUMMARY.md` → "Environment & execution notes" for full details on:
- Running servers, backgrounding processes, tmux setup
- Exposing endpoints (ngrok for HTTPS, DigitalOcean firewall)
- Submitting to Hub, env vars, ESM module setup

## Running the project (on droplet)

```bash
cd ~/AI4Devs/LessonN
OPENAI_API_KEY="sk-..." node solution.js
```

## Coding conventions

- **ESM** — `"type": "module"` in each lesson's `package.json`; use `import`/`export`
- **Single quotes, no semicolons**
- Exercise data files use JSON stored in `.txt` files — parse with `JSON.parse(fs.readFileSync(..., 'utf8'))`

## LLM integration patterns

**Function Calling / Tool Use** — the agent loop runs until the model stops requesting tool calls:
1. Send message + tool definitions to LLM
2. If response contains tool calls → execute callbacks, append results to conversation history
3. Send updated history back to LLM → repeat until final text response

Tool definitions require precise `name`, `description`, and `parameters` schema — these directly control model behavior and tool-selection accuracy.

**Multi-step chaining** — a first LLM call classifies/routes, its result shapes the prompt for a second call.

**Structured Outputs** — pass `response_format: { type: "json_schema", json_schema: { ... } }` to get typed JSON back.

## API keys

- OpenAI key: set as `OPENAI_API_KEY` env var
- Course API key: `4abb691a-12aa-4546-82c5-1b6ba1c19f60` (safe to use in course exercises)
- Hub endpoint: `https://hub.ag3nts.org/verify`

## Exercise coding style

### ⚠️ Course philosophy — see top of this file for the full principle

Short version: **LLMs decide, code handles mechanics.** Always agentic from the start.

Ask yourself before writing any code: *"Is an LLM making decisions here, or am I just scripting?"*

### Tool pattern

When building exercise solutions, follow the proper agent tool pattern used in course examples:
- Wrap capabilities as **named tool objects** with `{ type, name, description, parameters }` definition + a handler function
- Separate tool **definitions** (what the model sees) from tool **handlers** (what actually runs)
- Use a `toolHandlers` / `nativeHandlers` map: `{ toolName: async (args) => result }`
- Route by checking tool name: `isNativeTool(name) ? executeNativeTool() : callMcpTool()`
- This pattern scales — adding a new capability is just adding one entry to definitions and one to handlers




```bash
cd ~/AI4Devs/LessonN
npm install <package>
```

## Code walkthrough protocol (IMPORTANT — apply every time)

When the user provides a code example from the course repository, always do ALL of the following:

1. **Files**: User uploads example files from the course repo directly into the `Lesson N/` folder. Read them locally first. Only fetch from GitHub (`https://github.com/i-am-alice/4th-devs`) if a referenced file is missing (e.g., shared `config.js` at repo root).

2. **Read the lesson `.md` first** — find the section where this example is discussed to understand its pedagogical context before touching the code.

3. **Walk through the source code step by step**, covering:
   - What each file does and how files reference each other
   - Execution flow: what happens in what order when you run it
   - **LLM parts** — explicitly mark every OpenAI/Anthropic/Gemini API call: what goes in, what comes back, why
   - **Deterministic parts** — mark pure JS logic that doesn't involve LLM
   - **Boilerplate** — flag repetitive scaffolding (HTTP servers, argument parsing, env loading, chunk collection patterns) and briefly explain why it's necessary even though it's not the interesting part
   - **MCP usage** — if present, explain where/how Model Context Protocol is used vs. plain function calling
   - **New concepts** — highlight anything not seen in previous lessons. **Before labelling something as new, search `reference/boilerplate.md`, `reference/patterns.md`, and all existing `WALKTHROUGH-*.md` files** (with grep) to confirm it hasn't been covered. If it has been covered before, say "same as X" and move on — do not re-explain it.
   - **JavaScript syntax** — whenever a JS/Node.js syntax feature appears for the first time (e.g. `...rest`, destructuring, `??`, optional chaining, built-in Node modules like `readline`, `fs`, `path`), explain it in plain terms before continuing. Don't assume JS knowledge beyond basic programming. Same rule: grep prior walkthroughs first — if the syntax was already explained, just reference where.
   - **"Step into" style** — for new or interesting code, drill down into the called function/method the same way a debugger would: show what it receives, what it does inside, what it returns, then return to the caller flow. This can be multi-layered (step into a function that itself calls something worth explaining). Skip this for things already covered in earlier examples.

4. **Save the walkthrough**: After completing the walkthrough, create a `WALKTHROUGH-<example-name>.md` file in the same `Lesson N/` folder as the example code. This persists the knowledge for future sessions.

5. **Update reference compendiums**: After each walkthrough, check `reference/boilerplate.md` and `reference/patterns.md` and add any new boilerplate snippets or patterns encountered. Keep entries concise with a code example and a "Seen in:" line.

6. **Goal**: user should feel comfortable reading the next example independently after the walkthrough. Teach the pattern, not just the code.

