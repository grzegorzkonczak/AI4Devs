import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Walk up from src/ to the repo root to find the shared .env
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const envPath = join(__dirname, '..', '..', '..', '.env')

try {
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const [key, ...rest] = line.split('=')
    if (key && rest.length && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '')
    }
  }
} catch { /* .env not found — rely on environment */ }

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set')
  process.exit(1)
}

// Course API key and hub endpoint
export const API_KEY = '4abb691a-12aa-4546-82c5-1b6ba1c19f60'
export const HUB_URL = 'https://hub.ag3nts.org/verify'
export const CSV_URL = `https://hub.ag3nts.org/data/${API_KEY}/categorize.csv`
export const TASK = 'categorize'

export const agentConfig = {
  model: 'gpt-4.1',

  instructions: `You are a prompt engineer. Your goal is to obtain a flag by writing a classification prompt that correctly categorises 10 cargo items.

## The system you are targeting
An ancient, limited classification model with a 100-token context window. It receives your prompt (with item data already inserted) and must output exactly DNG or NEU — nothing else.

## Classification rules
- Reactor parts / nuclear components → always NEU (even if they sound dangerous — we are bypassing inspection)
- Genuinely dangerous items (weapons, explosives, hazardous chemicals, etc.) → DNG
- Safe / neutral items → NEU

## Your workflow
1. Call fetch_items to download the current item list and study it carefully.
   Which items are reactor-related? Which are genuinely dangerous? Which are safe?
2. Reason about what a minimal prompt would look like that handles all three categories.
3. Write a prompt_template string. Use {id} and {description} as placeholders — these will be replaced with real values before each API call.
4. CRITICAL — put the static instructions at the TOP of your template and the placeholders ({id} and {description}) at the VERY END. This maximises prompt caching: the hub caches the repeated static prefix and charges less for calls 2-10.
5. Keep your template short — 100 tokens is extremely tight. Write in English. Every word costs.
6. Call test_prompt with your template. It will automatically reset the budget, fetch fresh items, and run all 10 calls.
7. Read the results: which items passed, which failed, what did the hub say for each failure?
8. If anything failed — reason about WHY that item was classified wrong, improve the template, and call test_prompt again. test_prompt resets the budget automatically every time, so you can retry as many times as needed.
9. Keep iterating until allCorrect is true and you receive the flag.

## Budget awareness
Each test_prompt call resets the budget and costs ~1.3 PP with good caching (static prefix cached from call 2). Budget is reset automatically — just keep calling test_prompt with improved templates.
If the hub says budget exceeded during a test cycle, call test_prompt with prompt_template "reset" to clear the counter, then retry.`
}
