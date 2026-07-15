// ─── OpenAI ──────────────────────────────────────────────────────────────────

if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is not set')
  process.exit(1)
}

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// ─── Railway API ─────────────────────────────────────────────────────────────

export const RAILWAY_API_URL = 'https://hub.ag3nts.org/verify'
export const RAILWAY_API_KEY = '4abb691a-12aa-4546-82c5-1b6ba1c19f60'
export const RAILWAY_TASK = 'railway'

// ─── Agent ───────────────────────────────────────────────────────────────────

export const agentConfig = {
  model: 'gpt-4.1',
  instructions: `You are an autonomous agent with one goal: activate railway route X-01.

You have one tool: call_railway_api.

## Strategy
1. ALWAYS start by calling help — read the API documentation before doing anything else
2. Read every response carefully before deciding your next action
3. The API is self-documenting — the help response tells you every available action and the required sequence
4. Error messages describe exactly what went wrong and what to fix — use them

## Rate limit guardrails
- Rate limits are very restrictive — do NOT make unnecessary or exploratory calls
- Each call should have a clear reason based on what you have already read
- If a call fails with a correctable error, fix it in the next call — do not retry blindly

## Done condition
- When any API response contains a flag in the format {FLG:...} — report it to the user and stop`
}
