import { coversDay, rangesOverlap } from "./dates.mjs";
import { dimensionGaps, scopeContains } from "./scope.mjs";
import { assetClosure } from "./projection.mjs";

// 在指定日期，为指定资产寻找从权利人到被许可方的完整再许可链。
// 链路：权利人(root grantor) ──grants to──▶ … ──grants to──▶ party
// 每一跳的上游授权必须 sublicense=true 且范围/期限覆盖请求；根授权的 grantor 必须是该资产权利人。
export function validGrantChains(state, assetRef, req, date) {
  const chains = [];
  const asset = state.assets.get(assetRef);
  if (!asset) return chains;

  const leaves = [...state.grants.values()].filter(
    (g) => g.asset_ref === assetRef && g.grantee_ref === req.party
  );

  for (const leaf of leaves) {
    const chain = ascend(state, asset, leaf, req, date);
    if (chain) chains.push(chain);
  }
  return chains;
}

function ascend(state, asset, grant, req, date) {
  const chain = [];
  let current = grant;
  const seen = new Set();
  while (current) {
    if (seen.has(current.source_id)) return null; // 环形链
    seen.add(current.source_id);

    if (!coversDay(date, current.valid_from, current.valid_to ?? null)) return null;
    if (!scopeContains(current.scope, req)) return null;

    const isRoot = !current.parent_source_id;
    if (!isRoot) {
      const parent = state.grants.get(current.parent_source_id);
      if (!parent) return null;
      if (parent.grantee_ref !== current.grantor_ref) return null; // 上游被许可方须是本跳授权方
      if (parent.scope.sublicense !== true) return null;           // 上游未允许再许可
      chain.push(current);
      current = parent;
    } else {
      chain.push(current);
      break;
    }
  }
  const root = chain[chain.length - 1];
  if (!asset.holders.has(root.grantor_ref)) return null; // 根授权方不是该资产权利人
  return chain.reverse(); // root -> leaf
}

// 单层资产为什么没有被覆盖（供缺失同意与原因码输出）
function layerGapReasons(state, asset, req, date) {
  const grantsOnAsset = [...state.grants.values()].filter((g) => g.asset_ref === asset.ref);
  const reasons = new Set();
  let chainBroken = false;
  let anyGrant = false;

  for (const g of grantsOnAsset) {
    anyGrant = true;
    if (!coversDay(date, g.valid_from, g.valid_to ?? null)) { reasons.add("EXPIRED"); continue; }
    for (const reason of dimensionGaps(g.scope, req)) reasons.add(reason);
    if (g.grantee_ref === req.party && g.parent_source_id) {
      const parent = state.grants.get(g.parent_source_id);
      if (!parent || parent.grantee_ref !== g.grantor_ref || parent.scope.sublicense !== true) {
        chainBroken = true;
      }
    }
  }
  if (chainBroken) reasons.add("SUBLICENSE_NOT_ALLOWED");
  if (!anyGrant) reasons.add("MISSING_CONSENT");
  return [...reasons];
}

// 收集 party 在某资产上全部再许可链中的上游许可方（含根授权方）。
// 这是主体关系事实，沿 parent_source_id 上行即可，与本次检查的维度/日期无关——
// 中间许可方（如出版社）持有的库存授权永远不构成对其下游的"第三方独占阻断"。
function upstreamLicensors(state, assetRef, party) {
  const set = new Set();
  const walk = (grant, seen) => {
    if (seen.has(grant.source_id)) return;
    seen.add(grant.source_id);
    set.add(grant.grantor_ref);
    if (grant.parent_source_id) {
      const parent = state.grants.get(grant.parent_source_id);
      if (parent && parent.grantee_ref === grant.grantor_ref) walk(parent, seen);
    }
  };
  for (const leaf of state.grants.values()) {
    if (leaf.asset_ref === assetRef && leaf.grantee_ref === party) walk(leaf, new Set());
  }
  return set;
}

// 独家窗口阻断：第三方持有的、与请求维度和日期重叠的独占授权
export function exclusivityBlocks(state, assetRefs, req, date) {
  const blocks = [];
  for (const ref of assetRefs) {
    const ownSide = upstreamLicensors(state, ref, req.party);
    for (const g of state.grants.values()) {
      if (g.asset_ref !== ref || !g.scope.exclusive) continue;
      if (g.grantee_ref === req.party || ownSide.has(g.grantee_ref)) continue;
      if (!coversDay(date, g.valid_from, g.valid_to ?? null)) continue;
      if (scopesOverlapOn(g, req)) {
        const asset = state.assets.get(ref);
        const chain = asset ? ascend(state, asset, g, req, date) : null;
        blocks.push({
          asset_ref: ref,
          source_id: g.source_id,
          grantee_ref: g.grantee_ref,
          valid_from: g.valid_from,
          valid_to: g.valid_to ?? null,
          chain_root_valid: Boolean(chain),
        });
      }
    }
  }
  return blocks;
}

function scopesOverlapOn(grant, req) {
  return grant.scope.media.includes(req.media)
    && grant.scope.territories.includes(req.territory)
    && grant.scope.channels.includes(req.channel);
}

// 签约前独家窗口冲突检查：任一方为独家、双方不同、维度相交、闭开区间相交。
// 同样排除拟签约方自己上游授权链上的许可方。
export function findExclusivityConflicts(state, { asset_refs, scope, valid_from, valid_to, party }) {
  const conflicts = [];
  for (const ref of asset_refs) {
    const ownSide = upstreamLicensors(state, ref, party);
    for (const g of state.grants.values()) {
      if (g.asset_ref !== ref) continue;
      if (g.grantee_ref === party || ownSide.has(g.grantee_ref)) continue;
      const eitherExclusive = scope.exclusive === true || g.scope.exclusive === true;
      if (!eitherExclusive) continue;
      if (!rangesOverlap(valid_from, valid_to, g.valid_from, g.valid_to ?? null)) continue;
      const dimsHit = scope.media.some((m) => g.scope.media.includes(m))
        && scope.territories.some((t) => g.scope.territories.includes(t))
        && scope.channels.some((c) => g.scope.channels.includes(c));
      if (dimsHit) {
        conflicts.push({
          asset_ref: ref,
          source_id: g.source_id,
          grantee_ref: g.grantee_ref,
          existing_window: { valid_from: g.valid_from, valid_to: g.valid_to ?? null },
          existing_scope: {
            media: g.scope.media, territories: g.scope.territories, channels: g.scope.channels,
            exclusive: g.scope.exclusive,
          },
        });
      }
    }
  }
  return conflicts;
}


function certificateAtDate(state, certId, date) {
  const cert = state.certificates.get(certId);
  if (!cert) return null;
  if (!coversDay(date, cert.valid_from, cert.valid_to ?? null)) {
    return { cert, status: "CERT_EXPIRED" };
  }
  if (cert.revoked_on && date >= cert.revoked_on) {
    return { cert, status: "CERT_REVOKED" };
  }
  return { cert, status: "ACTIVE" };
}

function certSourceIdsAt(state, cert, date) {
  const ids = new Set(cert.source_ids);
  for (const s of cert.supplements ?? []) {
    if (s.recorded_on <= date) ids.add(s.source_id); // 补签材料晚到：到期日之前不产生效力
  }
  return ids;
}

function usedQuantityAt(state, certId, date) {
  return state.usages
    .filter((u) => u.cert_id === certId && u.on_date <= date)
    .reduce((sum, u) => sum + (u.quantity ?? 0), 0);
}

// 凭证与授权链的交叉核对：凭证所裁剪的范围必须仍能被其引用来源支撑
function evaluateCertificate(state, imageRef, req, date) {
  const certs = [...state.certificates.values()]
    .filter((c) => (c.asset_refs ?? []).includes(imageRef) && c.counterparty === req.party);

  const result = { status: "NO_CERTIFICATE", cert: null, source_checks: [], used: 0, reasons: [] };
  if (certs.length === 0) return result;

  // 取签发时间相关的最新一张；as-of 日期下状态单独核算
  const cert = certs.sort((a, b) => b.issued_on.localeCompare(a.issued_on))[0];
  const at = certificateAtDate(state, cert.cert_id, date);
  result.cert = cert;
  result.status = at.status;
  if (at.status !== "ACTIVE") { result.reasons.push(at.status); return result; }

  if (!scopeContains(cert.scope, req)) {
    result.reasons.push(...dimensionGaps(cert.scope, req));
  }

  result.used = usedQuantityAt(state, cert.cert_id, date);
  if (cert.scope.max_quantity !== null && result.used >= (cert.scope.max_quantity ?? 0)) {
    result.reasons.push("QUANTITY_EXCEEDED");
  }

  // 凭证引用的每个来源，在当日仍须落在有效区间内（到期/撤销后凭证不得作为依据）
  for (const sid of certSourceIdsAt(state, cert, date)) {
    const g = state.grants.get(sid);
    if (!g) { result.source_checks.push({ source_id: sid, ok: false, reason: "SOURCE_MISSING" }); continue; }
    const ok = coversDay(date, g.valid_from, g.valid_to ?? null);
    result.source_checks.push({ source_id: sid, ok, reason: ok ? null : "EXPIRED" });
    if (!ok) result.reasons.push("EXPIRED");
  }
  return result;
}

function findContractBasis(state, sourceIds) {
  const basis = [];
  for (const contract of state.contracts.values()) {
    for (const version of contract.versions.values()) {
      const hit = version.source_ids.filter((sid) => sourceIds.has(sid));
      if (hit.length > 0) {
        basis.push({
          contract_id: contract.contract_id,
          version_no: version.version_no,
          source_ids: hit,
        });
      }
    }
  }
  return basis;
}

// 主判断：在 date 当日，party 是否可将 imageRef 用于 req 描述的用途。
export function evaluate(state, query, { decisionId, recordedAt } = {}) {
  const date = query.date;
  const req = {
    media: query.media,
    territory: query.territory,
    channel: query.channel,
    party: query.party,
  };

  const image = resolveImage(state, query);
  const closure = assetClosure(state, image.ref);
  const assetRefs = closure.map((a) => a.ref);

  const layers = [];
  const usedSourceIds = new Set();
  let rightsCovered = true;
  let retroactive = false;

  for (const asset of closure) {
    const chains = validGrantChains(state, asset.ref, req, date);
    const coveredHolders = new Set();
    for (const chain of chains) {
      const root = chain[0];
      coveredHolders.add(root.grantor_ref);
      for (const g of chain) {
        usedSourceIds.add(g.source_id);
        if ((g.recorded_on ?? recordedAt) > date) retroactive = true;
      }
    }
    const missingHolders = [...asset.holders].filter((h) => !coveredHolders.has(h));
    const covered = missingHolders.length === 0 && chains.length > 0;
    if (!covered) rightsCovered = false;
    layers.push({
      asset_ref: asset.ref,
      kind: asset.kind,
      title: asset.title,
      holders: [...asset.holders],
      covered,
      valid_chains: chains.map((chain) => chain.map((g) => ({
        source_id: g.source_id,
        grantor_ref: g.grantor_ref,
        grantee_ref: g.grantee_ref,
        valid_from: g.valid_from,
        valid_to: g.valid_to ?? null,
        recorded_on: g.recorded_on ?? null,
      }))),
      missing_holders: missingHolders,
      reasons: covered ? [] : layerGapReasons(state, asset, req, date),
    });
  }

  const blocks = exclusivityBlocks(state, assetRefs, req, date);
  const certView = evaluateCertificate(state, image.ref, req, date);
  const certReasons = certView.reasons;
  const certificateOk = certView.status === "ACTIVE" && certReasons.length === 0;

  const missingConsents = layers
    .filter((l) => l.missing_holders.length > 0)
    .map((l) => ({ asset_ref: l.asset_ref, kind: l.kind, holder_refs: l.missing_holders }));

  const blockingReasons = [
    ...new Set([
      ...layers.flatMap((l) => l.reasons),
      ...(missingConsents.length > 0 ? ["MISSING_CONSENT"] : []),
      ...(blocks.length > 0 ? ["EXCLUSIVITY_BLOCKED"] : []),
      ...(certView.status !== "ACTIVE" ? [certView.status] : certReasons),
    ]),
  ];

  const usable = rightsCovered && blocks.length === 0 && certificateOk;

  return {
    decision_id: decisionId,
    as_of_date: date,
    image_ref: image.ref,
    image_urls: [...image.urls],
    request: req,
    usable,
    rights_covered: rightsCovered,
    certificate_ok: certificateOk,
    blocking_reasons: usable ? [] : blockingReasons,
    asset_layers: layers,
    exclusivity_blocks: blocks,
    missing_consents: missingConsents,
    certificate: certView.cert ? {
      cert_id: certView.cert.cert_id,
      status: certView.status,
      contract_id: certView.cert.contract_id,
      version_no: certView.cert.version_no,
      valid_from: certView.cert.valid_from,
      valid_to: certView.cert.valid_to ?? null,
      revoked_on: certView.cert.revoked_on,
      scope: certView.cert.scope,
      used_quantity: certView.used,
      source_checks: certView.source_checks,
    } : null,
    contract_basis: findContractBasis(state, usedSourceIds),
    retroactive_basis: retroactive,
  };
}

export function resolveImage(state, query) {
  let ref = query.ref;
  if (!ref && query.url) {
    for (const asset of state.assets.values()) {
      if (asset.kind === "image" && asset.urls.has(query.url)) { ref = asset.ref; break; }
    }
  }
  const asset = ref ? state.assets.get(ref) : null;
  if (!asset) {
    const err = new Error(ref ? `未找到资产: ${ref}` : `没有图片登记此 URL: ${query.url}`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (asset.kind !== "image") {
    const err = new Error(`资产 ${ref} 不是图像（实际为 ${asset.kind}）`);
    err.code = "INVALID";
    throw err;
  }
  return asset;
}
