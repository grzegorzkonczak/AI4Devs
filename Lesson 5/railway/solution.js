/**
 * Lesson 5 — Railway exercise
 * Goal: activate route X-01 via a self-documenting API
 *
 * Challenges:
 *  - API returns 503 randomly (simulated overload) → retry with backoff
 *  - Very strict rate limits (429) → read reset header, wait exactly that long
 *  - Self-documenting: start with 'help', follow what it says
 */

const API_URL = 'https://hub.ag3nts.org/verify'
const API_KEY = '4abb691a-12aa-4546-82c5-1b6ba1c19f60'
const TASK = 'railway'

// ─── API client with retry + rate-limit handling ───────────────────────────

const call = async (answer) => {
  const body = JSON.stringify({ apikey: API_KEY, task: TASK, answer })

  while (true) {
    console.log(`\n→ Calling: ${JSON.stringify(answer)}`)

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    // 503 — simulated overload, retry after short delay
    if (res.status === 503) {
      console.log('  503 (overload) — retrying in 2s...')
      await sleep(2000)
      continue
    }

    // 429 — rate limited, check reset header
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After') || res.headers.get('X-RateLimit-Reset')
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 10000
      console.log(`  429 (rate limit) — waiting ${waitMs / 1000}s for reset...`)
      console.log('  All headers:', Object.fromEntries(res.headers))
      await sleep(waitMs)
      continue
    }

    // Any other non-OK response — log and throw
    if (!res.ok) {
      const text = await res.text()
      console.log(`  Error ${res.status}: ${text}`)
      console.log('  Headers:', Object.fromEntries(res.headers))
      throw new Error(`HTTP ${res.status}: ${text}`)
    }

    // Success — log rate limit headers so we can track usage
    const remaining = res.headers.get('X-RateLimit-Remaining')
    const reset = res.headers.get('X-RateLimit-Reset') || res.headers.get('Retry-After')
    if (remaining !== null) console.log(`  Rate limit: ${remaining} remaining, reset in ${reset}s`)

    const data = await res.json()
    console.log(`  Response:`, JSON.stringify(data, null, 2))
    return data
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ─── Main ───────────────────────────────────────────────────────────────────

const main = async () => {
  console.log('=== Railway exercise ===\n')

  // Step 1: read the API documentation
  const help = await call({ action: 'help' })
  console.log('\n=== HELP RESPONSE ===')
  console.log(JSON.stringify(help, null, 2))
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
