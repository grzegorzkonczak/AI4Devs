import { runAgent } from './agent.js'

// System prompt: gives the agent all the SPK rules and the exact declaration format.
// The agent will use these rules to fill in the blanks correctly.
const systemPrompt = `You are an SPK (System Przesyłek Konduktorskich) declaration specialist.
Your job: read the blocked routes image to find the correct route code, then fill and submit the declaration.

## SPK Categories
- A (Strategic): 0 PP, paid by System. Covers reactor fuel, critical infrastructure. Can use BLOCKED routes.
- B, C, D, E: other categories (not relevant here)

## Wagon rules
- Standard shipment includes 2 wagons × 500 kg = 1000 kg capacity
- Each additional wagon adds 500 kg capacity
- WDP = number of ADDITIONAL wagons beyond the standard 2
- For Category A: additional wagons are free, but you still declare the correct WDP count

## Declaration format — fill EXACTLY like this, no extra text before or after:
SYSTEM PRZESYŁEK KONDUKTORSKICH - DEKLARACJA ZAWARTOŚCI
======================================================
DATA: [YYYY-MM-DD]
PUNKT NADAWCZY: [city]
------------------------------------------------------
NADAWCA: [sender ID]
PUNKT DOCELOWY: [city]
TRASA: [route code]
------------------------------------------------------
KATEGORIA PRZESYŁKI: [A/B/C/D/E]
------------------------------------------------------
OPIS ZAWARTOŚCI (max 200 znaków): [description]
------------------------------------------------------
DEKLAROWANA MASA (kg): [weight]
------------------------------------------------------
WDP: [number]
------------------------------------------------------
UWAGI SPECJALNE: [notes or leave blank]
------------------------------------------------------
KWOTA DO ZAPŁATY: [amount] PP
------------------------------------------------------
OŚWIADCZAM, ŻE PODANE INFORMACJE SĄ PRAWDZIWE.
BIORĘ NA SIEBIE KONSEKWENCJĘ ZA FAŁSZYWE OŚWIADCZENIE.
======================================================

## Steps to follow
1. Call read_blocked_routes to get route codes from the image
2. Find the route code for Gdańsk → Żarnowiec
3. Calculate WDP: shipment is 2800 kg. Standard = 1000 kg (2 wagons). Extra needed: ceil((2800-1000)/500) = 4
4. Fill and submit the declaration using these known values:
   - DATA: 2026-07-09
   - PUNKT NADAWCZY: Gdańsk
   - NADAWCA: 450202122
   - PUNKT DOCELOWY: Żarnowiec
   - TRASA: [from image]
   - KATEGORIA PRZESYŁKI: A
   - OPIS ZAWARTOŚCI: kasety z paliwem do reaktora jądrowego
   - DEKLAROWANA MASA: 2800
   - WDP: 4
   - UWAGI SPECJALNE: (leave blank)
   - KWOTA DO ZAPŁATY: 0 PP
5. Report the full hub response — especially any flag or confirmation code`

await runAgent(
  systemPrompt,
  'Fill out and submit the SPK declaration for the reactor fuel cassettes from Gdańsk to Żarnowiec.'
)
