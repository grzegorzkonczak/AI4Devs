# Walkthrough — 02_02_chunking (Lesson 7)

Four chunking strategies compared on the same document. This is the *indexing* half of RAG:
turning a document into small "documents" (chunks) of **content + metadata** that an agent can
later retrieve.

## Pedagogical context (lesson .md)

The section *"Techniki indeksowania treści na potrzeby wyszukiwania"* defines indexing as splitting
content into small chunks (rarely >200–500 words / 500–4000 tokens), each with content + metadata.
It lists exactly the four strategies below, in increasing intelligence. Core principle applied:
strategies 1–2 are pure mechanics; 3–4 hand the *"where does one idea end?"* judgment to the LLM.

| # | Strategy   | Boundaries by                                   | Metadata            | LLM? | Chunks (example.md) |
|---|------------|-------------------------------------------------|---------------------|------|---------------------|
| 1 | Characters | fixed char count + overlap                      | index/chars/size    | No   | 26 |
| 2 | Separators | headings → paragraphs → sentences → words (rec.)| + section, source   | No   | 30 |
| 3 | Context    | separators, then LLM adds a context prefix      | + LLM context       | Yes  | 30 |
| 4 | Topics     | LLM chooses logical topic boundaries            | + LLM topic label   | Yes  | 12 |

Same document, 26 vs 30 vs 12 chunks — granularity depends entirely on strategy.

## File map

```
app.js                     orchestrator: read input → run 4 strategies → write JSONL
src/api.js                 thin Responses API chat() wrapper
src/utils.js               buildHeadingIndex() + findSection() (shared)
src/strategies/*.js        characters | separators | context | topics
workspace/example.md       input
workspace/example-*.jsonl  pre-generated outputs (one per strategy)
```

Dependency direction: app.js → strategies → (api.js | utils.js) → ../../config.js.

⚠️ `api.js` imports `../../config.js` = `Lesson 7/config.js`, a shared config not yet in the repo.
Strategies 1–2 run without it; 3–4 call the LLM so they need config + a `.env` key. That's why
pre-generated `.jsonl` outputs ship with the example.

## app.js flow

1. `confirmRun()` — token-cost "(yes/y)" gate via `node:readline/promises`. Same as Lesson 6
   (`reference/boilerplate.md` → token-cost confirmation prompt). Not new.
2. `readFile(INPUT)` → whole example.md as one string.
3. Run 4 strategies, each via `save(name, chunks)`.
4. `save` → `toJsonl` = `chunks.map(JSON.stringify).join("\n")` → **JSONL** (one JSON doc per line),
   the standard chunk storage format.

## 1. Characters (deterministic)

Sliding window: `slice(start, start+1000)`, advance `1000-200` so each chunk repeats the previous
200 chars (overlap keeps boundary-split sentences intact). Metadata is only code-computed
(index/chars/size/overlap) — no structural awareness; cuts mid-word. For unstructured text.

## 2. Separators (deterministic, recursive — the key algorithm)

Separator hierarchy: `["\n## ", "\n### ", "\n\n", "\n", ". ", " "]`.

`split()`:
1. Base case: `text.length <= size` → return `[text]`.
2. Pick the first (coarsest) separator present: `separators.find(s => text.includes(s))`.
3. `split(sep)` into parts, greedily re-glue into `current` until adding a part exceeds `size`,
   then push and start fresh.
4. `pickOverlap` carries a clean-boundary tail of the finished chunk into the next; `stats`
   only *reports* dropped/trimmed overlaps (facts, no decisions).
5. **Recursion:** chunks still > size are re-split with `remaining = separators after current`,
   via `flatMap` (map + flatten one level). So it drills `\n##` → ... → `" "` until all fit.
   Classic "recursive character text splitter."

Metadata gains `section` via `findSection`.

### utils.js (step-in)
- `buildHeadingIndex(text)`: regex-scan markdown `^#{1,6} title` (`gm`) + plain-text pseudo-headings
  (short line followed by content). Returns sorted `[{position, level, title}]`; `match.index` = offset.
- `findSection(text, chunkContent, headings)`: sample ~100 chars from **40% into** the chunk (avoids
  overlap-start false matches), `indexOf` it in source, walk headings to the last one before that
  position. Returns `"## Heading"`. Deterministic section attribution — no LLM.

## 3. Context (LLM-enriched — Anthropic contextual retrieval)

Reuse strategy 2, then per chunk one LLM call:
- `for (const [i, chunk] of base.entries())` — `.entries()` yields `[index, value]` pairs; the
  `[i, chunk]` destructuring pulls both (loop equivalent of `map`'s `(item, i)`). **First appearance.**
- Sequential `await` (not `Promise.all`) to be gentle on rate limits; `process.stdout.write("...\r")`
  rewrites one progress line (`\r` = carriage return).
- **LLM:** in = `<chunk>...</chunk>`; instruction = "1–2 sentence context situating this chunk in the
  doc, return ONLY the context". Out = string stored in `metadata.context`. **Content unchanged** —
  only metadata grows. Makes an otherwise ambiguous chunk self-describing → better retrieval.

## 4. Topics (fully AI-driven)

- One LLM call over the whole document: "break into ONE-topic chunks, preserve text verbatim, return
  JSON array of `{topic, content}`, no fences".
- Robust parse: `JSON.parse`, on failure strip ```` ``` ```` fences and retry (mechanics guarding
  model formatting, not a decision).
- Reuse `buildHeadingIndex`/`findSection` for `section`, plus the LLM's `topic` label.
- Result: 12 chunks vs 30 — the model merged related paragraphs into whole topics (e.g. one 2529-char
  "Autoregression in LLMs" chunk). Boundaries follow meaning, not size/punctuation.

## Through-line

Metadata richness and boundary intelligence climb together: char count → sections → LLM context →
LLM topics. Code owns mechanics (windowing, recursion, JSON repair, overlap accounting, progress);
the LLM is invoked only for judgment code can't make — *"what does this chunk mean?"* and *"where does
a topic begin?"*. Course principle applied to indexing.

## New this example
- Recursive separator splitting (patterns.md #29)
- Contextual retrieval / LLM metadata enrichment (patterns.md #30)
- JS: `array.entries()` + `[i, v]` destructuring in `for...of`; `process.stdout.write("\r")` progress line
- JSONL chunk output (`map(JSON.stringify).join("\n")`)
