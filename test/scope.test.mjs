import assert from "node:assert/strict";
import test from "node:test";
import { coverageGaps, normalizeTime, scopeOverlap, withinTerm } from "../src/scope.mjs";

test("闭开区间：起始日可用，结束日起不可用", () => {
  const from = normalizeTime("2026-01-01");
  const to = normalizeTime("2027-01-01");
  assert.equal(withinTerm(from, to, normalizeTime("2026-01-01")), true);
  assert.equal(withinTerm(from, to, normalizeTime("2026-12-31")), true);
  assert.equal(withinTerm(from, to, normalizeTime("2027-01-01")), false);
  assert.equal(withinTerm(from, to, normalizeTime("2025-12-31")), false);
});

test("缺失维度不代表无限授权", () => {
  const grant = {
    valid_from: normalizeTime("2026-01-01"),
    valid_to: normalizeTime("2027-01-01"),
    media: ["exhibition"],
    // 未声明 territories / channels / quantity / sublicense
  };
  const gaps = coverageGaps(grant, {
    at: normalizeTime("2026-06-01"),
    media: "exhibition",
    territory: "CN",
    channel: "e-commerce",
    quantity: 1,
    sublicense: true,
  });
  assert.equal(gaps.length, 4);
  assert.ok(gaps.some((g) => g.includes("地区未授予")));
  assert.ok(gaps.some((g) => g.includes("渠道未授予")));
  assert.ok(gaps.some((g) => g.includes("数量维度未授予")));
  assert.ok(gaps.some((g) => g.includes("再许可未授予")));
});

test("覆盖判断：所有维度满足才没有缺口", () => {
  const grant = {
    valid_from: normalizeTime("2026-01-01"),
    valid_to: normalizeTime("2027-01-01"),
    media: ["exhibition", "online"],
    territories: ["CN"],
    channels: ["e-commerce"],
    quantity: 100,
    sublicense: true,
  };
  const ok = coverageGaps(grant, {
    at: normalizeTime("2026-06-01"),
    media: "online",
    territory: "CN",
    channel: "e-commerce",
    quantity: 100,
    sublicense: true,
  });
  assert.deepEqual(ok, []);
  const tooMany = coverageGaps(grant, { quantity: 101 });
  assert.ok(tooMany.some((g) => g.includes("数量不足")));
});

test("独家窗口相交按闭开区间处理，首尾相接不冲突", () => {
  const base = { media: ["online"], territories: ["CN"], channels: ["e-commerce"] };
  const a = { ...base, valid_from: normalizeTime("2026-01-01"), valid_to: normalizeTime("2027-01-01") };
  const adjacent = { ...base, valid_from: normalizeTime("2027-01-01"), valid_to: normalizeTime("2028-01-01") };
  assert.equal(scopeOverlap(a, adjacent), null);
  const overlapping = { ...base, valid_from: normalizeTime("2026-06-01"), valid_to: normalizeTime("2028-01-01") };
  const overlap = scopeOverlap(a, overlapping);
  assert.deepEqual(overlap.window, { from: normalizeTime("2026-06-01"), to: normalizeTime("2027-01-01") });
  // 任一维度不相交即不冲突
  const otherMedia = { ...overlapping, media: ["print"] };
  assert.equal(scopeOverlap(a, otherMedia), null);
});
