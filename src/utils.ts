import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { createObjectCsvWriter } from 'csv-writer';

export interface ProductData {
    sku: string;
    source: string;
    title:string;
    price:string;
    description:string;
    reviewsAndRating:string;
}

const ERROR_LOG = path.resolve(process.cwd(), process.env.ERROR_LOG ?? 'errors.log');
const CSV_PATH  = path.resolve(process.cwd(), process.env.CSV_PATH  ?? 'product_data.csv');

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function logError(sku: string, source: string, message: string): void {
  const line = `[${new Date().toISOString()}] SKU: ${sku} | Source: ${source} | Error: ${message}\n`;
  // appendFileSync so partial runs don't wipe earlier failures
  fs.appendFileSync(ERROR_LOG, line, 'utf-8');
  console.error(line.trimEnd());
}

export async function writeToCSV(records: ProductData[]): Promise<void> {
  const fileExists = fs.existsSync(CSV_PATH);
  const writer = createObjectCsvWriter({
    path: CSV_PATH,
    header: [
      { id: 'sku',              title: 'SKU' },
      { id: 'source',           title: 'Source' },
      { id: 'title',            title: 'Title' },
      { id: 'description',      title: 'Description' },
      { id: 'price',            title: 'Price' },
      { id: 'reviewsAndRating', title: 'Number of Reviews and Rating' },
    ],
    // append=true omits the header row so existing rows aren't duplicated
    append: fileExists,
  });
  await writer.writeRecords(records);
}

// runConcurrent and retry are not used by the Crawlee scraper (Crawlee handles both
// internally) but are kept here because the test suite covers them directly.

export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }

  // Spawn at most `concurrency` workers; each drains the shared `next` counter
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  );
  return results;
}

export async function retry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 3000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Linear back-off: 1×, 2×, 3× baseDelayMs
      if (attempt < retries) await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}
