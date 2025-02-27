import { createDevServer } from "vite-mini";

createDevServer({
  root: process.cwd(), // 或者指定你的项目根目录
  port: 3000,
});
