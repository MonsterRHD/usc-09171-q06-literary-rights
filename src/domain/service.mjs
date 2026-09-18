import { EVENT_TYPES, EVENT_VERSION } from "./event-types.mjs";
import { replay, applyEvent, assetClosure } from "./projection.mjs";
import { normalizeScope, validateScope, intersectScopes } from "./scope.mjs";
import { coversDay, toDay, monthOf } from "./dates.mjs";
import { evaluate as evaluateNow, validGrantChains, exclusivityBlocks, findExclusivityConflicts, resolveImage } from "./evaluation.mjs";
import { computeSettlement, computeCorrection } from "./royalty.mjs";
import { newId, canonicalHash } from "./hashing.mjs";
import { conflict, notFound, invalid } from "./errors.mjs";

// 命令服务：单写者串行提交 + 幂等键 + 投影唯一索引。
// 并发提交同一方案、或服务重启后重放，都不可能制造第二张有效凭证。
export class RightsService {
  constructor(store, clock = () => new Date().toISOString().slice(0, 10)) {
    this.store = store;
    this.state = replay(store.load());
    this.today = clock;
    this._chain = Promise.resolve();
  }

  // 所有写命令经此串行化；返回 Promise 使并发调用按提交顺序落盘
  _commit(label, idempotencyKey, fn) {
    const run = this._chain.then(() => {
      if (idempotencyKey && this.state.idempotency.has(idempotencyKey)) {
        return { duplicate: true, ...this.state.idempotency.get(idempotencyKey) };
      }
      const events = fn();
      const list = Array.isArray(events) ? events : [events];
      const envelopes = list.map((e, i) => ({
        event_id: newId("evt"),
        type: e.type,
        version: EVENT_VERSION,
        recorded_at: new Date().toISOString(),
        recorded_on: this.today(),
        idempotency_key: i === 0 ? idempotencyKey ?? null : null,
        payload: e.payload,
      }));
      this.store.append(envelopes);
      for (const env of envelopes) this.#apply(env);
      return { duplicate: false, events: envelopes };
    });
    // 让链即使在失败时也能继续承接后续命令
    this._chain = run.then(() => undefined, () => undefined);
    return run;
  }

  #apply(env) {
    // 失败即抛出：内存状态与日志不得分叉
    applyEvent(this.state, env);
  }

  // ---------- 资产登记 ----------

  registerAsset(input) {
    const payload = {
      ref: input.ref,
      title: input.title ?? input.name ?? null,
      holders: [...new Set(input.holders ?? [])],
      derived_from: input.derived_from ?? [],
      urls: input.urls ?? [],
    };
    if (!payload.ref) throw invalid("资产必须给出 ref");
    if (payload.holders.length === 0) throw invalid(`资产 ${payload.ref} 必须至少登记一位权利人`);
    return this._commit("registerAsset", input.idempotency_key, () => {
      if (this.state.assets.has(payload.ref)) throw conflict(`资产已存在: ${payload.ref}`);
      for (const parent of payload.derived_from) {
        if (!this.state.assets.has(parent)) throw invalid(`来源资产不存在: ${parent}`);
      }
      const typeMap = {
        work: EVENT_TYPES.WORK_REGISTERED,
        character: EVENT_TYPES.CHARACTER_REGISTERED,
        translation: EVENT_TYPES.TRANSLATION_REGISTERED,
        image: EVENT_TYPES.IMAGE_REGISTERED,
        trademark: EVENT_TYPES.TRADEMARK_REGISTERED,
      };
      const type = typeMap[input.kind];
      if (!type) throw invalid(`未知资产类型: ${input.kind}`);
      return { type, payload };
    });
  }

  addDerivation({ asset_ref, parent_ref }) {
    return this._commit("addDerivation", null, () => {
      if (!this.state.assets.has(asset_ref)) throw notFound(`资产不存在: ${asset_ref}`);
      if (!this.state.assets.has(parent_ref)) throw notFound(`来源资产不存在: ${parent_ref}`);
      return { type: EVENT_TYPES.DERIVATION_ADDED, payload: { asset_ref, parent_ref } };
    });
  }

  // ---------- 权利来源（最小权利单元） ----------

  recordGrant(input) {
    const scope = normalizeScope(input.scope);
    const scopeErrors = validateScope(scope);
    const payload = {
      source_id: input.source_id,
      asset_ref: input.asset_ref,
      grantor_ref: input.grantor_ref,
      grantee_ref: input.grantee_ref,
      valid_from: input.valid_from ? toDay(input.valid_from) : null,
      valid_to: input.valid_to === null ? null : toDay(input.valid_to),
      parent_source_id: input.parent_source_id ?? null,
      recorded_on: input.recorded_on ? toDay(input.recorded_on) : this.today(),
      scope,
    };
    return this._commit("recordGrant", input.idempotency_key, () => {
      if (scopeErrors.length) throw invalid(scopeErrors.join("；"), { scope_errors: scopeErrors });
      if (!payload.source_id) throw invalid("授权必须给出 source_id");
      if (this.state.grants.has(payload.source_id)) throw conflict(`授权来源已存在: ${payload.source_id}`);
      const asset = this.state.assets.get(payload.asset_ref);
      if (!asset) throw notFound(`资产不存在: ${payload.asset_ref}`);
      if (!payload.grantor_ref || !payload.grantee_ref) throw invalid("授权双方均不可为空");
      if (!payload.valid_from) throw invalid("valid_from 不可为空");
      if (payload.valid_to !== null && payload.valid_to <= payload.valid_from) {
        throw invalid("闭开区间要求 valid_to > valid_from");
      }
      if (payload.parent_source_id) {
        const parent = this.state.grants.get(payload.parent_source_id);
        if (!parent) throw notFound(`上游授权不存在: ${payload.parent_source_id}`);
        if (parent.grantee_ref !== payload.grantor_ref) {
          throw invalid("再许可链断裂：上游被许可方与本跳授权方不一致", {
            upstream_grantee: parent.grantee_ref, grantor: payload.grantor_ref,
          });
        }
        if (parent.scope.sublicense !== true) {
          throw invalid(`上游授权 ${parent.source_id} 未允许再许可（sublicense 必须显式为 true）`);
        }
      } else if (!asset.holders.has(payload.grantor_ref)) {
        throw invalid(`根授权方 ${payload.grantor_ref} 不是资产 ${payload.asset_ref} 的登记权利人`, {
          holders: [...asset.holders],
        });
      }
      return { type: EVENT_TYPES.GRANT_RECORDED, payload };
    });
  }

  // ---------- 合作方案与独家窗口检查 ----------

  // 只读：签约前检查独家窗口冲突，不落任何事件
  checkExclusivity(input) {
    const scope = normalizeScope(input.scope);
    const errors = validateScope(scope);
    if (errors.length) throw invalid(errors.join("；"), { scope_errors: errors });
    if (!input.valid_from) throw invalid("valid_from 不可为空");
    const validTo = input.valid_to === null ? null : toDay(input.valid_to);
    return {
      conflicts: findExclusivityConflicts(this.state, {
        asset_refs: input.asset_refs,
        scope,
        valid_from: toDay(input.valid_from),
        valid_to: validTo,
        party: input.party,
      }),
    };
  }

  submitProposal(input) {
    const scope = normalizeScope(input.scope);
    const errors = validateScope(scope);
    const payload = {
      proposal_id: input.proposal_id ?? newId("prop"),
      party: input.party,
      asset_refs: [...input.asset_refs],
      scope,
      valid_from: toDay(input.valid_from),
      valid_to: input.valid_to === null ? null : toDay(input.valid_to),
      submitted_on: this.today(),
      fingerprint: null,
    };
    payload.fingerprint = canonicalHash({
      party: payload.party, asset_refs: [...payload.asset_refs].sort(),
      scope, valid_from: payload.valid_from, valid_to: payload.valid_to,
    });
    return this._commit("submitProposal", input.idempotency_key, () => {
      if (errors.length) throw invalid(errors.join("；"), { scope_errors: errors });
      if (this.state.proposals.has(payload.proposal_id)) throw conflict(`方案已存在: ${payload.proposal_id}`);
      for (const ref of payload.asset_refs) {
        if (!this.state.assets.has(ref)) throw notFound(`资产不存在: ${ref}`);
      }
      const conflicts = findExclusivityConflicts(this.state, {
        asset_refs: payload.asset_refs, scope,
        valid_from: payload.valid_from, valid_to: payload.valid_to, party: payload.party,
      });
      return [
        { type: EVENT_TYPES.PROPOSAL_SUBMITTED, payload },
        {
          type: EVENT_TYPES.DECISION_RECORDED,
          payload: this.#decisionPayload({
            kind: "PROPOSAL_EXCLUSIVITY_CHECK",
            proposal_id: payload.proposal_id,
            as_of_date: payload.submitted_on,
            usable: false,
            rights_covered: null,
            blocking_reasons: conflicts.length ? ["EXCLUSIVITY_BLOCKED"] : [],
            details: { conflicts },
          }),
        },
      ];
    });
  }

  // ---------- 合同版本与审批链 ----------

  createContract(input) {
    const payload = {
      contract_id: input.contract_id ?? newId("ctr"),
      proposal_id: input.proposal_id,
      title: input.title ?? "",
      approver_roles: [...new Set(input.approver_roles ?? [])],
      created_on: this.today(),
    };
    return this._commit("createContract", input.idempotency_key, () => {
      if (!this.state.proposals.has(payload.proposal_id)) throw notFound(`方案不存在: ${payload.proposal_id}`);
      if (payload.approver_roles.length === 0) throw invalid("合同必须显式配置审批角色链");
      if (this.state.contracts.has(payload.contract_id)) throw conflict(`合同已存在: ${payload.contract_id}`);
      return { type: EVENT_TYPES.CONTRACT_CREATED, payload };
    });
  }

  addContractVersion(input) {
    return this._commit("addContractVersion", input.idempotency_key, () => {
      const contract = this.state.contracts.get(input.contract_id);
      if (!contract) throw notFound(`合同不存在: ${input.contract_id}`);
      const nextNo = Math.max(0, ...contract.versions.keys()) + 1;
      const payload = {
        contract_id: input.contract_id,
        version_no: input.version_no ?? nextNo,
        source_ids: [...new Set(input.source_ids ?? [])],
        royalty: input.royalty ?? null,
        created_on: input.created_on ? toDay(input.created_on) : this.today(),
        note: input.note ?? "",
      };
      if (contract.versions.has(payload.version_no)) throw conflict(`版本号已存在: v${payload.version_no}`);
      if (payload.source_ids.length === 0) throw invalid("合同版本必须引用至少一条权利来源");
      for (const sid of payload.source_ids) {
        if (!this.state.grants.has(sid)) throw notFound(`权利来源不存在: ${sid}`);
      }
      if (!payload.royalty || typeof payload.royalty.rate !== "number") {
        throw invalid("合同版本必须显式给出版税条款 royalty.rate");
      }
      return { type: EVENT_TYPES.CONTRACT_VERSION_ADDED, payload };
    });
  }

  recordApproval(input) {
    const payload = {
      contract_id: input.contract_id,
      version_no: input.version_no,
      role: input.role,
      approver: input.approver,
      at: input.at ? toDay(input.at) : this.today(),
    };
    return this._commit("recordApproval", input.idempotency_key, () => {
      const version = this.state.contracts.get(payload.contract_id)?.versions.get(payload.version_no);
      if (!version) throw notFound(`合同版本不存在: ${payload.contract_id} v${payload.version_no}`);
      const contract = this.state.contracts.get(payload.contract_id);
      if (!contract.approver_roles.includes(payload.role)) {
        throw invalid(`角色 ${payload.role} 不在该合同审批链中`, { required_roles: contract.approver_roles });
      }
      if (version.approvals.has(payload.role)) throw conflict(`角色 ${payload.role} 已批准 v${payload.version_no}`);
      return { type: EVENT_TYPES.APPROVAL_RECORDED, payload };
    });
  }

  #fullyApproved(contract, version) {
    return contract.approver_roles.every((role) => version.approvals.has(role));
  }

  // ---------- 范围凭证签发 ----------

  issueCertificate(input) {
    return this._commit("issueCertificate", input.idempotency_key, () => {
      const proposal = this.state.proposals.get(input.proposal_id);
      if (!proposal) throw notFound(`方案不存在: ${input.proposal_id}`);

      // 唯一索引：同方案 / 同内容指纹只能有一张有效凭证
      const existingByProposal = this.state.activeCertByProposal.get(proposal.proposal_id);
      if (existingByProposal) {
        throw conflict("该方案已存在有效凭证，并发提交不得签发第二张", { cert_id: existingByProposal });
      }
      const existingByFp = this.state.activeCertByFingerprint.get(proposal.fingerprint);
      if (existingByFp) {
        throw conflict("相同合作方案已存在有效凭证", { cert_id: existingByFp });
      }

      const contract = this.state.contracts.get(input.contract_id);
      if (!contract) throw notFound(`合同不存在: ${input.contract_id}`);
      if (contract.proposal_id !== proposal.proposal_id) {
        throw invalid("合同与方案不匹配");
      }
      const version = input.version_no
        ? contract.versions.get(input.version_no)
        : [...contract.versions.values()].sort((a, b) => b.version_no - a.version_no)[0];
      if (!version) throw invalid("合同尚无版本，无法签发凭证");
      if (!this.#fullyApproved(contract, version)) {
        throw invalid("审批链与合同版本不一致：该版本尚未取得全部必需角色批准", {
          required_roles: contract.approver_roles,
          approved_roles: [...version.approvals.keys()],
        });
      }

      const issuedOn = toDay(input.issued_on ?? this.today());
      const reqBase = {
        media: proposal.scope.media[0],
        territory: proposal.scope.territories[0],
        channel: proposal.scope.channels[0],
        party: proposal.party,
      };

      // 逐层（含来源闭包）核对权利覆盖、再许可链、独家阻断
      const closureRefs = new Set();
      for (const ref of proposal.asset_refs) {
        for (const a of assetClosure(this.state, ref)) closureRefs.add(a.ref);
      }
      const approvedSources = new Set(version.source_ids);
      let certScope = proposal.scope;
      let windowFrom = proposal.valid_from;
      let windowTo = proposal.valid_to;
      const missing = [];

      for (const ref of closureRefs) {
        const asset = this.state.assets.get(ref);
        for (const media of proposal.scope.media) {
          for (const territory of proposal.scope.territories) {
            for (const channel of proposal.scope.channels) {
              const req = { media, territory, channel, party: proposal.party };
              // 权利核对在方案窗口起点进行（允许凭证先于授权生效日签发，窗口另行裁剪交集）
              const chains = validGrantChains(this.state, ref, req, proposal.valid_from);
              // 凭证只能建立在"本合同已批准版本引用"的来源上
              const approved = chains.filter((chain) =>
                chain.every((g) => approvedSources.has(g.source_id)));
              const coveredHolders = new Set(approved.map((c) => c[0].grantor_ref));
              const miss = [...asset.holders].filter((h) => !coveredHolders.has(h));
              if (miss.length) {
                missing.push({ asset_ref: ref, media, territory, channel, holder_refs: miss });
              }
              const blocks = exclusivityBlocks(this.state, [ref], req, proposal.valid_from);
              if (blocks.length) {
                throw conflict("存在独家窗口阻断，不能签发凭证", { blocks });
              }
              for (const chain of approved) {
                for (const g of chain) {
                  certScope = intersectScopes(certScope, g.scope);
                  if (g.valid_from > windowFrom) windowFrom = g.valid_from;
                  if (windowTo === null) windowTo = g.valid_to ?? null;
                  else if (g.valid_to !== null && g.valid_to < windowTo) windowTo = g.valid_to;
                }
              }
            }
          }
        }
      }

      if (missing.length) {
        throw invalid("权利来源未覆盖方案全部维度或缺少权利人同意", { missing });
      }
      if (certScope.media.length === 0 || certScope.territories.length === 0 || certScope.channels.length === 0) {
        throw invalid("批准来源与方案的媒介/地区/渠道交集为空，不能签发凭证", { cert_scope: certScope });
      }
      if (windowTo !== null && windowFrom >= windowTo) {
        throw invalid("批准来源期限与方案窗口交集为空", { windowFrom, windowTo });
      }

      const certId = newId("cert");
      const payload = {
        cert_id: certId,
        proposal_id: proposal.proposal_id,
        fingerprint: proposal.fingerprint,
        contract_id: contract.contract_id,
        version_no: version.version_no,
        counterparty: proposal.party,
        asset_refs: [...closureRefs],
        scope: certScope,
        valid_from: windowFrom,
        valid_to: windowTo,
        issued_on: issuedOn,
        source_ids: version.source_ids,
      };
      return { type: EVENT_TYPES.CERTIFICATE_ISSUED, payload };
    }).then((r) => r.duplicate ? r : { ...r, cert_id: r.events?.[0]?.payload.cert_id });
  }

  revokeCertificate(input) {
    return this._commit("revokeCertificate", input.idempotency_key, () => {
      const cert = this.state.certificates.get(input.cert_id);
      if (!cert) throw notFound(`凭证不存在: ${input.cert_id}`);
      if (cert.revoked_on) throw conflict(`凭证已于 ${cert.revoked_on} 撤销`);
      return {
        type: EVENT_TYPES.CERTIFICATE_REVOKED,
        payload: {
          cert_id: cert.cert_id, proposal_id: cert.proposal_id,
          on_date: toDay(input.on_date ?? this.today()), reason: input.reason ?? "",
        },
      };
    });
  }

  // 补签材料晚到：只追加，最早自 recorded_on 起对凭证产生补充效力
  recordSupplement(input) {
    return this._commit("recordSupplement", input.idempotency_key, () => {
      const cert = this.state.certificates.get(input.cert_id);
      if (!cert) throw notFound(`凭证不存在: ${input.cert_id}`);
      if (!this.state.grants.has(input.source_id)) throw notFound(`权利来源不存在: ${input.source_id}`);
      return {
        type: EVENT_TYPES.SUPPLEMENT_RECORDED,
        payload: {
          cert_id: cert.cert_id,
          source_id: input.source_id,
          recorded_on: toDay(input.recorded_on ?? this.today()),
          note: input.note ?? "",
        },
      };
    });
  }

  // ---------- 素材领取 / 样稿 / 实际使用 / 销售 ----------

  #activeCertForUse(certId, date, quantity) {
    const cert = this.state.certificates.get(certId);
    if (!cert) throw notFound(`凭证不存在: ${certId}`);
    if (cert.revoked_on && date >= cert.revoked_on) throw invalid(`凭证已于 ${cert.revoked_on} 撤销`, { code: "CERT_REVOKED" });
    if (!coversDay(date, cert.valid_from, cert.valid_to ?? null)) {
      throw invalid(`凭证在 ${date} 不在有效期 [${cert.valid_from}, ${cert.valid_to ?? "∞"})`, { code: "CERT_EXPIRED" });
    }
    if (cert.scope.max_quantity !== null) {
      const used = this.state.usages
        .filter((u) => u.cert_id === certId && u.on_date <= date)
        .reduce((s, u) => s + (u.quantity ?? 0), 0);
      if (used + quantity > cert.scope.max_quantity) {
        throw conflict(`超出凭证数量上限：已用 ${used}，本次 ${quantity}，上限 ${cert.scope.max_quantity}`, {
          code: "QUANTITY_EXCEEDED", used, requested: quantity, max_quantity: cert.scope.max_quantity,
        });
      }
    }
    return cert;
  }

  #useEvent(type, input, kind) {
    return this._commit(kind, input.idempotency_key, () => {
      const date = toDay(input.on_date ?? this.today());
      const quantity = input.quantity ?? 1;
      this.#activeCertForUse(input.cert_id, date, quantity);
      if (input.asset_ref && !this.state.assets.has(input.asset_ref)) throw notFound(`资产不存在: ${input.asset_ref}`);
      return {
        type,
        payload: {
          cert_id: input.cert_id,
          asset_ref: input.asset_ref ?? null,
          quantity,
          on_date: date,
          channel: input.channel ?? null,
          media: input.media ?? null,
          territory: input.territory ?? null,
        },
      };
    });
  }

  pickupMaterial(input) { return this.#useEvent(EVENT_TYPES.MATERIAL_PICKED_UP, input, "pickupMaterial"); }
  recordSample(input) { return this.#useEvent(EVENT_TYPES.SAMPLE_RECORDED, input, "recordSample"); }
  recordUsage(input) { return this.#useEvent(EVENT_TYPES.USAGE_RECORDED, input, "recordUsage"); }

  recordSale(input) {
    return this._commit("recordSale", input.idempotency_key, () => {
      const date = toDay(input.on_date ?? this.today());
      const cert = this.state.certificates.get(input.cert_id);
      if (!cert) throw notFound(`凭证不存在: ${input.cert_id}`);
      if (!coversDay(date, cert.valid_from, cert.valid_to ?? null)) {
        throw invalid(`销售日期 ${date} 不在凭证有效期内`, { code: "CERT_EXPIRED" });
      }
      // period_month 允许跨月补录的退货归属原结算月份；缺省按发生日所在月
      let month = input.period_month ?? monthOf(date);
      if (!/^\d{4}-\d{2}$/.test(month)) throw invalid("period_month 格式应为 YYYY-MM");
      if (month > monthOf(date)) throw invalid("补录归属月份不能晚于记录发生月");
      const payload = {
        sale_id: input.sale_id ?? newId("sale"),
        cert_id: cert.cert_id,
        on_date: date,
        month,
        units: input.units ?? 0,
        returned_units: input.returned_units ?? 0,
        gross_amount: input.gross_amount ?? 0,
        returned_amount: input.returned_amount ?? 0,
      };
      return { type: EVENT_TYPES.SALE_RECORDED, payload };
    });
  }

  // ---------- 判断入口 ----------

  evaluate(query) {
    const date = toDay(query.date ?? this.today());
    const fullQuery = { ...query, date };
    if (!fullQuery.party) throw invalid("查询必须给出 party（被许可方）");
    if (!fullQuery.media || !fullQuery.territory || !fullQuery.channel) {
      throw invalid("查询必须显式给出 media / territory / channel，缺失维度不做推定");
    }
    resolveImage(this.state, fullQuery); // 提前 404

    const questionKey = canonicalHash({
      ref: fullQuery.ref ?? null,
      url: fullQuery.url ?? null,
      date,
      media: fullQuery.media,
      territory: fullQuery.territory,
      channel: fullQuery.channel,
      party: fullQuery.party,
    });

    return this._commit("evaluate", null, () => {
      // decisionId 在临界区内生成，保证问题键与结论一一对应
      const decisionId = newId("dec");
      const result = evaluateNow(this.state, fullQuery, { decisionId, recordedAt: this.today() });
      const supersedes = this.state.latestDecisionByQuestion.get(questionKey) ?? null;
      return {
        type: EVENT_TYPES.DECISION_RECORDED,
        payload: this.#decisionPayload({
          kind: "USAGE_EVALUATION",
          decision_id: decisionId,
          question_key: questionKey,
          supersedes_decision_id: supersedes,
          as_of_date: date,
          query: fullQuery,
          usable: result.usable,
          rights_covered: result.rights_covered,
          blocking_reasons: result.blocking_reasons,
          result,
        }),
      };
    }).then((r) => {
      const payload = r.events[0].payload;
      return payload.result;
    });
  }

  #decisionPayload(extra) {
    return {
      decision_id: extra.decision_id ?? newId("dec"),
      kind: extra.kind,
      question_key: extra.question_key ?? canonicalHash({ ...extra, kind: undefined }),
      supersedes_decision_id: extra.supersedes_decision_id ?? null,
      recorded_on: this.today(),
      proposal_id: extra.proposal_id ?? null,
      as_of_date: extra.as_of_date,
      usable: extra.usable,
      rights_covered: extra.rights_covered,
      blocking_reasons: extra.blocking_reasons ?? [],
      details: extra.details ?? null,
      result: extra.result ?? null,
      query: extra.query ?? null,
    };
  }

  // ---------- 结算 ----------

  confirmSettlement(input) {
    return this._commit("confirmSettlement", input.idempotency_key, () => {
      const month = input.month;
      if (!/^\d{4}-\d{2}$/.test(month)) throw invalid("月份格式应为 YYYY-MM");
      const key = `${input.cert_id}:${month}`;
      if (this.state.settlements.has(key)) {
        const existing = this.state.settlements.get(key);
        throw conflict("该月份已确认结算，只能追加可追溯更正", { settlement_id: existing.settlement_id });
      }
      const calc = computeSettlement(this.state, { cert_id: input.cert_id, month });
      const alreadyPaid = input.already_paid ?? 0;
      const payload = {
        settlement_id: newId("stl"),
        cert_id: input.cert_id,
        month,
        confirmed_on: this.today(),
        already_paid: alreadyPaid,
        ...calc,
        balance_due: Math.round((calc.payable_royalty - alreadyPaid) * 100) / 100,
      };
      return { type: EVENT_TYPES.SETTLEMENT_CONFIRMED, payload };
    });
  }

  correctSettlement(input) {
    return this._commit("correctSettlement", input.idempotency_key, () => {
      const key = `${input.cert_id}:${input.month}`;
      const entry = this.state.settlements.get(key);
      if (!entry) throw notFound(`结算不存在: ${key}，请先确认`);
      // 差额基准：若已存在更正，以最近一次更正后的应付为基准形成更正链
      const prior = entry.corrections[entry.corrections.length - 1];
      const basePayable = prior ? prior.payable_royalty : entry.confirmed.payable_royalty;
      const calc = computeCorrection(this.state, {
        cert_id: input.cert_id, month: input.month,
        originalPayable: Number(input.original_payable_royalty ?? basePayable),
      });
      const payload = {
        correction_id: newId("corr"),
        settlement_id: entry.settlement_id,
        cert_id: input.cert_id,
        month: input.month,
        corrected_on: this.today(),
        reason: input.reason ?? "",
        ...calc,
        balance_due: calc.correction_delta,
      };
      return { type: EVENT_TYPES.SETTLEMENT_CORRECTED, payload };
    });
  }

  // ---------- 查询投影 ----------

  getState() { return this.state; }

  decisionHistory(query) {
    const date = toDay(query.date ?? this.today());
    const questionKey = canonicalHash({
      ref: query.ref ?? null, url: query.url ?? null, date,
      media: query.media, territory: query.territory, channel: query.channel, party: query.party,
    });
    const latestId = this.state.latestDecisionByQuestion.get(questionKey);
    const chain = this.state.decisions
      .filter((d) => d.question_key === questionKey)
      .sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
    return { question_key: questionKey, latest_decision_id: latestId ?? null, history: chain };
  }
}
