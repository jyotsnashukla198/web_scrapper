import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { PlaywrightCrawler, ProxyConfiguration, RequestQueue } from 'crawlee';
import { Page } from 'playwright';
import { ProductData, logError, writeToCSV } from './utils';

const HEADLESS      = process.env.HEADLESS !== 'false';
const CONCURRENCY   = parseInt(process.env.CONCURRENCY   ?? '2', 10);
const PAGE_TIMEOUT  = parseInt(process.env.PAGE_TIMEOUT  ?? '30000', 10);
const SLEEP_BASE_MS = parseInt(process.env.SLEEP_BASE_MS ?? '1500', 10);
const RETRY_COUNT   = parseInt(process.env.RETRY_COUNT   ?? '3', 10);
const SLOW_MO       = parseInt(process.env.SLOW_MO       ?? '0', 10);
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || undefined;
const PROXY_ENABLED  = process.env.PROXY_ENABLED === 'true';
const PROXIES_PATH   = path.resolve(process.cwd(), process.env.PROXIES_PATH ?? 'proxies.json');
const SKUS_PATH      = path.resolve(process.cwd(), process.env.SKUS_PATH ?? 'skus.json');

interface SKUEntry {
  Type: 'Amazon' | 'Walmart';
  SKU: string;
}

// ─── Extraction helpers (page is already loaded by Crawlee) ──────────────────
// These functions only read the DOM — they do NOT call page.goto().
// Navigation is handled by Crawlee before requestHandler fires.

async function extractAmazon(page: Page, sku: string): Promise<ProductData> {
  const title = await page
    .$eval('#productTitle', el => el.textContent?.trim() ?? '')
    .catch(() => 'N/A');

  // Multiple selector fallbacks because Amazon A/B tests its price layout frequently
  const price = await page.evaluate((): string => {
    const candidates = [
      '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
      '.priceToPay .a-offscreen',
      '#price_inside_buybox',
      '#priceblock_ourprice',
      '.a-price .a-offscreen',
    ];
    for (const sel of candidates) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return 'N/A';
  });

  const description = await page.evaluate((): string => {
    const bullets = Array.from(
      document.querySelectorAll('#feature-bullets .a-list-item')
    )
      .map(el => el.textContent?.trim())
      .filter(Boolean)
      .join('; ');
    if (bullets) return bullets;
    return document.querySelector('#productDescription')?.textContent?.trim() ?? 'N/A';
  });

  const reviewsAndRating = await page.evaluate((): string => {
    const rating = document.querySelector('#acrPopover .a-icon-alt')?.textContent?.trim()
      ?? document.querySelector('span[data-hook="rating-out-of-text"]')?.textContent?.trim()
      ?? '';
    const count = document.querySelector('#acrCustomerReviewText')?.textContent?.trim() ?? '';
    return [rating, count].filter(Boolean).join(' | ') || 'N/A';
  });

  return { sku, source: 'Amazon', title, description, price, reviewsAndRating };
}

async function extractWalmart(page: Page, sku: string): Promise<ProductData> {
  // Walmart renders the h1 after a JS hydration delay — wait for it before reading
  await page.waitForSelector('h1', { timeout: 10_000 }).catch(() => {});

  const title = await page.evaluate((): string => {
    for (const sel of ['h1[itemprop="name"]', '#main-title', 'h1.prod-ProductTitle', 'h1']) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return 'N/A';
  });

  const price = await page.evaluate((): string => {
    for (const sel of [
      '[itemprop="price"]',
      '[data-testid="price-wrap"] .price-characteristic',
      'span.price-characteristic',
      '[data-automation="buybox-price"]',
    ]) {
      const el = document.querySelector(sel);
      // Structured data in `content` attr is more reliable than visible text
      const v = el?.getAttribute('content') ?? el?.textContent?.trim();
      if (v) return v;
    }
    return 'N/A';
  });

  const description = await page.evaluate((): string => {
    for (const sel of [
      '[data-testid="product-description-content"]',
      '.about-product-description',
      '[data-automation="product-description"]',
      '#product-description',
    ]) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return 'N/A';
  });

  const reviewsAndRating = await page.evaluate((): string => {
    const rating = document.querySelector('.stars-container')?.textContent?.trim()
      ?? document.querySelector('[itemprop="ratingValue"]')?.getAttribute('content')
      ?? '';
    const count = document.querySelector('.rating-number')?.textContent?.trim()
      ?? document.querySelector('[itemprop="reviewCount"]')?.getAttribute('content')
      ?? '';
    return [rating, count].filter(Boolean).join(' | ') || 'N/A';
  });

  return { sku, source: 'Walmart', title, description, price, reviewsAndRating };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { skus }: { skus: SKUEntry[] } = JSON.parse(fs.readFileSync(SKUS_PATH, 'utf-8'));

  // Drop the request queue so every run re-scrapes all SKUs from scratch.
  // Sessions (cookies + fingerprints) are preserved separately because
  // CRAWLEE_PURGE_ON_START=false is set in .env — that env var must live in .env,
  // not in code, because Crawlee reads it at import time before main() runs.
  await (await RequestQueue.open()).drop();

  const results: ProductData[] = [];

  let proxyConfiguration: ProxyConfiguration | undefined;
  if (PROXY_ENABLED) {
    const proxyUrls = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf-8')) as string[];
    proxyConfiguration = new ProxyConfiguration({ proxyUrls });
  }

  const crawler = new PlaywrightCrawler({
    maxConcurrency: CONCURRENCY,
    maxRequestRetries: RETRY_COUNT,
    navigationTimeoutSecs: Math.floor(PAGE_TIMEOUT / 1000),
    requestHandlerTimeoutSecs: 90,

    // Crawlee injects realistic browser fingerprints (UA, screen size, WebGL,
    // canvas, plugins, etc.) per session — replaces playwright-extra stealth
    browserPoolOptions: {
      useFingerprints: true,
      fingerprintOptions: {
        fingerprintGeneratorOptions: {
          browsers: ['chrome'],
          devices: ['desktop'],
          operatingSystems: ['windows', 'macos'],
        },
      },
    },

    // Session pool keeps cookies between retries so solved challenges persist.
    // maxErrorScore raised so a manually-solved session isn't retired by Crawlee
    // just because it hit the challenge page once before the user could solve it.
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
      sessionOptions: {
        maxErrorScore: 10,
      },
    },

    launchContext: {
      launchOptions: {
        // "chrome" uses system Google Chrome (better TLS/HTTP2 fingerprint with Akamai).
        // Leave BROWSER_CHANNEL empty in .env to fall back to bundled Chromium.
        channel: BROWSER_CHANNEL as 'chrome' | undefined,
        headless: HEADLESS,
        // SLOW_MO adds a delay between every Playwright action — useful for
        // making bot-detection timing look more human during debugging
        slowMo: SLOW_MO || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
        ],
      },
    },

    proxyConfiguration,

    // Set Referer to Google so the request looks like it came from a search result
    preNavigationHooks: [
      async ({ page, request }, gotoOptions) => {
        gotoOptions.referer = 'https://www.google.com/';

        // For Walmart: visit the homepage first if this session has no Walmart cookies yet.
        // This mimics a real user landing on walmart.com before browsing to a product,
        // giving Akamai's JS sensor time to score the session before the product page loads.
        const { source } = request.userData as { source: string };
        if (source === 'Walmart') {
          const cookies = await page.context().cookies('https://www.walmart.com');
          const hasWalmartSession = cookies.some(c => c.name === 'vtc' || c.name === 'abqme');
          if (!hasWalmartSession) {
            await page.goto('https://www.walmart.com', {
              waitUntil: 'domcontentloaded',
              timeout: PAGE_TIMEOUT,
            });
            // Brief pause so the JS sensor can run on the homepage before we navigate away
            await page.waitForTimeout(2000 + Math.random() * 1000);
          }
        }
      },
    ],

    // Random jitter on top of SLEEP_BASE_MS avoids deterministic timing signatures
    postNavigationHooks: [
      async ({ page }) => {
        await page.waitForTimeout(SLEEP_BASE_MS + Math.random() * 1000);
      },
    ],

    async requestHandler({ request, page, log, session, proxyInfo }) {
      const { sku, source } = request.userData as { sku: string; source: 'Amazon' | 'Walmart' };

      if (proxyInfo) {
        log.info(`[Proxy] ${source} | ${sku} | ${proxyInfo.url}`);
      } else {
        log.info(`[Proxy] ${source} | ${sku} | no proxy`);
      }
      let html = await page.content();

      if (source === 'Amazon') {
        if (/robot check|Enter the characters you see/i.test(html)) {
          // Retire the session so the next retry gets a fresh fingerprint + new proxy IP
          session?.retire();
          throw new Error('CAPTCHA detected');
        }
        if (/Looking for something\?|Page Not Found/i.test(html))
          throw new Error('Product not found');
      } else {
        if (/Robot or human\?|Access Denied/i.test(html)) {
          if (HEADLESS) {
            // Headless mode can't solve the press-and-hold physically — rotate session
            session?.retire();
            throw new Error('Anti-bot challenge detected');
          }
          // Visible mode: let the user physically press-and-hold in the open browser window.
          // The challenge is Akamai's bot manager and cannot be automated — it measures
          // physical pressure timing that synthetic events can't replicate accurately.
          log.warning(`[Challenge] ${source} | ${sku} | Solve the "press and hold" in the browser window. Waiting up to 2 minutes...`);
          try {
            await page.waitForFunction(
              () => !/Robot or human\?|Access Denied/i.test(document.body.innerText),
              { timeout: 120_000 },
            );
            await page.waitForLoadState('domcontentloaded', { timeout: PAGE_TIMEOUT });
            html = await page.content();
            log.info(`[Challenge] ${source} | ${sku} | Solved! Continuing extraction...`);
          } catch {
            session?.retire();
            throw new Error('Anti-bot challenge not solved within 2 minutes');
          }
        }
        if (/couldn't find|page not found/i.test(html))
          throw new Error('Product not found');
      }

      const data = source === 'Amazon'
        ? await extractAmazon(page, sku)
        : await extractWalmart(page, sku);

      results.push(data);
      log.info(`[OK] ${source} | ${sku} | ${data.title.slice(0, 60)}`);
    },

    failedRequestHandler({ request }, error) {
      const { sku, source } = request.userData as { sku: string; source: string };
      logError(sku, source, error.message);
    },
  });

  const requests = skus.map(entry => ({
    url: entry.Type === 'Amazon'
      ? `https://www.amazon.com/dp/${entry.SKU}`
      : `https://www.walmart.com/ip/${entry.SKU}`,
    userData: { sku: entry.SKU, source: entry.Type },
  }));

  await crawler.run(requests);

  if (results.length > 0) {
    await writeToCSV(results);
    console.log(`\nSaved ${results.length}/${skus.length} records → ${process.env.CSV_PATH ?? 'product_data.csv'}`);
  }

  const failed = skus.length - results.length;
  if (failed > 0) console.log(`${failed} SKU(s) failed — see errors.log`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
