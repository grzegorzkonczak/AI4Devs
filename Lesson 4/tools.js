import https from 'https'
import OpenAI from 'openai'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const API_KEY = '4abb691a-12aa-4546-82c5-1b6ba1c19f60'

// Downloads any URL and returns its content as base64 string
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

// Tool 1: reads the blocked routes PNG using GPT-4o vision
// Returns a text description of all route codes and city pairs in the image
async function read_blocked_routes() {
  console.log('[tool] Downloading blocked routes image...')
  const base64 = await downloadAsBase64('https://hub.ag3nts.org/dane/doc/trasy-wylaczone.png')

  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        { type: 'text', text: 'List ALL route codes and city pairs visible in this image. Be precise and complete.' }
      ]
    }]
  })

  const visionResponse = res.choices[0].message.content
  console.log('[vision] GPT-4o read the image:\n' + visionResponse)
  return visionResponse
}

// Tool 2: POSTs the filled declaration to the hub and returns the response
async function submit_declaration({ declaration }) {
  console.log('[tool] Submitting declaration to hub...')
  console.log('--- Declaration ---\n' + declaration + '\n---')

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      apikey: API_KEY,
      task: 'sendit',
      answer: { declaration }
    })

    const req = https.request({
      hostname: 'hub.ag3nts.org',
      path: '/verify',
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

// Tool definitions in the format OpenAI expects (passed to tools: [...] in API calls)
export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'read_blocked_routes',
      description: 'Downloads and reads the blocked routes image to find route codes between cities',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_declaration',
      description: 'Submits the completed SPK declaration to the hub for verification',
      parameters: {
        type: 'object',
        properties: {
          declaration: { type: 'string', description: 'The complete filled-out declaration text' }
        },
        required: ['declaration']
      }
    }
  }
]

// Map of tool name → actual function (agent.js uses this to execute tool calls)
export const toolHandlers = {
  read_blocked_routes,
  submit_declaration
}
