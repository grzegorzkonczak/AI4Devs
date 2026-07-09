# Lesson 3 — Custom Filesystem MCP Server

## What was built

A custom MCP (Model Context Protocol) server that exposes **4 optimized filesystem tools** to AI clients.
This is a compression of the official Filesystem MCP server's 13 tools into 4 logical groups,
as described in the s01e03 lesson.

### Files

```
Lesson 3/
├── server.js      — MCP server entry point: registers tools, starts stdio transport
├── fs-tools.js    — Pure filesystem logic: 4 handler functions + path security
└── package.json   — Dependencies: @modelcontextprotocol/sdk, glob
```

---

## The 4 tools (vs. original 13)

| New tool | Replaces (original) | What it does |
|---|---|---|
| `fs_search` | `search_files`, `directory_tree`, `list_directory`, `list_directory_with_sizes`, `get_file_info`, `list_allowed_directories` | Search & explore: glob patterns, recursive tree, directory listing, file metadata, show allowed dirs |
| `fs_read` | `read_text_file`, `read_media_file`, `read_multiple_files` | Read one or many files; auto-detects text vs binary (base64+MIME for images/audio); supports head/tail |
| `fs_write` | `write_file`, `edit_file` | Overwrite entire file OR apply surgical text patches; `dryRun=true` shows a diff before applying |
| `fs_manage` | `create_directory`, `move_file` | Create directories (recursive, idempotent) and move/rename files |

### Why compress from 13 → 4?

Every tool definition costs **tokens** from the LLM's context window.
With 13 tools just for filesystem access, you burn token budget before the agent does real work.
Fewer, broader tools also mean **better tool selection accuracy** — less decision paralysis for the model.
The goal is not minimal tools, but the right balance between coverage and clarity.

---

## How it works — full flow

```
1. Client connects to server (stdio pipe)
         │
         ▼
2. Client asks: "what tools do you have?"
   Server replies: 4 tool definitions with JSON schemas
         │
         ▼
3. Client sends those tool schemas to the LLM
   (they become part of the system prompt / context)
         │
         ▼
4. User says: "find all .js files in the project"
   LLM decides: call fs_search with action="files", pattern="**/*.js"
         │
         ▼
5. Client intercepts that tool call,
   forwards it to the MCP server over stdio
         │
         ▼
6. server.js validates args (Zod), calls fs-tools.js handler
   fs-tools.js checks path is inside allowed dirs, runs Node.js fs/promises + glob
   Returns result to client
         │
         ▼
7. Client appends the result to LLM conversation history
   LLM reads the result and forms a natural language answer
         │
         ▼
8. Repeat until LLM has no more tool calls → final answer to user
```

---

## Where it fits in the full application

```
┌─────────────────────────────────────────────────────────┐
│                    FULL APPLICATION                      │
│                                                          │
│  ┌──────────────┐        ┌──────────────────────────┐   │
│  │   LLM API    │        │      MCP CLIENT          │   │
│  │  (OpenAI /   │◄──────►│  (your app code,         │   │
│  │  Anthropic)  │        │   Claude Desktop,        │   │
│  └──────────────┘        │   Cursor, VS Code...)    │   │
│                           └────────────┬─────────────┘  │
│                                        │ stdio / HTTP    │
│                           ┌────────────▼─────────────┐  │
│                           │      MCP SERVER           │  │
│                           │   ← WE BUILT THIS        │  │
│                           │      server.js            │  │
│                           │      fs-tools.js          │  │
│                           └──────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

We built the **server side only**. The client side can be:

- **Option A — Existing client (zero code needed today)**
  Add `server.js` to Claude Desktop, Cursor, or VS Code MCP config.
  Those apps handle the client side and the LLM loop automatically.

- **Option B — Custom client (what the course builds toward)**
  Use `@modelcontextprotocol/sdk` Client class in your own Node.js app.
  You control the full agent loop: send tools to LLM → catch tool calls → forward to server → repeat.

---

## Technologies used

| Technology | What it is | Why |
|---|---|---|
| `@modelcontextprotocol/sdk` | Official MCP SDK (npm) | Provides `McpServer`, `StdioServerTransport`, tool registration |
| `zod` | Schema validation library (npm) | Validates tool input arguments before calling handlers |
| `glob` | File pattern matching (npm) | Powers the `fs_search` action="files" glob searches |
| `fs/promises` | Built-in Node.js module | Async filesystem operations (readFile, writeFile, stat, mkdir, rename…) |
| `path` | Built-in Node.js module | Cross-platform path resolution and manipulation |
| **stdio transport** | Standard input/output pipe | How the MCP client and server communicate (STDIN/STDOUT) |

---

## Security model

All filesystem operations go through `validatePath()` in `fs-tools.js`.
It resolves the requested path to an absolute path and checks it is inside
one of the **allowed directories** passed as CLI arguments.
Any attempt to escape the sandbox (e.g. `../../etc/passwd`) throws an error
before any filesystem call is made.

```bash
# Only paths inside /my/project are accessible
node server.js /my/project
```

---

## How to run

```bash
# Install dependencies (first time only)
npm install

# Start the server with one or more allowed directories
node server.js C:/your/project/path

# Test with MCP Inspector (https://modelcontextprotocol.io/docs/tools/inspector)
# Transport Type: STDIO
# Command: node
# Arguments: "Lesson 3/server.js" C:/your/project/path
```
