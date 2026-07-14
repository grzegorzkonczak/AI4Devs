# Walkthrough: `01_04_video` + `01_04_video_generation`

## The lesson context

Two related examples covered together:
- **`01_04_video`**: Video understanding — "talk directly with YouTube videos". Transcribe, analyze, extract scenes/objects/text, or ask freeform questions about any local video or YouTube URL. Architecture is nearly identical to `01_04_audio`.
- **`01_04_video_generation`**: Video creation pipeline. JSON template → Gemini generates start frame → Gemini edits it to produce an end frame (using start as reference for visual consistency) → **Kling** on Replicate generates the 10-second video between the two frames. A third provider enters the stack.

---

## Part 1 — `01_04_video` (the short one)

**This is `01_04_audio` with video MIME types.** Architecture identical: same Gemini Files API upload pattern, same structured JSON schema output, same agent loop and REPL.

### What's actually different

**1. Four tools**

```
analyze_video    — visual/audio/action/general analysis, returns key_moments with timestamps
transcribe_video — speech → structured JSON (also captures non-speech audio events)
extract_video    — NEW: extract scenes / keyframes / objects / on-screen text
query_video      — freeform questions, can reference specific timestamps
```

`extract_video` is the only genuinely new concept. Instead of describing the video, it asks Gemini to enumerate specific things. Each extraction type has its own JSON response schema:
- `scenes` → array of `{ scene_number, start_time, end_time, description, mood }`
- `keyframes` → array of `{ timestamp, description, significance }`
- `objects` → array of `{ name, timestamps[], context }`
- `text` → array of `{ content, timestamp, location, purpose }`

**2. Video clipping parameters**

```js
// All tools accept optional time range + fps:
start_time: "1m30s"   // start processing here
end_time:   "3m00s"   // stop here
fps: 0.5              // sample 1 frame every 2 seconds (for long videos)
```

These get packed into `videoMetadata`:
```js
const videoMetadata = buildVideoMetadata({ start_time, end_time, fps })
// → { start_offset: "1m30s", end_offset: "3m00s", fps: 0.5 }
// attached as video_metadata on the Gemini request part
```

Config notes: *~300 tokens/second at default resolution, ~1M tokens per hour*. Clipping is the main cost control tool.

**3. Prompt ordering is reversed vs audio**

```js
// audio: text first, then media
parts = [{ text: prompt }, audioData]

// video: media first, then text (Gemini docs recommendation)
parts = [videoData, { text: prompt }]
```

**4. YouTube URLs skip the MIME type**

```js
if (fileUri.includes("youtube.com") || fileUri.includes("youtu.be")) {
  parts.push({ file_data: { file_uri: fileUri } })         // no mime_type
} else {
  parts.push({ file_data: { file_uri: fileUri, mime_type: mimeType } })
}
```

Gemini natively recognises YouTube URLs and doesn't need a content type hint.

That's all that's new in `01_04_video`.

---

## Part 2 — `01_04_video_generation` (the interesting one)

Combines the image generation patterns from `json_image` / `image_guidance` with a brand new provider: **Replicate** running the **Kling** model.

### File map

```
src/
  native/
    tools.js       ← 5 tools: create_image, analyze_image, generate_video, image_to_video, analyze_video
    gemini.js      ← image generation (identical to reports/json_image)
    replicate.js   ← NEW: Kling video generation via Replicate SDK
  config.js        ← 3 required API keys: OpenAI + Gemini/OpenRouter + Replicate
workspace/
  template.json    ← JSON image prompt template (same pattern as json_image)
  prompts/         ← versioned copies
  demo/            ← fox example: start frame, end frame, and final video
```

### Three providers, all required

```js
// config.js checks at startup:
if (!hasGeminiImageBackend && !hasOpenRouterImageBackend)  → process.exit(1)
if (!process.env.REPLICATE_API_TOKEN)                      → process.exit(1)
```

| Provider | Role |
|---|---|
| **GPT-4.1** | Agent reasoning loop |
| **Gemini** | Image generation (start frame, end frame) |
| **Kling via Replicate** | Video generation (text→video or frames→video) |

---

### Step into: `replicate.js` — the new provider

**New: Replicate SDK**

```js
import Replicate from "replicate"
const replicate = new Replicate()
// automatically reads REPLICATE_API_TOKEN from environment
```

Unlike Gemini and OpenAI calls which use raw `fetch()` with manually constructed headers and JSON bodies, the Replicate SDK gives you a single high-level call:

```js
const output = await replicate.run(KLING_MODEL, { input })
```

`replicate.run()` does several things under the hood:
1. Submits the job to Replicate's API
2. **Polls for completion** — Kling takes 30–120 seconds to generate video
3. Returns only when done

Without the SDK you'd write the polling loop yourself: submit → wait → check status → wait → check again... The SDK absorbs all of that.

**`generateVideo` — text to video:**

```js
export const generateVideo = async ({ prompt, duration = 10, aspectRatio = "16:9", negativePrompt = "" }) => {
  const input = { prompt, duration, aspect_ratio: aspectRatio, negative_prompt: negativePrompt }
  const output = await replicate.run(KLING_MODEL, { input })
  
  const videoUrl = output.url ? output.url() : output
  //              ↑ output shape varies by model version
  
  return { url: videoUrl, prompt, duration, aspectRatio }
}
```

**`imageToVideo` — start frame (+ optional end frame) to video:**

```js
export const imageToVideo = async ({ prompt, startImagePath, endImagePath, ... }) => {
  const startImageBuffer = await readFile(join(PROJECT_ROOT, startImagePath))
  
  const input = {
    prompt,
    start_image: startImageBuffer,   // ← raw Buffer, Replicate SDK handles encoding
    ...
  }
  
  if (endImagePath) {
    input.end_image = await readFile(join(PROJECT_ROOT, endImagePath))
  }
  
  const output = await replicate.run(KLING_MODEL, { input })
  ...
}
```

The Replicate SDK accepts Node.js `Buffer` objects directly for image inputs — it encodes them internally. You just read the file and pass it.

**`downloadVideo` — saving the generated video:**

Kling hosts generated videos temporarily on Replicate's servers. The code downloads them:

```js
export const downloadVideo = async (url, outputName) => {
  const response = await fetch(url)
  const buffer = Buffer.from(await response.arrayBuffer())
  //                                     ↑
  //                  .arrayBuffer() — new method!
  
  const filename = `${outputName}_${Date.now()}.mp4`
  await writeFile(join(PROJECT_ROOT, "workspace/output", filename), buffer)
  return `workspace/output/${filename}`
}
```

**New JS syntax — `response.arrayBuffer()`:**

You've seen `response.json()` and `response.text()`. `.arrayBuffer()` is the third: reads the entire response as raw binary data. `Buffer.from(arrayBuffer)` converts it to a Node.js `Buffer` you can write to disk.

This is how you download any binary file (video, image, PDF) from a URL — you can't use `.json()` or `.text()` for binary data, they'd produce garbage.

---

### The agent instructions: three-step workflow

`config.js` instructions describe the workflow precisely (this is a workflow-style agent — steps are defined, not just goals):

```
Step 1: Generate START Frame
  - Copy workspace/template.json → workspace/prompts/{scene}_{timestamp}.json
  - Edit ONLY the "subject" section for the STARTING state
  - create_image(fullJson, aspect_ratio: "16:9", image_size: "2k")
  - Output: {scene}_frame_start_{timestamp}.png

Step 2: Generate END Frame FROM the start frame
  - create_image(endStatePrompt, reference_images: [start_frame_path])
  - Prompt describes the END state while referencing start frame for consistency
  - Output: {scene}_frame_end_{timestamp}.png

Step 3: Generate Video
  - image_to_video(motion_prompt, start_image: start, end_image: end)
  - Prompt describes the motion between the two frames
```

**Why start AND end frame?**

Kling can generate from just text or just a start image, but the lesson emphasises: *"indicating starting and ending frames allows achieving a high level of control."* Without an end frame, Kling decides where the video ends — with both frames defined, you control the exact beginning and ending state, and Kling only needs to figure out the motion between them.

**Why generate end frame FROM the start frame?**

Character consistency across independent generations is hard. A fresh generation of "the same fox" will have slightly different proportions, fur color, ear shape. By passing the start frame as `reference_images` when generating the end frame, Gemini keeps the character visually identical — only the pose and state changes.

From the instructions:
```
"Same fox character with identical fur colors and markings, now landed in a fluffy snowdrift.
 Fox is partially buried in snow up to chest, snow particles floating... Keep exact same art
 style and line quality."
```

The demo folder shows this in action: `fox_fence_snow_frame_start.jpg`, `fox_fence_snow_frame_start_v2.jpg`, and two final `.mp4` videos.

**When to skip the end frame reference** (from instructions):
- Character transforms completely (caterpillar → butterfly)
- Scene changes entirely (day → night, different location)
- User explicitly asks for dramatic change

Otherwise: always use start frame as reference.

---

### The `analyze_video` tool in video_generation

After generating, the agent reviews its own video before delivering:

```js
const videoBuffer = await readFile(fullPath)
const videoBase64 = videoBuffer.toString("base64")

const analysis = await processVideo({
  videoBase64,
  mimeType: "video/mp4",
  prompt: prompts[analysis_focus]   // general / motion / quality / prompt_adherence
})
```

Four focus modes, `prompt_adherence` being the most useful — it receives the original prompt and scores how well the video matched it. This is the self-evaluation loop pattern again, now applied to video.

---

### Full execution flow: `01_04_video_generation`

```
user: "Create a video of a fox jumping over a fence into snow"
  │
  └─ [GPT-4.1] plans 3-step workflow
  │
  ├─ [MCP] fs_read("workspace/template.json")
  ├─ [MCP] fs_write("workspace/prompts/fox_fence_snow_123.json")  ← clone + edit subject only
  │
  ├─ [Gemini] create_image(fullJson, 16:9, 2k)
  │    → "workspace/output/fox_fence_snow_frame_start_123.jpg"    ← start frame
  │
  ├─ [GPT-4.1 vision] analyze_image(start_frame) — quality check
  │
  ├─ [Gemini] create_image(endStatePrompt, reference: [start_frame])
  │    → "workspace/output/fox_fence_snow_frame_end_456.jpg"      ← end frame (same fox!)
  │
  ├─ [Kling/Replicate] image_to_video(motion_prompt, start, end)
  │    → replicate.run() polls ~60s until ready
  │    → returns video URL
  │    → downloadVideo() fetches binary, saves locally
  │    → "workspace/output/fox_fence_snow_video_789.mp4"
  │
  ├─ [Gemini] analyze_video(video_path, focus: "prompt_adherence")
  │    → "Motion smooth, fox consistent across frames, 8/10"
  │
  └─ [GPT-4.1] "Video created at workspace/output/fox_fence_snow_video_789.mp4"
```

---

## What's new across both examples

| Feature | audio | video | video_generation |
|---|---|---|---|
| Gemini understanding (media) | ✅ audio | ✅ video | ✅ video (analysis only) |
| Gemini image generation | ❌ | ❌ | ✅ same as reports |
| Files API upload | ✅ | ✅ same | ❌ |
| YouTube URL support | ✅ | ✅ same | ❌ |
| Video clipping (fps/start/end) | ❌ | ✅ new | ❌ |
| `extract_video` tool | ❌ | ✅ new | ❌ |
| Replicate/Kling SDK | ❌ | ❌ | ✅ new |
| Text→video, frames→video | ❌ | ❌ | ✅ new |
| Start+End frame workflow | ❌ | ❌ | ✅ new |
| `response.arrayBuffer()` | ❌ | ❌ | ✅ new |

**New JS/Node concepts:**
- `response.arrayBuffer()` — fetch response as raw binary (for downloading binary files)
- `new Replicate()` — SDK client that auto-reads env var and wraps async polling
- `replicate.run(model, { input })` — one call handles submit + poll + return

**Longer-chain continuity (video_generation):**
- Combines: JSON template prompt (from `json_image`) + reference image (from `image_guidance`) + self-evaluation loop (from `image_editing`) + new Kling generation — all in one agent
