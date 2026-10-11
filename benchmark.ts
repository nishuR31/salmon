import { performance } from "node:perf_hooks";
import Salmon from "./salmon";

type Workload = "uniform" | "hotspot" | "zipf" | "phase-shift";

interface Result {
  workload: Workload;
  structure: string;
  operations: number;
  elapsedMs: number;
  opsPerSecond: number;
  averageNs: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
  hits: number;
  misses: number;
  promotions: number;
  demotions: number;
  reorders: number;
  comparisons: number;
}

const N = Number(process.env.N ?? 50_000);
const OPS = Number(process.env.OPS ?? 300_000);
const WARMUP = Number(process.env.WARMUP ?? 20_000);
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY ?? 20);

if (!Number.isSafeInteger(N) || N <= 0) throw new Error("N must be > 0");
if (!Number.isSafeInteger(OPS) || OPS <= 0) throw new Error("OPS must be > 0");

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index]!;
}

function makeKey(
  i: number,
  workload: Workload,
  phase: number,
  rng: () => number
): number {
  switch (workload) {
    case "uniform":
      return Math.floor(rng() * N);

    case "hotspot":
      // 5% of the keys receive ~80% of accesses.
      if (rng() < 0.8) return Math.floor(rng() * Math.max(1, N * 0.05));
      return Math.floor(rng() * N);

    case "zipf": {
      // Simple approximate Zipf distribution using inverse power sampling.
      const u = Math.max(Number.EPSILON, rng());
      const rank = Math.floor(Math.pow(u, 1 / 1.15) * N);
      return Math.min(N - 1, rank);
    }

    case "phase-shift": {
      const half = Math.floor(N / 10);
      const base = phase === 0 ? 0 : Math.floor(N / 2);
      if (rng() < 0.8) return base + Math.floor(rng() * Math.max(1, half));
      return Math.floor(rng() * N);
    }
  }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runWorkload(
  workload: Workload,
  run: (i: number, phase: number) => void,
  stats?: () => Partial<Result>
): Result {
  const rng = seededRandom(0x51a1_0000 + workload.length);
  const times: number[] = [];

  // Warmup is intentionally excluded from the reported measurements.
  for (let i = 0; i < WARMUP; i++) {
    const phase = workload === "phase-shift" && i >= WARMUP / 2 ? 1 : 0;
    run(i, phase);
  }

  const before = stats?.() ?? {};
  const start = performance.now();

  for (let i = 0; i < OPS; i++) {
    const phase =
      workload === "phase-shift" && i >= Math.floor(OPS / 2) ? 1 : 0;
    const key = makeKey(i, workload, phase, rng);

    const t0 = performance.now();
    run(key, phase);
    const t1 = performance.now();

    if (i % SAMPLE_EVERY === 0) {
      times.push((t1 - t0) * 1_000_000);
    }
  }

  const elapsedMs = performance.now() - start;
  const after = stats?.() ?? {};

  const delta = (field: keyof Result) =>
    Number(after[field] ?? 0) - Number(before[field] ?? 0);

  return {
    workload,
    structure: "unknown",
    operations: OPS,
    elapsedMs,
    opsPerSecond: OPS / (elapsedMs / 1000),
    averageNs: (elapsedMs * 1_000_000) / OPS,
    p50Ns: percentile(times, 0.50),
    p95Ns: percentile(times, 0.95),
    p99Ns: percentile(times, 0.99),
    hits: delta("hits"),
    misses: delta("misses"),
    promotions: delta("promotions"),
    demotions: delta("demotions"),
    reorders: delta("reorders"),
    comparisons: delta("comparisons"),
  };
}

function createSalmon() {
  return new Salmon<number, number>({
    // Longer memory is useful for workloads where a key is revisited
    // after many other operations.
    decay: 0.999,
    warmThreshold: 4,
    hotThreshold: 14,
    reorderThreshold: 1,
  });
}

const results: Result[] = [];
const workloads: Workload[] = ["uniform", "hotspot", "zipf", "phase-shift"];

for (const workload of workloads) {
  const map = new Map<number, number>();
  const salmon = createSalmon();

  for (let i = 0; i < N; i++) {
    map.set(i, i);
    salmon.set(i, i);
  }

  // Map baseline.
  const mapResult = runWorkload(
    workload,
    (key) => {
      map.get(key);
    },
    () => ({ hits: 0, misses: 0, promotions: 0, demotions: 0, reorders: 0, comparisons: 0 })
  );
  mapResult.structure = "Map";
  results.push(mapResult);

  // Salmon.
  salmon.resetStats();
  const salmonResult = runWorkload(
    workload,
    (key) => {
      salmon.get(key);
    },
    () => salmon.getStats()
  );
  salmonResult.structure = "Salmon";
  results.push(salmonResult);
}

const output = {
  metadata: {
    project: "salmon",
    runtime: typeof Bun !== "undefined" ? `Bun ${Bun.version}` : process.version,
    date: new Date().toISOString(),
    datasetSize: N,
    operations: OPS,
    warmup: WARMUP,
    timingSampleEvery: SAMPLE_EVERY,
    note: "Benchmark measures lookup plus Salmon adaptation overhead. It does not claim Salmon is universally faster than Map."
  },
  benchmarks: results,
};

const text = JSON.stringify(output, null, 2) + "\n";
if (typeof Bun !== "undefined") {
  await Bun.write("performance.json", text);
} else {
  const { writeFile } = await import("node:fs/promises");
  await writeFile("performance.json", text);
}

console.log(text);
