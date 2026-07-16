import assert from "node:assert/strict";
import test from "node:test";
import { formatUniverseChanges, universeChanges, validateUniverseSnapshot } from "../src/universe-refresh.js";

test("universe refresh identifies newly listed and removed securities", () => {
  const changes = universeChanges(
    [{ symbol: "OLD" }, { symbol: "KEEP" }],
    [{ symbol: "KEEP" }, { symbol: "NEWIPO" }]
  );
  assert.deepEqual(changes.added, ["NEWIPO"]);
  assert.deepEqual(changes.removed, ["OLD"]);
  assert.match(formatUniverseChanges(changes), /Added 1: NEWIPO/);
  assert.match(formatUniverseChanges(changes), /Removed 1: OLD/);
});

test("universe refresh rejects an empty or corrupt official snapshot", () => {
  assert.throws(
    () => validateUniverseSnapshot([], { label: "Nifty 500", minRows: 450, maxRows: 550 }),
    /Last good file was kept/
  );
  assert.throws(
    () => validateUniverseSnapshot([{ symbol: "ABC" }, { symbol: "ABC" }], { minRows: 1 }),
    /duplicate symbols/
  );
});

test("universe refresh blocks an implausibly large constituent drop", () => {
  const previousRows = Array.from({ length: 500 }, (_, index) => ({ symbol: `OLD${index}` }));
  const nextRows = Array.from({ length: 450 }, (_, index) => ({ symbol: `NEW${index}` }));
  assert.throws(
    () => validateUniverseSnapshot(nextRows, {
      label: "Nifty 500",
      minRows: 400,
      maxRows: 550,
      maxDropPct: 5,
      previousRows
    }),
    /safety limit is 5%/
  );
});
