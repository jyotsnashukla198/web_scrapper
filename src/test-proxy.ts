import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';

const PROXIES_PATH = path.resolve(process.cwd(), process.env.PROXIES_PATH ?? 'proxies.json');
const TIMEOUT      = 20_000;
const IP_CHECK     = 'https://api.ipify.org?format=json';

// Chromium doesn't reliably parse credentials embedded in the proxy URL string,
// so we split them into separate fields that the launch options accept explicitly.
function parseProxyUrl(raw: string) {
  const url = new URL(raw);
  return {
    server:   `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

async function getIP(proxyRaw?: string): Promise<string> {
  const proxy = proxyRaw ? parseProxyUrl(proxyRaw) : undefined;
  const browser = await chromium.launch({
    headless: true,
    ...(proxy ? { proxy } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto(IP_CHECK, { timeout: TIMEOUT });
    const body = await page.evaluate(() => document.body.innerText.trim());
    try {
      return JSON.parse(body).ip;
    } catch {
      throw new Error(`Unexpected response: "${body.slice(0, 80)}"`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('--- Proxy Test ---\n');

  const realIP = await getIP().catch(err => {
    console.error('Failed to get real IP:', err.message);
    process.exit(1);
  });
  console.log(`Real IP:  ${realIP}\n`);

  if (!fs.existsSync(PROXIES_PATH)) {
    console.log(`proxies.json not found at ${PROXIES_PATH} — skipping proxy check.`);
    return;
  }

  const proxyUrls = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf-8')) as string[];
  console.log(`Testing ${proxyUrls.length} proxies from ${PROXIES_PATH}\n`);

  let passed = 0;
  for (const url of proxyUrls) {
    const { server, username } = parseProxyUrl(url);
    process.stdout.write(`  ${server} (${username}) ... `);
    try {
      const proxyIP = await getIP(url);
      const working = proxyIP !== realIP;
      console.log(`${proxyIP}  ${working ? 'OK' : 'WARN: same IP as real — not routing'}`);
      if (working) passed++;
    } catch (err) {
      // Most common causes when curl works but Playwright fails:
      //   1. Webshare IP allowlist — add your real IP at webshare.io → Proxy → IP Allowlist
      //   2. Wrong port — needs port 3128+ for HTTPS CONNECT (port 80 handles HTTP only)
      //   3. Stale credentials — verify on webshare.io dashboard
      console.log(`FAILED — ${(err as Error).message}`);
    }
  }

  console.log(`\n${passed}/${proxyUrls.length} proxies working.`);
  if (passed < proxyUrls.length) {
    console.log('\nIf proxies fail: add your real IP', realIP, 'to webshare.io → Proxy → IP Allowlist');
  }
}

main();
