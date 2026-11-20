import { createHash, randomBytes } from 'node:crypto';

/** 稳定序列化（键排序），用于哈希 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function shortHash(value: unknown, len = 12): string {
  return sha256(canonicalJson(value)).slice(0, len);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 运行编号：短，避免 Windows 路径过长。例：r-20261008-a1b2c3 */
export function newRunId(date = new Date()): string {
  const d = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `r-${d}-${randomBytes(3).toString('hex')}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** 可复现的伪随机数（mulberry32），用于匿名化顺序；种子记录在 run.anonymization.seed */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rnd = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function newSeed(): number {
  return randomBytes(4).readUInt32LE(0);
}

export function assertNever(x: never, msg = '未处理的分支'): never {
  throw new Error(`${msg}: ${JSON.stringify(x)}`);
}
