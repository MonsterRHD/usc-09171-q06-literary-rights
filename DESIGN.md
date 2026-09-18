# 授权决策系统设计

## 1. 目标：一个判断入口

法务在任意日期 `D` 查询一张线上图片（内部 `asset_ref` 或公开 URL），系统必须回答：

1. 该用途在当日是否可用；
2. 可用的依据是哪一条权利来源、哪一份合同的哪一个审批版本；
3. 不可用时缺的是哪位权利人对哪一层资产（作品 / 角色 / 译本 / 图像 / 商标）的同意；
4. 历史上对同一问题给出过的结论不得被改写。

业务同事在签约前对合作方案做独家窗口冲突检查，避免在同一媒介 / 地区 / 渠道 / 期限上与既有独家授权相撞。

## 2. 领域模型：来源关系拆到最小权利单元

资产（asset）五类，沿"衍生自"边构成来源链：

```
work（作品）
  ├─ character（角色，含人物名称权）
  │    ├─ image（插画）
  │    └─ trademark（商标，可挂在角色/名称上）
  └─ translation（译本）── 含译文片段的图像同时衍生自 translation
```

评估一张图时，取其**传递闭包**：图 → 角色 → 作品，以及图所嵌入的译本、商标。每一层资产各有权利人（可多人，如共同作者），任一层缺同意即不可用。

每个权利来源（grant）是一个最小权利单元：

| 维度 | 字段 | 规则 |
|---|---|---|
| 媒介 | `scope.media[]` | 用途媒介必须显式命中 |
| 地区 | `scope.territories[]` | 同上 |
| 渠道 | `scope.channels[]` | `online-store` / `onsite` / `social-media`… |
| 期限 | `valid_from` / `valid_to` | **闭开区间 `[from, to)`**；`valid_to:null` 表示显式无固定期限 |
| 数量 | `scope.max_quantity` | 累计实际使用量（含样稿）不得超过 |
| 再许可 | `scope.sublicense` | 向下授权必须沿 `parent_source_id` 链逐跳验证 |
| 独家 | `scope.exclusive` | 独家窗口用于签约前冲突检查与排他阻断 |

**缺失维度不代表无限授权**：授权记录里没有 `channels`，就是没有授权任何渠道，而不是全渠道开放。这正是"境内短期展陈权被用于长期线上销售"被拦下的原因。

再许可链：权利人 H → 出版社 P 的授权须 `sublicense:true` 且范围覆盖；P → 厂商 V 的分授权通过 `parent_source_id` 指向上游来源，逐跳校验区间与范围。

## 3. 事件溯源：只追加，不改写

所有状态来自只追加事件日志（`data/events.jsonl`），命令处理器是纯函数 `(state, command) → events`，状态由回放重建。事件类型：

- 资产：`WorkRegistered` / `CharacterRegistered` / `TranslationRegistered` / `ImageRegistered` / `TrademarkRegistered` / `DerivationAdded`
- 授权：`GrantRecorded`
- 业务：`ProposalSubmitted`
- 合同：`ContractCreated` / `ContractVersionAdded` / `ApprovalRecorded`
- 凭证：`CertificateIssued` / `CertificateRevoked` / `SupplementRecorded`
- 使用：`MaterialPickedUp` / `SampleRecorded` / `UsageRecorded` / `SaleRecorded`
- 判断：`DecisionRecorded`
- 结算：`SettlementConfirmed` / `SettlementCorrected`

关键约定：**撤销、到期、超量、补签材料晚到、合同回溯生效，都只追加新的判断**。每次评估写一条 `DecisionRecorded`（含完整输入快照与结论），同一问题键的新结论以 `supersedes_decision_id` 指向旧结论，旧结论原样保留。合同回溯生效时（授权记录日晚于用途日但 `valid_from` 更早），新结论打 `retroactive_basis` 标记，无法抹掉当时的结论。

## 4. 审批链与唯一范围凭证

- 合同有版本；每个版本携带拟用的 `source_ids` 与版税条款。
- 审批角色表在合同模板中固定（如：法务、版权、财务）。**只有该版本的每一个必需角色都批准同一版本**，版本才成立；新版本追加后旧批准不延续。
- 签发条件：版本完整批准；方案所需每个资产的每条维度都被批准版本所引用的授权链覆盖（再许可逐跳通过）；与他人的独家窗口不冲突。
- 凭证范围是各授权范围的**严格交集**（按最小维度裁剪），不是方案申请范围。
- **唯一性**：一个合作方案至多有一张有效凭证。签发命令以方案内容哈希为幂等键，事件存储层有唯一索引；并发提交五次要么返回同一张凭证，要么 409；服务重启后唯一索引随回放重建。

## 5. 评估算法（`GET /v1/evaluate`）

输入：`ref|url` + `date` + `media/territory/channel[/quantity/party]`。

1. 解析图片 → 取资产来源闭包；
2. 逐层资产寻找覆盖当日 `[date, date+1)` 且逐维度命中、再许可链完整的授权；按授权人比对该层权利人，得出 `missing_consents`；
3. 检查他人独家窗口阻断（`EXCLUSIVITY_BLOCKED`）；
4. 检查范围凭证：存在、当日有效（区间含当日、撤销日之后无效）、累计用量未超 `max_quantity`；
5. 输出 `rights_covered` 与 `permitted`，`usable = 两者皆真`，逐层给出依据（source / contract / version / holder）与原因码；
6. 结论作为 `DecisionRecorded` 追加。

原因码：`EXPIRED` / `MEDIA_NOT_LICENSED` / `TERRITORY_NOT_LICENSED` / `CHANNEL_NOT_LICENSED` / `SUBLICENSE_NOT_ALLOWED` / `QUANTITY_EXCEEDED` / `MISSING_CONSENT` / `EXCLUSIVITY_BLOCKED` / `NO_CERTIFICATE` / `CERT_REVOKED` / `CERT_EXPIRED`。

## 6. 版税结算

按月（`YYYY-MM`）聚合 `SaleRecorded`（含退货数量与退货金额），取当月有效的合同版本条款：

```
净销售额 = 销售额 − 退货金额
应付版税 = max(净销售额 × 版税率, 当月最低保证)
差额     = 应付版税 − 已付
```

`SettlementConfirmed` 一经确认不可变；更正只能追加 `SettlementCorrected` 重算差额，保留更正链。幂等：同一（凭证, 月份）只有一条结算，重复运行返回原记录。

## 7. 并发与持久化

- 单写者串行提交（命令队列互斥）+ 幂等键 + 投影唯一索引，保证不产生第二张有效凭证；
- 日志顺序追加到 JSONL，重启回放；测试用临时日志文件验证"重启不重复签发"；
- HTTP 层接受 `Idempotency-Key` 头。
