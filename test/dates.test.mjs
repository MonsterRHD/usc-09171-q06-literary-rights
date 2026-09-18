import assert from "node:assert/strict";
import test from "node:test";
import { coversDay, rangesOverlap, monthOf, lastDayOfMonth } from "../src/domain/dates.mjs";

test("闭开区间：起点含、终点不含", () => {
  assert.equal(coversDay("2026-01-01", "2026-01-01", "2026-04-01"), true);
  assert.equal(coversDay("2026-03-31", "2026-01-01", "2026-04-01"), true);
  assert.equal(coversDay("2026-04-01", "2026-01-01", "2026-04-01"), false); // 终点当日已失效
  assert.equal(coversDay("2025-12-31", "2026-01-01", "2026-04-01"), false);
  assert.equal(coversDay("2030-01-01", "2025-01-01", "2030-01-01"), false);
  assert.equal(coversDay("2099-01-01", "2025-01-01", null), true); // null = 显式无固定期限
});

test("区间相交按闭开语义：首尾相接不相交", () => {
  assert.equal(rangesOverlap("2026-03-01", "2026-04-01", "2026-04-01", "2026-05-01"), false);
  assert.equal(rangesOverlap("2026-03-01", "2026-04-02", "2026-04-01", "2026-05-01"), true);
  assert.equal(rangesOverlap("2026-01-01", null, "2030-01-01", null), true);
});

test("月份工具", () => {
  assert.equal(monthOf("2026-03-31"), "2026-03");
  assert.equal(lastDayOfMonth("2026-02"), "2026-02-28");
  assert.equal(lastDayOfMonth("2024-02"), "2024-02-29");
});
