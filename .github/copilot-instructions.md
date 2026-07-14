# Copilot Instructions

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

**This project runs on a DigitalOcean droplet, not the local Windows machine.**

- Local machine: Windows laptop on a corporate network (heavily firewalled — cannot expose ports, SSH often blocked)
- Execution environment: Ubuntu droplet at `209.38.202.11`, accessed via DigitalOcean browser console
- All `node` commands, `npm install`, and server runs happen on the droplet
- Use **bash syntax** for all terminal commands (not PowerShell)
- Use **nano** for file editing on the droplet

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

## Exercise coding style (IMPORTANT)

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
   - **New concepts** — highlight anything not seen in previous lessons
   - **JavaScript syntax** — whenever a JS/Node.js syntax feature appears for the first time (e.g. `...rest`, destructuring, `??`, optional chaining, built-in Node modules like `readline`, `fs`, `path`), explain it in plain terms before continuing. Don't assume JS knowledge beyond basic programming.
   - **"Step into" style** — for new or interesting code, drill down into the called function/method the same way a debugger would: show what it receives, what it does inside, what it returns, then return to the caller flow. This can be multi-layered (step into a function that itself calls something worth explaining). Skip this for things already covered in earlier examples.

4. **Save the walkthrough**: After completing the walkthrough, create a `WALKTHROUGH-<example-name>.md` file in the same `Lesson N/` folder as the example code. This persists the knowledge for future sessions.

5. **Update reference compendiums**: After each walkthrough, check `reference/boilerplate.md` and `reference/patterns.md` and add any new boilerplate snippets or patterns encountered. Keep entries concise with a code example and a "Seen in:" line.

6. **Goal**: user should feel comfortable reading the next example independently after the walkthrough. Teach the pattern, not just the code.

