import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/app.mjs";
import { tempService, seedCatalogue, issueFullCert } from "./helpers.mjs";

async function withServer(svc) {
  const server = createServer(svc);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, urlPath, body, headers = {}) => {
    const res = await fetch(base + urlPath, {
      method,
      headers: body ? { "content-type": "application/json", ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { call, close, base };
}

test("健康检查", async () => {
  const svc = tempService();
  const { call, close } = await withServer(svc);
  const r = await call("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.service, "literary-rights");
  await close();
  svc.cleanup();
});

test("判断入口：按 URL 查询线上图片，返回可用性、依据合同与缺失同意", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  const certId = await issueFullCert(svc);
  const { call, close } = await withServer(svc);

  const qs = new URLSearchParams({ url: "https://x/a.jpg", date: "2026-03-15", media: "online-product-image", territory: "CN", channel: "online-store", party: "vendor" });
  const ok = await call("GET", `/v1/evaluate?${qs}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.usable, true);
  assert.equal(ok.json.certificate.cert_id, certId);
  assert.ok(ok.json.contract_basis.some((b) => b.contract_id === "ctr1"));

  // 事故厂商：无授权链、无凭证
  const qs2 = new URLSearchParams({ ref: "img", date: "2026-09-01", media: "physical-merchandise", territory: "CN", channel: "online-store", party: "stage-vendor" });
  const bad = await call("GET", `/v1/evaluate?${qs2}`);
  assert.equal(bad.status, 200);
  assert.equal(bad.json.usable, false);
  assert.ok(bad.json.missing_consents.length >= 1);
  assert.ok(bad.json.blocking_reasons.includes("NO_CERTIFICATE"));

  await close();
  svc.cleanup();
});

test("并发 POST 带同一 Idempotency-Key 只落一条授权", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  const { call, close } = await withServer(svc);
  const body = { source_id: "http-1", asset_ref: "img", grantor_ref: "artist", grantee_ref: "pub", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 1, sublicense: true } };
  const results = await Promise.all([
    call("POST", "/v1/grants", body, { "idempotency-key": "abc" }),
    call("POST", "/v1/grants", body, { "idempotency-key": "abc" }),
  ]);
  assert.equal(results[0].status, 201);
  assert.equal(results[1].json.duplicate, true);
  assert.equal(svc.getState().grants.size, 7);
  await close();
  svc.cleanup();
});

test("未完整批准即请求签发：400 并指明缺失角色", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  await svc.submitProposal({ proposal_id: "p1", party: "vendor", asset_refs: ["img"], scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 1000, sublicense: false }, valid_from: "2026-02-01", valid_to: "2026-12-01" });
  await svc.createContract({ contract_id: "ctr1", proposal_id: "p1", approver_roles: ["legal", "finance"] });
  await svc.addContractVersion({ contract_id: "ctr1", version_no: 1, source_ids: ["g-w", "l-w", "g-c", "l-c", "g-img", "l-img"], royalty: { rate: 0.1, minimum_guarantee: 0 } });
  const { call, close } = await withServer(svc);
  const r = await call("POST", "/v1/certificates/issue", { proposal_id: "p1", contract_id: "ctr1" });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.includes("审批链"));
  assert.deepEqual(r.json.details.required_roles, ["legal", "finance"]);
  await close();
  svc.cleanup();
});

test("查询参数缺失渠道：400，不做无限推定", async () => {
  const svc = tempService();
  const { call, close } = await withServer(svc);
  const qs = new URLSearchParams({ ref: "img", date: "2026-03-15", media: "x", territory: "CN", party: "v" });
  const r = await call("GET", `/v1/evaluate?${qs}`);
  assert.equal(r.status, 400);
  assert.ok(r.json.message.includes("channel"));
  await close();
  svc.cleanup();
});
