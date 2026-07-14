# Conversation History — How It Grows Across Turns

## The spread operator `...`

`...` (spread) unpacks an array's contents into the place where it's written:

```js
const old = [A, B, C]
const extended = [...old, D]
// extended = [A, B, C, D]
// "old" is unchanged — a new array is created
```

In agent.js:
```js
const messages = [...conversationHistory, { role: "user", content: query }]
```
= "make a new array: all previous messages first, then append the new user message"

Also used with `push`:
```js
messages.push(...response.output)
```
= "push each element of response.output individually" (not as a nested array)

---

## `createConversation()` — the history container

```js
// agent.js
export const createConversation = () => ({ history: [] })
```

A factory function. Returns a fresh `{ history: [] }` object. Called:
- Once at REPL startup → initial empty container
- When user types `clear` → resets to empty again

The `history` array is what travels between `repl.js` and `run()`.

---

## Iteration diagram

```
INITIAL STATE
─────────────────────────────────────────
conversation.history = []


══════════════════════════════════════════
TURN 1 — User: "Make a PDF about karate poses"
══════════════════════════════════════════

repl.js:
  run("Make a PDF...", { conversationHistory: [] })
                                              │
                                              ▼
agent.js run():
  messages = [...[], userMsg1]
  messages = [
    ① { role:"user", content:"Make a PDF about karate poses" }
  ]

  ── step 1: LLM responds with tool call ──
  messages.push(...response.output)
  messages = [
    ① { role:"user", content:"Make a PDF about karate poses" }
    ② { type:"function_call", name:"fs_read", call_id:"c1" }  ← LLM requested this
  ]

  ── step 1: tool runs, result appended ──
  messages.push(...results)
  messages = [
    ① { role:"user", content:"Make a PDF about karate poses" }
    ② { type:"function_call", name:"fs_read", call_id:"c1" }
    ③ { type:"function_call_output", call_id:"c1", output:"<html>..." }
  ]

  ── step 2: LLM requests another tool call ──
  messages = [
    ① user msg
    ② function_call: fs_read
    ③ function_call_output: template content
    ④ function_call: create_image ("kata pose 1, [style]")
    ⑤ function_call_output: { output_path: "workspace/output/img1.jpg" }
    ⑥ function_call: html_to_pdf
    ⑦ function_call_output: { output_path: "workspace/output/kata.pdf" }
  ]

  ── final step: LLM returns text, no more tool calls ──
  messages.push(...response.output)
  messages = [
    ① user msg
    ② function_call: fs_read
    ③ function_call_output: template
    ④ function_call: create_image
    ⑤ function_call_output: image path
    ⑥ function_call: html_to_pdf
    ⑦ function_call_output: pdf path
    ⑧ { type:"message", content:"PDF saved to workspace/output/kata.pdf" }  ← final answer
  ]

  return {
    response: "PDF saved to workspace/output/kata.pdf",
    conversationHistory: messages  ← all 8 items
  }
                                              │
                                              ▼
repl.js:
  conversation.history = result.conversationHistory
  conversation.history = [ ①②③④⑤⑥⑦⑧ ]   ← 8 items stored


══════════════════════════════════════════
TURN 2 — User: "The second image looks wrong, fix it"
══════════════════════════════════════════

repl.js:
  run("The second image looks wrong, fix it", {
    conversationHistory: [ ①②③④⑤⑥⑦⑧ ]  ← the 8 items from turn 1
  })
                                              │
                                              ▼
agent.js run():
  messages = [
    ...[ ①②③④⑤⑥⑦⑧ ],                ← spread: all 8 turn-1 items unpacked
    { role:"user", content:"The second image looks wrong, fix it" }  ← ⑨ new
  ]

  messages = [
    ① user: "Make a PDF about karate poses"
    ② function_call: fs_read
    ③ function_call_output: template
    ④ function_call: create_image
    ⑤ function_call_output: image path
    ⑥ function_call: html_to_pdf
    ⑦ function_call_output: pdf path
    ⑧ message: "PDF saved to..."
    ⑨ user: "The second image looks wrong, fix it"  ← LLM sees all of this!
  ]

  ── LLM can now see: which image was generated, what path it's at,
     what the PDF contained — it makes a targeted fix without starting over ──

  ── steps: regenerate image → update HTML → re-export PDF ──

  messages = [
    ①..⑨ (all previous)
    ⑩ function_call: create_image (with improved prompt)
    ⑪ function_call_output: new image path
    ⑫ function_call: html_to_pdf
    ⑬ function_call_output: new pdf path
    ⑭ message: "Fixed. Updated PDF at workspace/output/kata_updated.pdf"
  ]

  return {
    response: "Fixed. Updated PDF at ...",
    conversationHistory: [ ①..⑭ ]   ← 14 items now
  }
                                              │
                                              ▼
repl.js:
  conversation.history = [ ①..⑭ ]   ← grows with every turn


══════════════════════════════════════════
TURN 3 — User: "clear"
══════════════════════════════════════════

repl.js:
  if (input.toLowerCase() === "clear") {
    conversation = createConversation()   ← fresh { history: [] }
    continue
  }

  conversation.history = []   ← 14 items gone, fresh start
```

---

## Key insight: why `messages` is a local variable

Inside `run()`, `messages` is built fresh every call:
```js
const messages = [...conversationHistory, { role: "user", content: query }]
```

The `conversationHistory` passed in is **not mutated** — a new array is created.
As the agent loop runs, items are pushed onto the local `messages` array.
At the end, the whole `messages` array is returned as `conversationHistory`.

Then in `repl.js`:
```js
conversation.history = result.conversationHistory
```

This **replaces** the stored history with the new (longer) one.

So the growth pattern is:
```
Turn 1: history starts at 0 items  → ends at N items (user + all tool calls + final answer)
Turn 2: history starts at N items  → ends at N+M items (all previous + new turn)
Turn 3: history starts at N+M      → ends at N+M+K items
"clear": history reset to 0 items
```

---

## Summary: who owns what

| Variable | Lives in | Contains |
|---|---|---|
| `conversation` | `repl.js` (while loop) | `{ history: [...] }` — persists across turns |
| `conversation.history` | `repl.js` | array of all messages so far |
| `messages` | `agent.js run()` | local copy, built fresh each call, returned at end |
| `conversationHistory` | `run()` parameter | snapshot of history at call time, not mutated |
