import OpenAI from 'openai'
import { toolDefinitions, toolHandlers } from './tools.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Generic agent loop: keeps calling OpenAI until the model stops requesting tools
// systemPrompt — instructions/context for the agent
// userMessage  — the task to start with
export async function runAgent(systemPrompt, userMessage) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ]

  console.log('Agent starting...\n')

  for (let i = 0; i < 10; i++) {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: toolDefinitions,
      tool_choice: 'auto'
    })

    const msg = response.choices[0].message
    const reason = response.choices[0].finish_reason
    messages.push(msg)

    // Model finished — no more tool calls, just a final text answer
    if (reason === 'stop') {
      console.log('\n=== Agent done ===')
      console.log(msg.content)
      return msg.content
    }

    // Model wants to call one or more tools
    if (msg.tool_calls) {
      for (const call of msg.tool_calls) {
        const name = call.function.name
        const args = JSON.parse(call.function.arguments)
        console.log(`\n[agent → tool] ${name}`, Object.keys(args).length ? args : '')

        const handler = toolHandlers[name]
        if (!handler) throw new Error(`Unknown tool: ${name}`)

        const result = await handler(args)
        console.log(`[tool → agent] ${name} returned`)

        // Tool result must be sent back as a 'tool' role message with matching tool_call_id
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        })
      }
    }
  }

  throw new Error('Agent exceeded max iterations (10)')
}
