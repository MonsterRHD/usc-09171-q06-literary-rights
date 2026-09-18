import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { RightsService } from "../src/domain/service.mjs";
import { JsonlEventStore } from "../src/store/jsonl-store.mjs";

export function tempService(clock = () => "2026-09-17") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rights-"));
  const file = path.join(dir, "events.jsonl");
  const store = new JsonlEventStore(file);
  const service = new RightsService(store, clock);
  service.tmpDir = dir;
  service.file = file;
  service.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return service;
}

// 重新打开同一日志，模拟服务重启
export function restart(service, clock) {
  return new RightsService(new JsonlEventStore(service.file), clock ?? (() => "2026-09-17"));
}

export async function expectReject(promise, code) {
  let error;
  try { await promise; } catch (e) { error = e; }
  if (!error) throw new Error("应当抛错但没有");
  if (code && error.code !== code) throw new Error(`期望错误码 ${code}，实际 ${error.code}: ${error.message}`);
  return error;
}

// 搭建：作品 → 角色 → 插画，各层权利人
export async function seedCatalogue(svc, opts = {}) {
  await svc.registerAsset({ kind: "work", ref: "w", title: "作品", holders: ["heir"] });
  await svc.registerAsset({ kind: "character", ref: "c", title: "角色", holders: ["heir"], derived_from: ["w"] });
  await svc.registerAsset({ kind: "image", ref: "img", title: "插画", urls: ["https://x/a.jpg"], holders: ["artist"], derived_from: ["c"] });

  const SCOPE = (over = {}) => ({
    media: ["online-product-image"], territories: ["CN"], channels: ["online-store"],
    max_quantity: null, sublicense: true, ...over,
  });

  if (opts.chain !== false) {
    await svc.recordGrant({ source_id: "g-w", asset_ref: "w", grantor_ref: "heir", grantee_ref: "pub", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: SCOPE() });
    await svc.recordGrant({ source_id: "g-c", asset_ref: "c", grantor_ref: "heir", grantee_ref: "pub", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: SCOPE() });
    await svc.recordGrant({ source_id: "g-img", asset_ref: "img", grantor_ref: "artist", grantee_ref: "pub", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: SCOPE() });
    await svc.recordGrant({ source_id: "l-w", asset_ref: "w", grantor_ref: "pub", grantee_ref: "vendor", parent_source_id: "g-w", valid_from: "2026-02-01", valid_to: "2026-12-01", scope: SCOPE({ sublicense: false }) });
    await svc.recordGrant({ source_id: "l-c", asset_ref: "c", grantor_ref: "pub", grantee_ref: "vendor", parent_source_id: "g-c", valid_from: "2026-02-01", valid_to: "2026-12-01", scope: SCOPE({ sublicense: false }) });
    await svc.recordGrant({ source_id: "l-img", asset_ref: "img", grantor_ref: "pub", grantee_ref: "vendor", parent_source_id: "g-img", valid_from: "2026-02-01", valid_to: "2026-12-01", scope: SCOPE({ sublicense: false }) });
  }
  return { SCOPE };
}

export async function issueFullCert(svc, scope) {
  const certScope = scope ?? { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 1000, sublicense: false };
  await svc.submitProposal({ proposal_id: "p1", party: "vendor", asset_refs: ["img"], scope: certScope, valid_from: "2026-02-01", valid_to: "2026-12-01" });
  await svc.createContract({ contract_id: "ctr1", proposal_id: "p1", approver_roles: ["legal", "finance"] });
  await svc.addContractVersion({ contract_id: "ctr1", version_no: 1, source_ids: ["g-w", "l-w", "g-c", "l-c", "g-img", "l-img"], royalty: { rate: 0.1, minimum_guarantee: 5000 }, created_on: "2026-01-20" });
  await svc.recordApproval({ contract_id: "ctr1", version_no: 1, role: "legal", approver: "u1", at: "2026-01-21" });
  await svc.recordApproval({ contract_id: "ctr1", version_no: 1, role: "finance", approver: "u2", at: "2026-01-21" });
  const r = await svc.issueCertificate({ proposal_id: "p1", contract_id: "ctr1", issued_on: "2026-01-22" });
  return r.cert_id;
}
