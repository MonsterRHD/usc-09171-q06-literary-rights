import { EVENT_TYPES } from "./event-types.mjs";
import { normalizeScope } from "./scope.mjs";

// 只读状态：由事件日志完整回放得到。任何字段都不得在投影外修改。
export function createInitialState() {
  return {
    assets: new Map(),          // asset_ref -> {ref, kind, title, holders:Set, derived_from:Set, urls:Set}
    grants: new Map(),          // source_id -> grant
    proposals: new Map(),       // proposal_id -> proposal
    contracts: new Map(),       // contract_id -> {versions:Map(no -> version)}
    certificates: new Map(),    // cert_id -> certificate（含 revoked_on）
    activeCertByProposal: new Map(), // proposal_id -> cert_id
    activeCertByFingerprint: new Map(),
    usages: [],                 // {cert_id, asset_ref, quantity, on_date, kind}
    sales: [],
    decisions: [],
    latestDecisionByQuestion: new Map(),
    settlements: new Map(),     // `${cert_id}:${month}` -> settlement
    idempotency: new Map(),     // key -> {kind, ref}
    seq: 0,
  };
}

export function applyEvent(state, event) {
  const p = event.payload;
  switch (event.type) {
    case EVENT_TYPES.WORK_REGISTERED:
    case EVENT_TYPES.CHARACTER_REGISTERED:
    case EVENT_TYPES.TRANSLATION_REGISTERED:
    case EVENT_TYPES.IMAGE_REGISTERED:
    case EVENT_TYPES.TRADEMARK_REGISTERED: {
      const kind = {
        [EVENT_TYPES.WORK_REGISTERED]: "work",
        [EVENT_TYPES.CHARACTER_REGISTERED]: "character",
        [EVENT_TYPES.TRANSLATION_REGISTERED]: "translation",
        [EVENT_TYPES.IMAGE_REGISTERED]: "image",
        [EVENT_TYPES.TRADEMARK_REGISTERED]: "trademark",
      }[event.type];
      state.assets.set(p.ref, {
        ref: p.ref,
        kind,
        title: p.title ?? p.name ?? p.ref,
        holders: new Set(p.holders ?? []),
        derived_from: new Set(p.derived_from ?? []),
        urls: new Set(p.urls ?? []),
      });
      break;
    }
    case EVENT_TYPES.DERIVATION_ADDED: {
      const asset = state.assets.get(p.asset_ref);
      if (asset) asset.derived_from.add(p.parent_ref);
      break;
    }
    case EVENT_TYPES.GRANT_RECORDED: {
      state.grants.set(p.source_id, { ...p, scope: normalizeScope(p.scope) });
      break;
    }
    case EVENT_TYPES.PROPOSAL_SUBMITTED: {
      state.proposals.set(p.proposal_id, p);
      break;
    }
    case EVENT_TYPES.CONTRACT_CREATED: {
      state.contracts.set(p.contract_id, {
        contract_id: p.contract_id,
        proposal_id: p.proposal_id,
        title: p.title,
        approver_roles: [...p.approver_roles],
        created_on: p.created_on,
        versions: new Map(),
      });
      break;
    }
    case EVENT_TYPES.CONTRACT_VERSION_ADDED: {
      const contract = state.contracts.get(p.contract_id);
      if (contract) {
        contract.versions.set(p.version_no, {
          version_no: p.version_no,
          source_ids: [...p.source_ids],
          royalty: p.royalty,
          created_on: p.created_on,
          note: p.note ?? "",
          approvals: new Map(), // role -> {approver, at}
        });
      }
      break;
    }
    case EVENT_TYPES.APPROVAL_RECORDED: {
      const version = state.contracts.get(p.contract_id)?.versions.get(p.version_no);
      if (version) version.approvals.set(p.role, { approver: p.approver, at: p.at });
      break;
    }
    case EVENT_TYPES.CERTIFICATE_ISSUED: {
      state.certificates.set(p.cert_id, { ...p, scope: normalizeScope(p.scope), revoked_on: null });
      state.activeCertByProposal.set(p.proposal_id, p.cert_id);
      state.activeCertByFingerprint.set(p.fingerprint, p.cert_id);
      break;
    }
    case EVENT_TYPES.CERTIFICATE_REVOKED: {
      const cert = state.certificates.get(p.cert_id);
      if (cert) {
        cert.revoked_on = p.on_date;
        cert.revoke_reason = p.reason;
      }
      if (state.activeCertByProposal.get(p.proposal_id) === p.cert_id) {
        state.activeCertByProposal.delete(p.proposal_id);
      }
      if (state.activeCertByFingerprint.get(cert?.fingerprint) === p.cert_id) {
        state.activeCertByFingerprint.delete(cert.fingerprint);
      }
      break;
    }
    case EVENT_TYPES.SUPPLEMENT_RECORDED: {
      const cert = state.certificates.get(p.cert_id);
      if (cert) {
        cert.supplements = cert.supplements ?? [];
        cert.supplements.push({ source_id: p.source_id, recorded_on: p.recorded_on, note: p.note });
      }
      break;
    }
    case EVENT_TYPES.MATERIAL_PICKED_UP:
      state.usages.push({ cert_id: p.cert_id, asset_ref: p.asset_ref, quantity: p.quantity, on_date: p.on_date, kind: "pickup" });
      break;
    case EVENT_TYPES.SAMPLE_RECORDED:
      state.usages.push({ cert_id: p.cert_id, asset_ref: p.asset_ref, quantity: p.quantity, on_date: p.on_date, kind: "sample" });
      break;
    case EVENT_TYPES.USAGE_RECORDED:
      state.usages.push({ cert_id: p.cert_id, asset_ref: p.asset_ref, quantity: p.quantity, on_date: p.on_date, kind: "usage", channel: p.channel, media: p.media, territory: p.territory });
      break;
    case EVENT_TYPES.SALE_RECORDED:
      state.sales.push(p);
      break;
    case EVENT_TYPES.DECISION_RECORDED: {
      state.decisions.push(p);
      state.latestDecisionByQuestion.set(p.question_key, p.decision_id);
      break;
    }
    case EVENT_TYPES.SETTLEMENT_CONFIRMED:
      state.settlements.set(`${p.cert_id}:${p.month}`, {
        settlement_id: p.settlement_id, cert_id: p.cert_id, month: p.month,
        confirmed: p, corrections: [],
      });
      break;
    case EVENT_TYPES.SETTLEMENT_CORRECTED: {
      const key = `${p.cert_id}:${p.month}`;
      const entry = state.settlements.get(key);
      if (entry) entry.corrections.push(p);
      break;
    }
    default:
      // 未知事件：新版本日志被旧代码读到时直接报错，绝不静默忽略
      throw new Error(`未知事件类型: ${event.type}`);
  }
  if (event.idempotency_key) state.idempotency.set(event.idempotency_key, { kind: event.type, ref: event.payload?.proposal_id ?? event.payload?.cert_id ?? event.payload?.decision_id });
  state.seq += 1;
  return state;
}

export function replay(events) {
  return events.reduce((state, event) => applyEvent(state, event), createInitialState());
}

// 资产来源闭包（图 → 角色/译本/商标 → 作品），按拓扑顺序返回，作品在前
export function assetClosure(state, ref, seen = new Set(), out = []) {
  if (seen.has(ref) || !state.assets.has(ref)) return out;
  seen.add(ref);
  const asset = state.assets.get(ref);
  for (const parent of asset.derived_from) assetClosure(state, parent, seen, out);
  out.push(asset);
  return out;
}
