// 事件类型与版本号。事件一旦写入日志结构即冻结；演进只能新增事件类型或新版本。
export const EVENT_TYPES = Object.freeze({
  WORK_REGISTERED: "WorkRegistered",
  CHARACTER_REGISTERED: "CharacterRegistered",
  TRANSLATION_REGISTERED: "TranslationRegistered",
  IMAGE_REGISTERED: "ImageRegistered",
  TRADEMARK_REGISTERED: "TrademarkRegistered",
  DERIVATION_ADDED: "DerivationAdded",

  GRANT_RECORDED: "GrantRecorded",

  PROPOSAL_SUBMITTED: "ProposalSubmitted",

  CONTRACT_CREATED: "ContractCreated",
  CONTRACT_VERSION_ADDED: "ContractVersionAdded",
  APPROVAL_RECORDED: "ApprovalRecorded",

  CERTIFICATE_ISSUED: "CertificateIssued",
  CERTIFICATE_REVOKED: "CertificateRevoked",
  SUPPLEMENT_RECORDED: "SupplementRecorded",

  MATERIAL_PICKED_UP: "MaterialPickedUp",
  SAMPLE_RECORDED: "SampleRecorded",
  USAGE_RECORDED: "UsageRecorded",
  SALE_RECORDED: "SaleRecorded",

  DECISION_RECORDED: "DecisionRecorded",

  SETTLEMENT_CONFIRMED: "SettlementConfirmed",
  SETTLEMENT_CORRECTED: "SettlementCorrected",
});

export const EVENT_VERSION = 1;
