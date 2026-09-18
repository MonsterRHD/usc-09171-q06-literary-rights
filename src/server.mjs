import { createApp } from "./app.mjs";

const port = Number(process.env.PORT ?? 8080);
const storePath = process.env.STORE_PATH ?? "data/state.json";

const app = await createApp({ storePath });
app.listen(port, () => {
  console.log(`literary-rights 服务已启动：端口 ${port}，状态文件 ${storePath}`);
});
