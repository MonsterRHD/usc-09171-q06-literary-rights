# 文学作品衍生授权

项目用于维护作品素材的权利来源与对外使用范围。仓库目前提供服务入口和现有权利资料样例，尚无审批、凭证或结算能力。

`contracts/rights-source.json` 中每条记录代表一个权利来源声明。`asset_ref` 是内部稳定标识，`valid_from` 与 `valid_to` 采用闭开区间，`scope` 内缺失的维度不能解释为无限授权。

运行 `npm start` 可启动服务，健康检查为 `GET /health`，基础检查使用 `npm test`。
