import { performance } from "node:perf_hooks";
import { Salmon } from "./index";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index]!;
}

console.log("===============================================================================");
console.log("            SALMON SCALE & STRESS TEST REPORT (TOWARDS 1 TRILLION)            ");
console.log("===============================================================================\n");

// =============================================================================
// PART 1: THEORETICAL 1 TRILLION RECORD FEASIBILITY ANALYSIS
// =============================================================================
console.log("--- PART 1: Physical & Architectural Feasibility for 1,000,000,000,000 Records ---");
const ONE_TRILLION = 1_000_000_000_000;
const ASSUMED_BYTES_PER_NODE = 160; // Estimated Node object + Map hash bucket + pointers
const TOTAL_RAM_TRILLION_BYTES = ONE_TRILLION * ASSUMED_BYTES_PER_NODE;
const TOTAL_RAM_TRILLION_TB = TOTAL_RAM_TRILLION_BYTES / (1024 ** 4);
const ASSUMED_OPS_PER_SEC = 500_000;
const SECONDS_FOR_1T_OPS = ONE_TRILLION / ASSUMED_OPS_PER_SEC;
const DAYS_FOR_1T_OPS = SECONDS_FOR_1T_OPS / 86400;

console.log(`• Records Requested: 1,000,000,000,000 (10^12)`);
console.log(`• Node overhead in V8/JSC: ~${ASSUMED_BYTES_PER_NODE} bytes (Map bucket + Node + 2 pointers + 4 fields)`);
console.log(`• RAM required for 1T in-memory records: ~${TOTAL_RAM_TRILLION_TB.toFixed(2)} TB RAM`);
console.log(`• Time to populate/touch at 500k ops/sec: ~${DAYS_FOR_1T_OPS.toFixed(1)} days continuous CPU`);
console.log(`• Runtime constraint: Node.js/Bun heap ceiling is ~2GB-4GB (single process).`);
console.log(`  To store 1 trillion records in practice, a distributed LSM-Tree / disk-backed architecture`);
console.log(`  (such as RocksDB, ScyllaDB, Bigtable) or a cluster of ~1,000+ nodes is required.\n`);

// =============================================================================
// PART 2: EMPIRICAL MEMORY SCALING STRESS TEST
// =============================================================================
console.log("--- PART 2: Memory Scaling & Density Ramp Test (Up to Maximum Feasible Heap) ---");
const scaleSteps = [100_000, 300_000, 600_000, 1_000_000, 1_500_000];

let previousHeap = process.memoryUsage().heapUsed;
let measuredBytesPerNode = 0;

for (const count of scaleSteps) {
  if (global.gc) global.gc();
  const beforeMem = process.memoryUsage();
  const salmon = new Salmon<number, number>({
    decay: 0.999,
    warmThreshold: 4,
    hotThreshold: 14,
    reorderThreshold: 1,
  });

  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    salmon.set(i, i);
  }
  const t1 = performance.now();
  const afterMem = process.memoryUsage();

  const memDelta = afterMem.heapUsed - beforeMem.heapUsed;
  const bytesPerRecord = memDelta > 0 ? memDelta / count : 0;
  if (bytesPerRecord > 0) measuredBytesPerNode = bytesPerRecord;

  const insertOpsPerSec = count / ((t1 - t0) / 1000);

  console.log(
    `[${count.toLocaleString().padStart(9)} Records] ` +
    `Time: ${(t1 - t0).toFixed(0).padStart(5)}ms | ` +
    `Insert: ${(insertOpsPerSec / 1000).toFixed(1).padStart(7)} kops/s | ` +
    `Heap: ${formatBytes(afterMem.heapUsed).padStart(9)} | ` +
    `Avg/Record: ~${bytesPerRecord.toFixed(0)} B`
  );
}

const projected1M_RAM = (1_000_000 * measuredBytesPerNode) / (1024 * 1024);
const projected1B_RAM = (1_000_000_000 * measuredBytesPerNode) / (1024 * 1024 * 1024);
const projected1T_RAM = (ONE_TRILLION * measuredBytesPerNode) / (1024 ** 4);

console.log(`\n• Empirical Memory Density: ~${measuredBytesPerNode.toFixed(1)} bytes per Salmon entry`);
console.log(`• Projected 1,000,000 records:    ~${projected1M_RAM.toFixed(1)} MB`);
console.log(`• Projected 1,000,000,000 records:  ~${projected1B_RAM.toFixed(2)} GB`);
console.log(`• Projected 1,000,000,000,000 (1T): ~${projected1T_RAM.toFixed(2)} TB (Requires distributed cluster)\n`);

// =============================================================================
// PART 3: HIGH-THROUGHPUT STRESS & ADAPTIVE STABILITY TEST (1,000,000 OPS)
// =============================================================================
console.log("--- PART 3: High-Throughput Stress Test (1,000,000 Adaptive Operations) ---");
const N = 200_000;
const STRESS_OPS = 1_000_000;
const salmon = new Salmon<number, number>({
  decay: 0.999,
  warmThreshold: 4,
  hotThreshold: 14,
  reorderThreshold: 1,
});

console.log(`Populating Salmon with ${N.toLocaleString()} records...`);
for (let i = 0; i < N; i++) {
  salmon.set(i, i);
}

salmon.resetStats();
const times: number[] = [];

console.log(`Executing ${STRESS_OPS.toLocaleString()} operations under Zipfian heavy-tail load...`);
const startStress = performance.now();

for (let i = 0; i < STRESS_OPS; i++) {
  // Zipfian distribution (rank power 1.25)
  const u = Math.max(Number.EPSILON, Math.random());
  const rank = Math.floor(Math.pow(u, 1 / 1.25) * N);
  const key = Math.min(N - 1, rank);

  const t0 = performance.now();
  salmon.get(key);
  const t1 = performance.now();

  if (i % 25 === 0) {
    times.push((t1 - t0) * 1_000_000); // ns
  }
}

const elapsedStress = performance.now() - startStress;
const stats = salmon.getStats();

console.log(`✓ Completed in ${(elapsedStress / 1000).toFixed(2)}s`);
console.log(`• Sustained Throughput: ${(STRESS_OPS / (elapsedStress / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })} ops/sec`);
console.log(`• Avg Latency:         ${((elapsedStress * 1_000_000) / STRESS_OPS).toFixed(1)} ns`);
console.log(`• p50 Latency:         ${percentile(times, 0.50).toFixed(1)} ns`);
console.log(`• p95 Latency:         ${percentile(times, 0.95).toFixed(1)} ns`);
console.log(`• p99 Latency:         ${percentile(times, 0.99).toFixed(1)} ns`);
console.log(`• Promotions:          ${stats.promotions.toLocaleString()}`);
console.log(`• Reorders:            ${stats.reorders.toLocaleString()}`);
console.log(`• Comparisons:         ${stats.comparisons.toLocaleString()}`);

// =============================================================================
// PART 4: ADVERSARIAL STRESS & STRUCTURAL INTEGRITY VALIDATION
// =============================================================================
console.log("\n--- PART 4: Adversarial Reorder & Structural Invariant Validation ---");
const validation = salmon.validateStructure();
console.log(`• Structure Valid:     ${validation.valid ? "PASSED (No broken pointers / leaks)" : "FAILED"}`);
console.log(`• Zone Breakdown:      Cold: ${validation.zoneSizes.cold.toLocaleString()} | Warm: ${validation.zoneSizes.warm.toLocaleString()} | Hot: ${validation.zoneSizes.hot.toLocaleString()}`);
console.log(`• Map vs List Size:    Map: ${validation.mapSize.toLocaleString()} === List: ${validation.listSize.toLocaleString()}`);

if (!validation.valid) {
  console.error("Errors found:", validation.errors);
  process.exit(1);
}

console.log("\n===============================================================================");
console.log("                          STRESS TEST PASSED SUCCESSFULLY                      ");
console.log("===============================================================================");
