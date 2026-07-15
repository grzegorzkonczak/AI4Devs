import { OPENAI_API_KEY, agentConfig } from './config.js'
import { nativeTools, isNativeTool, executeNativeTool } from './tools.js'

const MAX_STEPS = 20

const chat = async (messages) => {
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

export const run = async (task) => {
  console.log(`\n🎯 Task: ${task}\n`)
  const messages = [{ role: 'user', content: task }]

  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`\n[Step ${step}] LLM thinking... (${messages.length} messages in context)`)
    const response = await chat(messages)
    const toolCalls = extractToolCalls(response)

    if (toolCalls.length === 0) {
      const text = extractText(response)
      console.log(`\n✅ Done:\n${text}`)
      return text
    }

    messages.push(...response.output)

    for (const tc of toolCalls) {
      const args = JSON.parse(tc.arguments)
      console.log(`\n⚡ [${tc.name}] ${JSON.stringify(args)}`)
      const result = await executeNativeTool(tc.name, args)
      console.log(`   → ${JSON.stringify(result).substring(0, 400)}`)
      messages.push({ type: 'function_call_output', call_id: tc.call_id, output: JSON.stringify(result) })
    }
  }

  throw new Error(`Max steps (${MAX_STEPS}) reached`)
}
