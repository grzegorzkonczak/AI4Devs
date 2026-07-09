# Copilot Instructions

## Project overview

This is the **AI_devs 4: Builders** course workspace — a Node.js project for building hands-on exercises that integrate LLM APIs (OpenAI, Anthropic, Gemini) into application logic. Each lesson lives in its own `Lesson N/` directory containing a Markdown lesson file and exercise data files.

The companion reference implementation is at: https://github.com/i-am-alice/4th-devs

## Repository layout

```
Lesson 1/   — lesson notes (Markdown) + exercise data (people.csv, JSON with suspects.txt)
Lesson 2/   — lesson notes (Markdown) + exercise data (power_plants.txt)
index.js    — root entry point (placeholder)
package.json
```

Each lesson's exercise code should live alongside the lesson data in its `Lesson N/` directory.

## Running the project

```powershell
node index.js
# or a specific lesson exercise:
node "Lesson 1/solution.js"
```

No build step. `npm test` is a placeholder — do not treat it as a real test suite.

## Coding conventions

- **CommonJS** — no `"type": "module"` in `package.json`; use `require`/`module.exports`.
- **Single quotes, no semicolons** — match the style in `index.js`.
- Exercise data files use JSON stored in `.txt` files (e.g., `power_plants.txt`, `JSON with suspects.txt`) — parse with `JSON.parse(fs.readFileSync(..., 'utf8'))`.

## LLM integration patterns

These patterns recur across lessons:

**Structured Outputs** — pass `response_format: { type: "json_schema", json_schema: { ... } }` to get typed JSON back. Always `JSON.parse()` the response content.

**Function Calling / Tool Use** — the agent loop runs until the model stops requesting tool calls:
1. Send message + tool definitions to LLM
2. If response contains tool calls → execute callbacks, append results to conversation history
3. Send updated history back to LLM → repeat until final text response

Tool definitions require precise `name`, `description`, and `parameters` schema — these directly control model behavior and tool-selection accuracy.

**Multi-step chaining** — a first LLM call classifies/routes, its result shapes the prompt for a second call. Keep calls independent and compose results in application code.

## API keys

The course uses OpenAI and OpenRouter. Keys are not committed. Load from environment variables:
```js
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
```

## Adding dependencies

No dependencies are installed yet. When adding (e.g., `openai`, `@anthropic-ai/sdk`):
1. `npm install <package>`
2. Commit the resulting `package-lock.json` alongside `package.json`.

---

## Salesforce Development — AI Factory Integration

When the user presents any Salesforce development task (Apex, LWC, SOQL, Flow, metadata, deployment, integration, security, testing), follow this protocol exactly. Do NOT answer from general Salesforce knowledge alone.

### Step 1 — Check if AI Factory dashboard is running

```powershell
Invoke-RestMethod http://localhost:3939/api/copilot/status
```

- If `ready: true` → **use Level 3** (route through the AI Factory Salesforce agent)
- If not running or error → **use Level 2** (read CTech skill files directly)

---

### Level 3 — Route through AI Factory agent (preferred when dashboard is up)

1. Find the Salesforce agent ID:
```powershell
$agents = Invoke-RestMethod http://localhost:3939/api/agents
$sfAgent = $agents.data | Where-Object { $_.name -match "Salesforce" -or $_.agentId -match "salesforce" } | Select-Object -First 1
$sfAgent.agentId
```

2. Invoke it with the user's task:
```powershell
$body = @{ agentId = $sfAgent.agentId; task = "<user task here>"; calledBy = "copilot-cli"; expectedOutputFormat = "json" } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri http://localhost:3939/api/agents/invoke -Method POST -ContentType "application/json" -Body $body -TimeoutSec 180
```

3. Return `data.output` to the user. The agent produces deployment-ready output: `{ questions[], files[{ path, content }] }`.

---

### Level 2 — Read CTech skill files directly (fallback)

Before answering, read:
- **Always**: `ai-factory/docs/salesforce-agent/MasterPrompt.md` (behavioral contract + output format)
- **Apex tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_Apex.md`
- **LWC tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_LWC.md`
- **SOQL tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_SOQL.md`
- **Flow tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_Flow.md`
- **Testing tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_Testing.md`
- **Security tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_Security.md`
- **Metadata tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_Metadata.md`
- **Integration tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_Integration.md`
- **Deployment tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_Deploy.md`
- **Data tasks**: `ai-factory/docs/salesforce-agent/kb/tech/salesforce/Code Skills/Tech_SF_Instr_Ctech_Data.md`
- **Security is a cross-cutting concern** — load it alongside any other domain.

Then answer applying those CTech standards. CTech override rules always take precedence over generic Salesforce best practices.

---

### Core principles — always apply for all Salesforce tasks

- **Native-first → Declarative-first → Code-last**: prefer standard Salesforce config, then declarative (Flows, validation rules), then Apex/LWC only when declarative is insufficient.
- **Output format**: deployment-ready MD API ZIP structure with `package.xml`, companion metadata files, and correct XML tag names. Not SFDX source format.
- **Structured output contract**: `{ questions: string[], files: Array<{ path: string, content: string }> }`. Put unclear requirements in `questions`, never guess.
- **Never bloat**: when modifying object metadata, include only the necessary blocks, not the full object file.
- **Repository context**: check the user's repo for existing naming conventions, API names, Permission Sets, package structure, and reuse them.
