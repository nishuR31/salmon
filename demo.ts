import { Salmon } from "./salmon";

const salmon = new Salmon<string, string>({
  decay: 0.95,
  warmThreshold: 5,
  hotThreshold: 14,
  reorderThreshold: 1,
});

for (const key of ["A", "B", "C", "D", "E"]) {
  salmon.set(key, `value-${key}`);
}

console.log("Initial:", salmon.dump());

// A becomes hot because we repeatedly access it.
for (let i = 0; i < 30; i++) salmon.get("A");

// B is moderately active.
for (let i = 0; i < 10; i++) salmon.get("B");

console.log("\nAfter accesses:");
console.dir(salmon.dump(), { depth: null });

console.log("\nHotness:");
for (const key of ["A", "B", "C", "D", "E"]) {
  console.log(key, salmon.getHotness(key), salmon.getZone(key));
}

console.log("\nStats:", salmon.getStats());

salmon.tick(50);

console.log("\nAfter 50 logical time units:");
for (const key of ["A", "B", "C", "D", "E"]) {
  console.log(key, salmon.getHotness(key), salmon.getZone(key));
}
