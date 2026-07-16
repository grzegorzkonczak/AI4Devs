import { API_KEY, HUB_URL, CSV_URL, TASK } from './config.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// --- CSV parser ---
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

// --- Hub API client with retry ---
const callHub = async (payload) => {
  while (true) {
    const res = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: API_KEY, task: TASK, ...payload }),
    })

    if (res.status === 503) {
      console.log('     [hub] 503 - retrying in 2s...')
      await sleep(2000)
      continue
    }
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') ?? '10')
      console.log(`     [hub] 429 - waiting ${wait}s...`)
      await sleep(wait * 1000)
      continue
    }

    return await res.json()
  }
}

// --- Tool definitions (what the LLM sees) ---
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
Steps performed automatically: reset budget -> fetch fresh items -> send 10 requests.
Use {id} and {description} as placeholders - they will be replaced with real values.
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

// --- Tool handlers (what actually runs) ---
const handlers = {
  async fetch_items() {
    const res = await fetch(CSV_URL)
    if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`)
    const items = parseCsv(await res.text())
    console.log(`\n     Items (${items.length}):`)
    items.forEach(item => console.log(`       ${String(item.id).padEnd(8)} ${item.description ?? item.name}`))
    return items
  },

  async test_prompt({ prompt_template }) {
    // Special case: just reset
    if (prompt_template.trim().toLowerCase() === 'reset') {
      const result = await callHub({ answer: { prompt: 'reset' } })
      return { reset: true, response: result }
    }

    // Step 1: reset budget
    console.log('\n     [1/3] Resetting budget...')
    const resetResp = await callHub({ answer: { prompt: 'reset' } })
    const balance = resetResp?.debug?.balance ?? resetResp?.message ?? '?'
    console.log(`           Balance: ${balance}`)

    // Step 2: fetch fresh items
    console.log('     [2/3] Fetching items...')
    const res = await fetch(CSV_URL)
    if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`)
    const items = parseCsv(await res.text())

    // Step 3: test each item
    console.log(`     [3/3] Testing prompt against ${items.length} items...`)
    const results = []
    let flag = null

    for (const [idx, item] of items.entries()) {
      const id = item.id ?? item.code ?? ''
      const description = item.description ?? item.name ?? ''
      const prompt = prompt_template
        .replace(/{id}/g, id)
        .replace(/{code}/g, id)
        .replace(/{description}/g, description)

      const response = await callHub({ answer: { prompt } })

      if (response.message && String(response.message).includes('{FLG:')) {
        flag = response.message
      }

      const msg = String(response.message ?? "")

      // Insufficient funds mid-test: abort remaining items (no point calling hub further)
      if (msg.toLowerCase().includes("insufficient")) {
        console.log(`           [${String(idx + 1).padStart(2)}/10] STOP  ${String(id).padEnd(8)} out of budget - aborting`)
        break
      }

      const ok = response.ok === true || response.code === 0 || msg.toLowerCase().includes("accepted")
      const hint = ok ? 'pass' : (response.hint ?? response.message ?? 'fail')
      console.log(`           [${String(idx + 1).padStart(2)}/10] ${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(8)} ${hint}`)

      results.push({ id, description, ok, response })
    }

    const passed = results.filter(r => r.ok).length
    const failedIds = results.filter(r => !r.ok).map(r => r.id).join(', ')

    console.log(`\n     Result: ${passed}/10 correct${passed < 10 ? `  (failed: ${failedIds})` : ''}`)
    if (flag) console.log(`     *** FLAG: ${flag} ***`)

    return {
      allCorrect: passed === 10,
      flag,
      passed,
      total: items.length,
      results: results.map(r => ({ id: r.id, description: r.description, ok: r.ok, hint: r.response?.hint ?? r.response?.message })),
    }
  },
}

// --- Registry ---
export const isNativeTool = name => name in handlers
export const executeNativeTool = async (name, args) => {
  const handler = handlers[name]
  if (!handler) throw new Error(`Unknown tool: ${name}`)
  return handler(args)
}