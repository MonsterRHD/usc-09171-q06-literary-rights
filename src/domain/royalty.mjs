import { lastDayOfMonth } from "./dates.mjs";

// 依据指定月份月末仍有效的、已完整批准的最新合同版本取版税条款。
export function effectiveRoyaltyTerms(state, contractId, month) {
  const contract = state.contracts.get(contractId);
  if (!contract) return null;
  const cutoff = lastDayOfMonth(month);
  let chosen = null;
  for (const version of contract.versions.values()) {
    const fullyApproved = contract.approver_roles.every((role) => version.approvals.has(role));
    if (!fullyApproved) continue;
    if (version.created_on > cutoff) continue; // 次月才成立的版本不得回溯适用
    if (!chosen || version.created_on > chosen.created_on) chosen = version;
  }
  return chosen ? { version_no: chosen.version_no, royalty: chosen.royalty } : null;
}

// 跨月结算：净销售（销售 − 退货）× 税率，与当月最低保证取大；返回应付差额。
export function computeSettlement(state, { cert_id, month }) {
  const lines = state.sales.filter((s) => s.cert_id === cert_id && s.month === month);
  let gross = 0;
  let returns = 0;
  let netUnits = 0;
  for (const s of lines) {
    gross += Number(s.gross_amount) || 0;
    returns += Number(s.returned_amount) || 0;
    netUnits += (Number(s.units) || 0) - (Number(s.returned_units) || 0);
  }
  const netSales = gross - returns;

  const cert = state.certificates.get(cert_id);
  const terms = cert ? effectiveRoyaltyTerms(state, cert.contract_id, month) : null;
  if (!terms) {
    const err = new Error(`凭证 ${cert_id} 在 ${month} 没有已生效的版税条款，无法结算`);
    err.code = "INVALID";
    throw err;
  }
  const rate = Number(terms.royalty.rate) || 0;
  const minimum = Number(terms.royalty.minimum_guarantee) || 0;
  const currency = terms.royalty.currency ?? "CNY";

  const royaltyFromSales = Math.round(netSales * rate * 100) / 100;
  const payable = Math.max(royaltyFromSales, minimum);

  return {
    month,
    cert_id,
    contract_id: cert.contract_id,
    version_no: terms.version_no,
    currency,
    rate,
    minimum_guarantee: minimum,
    gross_sales: Math.round(gross * 100) / 100,
    returned_sales: Math.round(returns * 100) / 100,
    net_sales: Math.round(netSales * 100) / 100,
    net_units: netUnits,
    royalty_from_sales: royaltyFromSales,
    payable_royalty: payable,
    line_count: lines.length,
  };
}

// 更正只重算并留痕：原确认不变，追加差额（可为负，代表追回）。
// 更正差额相对"原确认应付"，回答"按现有数据应当补/退多少"。
export function computeCorrection(state, { cert_id, month, originalPayable }) {
  const recomputed = computeSettlement(state, { cert_id, month });
  const delta = Math.round((recomputed.payable_royalty - originalPayable) * 100) / 100;
  return { ...recomputed, original_payable_royalty: originalPayable, correction_delta: delta };
}
