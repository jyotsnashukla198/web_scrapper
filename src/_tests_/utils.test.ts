import * as fs from 'fs';
import { sleep, logError, writeToCSV, runConcurrent, retry, ProductData } from '../utils';

jest.mock('fs');
jest.mock('csv-writer', () => ({
  createObjectCsvWriter: jest.fn(() => ({
    writeRecords: jest.fn().mockResolvedValue(undefined),
  })),
}));

// ─── sleep ───────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after roughly the given ms', async () => {
    const start = Date.now();
    await sleep(100);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });
});

// ─── logError ────────────────────────────────────────────────────────────────

describe('logError', () => {
  it('writes a formatted line to the error log', () => {
    (fs.appendFileSync as jest.Mock).mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    logError('SKU123', 'Amazon', 'timeout');
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    const written = (fs.appendFileSync as jest.Mock).mock.calls[0][1] as string;
    expect(written).toContain('SKU123');
    expect(written).toContain('Amazon');
    expect(written).toContain('timeout');
    expect(written).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  afterEach(() => jest.clearAllMocks());
});

// ─── writeToCSV ──────────────────────────────────────────────────────────────

const sampleRecord: ProductData = {
  sku: 'B0001',
  source: 'Amazon',
  title: 'Test Product',
  price: '$9.99',
  description: 'A test item',
  reviewsAndRating: '4.5 out of 5 | 100 ratings',
};

describe('writeToCSV', () => {
  it('creates new file when it does not exist', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    await expect(writeToCSV([sampleRecord])).resolves.not.toThrow();
  });

  it('appends when file already exists', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    await expect(writeToCSV([sampleRecord])).resolves.not.toThrow();
  });

  afterEach(() => jest.clearAllMocks());
});

// ─── retry ───────────────────────────────────────────────────────────────────

describe('retry', () => {
  it('returns value immediately on first success', async () => {
    const result = await retry(() => Promise.resolve('ok'), 3, 0);
    expect(result).toBe('ok');
  });

  it('retries and succeeds on second attempt', async () => {
    let calls = 0;
    const result = await retry(() => {
      calls++;
      if (calls < 2) return Promise.reject(new Error('fail'));
      return Promise.resolve('recovered');
    }, 3, 0);
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('throws after all retries are exhausted', async () => {
    let calls = 0;
    await expect(
      retry(() => { calls++; return Promise.reject(new Error('always fails')); }, 3, 0)
    ).rejects.toThrow('always fails');
    expect(calls).toBe(3);
  });
});

// ─── runConcurrent ───────────────────────────────────────────────────────────

describe('runConcurrent', () => {
  it('runs all tasks and returns fulfilled results', async () => {
    const tasks = [1, 2, 3].map(n => () => Promise.resolve(n));
    const results = await runConcurrent(tasks, 2);
    expect(results).toHaveLength(3);
    results.forEach((r, i) => {
      expect(r).toEqual({ status: 'fulfilled', value: i + 1 });
    });
  });

  it('captures rejected tasks without throwing', async () => {
    const tasks = [
      () => Promise.resolve('good'),
      () => Promise.reject(new Error('bad')),
    ];
    const results = await runConcurrent(tasks, 2);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'good' });
    expect(results[1].status).toBe('rejected');
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const tasks = Array.from({ length: 6 }, () => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(20);
      running--;
    });
    await runConcurrent(tasks, 2);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('handles empty task list', async () => {
    const results = await runConcurrent([], 2);
    expect(results).toHaveLength(0);
  });
});
