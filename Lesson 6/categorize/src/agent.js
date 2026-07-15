import { OPENAI_API_KEY, agentConfig } from './config.js'
import { nativeTools, executeNativeTool } from './tools.js'

const MAX_STEPS = 40
const DIVIDER = '─'.repeat(72)

// ─── Logging helpers ──────────────────────────────────────────────────────────
const logLlmSend = (messages) => {
  console.log(`\n${DIVIDER}`)
  console.log(`🧠 [LLM →] Sending ${messages.length} message(s) to OpenAI`)
  for (const [i, m] of messages.entries()) {
    const preview = JSON.stringify(m)
    console.log(`   [${i}] ${preview.length > 200 ? preview.substring(0, 200) + '…' : preview}`)
  }
}

const logLlmReceive = (response) => {
  console.log(`🧠 [LLM ←] Response (status 200)`)
  console.log(`   tokens: ${response.usage?.input_tokens} in / ${response.usage?.output_tokens} out`)
  for (const item of response.output ?? []) {
    if (item.type === 'function_call') {
      console.log(`   🔧 tool_call: ${item.name}(${item.arguments})`)
    } else if (item.type === 'message') {
      const text = (item.content ?? []).filter(p => p.type === 'output_text').map(p => p.text).join('')
      console.log(`   💬 message: ${text.substring(0, 300)}${text.length > 300 ? '…' : ''}`)
    }
  }
  console.log(DIVIDER)
}

// ─── OpenAI Responses API ─────────────────────────────────────────────────────
const chat = async (messages) => {
  logLlmSend(messages)

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
  if (!res.ok) throw new Error(data.error?.message ?? `OpenAI error ${res.status}`)

  logLlmReceive(data)
  return data
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

// ─── Agent loop ───────────────────────────────────────────────────────────────
export const run = async (task) => {
  console.log(`\n🎯 Task: ${task}\n`)
  const messages = [{ role: 'user', content: task }]

  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`\n══ Step ${step} / ${MAX_STEPS} ══════════════════════════════════════════════`)

    const response = await chat(messages)
    const toolCalls = extractToolCalls(response)

    if (toolCalls.length === 0) {
      const text = extractText(response)
      console.log(`\n✅ Agent finished:\n${text}`)
      return text
    }

    messages.push(...response.output)

    for (const tc of toolCalls) {
      const args = JSON.parse(tc.arguments)
      console.log(`\n⚡ [TOOL CALL] ${tc.name}`)
      console.log(`   call_id: ${tc.call_id}`)
      console.log(`   args:    ${JSON.stringify(args, null, 2).split('\n').join('\n   ')}`)

      const result = await executeNativeTool(tc.name, args)

      const resultStr = JSON.stringify(result)
      console.log(`\n   [TOOL RESULT] ${resultStr.length > 500 ? resultStr.substring(0, 500) + '…' : resultStr}`)

      messages.push({ type: 'function_call_output', call_id: tc.call_id, output: JSON.stringify(result) })
    }
  }

  throw new Error(`Max steps (${MAX_STEPS}) reached without completing the task`)
}

