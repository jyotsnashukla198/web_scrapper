# Scraper Development Journey

A chronological record of every approach tried, what it was meant to solve, and what happened.

---

## Anti-Bot & Stealth

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 1 | Manual `User-Agent` header string | Basic UA detection | Worked for simple sites; not enough for Amazon/Walmart |
| 2 | `user-agents` npm package | Randomise UA per request | Added realistic UAs but didn't handle fingerprint signals beyond the header |
| 3 | `playwright-extra` stealth plugin | Mask `navigator.webdriver`, canvas, plugins | Helped with basic bot checks; not effective against Akamai |
| 4 | Migrated to **Crawlee** `PlaywrightCrawler` | Replace all manual stealth code | Crawlee injects full browser fingerprints (UA, WebGL, canvas, screen, plugins) per session — replaced stealth plugin and `user-agents` package entirely |
| 5 | `browserPoolOptions.useFingerprints: true` | Realistic fingerprint per session | Each session gets a unique, consistent fingerprint; Crawlee handles rotation automatically |

---

## Proxy Setup

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 6 | No proxy (direct IP) | — | Amazon worked; Walmart blocked immediately |
| 7 | Webshare rotating proxy — port **80** | Mask real IP | `ERR_PROXY_CONNECTION_FAILED` — port 80 only handles HTTP, not HTTPS CONNECT tunneling |
| 8 | Webshare rotating proxy — port **3128** | HTTPS CONNECT tunneling | Connectivity fixed; proxy working (confirmed via `npm run test:proxy`) |
| 9 | Sticky session via username format (`cvtaqxhe-rotate-session-ID`) | Keep same IP per session | Webshare rejected the modified username format — `ERR_TUNNEL_CONNECTION_FAILED` |
| 10 | Reverted to simple `proxyUrls` array | Drop sticky username hack | Rotating proxy worked but gave a new IP every request — no session stickiness |
| 11 | Static residential proxies (`proxies.json`) | True IP stickiness per session | Each session gets a fixed IP; Crawlee's `proxyConfiguration.newUrl(sessionId)` assigns and locks the mapping automatically |

---

## Session Management

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 12 | `useSessionPool: true` + `persistCookiesPerSession: true` | Reuse browser session across retries | Sessions persist cookies; same session → same proxy IP → same fingerprint within a run |
| 13 | `CRAWLEE_PURGE_ON_START=false` in `.env` | Keep solved session cookies between runs | Sessions survive restarts; Walmart cookies from a solved challenge carried over *(note: must be in `.env`, not code — Crawlee reads this at import time)* |
| 14 | Explicit `RequestQueue.drop()` at startup | SKUs being skipped because queue from previous run still existed | Fixed — queue wiped on every run; session store preserved separately |
| 15 | `npm run delete_queue` / `npm run delete_sessions` scripts | Manual control over what gets wiped | Clean alternative to `CRAWLEE_PURGE_ON_START=true`; purge only what you need |

---

## Walmart Bot Detection (Akamai)

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 16 | `session.retire()` on challenge detection | Force new fingerprint + proxy IP on retry | Correct pattern for headless mode; Crawlee creates a fresh session on next retry |
| 17 | `page.waitForFunction()` — wait for challenge to clear | Manual press-and-hold in visible mode | Works — user solves the challenge in the open browser window; scraper continues automatically |
| 18 | `HEADLESS=false` + manual press-and-hold | Unblockable Akamai challenge | Most reliable current approach; Akamai validates physical press timing that automation can't replicate |
| 19 | Static residential proxies (higher reputation) | Rotating IPs flagged by Akamai | Akamai still shows challenge — IP reputation alone isn't the deciding factor; JS sensor data and behavioral signals matter more |
| 20 | Switched to US-based static residential proxies | Non-US IPs (Germany, UK) scoring as higher risk for a US retailer | Same Akamai press-and-hold challenge — geolocation was not the root cause; Webshare IP ranges are flagged in Akamai's threat database regardless of country |
| 21 | `channel: 'chrome'` via `BROWSER_CHANNEL=chrome` env var — real Google Chrome instead of Playwright's Chromium | Chromium's JA3 and HTTP/2 fingerprints are known to Akamai | Pending — real Chrome has a far more common TLS fingerprint (billions of legitimate users) vs Chromium's recognisable scraper fingerprint |
| 22 | Visit `walmart.com` homepage before product URL — in `preNavigationHooks`, if session has no Walmart cookies (`vtc`/`abqme`) navigate to homepage first with a 2–3s pause, then Crawlee proceeds to the product URL | Direct deep-link to product page is a strong bot signal; Akamai's JS sensor has no prior session data to score | **Working** — homepage visit lets Akamai's JS sensor score the session before the product page loads; press-and-hold challenge no longer appears |

---

## Infrastructure & Config

| # | Approach | Problem it solved | Outcome |
|---|---|---|---|
| 20 | `.env` file for all runtime config | Hard-coded values | All settings (headless, proxy, concurrency, timeouts, paths) externalised |
| 21 | `SLOW_MO` env var | Make browser actions look human during debugging | Useful at 50–150ms for debugging; keep at `0` for production |
| 22 | `parseProxyUrl()` in `test-proxy.ts` | Chromium doesn't parse credentials embedded in proxy URL reliably | Split into `server` / `username` / `password` fields; Crawlee's `ProxyConfiguration` handles this internally so only needed in the test script |
| 23 | `proxies.json` (git-ignored) | Store list of static proxy URLs outside code | Clean separation of credentials from code; loaded at runtime |
| 24 | `postNavigationHooks` random jitter | Fixed sleep timing is a bot signal | `SLEEP_BASE_MS + random * 1000ms` after every page load |
| 25 | `preNavigationHooks` — `gotoOptions.referer = 'https://www.google.com/'` | Direct deep-link navigation is a strong bot signal; real users arrive via Google | Did not work — Akamai challenge still shown; IP reputation and JS sensor score outweigh the referrer header |

---

## Current State

| Layer | Solution in use |
|---|---|
| Browser automation | Crawlee `PlaywrightCrawler` |
| Fingerprinting | Crawlee `useFingerprints: true` (Chrome, desktop, Windows/macOS) |
| Proxy | Static residential IPs from `proxies.json` |
| Session stickiness | Crawlee session pool + `proxyConfiguration.newUrl(sessionId)` (automatic) |
| Cookie persistence | `persistCookiesPerSession: true` + `CRAWLEE_PURGE_ON_START=false` |
| Walmart bot bypass | `HEADLESS=false` + manual press-and-hold; `session.retire()` in headless mode |
| Amazon bot bypass | Session retire + retry on CAPTCHA detection |
| Output | `product_data.csv` (append mode), `errors.log` |
