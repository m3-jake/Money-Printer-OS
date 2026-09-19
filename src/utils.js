export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function mapLimit(items, limit, fn) {
  const input = Array.from(items || []);
  if (!input.length) return [];
  const out = new Array(input.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, input.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= input.length) return;
      try {
        out[i] = await fn(input[i], i);
      } catch (error) {
        out[i] = { __error: error };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export function percentile(values, p = 0.5) {
  const xs = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * p)));
  return xs[idx];
}

export function compactError(error) {
  if (!error) return 'Unknown error';
  return String(error.message || error).slice(0, 500);
}
