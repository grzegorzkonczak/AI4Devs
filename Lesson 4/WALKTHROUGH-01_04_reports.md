# Walkthrough: `01_04_reports`

## What this example is about (from the lesson)

The lesson describes this as a **culmination of all Lesson 4 skills combined into one capable agent**. The agent can:

- Read/write files via MCP (same as before)
- Generate and edit images via Gemini (same as before)
- Analyze image quality via GPT vision (same as before)
- **NEW**: Convert HTML files to PDF using **Puppeteer** (headless Chrome)

Key lesson quote: *"the agent's capabilities have significantly grown — it can operate on local and generated files, precisely edit selected document fragments, and ultimately produce a PDF"*. Example use case: ask the agent to prepare a document presenting 4 Kata poses from Karate — it identifies all necessary actions and delivers the final PDF.

The lesson also emphasizes: if problems appear (wrong styling, bad images, errors), **the agent can apply corrections without starting from scratch** — key advantage over a one-shot generator.

---

## File map

```
app.js                     ← entry point + startup guard
src/
  agent.js                 ← agent loop with conversation memory
  config.js                ← API config + detailed agent instructions
  repl.js                  ← interactive chat loop
  helpers/
    api.js                 ← OpenAI Responses API + vision calls
    stats.js, logger.js, shutdown.js  ← boilerplate helpers
  mcp/client.js            ← MCP connection via stdio
  native/
    tools.js               ← 3 native tools: create_image, analyze_image, html_to_pdf
    gemini.js              ← Gemini image generation (native API or OpenRouter)
workspace/
  template.html            ← master HTML/CSS design system (never edit directly)
  style-guide.md           ← design rules for the agent to follow
  image-style.txt          ← written by agent before first image, referenced verbatim in all prompts
  input/                   ← user drops source files here
  html/                    ← agent writes working HTML files here
  output/                  ← generated PDFs and images land here
  demo/                    ← example PDF from a previous run
```

New dependency: `"puppeteer": "^24.4.0"` — Node.js library that controls a real Chrome browser.

---

## Step 1 — Startup guard: `app.js` `confirmRun()`

```js
const confirmRun = async () => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Czy chcesz kontynuować? (yes/y): ");
  rl.close();
  const normalized = answer.trim().toLowerCase();
  if (normalized !== "yes" && normalized !== "y") {
    process.exit(0);
  }
};
```

**Pattern**: asks user consent before running. Good practice for agents that will call APIs many times and generate files — prevents accidental runs.

**New JS syntax — `?.` optional chaining**: Later in main():
```js
rl?.close();
```
Means: "if `rl` is not null/undefined, call `.close()` on it — otherwise do nothing". Equivalent to `if (rl) rl.close()`. Used when a variable might not have been initialized (e.g. MCP failed before `rl` was created).

---

## Step 2 — Agent instructions: `src/config.js`

The most important file — defines the agent's reasoning model. Has two sections: **REASONING** and **RULES**.

### REASONING section (agent thinks, not follows steps)

```
1. CONTENT
   Every element must earn its place — if it doesn't clarify, it clutters.
   Prefer fewer, stronger points over comprehensive coverage.

3. IMAGE CONSISTENCY
   Before generating the first image, define the style explicitly.
   Write the style definition to workspace/image-style.txt for reference.
   Every subsequent create_image call must include this style in the prompt.
   Style consistency > individual image quality.
```

**Why `image-style.txt`?** Gemini has no memory across tool calls. To keep 4 images consistent, the agent:
1. Defines the style in plain text and saves it to `workspace/image-style.txt`
2. Reads that file and pastes it verbatim into every subsequent `create_image` prompt

The existing demo file shows what this looks like:
```
- Medium: minimalist instructional sketch (clean line drawing)
- Rendering: thin-to-medium charcoal/ink lines, no shading, no textures
- Palette: black ink lines on pure white background (#ffffff)
```

### RULES section

```
1. TEMPLATE: Read template.html, copy to workspace/html/{name}.html.
   Never edit template.html — it's the master reference.
   Preserve <head> and styles, modify only <body> content.

2. IMAGE PATHS: HTML requires absolute filesystem paths for images.
   Tools return project_root and absolute_path — use these.
   Pattern: {project_root}/workspace/output/{filename}
```

**Why absolute paths?** Puppeteer opens HTML as a local file. Relative paths like `../../output/img.png` may not resolve from the browser's working directory. The safe approach: full absolute path like `/home/ubuntu/AI4Devs/.../workspace/output/img.png`.

---

## Step 3 — Design system: `template.html` + `style-guide.md`

`template.html` is a ~600-line dark-theme HTML/CSS design system. Pre-built components available:

- `.page` → one printed A4 page (`page-break-after: always`)
- `.metrics` / `.metric` → KPI cards (big number + label)
- `.note` → highlighted info box with accent left border
- `.status-success/warning/error` → colored dot + text status indicator
- `.grid-2` / `.grid-3` → two/three-column layouts
- `.page-header` / `.page-footer` → header and footer on each page

Agent reads `style-guide.md` to understand when to use each component, then writes only `<body>` content using pre-defined classes. Never writes CSS.

**Why this approach**: agent only writes HTML using known, tested classes → consistent results, fewer tokens, no broken CSS.

---

## Step 4 — The `html_to_pdf` tool: `src/native/tools.js`

The three tools: `create_image`, `analyze_image` (unchanged from previous examples), and the new `html_to_pdf`.

**Definition** — what the model sees:
```js
{
  name: "html_to_pdf",
  parameters: {
    html_path: "Path to HTML file relative to project root",
    output_name: "Base name for output PDF (without extension)",
    options: {
      format: "A4 or Letter",
      landscape: "boolean",
      margin: { top, right, bottom, left },
      print_background: "boolean — MUST be true for dark theme"
    }
  }
}
```

`print_background: true` is critical — browsers don't print CSS backgrounds by default (to save ink). Without it, dark theme = black text on white paper.

**Handler** — what actually executes:

```js
async html_to_pdf({ html_path, output_name, options = {} }) {
```

**New JS syntax — destructuring with default value**: `options = {}` means: if caller didn't pass `options`, use empty object `{}`. Prevents "cannot read property of undefined" when accessing `options.format` later.

### Step into: Puppeteer

```js
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});
```
- Starts a real Chrome browser process invisibly in the background
- `--no-sandbox` flags required when running as root on Linux (DigitalOcean droplet)

```js
const page = await browser.newPage();
const fileUrl = `file://${fullHtmlPath}`;
await page.goto(fileUrl, { waitUntil: "networkidle0" });
```
- Opens a new browser tab
- Navigates to the local HTML file (`file://` prefix = local file, not a URL)
- `networkidle0` = wait until fully loaded, including Google Fonts from template

```js
await page.pdf(pdfOptions);
```
- Chrome renders the page exactly as it would look in a browser, saves as PDF

```js
} finally {
  await browser.close();
}
```
**`try/finally`**: the `finally` block runs *whether or not an error occurred*. Guarantees Chrome process is always killed, even if PDF generation fails. Without this, a failed run would leak Chrome processes.

---

## Step 5 — REPL and conversation memory: `src/repl.js`

```js
let conversation = createConversation();

while (true) {
  const input = await rl.question("You: ");
  ...
  const result = await run(input, { 
    conversationHistory: conversation.history
  });
  conversation.history = result.conversationHistory;  // ← update
}
```

Each REPL turn appends to `conversation.history`. Follow-up requests like *"fix the image on page 2"* work because the agent sees all previous turns. This enables iterative corrections without starting from scratch.

In `agent.js`:
```js
const messages = [...conversationHistory, { role: "user", content: query }];
```
`...conversationHistory` — spread operator unpacks the existing history array, then the new user message is appended.

---

## Full execution flow

```
node app.js
  └─ confirmRun()                            ← "yes/no" before starting
  └─ createMcpClient()                       ← spawns Files MCP via stdio
  └─ runRepl()
      └─ user: "Make a PDF about karate kata poses"
      └─ run(query)
          └─ [LLM] plans actions
          └─ [MCP] fs_read("workspace/style-guide.md")
          └─ [MCP] fs_read("workspace/template.html")
          └─ [MCP] fs_write("workspace/html/kata.html")   ← clone template
          └─ [MCP] fs_write("workspace/image-style.txt")  ← define style once
          └─ [Gemini] create_image("kata pose 1 + style")
          └─ [GPT vision] analyze_image(...)
          └─ [Gemini] create_image again if needed
          └─ [MCP] fs_write("workspace/html/kata.html")   ← embed absolute image paths
          └─ [Puppeteer] html_to_pdf("kata.html")
          └─ [LLM] returns: "PDF saved to workspace/output/kata_123.pdf"
      └─ user: "The second image looks wrong, fix it"
      └─ run(query, history=[all previous])              ← agent remembers everything
          └─ regenerates only that image, updates HTML, re-exports PDF
```

Three backends in one run: **GPT** (reasoning+vision) + **Gemini** (image generation) + **Puppeteer/Chrome** (PDF rendering).

---

## What's new vs previous examples

| Feature | Previous | Reports |
|---|---|---|
| Image generation | ✅ | ✅ same |
| Image analysis | ✅ | ✅ same |
| MCP file tools | ✅ | ✅ same |
| HTML template system | ❌ | ✅ new |
| Image style anchor (`image-style.txt`) | ❌ | ✅ new |
| `html_to_pdf` via Puppeteer | ❌ | ✅ new |
| Startup consent guard | ❌ | ✅ new |

**New JS syntax:**
- `rl?.close()` — optional chaining `?.` (call method only if not null/undefined)
- `{ options = {} }` — destructuring parameter with default value
- `try/finally` — guaranteed cleanup block regardless of error
