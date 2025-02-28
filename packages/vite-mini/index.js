/**
 * 1.一个开发服务器，通过options.port 传入监听某个端口
 * 2.TreeShaking 通过esbuild去做
 * 3.对css，js，image 等静态文件的处理
 * 4.对vue文件的支持，通过vue的compiler-sfc去解析vue的单文件组件
 */
import fs from "node:fs/promises";
import path from "node:path";
import koa from "koa";
import { parse } from "es-module-lexer";
import MagicString from "magic-string";
import { parse as vueParse, compileTemplate } from "@vue/compiler-sfc";

// 创建Koa应用
const app = new koa();

/**
 * 创建开发服务器
 * @param {object} params
 * @param {string} params.rootDir
 * @param {number} params.port
 */
async function createDevServer(params) {
  const { rootDir = process.cwd(), port = 3000 } = params;
  app.use(async (context, next) => {
    // 判断url
    const url =
      context.request.url === "/" ? "/index.html" : context.request.url;
    //拼接路径
    const filePath = path.join(rootDir, url);
    // 读取文件
    const content = await fs.readFile(filePath, "utf-8");
    if (url.startsWith("./") || url.startsWith("../")) {
      if (url.endsWith(".html")) {
        // 读取html文件
        context.type = "text/html";
        context.body = content;
      } else if (url.endsWith(".js")) {
        // 处理js文件, 解析import语句
        const code = await resolveImports(content, path.dirname(filePath));
        context.body = code;
        context.type = "application/javascript";
      } else if (url.endsWith(".css")) {
        // 处理css文件
        context.body = content;
        context.type = "text/css";
      } else if (url.endsWith(".vue")) {
        // 处理vue文件
        const { descriptor } = vueParse(content);

        let scriptContent = "";
        if (descriptor.script) {
          scriptContent = descriptor.script.content;
        } else if (descriptor.scriptSetup) {
          scriptContent = descriptor.scriptSetup.content;
        }

        let templateContent = "";
        if (descriptor.template) {
          const compiled = compileTemplate({
            source: descriptor.template.content,
            id: filePath,
          });
          templateContent = `export function render(_ctx, _cache, $props, $setup, $data, $options) { ${compiled.code} }`;
        }

        const combinedCode = `
      ${scriptContent}
      ${templateContent}
                        `;
        context.body = combinedCode;
        context.type = "application/javascript";
      } else {
        // 其他文件
        const stats = await fs.stat(filePath);
        if (stats.isFile()) {
          // 直接返回文件内容
          context.type = path.extname(url).slice(1); // 根据扩展名设置 Content-Type
          context.body = fs.createReadStream(filePath); // 使用 stream 提高性能
        } else {
          context.body = "Not Found";
          context.status = 404;
        }
      }
    } else {
      // 例如vue，lodash的引入
    }
  });
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
/**
 * 解析 import 路径，替换为绝对路径
 * @param {string} code
 * @param {string} currentDir
 * @returns {Promise<string>}
 */
async function resolveImports(code, currentDir) {
  const [imports] = parse(code);
  if (!imports.length) return code;
  // 这里通过MagicString来处理代码，真实项目中可以使用@babel/parser
  const magicString = new MagicString(code);
  for (let i = 0; i < imports.length; i++) {
    const { s: start, e: end, d: dynamicIndex } = imports[i];
    // 动态导入的跳过
    if (dynamicIndex > -1) continue;
    const importPath = code.substring(start, end);
    // 1. 绝对路径 跳过
    if (importPath.startsWith("/")) {
      continue;
    }
    // 2. 相对路径
    const resolvedPath = path.resolve(currentDir, importPath);
    const normalizedPath =
      "/" + path.relative(process.cwd(), resolvedPath).replace(/\\/g, "/"); // windows 兼容
    magicString.overwrite(start, end, normalizedPath);
  }
  return magicString.toString();
}

export { createDevServer };
