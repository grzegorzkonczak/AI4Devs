/**
 * Network mechanics — a POST helper that retries on rate limits.
 *
 * Retrying on 429/503 is pure mechanics (the course explicitly allows retry
 * loops on 429/503). It makes NO decisions about the task; it just keeps a
 * transient, provably-retryable failure from surfacing as a fake result. As a
 * side effect it self-paces our requests to the provider's per-minute limit.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pulls "try again in 1.502s" style hints out of an error message, in ms. */
const parseRetryHintMs = (message) => {
  if (typeof message !== "string") return null;
  const s = message.match(/try again in ([\d.]+)\s*s/i);
  if (s) return Math.ceil(parseFloat(s[1]) * 1000);
  const ms = message.match(/try again in ([\d.]+)\s*ms/i);
  if (ms) return Math.ceil(parseFloat(ms[1]));
  return null;
};

/**
 * POSTs JSON and parses JSON back, retrying on 429/503 (and on OpenAI's
 * rate-limit error payloads) with backoff.
 *
 * @returns {Promise<object>} parsed JSON body (throws only on non-retryable API errors)
 */
export const postJson = async (url, headers, body, { retries = 8, baseDelay = 800 } = {}) => {
  let lastData = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    lastData = data;

    const rateLimited =
      res.status === 429 ||
      res.status === 503 ||
      (data?.error && /rate limit/i.test(data.error.message || ""));

    if (!rateLimited) return data;

    if (attempt < retries) {
      const hint = parseRetryHintMs(data?.error?.message);
      const backoff = baseDelay * 2 ** attempt;
      const wait = Math.min((hint ?? backoff) + 150, 20000);
      await sleep(wait);
    }
  }

  return lastData; // exhausted retries — return the last (error) body for the caller to see
};
