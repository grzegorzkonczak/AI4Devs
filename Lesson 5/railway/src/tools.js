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

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = {
  req:  (msg)       => console.log(`  📤 [HTTP →] ${msg}`),
  res:  (msg)       => console.log(`  📥 [HTTP ←] ${msg}`),
  wait: (msg)       => console.log(`  ⏳ [WAIT]   ${msg}`),
  retry:(msg)       => console.log(`  🔁 [RETRY]  ${msg}`),
  rl:   (msg)       => console.log(`  🚦 [RATELIM] ${msg}`),
}

// ─── Tool handler (what actually runs) ───────────────────────────────────────

const handlers = {
  async call_railway_api({ answer }) {
    const payload = { apikey: RAILWAY_API_KEY, task: RAILWAY_TASK, answer }
    const body = JSON.stringify(payload)

    let attempt = 0
    while (true) {
      attempt++
      log.req(`POST ${RAILWAY_API_URL}  (attempt #${attempt})`)
      log.req(`Body: ${JSON.stringify(answer)}`)

      const res = await fetch(RAILWAY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

      log.res(`Status: ${res.status}`)

      // Print ALL response headers so nothing is missed
      const headers = Object.fromEntries(res.headers)
      log.res(`Headers: ${JSON.stringify(headers)}`)

      // 503 — simulated overload, retry after short delay
      if (res.status === 503) {
        log.retry(`503 server overload — waiting 2s before retry...`)
        await sleep(2000)
        continue
      }

      // 429 — rate limited, wait for reset
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') ?? res.headers.get('X-RateLimit-Reset') ?? '10'
        const waitSec = parseInt(retryAfter)
        log.rl(`429 rate limit hit — must wait ${waitSec}s for reset`)
        log.wait(`Sleeping ${waitSec}s...`)
        await sleep(waitSec * 1000)
        log.wait(`Done sleeping, retrying now`)
        continue
      }

      const text = await res.text()
      log.res(`Raw body: ${text}`)

      // Log remaining rate limit quota if present
      const remaining = res.headers.get('X-RateLimit-Remaining')
      const reset = res.headers.get('X-RateLimit-Reset') ?? res.headers.get('Retry-After')
      if (remaining !== null) {
        log.rl(`${remaining} calls remaining, resets in ${reset}s`)
      }

      // Parse JSON — return to LLM whether success or API-level error
      try {
        return JSON.parse(text)
      } catch {
        return { raw: text }
      }
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
