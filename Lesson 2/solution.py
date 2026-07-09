import json
import os
import math
import requests
from openai import OpenAI

# ─── Config ───────────────────────────────────────────────────────────────────
# Set env var before running:  $env:OPENAI_API_KEY = "sk-..."
# Or paste your key directly below.
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', 'YOUR_OPENAI_KEY_HERE')
if OPENAI_API_KEY == 'YOUR_OPENAI_KEY_HERE':
    raise SystemExit('❌ Set your OpenAI key: edit solution.py or run: export OPENAI_API_KEY="sk-..."')
COURSE_API_KEY = os.environ.get('COURSE_API_KEY', '4abb691a-12aa-4546-82c5-1b6ba1c19f60')

BASE_URL = 'https://hub.ag3nts.org'
MAX_ITERATIONS = 15

client = OpenAI(api_key=OPENAI_API_KEY)

# ─── Suspects (from Lesson 1) ─────────────────────────────────────────────────
suspects = [
    {'name': 'Cezary',   'surname': 'Żurek',    'gender': 'M', 'born': 1987, 'city': 'Grudziądz', 'tags': ['transport']},
    {'name': 'Jacek',    'surname': 'Nowak',     'gender': 'M', 'born': 1991, 'city': 'Grudziądz', 'tags': ['transport', 'praca z ludźmi']},
    {'name': 'Oskar',    'surname': 'Sieradzki', 'gender': 'M', 'born': 1993, 'city': 'Grudziądz', 'tags': ['transport']},
    {'name': 'Wojciech', 'surname': 'Bielik',    'gender': 'M', 'born': 1986, 'city': 'Grudziądz', 'tags': ['transport']},
    {'name': 'Wacław',   'surname': 'Jasiński',  'gender': 'M', 'born': 1986, 'city': 'Grudziądz', 'tags': ['transport']},
]
print(f"Loaded {len(suspects)} suspects: {', '.join(s['name'] + ' ' + s['surname'] for s in suspects)}")

# ─── Power plants (fetched at runtime from Hub) ───────────────────────────────
# Approximate city-center GPS coordinates for proximity matching.
# The Hub response has no coordinates — we supply them so Python can do the math.
CITY_COORDS = {
    'Zabrze':               (50.3249, 18.7857),
    'Piotrków Trybunalski': (51.4047, 19.7030),
    'Grudziądz':            (53.4838, 18.7536),
    'Tczew':                (53.7831, 18.7766),
    'Radom':                (51.4027, 21.1471),
    'Chelmno':              (53.3494, 18.4261),
    'Żarnowiec':            (54.7047, 18.1258),
}

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(d_lon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def fetch_power_plants() -> list:
    url = f'{BASE_URL}/data/{COURSE_API_KEY}/findhim_locations.json'
    resp = requests.get(url, timeout=10)
    if not resp.ok:
        raise RuntimeError(f'Failed to fetch power plants: {resp.status_code} {url}')
    data = resp.json()
    plants = data.get('power_plants', data)
    return [
        {'city': city, 'code': info['code'], 'is_active': info.get('is_active', True),
         'lat': CITY_COORDS.get(city, (None, None))[0],
         'lng': CITY_COORDS.get(city, (None, None))[1]}
        for city, info in plants.items()
    ]

power_plants = fetch_power_plants()
print(f"Loaded {len(power_plants)} power plants: {', '.join(p['city'] for p in power_plants)}")

# ─── Tool implementations ─────────────────────────────────────────────────────

def get_person_locations(name: str, surname: str) -> dict:
    """
    Fetches tracked GPS locations for a suspect and computes which power plant
    they were closest to. Returns the nearest plant city and code directly.
    """
    resp = requests.post(
        f'{BASE_URL}/api/location',
        json={'apikey': COURSE_API_KEY, 'name': name, 'surname': surname},
        timeout=10
    )
    if not resp.ok:
        return {'error': f'Location API returned {resp.status_code}'}

    data = resp.json()
    locations = data if isinstance(data, list) else data.get('locations', data.get('data', []))

    if not locations:
        return {'name': name, 'surname': surname, 'message': 'No location data found.'}

    # For every tracked location, find the nearest power plant
    closest_plant = None
    min_dist_km = float('inf')

    for loc in locations:
        lat = loc.get('lat') or loc.get('latitude')
        lng = loc.get('lng') or loc.get('lon') or loc.get('longitude')
        if lat is None or lng is None:
            continue
        for plant in power_plants:
            if plant['lat'] is None:
                continue
            dist = haversine_km(lat, lng, plant['lat'], plant['lng'])
            if dist < min_dist_km:
                min_dist_km = dist
                closest_plant = plant

    return {
        'name': name,
        'surname': surname,
        'location_count': len(locations),
        'closest_power_plant_city': closest_plant['city'] if closest_plant else None,
        'closest_power_plant_code': closest_plant['code'] if closest_plant else None,
        'distance_km': round(min_dist_km, 2) if closest_plant else None,
    }


def get_access_level(name: str, surname: str, birth_year: int) -> dict:
    """Fetches the security access level for a confirmed suspect."""
    resp = requests.post(
        f'{BASE_URL}/api/accesslevel',
        json={'apikey': COURSE_API_KEY, 'name': name, 'surname': surname, 'birthYear': birth_year},
        timeout=10
    )
    if not resp.ok:
        return {'error': f'Access level API returned {resp.status_code}'}
    return resp.json()


def submit_answer(name: str, surname: str, access_level: int, power_plant: str) -> dict:
    """Submits a suspect to the verification endpoint and returns whether they were correct."""
    payload = {
        'apikey': COURSE_API_KEY,
        'task': 'findhim',
        'answer': {
            'name': name,
            'surname': surname,
            'accessLevel': access_level,
            'powerPlant': power_plant
        }
    }
    print(f'\n📤 Submitting: {json.dumps(payload["answer"])}')
    resp = requests.post(f'{BASE_URL}/verify', json=payload, timeout=10)
    result = resp.json()
    # Add a clear success/failure signal so the LLM can decide whether to continue
    result['_submitted'] = {'name': name, 'surname': surname}
    result['_hint'] = 'If this was wrong, try the next suspect ranked closest to a power plant.'
    return result


# ─── Tool dispatch map ────────────────────────────────────────────────────────
TOOL_HANDLERS = {
    'get_person_locations': lambda args: get_person_locations(args['name'], args['surname']),
    'get_access_level':     lambda args: get_access_level(args['name'], args['surname'], args['birthYear']),
    'submit_answer':        lambda args: submit_answer(args['name'], args['surname'], args['accessLevel'], args['powerPlant']),
}

# ─── Tool definitions (JSON Schema) passed to the LLM ────────────────────────
tools = [
    {
        'type': 'function',
        'function': {
            'name': 'get_person_locations',
            'description': (
                'Fetches all tracked GPS locations for a suspect and returns which power plant '
                'they were closest to, including the exact plant code. '
                'Use the returned closest_power_plant_code when submitting the answer for this person.'
            ),
            'parameters': {
                'type': 'object',
                'properties': {
                    'name':    {'type': 'string', 'description': "Suspect's first name"},
                    'surname': {'type': 'string', 'description': "Suspect's surname"},
                },
                'required': ['name', 'surname'],
                'additionalProperties': False
            }
        }
    },
    {
        'type': 'function',
        'function': {
            'name': 'get_access_level',
            'description': (
                'Retrieves the security access level of a suspect. '
                'Only call this after identifying which suspect was near a power plant.'
            ),
            'parameters': {
                'type': 'object',
                'properties': {
                    'name':      {'type': 'string'},
                    'surname':   {'type': 'string'},
                    'birthYear': {'type': 'integer', 'description': 'Year of birth, e.g. 1987'}
                },
                'required': ['name', 'surname', 'birthYear'],
                'additionalProperties': False
            }
        }
    },
    {
        'type': 'function',
        'function': {
            'name': 'submit_answer',
            'description': (
                'Submits a suspect as the answer to the verification endpoint. '
                'If the response indicates failure, move on to the next suspect '
                'ranked closest to a power plant and try again with their data.'
            ),
            'parameters': {
                'type': 'object',
                'properties': {
                    'name':        {'type': 'string'},
                    'surname':     {'type': 'string'},
                    'accessLevel': {'type': 'integer'},
                    'powerPlant':  {'type': 'string', 'description': 'Power plant code, e.g. PWR7264PL'}
                },
                'required': ['name', 'surname', 'accessLevel', 'powerPlant'],
                'additionalProperties': False
            }
        }
    }
]

# ─── Agent loop ───────────────────────────────────────────────────────────────
def run_agent():
    suspect_list = '\n'.join(
        f"- {s['name']} {s['surname']}, born {s['born']}"
        for s in suspects
    )

    messages = [
        {
            'role': 'system',
            'content': (
                'You are an investigative agent. Find which suspect was tracked near a nuclear power plant.\n\n'
                f'Suspects:\n{suspect_list}\n\n'
                'Each suspect\'s location response already includes closest_power_plant_city, '
                'closest_power_plant_code, and distance_km — Python has done the matching for you.\n\n'
                'Strategy:\n'
                '1. Call get_person_locations for EVERY suspect.\n'
                '2. Rank suspects by distance_km (smallest = closest to a plant).\n'
                '3. Starting with the closest: call get_access_level using their birth year.\n'
                '4. Call submit_answer using their closest_power_plant_code from step 1.\n'
                '5. If the hub returns failure, try the next suspect in your ranked list.\n'
                '6. Continue until you receive a success response.\n\n'
                'Important: birthYear must be an integer. Use the exact power plant code from the location response.'
            )
        },
        {
            'role': 'user',
            'content': 'Start the investigation. Check all suspects and submit the answer, retrying with the next candidate if needed.'
        }
    ]

    for i in range(MAX_ITERATIONS):
        print(f'\n─── Agent iteration {i + 1}/{MAX_ITERATIONS} ───')

        response = client.chat.completions.create(
            model='gpt-4o-mini',
            messages=messages,
            tools=tools,
            tool_choice='auto'
        )

        msg = response.choices[0].message
        messages.append(msg)

        if not msg.tool_calls:
            # Agent gave a final text response — done
            print(f'\n🤖 Agent: {msg.content}')
            break

        for call in msg.tool_calls:
            args = json.loads(call.function.arguments)
            print(f'  🔧 {call.function.name}({args})')

            handler = TOOL_HANDLERS.get(call.function.name)
            result = handler(args) if handler else {'error': f'Unknown tool: {call.function.name}'}

            print(f'     ↳ {json.dumps(result)[:200]}')

            if call.function.name == 'submit_answer':
                print(f'\n{"✅" if result.get("code") == 0 or "flag" in str(result).lower() else "❌"} Verification result: {json.dumps(result, indent=2)}')

            messages.append({
                'role': 'tool',
                'tool_call_id': call.id,
                'content': json.dumps(result)
            })

# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('\n🕵️  Starting agent...\n')
    run_agent()
