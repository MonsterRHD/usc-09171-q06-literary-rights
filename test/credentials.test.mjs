import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE, addFullSources, fullFlow, makeServer, registerLineage } from "./helpers.mjs";

const GRANT = { media: ["online"], territories: ["CN"], channels: ["e-commerce"], quantity: 1000 };
const WINDOW = ["2026-01-01", "2027-01-01"];

async function proposalAndContract(api) {
  const proposalRes = await api("POST", "/proposals", {
    licensee_ref: "vendor-c",
    asset_refs: [IMAGE],
    requested_scope: { ...GRANT, valid_from: WINDOW[0], valid_to: WINDOW[1] },
  });
  const proposal = proposalRes.body.proposal;
  const contractRes = await api("POST", "/contracts", {
    proposal_id: proposal.proposal_id,
    effective_from: WINDOW[0],
    effective_to: WINDOW[1],
    grants: [{ asset_ref: IMAGE, scope: GRANT }],
    royalty: { rate: 0.1, minimum_guarantee: 5000 },
    required_approvals: ["legal", "rights"],
  });
  return { proposal, contractId: contractRes.body.contract.contract_id };
}

test("审批链与合同版本完全一致后才签发凭证", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const { proposal, contractId } = await proposalAndContract(api);

  // 未审批，不能签发
  let res = await api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  assert.equal(res.status, 409);
  // 审批环节必须落在版本要求的审批链上
  res = await api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "finance", approver: "x" });
  assert.equal(res.status, 422);
  await api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "legal", approver: "user-legal" });
  // 同一环节不能重复审批
  res = await api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "legal", approver: "user-other" });
  assert.equal(res.status, 409);
  // 审批链仍缺 rights，不能签发
  res = await api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  assert.equal(res.status, 409);
  assert.ok(res.body.error.message.includes("rights"));
  await api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "rights", approver: "user-rights" });
  res = await api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  assert.equal(res.status, 201);
  assert.equal(res.body.credential.contract_version, 1);
  const firstCredential = res.body.credential;

  // 合同修订产生 v2 后，v1 的审批链不算数
  await api("POST", `/contracts/${contractId}/versions`, {
    effective_from: WINDOW[0],
    effective_to: WINDOW[1],
    grants: [{ asset_ref: IMAGE, scope: { ...GRANT, quantity: 2000 } }],
    royalty: { rate: 0.12, minimum_guarantee: 6000 },
    required_approvals: ["legal", "rights"],
  });
  // 旧凭证仍有效时，签发请求幂等返回旧凭证
  res = await api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  assert.equal(res.status, 200);
  assert.equal(res.body.credential.credential_id, firstCredential.credential_id);
  // 旧凭证撤销后，v2 未审批完整仍不能签发新凭证
  await api("POST", `/credentials/${firstCredential.credential_id}/revoke`, { reason: "条款重议" });
  res = await api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  assert.equal(res.status, 409);
  await api("POST", `/contracts/${contractId}/versions/2/approvals`, { step: "legal", approver: "user-legal" });
  await api("POST", `/contracts/${contractId}/versions/2/approvals`, { step: "rights", approver: "user-rights" });
  res = await api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  assert.equal(res.status, 201);
  assert.equal(res.body.credential.contract_version, 2);
  // 任意时刻同一方案只有一张有效凭证
  const valid = await api("GET", `/credentials?proposal_id=${proposal.proposal_id}&status=valid`);
  assert.equal(valid.body.length, 1);
});

test("并发提交同一方案只会签发一张有效凭证", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const { proposal, contractId } = await proposalAndContract(api);
  await api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "legal", approver: "user-legal" });
  await api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "rights", approver: "user-rights" });

  const results = await Promise.all(Array.from({ length: 5 }, () => api("POST", "/credentials", { proposal_id: proposal.proposal_id })));
  const ids = new Set(results.map((r) => r.body.credential.credential_id));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  const valid = await api("GET", `/credentials?proposal_id=${proposal.proposal_id}&status=valid`);
  assert.equal(valid.body.length, 1);
});

test("服务重启后不会制造第二张有效凭证", async (t) => {
  const first = await makeServer(t);
  await registerLineage(first.api);
  await addFullSources(first.api);
  const { proposal, contractId } = await proposalAndContract(first.api);
  await first.api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "legal", approver: "user-legal" });
  await first.api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "rights", approver: "user-rights" });
  const issued = await first.api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  assert.equal(issued.status, 201);

  // 用同一状态文件重新启动服务
  const restarted = await makeServer(t, { storePath: first.storePath });
  const again = await restarted.api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  assert.equal(again.status, 200);
  assert.equal(again.body.credential.credential_id, issued.body.credential.credential_id);
  const valid = await restarted.api("GET", `/credentials?proposal_id=${proposal.proposal_id}&status=valid`);
  assert.equal(valid.body.length, 1);
});

test("撤销只追加判断，历史结论不变", async (t) => {
  const { api } = await makeServer(t);
  await registerLineage(api);
  await addFullSources(api);
  const { credential } = await fullFlow(api, { assetRef: IMAGE, grantScope: GRANT, window: WINDOW });
  const query = {
    credential_id: credential.credential_id,
    asset_ref: IMAGE,
    as_of: "2026-06-01",
    usage: { media: "online", territory: "CN", channel: "e-commerce", quantity: 1 },
  };
  const before = (await api("POST", "/decisions", query)).body;
  assert.equal(before.decision, "permit");

  await api("POST", `/credentials/${credential.credential_id}/revoke`, { reason: "发现超范围使用" });
  const after = (await api("POST", "/decisions", query)).body;
  assert.equal(after.decision, "deny");
  assert.ok(after.reasons.some((r) => r.includes("撤销")));

  // 当时的许可结论保持原样
  const original = await api("GET", `/judgments/${before.judgment_id}`);
  assert.deepEqual(original.body, before);
  // 撤销本身也留下了一条判断
  const judgments = await api("GET", `/judgments?credential_id=${credential.credential_id}`);
  assert.ok(judgments.body.some((j) => j.kind === "revocation"));
});
