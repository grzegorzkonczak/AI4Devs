import { RAILWAY_API_URL, RAILWAY_API_KEY, RAILWAY_TASK } from './config.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ─── Tool definition (what the LLM sees) ─────────────────────────────────────

export const nativeTools = [
  {
    type: 'function',
    name: 'call_railway_api',
    description: `Call the railway control system API. 
503 errors (server overload) and 429 errors (rate limit) are handled automatically — you will always get a clean result or error back.
Always start with action "help" to read the API documentation before taking any other action.`,
    parameters: {
      type: 'object',
      properties: {
        answer: {
          type: 'object',
          description: 'The full payload to send to the API. Must include "action". Additional fields depend on the action — read the help response to learn them.',
          properties: {
            action: {
              type: 'string',
              description: 'The action to call (e.g. "help"). See help response for all available actions.'
            }
          },
          required: ['action'],
          additionalProperties: true
        }
      },
      required: ['answer'],
      additionalProperties: false
    }
  }
]

// ─── Tool handler (what actually runs) ───────────────────────────────────────

const handlers = {
  async call_railway_api({ answer }) {
    const body = JSON.stringify({
      apikey: RAILWAY_API_KEY,
      task: RAILWAY_TASK,
      answer,
    })

    while (true) {
      const res = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

      // 503 — simulated overload, retry after short delay
      if (res.status === 503) {
        console.log('    [tool] 503 — retrying in 2s...')
        await sleep(2000)
        continue
      }

      // 429 — rate limited, wait for reset
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') ?? res.headers.get('X-RateLimit-Reset') ?? '10'
        const waitSec = parseInt(retryAfter)
        console.log(`    [tool] 429 — rate limited, waiting ${waitSec}s...`)
        await sleep(waitSec * 1000)
        continue
      }

      const data = await res.json()

      // Log remaining rate limit quota after every successful call
      const remaining = res.headers.get('X-RateLimit-Remaining')
      const reset = res.headers.get('X-RateLimit-Reset') ?? res.headers.get('Retry-After')
      if (remaining !== null) {
        console.log(`    [tool] rate limit: ${remaining} remaining, resets in ${reset}s`)
      }

      // Return the parsed JSON to the LLM — whether success or API-level error
      return data
    }
  }
}

// ─── Registry helpers (same pattern as 01_05_confirmation) ───────────────────

export const isNativeTool = (name) => name in handlers

export const executeNativeTool = async (name, args) => {
  const handler = handlers[name]
  if (!handler) throw new Error(`Unknown native tool: ${name}`)
  return handler(args)
}
