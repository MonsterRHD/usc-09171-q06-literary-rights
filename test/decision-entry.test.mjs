import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE, TRANSLATION, addFullSources, fullFlow, makeServer, registerLineage } from "./helpers.mjs";

test("判断入口：境内短期展陈授权不能支持长期线上销售", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  // 厂商 C 只拿到 2026 年第一季度、CN、线下展陈的授权
  const { credential, contractId } = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: { media: ["exhibition"], territories: ["CN"], channels: ["offline"], quantity: 500 },
    window: ["2026-01-01", "2026-04-01"],
  });
  // 法务在 2026-09-17 查询：这张插画被用于线上长期销售
  const res = await api("POST", "/decisions", {
    credential_id: credential.credential_id,
    asset_ref: IMAGE,
    as_of: "2026-09-17",
    usage: { media: "online", territory: "CN", channel: "e-commerce", quantity: 1 },
  });
  assert.equal(res.status, 201);
  const judgment = res.body;
  assert.equal(judgment.decision, "deny");
  // 说明依据哪份合同、哪张凭证
  assert.equal(judgment.basis.contract_id, contractId);
  assert.equal(judgment.basis.credential_id, credential.credential_id);
  // 媒介、渠道、期限三个维度都越界
  assert.ok(judgment.reasons.some((r) => r.includes("媒介未授予：online")));
  assert.ok(judgment.reasons.some((r) => r.includes("渠道未授予：e-commerce")));
  assert.ok(judgment.reasons.some((r) => r.includes("期限未覆盖")));
});

test("判断入口：授权齐全时放行并给出完整依据", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const { credential, contractId } = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: { media: ["online"], territories: ["CN"], channels: ["e-commerce"], quantity: 1000 },
    window: ["2026-01-01", "2027-01-01"],
  });
  const res = await api("POST", "/decisions", {
    credential_id: credential.credential_id,
    asset_ref: IMAGE,
    as_of: "2026-09-17",
    usage: { media: "online", territory: "CN", channel: "e-commerce", quantity: 1 },
  });
  const judgment = res.body;
  assert.equal(judgment.decision, "permit");
  assert.equal(judgment.basis.contract_id, contractId);
  assert.equal(judgment.basis.contract_version, 1);
  // 依据一路追溯到作品本身的权利来源
  assert.deepEqual([...judgment.basis.rights_source_ids].sort(), ["src-character", "src-image", "src-work"]);
  assert.deepEqual(judgment.missing_consents, []);
});

test("判断入口：指出缺少哪位权利人的同意", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  // 插画师的授权材料尚未到位
  await addFullSources(api, { skip: ["src-image"] });
  const { credential } = await fullFlow(api, {
    assetRef: IMAGE,
    grantScope: { media: ["online"], territories: ["CN"], channels: ["e-commerce"], quantity: 1000 },
    window: ["2026-01-01", "2027-01-01"],
  });
  const res = await api("POST", "/decisions", {
    credential_id: credential.credential_id,
    asset_ref: IMAGE,
    as_of: "2026-06-01",
    usage: { media: "online", territory: "CN", channel: "e-commerce", quantity: 1 },
  });
  const judgment = res.body;
  assert.equal(judgment.decision, "deny");
  const missing = judgment.missing_consents.find((m) => m.asset_ref === IMAGE);
  assert.equal(missing.holder_ref, "holder-artist-b");
  assert.deepEqual(missing.gaps, ["没有任何权利来源声明"]);
});

test("判断入口：被授权方没有任何凭证时也能说明缺什么", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const res = await api("POST", "/decisions", {
    licensee_ref: "vendor-unknown",
    asset_ref: IMAGE,
    as_of: "2026-06-01",
    usage: { media: "online", territory: "CN", channel: "e-commerce", quantity: 1 },
  });
  const judgment = res.body;
  assert.equal(judgment.decision, "deny");
  assert.ok(judgment.reasons.some((r) => r.includes("不存在覆盖该使用的有效凭证")));
  // 权利来源齐全，缺的只是合同与凭证
  assert.deepEqual(judgment.missing_consents, []);
});

test("仓库既有样例：缺失渠道维度不等于无限授权", async (t) => {
  const { api } = await makeServer(t, { seed: true });
  await api("POST", "/assets", { asset_ref: "work:seed", type: "work", holder_ref: "holder-author" });
  await api("POST", "/assets", { asset_ref: TRANSLATION, type: "translation", holder_ref: "holder-translator-a", derived_from: ["work:seed"] });
  // 样例中译者声明只有 exhibition 媒介、CN 地区，没有渠道与数量维度
  const res = await api("POST", "/decisions", {
    licensee_ref: "vendor-c",
    asset_ref: TRANSLATION,
    as_of: "2026-06-01",
    usage: { media: "exhibition", territory: "CN", channel: "e-commerce", quantity: 1 },
  });
  const judgment = res.body;
  assert.equal(judgment.decision, "deny");
  const missing = judgment.missing_consents.find((m) => m.asset_ref === TRANSLATION);
  assert.equal(missing.holder_ref, "holder-translator-a");
  assert.ok(missing.gaps.some((g) => g.includes("渠道未授予")));
  assert.ok(missing.gaps.some((g) => g.includes("数量维度未授予")));
});

test("未知路由与非法 JSON", async (t) => {
  const { api, base } = await makeServer(t);
  const missing = await api("GET", "/nope");
  assert.equal(missing.status, 404);
  const raw = await fetch(`${base}/assets`, { method: "POST", body: "not-json" });
  assert.equal(raw.status, 400);
});
