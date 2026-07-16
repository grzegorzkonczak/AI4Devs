import { OPENAI_API_KEY, agentConfig } from './config.js'
import { nativeTools, executeNativeTool } from './tools.js'

const MAX_STEPS = 40

// --- OpenAI Responses API ---
const chat = async (messages) => {
  console.log(`\n Thinking... (${messages.length} messages in context)`)

  while (true) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: agentConfig.model,
        instructions: agentConfig.instructions,
        input: messages,
        tools: nativeTools,
      }),
    })
    const data = await res.json()

    // OpenAI TPM / RPM rate limit - parse wait time from error message and retry
    if (res.status === 429) {
      const msg = data.error?.message ?? ''
      const match = msg.match(/try again in ([\d.]+)s/i)
      const waitSec = match ? Math.ceil(parseFloat(match[1])) + 1 : 15
      console.log(`  OpenAI rate limit - waiting ${waitSec}s...`)
      await new Promise(r => setTimeout(r, waitSec * 1000))
      continue
    }

    if (!res.ok) throw new Error(data.error?.message ?? `OpenAI error ${res.status}`)

    // Show what the LLM said (its reasoning or plan)
    for (const item of data.output ?? []) {
      if (item.type === 'message') {
        const text = (item.content ?? []).filter(p => p.type === 'output_text').map(p => p.text).join('')
        if (text) console.log(`  Agent: ${text.length > 300 ? text.substring(0, 300) + '...' : text}`)
      }
    }

    return data
  }
}

const extractToolCalls = r => (r.output ?? []).filter(i => i.type === 'function_call')
const extractText = r => {
  if (r.output_text) return r.output_text
  return (r.output ?? [])
    .filter(i => i.type === 'message')
    .flatMap(m => m.content ?? [])
    .filter(p => p.type === 'output_text')
    .map(p => p.text).join('')
}

// --- Agent loop ---
export const run = async (task) => {
  console.log(`\n=== STARTING CATEGORIZE AGENT ===`)
  console.log(`Task: ${task}\n`)
  const messages = [{ role: 'user', content: task }]

  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`\n--- Step ${step} ---`)

    const response = await chat(messages)
    const toolCalls = extractToolCalls(response)

    if (toolCalls.length === 0) {
      const text = extractText(response)
      console.log(`\n=== Agent done ===\n${text}`)
      return text
    }

    messages.push(...response.output)

    for (const tc of toolCalls) {
      const args = JSON.parse(tc.arguments)

      // Show tool call intent - include the template for test_prompt (the key info)
      if (tc.name === 'test_prompt') {
        console.log(`\n  -> test_prompt`)
        console.log(`     Template: "${args.prompt_template}"`)
      } else {
        console.log(`\n  -> ${tc.name}`)
      }

      const result = await executeNativeTool(tc.name, args)
      messages.push({ type: 'function_call_output', call_id: tc.call_id, output: JSON.stringify(result) })
    }
  }

  throw new Error(`Max steps (${MAX_STEPS}) reached without completing the task`)
}