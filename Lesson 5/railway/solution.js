/**
 * Lesson 5 — Railway exercise
 * Goal: activate route X-01
 *
 * An agent with one tool (call_railway_api) reasons about the self-documenting
 * API from its help response and executes the required sequence autonomously.
 */

import { run } from './src/agent.js'

const main = async () => {
  console.log('=== Railway exercise — agentic approach ===')
  await run('Activate railway route X-01. Use the call_railway_api tool.')
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
