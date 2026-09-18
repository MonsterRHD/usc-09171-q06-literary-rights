# 文学作品衍生授权

围绕**判断入口**建立的授权决策服务：在任意日期查询任一素材的任一使用方式，说明它**是否可用、依据哪份合同、缺少哪位权利人的同意**；业务同事在签约前即可看到独家窗口冲突。

## 基本约定

1. **闭开有效期**：所有有效期一律为 `[valid_from, valid_to)`——起始日可用，结束日起不可用。
2. **缺失维度不代表无限授权**：权利被拆到媒介、地区、渠道、期限、数量、再许可等最小单元；未写明的维度一律视为未授予。
3. **只追加判断**：撤销、到期、超量、补签材料晚到、合同回溯生效，都只追加新的判断记录，当时的结论永不改写。
4. **唯一范围凭证**：审批链与合同当前版本完全一致后才签发凭证；同一合作方案任意时刻至多一张有效凭证，并发提交与服务重启都不会制造出第二张。
5. **结算只留可追溯更正**：跨月结算依据有效条款、最低保证与退回产品生成版税差额；已确认的结算不修改，只能追加更正记录。

## 领域模型

- **素材（asset）**：`work` / `character` / `translation` / `image` / `trademark`，以 `derived_from` 记录来源关系（如 插画 → 角色 → 作品）。使用任一素材时，其全部祖先的权利人同意都会被逐一核对。
- **权利来源（rights source）**：权利人的授权声明，含 `asset_ref`、`holder_ref`、闭开有效期与范围。`contracts/rights-source.json` 中的既有样例在启动时幂等装载。
- **合作方案（proposal）**：提交时即返回独家窗口冲突（与既有合同授予、其他在途方案在媒介/地区/渠道/期限上相交且任一方声明独家）。
- **合同与版本（contract version）**：每个版本含生效窗口、授予清单、版税条款（费率 + 最低保证）与所需审批链；修订只产生新版本，生效日可回溯。
- **范围凭证（credential）**：审批链与合同当前版本完全一致后签发，签发幂等。
- **判断（judgment）**：每次查询、素材领取、样稿、实际使用、撤销都追加一条，含结论、原因、缺少的权利人同意与合同依据。
- **使用记录（usage）**：`sale` 需经判断入口许可才记录（占用数量）；`return` 只记录，供结算冲减。
- **结算（settlement）**：按合同 + 期间（YYYY-MM）生成，同一期间只有一份；`confirmed` 后只能追加 `correction`。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/assets` | 登记素材与来源关系 |
| GET | `/assets/:ref` | 查看素材及其完整来源链 |
| POST | `/rights-sources` | 登记权利来源声明（补签材料亦走此入口） |
| POST | `/proposals` | 提交合作方案，响应含独家窗口冲突 |
| GET | `/proposals/:id/conflicts` | 随时重查方案冲突 |
| POST | `/contracts` | 依据方案创建合同 v1，响应提示缺少的权利人同意 |
| POST | `/contracts/:id/versions` | 合同修订（可回溯生效） |
| POST | `/contracts/:id/versions/:n/approvals` | 记录审批链环节 |
| POST | `/credentials` | 签发范围凭证（幂等） |
| POST | `/credentials/:id/revoke` | 撤销凭证（追加判断） |
| POST | `/decisions` | **判断入口**：`{asset_ref, as_of, usage, credential_id 或 licensee_ref}` |
| GET | `/judgments` | 判断记录检索（`asset_ref` / `credential_id` / `kind`） |
| POST | `/material-pickups`、`/sample-drafts` | 素材领取、样稿，与使用同一判断入口 |
| POST | `/usages` | 实际使用（`sale`）与退回（`return`） |
| POST | `/settlements/run` | 生成某合同某期间的结算（幂等） |
| POST | `/settlements/:id/confirm` | 确认结算 |
| POST | `/settlements/:id/corrections` | 对已确认结算追加可追溯更正 |
| GET | `/settlements/:id` | 原始结算 + 更正记录 + 更正后口径 |

## 运行

```bash
npm start          # 默认端口 8080，状态文件 data/state.json（PORT / STORE_PATH 可覆盖）
npm test           # node --test
```

## 示例：法务的日常查询

厂商 C 取得的是 2026 年第一季度、CN、线下展陈授权，却把插画用于长期线上销售：

```bash
curl -X POST localhost:8080/decisions -d '{
  "credential_id": "cred-0001",
  "asset_ref": "illustration:character-a:pose-7",
  "as_of": "2026-09-17",
  "usage": {"media": "online", "territory": "CN", "channel": "e-commerce", "quantity": 1}
}'
```

返回 `decision: "deny"`，`reasons` 列出媒介未授予、渠道未授予、期限未覆盖，`basis` 指明依据的合同与版本，`missing_consents` 列出缺少哪位权利人的同意。即使日后补签或合同回溯生效，这条判断也保持原样，新的结论只会以新的判断追加。
