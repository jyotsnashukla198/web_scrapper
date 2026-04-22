# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # run scraper with ts-node (development)
npm run build          # compile TypeScript → dist/
npm start              # run compiled output
npm test               # run all Jest tests
npm run test:proxy     # verify all proxies in proxies.json before running scraper
npm run delete_queue   # drop Crawlee request queue (forces re-scrape of all SKUs next run)
npm run delete_sessions  # wipe Crawlee session store (cookies, fingerprints — fresh start)
```

Run a single test file:
```bash
npx jest src/_tests_/utils.test.ts
```

Run a single test by name:
```bash
npx jest -t "retries and succeeds on second attempt"
```

## Architecture

### Data flow

```
skus.json → PlaywrightCrawler → extractAmazon / extractWalmart → results[] → product_data.csv
                                                                           → errors.log (failures)
```

`scraper.ts` is the entry point and contains everything: crawler setup, anti-bot detection, extraction logic, and output. `utils.ts` provides the `ProductData` interface, `writeToCSV`, and `logError`. The `runConcurrent` and `retry` helpers in `utils.ts` are no longer used by the scraper (Crawlee replaced them) but are kept because the test suite covers them.

### Crawlee integration

`PlaywrightCrawler` handles browser lifecycle, concurrency, retries, and session management. Key design decisions:

- **Navigation is done by Crawlee** — `extractAmazon` / `extractWalmart` receive an already-loaded page and only extract data. They do not call `page.goto`.
- **`preNavigationHooks`** sets `Referer: https://www.google.com/` on every navigation to mimic organic search traffic.
- **`postNavigationHooks`** adds a random sleep after every page load (before `requestHandler` runs).
- **`useSessionPool: true` + `persistCookiesPerSession: true`** — each session maintains its own cookies and fingerprint across requests. When `session.retire()` is called on bot detection, Crawlee creates a fresh session (new fingerprint + new proxy IP) for the retry.
- **`sessionPoolOptions.sessionOptions.maxErrorScore: 10`** — raised from default (3) so a manually-solved Walmart session is not retired by Crawlee after the first bot challenge error.
- **`browserPoolOptions.useFingerprints: true`** — Crawlee injects realistic browser fingerprints per session (UA, WebGL, canvas, plugins).
- **`BROWSER_CHANNEL=chrome`** — uses system-installed Google Chrome instead of Playwright's bundled Chromium. Chrome has a more trusted JA3/TLS and HTTP/2 fingerprint with Akamai. Set to empty to fall back to Chromium.

### Anti-bot detection

In `requestHandler`, after page load the HTML is checked for known bot-challenge strings before extraction is attempted. On detection: `session.retire()` is called first (discards cookies), then an error is thrown to trigger Crawlee's retry with a fresh session and proxy IP.

- `"Product not found"` errors do **not** retire the session — they are legitimate responses, not blocks.
- Walmart's Akamai press-and-hold challenge: in `HEADLESS=false` mode the scraper waits up to 2 minutes for the user to solve it manually, then continues extraction. In headless mode it retires the session and throws immediately.

### Proxy

Proxy URLs are stored in `proxies.json` (git-ignored, one URL per entry). `PROXY_ENABLED=false` in `.env` disables proxies without touching the file. Proxy URLs must use **port 3128** (not 80) for HTTPS CONNECT tunneling.

Crawlee's `ProxyConfiguration` automatically handles credential parsing and assigns one proxy per session via `newUrl(sessionId)` — the same session always uses the same proxy IP for the duration of its lifetime.

`src/test-proxy.ts` (`npm run test:proxy`) tests every proxy in `proxies.json` in sequence and reports the resolved IP for each. It uses `parseProxyUrl()` to split credentials into separate `username`/`password` fields — required because Chromium doesn't reliably parse credentials embedded in the proxy URL.

### Session persistence

- `CRAWLEE_PURGE_ON_START=false` in `.env` — keeps session cookies between runs. Must be an env var (not code) because Crawlee reads it at import time before `main()` runs.
- `RequestQueue.drop()` is called explicitly at startup — ensures all SKUs are re-scraped every run while sessions are preserved.
- Use `npm run delete_sessions` to manually wipe sessions when all are blocked; use `npm run delete_queue` to force a full re-scrape without touching sessions.

### Configuration

All runtime settings come from `.env` via `dotenv/config` (loaded at module import time). Defaults are defined inline on each `process.env` read. Both `.env` and `proxies.json` are git-ignored as they contain credentials.

### CSS selector strategy

Both extractors use ordered arrays of CSS selectors with fallbacks, trying each in sequence and returning the first match. Amazon and Walmart both A/B test their layouts frequently, so multiple selectors per field are expected and intentional.
