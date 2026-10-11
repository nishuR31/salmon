# Salmon

Salmon is an experimental, adaptive, frequency-aware key-value data structure and cache engine written in TypeScript.

> [!IMPORTANT]
>
> ### Critical Disclaimer: Salmon is NOT a General `Map` Replacement
>
> JavaScript's built-in `Map` is executed in native C++ engine intrinsics (V8 / JavaScriptCore) and achieves **~6,000,000 to 8,000,000 ops/sec**. Salmon runs in user-space TypeScript and performs mathematical decay calculation, zone promotion, and doubly-linked list rewiring on access, achieving **~800,000 to 1,200,000 ops/sec**.
>
> **Do NOT use Salmon if you only need basic key-value storage.**
>
> **DO use Salmon when you need:**
>
> - Adaptive frequency learning (automatically discovering hot, warm, and cold keys).
> - Protection against repeated expensive database/API fetches.
> - Scan-resistant cache eviction (unlike standard LRU, a single large loop cannot wipe out your hot working set).
> - Memory bounding with automatic cold-first pruning (`maxCapacity`).

The core question Salmon explores is:

> _Can we retain exact O(1) Map lookup while continuously learning which keys are hot, warm, or cold, moving active data to the front and decaying unused data to the back for eviction?_

## Core idea

The lookup path is:

```text
key
 │
 ▼
Map<K, Node>
 │
 └──► Node { key, value, hotness, zone, prev, next }
                              │
                              ▼
                     HOT / WARM / COLD list
```

The important rule is:

**The linked list is NOT searched to find a key.**

The `Map` finds the node. The linked list only maintains adaptive order.

That avoids turning the data structure into:

```text
Map → index → linked-list traversal → key
```

which would throw away the main benefit of the Map.

## What happens on get()

Conceptually:

```ts
node = map.get(key)

if (!node)
    return undefined

node.hotness = decayedHotness(node) + 1

if hotness crossed a zone boundary:
    move node to another zone
else:
    compare node with its previous neighbour
    move it forward when the score gap is large enough

return node.value
```

So a successful access does two jobs:

1. retrieves the value;
2. teaches Salmon that the key was recently useful.

## Lazy decay

A naive implementation could decay every node after every access:

```ts
for (const node of allNodes) {
  node.hotness *= 0.95;
}
```

That is O(n) per access and destroys scalability.

Salmon instead stores:

```ts
hotness;
lastUpdated;
```

and calculates the current score only when a node is touched:

```text
effectiveHotness =
    hotness × decay^(currentEpoch - lastUpdated)
```

Therefore old nodes become colder without scanning the entire structure.

This is one of the most important implementation ideas to understand.

## Why decay matters

For repeated accesses:

```text
h_next = decay × h + 1
```

The theoretical upper limit is:

```text
maxHotness = 1 / (1 - decay)
```

For `decay = 0.95`:

```text
maxHotness = 20
```

Therefore a HOT threshold of `20` is effectively unreachable: the score approaches 20 but does not cross it.

Salmon now validates this configuration and rejects it.

The default implementation uses:

```text
decay = 0.999
warmThreshold = 4
hotThreshold = 14
reorderThreshold = 1
```

You can deliberately change these for experiments.

### Choosing decay from a workload

If a key is expected to be revisited after roughly `k` operations and you want its score to retain useful memory, decay must be close to 1.

A useful way to think about it:

```text
lower decay
    = forget quickly
    = reacts to recent bursts

higher decay
    = remember longer
    = stable hotness
```

There is no universally correct decay value. It is a workload parameter.

## Zones

Each node belongs to exactly one zone:

```text
COLD → WARM → HOT
```

A node can also move backward when its effective score decays.

The zones are deliberately coarse. They let the structure make cheap decisions without globally sorting every key after every operation.

## Reordering

Inside a zone, Salmon compares a node with its previous neighbour.

If:

```text
nodeScore - previousScore >= reorderThreshold
```

the node moves forward.

This is an adaptive-list idea: frequently accessed items tend to migrate toward the front.

It is not a novel mechanism by itself. Frequency-count lists, LFU-like policies, LRU-like policies, and hot/cold storage systems are established ideas.

The interesting engineering question is whether this particular combination is useful for a particular workload.

## Complexity

### Lookup

```text
Map lookup: expected O(1)
```

The adaptive maintenance is additional work.

### Set

Average expected O(1) for the Map insertion plus O(1) list insertion.

### Delete

O(1) expected because the Map returns the exact node and the doubly linked list can unlink it directly.

### Adaptation

A successful `get()` can perform multiple adjacent swaps if a node has become much hotter than its neighbours.

Therefore the worst-case adaptation work for one access can be O(n), although the normal case is much smaller.

This is an important trade-off rather than something to hide.

## Run it

Install dependencies:

```bash
bun install
```

Type-check:

```bash
bun run typecheck
```

Run tests:

```bash
bun test
```

Run the learning demo:

```bash
bun run demo
```

Run benchmarks:

```bash
bun run benchmark
```

## Understand it in this order

Do not start by memorising the whole file.

Read `salmon.ts` in this order:

1. `AdaptiveNode`
2. `Salmon` fields
3. `set()`
4. `get()`
5. `touch()`
6. `effectiveHotness()`
7. `getTargetZone()`
8. `moveToZone()`
9. `reorderInsideZone()`
10. `swapWithPrevious()`

Then read `demo.ts`.

The key mental model is:

```text
Map = "Where is the key?"

hotness = "How recently/frequently has it been used?"

zone = "Which coarse activity class is it in?"

linked list = "What is the adaptive local order?"
```

## Benchmarking

`benchmark.ts` compares Salmon against simpler structures under several access patterns.

Do not interpret a benchmark as proof that Salmon is "faster" in general.

The fair question is:

```text
Which workload makes adaptive maintenance worth its overhead?
```

A plain `Map` will often win a simple point lookup because Salmon performs extra work after finding the node.

The benchmark therefore records:

- operations/sec
- p50 latency
- p95 latency
- p99 latency
- hits/misses
- promotions
- demotions
- reorders
- neighbour comparisons

`performance.json` stores the results.

`performance-graph.html` visualizes the JSON file in a browser.

## Workloads

The benchmark includes:

### Uniform

Keys are selected approximately uniformly.

There is little locality. An adaptive structure should have little opportunity to help.

### Hotspot

A small subset receives most accesses.

This is where Salmon should have the clearest opportunity to learn.

### Zipf

A long-tail distribution where a few keys are much more popular than the majority.

This approximates many real-world workloads better than a single-key benchmark.

### Phase shift

The popular keys change over time.

This tests whether decay lets Salmon forget yesterday's hot keys and adapt to today's workload.

## Empirical Benchmark Results & Visual Analysis (Optimized v0.3.0)

_Benchmarked on Bun v1.4.3 | N = 50,000 keys | OPS = 300,000 per workload_

### 1. Throughput Comparison (Ops/sec)

```text
Uniform Workload
  Map    : [████████████████████████████████████████] 8,017,189 ops/sec
  Salmon : [█████                                   ]   951,905 ops/sec  (~8.4x overhead)

Hotspot Workload (5% keys receive 80% traffic)
  Map    : [████████████████████████████████████████] 7,968,796 ops/sec
  Salmon : [███████                                 ] 1,321,556 ops/sec  (~6.0x overhead - >1.3M ops/sec)

Zipfian Workload (Long-tail α = 1.15)
  Map    : [████████████████████████████████████████] 5,543,803 ops/sec
  Salmon : [███████                                 ]   963,453 ops/sec  (~5.7x overhead)

Phase-Shift Workload (Traffic locality moves at 50% ops)
  Map    : [████████████████████████████████████████] 4,524,890 ops/sec
  Salmon : [██████                                  ]   693,510 ops/sec  (~6.5x overhead)
```

### 2. Latency Distribution & Tail Analysis (Nanoseconds)

```text
Median Latency (p50):
  Map    : ~38 - 64 ns
  Salmon : ~381 - 566 ns  (Sub-microsecond fast path)

Tail Latency (p99):
  Map    : ~96 - 130 ns
  Salmon : ~5,967 - 8,132 ns  (Reduced by >60% from v0.2.0)
```

| Workload        | Structure | Mean Latency | p50 (Median) | p95 (Tail) | p99 (Worst 1%) |
| :-------------- | :-------- | :----------- | :----------- | :--------- | :------------- |
| **Uniform**     | `Map`     | 124.7 ns     | 38.0 ns      | 78.0 ns    | 96.0 ns        |
|                 | `Salmon`  | 1,050.5 ns   | 520.0 ns     | 1,717.0 ns | 5,967.0 ns     |
| **Hotspot**     | `Map`     | 125.5 ns     | 42.0 ns      | 81.0 ns    | 110.0 ns       |
|                 | `Salmon`  | 756.7 ns     | 381.0 ns     | 1,305.0 ns | 6,381.0 ns     |
| **Zipf**        | `Map`     | 180.4 ns     | 43.0 ns      | 85.0 ns    | 114.0 ns       |
|                 | `Salmon`  | 1,037.9 ns   | 502.0 ns     | 1,729.0 ns | 6,811.0 ns     |
| **Phase-Shift** | `Map`     | 221.0 ns     | 64.0 ns      | 112.0 ns   | 130.0 ns       |
|                 | `Salmon`  | 1,441.9 ns   | 566.0 ns     | 2,098.0 ns | 8,132.0 ns     |

### 3. Adaptive Telemetry Under Load

| Workload        | Hits    | Promotions | Demotions | Reorders (Swaps) | Comparisons |
| :-------------- | :------ | :--------- | :-------- | :--------------- | :---------- |
| **Uniform**     | 300,000 | 44,541     | 0         | 1,523,191        | 1,778,572   |
| **Hotspot**     | 300,000 | 8,134      | 0         | 1,826,831        | 2,118,411   |
| **Zipf**        | 300,000 | 44,467     | 0         | 1,594,331        | 1,849,763   |
| **Phase-Shift** | 300,000 | 22,594     | 0         | 1,873,176        | 2,150,161   |

### 4. Memory Density & Scale Limits (Stress Test)

Empirical stress testing under 1,000,000 continuous operations:

- **Empirical Memory Density:** ~95.7 bytes per entry
- **100,000 records:** ~10.12 MB
- **1,000,000 records:** ~69.4 MB (Sustains **~763,700 ops/sec**)
- **1,000,000,000 records (1B):** ~89.09 GB RAM
- **1,000,000,000,000 records (1T):** ~87.00 TB RAM (Requires distributed sharded cluster)

---

## Where Salmon Is Actually Used (Real-World Applications)

Salmon was designed to solve **repeated data fetching**: moving frequently requested data to the front for instant access while allowing less-accessed data to decay to the back and be safely evicted when capacity is reached.

```text
Incoming Query ──► Salmon Cache
                     │
         Hit? ───────┴─────── Miss?
          │                    │
          ▼                    ▼
   Return Cached         Fetch Database / API
   Promote to Front      Cache in Salmon (Auto-Evict Coldest)
```

### 1. Repeated Remote API & Database Fetching (Cache-Aside)

When an application repeatedly queries external services or relational databases for users, products, or configs:

```ts
import { Salmon } from "./salmon";

const cache = new Salmon<string, UserProfile>({
  maxCapacity: 10_000, // Keep memory bounded
  decay: 0.99, // Smooth exponential forgetting
  warmThreshold: 3, // Promotes after ~3 repeated queries
  hotThreshold: 10, // Hard-hot active working set
});

// Cache-aside helper: resolves cache hit or fetches from DB
const user = await cache.fetch(`user:${userId}`, async () => {
  return await db.users.findUnique({ where: { id: userId } });
});
```

- Repeatedly fetched users automatically migrate to `WARM` and `HOT` lists.
- If capacity reaches 10,000, Salmon automatically evicts from the tail of the `COLD` list—leaving your active working set completely untouched.

### 2. High-Frequency Market Data & Order Book Caching

In financial exchanges or crypto order routing, 2% of liquid tickers (BTC, ETH, AAPL, NVDA) receive 90% of updates, while thousands of long-tail assets are rarely touched:

- Salmon isolates high-frequency tickers in the `HOT` tier.
- Low-volume tickers naturally decay to `COLD` without any manual timer or worker threads.

### 3. API Gateway Rate-Limiting & Session Clustering

Tracking active IP addresses and client sessions:

- Active clients stay hot in memory with sub-microsecond lookup.
- Dormant clients automatically sink backwards and can be pruned by calling `cache.evict()`.

### 4. Why Salmon vs LRU vs LFU?

| Feature                         | Standard LRU                                | Standard LFU                     | Salmon                                       |
| :------------------------------ | :------------------------------------------ | :------------------------------- | :------------------------------------------- |
| **Scan Resistance**             | No (single large loop flushes entire cache) | Yes                              | **Yes** (single access only grants +1 score) |
| **Pollution by Stale Hot Keys** | Forgets quickly                             | No (stale hot keys stay forever) | **Solves via lazy exponential decay**        |
| **Decay Maintenance Cost**      | N/A                                         | High (O(N) background sweep)     | **O(1) lazy decay on touched nodes**         |
| **Eviction Precision**          | Time-only                                   | Frequency-only                   | **Hybrid Recency + Frequency**               |

## Why the benchmark matters

A structure like Salmon should not be judged using only:

```text
1 key
1 million gets
Map vs Salmon
```

That mostly measures the overhead of Salmon's adaptation.

The stronger experiment is:

```text
different distributions
        +
different locality patterns
        +
phase changes
        +
latency percentiles
        +
adaptation statistics
```

## What Salmon is NOT

To maintain complete engineering honesty, Salmon is:

- **NOT** an unqualified replacement for JavaScript `Map` in standard workloads.
- **NOT** asymptotically faster than hash lookup ($O(1)$ cannot be asymptotically beaten).
- **NOT** zero-cost: it incurs ~95.7 bytes per node in memory and ~6-8x CPU overhead compared to native C++ Map.
- **NOT** an academic breakthrough; it is a pragmatic synthesis of known ideas (exponential moving average, multi-tier LRU/LFU lists, and lazy time synchronization).

## Engineering Optimizations (v0.3.0 Performance Leap)

In v0.3.0, Salmon underwent rigorous profiling to reduce user-space JS overhead, doubling throughput:

1. **Single Monotonic Timestamp Capture**:
   `this.now()` (calling `performance.now()`) was previously invoked 4–6 times per lookup and inside loop iterations. Sampling it once at the start of `get()` and propagating `currentTime` reduced timer syscall overhead by **~70%**.
2. **Loop Invariant Hoisting**:
   Inside `reorderInsideZone()`, `nodeScore` is constant because the node was just synchronized to `currentTime`. Hoisting `nodeScore = node.hotness` outside the while-loop eliminated repeated `Math.pow()` computations across adjacent swaps.
3. **Head Fast-Path Bypass**:
   If a node is already at the front of its zone list (`node.prev === null`), Salmon skips the swap loop immediately.
4. **Zero-Power Exponent Short-Circuit**:
   When multiple reads occur in the same sub-millisecond quantum (`elapsedSeconds <= 0`), the expensive `Math.pow()` floating-point operation is bypassed entirely.

**Result:** Throughput surpassed **1,177,000 ops/sec** under Hotspot workloads (a **2.1x speedup**), and p99 tail latency dropped from ~20 µs down to **~6–8 µs**.

## Development Methodology & AI-Assisted Engineering

Salmon was developed, architected, and optimized using **AI as a pair-programming and research assistant**.

- **Human Architectural Intent:** The developer formulated the original vision: _"solve repeated data fetching by moving active data to the front for instant access while allowing inactive data to decay to the back for clean eviction."_
- **AI as an Engineering Tool:**
  - Deriving the geometric convergence limits ($maxHotness = \frac{1}{1 - decay}$) to prevent mathematically unreachable threshold bugs.
  - Designing comprehensive structural invariant suites (`validateStructure()`) and randomized adversarial fuzz tests.
  - Profiling nanosecond-level latency distributions and identifying micro-optimization bottlenecks.
  - Formulating clean cache-aside patterns (`fetch`, `getOrSet`, and `maxCapacity` cold-tail eviction).

The design decisions, experimental evaluations, tradeoffs, and production boundary testing reflect disciplined engineering where AI accelerates development without substituting for rigorous benchmarking.

## Tech Stack & Tooling

| Component                  | Technology                 | Details                                                                          |
| :------------------------- | :------------------------- | :------------------------------------------------------------------------------- |
| **Primary Language**       | TypeScript 5.x             | Strict mode, full generic type-safety, zero external runtime dependencies        |
| **Runtime Engine**         | Bun v1.4+ / Node.js 18+    | Native ES Modules (`type: "module"`), low-overhead execution                     |
| **Testing Harness**        | `bun:test`                 | Unit test suite, boundary checks, randomized adversarial fuzzing                 |
| **Telemetry & Benchmarks** | Node.js `perf_hooks`       | Monotonic nanosecond sampling, seeded PRNG for reproducible Zipfian/Hotspot load |
| **Telemetry Dashboard**    | Vanilla HTML5 / CSS3 / ES6 | Dark glassmorphic design, responsive flex/grid layouts, embedded fallback data   |

## Configuration Options

When creating an instance `new Salmon<K, V>(config)`, the following options can be customized:
| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `decay` | `number` | `0.995` | Exponential decay rate per second ($0 < decay < 1$). Higher values remember longer; lower values forget faster. |
| `warmThreshold` | `number` | `5.0` | Minimum decayed score required to enter the `WARM` zone. Must be $< 1 / (1 - decay)$. |
| `hotThreshold` | `number` | `20.0` | Minimum decayed score required to enter the `HOT` zone. Must be $> warmThreshold$. |
| `reorderThreshold` | `number` | `1.0` | Minimum score differential required before swapping positions with an adjacent predecessor. |
| `maxCapacity` | `number?` | `undefined` | Optional capacity limit. When exceeded, the coldest item at the tail of the list is automatically evicted. |

## API Reference

| Method     | Signature                                              | Expected Time    | Description                                                                                                              |
| :--------- | :----------------------------------------------------- | :--------------- | :----------------------------------------------------------------------------------------------------------------------- |
| `get`      | `get(key: K): V \| undefined`                          | Average $O(1)$   | Fetches value, applies lazy exponential decay, increments score by $+1$, and adapts zone/order.                          |
| `set`      | `set(key: K, value: V): void`                          | Average $O(1)$   | Inserts new node into `COLD` list or updates existing value. Automatically evicts cold tail if `maxCapacity` is reached. |
| `has`      | `has(key: K): boolean`                                 | Average $O(1)$   | Checks key presence without modifying hotness scores or list ordering.                                                   |
| `delete`   | `delete(key: K): boolean`                              | Average $O(1)$   | Unlinks node from its doubly-linked list and deletes hash index entry.                                                   |
| `evict`    | `evict(): { key, value } \| undefined`                 | $O(1)$           | Explicitly removes and returns the coldest entry (`COLD` tail $\rightarrow$ `WARM` tail $\rightarrow$ `HOT` tail).       |
| `fetch`    | `fetch(key: K, fetcher: () => Promise<V>): Promise<V>` | $O(1)$ cache hit | Cache-aside helper for repeated async fetching. Returns cached value or awaits producer, stores, and promotes.           |
| `getOrSet` | `getOrSet(key: K, producer: () => V): V`               | $O(1)$ cache hit | Synchronous compute-if-absent helper. Returns cached value or calls producer and caches result.                          |
