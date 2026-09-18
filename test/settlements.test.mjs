import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE, addFullSources, fullFlow, makeServer, registerLineage } from "./helpers.mjs";

const GRANT = { media: ["online"], territories: ["CN"], channels: ["e-commerce"], quantity: 100000 };

async function settledFixture(t) {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const flow = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: GRANT,
    window: ["2026-01-01", "2027-01-01"],
    royalty: { rate: 0.1, minimum_guarantee: 5000 },
  });
  const sale = (at, quantity, gross) =>
    api("POST", "/usages", {
      credential_id: flow.credential.credential_id,
      asset_ref: IMAGE,
      at,
      kind: "sale",
      quantity,
      gross_amount: gross,
      media: "online",
      territory: "CN",
      channel: "e-commerce",
    });
  const returnGoods = (at, quantity, amount) =>
    api("POST", "/usages", {
      credential_id: flow.credential.credential_id,
      asset_ref: IMAGE,
      at,
      kind: "return",
      quantity,
      gross_amount: amount,
    });
  return { api, flow, sale, returnGoods };
}

test("跨月结算：有效条款 + 最低保证 + 退回产品生成版税差额", async (t) => {
  const { api, flow, sale, returnGoods } = await settledFixture(t);
  // 一月：销售 60000，退回 10000，版税恰好等于最低保证
  await sale("2026-01-10", 100, 60000);
  await returnGoods("2026-01-20", 20, 10000);
  const janRes = await api("POST", "/settlements/run", { contract_id: flow.contractId, period: "2026-01" });
  assert.equal(janRes.status, 201);
  const jan = janRes.body.settlement;
  assert.equal(jan.status, "draft");
  assert.equal(jan.contract_version, 1);
  assert.equal(jan.totals.gross_amount, 60000);
  assert.equal(jan.totals.returns_amount, 10000);
  assert.equal(jan.totals.net_amount, 50000);
  assert.equal(jan.totals.royalty_due, 5000);
  assert.equal(jan.totals.minimum_guarantee, 5000);
  assert.equal(jan.totals.difference, 0);
  assert.equal(jan.totals.amount_due, 0);
  assert.equal(jan.lines.length, 1);
  assert.equal(jan.lines[0].sales_quantity, 100);
  assert.equal(jan.lines[0].returns_quantity, 20);

  // 草稿重跑幂等，不生成第二份
  const rerun = await api("POST", "/settlements/run", { contract_id: flow.contractId, period: "2026-01" });
  assert.equal(rerun.status, 200);
  assert.equal(rerun.body.settlement.settlement_id, jan.settlement_id);

  // 二月：版税超过最低保证，差额为应补缴部分
  await sale("2026-02-10", 150, 100000);
  const feb = (await api("POST", "/settlements/run", { contract_id: flow.contractId, period: "2026-02" })).body.settlement;
  assert.equal(feb.totals.royalty_due, 10000);
  assert.equal(feb.totals.difference, 5000);
  assert.equal(feb.totals.amount_due, 5000);
  // 一月的退回不计入二月
  assert.equal(feb.totals.returns_amount, 0);

  // 确认后不能重跑，只能更正
  await api("POST", `/settlements/${jan.settlement_id}/confirm`);
  const conflicted = await api("POST", "/settlements/run", { contract_id: flow.contractId, period: "2026-01" });
  assert.equal(conflicted.status, 409);

  // 更正只追加记录，原始结算不被修改
  const correction = await api("POST", `/settlements/${jan.settlement_id}/corrections`, {
    reason: "补录一月底退回产品",
    returns_delta: 5000,
  });
  assert.equal(correction.status, 201);
  assert.equal(correction.body.resulting_totals.net_amount, 45000);
  assert.equal(correction.body.resulting_totals.royalty_due, 4500);
  assert.equal(correction.body.resulting_totals.difference, -500);
  assert.equal(correction.body.resulting_totals.amount_due, 0);

  const view = await api("GET", `/settlements/${jan.settlement_id}`);
  assert.equal(view.body.totals.net_amount, 50000);
  assert.equal(view.body.corrections.length, 1);
  assert.equal(view.body.corrections[0].reason, "补录一月底退回产品");
  assert.equal(view.body.corrected_totals.net_amount, 45000);
});

test("无有效条款的期间不能结算", async (t) => {
  const { api, flow } = await settledFixture(t);
  const res = await api("POST", "/settlements/run", { contract_id: flow.contractId, period: "2025-01" });
  assert.equal(res.status, 422);
});
