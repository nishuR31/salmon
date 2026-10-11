import { describe, expect, test } from "bun:test";
import { Salmon } from "./salmon";

describe("Salmon", () => {
  test("uses the Map for exact lookup", () => {
    const s = new Salmon<string, number>();
    s.set("a", 10);

    expect(s.get("a")).toBe(10);
    expect(s.get("missing")).toBeUndefined();
    expect(s.has("a")).toBe(true);
    expect(s.has("missing")).toBe(false);
  });

  test("updates an existing value without duplicating the node", () => {
    const s = new Salmon<string, number>();
    s.set("a", 1);
    s.set("a", 2);

    expect(s.size).toBe(1);
    expect(s.get("a")).toBe(2);
  });

  test("promotes a frequently accessed key", () => {
    const s = new Salmon<string, number>({
      decay: 0.95,
      warmThreshold: 5,
      hotThreshold: 14,
    });

    s.set("a", 1);

    for (let i = 0; i < 30; i++) s.get("a");

    expect(s.getZone("a")).toBe("hot");
    expect(s.getStats().promotions).toBeGreaterThan(0);
  });

  test("lazy decay reduces old activity", () => {
    const s = new Salmon<string, number>({ decay: 0.9 });
    s.set("a", 1);

    for (let i = 0; i < 10; i++) s.get("a");

    const before = s.getHotness("a")!;
    s.tick(10);
    const after = s.getHotness("a")!;

    expect(after).toBeLessThan(before);
  });

  test("clear removes all nodes and resets list sizes", () => {
    const s = new Salmon<string, number>();
    s.set("a", 1);
    s.set("b", 2);
    s.clear();

    expect(s.size).toBe(0);
    expect(s.has("a")).toBe(false);
    expect(s.dump()).toEqual({ cold: [], warm: [], hot: [] });
  });

  test("rejects an unreachable HOT threshold", () => {
    expect(() =>
      new Salmon({
        decay: 0.95,
        warmThreshold: 5,
        hotThreshold: 20,
      })
    ).toThrow();
  });

  test("deletes keys across cold, warm, and hot zones while preserving list integrity", () => {
    const s = new Salmon<string, number>({
      decay: 0.95,
      warmThreshold: 3,
      hotThreshold: 8,
    });

    s.set("cold1", 1);
    s.set("cold2", 2);
    s.set("warm1", 3);
    s.set("hot1", 4);

    // Promote warm1
    for (let i = 0; i < 5; i++) s.get("warm1");
    // Promote hot1
    for (let i = 0; i < 15; i++) s.get("hot1");

    expect(s.getZone("cold1")).toBe("cold");
    expect(s.getZone("warm1")).toBe("warm");
    expect(s.getZone("hot1")).toBe("hot");

    // Delete cold node
    expect(s.delete("cold1")).toBe(true);
    expect(s.has("cold1")).toBe(false);
    expect(s.get("cold1")).toBeUndefined();
    expect(s.validateStructure().valid).toBe(true);

    // Delete warm node
    expect(s.delete("warm1")).toBe(true);
    expect(s.has("warm1")).toBe(false);
    expect(s.validateStructure().valid).toBe(true);

    // Delete hot node
    expect(s.delete("hot1")).toBe(true);
    expect(s.has("hot1")).toBe(false);
    expect(s.validateStructure().valid).toBe(true);

    // Delete missing
    expect(s.delete("nonexistent")).toBe(false);
    expect(s.size).toBe(1); // Only cold2 remains
  });

  test("demotes a decayed hot key when accessed after elapsed time", () => {
    const s = new Salmon<string, number>({
      decay: 0.5,
      warmThreshold: 1.5,
      hotThreshold: 1.8,
    });

    s.set("item", 100);
    // Pump into hot zone
    for (let i = 0; i < 10; i++) s.get("item");
    expect(s.getZone("item")).toBe("hot");

    // Advance time significantly so score drops below hot/warm thresholds
    s.tick(10);
    expect(s.getHotness("item")!).toBeLessThan(0.1);

    // Accessing now triggers updateHotness (score = decayed + 1 = ~1.0)
    // 1.0 is below warmThreshold (1.5), so it should be demoted to cold
    s.get("item");
    expect(s.getZone("item")).toBe("cold");
    expect(s.getStats().demotions).toBeGreaterThan(0);
    expect(s.validateStructure().valid).toBe(true);
  });

  test("reorders items inside a zone when score differential exceeds reorderThreshold", () => {
    const s = new Salmon<string, number>({
      decay: 0.999,
      warmThreshold: 20,
      hotThreshold: 50,
      reorderThreshold: 1,
    });

    s.set("first", 1);
    s.set("second", 2);
    // Both are in cold zone. In insertion order, "second" is head, "first" is tail.
    expect(s.dump().cold.map((n) => n.key)).toEqual(["second", "first"]);

    // Repeatedly touch "first" so its score overtakes "second"
    for (let i = 0; i < 5; i++) s.get("first");

    // "first" should have moved ahead of "second"
    expect(s.dump().cold.map((n) => n.key)).toEqual(["first", "second"]);
    expect(s.getStats().reorders).toBeGreaterThan(0);
    expect(s.validateStructure().valid).toBe(true);
  });

  test("maintains structural integrity under randomized stress fuzzing", () => {
    const s = new Salmon<number, number>({
      decay: 0.99,
      warmThreshold: 3,
      hotThreshold: 10,
      reorderThreshold: 1,
    });

    const KEY_SPACE = 50;
    for (let op = 0; op < 2000; op++) {
      const key = Math.floor(Math.random() * KEY_SPACE);
      const action = Math.random();

      if (action < 0.4) {
        s.set(key, op);
      } else if (action < 0.8) {
        s.get(key);
      } else if (action < 0.9) {
        s.delete(key);
      } else {
        s.tick(Math.random() * 2);
      }
    }

    const check = s.validateStructure();
    expect(check.valid).toBe(true);
    expect(check.errors).toEqual([]);
    expect(check.mapSize).toBe(s.size);
    expect(check.listSize).toBe(s.size);
  });

  test("evicts coldest keys automatically when maxCapacity is exceeded", () => {
    const s = new Salmon<string, number>({
      decay: 0.95,
      warmThreshold: 3,
      hotThreshold: 8,
      maxCapacity: 3,
    });

    s.set("k1", 1);
    s.set("k2", 2);
    s.set("k3", 3);

    // Make k1 hot
    for (let i = 0; i < 15; i++) s.get("k1");
    // Make k2 warm
    for (let i = 0; i < 5; i++) s.get("k2");
    // k3 is untouched, remains cold at tail

    expect(s.getZone("k1")).toBe("hot");
    expect(s.getZone("k2")).toBe("warm");
    expect(s.getZone("k3")).toBe("cold");

    // Inserting 4th item must trigger eviction of k3 (cold tail)
    s.set("k4", 4);

    expect(s.size).toBe(3);
    expect(s.has("k3")).toBe(false); // Cold item evicted!
    expect(s.has("k1")).toBe(true);  // Hot item protected
    expect(s.has("k2")).toBe(true);  // Warm item protected
    expect(s.has("k4")).toBe(true);
    expect(s.getStats().evictions).toBe(1);
    expect(s.validateStructure().valid).toBe(true);
  });

  test("getOrSet and fetch cache-aside helpers resolve repeated calls without refetching", async () => {
    const s = new Salmon<string, string>({
      decay: 0.95,
      warmThreshold: 3,
      hotThreshold: 8,
    });

    let syncFetches = 0;
    const getter = (key: string) => {
      syncFetches++;
      return `val_${key}`;
    };

    // First call calls factory
    const v1 = s.getOrSet("user:101", getter);
    expect(v1).toBe("val_user:101");
    expect(syncFetches).toBe(1);

    // Repeated call uses cache directly
    const v2 = s.getOrSet("user:101", getter);
    expect(v2).toBe("val_user:101");
    expect(syncFetches).toBe(1); // Not called again!

    let asyncFetches = 0;
    const asyncFetcher = async (key: string) => {
      asyncFetches++;
      return `async_${key}`;
    };

    // First async call
    const a1 = await s.fetch("product:99", asyncFetcher);
    expect(a1).toBe("async_product:99");
    expect(asyncFetches).toBe(1);

    // Repeated async call uses cache
    const a2 = await s.fetch("product:99", asyncFetcher);
    expect(a2).toBe("async_product:99");
    expect(asyncFetches).toBe(1); // Not called again!

    // Verify it learned and promoted product:99
    expect(s.getHotness("product:99")!).toBeGreaterThan(1);
  });
});


