import { run } from './src/agent.js'

console.log('=== Lesson 6 — Categorize exercise ===\n')

run(`You are a prompt engineer. Your goal is to get the flag.

Start by calling fetch_items to see what cargo needs classifying.
Then write a classification prompt template and call test_prompt to test it.
Iterate until all 10 items are correctly classified and you receive the flag.

Remember: reactor-related items must always be NEU. Put {id} and {description} at the END of your prompt template for maximum caching efficiency.`
).catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
