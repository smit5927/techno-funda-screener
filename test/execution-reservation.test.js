import test from "node:test";
import assert from "node:assert/strict";

import { confirmedEntryFillQuantity } from "../src/trade-journal.js";

test("confirmed one-share order fills through a small 09:17 opening gap", () => {
  assert.equal(confirmedEntryFillQuantity({
    reservedQuantity: 1,
    reservedAllocation: 5001.9,
    cashCapacity: 100000,
    riskCapacity: 1000,
    fillPrice: 5033.5,
    riskPerShare: 94.29
  }), 1);
});

test("confirmed order never exceeds approved quantity or available cash and risk", () => {
  assert.equal(confirmedEntryFillQuantity({
    reservedQuantity: 10,
    reservedAllocation: 10000,
    cashCapacity: 4200,
    riskCapacity: 250,
    fillPrice: 1050,
    riskPerShare: 100
  }), 2);
});

test("confirmed order remains blocked when the 09:17 gap exceeds tolerance", () => {
  assert.equal(confirmedEntryFillQuantity({
    reservedQuantity: 1,
    reservedAllocation: 5000,
    cashCapacity: 100000,
    riskCapacity: 1000,
    fillPrice: 5400,
    riskPerShare: 100
  }), 0);
});
