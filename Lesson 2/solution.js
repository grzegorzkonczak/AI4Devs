'use strict'

const fs = require('fs')
const path = require('path')
const { OpenAI } = require('openai')

// ─── Config ──────────────────────────────────────────────────────────────────
// Replace placeholders with real values, or set env vars before running:
//   $env:OPENAI_API_KEY  = "sk-..."
//   $env:COURSE_API_KEY  = "your-hub-key"
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'YOUR_OPENAI_KEY_HERE'
const COURSE_API_KEY = process.env.COURSE_API_KEY || '4abb691a-12aa-4546-82c5-1b6ba1c19f60'

const BASE_URL = 'https://hub.ag3nts.org'
const MAX_ITERATIONS = 15
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// ─── Load suspects from Lesson 1 ─────────────────────────────────────────────
// The file is JSON objects separated by commas, missing the outer [ ].
const rawSuspects = fs.readFileSync(
  path.join(__dirname, '../Lesson 1/JSON with suspects.txt'),
  'utf8'
)
const suspects = JSON.parse('[' + rawSuspects + ']')
console.log(`Loaded ${suspects.length} suspects:`, suspects.map(s => `${s.name} ${s.surname}`).join(', '))

// ─── Haversine distance (km) between two GPS coords ──────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ─── Fetch power plant locations (with GPS coords) from Hub ──────────────────
async function fetchPowerPlantLocations() {
  const url = `${BASE_URL}/data/${COURSE_API_KEY}/findhim_locations.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch power plant locations: ${res.status} ${url}`)
  const data = await res.json()
  console.log('Power plant data structure (raw):', JSON.stringify(data).slice(0, 300))
  return data
}

// ─── Tool implementations ─────────────────────────────────────────────────────

// Gets a person's tracked locations and enriches with nearest power plant info.
// powerPlants: raw data from findhim_locations.json
async function getPersonLocations(name, surname, powerPlants) {
  const res = await fetch(`${BASE_URL}/api/location`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: COURSE_API_KEY, name, surname })
  })
  if (!res.ok) return { error: `Location API returned ${res.status}` }

  const data = await res.json()

  // Normalize location list — API may return array directly or nested under a key
  const locationList = Array.isArray(data) ? data : (data.locations || data.data || [])

  if (!locationList.length) {
    return { name, surname, message: 'No location data found for this person.' }
  }

  // Find which power plant each location is closest to
  // powerPlants may be an object keyed by city name or an array — handle both
  const plants = Array.isArray(powerPlants)
    ? powerPlants
    : Object.entries(powerPlants).map(([city, info]) => ({ city, ...info }))

  let closestPlant = null
  let minDistKm = Infinity

  for (const loc of locationList) {
    const lat = loc.lat ?? loc.latitude
    const lng = loc.lng ?? loc.lon ?? loc.longitude
    if (lat == null || lng == null) continue

    for (const plant of plants) {
      const pLat = plant.lat ?? plant.latitude
      const pLng = plant.lng ?? plant.lon ?? plant.longitude
      if (pLat == null || pLng == null) continue

      const dist = haversineKm(lat, lng, pLat, pLng)
      if (dist < minDistKm) {
        minDistKm = dist
        closestPlant = { city: plant.city || plant.name, code: plant.code, distanceKm: +dist.toFixed(3) }
      }
    }
  }

  return {
    name,
    surname,
    locationsCount: locationList.length,
    closestPowerPlant: closestPlant,
    note: closestPlant
      ? `Closest plant is ${closestPlant.city} (${closestPlant.code}) at ${closestPlant.distanceKm} km`
      : 'Could not compute proximity — check power plant data format.'
  }
}

// Gets the security access level for a confirmed suspect.
async function getAccessLevel(name, surname, birthYear) {
  const res = await fetch(`${BASE_URL}/api/accesslevel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: COURSE_API_KEY, name, surname, birthYear })
  })
  if (!res.ok) return { error: `Access level API returned ${res.status}` }
  return res.json()
}

// Submits the final answer to /verify.
async function submitAnswer(name, surname, accessLevel, powerPlant) {
  const payload = {
    apikey: COURSE_API_KEY,
    task: 'findhim',
    answer: { name, surname, accessLevel, powerPlant }
  }
  console.log('\n📤 Submitting answer:', JSON.stringify(payload.answer))
  const res = await fetch(`${BASE_URL}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return res.json()
}

// ─── Tool definitions (JSON Schema) passed to the LLM ────────────────────────
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_person_locations',
      description: 'Fetches all known GPS locations for a suspect and returns which power plant they were closest to and the distance in km. Call this for every suspect to find who was near a facility.',
      parameters: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: "Suspect's first name" },
          surname: { type: 'string', description: "Suspect's surname" }
        },
        required: ['name', 'surname'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_access_level',
      description: 'Retrieves the security access level of a suspect. Only call this after you have identified the specific suspect who was near a power plant.',
      parameters: {
        type: 'object',
        properties: {
          name:      { type: 'string' },
          surname:   { type: 'string' },
          birthYear: { type: 'integer', description: 'Year of birth as an integer, e.g. 1987' }
        },
        required: ['name', 'surname', 'birthYear'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'submit_answer',
      description: 'Submits the final report to the verification endpoint. Call this exactly once after you have the suspect name, their access level, and the power plant code (format: PWR0000PL).',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string' },
          surname:     { type: 'string' },
          accessLevel: { type: 'integer' },
          powerPlant:  { type: 'string', description: 'Power plant code, e.g. PWR1234PL' }
        },
        required: ['name', 'surname', 'accessLevel', 'powerPlant'],
        additionalProperties: false
      }
    }
  }
]

// ─── Agent loop ───────────────────────────────────────────────────────────────
async function runAgent(powerPlants) {
  const suspectList = suspects
    .map(s => `- ${s.name} ${s.surname}, born ${s.born}`)
    .join('\n')

  const messages = [
    {
      role: 'system',
      content: `You are an investigative agent. Your mission: identify which suspect was seen near a nuclear power plant.

Suspects:
${suspectList}

Steps to follow:
1. Call get_person_locations for EVERY suspect on the list.
2. Compare results — find the suspect with the smallest distance to any power plant.
3. Call get_access_level for that suspect using their birth year from the list above.
4. Call submit_answer with: name, surname, accessLevel, and the power plant code (format PWR0000PL).

Rules: use birthYear as an integer. Submit only once. Do not skip any suspect when collecting locations.`
    },
    {
      role: 'user',
      content: 'Start the investigation. Check all suspects and submit the final answer.'
    }
  ]

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`\n─── Agent iteration ${i + 1}/${MAX_ITERATIONS} ───`)

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools,
      tool_choice: 'auto'
    })

    const msg = response.choices[0].message
    messages.push(msg)

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Agent gave a final text response — done
      console.log('\n🤖 Agent final response:', msg.content)
      break
    }

    // Execute each tool the agent requested
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments)
      console.log(`  🔧 ${call.function.name}(${JSON.stringify(args)})`)

      let result
      switch (call.function.name) {
        case 'get_person_locations':
          result = await getPersonLocations(args.name, args.surname, powerPlants)
          break
        case 'get_access_level':
          result = await getAccessLevel(args.name, args.surname, args.birthYear)
          break
        case 'submit_answer':
          result = await submitAnswer(args.name, args.surname, args.accessLevel, args.powerPlant)
          console.log('\n✅ Verification result:', JSON.stringify(result))
          break
        default:
          result = { error: `Unknown tool: ${call.function.name}` }
      }

      console.log(`     ↳`, JSON.stringify(result))

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result)
      })
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n📡 Fetching power plant locations from Hub...')
  const powerPlants = await fetchPowerPlantLocations()

  console.log(`\n🕵️  Starting agent with ${suspects.length} suspects...\n`)
  await runAgent(powerPlants)
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
