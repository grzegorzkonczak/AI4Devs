import { API_KEY, HUB_URL, CSV_URL, TASK } from './config.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── CSV parser ───────────────────────────────────────────────────────────────
// Splits on first comma only so descriptions containing commas stay intact.
// Strips surrounding quotes from values (CSV standard quoting).
const stripQuotes = s => s?.replace(/^["']|["']$/g, '').trim() ?? ''

const parseCsv = (text) => {
  const lines = text.trim().split('\n').filter(Boolean)
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
  return lines.slice(1).map(line => {
    const firstComma = line.indexOf(',')
    const values = firstComma === -1
      ? [line.trim()]
      : [line.slice(0, firstComma).trim(), line.slice(firstComma + 1).trim()]
    const obj = Object.fromEntries(headers.map((h, i) => [h, stripQuotes(values[i] ?? '')]))
    // Normalise: if CSV uses 'code' as the identifier column, alias it as 'id' too
    if (obj.code && !obj.id) obj.id = obj.code
    return obj
  })
}

// ─── Hub API client with retry ────────────────────────────────────────────────
const callHub = async (payload, label) => {
  let attempt = 0
  while (true) {
    attempt++
    console.log(`  [hub] ${label} (attempt ${attempt})`)

    const res = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: API_KEY, task: TASK, ...payload }),
    })

    if (res.status === 503) {
      console.log('  [hub] 503 — retrying in 2s...')
      await sleep(2000)
      continue
    }
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') ?? '10')
      console.log(`  [hub] 429 — waiting ${wait}s...`)
      await sleep(wait * 1000)
      continue
    }

    const data = await res.json()
    console.log(`  [hub] ← ${JSON.stringify(data)}`)
    return data
  }
}

// ─── Tool definitions (what the LLM sees) ────────────────────────────────────
export const nativeTools = [
  {
    type: 'function',
    name: 'fetch_items',
    description: 'Download the current list of 10 cargo items to classify. Returns an array of { id, description } objects. Call this first to understand what needs classifying.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'test_prompt',
    description: `Test a classification prompt template against all 10 items.
Steps performed automatically: reset budget → fetch fresh items → send 10 requests.
Use {id} and {description} as placeholders — they will be replaced with real values.
Put static instructions FIRST, {id} and {description} LAST for best caching.
Returns per-item results and the flag if all 10 were correct.
Send prompt_template "reset" to just reset the budget counter without testing.`,
    parameters: {
      type: 'object',
      properties: {
        prompt_template: {
          type: 'string',
          description: 'The prompt template to test. Use {id} and {description} as placeholders for item data at the end.',
        },
      },
      required: ['prompt_template'],
      additionalProperties: false,
    },
  },
]

// ─── Tool handlers (what actually runs) ──────────────────────────────────────
const handlers = {
  async fetch_items() {
    console.log(`\n[fetch_items] Downloading CSV from ${CSV_URL}`)
    const res = await fetch(CSV_URL)
    if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`)
    const text = await res.text()
    console.log(`[fetch_items] Raw CSV:\n${text}`)
    const items = parseCsv(text)
    console.log(`[fetch_items] Parsed ${items.length} items:`)
    items.forEach(item => console.log(`   • ${item.id}: ${item.description ?? item.name}`))
    return items
  },

  async test_prompt({ prompt_template }) {
    // Special case: just reset
    if (prompt_template.trim().toLowerCase() === 'reset') {
      const result = await callHub({ answer: { prompt: 'reset' } }, 'RESET')
      return { reset: true, response: result }
    }

    // Step 1: reset budget
    console.log('\n[test_prompt] ── Starting new test cycle ──────────────────────────')
    console.log('[test_prompt] Step 1: Resetting budget...')
    const resetResp = await callHub({ answer: { prompt: 'reset' } }, 'RESET')
    console.log(`[test_prompt] Reset response: ${JSON.stringify(resetResp)}`)

    // Step 2: fetch fresh items
    console.log('\n[test_prompt] Step 2: Fetching fresh items...')
    const res = await fetch(CSV_URL)
    if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`)
    const items = parseCsv(await res.text())
    console.log(`[test_prompt] Got ${items.length} items`)

    // Step 3: test each item
    console.log('\n[test_prompt] Step 3: Testing prompt against all items...')
    console.log(`[test_prompt] Template: "${prompt_template}"\n`)
    const results = []
    let flag = null

    for (const [idx, item] of items.entries()) {
      const id = item.id ?? item.code ?? ''
      const description = item.description ?? item.name ?? ''
      const prompt = prompt_template
        .replace(/{id}/g, id)
        .replace(/{code}/g, id)           // agent may use {code} — both work
        .replace(/{description}/g, description)

      console.log(`\n  [${idx + 1}/10] Item: ${id} — "${description}"`)
      console.log(`  [${idx + 1}/10] Prompt sent: "${prompt}"`)

      const response = await callHub({ answer: { prompt } }, `item ${id}`)

      if (response.message && String(response.message).includes('{FLG:')) {
        flag = response.message
        console.log(`\n  🚩 FLAG RECEIVED: ${flag}`)
      }

      const ok = response.ok === true || response.code === 0
      console.log(`  [${idx + 1}/10] Result: ${ok ? '✅ PASS' : '❌ FAIL'} — ${JSON.stringify(response)}`)

      results.push({ id, description, prompt_sent: prompt, response, ok })
    }

    const allCorrect = results.every(r => r.ok)
    const passed = results.filter(r => r.ok).length
    const failed = results.filter(r => !r.ok)

    console.log(`\n[test_prompt] ── Cycle summary: ${passed}/10 correct ────────────────`)
    if (failed.length > 0) {
      console.log('[test_prompt] Failed items:')
      failed.forEach(r => console.log(`   ❌ ${r.id} ("${r.description}") → ${JSON.stringify(r.response)}`))
    }
    if (flag) console.log(`[test_prompt] 🎉 FLAG: ${flag}`)
    console.log('[test_prompt] ──────────────────────────────────────────────────────\n')

    return {
      allCorrect,
      flag,
      passed,
      total: items.length,
      results: results.map(r => ({ id: r.id, description: r.description, ok: r.ok, response: r.response })),
    }
  },
}

// ─── Registry ─────────────────────────────────────────────────────────────────
export const isNativeTool = name => name in handlers
export const executeNativeTool = async (name, args) => {
  const handler = handlers[name]
  if (!handler) throw new Error(`Unknown tool: ${name}`)
  return handler(args)
}
