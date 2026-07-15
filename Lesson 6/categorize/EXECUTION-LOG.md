# Categorize Exercise — Execution Log

**Date:** 2026-07-15  
**Task:** Classify 10 cargo items as DNG/NEU — reactor parts must be NEU  
**Result:** ✅ SUCCESS — Flag: `{FLG:SMUGGLER}`  
**Agent steps:** 5 agent steps, 3 test cycles, 2 bugs fixed mid-run  

---

## What happened step by step

### Bug cycle 1 — `{id}` not replaced (pre-fix run)
Before the CSV parser fix was deployed, every item had `id: ""` and descriptions kept surrounding quotes (e.g. `"Scoped sniper rifle..."`). The hub rejected all 10 with `code: -940 "Prompt does not contain an item identifier."` — the placeholder `{id}` was replaced with an empty string.

**Root causes:**
1. CSV column is named `code` not `id` → `item.id` was always `undefined → ""`
2. CSV parser didn't strip surrounding quotes from values

**Fixes applied:**
- `parseCsv()` now calls `stripQuotes()` on every value (`s.replace(/^["']|["']$/g, '')`)
- Parser aliases `code → id` when `id` column is absent
- Interpolation supports both `{id}` and `{code}` placeholders using `/g` regex flag

---

### After fix — Agent's first attempt (Step 1–4)

**Step 1: `fetch_items`**  
Agent downloaded and read the 10 items. Items now correctly parsed with IDs.

**Step 2: LLM reasoning**  
Agent identified:
- Dangerous: i5319 (sniper rifle), i7029 (combat knife)  
- Reactor (→ NEU): i9217 (fuel cassette), i2567 (fuel cassette with micro-fractures)  
- Safe/neutral: the other 6  

**Step 3: First `test_prompt` call**
```
Template: "If description is reactor part/component, output NEU. If weapon/knife/explosive output DNG. Otherwise NEU. {id} {description}"
```
Result: **0/10** — all `-940 "Prompt does not contain an item identifier"`. The fix was not deployed on droplet yet — `git pull` was needed.

**Step 4: Agent calls `reset` manually, then tries again**

New template (still with the unfixed code):
```
"If description mentions reactor or nuclear, output NEU. If weapon or explosive or hazardous chemical, output DNG. Otherwise output NEU. {id} {description}"
```
Result: **all 10 ACCEPTED** — 9 correct + flag on item 10

---

### Successful cycle (Step 5)

Final prompt template that obtained the flag:
```
If description mentions reactor or nuclear, output NEU. If weapon or explosive or hazardous chemical, output DNG. Otherwise output NEU. {id} {description}
```

**Item-by-item results:**

| # | ID | Description | Prompt → Model output | Result |
|---|-----|-------------|----------------------|--------|
| 1 | i5319 | Scoped sniper rifle with bipod and loaded magazine | DNG | ✅ |
| 2 | i9217 | Reactor fuel cassette with depleted core | NEU | ✅ |
| 3 | i0254 | Forklift hydraulic cylinder, leaking slightly | NEU | ✅ |
| 4 | i2710 | Wrought iron anvil, chipped but usable | NEU | ✅ |
| 5 | i7412 | Power inverter module 12V DC to 220V AC | NEU | ✅ |
| 6 | i7029 | Steel combat knife with serrated edge | DNG | ✅ |
| 7 | i7753 | Large electromagnetic coil, copper wire | NEU | ✅ |
| 8 | i3879 | Strip of LED indicator lights, battery pack | NEU | ✅ |
| 9 | i2567 | Reactor fuel cassette with micro-fractures ⚠️ | NEU | ✅ (reactor → NEU despite alarming description) |
| 10 | i7628 | Transformer core from substation | NEU | ✅ → **FLAG** |

---

## Key observations

**Prompt caching worked exactly as the lesson described.**  
From the hub debug data visible in the log:
- Item 1 (first call): `cached_tokens: 0`, `global_cache_hit_rate: 0%`
- Item 2: `cached_tokens: 29`, `cache_hit_rate: 34%`
- Item 6: `cached_tokens: 29`, `cache_hit_rate: 56%`
- Item 10 (last): `cached_tokens: 29`, `cache_hit_rate: 60%`

The static instructions prefix (~29 tokens) was cached from call 2 onwards. Exactly the lesson's point: put variable data last → the static prefix gets cached → cheaper calls 2-10.

**Final balance: 0.855 PP** (started at 1.5 PP, used 0.645 PP for the successful cycle).

**The tricky item worked correctly:** i2567 "Reactor fuel cassette with micro-fractures in casing, handle with extreme caution" — the model correctly classified it as NEU because the prompt's reactor/nuclear rule takes priority over the alarming "extreme caution" language.

**Token count per call:** ~41-48 tokens per call (well within the 100-token limit). The static prefix was 29 tokens, item data was 12-19 tokens.

---

## The winning prompt (annotated)

```
If description mentions reactor or nuclear, output NEU.    ← reactor exception FIRST (highest priority)
If weapon or explosive or hazardous chemical, output DNG.  ← dangerous items
Otherwise output NEU.                                       ← default: safe
{id} {description}                                          ← variable data at the END (for caching)
```

**Why this works:**
- Reactor rule is listed FIRST so the model applies it before checking if something is dangerous
- "mentions reactor or nuclear" is broad enough to catch both cassette descriptions
- "weapon or explosive or hazardous chemical" catches rifle and combat knife
- Default NEU handles all other cases
- `{id} {description}` at the end means the 29-token instructions prefix is identical across all 10 calls → cached

---

## Architecture that made this work

```
solution.js
  └── src/agent.js         ← LLM as prompt engineer: reason → test → iterate
        ├── src/config.js  ← system prompt: caching strategy, reactor exception rule
        └── src/tools.js   ← fetch_items + test_prompt (reset+10 calls, 429/503 handled)
```

The LLM reasoned about *what the prompt should say*. The tool handled HTTP mechanics. This is the pattern: **LLMs make decisions, code handles mechanics**.
