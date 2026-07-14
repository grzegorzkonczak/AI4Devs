# Boilerplate Reference

Common scaffolding code that appears repeatedly across examples. Not the interesting part — but necessary. Copy-paste and move on.

---

## ESM `__filename` / `__dirname` reconstruction

ESM modules don't have `__filename` and `__dirname` by default (unlike CommonJS). Whenever a file needs to resolve paths relative to itself, add this at the top:

```js
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '../..')  // adjust depth as needed
```

Seen in: every file that builds absolute paths (`native/tools.js`, `mcp/client.js`)

---

## HTTPS response collection (Node built-in, no fetch)

When using Node's built-in `https` instead of `fetch` — responses arrive in chunks and must be assembled:

```js
import https from 'https'

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
        catch (e) { resolve(Buffer.concat(chunks).toString()) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
```

Seen in: Lesson 3 `proxy.js`, Lesson 4 exercise `tools.js`
Note: Modern Node (18+) has `fetch` built-in — prefer that when possible.

---

## Download URL as base64

For sending images to vision APIs — download binary and convert to base64:

```js
import https from 'https'

function downloadAsBase64(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
      res.on('error', reject)
    })
  })
}
```

Seen in: Lesson 4 exercise `tools.js`, `image_recognition` vision tool

---

## Read local file as base64

Same idea but from disk:

```js
import { readFile } from 'fs/promises'

const imageBuffer = await readFile(fullPath)
const imageBase64 = imageBuffer.toString('base64')
```

Seen in: `native/tools.js` in image_recognition, image_editing

---

## MIME type mapping

Maps file extensions to MIME type strings — needed for base64 image payloads:

```js
const getMimeType = (filepath) => {
  const ext = extname(filepath).toLowerCase()
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  }
  return mimeTypes[ext] || 'image/jpeg'
}
```

Seen in: `native/tools.js` in image_recognition, image_editing

---

## Ensure directory exists (mkdir recursive)

Create a directory including all parents, silently do nothing if it already exists:

```js
import { mkdir } from 'fs/promises'

const ensureDir = async (dir) => {
  await mkdir(dir, { recursive: true })
}
```

`recursive: true` doesn't throw if directory already exists. No need to catch `EEXIST`.
Seen in: `native/tools.js` create_image handler

---

## Timestamped filename generator

Unique filenames for generated outputs — avoids collisions between runs:

```js
const generateFilename = (prefix, mimeType) => {
  const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }
  const ext = extensions[mimeType] || '.png'
  return `${prefix}_${Date.now()}${ext}`
}
// → "result_1720615200000.jpg"
```

Seen in: `native/tools.js` create_image handler

---

## Token usage tracker

Module-level accumulator — tracks total tokens across all API calls in a session:

```js
let totalTokens = { input: 0, output: 0, requests: 0 }

export const recordUsage = (usage) => {
  if (!usage) return
  totalTokens.input += usage.input_tokens || 0
  totalTokens.output += usage.output_tokens || 0
  totalTokens.requests += 1
}

export const logStats = () => {
  const { input, output, requests } = totalTokens
  console.log(`📊 ${requests} requests, ${input} input, ${output} output, ${input + output} total tokens`)
}

export const resetStats = () => {
  totalTokens = { input: 0, output: 0, requests: 0 }
}
```

Call `recordUsage(response.usage)` after every API call.
Seen in: `src/helpers/stats.js` in image_recognition, image_editing

---

## Responses API text extractor

The OpenAI Responses API nests text content deep. This helper finds it:

```js
export const extractResponseText = (data) => {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text
  }
  const messages = Array.isArray(data?.output)
    ? data.output.filter(item => item?.type === 'message')
    : []
  const textPart = messages
    .flatMap(msg => Array.isArray(msg?.content) ? msg.content : [])
    .find(part => part?.type === 'output_text' && typeof part?.text === 'string')
  return textPart?.text ?? ''
}
```

Seen in: `src/helpers/response.js` in image_recognition, image_editing

---

## Process signal handlers (graceful shutdown)

For interactive apps and servers — clean up connections when the user presses Ctrl+C:

```js
export const onShutdown = (cleanup) => {
  const handler = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down...`)
    await cleanup()
    process.exit(0)
  }
  process.on('SIGINT', () => handler('SIGINT'))
  process.on('SIGTERM', () => handler('SIGTERM'))
  return cleanup
}
```

Seen in: `src/helpers/shutdown.js` in image_editing

---

## MCP client creation from `mcp.json`

Loads MCP server config, spawns server as a child process, connects via stdio:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile } from 'fs/promises'

export const createMcpClient = async (serverName = 'files') => {
  const config = JSON.parse(await readFile('mcp.json', 'utf-8'))
  const serverConfig = config.mcpServers[serverName]

  const client = new Client({ name: 'my-client', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...serverConfig.env },
    cwd: process.cwd()
  })
  await client.connect(transport)
  return client
}

export const listMcpTools = async (client) => (await client.listTools()).tools

export const callMcpTool = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.find(c => c.type === 'text')
  if (text) {
    try { return JSON.parse(text.text) } catch { return text.text }
  }
  return result
}
```

Seen in: `src/mcp/client.js` in image_recognition, image_editing

---

## MCP tools → OpenAI format adapter

Converts MCP tool definitions to what OpenAI's Responses API expects:

```js
export const mcpToolsToOpenAI = (mcpTools) =>
  mcpTools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false   // MCP schemas are often flexible, strict mode would reject them
  }))
```

Seen in: `src/mcp/client.js` in image_recognition, image_editing

---

## readline REPL setup

Interactive terminal loop for multi-turn agents:

```js
import * as readline from 'readline/promises'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

while (true) {
  const input = await rl.question('You: ').catch(() => 'exit')
  if (input.toLowerCase() === 'exit') break
  if (!input.trim()) continue
  // handle input...
}

rl.close()
```

Seen in: `src/repl.js` in image_editing

---

## Puppeteer HTML → PDF conversion

Convert a local HTML file to PDF using a headless Chrome browser:

```js
import puppeteer from 'puppeteer'

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']  // required when running as root on Linux
})
try {
  const page = await browser.newPage()
  await page.goto(`file://${absoluteHtmlPath}`, { waitUntil: 'networkidle0' })
  await page.pdf({
    path: outputPdfPath,
    format: 'A4',
    landscape: false,
    printBackground: true,  // REQUIRED for dark themes — browser skips backgrounds by default
    margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }
  })
} finally {
  await browser.close()  // try/finally = always close, even on error
}
```

Key notes:
- `file://` prefix for local HTML files (not a URL)
- `waitUntil: 'networkidle0'` waits for fonts (Google Fonts in template) to load
- `printBackground: true` is critical for any colored background or dark theme
- `try/finally` guarantees Chrome process is killed even if PDF generation fails

Seen in: `native/tools.js` `html_to_pdf` handler in `01_04_reports`

---

## Startup consent guard

Ask user to confirm before running an expensive/side-effecting agent:

```js
import { createInterface } from 'node:readline/promises'

const confirmRun = async () => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('⚠️  This will consume tokens and generate files.')
  const answer = await rl.question('Continue? (yes/y): ')
  rl.close()
  if (!['yes', 'y'].includes(answer.trim().toLowerCase())) {
    console.log('Aborted.')
    process.exit(0)
  }
}
```

Call it at the very start of `main()` before connecting to any APIs.
Seen in: `app.js` in `01_04_reports`

---

## Gemini Files API — resumable upload (large files)

For files > 20MB, Gemini requires a two-step resumable upload before processing:

```js
// Step 1: register intent, get a session URL
const initResponse = await fetch(UPLOAD_ENDPOINT, {
  method: "POST",
  headers: {
    "x-goog-api-key": apiKey,
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": buffer.length.toString(),
    "X-Goog-Upload-Header-Content-Type": mimeType,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ file: { display_name: displayName } })
})
const uploadUrl = initResponse.headers.get("x-goog-upload-url")

// Step 2: send the actual bytes to the session URL
const uploadResponse = await fetch(uploadUrl, {
  method: "POST",
  headers: {
    "Content-Length": buffer.length.toString(),
    "X-Goog-Upload-Offset": "0",
    "X-Goog-Upload-Command": "upload, finalize"
  },
  body: buffer  // raw binary, not JSON
})

const fileInfo = await uploadResponse.json()
const fileUri = fileInfo.file.uri  // reference this in future API calls
```

Seen in: `native/gemini.js` `uploadAudioFile()` in `01_04_audio`

---

## WAV file construction from raw PCM

Gemini TTS outputs raw PCM (24kHz, 16-bit, mono). Wrap it in a WAV container to make it playable:

```js
import { writeFile } from 'fs/promises'

const writeWavFile = async (filepath, pcmBuffer) => {
  const sampleRate = 24000, numChannels = 1, bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcmBuffer.length
  const buf = Buffer.alloc(44 + dataSize)

  buf.write("RIFF", 0);  buf.writeUInt32LE(36 + dataSize, 4);  buf.write("WAVE", 8)
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16);             buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(numChannels, 22);  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28);     buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40)
  pcmBuffer.copy(buf, 44)

  await writeFile(filepath, buf)
}
```

Key notes:
- `Buffer.alloc(n)` — Node.js binary buffer, n zeroed bytes
- `writeUInt32LE` — 4-byte integer, little-endian byte order
- `writeUInt16LE` — 2-byte integer, little-endian
- WAV header is always exactly 44 bytes, audio data follows

Seen in: `native/tools.js` `writeWavFile()` in `01_04_audio`

---

## Replicate SDK — video generation with polling

For models that run asynchronously (e.g. Kling video generation — takes 30–120 seconds):

```js
import Replicate from "replicate"

const replicate = new Replicate()   // reads REPLICATE_API_TOKEN from env automatically
const MODEL = "kwaivgi/kling-v2.5-turbo-pro"

// Text to video:
const output = await replicate.run(MODEL, {
  input: { prompt, duration: 10, aspect_ratio: "16:9", negative_prompt: "" }
})
const videoUrl = output.url ? output.url() : output   // shape varies by model version

// Image(s) to video — pass Buffer objects directly, SDK handles encoding:
const startBuffer = await readFile(startImagePath)
const output2 = await replicate.run(MODEL, {
  input: { prompt, start_image: startBuffer, end_image: endBuffer, duration: 10 }
})
```

`replicate.run()` submits the job and **polls until complete** — you don't write the polling loop yourself. Returns only when done.

Download the binary result:
```js
const response = await fetch(videoUrl)
const buffer = Buffer.from(await response.arrayBuffer())  // .arrayBuffer() for binary files
await writeFile(outputPath, buffer)
```

`.arrayBuffer()` is the fetch method for binary data — use it instead of `.json()` or `.text()` when downloading images, videos, or PDFs.

Seen in: `native/replicate.js` in `01_04_video_generation`

---

## Definition / Handler / Shared split

As native tools grow beyond one file, split each tool into its own folder. Keep the top-level `tools.js` as a thin registry only.

```
src/native/
├── tools.js                  ← registry only: imports + exports nativeTools / nativeHandlers
├── create-image/
│   ├── definition.js         ← OpenAI tool schema (what the model sees)
│   ├── handler.js            ← execution logic (what runs when model calls the tool)
│   └── gemini.js             ← any provider-specific API calls
├── analyze-image/
│   ├── definition.js
│   └── handler.js
└── shared/
    └── image-files.js        ← utilities used by more than one handler
```

`tools.js` stays minimal — just wires definitions to handlers:
```js
import { createImageDefinition } from './create-image/definition.js'
import { createImage } from './create-image/handler.js'
import { analyzeImageDefinition } from './analyze-image/definition.js'
import { analyzeImage } from './analyze-image/handler.js'

export const nativeTools = [createImageDefinition, analyzeImageDefinition]
export const nativeHandlers = {
  create_image: createImage,
  analyze_image: analyzeImage
}
export const isNativeTool = (name) => name in nativeHandlers
export const executeNativeTool = async (name, args) => {
  const handler = nativeHandlers[name]
  if (!handler) throw new Error(`Unknown native tool: ${name}`)
  return handler(args)
}
```

The agent loop imports only from `tools.js` — it never knows about the subdirectory structure.

Seen in: `src/native/` in `01_04_image_guidance`

