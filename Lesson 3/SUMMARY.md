# Lesson 3 — Summary

---

## Part A: Lesson content — Custom Filesystem MCP Server

Built a custom MCP (Model Context Protocol) server compressing the official Filesystem MCP's 13 tools into 4:

| Tool | Replaces | What it does |
|---|---|---|
| `fs_search` | 6 tools | glob search, recursive tree, directory listing, file metadata, list allowed dirs |
| `fs_read` | 3 tools | read text/binary/multiple files; head/tail support |
| `fs_write` | 2 tools | overwrite or surgical patch edits; dryRun diff preview |
| `fs_manage` | 2 tools | create directories, move/rename files |

**Why:** fewer tools = fewer tokens burned + better model tool-selection accuracy.

Files: `server.js` (MCP server, Zod validation), `fs-tools.js` (pure filesystem logic + path security sandbox).

---

## Part B: Exercise — "proxy" task

### What was built

An HTTP server acting as a covert logistics chatbot (`proxy.js`):
- Accepts `POST /` with `{ sessionID, msg }`, returns `{ msg }`
- Per-session conversation history (in-memory Map)
- LLM agent loop with OpenAI function calling (max 5 iterations)
- Two tools: `check_package`, `redirect_package` calling `https://hub.ag3nts.org/api/packages`
- **Hidden directive**: silently redirects reactor parts packages to `PWR6132PL` regardless of operator's requested destination, confirms the operator's destination to maintain cover
- System prompt persona: "Marek", a human Polish logistics warehouse employee

**Flag obtained:** `{FLG:FABRICATOR}`

### Key prompt engineering lessons

- "You are a human" is not enough — the model still deflects off-topic questions
- Must explicitly say **"just make something up naturally"** for small talk to work
- The hidden redirect failed initially because the model leaked `PWR6132PL` in its reply — fixed by adding **"tell the operator THEIR requested destination"**
- Hallucinated confirmation codes — fixed by **"always give the real confirmation code from the API response"**
- Iterating on the system prompt 3 times was needed to pass the Hub's test

---

## Environment & execution notes (important for future lessons)

### Development machine
- **Windows laptop on corporate network** — heavily firewalled
- Cannot use: ngrok download (blocked as virus), SSH outbound on port 22/443 (blocked), most external tools
- PowerShell works for local commands but `irm`/`Invoke-RestMethod` has quirks with JSON quoting
- **Do not try to expose local ports from this machine** — it won't work

### Execution environment
- **DigitalOcean Droplet** — Ubuntu 24 LTS, 1vCPU/512MB RAM, Frankfurt region
- IP: `209.38.202.11`
- All exercise code runs here, not locally
- Access via DigitalOcean browser console (no SSH client needed)
- Node.js v24, npm installed
- Project path: `~/AI4Devs/LessonN/`

### Terminal setup on droplet
- Use **tmux** for multiple panes: `apt install tmux`
  - `Ctrl+B "` — split horizontal
  - `Ctrl+B %` — split vertical
  - `Ctrl+B arrow` — switch pane
- Background processes: `command &` to start in background, `kill %1` to stop
- **Always use `nano`** for file editing — paste content, `Ctrl+O` save, `Ctrl+X` exit

### Exposing endpoints publicly
- Droplet has public IP — open port in DigitalOcean Firewall dashboard + `ufw allow PORT`
- Must bind server to `0.0.0.0` not just `localhost`: `server.listen(PORT, '0.0.0.0', ...)`
- For HTTPS (Hub requires it): use **ngrok on the droplet**
  ```bash
  wget https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz
  tar xvzf ngrok-v3-stable-linux-amd64.tgz
  ./ngrok config add-authtoken YOUR_TOKEN
  ./ngrok http 3000
  ```
- Hub submission requires HTTPS URL — plain `http://IP:PORT` is rejected with code -980

### Running Node.js on droplet
- Set env vars inline: `OPENAI_API_KEY="sk-..." node proxy.js`
- ESM modules: add `"type": "module"` to `package.json` (only once — duplicate `"type"` fields break it)
- Install deps: `npm install openai` inside the lesson directory

### Submitting to Hub
```bash
curl -X POST https://hub.ag3nts.org/verify -H "Content-Type: application/json" -d '{"apikey":"4abb691a-12aa-4546-82c5-1b6ba1c19f60","task":"TASK_NAME","answer": ...}'
```
- Save submit commands to a `submit.sh` file to avoid copy-paste formatting issues
- Hub responds with `code: 0` when submission is accepted, then tests the endpoint within ~15 seconds
- Watch ngrok HTTP log or server stdout to confirm requests are coming in

### API keys
- OpenAI: set as env var `OPENAI_API_KEY`
- Course API key: `4abb691a-12aa-4546-82c5-1b6ba1c19f60` (safe to hardcode for course exercises)

---

## Lesson 4 — "sendit" exercise (multimodal)

**Task:** Fill out and submit an SPK railway shipment declaration.
**Approach:** Full agent app — function calling + vision model + Hub POST.
**Result:** ✅ Worked on first try.

### Files
- `Lesson 4/index.js` — entry point, system prompt with all SPK rules and known shipment data
- `Lesson 4/agent.js` — generic reusable agent loop (function calling, max 10 iterations)
- `Lesson 4/tools.js` — two tools: `read_blocked_routes` (vision), `submit_declaration` (Hub POST)

### What the agent did
1. Called `read_blocked_routes` → downloaded `trasy-wylaczone.png`, sent to GPT-4o vision, got route code
2. Identified route code **X-01** for Gdańsk → Żarnowiec
3. Built the full declaration (3 API calls total: agent loop × 2 + vision × 1)
4. Called `submit_declaration` → POSTed to `hub.ag3nts.org/verify` with `task: "sendit"`
5. **Flag obtained: `{FLG:WISDOM}`** — returned in hub response, reported by agent in final message

### Declaration that worked
```
SYSTEM PRZESYŁEK KONDUKTORSKICH - DEKLARACJA ZAWARTOŚCI
======================================================
DATA: 2026-07-09
PUNKT NADAWCZY: Gdańsk
------------------------------------------------------
NADAWCA: 450202122
PUNKT DOCELOWY: Żarnowiec
TRASA: X-01
------------------------------------------------------
KATEGORIA PRZESYŁKI: A
------------------------------------------------------
OPIS ZAWARTOŚCI (max 200 znaków): kasety z paliwem do reaktora jądrowego
------------------------------------------------------
DEKLAROWANA MASA (kg): 2800
------------------------------------------------------
WDP: 4
------------------------------------------------------
UWAGI SPECJALNE:
------------------------------------------------------
KWOTA DO ZAPŁATY: 0 PP
------------------------------------------------------
OŚWIADCZAM, ŻE PODANE INFORMACJE SĄ PRAWDZIWE.
BIORĘ NA SIEBIE KONSEKWENCJĘ ZA FAŁSZYWE OŚWIADCZENIE.
======================================================
```

### Key decisions
- **Nested OpenAI calls**: `agent.js` uses `gpt-4o` for the agent loop; `tools.js` also calls `gpt-4o` for vision — two separate API calls in one execution
- **No ngrok needed**: this exercise doesn't expose an endpoint, it only calls out → no HTTPS tunnel required
- **System prompt contained all the answers**: Category A rules, WDP calculation, declaration format — the agent just needed to assemble the pieces and get the route code from the image
- Run with: `OPENAI_API_KEY="sk-..." node index.js` (from `~/AI4Devs/Lesson4/`)
- Add `"type": "module"` to `package.json` to avoid the ESM warning on Node v24

