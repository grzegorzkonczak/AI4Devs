# Railway Exercise — Execution Log

**Date:** 2026-07-15  
**Task:** Activate railway route X-01  
**Result:** ✅ SUCCESS — Flag: `{FLG:COUNTRYROADS}`  
**Total steps:** 5 agent steps, ~2 minutes (all time spent waiting on rate limits)

---

## What happened step by step

### Step 1 — LLM calls `help`
- Agent immediately follows the system prompt instruction: "always call help first"
- `help` returns the full API schema: 5 actions (`help`, `reconfigure`, `getstatus`, `setstatus`, `save`)
- Route format: `[a-z]-[0-9]{1,2}` (case-insensitive)
- Status values: `RTOPEN` = open, `RTCLOSE` = close
- Key note from API: *"To change status of the road, you must first set it to reconfigure mode"*

### Step 2 — LLM calls `reconfigure` for route X-01
- LLM correctly deduced the sequence from the help docs: reconfigure → setstatus → save
- Hit **429 rate limit** immediately (1 call per 30s window)
  - `Retry-After: 28s` — tool waited exactly 28s then retried
- Success: `{ ok: true, route: "X-01", mode: "reconfigure", status: "close" }`
- Rate limit policy visible in headers: `x-ratelimit-policy: 1;w=30` (1 request per 30 second window!)

### Step 3 — LLM calls `setstatus` with `RTOPEN`
- Hit **429** again (1s after previous call, still in window)
  - Waited 28s
- After wait: hit **503 server overload** on attempt 2
  - Retried after 2s (attempt 3)
- Success: `{ ok: true, route: "X-01", mode: "reconfigure", status: "open", message: "Status updated." }`

### Step 4 — LLM calls `save`
- Hit **429** again — waited 29s
- Success: `{ code: 0, message: "{FLG:COUNTRYROADS}" }` ← **flag delivered in this response**

### Step 5 — LLM returns final text
- LLM sees the flag in the `save` response and returns:
  > "The railway route X-01 has been activated successfully. Flag: {FLG:COUNTRYROADS}"

---

## Key observations

**Rate limit is brutal:** `x-ratelimit-policy: 1;w=30` — only 1 call per 30-second window. With 4 calls needed (help, reconfigure, setstatus, save), that's at minimum ~90 seconds of waiting.

**The agent handled everything autonomously:**
- Read the API docs from the `help` response with no prior knowledge
- Deduced the correct 3-step sequence (reconfigure → setstatus → save)
- Never saw a single 429 or 503 — all handled transparently inside the tool

**503 and 429 were both hit during `setstatus`** — that was the hardest call: first a 429, then after the wait a 503, then finally success on attempt 3. Total: 3 HTTP attempts for one logical operation.

**Token usage** (from OpenAI responses):
| Step | Input tokens | Output tokens |
|------|-------------|---------------|
| 1    | 355         | 20            |
| 2    | 588         | 27            |
| 3    | 657         | 32            |
| 4    | 726         | 26            |
| 5    | 780         | 24            |

Context grew by ~150 tokens per step as full conversation history accumulated.

---

## Architecture that made this work

```
solution.js
  └── src/agent.js         ← loop: LLM decides what to call
        ├── src/config.js  ← system prompt: "always call help first", rate limit guardrails
        └── src/tools.js   ← call_railway_api: transparent 503/429 handling
```

The LLM only reasoned about *what to call*. The tool handled all HTTP mechanics invisibly.  
This is the core lesson: **separate reasoning (LLM) from mechanics (tool handler)**.
