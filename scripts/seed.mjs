// 种子数据：舞台联名事故场景 + 一条正规授权路径。
// 用法：node scripts/seed.mjs [--reset] [EVENTS_FILE]
import fs from "node:fs";
import { RightsService } from "../src/domain/service.mjs";
import { JsonlEventStore } from "../src/store/jsonl-store.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? "data/events.jsonl";
if (process.argv.includes("--reset") && fs.existsSync(file)) fs.rmSync(file);
if (fs.existsSync(file) && fs.statSync(file).size > 0) {
  console.error(`事件日志 ${file} 非空；如需重建请加 --reset`);
  process.exit(1);
}

const svc = new RightsService(new JsonlEventStore(file), () => "2026-09-17");

async function main() {
  // ---- 资产：作品 / 角色（含名称权）/ 译本 / 插画 / 商标 ----
  await svc.registerAsset({ kind: "work", ref: "work:classic-novel", title: "《长河》", holders: ["holder-author-heirs"] });
  await svc.registerAsset({ kind: "character", ref: "character:character-a", title: "人物 A（含人物名称权）", holders: ["holder-author-heirs"], derived_from: ["work:classic-novel"] });
  await svc.registerAsset({ kind: "translation", ref: "translation:chapter-3:paragraph-2", title: "第三章第二段译本", holders: ["holder-translator-a"], derived_from: ["work:classic-novel"] });
  await svc.registerAsset({ kind: "image", ref: "illustration:character-a:pose-7", title: "人物 A 插画 pose-7", urls: ["https://cdn.example.com/stage/pose-7.jpg"], holders: ["holder-artist-b"], derived_from: ["character:character-a"] });
  await svc.registerAsset({ kind: "image", ref: "illustration:stage-keyvisual", title: "舞台联名主视觉（含译文片段）", urls: ["https://cdn.example.com/stage/keyvisual.png"], holders: ["holder-artist-b"], derived_from: ["character:character-a", "translation:chapter-3:paragraph-2"] });
  await svc.registerAsset({ kind: "trademark", ref: "trademark:character-a-word", title: "人物 A 文字商标", holders: ["holder-tm-owner"], derived_from: ["character:character-a"] });
  await svc.registerAsset({ kind: "image", ref: "illustration:retro-poster", title: "独立海报（补签回溯示例）", urls: ["https://cdn.example.com/stage/retro-poster.jpg"], holders: ["holder-artist-c"], derived_from: [] });

  const ONLINE = { media: ["physical-merchandise", "online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: null, sublicense: true };
  const BROAD = { media: ["exhibition", "physical-merchandise", "online-product-image"], territories: ["CN"], channels: ["onsite", "online-store", "social-media"], max_quantity: null, sublicense: true };

  // ---- 权利人 → 出版社 的根授权 ----
  await svc.recordGrant({ source_id: "g-work-pub", asset_ref: "work:classic-novel", grantor_ref: "holder-author-heirs", grantee_ref: "party-publisher", valid_from: "2025-01-01", valid_to: "2030-01-01", scope: BROAD, recorded_on: "2025-01-10" });
  await svc.recordGrant({ source_id: "g-char-pub", asset_ref: "character:character-a", grantor_ref: "holder-author-heirs", grantee_ref: "party-publisher", valid_from: "2025-01-01", valid_to: "2030-01-01", scope: BROAD, recorded_on: "2025-01-10" });
  await svc.recordGrant({ source_id: "g-tm-pub", asset_ref: "trademark:character-a-word", grantor_ref: "holder-tm-owner", grantee_ref: "party-publisher", valid_from: "2025-06-01", valid_to: "2028-06-01", scope: { media: ["physical-merchandise", "online-product-image"], territories: ["CN"], channels: ["onsite", "online-store"], max_quantity: null, sublicense: true }, recorded_on: "2025-06-05" });
  // 旧样例两条：显式补全渠道与数量；仍然只是展陈/线下、且插画不可再许可超范围
  await svc.recordGrant({ source_id: "rights-translation-1", asset_ref: "translation:chapter-3:paragraph-2", grantor_ref: "holder-translator-a", grantee_ref: "party-publisher", valid_from: "2025-01-01", valid_to: "2030-01-01", scope: { media: ["exhibition"], territories: ["CN"], channels: ["onsite"], max_quantity: null, sublicense: false }, recorded_on: "2025-01-15" });
  await svc.recordGrant({ source_id: "rights-image-4", asset_ref: "illustration:character-a:pose-7", grantor_ref: "holder-artist-b", grantee_ref: "party-publisher", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: { media: ["exhibition", "physical-merchandise"], territories: ["CN"], channels: ["onsite"], max_quantity: null, sublicense: true }, recorded_on: "2026-01-05" });
  // 线上销售所需的独立根授权
  await svc.recordGrant({ source_id: "rights-image-online", asset_ref: "illustration:character-a:pose-7", grantor_ref: "holder-artist-b", grantee_ref: "party-publisher", valid_from: "2026-01-01", valid_to: "2027-01-01", scope: ONLINE, recorded_on: "2026-01-05" });

  // ---- 事故厂商：只取得境内短期线下展陈权 ----
  await svc.recordGrant({ source_id: "g-stage-vendor-img", asset_ref: "illustration:character-a:pose-7", grantor_ref: "party-publisher", grantee_ref: "vendor-stage-co", parent_source_id: "rights-image-4", valid_from: "2026-03-01", valid_to: "2026-04-01", scope: { media: ["exhibition"], territories: ["CN"], channels: ["onsite"], max_quantity: 500, sublicense: false }, recorded_on: "2026-02-20" });
  await svc.recordGrant({ source_id: "g-stage-vendor-char", asset_ref: "character:character-a", grantor_ref: "party-publisher", grantee_ref: "vendor-stage-co", parent_source_id: "g-char-pub", valid_from: "2026-03-01", valid_to: "2026-04-01", scope: { media: ["exhibition"], territories: ["CN"], channels: ["onsite"], max_quantity: 500, sublicense: false }, recorded_on: "2026-02-20" });

  // ---- 正规厂商：完整线上授权链 + 合同 + 凭证 ----
  await svc.recordGrant({ source_id: "g-good-work", asset_ref: "work:classic-novel", grantor_ref: "party-publisher", grantee_ref: "vendor-good-co", parent_source_id: "g-work-pub", valid_from: "2026-02-01", valid_to: "2026-12-01", scope: ONLINE, recorded_on: "2026-01-20" });
  await svc.recordGrant({ source_id: "g-good-char", asset_ref: "character:character-a", grantor_ref: "party-publisher", grantee_ref: "vendor-good-co", parent_source_id: "g-char-pub", valid_from: "2026-02-01", valid_to: "2026-12-01", scope: ONLINE, recorded_on: "2026-01-20" });
  await svc.recordGrant({ source_id: "g-good-img", asset_ref: "illustration:character-a:pose-7", grantor_ref: "party-publisher", grantee_ref: "vendor-good-co", parent_source_id: "rights-image-online", valid_from: "2026-02-01", valid_to: "2026-12-01", scope: ONLINE, recorded_on: "2026-01-20" });

  const goodScope = { media: ["online-product-image"], territories: ["CN"], channels: ["online-store"], max_quantity: 1000, sublicense: false };
  const proposal = await svc.submitProposal({ proposal_id: "prop-good-online", party: "vendor-good-co", asset_refs: ["illustration:character-a:pose-7"], scope: goodScope, valid_from: "2026-02-01", valid_to: "2026-12-01" });
  await svc.createContract({ contract_id: "ctr-good", proposal_id: "prop-good-online", title: "正规厂商线上周边授权合同", approver_roles: ["legal", "copyright", "finance"] });
  await svc.addContractVersion({ contract_id: "ctr-good", version_no: 1, source_ids: ["g-good-work", "g-work-pub", "g-good-char", "g-char-pub", "g-good-img", "rights-image-online"], royalty: { rate: 0.12, minimum_guarantee: 10000, currency: "CNY" }, created_on: "2026-01-22", note: "首版" });
  await svc.recordApproval({ contract_id: "ctr-good", version_no: 1, role: "legal", approver: "user-legal-1", at: "2026-01-23" });
  await svc.recordApproval({ contract_id: "ctr-good", version_no: 1, role: "copyright", approver: "user-copyright-1", at: "2026-01-23" });
  await svc.recordApproval({ contract_id: "ctr-good", version_no: 1, role: "finance", approver: "user-finance-1", at: "2026-01-24" });
  const cert = await svc.issueCertificate({ proposal_id: "prop-good-online", contract_id: "ctr-good", issued_on: "2026-01-25" });
  console.log("已签发凭证:", cert.cert_id);

  // 素材领取 / 样稿 / 实际使用（计入数量余额）
  await svc.pickupMaterial({ cert_id: cert.cert_id, asset_ref: "illustration:character-a:pose-7", quantity: 100, on_date: "2026-02-02" });
  await svc.recordSample({ cert_id: cert.cert_id, asset_ref: "illustration:character-a:pose-7", quantity: 20, on_date: "2026-02-10" });
  await svc.recordUsage({ cert_id: cert.cert_id, asset_ref: "illustration:character-a:pose-7", quantity: 700, on_date: "2026-03-15", channel: "online-store", media: "online-product-image", territory: "CN" });

  // 三月销售与退货
  await svc.recordSale({ cert_id: cert.cert_id, on_date: "2026-03-20", units: 600, returned_units: 30, gross_amount: 120000, returned_amount: 6000 });
  // 三月结算先确认：净销售 114000 × 12% = 13680，高于最低保证 10000
  const stlMarch = await svc.confirmSettlement({ cert_id: cert.cert_id, month: "2026-03", already_paid: 10000 });
  console.log("三月结算应付 =", stlMarch.events[0].payload.payable_royalty, "差额 =", stlMarch.events[0].payload.balance_due);
  // 四月：销售不足最低保证，按最低保证计提
  await svc.recordSale({ cert_id: cert.cert_id, on_date: "2026-04-18", units: 150, returned_units: 0, gross_amount: 30000, returned_amount: 0 });
  await svc.confirmSettlement({ cert_id: cert.cert_id, month: "2026-04", already_paid: 10000 });
  // 五月补录的三月退货（归属原结算月份），只能追加更正，不能改掉原确认
  await svc.recordSale({ cert_id: cert.cert_id, on_date: "2026-05-06", units: 0, returned_units: 100, gross_amount: 0, returned_amount: 20000, period_month: "2026-03" });
  const corrMarch = await svc.correctSettlement({ cert_id: cert.cert_id, month: "2026-03", reason: "五月补录三月退货 20000 元" });
  console.log("三月重算应付 =", corrMarch.events[0].payload.payable_royalty, "更正差额 =", corrMarch.events[0].payload.balance_due);

  // ---- 独家窗口：另一厂商独占社媒渠道 ----
  await svc.recordGrant({ source_id: "g-excl-social-char", asset_ref: "character:character-a", grantor_ref: "party-publisher", grantee_ref: "vendor-exclusive", parent_source_id: "g-char-pub", valid_from: "2026-05-01", valid_to: "2026-08-01", scope: { media: ["online-product-image"], territories: ["CN"], channels: ["social-media"], max_quantity: null, sublicense: false, exclusive: true }, recorded_on: "2026-04-10" });

  // ---- 补签回溯：7 月的用途在当时缺同意，9 月补签后重新判断 ----
  const retroDecision1 = await svc.evaluate({ ref: "illustration:retro-poster", date: "2026-07-15", media: "online-product-image", territory: "CN", channel: "online-store", party: "vendor-retro-co" });
  console.log("补签前 2026-07-15 判断 usable =", retroDecision1.usable, retroDecision1.blocking_reasons);

  await svc.recordGrant({ source_id: "g-retro-root", asset_ref: "illustration:retro-poster", grantor_ref: "holder-artist-c", grantee_ref: "party-publisher", valid_from: "2026-06-01", valid_to: "2027-06-01", scope: ONLINE, recorded_on: "2026-09-02" });
  await svc.recordGrant({ source_id: "g-retro-leaf", asset_ref: "illustration:retro-poster", grantor_ref: "party-publisher", grantee_ref: "vendor-retro-co", parent_source_id: "g-retro-root", valid_from: "2026-06-01", valid_to: "2027-01-01", scope: { ...ONLINE, max_quantity: 200 }, recorded_on: "2026-09-05" });
  await svc.submitProposal({ proposal_id: "prop-retro", party: "vendor-retro-co", asset_refs: ["illustration:retro-poster"], scope: { ...goodScope, max_quantity: 200 }, valid_from: "2026-06-01", valid_to: "2027-01-01" });
  await svc.createContract({ contract_id: "ctr-retro", proposal_id: "prop-retro", title: "补签合同（回溯生效）", approver_roles: ["legal", "copyright"] });
  await svc.addContractVersion({ contract_id: "ctr-retro", version_no: 1, source_ids: ["g-retro-root", "g-retro-leaf"], royalty: { rate: 0.1, minimum_guarantee: 0, currency: "CNY" }, created_on: "2026-09-08" });
  await svc.recordApproval({ contract_id: "ctr-retro", version_no: 1, role: "legal", approver: "user-legal-1", at: "2026-09-08" });
  await svc.recordApproval({ contract_id: "ctr-retro", version_no: 1, role: "copyright", approver: "user-copyright-1", at: "2026-09-09" });
  await svc.issueCertificate({ proposal_id: "prop-retro", contract_id: "ctr-retro", issued_on: "2026-09-10" });
  const retroDecision2 = await svc.evaluate({ ref: "illustration:retro-poster", date: "2026-07-15", media: "online-product-image", territory: "CN", channel: "online-store", party: "vendor-retro-co" });
  console.log("补签后 2026-07-15 判断 usable =", retroDecision2.usable, "retroactive =", retroDecision2.retroactive_basis, "supersedes =", retroDecision2.decision_id !== retroDecision1.decision_id);

  // ---- 事故现场：今日对线上图片的判断（写入事件，结论可追溯）----
  const incident = await svc.evaluate({ url: "https://cdn.example.com/stage/pose-7.jpg", date: "2026-09-17", media: "physical-merchandise", territory: "CN", channel: "online-store", party: "vendor-stage-co" });
  console.log("事故图片今日判断 usable =", incident.usable, incident.blocking_reasons);
  console.log("缺少同意:", JSON.stringify(incident.missing_consents));

  // ---- 正规厂商的判断与结算 ----
  const goodEval = await svc.evaluate({ ref: "illustration:character-a:pose-7", date: "2026-03-16", media: "online-product-image", territory: "CN", channel: "online-store", party: "vendor-good-co" });
  console.log("正规厂商 2026-03-16 判断 usable =", goodEval.usable, "凭证 =", goodEval.certificate.cert_id);

  // 独家窗口签约前检查（只读）
  const clash = svc.checkExclusivity({ party: "vendor-good-co", asset_refs: ["character:character-a"], scope: { media: ["online-product-image"], territories: ["CN"], channels: ["social-media"], max_quantity: null, sublicense: false, exclusive: true }, valid_from: "2026-06-01", valid_to: "2026-07-01" });
  console.log("独家窗口冲突数 =", clash.conflicts.length, "->", clash.conflicts[0]?.source_id);

  console.log("种子数据完成，事件文件:", file);
}

main().catch((err) => { console.error(err); process.exit(1); });
