# Walkthrough — 02_02_embedding (Lesson 7)

Interactive REPL that embeds each line you type and prints a pairwise cosine-similarity matrix.
This is the *semantic* primitive behind RAG: `text -> vector -> cosine compare`. No LLM reasoning,
no tools — just the embeddings endpoint + a little math.

## Pedagogical context (lesson .md)

Section *"Przeszukiwanie semantyczne i wybór modelu do embeddingu"* introduces embeddings: a model
class that encodes *meaning* as a vector. Same input -> same vector (stable meaning); different input
-> different values. `text-embedding-3-small` = **1536 dimensions**. Compare vectors with **cosine
similarity** -> "Woman" is nearer "Queen" than "King" despite no shared keywords. Motivates hybrid
(lexical + semantic) search. This demo lets you feel it live.

## What it is

Single file `app.js` (~160 lines), no src/ split. Import is `../config.js` = shared `Lesson 7/config.js`.
Loop: read line -> embed -> recompute all-pairs cosine matrix -> print in color.

## Flow

1. **Setup** — `readline/promises` REPL (same as Lesson 5, boilerplate "readline REPL setup").
   `MODEL = resolveModelForProvider("text-embedding-3-small")`.
2. **Loop** (`main`):
   - `await rl.question("Text: ").catch(() => "exit")` — reject (e.g. Ctrl-D closes stdin) becomes
     "exit" instead of crashing. Defensive idiom on an awaited promise.
   - Accumulate every entry in `entries[]` so the matrix is always all-pairs over full history.
3. **embed() — NEW: Embeddings API** (`/v1/embeddings`, different from Responses API):
   | | Responses `/v1/responses` | Embeddings `/v1/embeddings` |
   |---|---|---|
   | Request | `input` + `instructions` | `model` + `input` |
   | Response | `data.output[...]` | `data.data[0].embedding` |
   | Returns | text / tool calls | 1536 floats |
   - `data.data` is an array (API can embed many inputs at once); one string in -> `data.data[0]`.
   - `...EXTRA_API_HEADERS` spreads OpenRouter headers when active (mechanics).
4. **cosineSimilarity() — NEW: the math** = (a·b) / (‖a‖·‖b‖), cosine of angle between vectors.
   ~1 = same meaning, ~0 = unrelated. One loop computes dot + both norms, then divides. This is the
   literal heart of semantic search.
   ```js
   for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; normA += a[i]*a[i]; normB += b[i]*b[i] }
   return dot / (Math.sqrt(normA) * Math.sqrt(normB))
   ```
5. **Display (presentation only)**:
   - `preview()` shows first 4 + last 2 values + `(1536d)` so you can see identical input -> identical numbers.
   - `printMatrix()` N×N grid; diagonal `——`, off-diagonal = scaled `█` bar + score, colored by
     `colorFor` (green ≥0.60, yellow ≥0.35, red <0.35).
   - `c = { green: "\x1b[32m", reset: "\x1b[0m", ... }` = ANSI color codes (seen before in logger.js).
     `padStart`/`padEnd` align columns. Cosmetic.

## Through-line

No LLM reasoning at all — a pure indexing-primitive demo isolating `embed` + `cosineSimilarity`.
This same pair runs inside a database as the "semantic" half of the hybrid RAG example. Try
`king / queen / man / woman` to reproduce the lesson's Cosine Similarity diagram.

## New this example
- Embeddings API endpoint `/v1/embeddings` (request `{model, input}`, response `data.data[0].embedding`) — patterns.md #31
- Cosine similarity implementation — patterns.md #31
- Already covered: readline REPL (boilerplate), ANSI color codes (prior logger.js), resolveModelForProvider
