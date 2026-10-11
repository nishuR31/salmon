export type Zone = "cold" | "warm" | "hot";

export interface SalmonStats {
  hits: number;
  misses: number;
  promotions: number;
  demotions: number;
  reorders: number;
  comparisons: number;
}

interface Node<K, V> {
  key: K;
  value: V;

  /**
   * Stored hotness score.
   * This is the score at lastUpdated.
   */
  hotness: number;

  /**
   * Monotonic timestamp in seconds.
   */
  lastUpdated: number;

  zone: Zone;

  prev: Node<K, V> | null;
  next: Node<K, V> | null;
}

interface List<K, V> {
  head: Node<K, V> | null;
  tail: Node<K, V> | null;
  size: number;
}

export interface SalmonConfig {
  /**
   * Exponential decay factor per second.
   * Must be > 0 and < 1.
   */
  decay: number;

  /**
   * Score required to enter warm zone.
   */
  warmThreshold: number;

  /**
   * Score required to enter hot zone.
   */
  hotThreshold: number;

  /**
   * Minimum score difference required
   * before moving ahead inside a zone.
   */
  reorderThreshold: number;
}

export interface StructureValidation {
  valid: boolean;
  mapSize: number;
  listSize: number;
  zoneSizes: Record<Zone, number>;
  errors: string[];
}

export class Salmon<K, V> {
  // ==========================================================
  // INDEX
  // ==========================================================

  private readonly index = new Map<K, Node<K, V>>();

  // ==========================================================
  // ZONE LISTS
  // ==========================================================

  private readonly lists: Record<Zone, List<K, V>> = {
    cold: {
      head: null,
      tail: null,
      size: 0,
    },

    warm: {
      head: null,
      tail: null,
      size: 0,
    },

    hot: {
      head: null,
      tail: null,
      size: 0,
    },
  };

  // ==========================================================
  // CONFIGURATION & STATE
  // ==========================================================

  private readonly config: SalmonConfig;

  private logicalTime: number = 0;

  private stats: SalmonStats = {
    hits: 0,
    misses: 0,
    promotions: 0,
    demotions: 0,
    reorders: 0,
    comparisons: 0,
  };

  private now(): number {
    return performance.now() / 1000 + this.logicalTime;
  }

  // ==========================================================
  // CONSTRUCTOR
  // ==========================================================

  constructor(config?: Partial<SalmonConfig>) {
    const decay = config?.decay ?? 0.995;
    const maxHotness =
      Number.isFinite(decay) && decay > 0 && decay < 1
        ? 1 / (1 - decay)
        : Infinity;

    const defaultWarm =
      config?.warmThreshold ??
      (maxHotness <= 20
        ? Math.max(1, Number((maxHotness * 0.25).toFixed(2)))
        : 5);

    const defaultHot =
      config?.hotThreshold ??
      (maxHotness <= 20
        ? Math.max(defaultWarm + 1, Number((maxHotness * 0.7).toFixed(2)))
        : 20);

    this.config = {
      decay,
      warmThreshold: defaultWarm,
      hotThreshold: defaultHot,
      reorderThreshold: 5,
      ...config,
    };

    this.validateConfig(config);
  }

  // ==========================================================
  // CONFIG VALIDATION
  // ==========================================================

  private validateConfig(rawConfig?: Partial<SalmonConfig>): void {
    if (
      !Number.isFinite(this.config.decay) ||
      this.config.decay <= 0 ||
      this.config.decay >= 1
    ) {
      throw new Error(
        "decay must be a finite number between 0 and 1"
      );
    }

    if (
      !Number.isFinite(this.config.warmThreshold) ||
      this.config.warmThreshold < 0
    ) {
      throw new Error(
        "warmThreshold must be a finite number >= 0"
      );
    }

    if (
      !Number.isFinite(this.config.hotThreshold) ||
      this.config.hotThreshold <= this.config.warmThreshold
    ) {
      throw new Error(
        "hotThreshold must be greater than warmThreshold"
      );
    }

    if (
      !Number.isFinite(this.config.reorderThreshold) ||
      this.config.reorderThreshold < 0
    ) {
      throw new Error(
        "reorderThreshold must be a finite number >= 0"
      );
    }

    const maxHotness = 1 / (1 - this.config.decay);
    const EPSILON = 1e-9;

    if (
      (rawConfig?.warmThreshold !== undefined ||
        this.config.warmThreshold >= maxHotness - EPSILON) &&
      this.config.warmThreshold >= maxHotness - EPSILON
    ) {
      throw new Error(
        `warmThreshold (${this.config.warmThreshold}) is unreachable with decay ${this.config.decay}; max possible hotness is ${maxHotness}`
      );
    }

    if (
      (rawConfig?.hotThreshold !== undefined ||
        this.config.hotThreshold >= maxHotness - EPSILON) &&
      this.config.hotThreshold >= maxHotness - EPSILON
    ) {
      throw new Error(
        `hotThreshold (${this.config.hotThreshold}) is unreachable with decay ${this.config.decay}; max possible hotness is ${maxHotness}`
      );
    }
  }

  // ==========================================================
  // SET
  // ==========================================================

  /**
   * Insert a new key or replace the value of an existing key.
   *
   * Updating an existing value does NOT count as an access.
   */
  set(key: K, value: V): void {
    const existing = this.index.get(key);

    if (existing) {
      existing.value = value;
      return;
    }

    const node: Node<K, V> = {
      key,
      value,

      hotness: 1,

      lastUpdated: this.now(),

      zone: "cold",

      prev: null,
      next: null,
    };

    this.index.set(key, node);

    this.pushFront(node, "cold");
  }

  // ==========================================================
  // GET
  // ==========================================================

  /**
   * Lookup a value.
   *
   * Map lookup is O(1) average.
   *
   * Hotness update is O(1).
   *
   * Reordering is locally O(k), where k is the number
   * of positions the node moves.
   */
  get(key: K): V | undefined {
    const node = this.index.get(key);

    if (!node) {
      this.stats.misses++;
      return undefined;
    }

    this.stats.hits++;

    this.updateHotness(node);

    this.rebalance(node);

    return node.value;
  }

  // ==========================================================
  // HAS
  // ==========================================================

  /**
   * Check whether a key exists.
   *
   * O(1) average.
   *
   * Does NOT affect hotness.
   */
  has(key: K): boolean {
    return this.index.has(key);
  }

  // ==========================================================
  // DELETE
  // ==========================================================

  /**
   * Delete an item.
   *
   * O(1).
   */
  delete(key: K): boolean {
    const node = this.index.get(key);

    if (!node) {
      return false;
    }

    this.removeFromList(node);

    this.index.delete(key);

    return true;
  }

  // ==========================================================
  // CLEAR
  // ==========================================================

  /**
   * Remove all entries and reset linked lists.
   */
  clear(): void {
    this.index.clear();
    this.lists.cold = { head: null, tail: null, size: 0 };
    this.lists.warm = { head: null, tail: null, size: 0 };
    this.lists.hot = { head: null, tail: null, size: 0 };
  }

  // ==========================================================
  // SIZE
  // ==========================================================

  get size(): number {
    return this.index.size;
  }

  // ==========================================================
  // GET ZONE
  // ==========================================================

  /**
   * Get current zone of a key.
   */
  getZone(key: K): Zone | undefined {
    return this.index.get(key)?.zone;
  }

  // ==========================================================
  // GET STATS
  // ==========================================================

  /**
   * Return a snapshot of operational telemetry statistics.
   */
  getStats(): SalmonStats {
    return { ...this.stats };
  }

  /**
   * Reset all telemetry statistics to zero.
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      promotions: 0,
      demotions: 0,
      reorders: 0,
      comparisons: 0,
    };
  }

  // ==========================================================
  // TICK
  // ==========================================================

  /**
   * Advance logical time by delta units (seconds).
   */
  tick(delta: number = 1): void {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new Error("delta must be a finite number >= 0");
    }
    this.logicalTime += delta;
  }

  // ==========================================================
  // GET HOTNESS
  // ==========================================================

  /**
   * Get current effective hotness.
   *
   * This is read-only.
   *
   * It does NOT:
   * - update stored hotness
   * - update timestamp
   * - move zones
   */
  getHotness(key: K): number | undefined {
    const node = this.index.get(key);

    if (!node) {
      return undefined;
    }

    return this.effectiveHotness(node);
  }

  // ==========================================================
  // DUMP
  // ==========================================================

  /**
   * Inspect all zones.
   */
  dump(): {
    cold: Array<{ key: K; hotness: number }>;
    warm: Array<{ key: K; hotness: number }>;
    hot: Array<{ key: K; hotness: number }>;
  } {
    return {
      cold: this.dumpList("cold"),
      warm: this.dumpList("warm"),
      hot: this.dumpList("hot"),
    };
  }

  // ==========================================================
  // HOTNESS
  // ==========================================================

  /**
   * Increase hotness after an access.
   *
   * First applies lazy decay.
   *
   * Then adds one access.
   */
  private updateHotness(node: Node<K, V>): void {
    const current = this.effectiveHotness(node);

    node.hotness = current + 1;

    node.lastUpdated = this.now();
  }

  /**
   * Calculate the effective hotness using lazy
   * exponential decay.
   *
   * Formula:
   *
   * effectiveHotness =
   *   storedHotness * decay ^ elapsedSeconds
   */
  private effectiveHotness(
    node: Node<K, V>
  ): number {
    const elapsedSeconds =
      this.now() - node.lastUpdated;

    if (elapsedSeconds <= 0) {
      return node.hotness;
    }

    const score =
      node.hotness *
      Math.pow(
        this.config.decay,
        elapsedSeconds
      );

    // Prevent tiny floating-point negative/NaN issues.
    if (!Number.isFinite(score) || score < 0) {
      return 0;
    }

    return score;
  }

  // ==========================================================
  // REBALANCING
  // ==========================================================

  private rebalance(
    node: Node<K, V>
  ): void {
    /**
     * updateHotness() has already synchronized
     * node.hotness with current time.
     */
    const score = node.hotness;

    const targetZone =
      this.getTargetZone(score);

    // Move between zones if required.
    if (targetZone !== node.zone) {
      this.moveToZone(
        node,
        targetZone
      );

      return;
    }

    // Otherwise reorder locally.
    this.reorderInsideZone(node);
  }

  // ==========================================================
  // TARGET ZONE
  // ==========================================================

  private getTargetZone(
    score: number
  ): Zone {
    if (
      score >=
      this.config.hotThreshold
    ) {
      return "hot";
    }

    if (
      score >=
      this.config.warmThreshold
    ) {
      return "warm";
    }

    return "cold";
  }

  private zoneRank(zone: Zone): number {
    switch (zone) {
      case "cold":
        return 0;
      case "warm":
        return 1;
      case "hot":
        return 2;
    }
  }

  // ==========================================================
  // MOVE ZONE
  // ==========================================================

  private moveToZone(
    node: Node<K, V>,
    zone: Zone
  ): void {
    const oldRank = this.zoneRank(node.zone);
    const newRank = this.zoneRank(zone);

    if (newRank > oldRank) {
      this.stats.promotions++;
    } else if (newRank < oldRank) {
      this.stats.demotions++;
    }

    this.removeFromList(node);

    this.pushFront(
      node,
      zone
    );
  }

  // ==========================================================
  // LOCAL REORDER
  // ==========================================================

  /**
   * Move a node forward while it is sufficiently
   * hotter than its predecessor.
   *
   * Each swap is O(1).
   */
  private reorderInsideZone(
    node: Node<K, V>
  ): void {
    while (node.prev) {
      const previous =
        node.prev;

      this.stats.comparisons++;

      const nodeScore =
        this.effectiveHotness(node);

      const previousScore =
        this.effectiveHotness(previous);

      const difference =
        nodeScore - previousScore;

      if (
        difference <
        this.config.reorderThreshold
      ) {
        break;
      }

      this.swapWithPrevious(node);
    }
  }

  // ==========================================================
  // PUSH FRONT
  // ==========================================================

  private pushFront(
    node: Node<K, V>,
    zone: Zone
  ): void {
    const list =
      this.lists[zone];

    node.zone = zone;

    node.prev = null;

    node.next =
      list.head;

    if (list.head) {
      list.head.prev =
        node;
    } else {
      list.tail =
        node;
    }

    list.head =
      node;

    list.size++;
  }

  // ==========================================================
  // REMOVE
  // ==========================================================

  private removeFromList(
    node: Node<K, V>
  ): void {
    const list =
      this.lists[node.zone];

    if (node.prev) {
      node.prev.next =
        node.next;
    } else {
      list.head =
        node.next;
    }

    if (node.next) {
      node.next.prev =
        node.prev;
    } else {
      list.tail =
        node.prev;
    }

    node.prev = null;
    node.next = null;

    list.size--;

    // Defensive protection.
    if (list.size < 0) {
      list.size = 0;

      throw new Error(
        `List size became negative for zone ${node.zone}`
      );
    }
  }

  // ==========================================================
  // SWAP WITH PREVIOUS
  // ==========================================================

  /**
   * Swap:
   *
   * before <-> previous <-> node <-> after
   *
   * into:
   *
   * before <-> node <-> previous <-> after
   *
   * O(1).
   */
  private swapWithPrevious(
    node: Node<K, V>
  ): void {
    const previous =
      node.prev;

    if (!previous) {
      return;
    }

    this.stats.reorders++;

    const before =
      previous.prev;

    const after =
      node.next;

    const list =
      this.lists[node.zone];

    // node
    node.prev =
      before;

    node.next =
      previous;

    // previous
    previous.prev =
      node;

    previous.next =
      after;

    // before
    if (before) {
      before.next =
        node;
    } else {
      list.head =
        node;
    }

    // after
    if (after) {
      after.prev =
        previous;
    } else {
      list.tail =
        previous;
    }
  }

  // ==========================================================
  // DUMP LIST
  // ==========================================================

  private dumpList(
    zone: Zone
  ): Array<{
    key: K;
    hotness: number;
  }> {
    const result: Array<{
      key: K;
      hotness: number;
    }> = [];

    let current =
      this.lists[zone].head;

    while (current) {
      result.push({
        key: current.key,

        hotness: Number(
          this.effectiveHotness(
            current
          ).toFixed(2)
        ),
      });

      current =
        current.next;
    }

    return result;
  }

  // ==========================================================
  // STRUCTURE VALIDATION
  // ==========================================================

  /**
   * Deep structural integrity validation.
   *
   * Checks:
   *
   * - linked-list head/tail consistency
   * - prev pointers
   * - next pointers
   * - node zones
   * - list sizes
   * - duplicate nodes
   * - Map/list consistency
   * - node key consistency
   * - circular list protection
   */
  validateStructure(): StructureValidation {
    const errors: string[] = [];

    let totalNodes = 0;

    const zoneSizes: Record<
      Zone,
      number
    > = {
      cold: 0,
      warm: 0,
      hot: 0,
    };

    const visited =
      new Set<Node<K, V>>();

    const validateList = (
      zone: Zone
    ): void => {
      const list =
        this.lists[zone];

      let current =
        list.head;

      let previous:
        Node<K, V> | null =
        null;

      let count = 0;

      // ------------------------------------------------------
      // Empty-list consistency
      // ------------------------------------------------------

      if (
        !list.head &&
        list.tail
      ) {
        errors.push(
          `${zone}: head is null but tail is not null`
        );
      }

      if (
        !list.tail &&
        list.head
      ) {
        errors.push(
          `${zone}: tail is null but head is not null`
        );
      }

      // ------------------------------------------------------
      // Traverse
      // ------------------------------------------------------

      while (current) {
        count++;
        totalNodes++;

        // ----------------------------------------------------
        // Circular-list protection
        // ----------------------------------------------------

        if (
          count >
          this.index.size + 1
        ) {
          errors.push(
            `${zone}: possible circular linked list detected`
          );

          break;
        }

        // ----------------------------------------------------
        // Duplicate node
        // ----------------------------------------------------

        if (
          visited.has(current)
        ) {
          errors.push(
            `${zone}: duplicate node detected for key ${String(
              current.key
            )}`
          );
        }

        visited.add(current);

        // ----------------------------------------------------
        // Zone consistency
        // ----------------------------------------------------

        if (
          current.zone !== zone
        ) {
          errors.push(
            `${zone}: node ${String(
              current.key
            )} has zone ${current.zone}`
          );
        }

        // ----------------------------------------------------
        // Previous pointer
        // ----------------------------------------------------

        if (
          current.prev !==
          previous
        ) {
          errors.push(
            `${zone}: broken prev pointer at key ${String(
              current.key
            )}`
          );
        }

        // ----------------------------------------------------
        // Next pointer
        // ----------------------------------------------------

        if (
          current.next &&
          current.next.prev !==
          current
        ) {
          errors.push(
            `${zone}: broken next.prev pointer at key ${String(
              current.key
            )}`
          );
        }

        previous =
          current;

        current =
          current.next;
      }

      // ------------------------------------------------------
      // Tail consistency
      // ------------------------------------------------------

      if (
        previous !==
        list.tail
      ) {
        errors.push(
          `${zone}: tail pointer is incorrect`
        );
      }

      // ------------------------------------------------------
      // Stored size
      // ------------------------------------------------------

      if (
        count !==
        list.size
      ) {
        errors.push(
          `${zone}: stored size ${list.size} !== actual size ${count}`
        );
      }

      zoneSizes[zone] =
        count;
    };

    // Validate every zone.
    validateList("cold");
    validateList("warm");
    validateList("hot");

    // ========================================================
    // MAP <-> LIST CONSISTENCY
    // ========================================================

    if (
      totalNodes !==
      this.index.size
    ) {
      errors.push(
        `Map size ${this.index.size} !== list node count ${totalNodes}`
      );
    }

    for (
      const [key, node]
      of this.index
    ) {
      // Node must exist in a list.
      if (
        !visited.has(node)
      ) {
        errors.push(
          `Map node ${String(
            key
          )} is missing from linked lists`
        );
      }

      // Map key must match node key.
      if (
        node.key !== key
      ) {
        errors.push(
          `Map key ${String(
            key
          )} does not match node key ${String(
            node.key
          )}`
        );
      }
    }

    return {
      valid:
        errors.length === 0,

      mapSize:
        this.index.size,

      listSize:
        totalNodes,

      zoneSizes,

      errors,
    };
  }
}

export default Salmon;