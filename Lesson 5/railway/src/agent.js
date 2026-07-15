import { OPENAI_API_KEY, agentConfig } from './config.js'
import { nativeTools, isNativeTool, executeNativeTool } from './tools.js'

const MAX_STEPS = 30

const DIVIDER = '─'.repeat(70)

// ─── OpenAI Responses API call ────────────────────────────────────────────────

const chat = async (messages) => {
  const payload = {
    model: agentConfig.model,
    instructions: agentConfig.instructions,
    input: messages,
    tools: nativeTools,
  }

  console.log(`\n${DIVIDER}`)
  console.log(`🧠 [LLM →] Sending to OpenAI (model: ${agentConfig.model})`)
  console.log(`   instructions: ${agentConfig.instructions.substring(0, 120)}...`)
  console.log(`   input has ${messages.length} item(s):`)
  for (const [i, m] of messages.entries()) {
    const preview = JSON.stringify(m).substring(0, 200)
    console.log(`     [${i}] ${preview}${JSON.stringify(m).length > 200 ? '...' : ''}`)
  }
  console.log(`   tools: [${nativeTools.map(t => t.name).join(', ')}]`)

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  })

  const data = await response.json()

  console.log(`\n🧠 [LLM ←] Response from OpenAI (status: ${response.status})`)

  if (!response.ok) {
    console.log(`   ERROR: ${JSON.stringify(data.error)}`)
    throw new Error(data.error?.message ?? `OpenAI API error ${response.status}`)
  }

  console.log(`   usage: input_tokens=${data.usage?.input_tokens}, output_tokens=${data.usage?.output_tokens}`)
  console.log(`   output (${(data.output ?? []).length} item(s)):`)
  for (const item of data.output ?? []) {
    const preview = JSON.stringify(item).substring(0, 300)
    console.log(`     • ${item.type}: ${preview}${JSON.stringify(item).length > 300 ? '...' : ''}`)
  }
  console.log(DIVIDER)

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
      console.log(`\n⚡ [TOOL CALL] ${tc.name}`)
      console.log(`   call_id: ${tc.call_id}`)
      console.log(`   args:    ${JSON.stringify(args, null, 2).split('\n').join('\n   ')}`)

      const result = await executeNativeTool(tc.name, args)

      console.log(`\n   [TOOL RESULT] → ${JSON.stringify(result)}`)

      messages.push({
        type: 'function_call_output',
        call_id: tc.call_id,
        output: JSON.stringify(result),
      })
    }
  }

  throw new Error(`Max steps (${MAX_STEPS}) reached without completing the task`)
}
