# 文学作品衍生授权决策系统

面向经典文学 IP 衍生合作的**授权判断入口**：法务在任意日期查询一张线上图片，立即得到"当日是否可用、依据哪份合同、缺哪位权利人的同意"。

## 解决什么问题

一次舞台联名把插画、人物名称、译文片段分别发给三家厂商，其中一家拿到的只是**境内短期线下展陈权**（媒介 exhibition / 渠道 onsite / 区间 `[2026-03-01, 2026-04-01)`），却把素材用于**长期线上销售**。系统在 2026-09-17 对该图的判断直接给出：

```json
{
  "usable": false,
  "blocking_reasons": ["EXPIRED", "CHANNEL_NOT_LICENSED", "MISSING_CONSENT", "NO_CERTIFICATE"],
  "missing_consents": [
    {"asset_ref": "work:classic-novel", "kind": "work", "holder_refs": ["holder-author-heirs"]},
    {"asset_ref": "character:character-a", "kind": "character", "holder_refs": ["holder-author-heirs"]},
    {"asset_ref": "illustration:character-a:pose-7", "kind": "image", "holder_refs": ["holder-artist-b"]}
  ]
}
```

原因码含义：`EXPIRED`（闭开区间已过终点）、`CHANNEL_NOT_LICENSED`（授权里没有 online-store 这个渠道——**缺失维度不是全渠道开放**）、`MISSING_CONSENT`（作品/角色层完全没有该方的授权）、`NO_CERTIFICATE`（无范围凭证）。

## 核心约定

- **最小权利单元**：每条授权按 媒介 / 地区 / 渠道 / 期限（闭开 `[from, to)`）/ 数量 / 再许可 / 独家 拆分并显式给出；`channels` 缺失或为空 = 未授权任何渠道，`max_quantity` 缺失 ≠ 不限量（必须写 `null` 才是显式不限量）。
- **来源闭包**：图片 → 角色 → 作品，以及嵌入的译本、商标；任一层任一登记权利人缺同意即不可用。
- **再许可链**：`parent_source_id` 指向上游，逐跳校验上游 `sublicense=true`、主体衔接、范围与期限覆盖，根授权方必须是该资产登记权利人。
- **事件溯源**：所有事实只追加到 `data/events.jsonl`，状态由回放得到。撤销 / 到期 / 超量 / 补签晚到 / 合同回溯都**只追加新判断**，以 `supersedes_decision_id` 链取代，当时结论永不改写。
- **唯一范围凭证**：合同版本的审批角色链（默认法务、版权、财务）全部批准同一版本后才能签发；一个合作方案（内容指纹）至多一张有效凭证，并发提交与重启重放都不会产生第二张。
- **跨月结算**：`max((销售额−退货)×税率, 最低保证)`；确认后不可改，补录退货走可追溯更正，差额可为负（追回）。

详见 [DESIGN.md](DESIGN.md)。

## 快速开始

```bash
npm run seed          # 重建并导入事故场景 + 正规路径样例数据
npm start             # 启动服务，默认 0.0.0.0:8080
```

健康检查：`GET /health`

### 判断入口（法务主用）

```
GET /v1/evaluate?url=<图片URL>&date=2026-09-17
  &media=physical-merchandise&territory=CN
  &channel=online-store&party=vendor-stage-co
```

也支持 `ref=<内部资产号>` 替代 `url`。返回 `usable`、逐层 `asset_layers`（含每条再许可链与权利人）、`missing_consents`、`certificate`（凭证号、状态、累计用量、来源有效性核对）、`contract_basis`（合同号/版本号/命中的来源）、`retroactive_basis`。每次查询本身也是只追加事件，历史可查 `GET /v1/decisions`（同参数）。

### 业务全流程端点

| 阶段 | 端点 |
|---|---|
| 资产/来源关系 | `POST /v1/assets` |
| 最小权利单元授权（含再许可链） | `POST /v1/grants` |
| 签约前独家窗口检查（只读） | `POST /v1/proposals/exclusivity-check` |
| 提交合作方案 | `POST /v1/proposals` |
| 建合同 / 加版本 / 审批 | `POST /v1/contracts` · `/v1/contracts/:id/versions` · `POST /v1/approvals` |
| 签发 / 撤销 / 补签材料 | `POST /v1/certificates/issue` · `/v1/certificates/:id/revoke` · `/v1/certificates/:id/supplements` |
| 素材领取 / 样稿 / 实际使用 / 销售 | `/v1/material-pickups` · `/v1/samples` · `/v1/usages` · `/v1/sales` |
| 结算确认 / 可追溯更正 | `/v1/settlements/confirm` · `/v1/settlements/correct` |

写端点接受 `Idempotency-Key` 头；并发重复请求返回已存在结果，不重复落事件。

## 项目结构

```
src/domain/
  dates.mjs        # 闭开区间 [from, to)
  scope.mjs        # 最小权利单元匹配与严格交集
  evaluation.mjs   # 再许可链、来源闭包、独家阻断、凭证核对——判断引擎
  service.mjs      # 命令服务：串行互斥 + 幂等 + 投影唯一索引
  projection.mjs   # 事件回放重建状态
  royalty.mjs      # 跨月版税与更正
src/store/jsonl-store.mjs  # 只追加日志
scripts/seed.mjs   # 事故场景与正规路径演示数据
test/              # 29 项 node:test 用例（含并发、重启、回溯）
```

运行测试：`npm test`。事件日志与种子产物在 `data/`（git 忽略），可随时 `npm run seed` 重建。
