import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScope, validateScope, dimensionGaps, intersectScopes, scopeContains } from "../src/domain/scope.mjs";

test("缺失维度不代表无限授权：空 channels 即未授权任何渠道", () => {
  const scope = normalizeScope({ media: ["exhibition"], territories: ["CN"] });
  assert.deepEqual(scope.channels, []);
  const req = { media: "exhibition", territory: "CN", channel: "online-store" };
  assert.deepEqual(dimensionGaps(scope, req), ["CHANNEL_NOT_LICENSED", "QUANTITY_NOT_LICENSED"]);
  assert.equal(scopeContains(scope, req), false);
});

test("max_quantity 缺失与显式 null 严格区分", () => {
  const errors = validateScope(normalizeScope({ media: ["x"], territories: ["CN"], channels: ["c"] }));
  assert.ok(errors.some((e) => e.includes("max_quantity")));
  assert.equal(validateScope(normalizeScope({ media: ["x"], territories: ["CN"], channels: ["c"], max_quantity: null })).length, 0);
});

test("交集严格裁剪：任一维度不相交即为空", () => {
  const a = normalizeScope({ media: ["exhibition", "physical-merchandise"], territories: ["CN"], channels: ["onsite"], max_quantity: 500, sublicense: true });
  const b = normalizeScope({ media: ["physical-merchandise", "online-product-image"], territories: ["CN"], channels: ["onsite"], max_quantity: 300, sublicense: true });
  const hit = intersectScopes(a, b);
  assert.deepEqual(hit.media, ["physical-merchandise"]);
  assert.equal(hit.max_quantity, 300);

  const c = normalizeScope({ media: ["online-product-image"], territories: ["US"], channels: ["online-store"], max_quantity: 10, sublicense: true });
  assert.deepEqual(intersectScopes(a, c).territories, []);
});

test("sublicense 默认 false，缺失不得视为允许再许可", () => {
  assert.equal(normalizeScope({}).sublicense, false);
});
