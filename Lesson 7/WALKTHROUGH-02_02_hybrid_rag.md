# Walkthrough — 02_02_hybrid_rag (Lesson 7)

The capstone: chunking + embeddings + FTS5 + sqlite-vec fused into an agent with one `search` tool.
Two phases — **indexing** (startup) and **retrieval** (per query) — exactly matching the lesson diagram.

## Pedagogical context (lesson .md)

"Połączmy teraz to wszystko w całość" — combine doc prep + indexing + both search techniques into a
hybrid RAG agent. On startup: scan `workspace/`, chunk, sync into SQLite with FTS + sqlite-vec.
`EMBEDDING_DIM` MUST equal the model's dims (1536). Agent makes TWO query forms — keyword list (FTS)
+ natural-language question (semantic) — producing two result lists merged by RRF. Bilingual demo:
Polish question vs English text → keyword match weak, but bilingual embedding makes semantic match work.

## Architecture map

```
app.js                 initDb → indexWorkspace → createTools → runRepl
src/db/index.js        open SQLite, load sqlite-vec, CREATE documents/chunks/chunks_fts/chunks_vec
src/db/indexer.js      read → sha256 hash (skip unchanged) → chunk → embed (batch 20) → insert → prune
src/db/chunking.js     recursive separator chunking — PORTED from 02_02_chunking (pattern #29)
src/db/embeddings.js   embed(texts[]) → arrays of 1536 floats
src/db/search.js       searchFts (BM25) + searchVector (cosine) + hybridSearch (RRF)  ← heart
src/agent/index.js     standard agent loop (pattern #1), MAX_STEPS=30, extractReasoning
src/agent/tools.js     one native "search" tool → hybridSearch; asks LLM for BOTH keywords + semantic
src/helpers/api.js     Responses API chat() + extractToolCalls/Text/Reasoning
src/repl.js            You: loop, commands exit/clear/reindex
src/mcp/client.js      MCP stdio client — SCAFFOLDED but UNUSED (nothing imports it)
spec/{fts,sqlite}.md   vendored reference docs (not executed)
```

## PHASE 1 — Indexing

### initDb (db/index.js) — NEW SQLite machinery
- **better-sqlite3**: synchronous driver. `db.prepare(sql).run()/.get()/.all()`, `db.exec()`, `db.pragma()`.
  No await — local file, instant. `sqliteVec.load(db)` loads the vector extension.
- Tables:
  - `documents` (source, content, hash, indexed_at)
  - `chunks` (FK document_id, content, chunk_index, section, chars)
  - `chunks_fts` — **FTS5 virtual table**, external-content (`content='chunks'`), kept in sync by 3
    triggers (after insert/delete/update) → inserting a chunk auto-populates full-text index.
  - `chunks_vec` — **sqlite-vec vec0 virtual table**, `embedding float[1536]` (why EMBEDDING_DIM matters).

### indexFile (indexer.js) — deterministic + incremental cache
1. `createHash("sha256").update(content).digest("hex")`; unchanged hash → skip (pure mechanics, not a
   decision). Changed → removeDocument then re-index.
2. `chunkBySeparators` — same recursive algorithm as 02_02_chunking. Not new.
3. Insert document → docId. Insert chunks → triggers fill FTS5. `BigInt(lastInsertRowid)` for vec key.
4. Embed in batches of 20 (`embed(batch)` — Embeddings API takes an array; `data.data` is an array).
5. **Store vectors as binary float32**: `Buffer.from(new Float32Array(arr).buffer)`. NEW: typed arrays.
   sqlite-vec stores packed float32, not JSON. Float32Array = 4-byte floats, `.buffer` = raw memory.
6. indexWorkspace also prunes DB rows for files deleted from disk.

## PHASE 2 — Retrieval (db/search.js, the heart)

LLM calls `search({keywords, semantic})`; `hybridSearch` runs both, fuses with RRF.

### searchFts — BM25 (deterministic)
- `toFtsQuery`: `/[^\p{L}\p{N}\s]/gu` strips punctuation. NEW JS: **Unicode property escapes** —
  `\p{L}` any letter (any language), `\p{N}` any number, `u` flag enables them. Bilingual-safe.
  Terms joined `"t1" OR "t2"`.
- `WHERE chunks_fts MATCH ? ORDER BY rank` = FTS5 built-in BM25. `highlight(...,'«','»')` +
  `extractMatchedTerms` (regex + Set) reveal which keywords hit. Lexical = exact words.

### searchVector — semantic (deterministic + 1 embed call)
- Embed `semantic` once → vec buffer → `WHERE embedding MATCH ? ORDER BY distance` = sqlite-vec kNN by
  cosine distance (same cosine idea as 02_02_embedding, run in-DB over all chunk vectors). Join winners
  back to chunks/documents.

### hybridSearch — NEW: Reciprocal Rank Fusion (RRF)
- BM25 and cosine scores aren't comparable, so RRF uses only rank position:
  `rrf += 1 / (RRF_K + rank + 1)`, RRF_K=60. Each doc earns from each list it appears in; a doc high in
  both rises to top; high in only one still scores lower. Matches lesson's "promote across lists".
- Graceful degradation: if embedding call throws (API down), vecResults=[] → FTS-only. Reports facts,
  doesn't decide strategy.
- Returns `{source, section, content}` to the LLM.

## Agent loop — familiar (pattern #1)
`chat({input, tools})` → run function_calls → append function_call_output → repeat; else return text.
MAX_STEPS=30, extractReasoning for logging (same Responses API shape as Lesson 6 agentic_rag).

**Core principle:** the tool asks the LLM for BOTH keyword + semantic queries; the system prompt
(config.js) tells it HOW to search (broad→refine, synonyms, cite, stop when confident). Code never
decides what to search or when to stop — it runs BM25 + vector + RRF and returns facts. LLM reasons,
DB does mechanics.

## MCP note
`src/mcp/client.js` is a full MCP stdio client (spawns a `files` server per mcp.json) but nothing
imports it — scaffolding for "add MCP tools later". Dormant in this example.

## Through-line
chunking → documents; embedding → vectors+cosine; hybrid_rag → both in SQLite (FTS5 words + vec0
meaning) queried by an agent, fused by RRF. Smart decisions in LLM/prompt; mechanics (chunk, hash,
embed, BM25, cosine, RRF, fallback) in code.

## New this example
- better-sqlite3 synchronous DB + prepared statements — boilerplate
- FTS5 external-content table + sync triggers (BM25 full-text) — patterns #32
- sqlite-vec vec0 virtual table + Float32Array→Buffer vector storage — patterns #32
- Reciprocal Rank Fusion (RRF) hybrid merge — patterns #33
- sha256 incremental reindex (skip-unchanged) — boilerplate
- JS: Unicode property escapes `\p{L}\p{N}` with `u` flag; typed arrays (Float32Array/.buffer); BigInt rowids
- Already covered: agent loop (#1), recursive separator chunking (#29), embeddings+cosine (#31), readline REPL
