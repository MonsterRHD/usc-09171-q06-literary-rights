import assert from "node:assert/strict";
import test from "node:test";
import { tempService, seedCatalogue, issueFullCert, expectReject } from "./helpers.mjs";

async function settledFixture() {
  const svc = tempService();
  await seedCatalogue(svc);
  const certId = await issueFullCert(svc); // rate 0.1, MG 5000
  return { svc, certId };
}

test("版税 = max(净销售×税率, 最低保证)，退货冲减净销售", async () => {
  const { svc, certId } = await settledFixture();
  await svc.recordSale({ cert_id: certId, on_date: "2026-03-20", units: 100, returned_units: 10, gross_amount: 100000, returned_amount: 10000 });
  const r = await svc.confirmSettlement({ cert_id: certId, month: "2026-03", already_paid: 5000 });
  const p = r.events[0].payload;
  assert.equal(p.net_sales, 90000);
  assert.equal(p.royalty_from_sales, 9000);
  assert.equal(p.payable_royalty, 9000);      // 高于最低保证
  assert.equal(p.balance_due, 4000);

  // 四月销售低迷：触发最低保证
  await svc.recordSale({ cert_id: certId, on_date: "2026-04-15", units: 10, gross_amount: 20000, returned_amount: 0 });
  const r2 = await svc.confirmSettlement({ cert_id: certId, month: "2026-04", already_paid: 0 });
  assert.equal(r2.events[0].payload.payable_royalty, 5000);
  svc.cleanup();
});

test("已确认结算不可改写；补录退货只能追加可追溯更正", async () => {
  const { svc, certId } = await settledFixture();
  await svc.recordSale({ cert_id: certId, on_date: "2026-03-20", units: 100, gross_amount: 100000, returned_amount: 0 });
  const first = await svc.confirmSettlement({ cert_id: certId, month: "2026-03", already_paid: 0 });
  assert.equal(first.events[0].payload.payable_royalty, 10000);

  // 重复确认被拒
  await expectReject(svc.confirmSettlement({ cert_id: certId, month: "2026-03" }), "CONFLICT");

  // 五月补录归属三月的退货
  await svc.recordSale({ cert_id: certId, on_date: "2026-05-03", units: 0, returned_units: 50, gross_amount: 0, returned_amount: 60000, period_month: "2026-03" });
  const corr = await svc.correctSettlement({ cert_id: certId, month: "2026-03", reason: "补录退货" });
  const cp = corr.events[0].payload;
  assert.equal(cp.net_sales, 40000);
  assert.equal(cp.payable_royalty, 5000); // 重算后落到最低保证
  assert.equal(cp.correction_delta, -5000); // 相对原确认 10000 追回

  // 原确认记录原样保留，更正挂在其后
  const entry = svc.getState().settlements.get(`${certId}:2026-03`);
  assert.equal(entry.confirmed.payable_royalty, 10000);
  assert.equal(entry.corrections.length, 1);
  assert.equal(entry.corrections[0].correction_id, cp.correction_id);
  svc.cleanup();
});

test("次月才成立的合同版本不得回溯适用当月结算", async () => {
  const { svc, certId } = await settledFixture();
  await svc.recordSale({ cert_id: certId, on_date: "2026-03-10", units: 1, gross_amount: 100, returned_amount: 0 });
  // 三月能按 v1（1月成立）结算
  const r = await svc.confirmSettlement({ cert_id: certId, month: "2026-03", already_paid: 0 });
  assert.equal(r.events[0].payload.version_no, 1);
  svc.cleanup();
});
