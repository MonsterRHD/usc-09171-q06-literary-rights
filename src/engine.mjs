// 授权决策引擎。
//
// 引擎函数都是「读状态 -> 校验 -> 改状态 -> 返回结果」的同步函数，由 Store.mutate
// 串行执行并落盘。判断（judgment）、使用记录（usage）、更正（correction）只追加、
// 不修改：撤销、到期、超量、补签材料晚到、合同回溯生效，都只会产生新的判断，
// 当时的结论永远保持原样。

import { badRequest, conflict, notFound, unprocessable } from "./errors.mjs";
import { coverageGaps, normalizeTime, scopeOverlap, withinTerm } from "./scope.mjs";
import { nextId } from "./store.mjs";

export const ASSET_TYPES = ["work", "character", "translation", "image", "trademark"];
export const CLEARANCE_KINDS = ["material-pickup", "sample-draft"];

const round2 = (value) => Math.round(value * 100) / 100;

// ---------- 输入校验 ----------

function requireFields(input, fields) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw badRequest("请求体必须是 JSON 对象");
  }
  for (const field of fields) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      throw badRequest(`缺少字段 ${field}`);
    }
  }
}

function requireStringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item === "")) {
    throw badRequest(`字段 ${field} 必须是非空字符串数组`);
  }
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`字段 ${field} 必须是正整数`);
  return value;
}

function requireMoney(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw badRequest(`字段 ${field} 必须是非负数字`);
  }
  return round2(value);
}

function requireMoneyDelta(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw badRequest(`字段 ${field} 必须是数字`);
  return round2(value);
}

// 范围对象只允许已知维度；未出现的键保持缺失——缺失维度不代表无限授权。
function normalizeScope(scope, { requireLists }) {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw badRequest("scope 必须是对象");
  }
  const known = new Set(["media", "territories", "channels", "quantity", "sublicense", "exclusive"]);
  for (const key of Object.keys(scope)) {
    if (!known.has(key)) throw badRequest(`未知范围维度 ${key}`);
  }
  const result = {};
  for (const dimension of ["media", "territories", "channels"]) {
    if (scope[dimension] !== undefined) {
      requireStringList(scope[dimension], `scope.${dimension}`);
      result[dimension] = [...scope[dimension]];
    } else if (requireLists) {
      throw badRequest(`范围必须显式声明 ${dimension}（缺失维度不代表无限授权）`);
    }
  }
  if (scope.quantity !== undefined) result.quantity = requirePositiveInt(scope.quantity, "scope.quantity");
  result["sublicense"] = scope["sublicense"] === true;
  result.exclusive = scope.exclusive === true;
  return result;
}

function normalizeWindow(fromValue, toValue, label) {
  const from = normalizeTime(fromValue, `${label}.valid_from`);
  const to = normalizeTime(toValue, `${label}.valid_to`);
  if (!(from < to)) throw unprocessable(`${label} 必须满足 valid_from < valid_to（闭开区间）`);
  return [from, to];
}

// ---------- 素材与来源关系 ----------

export function registerAsset(state, input, ctx) {
  requireFields(input, ["asset_ref", "type", "holder_ref"]);
  if (!ASSET_TYPES.includes(input.type)) {
    throw badRequest(`未知素材类型 ${input.type}，可选：${ASSET_TYPES.join(" / ")}`);
  }
  if (state.assets[input.asset_ref]) throw conflict(`素材已登记：${input.asset_ref}`);
  const derivedFrom = input.derived_from ?? [];
  if (!Array.isArray(derivedFrom)) throw badRequest("derived_from 必须是数组");
  if (derivedFrom.includes(input.asset_ref)) throw unprocessable("来源关系不能引用自身");
  for (const ref of derivedFrom) {
    if (!state.assets[ref]) throw unprocessable(`来源素材未登记：${ref}`);
  }
  const asset = {
    asset_ref: input.asset_ref,
    type: input.type,
    holder_ref: input.holder_ref,
    derived_from: [...derivedFrom],
    registered_at: ctx.now(),
  };
  state.assets[asset.asset_ref] = asset;
  return asset;
}

export function getAsset(state, assetRef) {
  const asset = state.assets[assetRef];
  if (!asset) throw notFound(`素材未登记：${assetRef}`);
  return asset;
}

// 本体 + 全部祖先（作品 -> 角色/译本 -> 图像等），深度优先去重。
export function lineageOf(state, assetRef) {
  const ordered = [];
  const seen = new Set();
  const visit = (ref) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    const asset = state.assets[ref];
    if (!asset) return;
    ordered.push(asset);
    for (const parent of asset.derived_from) visit(parent);
  };
  visit(assetRef);
  return ordered;
}

export function assetView(state, assetRef) {
  return { asset: getAsset(state, assetRef), lineage: lineageOf(state, assetRef) };
}

// ---------- 权利来源 ----------

export function addRightsSource(state, input, ctx) {
  requireFields(input, ["asset_ref", "holder_ref", "valid_from", "valid_to", "scope"]);
  const sourceId = input.source_id ?? nextId(state, "src");
  if (state.rights_sources[sourceId]) throw conflict(`权利来源已存在：${sourceId}`);
  const [validFrom, validTo] = normalizeWindow(input.valid_from, input.valid_to, "有效期");
  const source = {
    source_id: sourceId,
    asset_ref: input.asset_ref,
    holder_ref: input.holder_ref,
    valid_from: validFrom,
    valid_to: validTo,
    scope: normalizeScope(input.scope, { requireLists: false }),
    recorded_at: ctx.now(),
  };
  state.rights_sources[sourceId] = source;
  return source;
}

// ---------- 合作方案与独家窗口冲突 ----------

export function submitProposal(state, input, ctx) {
  requireFields(input, ["licensee_ref", "asset_refs", "requested_scope"]);
  requireStringList(input.asset_refs, "asset_refs");
  for (const ref of input.asset_refs) {
    if (!state.assets[ref]) throw unprocessable(`素材未登记：${ref}`);
  }
  const { valid_from, valid_to, ...scopeRest } = input.requested_scope;
  const [validFrom, validTo] = normalizeWindow(valid_from, valid_to, "合作方案期限");
  const requestedScope = {
    ...normalizeScope(scopeRest, { requireLists: true }),
    valid_from: validFrom,
    valid_to: validTo,
  };
  const proposal = {
    proposal_id: nextId(state, "prop"),
    licensee_ref: input.licensee_ref,
    asset_refs: [...input.asset_refs],
    requested_scope: requestedScope,
    status: "submitted",
    submitted_at: ctx.now(),
  };
  state.proposals[proposal.proposal_id] = proposal;
  return { proposal, conflicts: findWindowConflicts(state, proposal) };
}

export function getProposal(state, proposalId) {
  const proposal = state.proposals[proposalId];
  if (!proposal) throw notFound(`方案不存在：${proposalId}`);
  return proposal;
}

// 独家窗口冲突：新方案与既有合同授予、其他在途方案在媒介/地区/渠道/期限上相交，
// 且任一方声明独家，即构成冲突，签约前即可见。
export function findWindowConflicts(state, proposal) {
  const conflicts = [];
  const requested = proposal.requested_scope;
  for (const assetRef of proposal.asset_refs) {
    for (const contract of Object.values(state.contracts)) {
      const version = contract.versions[contract.versions.length - 1];
      if (!version) continue;
      for (const grant of version.grants) {
        if (grant.asset_ref !== assetRef) continue;
        if (!(requested.exclusive || grant.scope.exclusive)) continue;
        const overlap = scopeOverlap(requested, {
          ...grant.scope,
          valid_from: version.effective_from,
          valid_to: version.effective_to,
        });
        if (overlap) {
          conflicts.push({ kind: "contract", contract_id: contract.contract_id, asset_ref: assetRef, overlap });
        }
      }
    }
    for (const other of Object.values(state.proposals)) {
      if (other.proposal_id === proposal.proposal_id) continue;
      if (other.status !== "submitted") continue;
      if (!other.asset_refs.includes(assetRef)) continue;
      if (!(requested.exclusive || other.requested_scope.exclusive)) continue;
      const overlap = scopeOverlap(requested, other.requested_scope);
      if (overlap) {
        conflicts.push({ kind: "proposal", proposal_id: other.proposal_id, asset_ref: assetRef, overlap });
      }
    }
  }
  return conflicts;
}

// ---------- 合同、版本与审批链 ----------

export function createContract(state, input, ctx) {
  requireFields(input, ["proposal_id", "effective_from", "effective_to", "grants", "royalty", "required_approvals"]);
  const proposal = getProposal(state, input.proposal_id);
  if (Object.values(state.contracts).some((c) => c.proposal_id === proposal.proposal_id)) {
    throw conflict(`方案 ${proposal.proposal_id} 已存在合同`);
  }
  const contractId = nextId(state, "ctr");
  const version = buildVersion(state, contractId, 1, input, ctx);
  const contract = {
    contract_id: contractId,
    proposal_id: proposal.proposal_id,
    versions: [version],
    created_at: ctx.now(),
  };
  state.contracts[contractId] = contract;
  proposal.status = "contracted";
  return { contract, missing_consents: consentGapsForVersion(state, version) };
}

// 合同修订只产生新版本；effective_from 可以早于当前时间（回溯生效），
// 它只影响之后的新判断，不改写已有判断。
export function addContractVersion(state, contractId, input, ctx) {
  const contract = state.contracts[contractId];
  if (!contract) throw notFound(`合同不存在：${contractId}`);
  const version = buildVersion(state, contractId, contract.versions.length + 1, input, ctx);
  contract.versions.push(version);
  return { version, missing_consents: consentGapsForVersion(state, version) };
}

function buildVersion(state, contractId, versionNo, input, ctx) {
  requireFields(input, ["effective_from", "effective_to", "grants", "royalty", "required_approvals"]);
  const [effectiveFrom, effectiveTo] = normalizeWindow(input.effective_from, input.effective_to, "合同期限");
  if (!Array.isArray(input.grants) || input.grants.length === 0) {
    throw badRequest("grants 必须是非空数组");
  }
  const grants = input.grants.map((grant) => {
    requireFields(grant, ["asset_ref", "scope"]);
    if (!state.assets[grant.asset_ref]) throw unprocessable(`素材未登记：${grant.asset_ref}`);
    return { asset_ref: grant.asset_ref, scope: normalizeScope(grant.scope, { requireLists: true }) };
  });
  requireStringList(input.required_approvals, "required_approvals");
  return {
    contract_id: contractId,
    version: versionNo,
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    grants,
    royalty: normalizeRoyalty(input.royalty),
    required_approvals: [...input.required_approvals],
    approvals: [],
    recorded_at: ctx.now(),
  };
}

function normalizeRoyalty(royalty) {
  if (typeof royalty !== "object" || royalty === null || Array.isArray(royalty)) {
    throw badRequest("royalty 必须是对象");
  }
  const { rate, minimum_guarantee: minimumGuarantee } = royalty;
  if (typeof rate !== "number" || !(rate >= 0 && rate <= 1)) {
    throw badRequest("royalty.rate 必须是 [0, 1] 之间的数字");
  }
  if (typeof minimumGuarantee !== "number" || !(minimumGuarantee >= 0)) {
    throw badRequest("royalty.minimum_guarantee 必须是非负数字");
  }
  return { rate, minimum_guarantee: round2(minimumGuarantee) };
}

// 签约时的体检：按合同窗口 + 授予范围检查每一位权利人的来源声明是否完整覆盖。
function consentGapsForVersion(state, version) {
  const missing = [];
  const seen = new Set();
  for (const grant of version.grants) {
    for (const asset of lineageOf(state, grant.asset_ref)) {
      const key = `${grant.asset_ref}<-${asset.asset_ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const covered = Object.values(state.rights_sources).some(
        (source) => source.asset_ref === asset.asset_ref && windowCoveredBySource(source, grant.scope, version),
      );
      if (!covered) {
        missing.push({ asset_ref: asset.asset_ref, holder_ref: asset.holder_ref, grant_of: grant.asset_ref });
      }
    }
  }
  return missing;
}

function windowCoveredBySource(source, scope, version) {
  const granted = source.scope;
  if (!(source.valid_from <= version.effective_from && version.effective_to <= source.valid_to)) return false;
  for (const value of scope.media ?? []) {
    if (!(Array.isArray(granted.media) && granted.media.includes(value))) return false;
  }
  for (const value of scope.territories ?? []) {
    if (!(Array.isArray(granted.territories) && granted.territories.includes(value))) return false;
  }
  for (const value of scope.channels ?? []) {
    if (!(Array.isArray(granted.channels) && granted.channels.includes(value))) return false;
  }
  if (scope["sublicense"] === true && granted["sublicense"] !== true) return false;
  if (scope.quantity !== undefined && !(typeof granted.quantity === "number" && granted.quantity >= scope.quantity)) {
    return false;
  }
  return true;
}

// 审批必须落在该版本要求的审批链上；链上每一环都批准后，审批链才与合同版本完全一致。
export function approve(state, input, ctx) {
  requireFields(input, ["contract_id", "version", "step", "approver"]);
  const contract = state.contracts[input.contract_id];
  if (!contract) throw notFound(`合同不存在：${input.contract_id}`);
  const version = contract.versions.find((v) => v.version === input.version);
  if (!version) throw notFound(`合同 ${input.contract_id} 不存在版本 v${input.version}`);
  if (!version.required_approvals.includes(input.step)) {
    throw unprocessable(`版本 v${version.version} 的审批链不要求环节 ${input.step}`);
  }
  if (version.approvals.some((a) => a.step === input.step)) {
    throw conflict(`版本 v${version.version} 的环节 ${input.step} 已审批`);
  }
  version.approvals.push({ step: input.step, approver: input.approver, at: ctx.now() });
  return version;
}

export function isFullyApproved(version) {
  const done = new Set(version.approvals.map((a) => a.step));
  return version.required_approvals.every((step) => done.has(step));
}

// 在给定日期生效、且审批链完整的最新版本（回溯生效的新版本优先）。
function effectiveVersion(contract, at) {
  return (
    contract.versions
      .filter((version) => isFullyApproved(version) && withinTerm(version.effective_from, version.effective_to, at))
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

// 最近一个审批链完整的版本，用于在版本窗口不覆盖查询日期时仍给出完整的维度缺口。
function latestApprovedVersion(contract) {
  return (
    contract.versions
      .filter((version) => isFullyApproved(version))
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

export function contractView(state, contractId) {
  const contract = state.contracts[contractId];
  if (!contract) throw notFound(`合同不存在：${contractId}`);
  return {
    ...contract,
    versions: contract.versions.map((version) => ({ ...version, fully_approved: isFullyApproved(version) })),
  };
}

// ---------- 范围凭证 ----------

// 审批链与合同当前版本完全一致后才签发；同一方案任意时刻至多一张有效凭证，
// 已存在有效凭证时直接返回它——并发提交或服务重启都不会制造出第二张。
export function issueCredential(state, input, ctx) {
  requireFields(input, ["proposal_id"]);
  const proposal = getProposal(state, input.proposal_id);
  const existing = Object.values(state.credentials).find(
    (credential) => credential.proposal_id === proposal.proposal_id && credential.status === "valid",
  );
  if (existing) return { credential: existing, created: false };
  const contract = Object.values(state.contracts).find((c) => c.proposal_id === proposal.proposal_id);
  if (!contract) throw unprocessable(`方案 ${proposal.proposal_id} 尚无合同，不能签发凭证`);
  const version = contract.versions[contract.versions.length - 1];
  if (!isFullyApproved(version)) {
    const done = new Set(version.approvals.map((a) => a.step));
    const missing = version.required_approvals.filter((step) => !done.has(step));
    throw conflict(`合同版本 v${version.version} 的审批链未完整（缺少：${missing.join("、")}），不能签发凭证`);
  }
  const credential = {
    credential_id: nextId(state, "cred"),
    proposal_id: proposal.proposal_id,
    contract_id: contract.contract_id,
    contract_version: version.version,
    licensee_ref: proposal.licensee_ref,
    status: "valid",
    issued_at: ctx.now(),
    revoked_at: null,
    revoke_reason: null,
  };
  state.credentials[credential.credential_id] = credential;
  return { credential, created: true };
}

export function getCredential(state, credentialId) {
  const credential = state.credentials[credentialId];
  if (!credential) throw notFound(`凭证不存在：${credentialId}`);
  return credential;
}

// 撤销不删除凭证，只改变其状态并追加一条判断；历史判断保持原样。
export function revokeCredential(state, input, ctx) {
  requireFields(input, ["credential_id"]);
  const credential = getCredential(state, input.credential_id);
  if (credential.status === "revoked") throw conflict(`凭证 ${credential.credential_id} 已撤销`);
  credential.status = "revoked";
  credential.revoked_at = ctx.now();
  credential.revoke_reason = input.reason ?? null;
  appendJudgment(
    state,
    {
      kind: "revocation",
      asset_ref: null,
      licensee_ref: credential.licensee_ref,
      as_of: ctx.now(),
      usage: null,
      decision: "revoked",
      reasons: [input.reason ?? "凭证被撤销"],
      missing_consents: [],
      basis: {
        credential_id: credential.credential_id,
        contract_id: credential.contract_id,
        contract_version: credential.contract_version,
        rights_source_ids: [],
      },
    },
    ctx,
  );
  return credential;
}

// ---------- 判断入口 ----------

function normalizeUsageRequest(usage, kind) {
  const value = usage ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("usage 必须是对象");
  }
  const request = {};
  const needsFullDimensions = kind === "query" || kind === "usage";
  for (const dimension of ["media", "territory", "channel"]) {
    if (value[dimension] !== undefined) {
      if (typeof value[dimension] !== "string" || value[dimension] === "") {
        throw badRequest(`usage.${dimension} 必须是非空字符串`);
      }
      request[dimension] = value[dimension];
    } else if (needsFullDimensions) {
      throw badRequest(`判断${kind === "usage" ? "实际使用" : "查询"}必须声明 usage.${dimension}`);
    }
  }
  if (value.quantity !== undefined) {
    request.quantity = requirePositiveInt(value.quantity, "usage.quantity");
  } else if (kind === "usage") {
    throw badRequest("实际使用必须声明 usage.quantity");
  }
  if (value["sublicense"] !== undefined) request["sublicense"] = value["sublicense"] === true;
  return request;
}

function resolveCredential(state, input) {
  if (input.credential_id !== undefined) return getCredential(state, input.credential_id);
  if (input.licensee_ref === undefined) throw badRequest("必须提供 credential_id 或 licensee_ref");
  const related = Object.values(state.credentials).filter(
    (credential) =>
      credential.licensee_ref === input.licensee_ref && contractGrantsAsset(state, credential.contract_id, input.asset_ref),
  );
  const valid = related.filter((credential) => credential.status === "valid");
  if (valid.length > 1) {
    throw unprocessable(`被授权方 ${input.licensee_ref} 对该素材持有多张有效凭证，请指定 credential_id`);
  }
  if (valid.length === 1) return valid[0];
  // 全部已撤销时返回最近一张，让判断能说明「依据哪份合同、何时被撤销」。
  if (related.length > 0) return related[related.length - 1];
  return null;
}

function contractGrantsAsset(state, contractId, assetRef) {
  const contract = state.contracts[contractId];
  if (!contract) return false;
  const version = contract.versions[contract.versions.length - 1];
  return version.grants.some((grant) => grant.asset_ref === assetRef);
}

function consumedQuantity(state, credentialId, assetRef) {
  return state.usages
    .filter((usage) => usage.credential_id === credentialId && usage.asset_ref === assetRef && usage.kind === "sale")
    .reduce((sum, usage) => sum + usage.quantity, 0);
}

function findCoveringSource(state, assetRef, request) {
  return Object.values(state.rights_sources).find(
    (source) =>
      source.asset_ref === assetRef &&
      coverageGaps({ ...source.scope, valid_from: source.valid_from, valid_to: source.valid_to }, request).length === 0,
  );
}

// 没有来源能覆盖时，给出差距最小的来源的缺口，帮助法务定位问题。
function bestEffortGaps(state, assetRef, request) {
  const sources = Object.values(state.rights_sources).filter((source) => source.asset_ref === assetRef);
  if (sources.length === 0) return ["没有任何权利来源声明"];
  let best = null;
  for (const source of sources) {
    const gaps = coverageGaps({ ...source.scope, valid_from: source.valid_from, valid_to: source.valid_to }, request);
    if (best === null || gaps.length < best.length) best = gaps;
  }
  return best;
}

function appendJudgment(state, fields, ctx) {
  const judgment = { judgment_id: nextId(state, "jdg"), ...fields, recorded_at: ctx.now() };
  state.judgments.push(judgment);
  return judgment;
}

// 判断入口：在任意日期查询任一素材的任一使用方式，
// 说明是否可用、依据哪份合同、缺少哪位权利人的同意。每次判断都只追加一条记录。
export function evaluate(state, input, ctx) {
  const kind = input.kind ?? "query";
  requireFields(input, ["asset_ref", "as_of"]);
  const asOf = normalizeTime(input.as_of, "as_of");
  const usage = normalizeUsageRequest(input.usage, kind);
  const credential = resolveCredential(state, input);

  const reasons = [];
  const missingConsents = [];
  const basis = { credential_id: null, contract_id: null, contract_version: null, rights_source_ids: [] };

  const asset = state.assets[input.asset_ref];
  if (!asset) reasons.push(`素材未登记：${input.asset_ref}`);

  if (!credential) {
    reasons.push("不存在覆盖该使用的有效凭证");
  } else {
    basis.credential_id = credential.credential_id;
    basis.contract_id = credential.contract_id;
    if (credential.status !== "valid") {
      reasons.push(`凭证 ${credential.credential_id} 已于 ${credential.revoked_at} 撤销`);
    }
    const contract = state.contracts[credential.contract_id];
    // 优先取查询日期生效的版本；窗口不覆盖时退回最近审批完整的版本，
    // 由期限检查给出「期限未覆盖」，同时列出其余维度的缺口。
    const version = effectiveVersion(contract, asOf) ?? latestApprovedVersion(contract);
    if (!version) {
      reasons.push("没有审批链完整的合同版本");
    } else {
      basis.contract_version = version.version;
      const grant = version.grants.find((g) => g.asset_ref === input.asset_ref);
      if (!grant) {
        reasons.push(`合同版本 v${version.version} 未授予素材 ${input.asset_ref}`);
      } else {
        reasons.push(
          ...coverageGaps(
            { ...grant.scope, valid_from: version.effective_from, valid_to: version.effective_to },
            { ...usage, at: asOf },
          ),
        );
        if (usage.quantity !== undefined && typeof grant.scope.quantity === "number") {
          const consumed = consumedQuantity(state, credential.credential_id, input.asset_ref);
          if (consumed + usage.quantity > grant.scope.quantity) {
            reasons.push(`超量：已用 ${consumed}，本次请求 ${usage.quantity}，授予上限 ${grant.scope.quantity}`);
          }
        }
      }
    }
  }

  if (asset) {
    const request = { ...usage, at: asOf };
    for (const each of lineageOf(state, asset.asset_ref)) {
      const covering = findCoveringSource(state, each.asset_ref, request);
      if (covering) {
        basis.rights_source_ids.push(covering.source_id);
      } else {
        missingConsents.push({
          asset_ref: each.asset_ref,
          holder_ref: each.holder_ref,
          gaps: bestEffortGaps(state, each.asset_ref, request),
        });
      }
    }
  }

  return appendJudgment(
    state,
    {
      kind,
      asset_ref: input.asset_ref,
      licensee_ref: input.licensee_ref ?? credential?.licensee_ref ?? null,
      as_of: asOf,
      usage,
      decision: reasons.length === 0 && missingConsents.length === 0 ? "permit" : "deny",
      reasons,
      missing_consents: missingConsents,
      basis,
    },
    ctx,
  );
}

// 素材领取与样稿走同一个判断入口，只要求凭证有效、素材已授予、期限覆盖。
export function gateClearance(state, input, ctx) {
  requireFields(input, ["kind", "credential_id", "asset_ref", "at"]);
  if (!CLEARANCE_KINDS.includes(input.kind)) {
    throw badRequest(`kind 必须是 ${CLEARANCE_KINDS.join(" 或 ")}`);
  }
  return evaluate(
    state,
    { kind: input.kind, credential_id: input.credential_id, asset_ref: input.asset_ref, as_of: input.at, usage: input.usage ?? {} },
    ctx,
  );
}

// 实际使用：先经判断入口，许可才记录用量；退回只记录、不做范围判断。
export function recordUsage(state, input, ctx) {
  requireFields(input, ["credential_id", "asset_ref", "at", "kind"]);
  const credential = getCredential(state, input.credential_id);
  const at = normalizeTime(input.at, "at");
  if (input.kind === "return") {
    const usage = {
      usage_id: nextId(state, "use"),
      credential_id: credential.credential_id,
      contract_id: credential.contract_id,
      asset_ref: input.asset_ref,
      kind: "return",
      quantity: requirePositiveInt(input.quantity, "quantity"),
      gross_amount: requireMoney(input.gross_amount, "gross_amount"),
      at,
      recorded_at: ctx.now(),
    };
    state.usages.push(usage);
    const judgment = appendJudgment(
      state,
      {
        kind: "return",
        asset_ref: input.asset_ref,
        licensee_ref: credential.licensee_ref,
        as_of: at,
        usage: { quantity: usage.quantity },
        decision: "recorded",
        reasons: [],
        missing_consents: [],
        basis: { credential_id: credential.credential_id, contract_id: credential.contract_id, contract_version: null, rights_source_ids: [] },
      },
      ctx,
    );
    return { usage, judgment };
  }
  if (input.kind !== "sale") throw badRequest("kind 必须是 sale 或 return");
  const judgment = evaluate(
    state,
    {
      kind: "usage",
      credential_id: credential.credential_id,
      asset_ref: input.asset_ref,
      as_of: at,
      usage: {
        media: input.media,
        territory: input.territory,
        channel: input.channel,
        quantity: input.quantity,
        sublicense: input["sublicense"],
      },
    },
    ctx,
  );
  let usage = null;
  if (judgment.decision === "permit") {
    usage = {
      usage_id: nextId(state, "use"),
      credential_id: credential.credential_id,
      contract_id: credential.contract_id,
      asset_ref: input.asset_ref,
      kind: "sale",
      quantity: judgment.usage.quantity,
      gross_amount: requireMoney(input.gross_amount, "gross_amount"),
      at,
      recorded_at: ctx.now(),
      judgment_id: judgment.judgment_id,
    };
    state.usages.push(usage);
  }
  return { usage, judgment };
}

// ---------- 结算 ----------

function settlementTotals(grossAmount, returnsAmount, royalty) {
  const netAmount = round2(grossAmount - returnsAmount);
  const royaltyDue = round2(netAmount * royalty.rate);
  return {
    gross_amount: grossAmount,
    returns_amount: returnsAmount,
    net_amount: netAmount,
    rate: royalty.rate,
    royalty_due: royaltyDue,
    minimum_guarantee: royalty.minimum_guarantee,
    difference: round2(royaltyDue - royalty.minimum_guarantee),
    amount_due: round2(Math.max(0, royaltyDue - royalty.minimum_guarantee)),
  };
}

// 跨月结算：依据结算月首日有效（审批链完整）的合同版本条款，
// 汇总销售与退回，按版税率与最低保证生成版税差额。
// 同一合同同一期间只生成一份结算：草稿重跑幂等返回，已确认则只能更正。
export function runSettlement(state, input, ctx) {
  requireFields(input, ["contract_id", "period"]);
  const contract = state.contracts[input.contract_id];
  if (!contract) throw notFound(`合同不存在：${input.contract_id}`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw badRequest("period 格式必须为 YYYY-MM");
  const settlementId = `set-${input.period}-${contract.contract_id}`;
  const existing = state.settlements[settlementId];
  if (existing) {
    if (existing.status === "confirmed") throw conflict(`结算 ${settlementId} 已确认，只能通过更正记录调整`);
    return { settlement: existing, created: false };
  }
  const [year, month] = input.period.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const to = new Date(Date.UTC(year, month, 1)).toISOString();
  const version = effectiveVersion(contract, from);
  if (!version) throw unprocessable(`期间 ${input.period} 没有审批链完整且生效的合同版本，无法结算`);
  const credentialIds = new Set(
    Object.values(state.credentials)
      .filter((credential) => credential.contract_id === contract.contract_id)
      .map((credential) => credential.credential_id),
  );
  const linesByAsset = new Map();
  for (const usage of state.usages) {
    if (!credentialIds.has(usage.credential_id)) continue;
    if (!(from <= usage.at && usage.at < to)) continue;
    if (!linesByAsset.has(usage.asset_ref)) {
      linesByAsset.set(usage.asset_ref, {
        asset_ref: usage.asset_ref,
        sales_quantity: 0,
        gross_amount: 0,
        returns_quantity: 0,
        returns_amount: 0,
      });
    }
    const line = linesByAsset.get(usage.asset_ref);
    if (usage.kind === "sale") {
      line.sales_quantity += usage.quantity;
      line.gross_amount = round2(line.gross_amount + usage.gross_amount);
    } else {
      line.returns_quantity += usage.quantity;
      line.returns_amount = round2(line.returns_amount + usage.gross_amount);
    }
  }
  const lines = [...linesByAsset.values()];
  const gross = round2(lines.reduce((sum, line) => sum + line.gross_amount, 0));
  const returns = round2(lines.reduce((sum, line) => sum + line.returns_amount, 0));
  const settlement = {
    settlement_id: settlementId,
    contract_id: contract.contract_id,
    period: input.period,
    status: "draft",
    contract_version: version.version,
    lines,
    totals: settlementTotals(gross, returns, version.royalty),
    created_at: ctx.now(),
    confirmed_at: null,
  };
  state.settlements[settlementId] = settlement;
  return { settlement, created: true };
}

export function confirmSettlement(state, settlementId, ctx) {
  const settlement = state.settlements[settlementId];
  if (!settlement) throw notFound(`结算不存在：${settlementId}`);
  if (settlement.status === "confirmed") return settlement;
  settlement.status = "confirmed";
  settlement.confirmed_at = ctx.now();
  return settlement;
}

// 已确认的结算不修改，只追加可追溯的更正记录；每条更正都留下调整后的完整口径。
export function correctSettlement(state, settlementId, input, ctx) {
  const settlement = state.settlements[settlementId];
  if (!settlement) throw notFound(`结算不存在：${settlementId}`);
  if (settlement.status !== "confirmed") throw conflict("只有已确认的结算才通过更正记录调整；草稿请重新生成");
  requireFields(input, ["reason"]);
  const grossDelta = input.gross_delta === undefined ? 0 : requireMoneyDelta(input.gross_delta, "gross_delta");
  const returnsDelta = input.returns_delta === undefined ? 0 : requireMoneyDelta(input.returns_delta, "returns_delta");
  const prior = settlementView(state, settlementId).corrected_totals;
  const totals = settlementTotals(round2(prior.gross_amount + grossDelta), round2(prior.returns_amount + returnsDelta), {
    rate: prior.rate,
    minimum_guarantee: prior.minimum_guarantee,
  });
  const correction = {
    correction_id: nextId(state, "cor"),
    settlement_id: settlementId,
    reason: input.reason,
    gross_delta: grossDelta,
    returns_delta: returnsDelta,
    resulting_totals: totals,
    recorded_at: ctx.now(),
  };
  state.corrections.push(correction);
  return correction;
}

export function settlementView(state, settlementId) {
  const settlement = state.settlements[settlementId];
  if (!settlement) throw notFound(`结算不存在：${settlementId}`);
  const corrections = state.corrections.filter((correction) => correction.settlement_id === settlementId);
  return {
    ...settlement,
    corrections,
    corrected_totals: corrections.length === 0 ? settlement.totals : corrections[corrections.length - 1].resulting_totals,
  };
}

// ---------- 查询 ----------

export function listJudgments(state, filter = {}) {
  return state.judgments.filter(
    (judgment) =>
      (filter.asset_ref === undefined || judgment.asset_ref === filter.asset_ref) &&
      (filter.kind === undefined || judgment.kind === filter.kind) &&
      (filter.credential_id === undefined || judgment.basis?.credential_id === filter.credential_id),
  );
}

export function getJudgment(state, judgmentId) {
  const judgment = state.judgments.find((j) => j.judgment_id === judgmentId);
  if (!judgment) throw notFound(`判断不存在：${judgmentId}`);
  return judgment;
}
