import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE, addFullSources, fullFlow, makeServer, registerLineage } from "./helpers.mjs";

const FULL_GRANT = { media: ["online"], territories: ["CN"], channels: ["e-commerce"], quantity: 1000 };

test("补签材料晚到：只追加新判断，当时的拒绝结论不变", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  // 插画师的授权材料晚到
  await addFullSources(api, { skip: ["src-image"] });
  const { credential } = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: FULL_GRANT,
    window: ["2026-01-01", "2027-01-01"],
  });
  const query = {
    credential_id: credential.credential_id,
    asset_ref: IMAGE,
    as_of: "2026-06-01",
    usage: { media: "online", territory: "CN", channel: "e-commerce", quantity: 1 },
  };
  const denied = (await api("POST", "/decisions", query)).body;
  assert.equal(denied.decision, "deny");
  assert.ok(denied.missing_consents.some((m) => m.holder_ref === "holder-artist-b"));

  // 补签材料晚到（有效期覆盖查询日期），再次查询得到许可
  await api("POST", "/rights-sources", {
    source_id: "src-image",
    asset_ref: IMAGE,
    holder_ref: "holder-artist-b",
    valid_from: "2026-01-01",
    valid_to: "2027-01-01",
    scope: { media: ["exhibition", "online"], territories: ["CN"], channels: ["offline", "e-commerce"], quantity: 100000, sublicense: true },
  });
  const permitted = (await api("POST", "/decisions", query)).body;
  assert.equal(permitted.decision, "permit");
  assert.notEqual(denied.judgment_id, permitted.judgment_id);

  // 当时的拒绝结论保持原样
  const original = await api("GET", `/judgments/${denied.judgment_id}`);
  assert.deepEqual(original.body, denied);
});

test("合同回溯生效：只追加新判断，当时的结论不变", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  // v1 只授予线下展陈
  const { credential, contractId } = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: { media: ["exhibition"], territories: ["CN"], channels: ["offline"], quantity: 500 },
    window: ["2026-01-01", "2027-01-01"],
  });
  const query = {
    credential_id: credential.credential_id,
    asset_ref: IMAGE,
    as_of: "2026-06-01",
    usage: { media: "online", territory: "CN", channel: "e-commerce", quantity: 1 },
  };
  const denied = (await api("POST", "/decisions", query)).body;
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reasons.some((r) => r.includes("媒介未授予：online")));

  // 合同 v2 把线上电商纳入，生效日回溯到 2026-01-01
  await api("POST", `/contracts/${contractId}/versions`, {
    effective_from: "2026-01-01",
    effective_to: "2027-01-01",
    grants: [
      {
        asset_ref: IMAGE,
        scope: { media: ["exhibition", "online"], territories: ["CN"], channels: ["offline", "e-commerce"], quantity: 500 },
      },
    ],
    royalty: { rate: 0.1, minimum_guarantee: 5000 },
    required_approvals: ["legal", "rights"],
  });
  await api("POST", `/contracts/${contractId}/versions/2/approvals`, { step: "legal", approver: "user-legal" });
  await api("POST", `/contracts/${contractId}/versions/2/approvals`, { step: "rights", approver: "user-rights" });

  const permitted = (await api("POST", "/decisions", query)).body;
  assert.equal(permitted.decision, "permit");
  assert.equal(permitted.basis.contract_version, 2);

  // 当时的拒绝结论保持原样
  const original = await api("GET", `/judgments/${denied.judgment_id}`);
  assert.deepEqual(original.body, denied);
});

test("超量使用被拒绝且不记录用量", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const { credential } = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: { ...FULL_GRANT, quantity: 2 },
    window: ["2026-01-01", "2027-01-01"],
  });
  const sale = (quantity) =>
    api("POST", "/usages", {
      credential_id: credential.credential_id,
      asset_ref: IMAGE,
      at: "2026-06-01",
      kind: "sale",
      quantity,
      gross_amount: 100,
      media: "online",
      territory: "CN",
      channel: "e-commerce",
    });
  const first = await sale(2);
  assert.equal(first.body.judgment.decision, "permit");
  const second = await sale(1);
  assert.equal(second.body.judgment.decision, "deny");
  assert.ok(second.body.judgment.reasons.some((r) => r.includes("超量")));
  // 被拒绝的使用不占用数量
  const usages = await api("GET", `/usages?credential_id=${credential.credential_id}`);
  assert.equal(usages.body.length, 1);
  assert.equal(usages.body[0].quantity, 2);
});

test("到期（闭开区间右端点）起使用被拒绝", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const { credential } = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: FULL_GRANT,
    window: ["2026-01-01", "2026-07-01"],
  });
  const res = await api("POST", "/decisions", {
    credential_id: credential.credential_id,
    asset_ref: IMAGE,
    as_of: "2026-07-01",
    usage: { media: "online", territory: "CN", channel: "e-commerce", quantity: 1 },
  });
  assert.equal(res.body.decision, "deny");
  assert.ok(res.body.reasons.some((r) => r.includes("生效") || r.includes("期限")));
});

test("素材领取与样稿都经过同一个判断入口", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const { credential } = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: FULL_GRANT,
    window: ["2026-01-01", "2027-01-01"],
  });
  const pickup = await api("POST", "/material-pickups", { credential_id: credential.credential_id, asset_ref: IMAGE, at: "2026-06-01" });
  assert.equal(pickup.body.kind, "material-pickup");
  assert.equal(pickup.body.decision, "permit");
  const sample = await api("POST", "/sample-drafts", { credential_id: credential.credential_id, asset_ref: IMAGE, at: "2026-06-01" });
  assert.equal(sample.body.kind, "sample-draft");
  assert.equal(sample.body.decision, "permit");
  // 合同窗口之外，领取同样被拒绝
  const expired = await api("POST", "/material-pickups", { credential_id: credential.credential_id, asset_ref: IMAGE, at: "2027-06-01" });
  assert.equal(expired.body.decision, "deny");
  assert.ok(expired.body.reasons.length > 0);
});
