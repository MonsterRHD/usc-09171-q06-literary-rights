import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createApp } from "../src/app.mjs";

export const FIXED_NOW = "2026-09-17T00:00:00.000Z";
export const IMAGE = "illustration:character-a:pose-7";
export const TRANSLATION = "translation:chapter-3:paragraph-2";

// 启动一个使用临时状态文件的服务；seed=true 时装载仓库自带的权利来源样例。
export async function makeServer(t, { now = FIXED_NOW, seed = false, storePath } = {}) {
  const file = storePath ?? path.join(await fs.mkdtemp(path.join(os.tmpdir(), "rights-test-")), "state.json");
  const app = await createApp({ storePath: file, now: () => now, seedFile: seed ? undefined : null });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (method, requestPath, body) => {
    const response = await fetch(`${base}${requestPath}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  };
  return { app, api, base, storePath: file };
}

// 作品 -> 角色 -> 插画、作品 -> 译本 的来源关系。
export async function registerLineage(api) {
  await api("POST", "/assets", { asset_ref: "work:novel-a", type: "work", holder_ref: "holder-author" });
  await api("POST", "/assets", { asset_ref: "character:a", type: "character", holder_ref: "holder-author", derived_from: ["work:novel-a"] });
  await api("POST", "/assets", { asset_ref: IMAGE, type: "image", holder_ref: "holder-artist-b", derived_from: ["character:a"] });
  await api("POST", "/assets", { asset_ref: TRANSLATION, type: "translation", holder_ref: "holder-translator-a", derived_from: ["work:novel-a"] });
}

const FULL_SCOPE = {
  media: ["exhibition", "online"],
  territories: ["CN"],
  channels: ["offline", "e-commerce"],
  quantity: 100000,
  sublicense: true,
};

// 四位权利人的完整来源声明；skip 可用来模拟「补签材料晚到」。
export async function addFullSources(api, { skip = [] } = {}) {
  const sources = [
    { source_id: "src-work", asset_ref: "work:novel-a", holder_ref: "holder-author", valid_from: "2025-01-01", valid_to: "2030-01-01", scope: FULL_SCOPE },
    { source_id: "src-character", asset_ref: "character:a", holder_ref: "holder-author", valid_from: "2025-01-01", valid_to: "2030-01-01", scope: FULL_SCOPE },
    { source_id: "src-image", asset_ref: IMAGE, holder_ref: "holder-artist-b", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: FULL_SCOPE },
    { source_id: "src-translation", asset_ref: TRANSLATION, holder_ref: "holder-translator-a", valid_from: "2025-01-01", valid_to: "2030-01-01", scope: FULL_SCOPE },
  ];
  for (const source of sources) {
    if (!skip.includes(source.source_id)) await api("POST", "/rights-sources", source);
  }
}

// 走完 方案 -> 合同 -> 审批 -> 凭证 的全流程。
export async function fullFlow(
  api,
  { assetRef, grantScope, window, royalty = { rate: 0.1, minimum_guarantee: 5000 }, licensee = "vendor-c", exclusive = false },
) {
  const proposalRes = await api("POST", "/proposals", {
    licensee_ref: licensee,
    asset_refs: [assetRef],
    requested_scope: {
      media: grantScope.media,
      territories: grantScope.territories,
      channels: grantScope.channels,
      valid_from: window[0],
      valid_to: window[1],
      quantity: grantScope.quantity,
      sublicense: grantScope["sublicense"] ?? false,
      exclusive,
    },
  });
  const proposal = proposalRes.body.proposal;
  const contractRes = await api("POST", "/contracts", {
    proposal_id: proposal.proposal_id,
    effective_from: window[0],
    effective_to: window[1],
    grants: [{ asset_ref: assetRef, scope: grantScope }],
    royalty,
    required_approvals: ["legal", "rights"],
  });
  const contractId = contractRes.body.contract.contract_id;
  await api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "legal", approver: "user-legal" });
  await api("POST", `/contracts/${contractId}/versions/1/approvals`, { step: "rights", approver: "user-rights" });
  const credentialRes = await api("POST", "/credentials", { proposal_id: proposal.proposal_id });
  return {
    proposal,
    contractId,
    contractRes,
    credential: credentialRes.body.credential,
  };
}
