import assert from "node:assert/strict";
import test from "node:test";
import { tempService, seedCatalogue, issueFullCert, expectReject } from "./helpers.mjs";

const Q = (over = {}) => ({
  ref: "img", date: "2026-03-15", media: "online-product-image",
  territory: "CN", channel: "online-store", party: "vendor", ...over,
});

test("完整再许可链 + 有效凭证：判断可用并给出合同依据", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  const certId = await issueFullCert(svc);

  const r = await svc.evaluate(Q());
  assert.equal(r.usable, true);
  assert.equal(r.rights_covered, true);
  assert.equal(r.certificate.cert_id, certId);
  assert.ok(r.contract_basis.some((b) => b.contract_id === "ctr1" && b.version_no === 1));
  // 来源链逐层给出 root->leaf
  const imgLayer = r.asset_layers.find((l) => l.asset_ref === "img");
  assert.equal(imgLayer.valid_chains[0][0].grantor_ref, "artist");
  assert.equal(imgLayer.valid_chains[0].at(-1).grantee_ref, "vendor");
  svc.cleanup();
});

test("境内短期展陈权不得用于长期线上销售：渠道与期限双重阻断", async () => {
  const svc = tempService();
  await svc.registerAsset({ kind: "work", ref: "w", title: "作品", holders: ["heir"] });
  await svc.registerAsset({ kind: "character", ref: "c", title: "角色", holders: ["heir"], derived_from: ["w"] });
  await svc.registerAsset({ kind: "image", ref: "img", title: "插画", urls: ["https://x/a.jpg"], holders: ["artist"], derived_from: ["c"] });
  const onsite = { media: ["exhibition"], territories: ["CN"], channels: ["onsite"], max_quantity: 500, sublicense: true };
  await svc.recordGrant({ source_id: "r1", asset_ref: "img", grantor_ref: "artist", grantee_ref: "pub", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: onsite });
  await svc.recordGrant({ source_id: "l1", asset_ref: "img", grantor_ref: "pub", grantee_ref: "vendor", parent_source_id: "r1", valid_from: "2026-03-01", valid_to: "2026-04-01", scope: { ...onsite, sublicense: false } });

  // 展陈期内、线下 onsite：图片层本身有链，但作品/角色层无授权
  const during = await svc.evaluate(Q({ date: "2026-03-15", media: "exhibition", channel: "onsite" }));
  assert.equal(during.usable, false);
  assert.deepEqual(during.missing_consents.map((m) => m.asset_ref).sort(), ["c", "w"]);
  assert.equal(during.certificate_ok, false);

  // 线上店长期销售：渠道未授权
  const online = await svc.evaluate(Q({ date: "2026-09-01" }));
  assert.equal(online.usable, false);
  assert.ok(online.blocking_reasons.includes("CHANNEL_NOT_LICENSED"));
  assert.ok(online.blocking_reasons.includes("EXPIRED"));
  svc.cleanup();
});

test("缺少哪位权利人的同意要逐层点名", async () => {
  const svc = tempService();
  await seedCatalogue(svc, { chain: false });
  // 只给图片层授权，作品/角色层缺席
  await svc.recordGrant({ source_id: "g-img", asset_ref: "img", grantor_ref: "artist", grantee_ref: "pub", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: null, sublicense: true } });
  await svc.recordGrant({ source_id: "l-img", asset_ref: "img", grantor_ref: "pub", grantee_ref: "vendor", parent_source_id: "g-img", valid_from: "2026-02-01", valid_to: "2026-12-01", scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: null, sublicense: false } });
  const r = await svc.evaluate(Q());
  assert.equal(r.rights_covered, false);
  const byAsset = Object.fromEntries(r.missing_consents.map((m) => [m.asset_ref, m.holder_refs]));
  assert.deepEqual(byAsset.w, ["heir"]);
  assert.deepEqual(byAsset.c, ["heir"]);
  assert.equal(byAsset.img, undefined); // 图片层 artist 已同意
  svc.cleanup();
});

test("上游未允许 sublicense 时再许可链断裂", async () => {
  const svc = tempService();
  await seedCatalogue(svc, { chain: false });
  const scope = { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: null, sublicense: false };
  await svc.recordGrant({ source_id: "g-img", asset_ref: "img", grantor_ref: "artist", grantee_ref: "pub", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: { ...scope, sublicense: false } });
  await expectReject(
    svc.recordGrant({ source_id: "l-img", asset_ref: "img", grantor_ref: "pub", grantee_ref: "vendor", parent_source_id: "g-img", valid_from: "2026-02-01", valid_to: "2026-12-01", scope }),
    "INVALID"
  );
  svc.cleanup();
});

test("审批链与合同版本完全一致后才签发；旧版本批准不延续到新版本", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  await svc.submitProposal({ proposal_id: "p1", party: "vendor", asset_refs: ["img"], scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 1000, sublicense: false }, valid_from: "2026-02-01", valid_to: "2026-12-01" });
  await svc.createContract({ contract_id: "ctr1", proposal_id: "p1", approver_roles: ["legal", "finance"] });
  await svc.addContractVersion({ contract_id: "ctr1", version_no: 1, source_ids: ["g-img"], royalty: { rate: 0.1, minimum_guarantee: 0 } });
  await svc.recordApproval({ contract_id: "ctr1", version_no: 1, role: "legal", approver: "u1" });
  // 只有一个角色批准：拒绝签发
  await expectReject(svc.issueCertificate({ proposal_id: "p1", contract_id: "ctr1" }), "INVALID");

  // 升到 v2，legal 在 v1 的批准不延续
  await svc.addContractVersion({ contract_id: "ctr1", version_no: 2, source_ids: ["g-w", "l-w", "g-c", "l-c", "g-img", "l-img"], royalty: { rate: 0.1, minimum_guarantee: 0 } });
  await expectReject(svc.issueCertificate({ proposal_id: "p1", contract_id: "ctr1", version_no: 2 }), "INVALID");
  await svc.recordApproval({ contract_id: "ctr1", version_no: 2, role: "legal", approver: "u1" });
  await svc.recordApproval({ contract_id: "ctr1", version_no: 2, role: "finance", approver: "u2" });
  const r = await svc.issueCertificate({ proposal_id: "p1", contract_id: "ctr1", version_no: 2 });
  assert.ok(r.cert_id.startsWith("cert_"));
  svc.cleanup();
});

test("并发提交相同方案只产生一张有效凭证", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  await svc.submitProposal({ proposal_id: "p1", party: "vendor", asset_refs: ["img"], scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 1000, sublicense: false }, valid_from: "2026-02-01", valid_to: "2026-12-01" });
  await svc.createContract({ contract_id: "ctr1", proposal_id: "p1", approver_roles: ["legal"] });
  await svc.addContractVersion({ contract_id: "ctr1", version_no: 1, source_ids: ["g-w", "l-w", "g-c", "l-c", "g-img", "l-img"], royalty: { rate: 0.1, minimum_guarantee: 0 } });
  await svc.recordApproval({ contract_id: "ctr1", version_no: 1, role: "legal", approver: "u1" });

  const results = await Promise.allSettled([
    svc.issueCertificate({ proposal_id: "p1", contract_id: "ctr1" }),
    svc.issueCertificate({ proposal_id: "p1", contract_id: "ctr1" }),
    svc.issueCertificate({ proposal_id: "p1", contract_id: "ctr1" }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 2);
  assert.equal(svc.getState().certificates.size, 1);
  svc.cleanup();
});

test("服务重启后唯一索引随回放重建，仍不能签发第二张凭证", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  const certId = await issueFullCert(svc);

  // 重新打开同一日志：状态完整重建，不新增任何凭证
  const reborn = await (async () => {
    const { RightsService } = await import("../src/domain/service.mjs");
    const { JsonlEventStore } = await import("../src/store/jsonl-store.mjs");
    return new RightsService(new JsonlEventStore(svc.file), () => "2026-09-17");
  })();
  assert.equal(reborn.getState().certificates.size, 1);
  assert.equal(reborn.getState().activeCertByProposal.get("p1"), certId);

  // 重启后重复签发同一方案：冲突，凭证数仍为 1
  await expectReject(reborn.issueCertificate({ proposal_id: "p1", contract_id: "ctr1" }), "CONFLICT");
  assert.equal(reborn.getState().certificates.size, 1);
  svc.cleanup();
});

test("撤销与到期只追加新判断，不改写当时结论；补签回溯打 retroactive 标记", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  const certId = await issueFullCert(svc);

  // 有效期内：可用
  const d1 = await svc.evaluate(Q({ date: "2026-03-15" }));
  assert.equal(d1.usable, true);

  // 对 05-02 先给出"可用"结论
  const before = await svc.evaluate(Q({ date: "2026-05-02" }));
  assert.equal(before.usable, true);

  // 撤销生效日 05-01：只追加事件
  await svc.revokeCertificate({ cert_id: certId, on_date: "2026-05-01", reason: "违约转售" });

  // 同一问题（as-of 05-02）再判断：新结论取代旧结论
  const d2 = await svc.evaluate(Q({ date: "2026-05-02" }));
  assert.equal(d2.usable, false);
  assert.ok(d2.blocking_reasons.includes("CERT_REVOKED"));

  // 旧结论原样可查，新结论以 supersedes 链指向它
  const hist = svc.decisionHistory(Q({ date: "2026-05-02" }));
  assert.equal(hist.history.length, 2);
  assert.notEqual(hist.history[0].decision_id, hist.history[1].decision_id);
  assert.equal(hist.history[1].supersedes_decision_id, hist.history[0].decision_id);

  // 撤销不改写撤销日之前的当时结论
  const d1Again = await svc.evaluate(Q({ date: "2026-03-15" }));
  assert.equal(d1Again.usable, true);
  svc.cleanup();
});

test("数量上限：领取+样稿+实际使用累计，超量被拒且评估标记 QUANTITY_EXCEEDED", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  const certId = await issueFullCert(svc, { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 100, sublicense: false });
  await svc.pickupMaterial({ cert_id: certId, quantity: 30, on_date: "2026-02-05" });
  await svc.recordSample({ cert_id: certId, quantity: 20, on_date: "2026-02-08" });
  await svc.recordUsage({ cert_id: certId, quantity: 50, on_date: "2026-03-01" });
  await expectReject(svc.recordUsage({ cert_id: certId, quantity: 1, on_date: "2026-03-02" }), "CONFLICT");

  const r = await svc.evaluate(Q({ date: "2026-03-02" }));
  assert.equal(r.usable, false);
  assert.ok(r.blocking_reasons.includes("QUANTITY_EXCEEDED"));
  assert.equal(r.certificate.used_quantity, 100);
  svc.cleanup();
});

test("第三方独家窗口在签约前被发现", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  await svc.recordGrant({ source_id: "excl", asset_ref: "c", grantor_ref: "pub", grantee_ref: "rival", parent_source_id: "g-c", valid_from: "2026-06-01", valid_to: "2026-08-01", scope: { media: ["online-product-image"], territories: ["CN"], channels: ["social-media"], max_quantity: null, sublicense: false, exclusive: true } });
  const r = svc.checkExclusivity({
    party: "vendor", asset_refs: ["c"],
    scope: { media: ["online-product-image"], territories: ["CN"], channels: ["social-media"], max_quantity: null, sublicense: false, exclusive: true },
    valid_from: "2026-06-15", valid_to: "2026-07-15",
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].source_id, "excl");
  // 不重叠的窗口/渠道无冲突
  const r2 = svc.checkExclusivity({
    party: "vendor", asset_refs: ["c"],
    scope: { media: ["online-product-image"], territories: ["CN"], channels: ["social-media"], max_quantity: null, sublicense: false, exclusive: true },
    valid_from: "2026-08-01", valid_to: "2026-09-01", // 闭开相接
  });
  assert.equal(r2.conflicts.length, 0);
  svc.cleanup();
});

test("补签材料晚到、合同回溯生效：新结论追加并打 retroactive 标记，旧结论保留", async () => {
  const svc = tempService(() => "2026-09-10");
  await svc.registerAsset({ kind: "image", ref: "poster", title: "海报", urls: ["https://x/p.jpg"], holders: ["artist-c"], derived_from: [] });

  // 7 月使用当时：无任何授权
  const before = await svc.evaluate(Q({ ref: "poster", date: "2026-07-15" }));
  assert.equal(before.usable, false);
  assert.ok(before.blocking_reasons.includes("MISSING_CONSENT"));

  // 9 月补签：授权区间回溯到 6 月，记录日晚于使用日
  await svc.recordGrant({ source_id: "gr-root", asset_ref: "poster", grantor_ref: "artist-c", grantee_ref: "pub", valid_from: "2026-06-01", valid_to: "2027-06-01", recorded_on: "2026-09-02", scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: null, sublicense: true } });
  await svc.recordGrant({ source_id: "gr-leaf", asset_ref: "poster", grantor_ref: "pub", grantee_ref: "vendor", parent_source_id: "gr-root", valid_from: "2026-06-01", valid_to: "2027-01-01", recorded_on: "2026-09-05", scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 200, sublicense: false } });
  await svc.submitProposal({ proposal_id: "pr", party: "vendor", asset_refs: ["poster"], scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 200, sublicense: false }, valid_from: "2026-06-01", valid_to: "2027-01-01" });
  await svc.createContract({ contract_id: "ct", proposal_id: "pr", approver_roles: ["legal"] });
  await svc.addContractVersion({ contract_id: "ct", version_no: 1, source_ids: ["gr-root", "gr-leaf"], royalty: { rate: 0.1, minimum_guarantee: 0 }, created_on: "2026-09-08" });
  await svc.recordApproval({ contract_id: "ct", version_no: 1, role: "legal", approver: "u1", at: "2026-09-08" });
  await svc.issueCertificate({ proposal_id: "pr", contract_id: "ct", issued_on: "2026-09-10" });

  // 同一问题重新判断：结论翻转，但标记为回溯依据
  const after = await svc.evaluate(Q({ ref: "poster", date: "2026-07-15" }));
  assert.equal(after.usable, true);
  assert.equal(after.retroactive_basis, true);
  assert.equal(after.supersedes ?? null, null, "结果对象不携带旧 id，但事件链上有");

  // 历史链：旧结论仍在，新结论 supersedes 旧结论
  const hist = svc.decisionHistory(Q({ ref: "poster", date: "2026-07-15" }));
  assert.equal(hist.history.length, 2);
  assert.equal(hist.history[0].result.usable, false);
  assert.equal(hist.history[1].result.usable, true);
  assert.equal(hist.history[1].supersedes_decision_id, hist.history[0].decision_id);
  svc.cleanup();
});

test("幂等键：重复提交不产生第二条事件", async () => {
  const svc = tempService();
  await seedCatalogue(svc);
  const input = { source_id: "dup-1", asset_ref: "img", grantor_ref: "artist", grantee_ref: "pub", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 1, sublicense: true }, idempotency_key: "k-1" };
  await svc.recordGrant(input);
  const again = await svc.recordGrant(input);
  assert.equal(again.duplicate, true);
  assert.equal(svc.getState().grants.size, 7); // 6 条链 + 1
  svc.cleanup();
});
