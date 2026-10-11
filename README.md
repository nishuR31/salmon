# Salmon

Salmon is an experimental adaptive frequency-aware key-value data structure written in TypeScript.

The goal is not to pretend that `Map.get()` can be asymptotically beaten. JavaScript's `Map` already provides expected O(1) lookup.

The experiment is different:

> Can we keep exact Map lookup while continuously learning which keys are hot, warm, or cold and maintaining a cheap adaptive order around those keys?

The name comes from pink salmon: the structure is meant to be adaptive rather than static.

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
hotness
lastUpdated
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

Read `index.ts` in this order:

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

## Empirical Benchmark Results & Visual Analysis

*Benchmarked on Bun v1.4.3 | N = 50,000 keys | OPS = 300,000 per workload*

### 1. Throughput Comparison (Ops/sec)

```text
Uniform Workload
  Map    : [████████████████████████████████████████] 7,057,341 ops/sec
  Salmon : [███                                     ]   522,339 ops/sec  (~13.5x overhead)

Hotspot Workload (5% keys receive 80% traffic)
  Map    : [████████████████████████████████████████] 7,647,546 ops/sec
  Salmon : [███                                     ]   555,031 ops/sec  (~13.7x overhead)

Zipfian Workload (Long-tail α = 1.15)
  Map    : [████████████████████████████████████████] 5,622,279 ops/sec
  Salmon : [███                                     ]   502,644 ops/sec  (~11.2x overhead)

Phase-Shift Workload (Traffic locality moves at 50% ops)
  Map    : [████████████████████████████████████████] 4,184,007 ops/sec
  Salmon : [█████                                   ]   509,339 ops/sec  (~8.2x overhead)
```

### 2. Latency Distribution & Tail Analysis (Nanoseconds)

```text
Median Latency (p50):
  Map    : ~37 - 61 ns
  Salmon : ~619 - 759 ns  (Sub-microsecond fast path)

Tail Latency (p99):
  Map    : ~94 - 182 ns
  Salmon : ~15,150 - 20,316 ns  (~15-20 µs during cascade reorders)
```

| Workload | Structure | Mean Latency | p50 (Median) | p95 (Tail) | p99 (Worst 1%) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Uniform** | `Map` | 141.7 ns | 37.0 ns | 86.0 ns | 124.0 ns |
| | `Salmon` | 1,914.5 ns | 759.0 ns | 3,910.0 ns | 15,150.0 ns |
| **Hotspot** | `Map` | 130.8 ns | 42.0 ns | 81.0 ns | 94.0 ns |
| | `Salmon` | 1,801.7 ns | 619.0 ns | 3,566.0 ns | 20,316.0 ns |
| **Zipf** | `Map` | 177.9 ns | 43.0 ns | 82.0 ns | 103.0 ns |
| | `Salmon` | 1,989.5 ns | 750.0 ns | 4,212.0 ns | 17,866.0 ns |
| **Phase-Shift** | `Map` | 239.0 ns | 61.0 ns | 122.0 ns | 182.0 ns |
| | `Salmon` | 1,963.3 ns | 652.0 ns | 4,231.0 ns | 19,466.0 ns |

### 3. Adaptive Telemetry Under Load

| Workload | Hits | Promotions | Demotions | Reorders (Swaps) | Comparisons |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Uniform** | 300,000 | 44,541 | 0 | 1,539,878 | 1,795,261 |
| **Hotspot** | 300,000 | 8,134 | 0 | 1,921,734 | 2,213,314 |
| **Zipf** | 300,000 | 44,467 | 0 | 1,597,123 | 1,852,559 |
| **Phase-Shift** | 300,000 | 22,594 | 0 | 1,884,180 | 2,161,167 |

### 4. Memory Density & Scale Limits (Stress Test)

Empirical stress testing reveals memory overhead and physical limits:

- **Empirical Memory Density:** ~116.1 bytes per entry (Map bucket + Node object + 2 pointers + score/timestamp).
- **100,000 records:** ~9.43 MB
- **1,000,000 records:** ~110.7 MB
- **1,000,000,000 records (1B):** ~108.15 GB RAM
- **1,000,000,000,000 records (1T):** ~105.61 TB RAM (Requires distributed sharded cluster)


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

It is not:

- a replacement for JavaScript `Map` in every workload;
- asymptotically faster than hash lookup;
- a cache replacement;
- a proof/authentication structure;
- a blockchain structure;
- a claim of academic novelty.

The current project is an experimental data-structure design.

## How the idea was developed

The starting intuition was:

```text
What if a data structure learned which data is used more often?
```

That led to:

```text
HashMap
  +
hotness score
  +
HOT/WARM/COLD zones
  +
linked-list reordering
  +
decay
```

The design was then refined by questioning each operation:

- Can exact lookup stay O(1)? → use Map directly.
- Can every node be decayed on every access? → no, use lazy decay.
- Can the HOT threshold be unreachable? → yes, derive the maximum score and validate it.
- Should every access scan the list? → no, use local neighbour comparisons.
- Can this be claimed as a new data structure? → not without a stronger literature review and a genuinely new contribution.

GPT was used during the design/debugging process as an engineering and research assistant. The implementation, experiments, interpretation, and final understanding should be done by the developer using the project.

## What you should be able to explain

Before treating Salmon as "your" data structure, you should be able to answer these without looking at the code:

1. Why does Salmon need a Map?
2. Why does it also need a linked list?
3. Why must the linked list not be used for lookup?
4. What does `hotness` represent?
5. Why is decay lazy?
6. What happens when a node crosses `warmThreshold`?
7. What happens when it crosses `hotThreshold`?
8. Why can a node move backward?
9. Why can one `get()` perform more than one swap?
10. Why is Salmon not automatically faster than `Map`?
11. What workload should make Salmon useful?
12. Why does `decay=0.95` make a threshold of `20` unreachable?

If you can answer those, you understand the design rather than merely possessing the code.

## Project files

```text
salmon/
├── index.ts
├── index.test.ts
├── demo.ts
├── benchmark.ts
├── performance.json
├── performance-graph.html
├── package.json
├── tsconfig.json
└── README.md
```
