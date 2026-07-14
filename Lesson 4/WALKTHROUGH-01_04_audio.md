# Walkthrough: `01_04_audio`

## What the lesson says this agent can do

From the lesson transcript:
- **Transcription** of meeting recordings and voice notes, including files >20MB
- **Audio responses** usable as email/messenger attachments
- **Speech style analysis** — speaker characteristics, pace, accent hints
- **Custom freeform questions** about audio content

Lesson warnings:
- *"Speech style guidance (accent, emotion) can include hallucinations"*
- *"Avoid dictating URLs, tables, or complex formatting in generated audio — it doesn't translate to sound"*

---

## File map

```
app.js                    ← entry point, prints example queries
src/
  agent.js                ← identical to reports example
  api.js                  ← identical Responses API wrapper (no vision function)
  config.js               ← GPT-4.1 for reasoning, two Gemini models for audio
  repl.js                 ← simplified: let history = [] instead of createConversation
  helpers/                ← same boilerplate
  mcp/client.js           ← same MCP stdio pattern
  native/
    tools.js              ← 4 audio tools: transcribe, analyze, query, generate
    gemini.js             ← ALL audio logic: upload, transcribe, analyze, TTS
workspace/
  input/                  ← drop audio files here
  output/                 ← transcriptions, analyses, generated WAVs
  demo/                   ← example output WAV
```

Note: `package.json` lists `@elevenlabs/elevenlabs-js` but it's never used — the implementation chose Gemini for everything. The lesson mentions ElevenLabs as a higher-quality TTS option but the code went full Gemini.

---

## Step 1 — What's unchanged

`agent.js`, `api.js`, `mcp/client.js` are essentially identical to the reports example.

`repl.js` is slightly simplified vs reports:
```js
// reports used a factory pattern:
let conversation = createConversation()  // → { history: [] }
conversation.history = result.conversationHistory

// audio uses a plain variable:
let history = []
history = result.conversationHistory   // same concept, fewer layers
```

---

## Step 2 — config.js: two Gemini models, no vision

```js
export const api = {
  model: resolveModelForProvider("gpt-4.1"),  // GPT handles agent reasoning only
};

export const gemini = {
  audioModel: "gemini-2.5-flash",              // understanding/transcription/analysis
  ttsModel:   "gemini-2.5-flash-preview-tts"   // text-to-speech generation
};
```

**Provider split:**
- **GPT-4.1** — agent loop (which tool to call, how to interpret results)
- **Gemini** — ALL audio work: understand, transcribe, analyze, AND generate speech

Different from the image examples where GPT also handled vision. Here GPT does zero audio work.

---

## Step 3 — The four tools

```js
{ name: "transcribe_audio" }  // speech → structured JSON with timestamps/speakers/emotions
{ name: "analyze_audio"   }  // what type of audio? speech/music/sounds + characteristics
{ name: "query_audio"     }  // freeform question about audio content
{ name: "generate_audio"  }  // text → speech WAV file (single or multi-speaker)
```

### New JS syntax — `Object.entries()` + destructuring in arrow function

The `generate_audio` description is built dynamically:
```js
description: `Available voices: ${
  Object.entries(TTS_VOICES)
    .map(([name, style]) => `${name} (${style})`)
    .join(", ")
}`
```

- `Object.entries(TTS_VOICES)` converts `{ Kore: "Firm", Puck: "Upbeat", ... }` → `[["Kore","Firm"], ["Puck","Upbeat"], ...]`
- `.map(([name, style]) => ...)` — **destructuring in an arrow function parameter**: each `[key, value]` pair is unpacked into named variables right in the argument list. Equivalent to `(pair) => pair[0] + " (" + pair[1] + ")"` but cleaner.
- `.join(", ")` — joins array into `"Kore (Firm), Puck (Upbeat), ..."` string

Result: the model's tool definition always contains the current voice list, built from the actual code object — not a hardcoded string.

---

## Step 4 — Smart `loadAudio()` decision point

Before every audio call, the handler runs:
```js
const audio = await loadAudio(audio_path)
// then: await transcribeAudio({ ...audio, options... })
```

**Step into `loadAudio()`:**

```js
const loadAudio = async (audioPath) => {
  if (isYouTubeUrl(audioPath)) {
    return { fileUri: audioPath, mimeType: "video/mp4" }   // YouTube: pass URL directly
  }

  const buffer = await readFile(join(PROJECT_ROOT, audioPath))
  const mimeType = getAudioMimeType(audioPath)

  if (buffer.length > 20 * 1024 * 1024) {  // > 20MB
    const uploaded = await uploadAudioFile(buffer, mimeType, displayName)
    return { fileUri: uploaded.fileUri, mimeType }           // large: upload first
  } else {
    return { audioBase64: buffer.toString("base64"), mimeType }  // small: inline base64
  }
}
```

Returns one of three shapes:
| Situation | Returns |
|---|---|
| YouTube URL | `{ fileUri: "https://youtube.com/...", mimeType: "video/mp4" }` |
| Local < 20MB | `{ audioBase64: "base64...", mimeType: "audio/wav" }` |
| Local > 20MB | `{ fileUri: "https://generativelanguage.../files/abc", mimeType: "audio/wav" }` |

**New JS syntax — spread in object literal:**
```js
await transcribeAudio({ ...audio, includeTimestamps: true, ... })
```
`{ ...audio, extraField: value }` = new object with all properties from `audio` plus `extraField`. If `audio = { audioBase64: "...", mimeType: "audio/wav" }`, result is `{ audioBase64: "...", mimeType: "audio/wav", extraField: value }`.

---

## Step 5 — Large file upload: resumable two-step process

For files > 20MB, Gemini requires a two-step resumable upload:

```js
// Step 1: register intent
const initResponse = await fetch(UPLOAD_ENDPOINT, {
  headers: {
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": audioBuffer.length.toString(),
  }
})
const uploadUrl = initResponse.headers.get("x-goog-upload-url")  // ← unique session URL

// Step 2: send actual bytes to session URL
const uploadResponse = await fetch(uploadUrl, {
  method: "POST",
  headers: { "X-Goog-Upload-Command": "upload, finalize" },
  body: audioBuffer   // ← raw binary, not JSON
})

const fileInfo = await uploadResponse.json()
// → { file: { uri: "https://generativelanguage.../files/abc123" } }
```

Why two steps? "Resumable" means if the connection drops during transfer of a large file, you can resume from the last offset rather than starting over. The session URL from step 1 persists the upload state server-side.

After upload, Gemini stores the file. All future calls reference it by `fileUri` — no need to re-send the bytes.

---

## Step 6 — `processAudio()`: the core Gemini understanding call

All three understanding tools funnel through this one function:

```js
export const processAudio = async ({ fileUri, audioBase64, mimeType, prompt, responseSchema }) => {
  const parts = [
    { text: prompt },  // question/instruction first
    fileUri
      ? { file_data: { mime_type: mimeType, file_uri: fileUri } }      // uploaded
      : { inline_data: { mime_type: mimeType, data: audioBase64 } }    // inline
  ]

  const body = { contents: [{ parts }] }

  if (responseSchema) {
    body.generation_config = {
      response_mime_type: "application/json",
      response_schema: responseSchema    // ← force structured JSON output
    }
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text

  if (responseSchema) return JSON.parse(text)  // → structured object
  return text                                   // → plain string
}
```

**Two output modes:**
- Without `responseSchema` → plain text (used by `query_audio`)
- With `responseSchema` → Gemini forced to return valid JSON matching the schema

This is Gemini's equivalent of OpenAI structured output. The schema in `transcribeAudio` specifies exactly:
```js
{ summary: STRING, segments: [{ speaker, timestamp, content, language }] }
```

### New JS syntax — conditional spread in object literal

In `transcribeAudio()`, optional schema fields are added dynamically:
```js
...(targetLanguage && { translation: { type: "STRING" } }),
...(detectEmotions && { emotion: { type: "STRING", enum: [...] } })
```

`...(condition && { key: value })`:
- If condition is falsy → `false && {...}` → `false` → `...false` → JS silently ignores, nothing added
- If condition is truthy → `true && { key: value }` → `{ key: value }` → field added to object

This adds optional fields to an object conditionally, without `if` blocks.

---

## Step 7 — Text-to-speech + WAV binary construction

### [LLM PART] The TTS API call

```js
const body = {
  contents: [{ parts: [{ text }] }],
  generationConfig: {
    responseModalities: ["AUDIO"],          // "give me audio back"
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: voice }
      }
    }
  }
}
```

Gemini responds with **raw PCM audio** as base64:
```js
const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data
// → base64 string of raw PCM bytes
```

**What is PCM?** Raw uncompressed audio samples — just a long sequence of numbers representing the sound wave at each moment. 24,000 samples/second, 16-bit, mono. No header, not a playable file yet.

### [DETERMINISTIC PART] `writeWavFile()` — building the WAV binary header

```js
const writeWavFile = async (filepath, pcmBuffer) => {
  const wavBuffer = Buffer.alloc(44 + pcmBuffer.length)  // 44-byte header + audio data

  wavBuffer.write("RIFF", 0)              // bytes 0-3:   magic identifier
  wavBuffer.writeUInt32LE(36 + dataSize, 4)  // bytes 4-7:   file size
  wavBuffer.write("WAVE", 8)              // bytes 8-11:  format type
  wavBuffer.write("fmt ", 12)             // bytes 12-15: format chunk
  wavBuffer.writeUInt32LE(16, 16)         // bytes 16-19: chunk size
  wavBuffer.writeUInt16LE(1, 20)          // bytes 20-21: PCM = format 1
  wavBuffer.writeUInt16LE(numChannels, 22)   // bytes 22-23: 1 = mono
  wavBuffer.writeUInt32LE(sampleRate, 24)    // bytes 24-27: 24000 Hz
  wavBuffer.writeUInt32LE(byteRate, 28)      // bytes 28-31: bytes/second
  wavBuffer.writeUInt16LE(blockAlign, 32)    // bytes 32-33: frame size
  wavBuffer.writeUInt16LE(bitsPerSample, 34) // bytes 34-35: 16 bits
  wavBuffer.write("data", 36)             // bytes 36-39: data chunk
  wavBuffer.writeUInt32LE(dataSize, 40)   // bytes 40-43: audio data size
  pcmBuffer.copy(wavBuffer, 44)           // bytes 44+:   actual audio samples

  await writeFile(filepath, wavBuffer)
}
```

WAV is a binary container format with a 44-byte header describing the audio, followed by the raw samples. Any audio player reads the header first to know how to decode the bytes that follow.

**New JS/Node concepts:**
- `Buffer.alloc(n)` — Node.js `Buffer` is a chunk of raw memory for binary data. Unlike JS strings/arrays, it holds actual bytes. `alloc(n)` creates `n` zeroed bytes.
- `.write("RIFF", 0)` — writes ASCII characters at byte offset 0. "RIFF" is a "magic number" — every WAV file starts with these 4 bytes.
- `.writeUInt32LE(value, offset)` — writes a 4-byte unsigned integer at `offset`. `LE` = **Little Endian** (least significant byte first) — the standard byte order for WAV files and Intel/AMD hardware.
- `pcmBuffer.copy(wavBuffer, 44)` — copies all bytes from `pcmBuffer` into `wavBuffer` starting at position 44.

`Buffer` appears whenever Node.js deals with binary data — files, network bytes, images, audio at the raw level.

---

## Step 8 — Multi-speaker TTS

Single speaker uses one voice config; multi-speaker uses an array:

```js
// Multi-speaker body:
speechConfig: {
  multiSpeakerVoiceConfig: {
    speakerVoiceConfigs: [
      { speaker: "Alice", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      { speaker: "Bob",   voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } }
    ]
  }
}
```

Text prompt labels who says what:
```
"Alice: Hello, welcome to the meeting! Bob: Thanks for having me."
```

Gemini assigns the correct voice to each line by matching speaker names.

---

## Full execution flow

```
node app.js
  └─ prints tool list + example queries
  └─ createMcpClient()  ← Files MCP via stdio
  └─ runRepl()
      └─ user: "Transcribe workspace/input/tech_briefing.wav"
      └─ run(query)
          └─ [GPT-4.1]     decides: call transcribe_audio
          └─ loadAudio()   file < 20MB → inline base64
          └─ [Gemini Flash] transcribeAudio({ audioBase64, schema })
              └─ returns JSON: { summary, segments: [{ speaker, timestamp, content }] }
          └─ [GPT-4.1]     formats and returns summary

      └─ user: "Generate a warm audio greeting for our website"
      └─ run(query, { conversationHistory: [previous] })
          └─ [GPT-4.1]     decides: call generate_audio, picks voice "Sulafat (Warm)"
          └─ [Gemini TTS]  generateSpeech({ text: "Welcome...", voice: "Sulafat" })
              └─ returns raw PCM buffer
          └─ writeWavFile("workspace/output/greeting_1234.wav", pcmBuffer)
          └─ [GPT-4.1]     reports: "Generated at workspace/output/greeting_1234.wav"
```

---

## What's new vs previous examples

| Feature | Reports | Audio |
|---|---|---|
| GPT for agent reasoning | ✅ | ✅ same |
| MCP file tools | ✅ | ✅ same |
| Gemini image generation | ✅ | ❌ |
| Gemini audio understanding | ❌ | ✅ new |
| Gemini TTS | ❌ | ✅ new |
| Large file upload (Files API) | ❌ | ✅ new |
| YouTube URL as input | ❌ | ✅ new |
| Structured JSON schema output | ❌ | ✅ new |
| WAV binary file construction | ❌ | ✅ new |

**New JS/Node concepts:**
- `Object.entries(obj)` — object → `[[key, value], ...]` pairs
- `([name, style]) => ...` — destructuring in arrow function parameter
- `{ ...existing, newKey: val }` — spread in object literal
- `...(cond && { key: val })` — conditional spread (adds field only if truthy)
- `Buffer` — Node.js type for raw binary data
- `buffer.writeUInt32LE(value, offset)` — write integer at binary offset (LE = little-endian)
