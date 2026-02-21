/**
 * Rate-limited HTTP client for Ukrainian legislation from zakon.rada.gov.ua.
 *
 * Portal:
 *   - Law text: https://zakon.rada.gov.ua/laws/show/{REF}/print
 *   - Metadata (English UI): https://zakon.rada.gov.ua/laws/show/{REF}?lang=en
 *
 * Requirements:
 *   - 1-2 second delay between requests to government servers
 *   - Retries for transient failures
 */

const USER_AGENT =
  'Ansvar-Law-MCP/1.0 (+https://github.com/Ansvar-Systems/Ukrainian-law-mcp)';
const MIN_DELAY_MS = 1200;

let lastRequestTime = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
  url: string;
}

/**
 * Fetch a page from zakon.rada.gov.ua with retries for 429/5xx/network errors.
 */
export async function fetchWithRateLimit(
  url: string,
  maxRetries = 2,
): Promise<FetchResult> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    await enforceRateLimit();

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'uk,en;q=0.8',
        },
        redirect: 'follow',
      });

      const body = await response.text();
      const result: FetchResult = {
        status: response.status,
        body,
        contentType: response.headers.get('content-type') ?? '',
        url: response.url,
      };

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const backoff = 1000 * Math.pow(2, attempt);
          await sleep(backoff);
          attempt++;
          continue;
        }
      }

      return result;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const backoff = 1000 * Math.pow(2, attempt);
        await sleep(backoff);
        attempt++;
        continue;
      }
    }

    attempt++;
  }

  throw new Error(
    `Failed to fetch ${url} after ${maxRetries + 1} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
