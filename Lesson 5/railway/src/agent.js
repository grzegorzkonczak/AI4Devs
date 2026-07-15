import { OPENAI_API_KEY, agentConfig } from './config.js'
import { nativeTools, isNativeTool, executeNativeTool } from './tools.js'

const MAX_STEPS = 30

// ─── OpenAI Responses API call ────────────────────────────────────────────────

const chat = async (messages) => {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: agentConfig.model,
      instructions: agentConfig.instructions,
      input: messages,
      tools: nativeTools,
    }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error?.message ?? `OpenAI API error ${response.status}`)
  }

  return data
}

// ─── Extract helpers ──────────────────────────────────────────────────────────

const extractToolCalls = (response) =>
  (response.output ?? []).filter(item => item.type === 'function_call')

const extractText = (response) => {
  if (response.output_text) return response.output_text

  return (response.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(msg => msg.content ?? [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text)
    .join('')
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

export const run = async (task) => {
  console.log(`\n🚂 Task: ${task}\n`)

  const messages = [{ role: 'user', content: task }]

  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`\n[Step ${step}] Asking LLM... (${messages.length} items in context)`)

    const response = await chat(messages)
    const toolCalls = extractToolCalls(response)

    // No tool calls → LLM is done, return its final text
    if (toolCalls.length === 0) {
      const text = extractText(response)
      console.log(`\n✅ Agent done:\n${text}`)
      return text
    }

    // Append LLM output to history (so it sees its own tool calls next turn)
    messages.push(...response.output)

    // Execute each tool call and append results
    for (const tc of toolCalls) {
      const args = JSON.parse(tc.arguments)
      console.log(`\n⚡ ${tc.name}(${JSON.stringify(args.answer)})`)

      const result = await executeNativeTool(tc.name, args)
      const preview = JSON.stringify(result).substring(0, 300)
      console.log(`   → ${preview}${preview.length === 300 ? '...' : ''}`)

      messages.push({
        type: 'function_call_output',
        call_id: tc.call_id,
        output: JSON.stringify(result),
      })
    }
  }

  throw new Error(`Max steps (${MAX_STEPS}) reached without completing the task`)
}
