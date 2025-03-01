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
import { build } from "esbuild";

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
  const nodeModulesDir = path.join(rootDir, "node_modules");
  // 缓存预构建的依赖
  const depCache = new Map();

  app.use(async (context, next) => {
    // 判断url
    const url =
      context.request.url === "/" ? "/index.html" : context.request.url;

    if (url.indexOf("@modules") > -1) {
      const id = url.slice(10); // 去掉 /@modules/ 前缀
      try {
        const modulePath = await resolveBareModule(id);
        const content = await optimizeDep(id, modulePath);

        context.type = "application/javascript";
        context.body = content;
      } catch (e) {
        context.status = 404;
        context.body = `Module not found: ${id}`;
      }
      return;
    }

    if (url.endsWith(".html")) {
      // 读取html文件
      const filePath = path.join(rootDir, url);
      const content = await fs.readFile(filePath, "utf-8");
      context.type = "text/html";
      context.body = content;
    } else if (url.endsWith(".js")) {
      try {
        const filepath = path.join(rootDir, url);
        let code = await fs.readFile(filepath, "utf-8");
        // 重写导入语句
        code = await rewriteImports(code);
        context.type = "application/javascript";
        context.body = code;
      } catch (e) {
        context.status = 404;
      }
    } else if (url.endsWith(".css")) {
      const filePath = path.join(rootDir, url);
      const content = await fs.readFile(filePath, "utf-8");
      // 处理css文件
      context.body = content;
      context.type = "text/css";
    } else if (url.endsWith(".vue")) {
      const filePath = path.join(rootDir, url);
      const content = await fs.readFile(filePath, "utf-8");
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
      const filePath = path.join(rootDir, "/src/assets/", url);
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
  });

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

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

  // 解析裸模块
  async function resolveBareModule(id) {
    try {
      // 查找package.json中的入口文件
      const pkgPath = path.join(nodeModulesDir, id, "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));

      // 优先使用 ESM 入口
      const entryPoint = pkg.module || pkg.main || "index.js";
      return path.join(nodeModulesDir, id, entryPoint);
    } catch (e) {
      console.error(`Cannot resolve bare module: ${id}`, e);
      throw e;
    }
  }

  // 预构建依赖
  async function optimizeDep(id, filepath) {
    if (depCache.has(id)) {
      return depCache.get(id);
    }

    console.log(`Optimizing dependency: ${id}`);

    try {
      // 使用esbuild转换为浏览器兼容的ESM
      const result = await build({
        entryPoints: [filepath],
        bundle: true,
        write: false,
        format: "esm",
        target: ["es2020"],
      });

      const optimized = result.outputFiles[0].text;
      depCache.set(id, optimized);
      return optimized;
    } catch (e) {
      console.error(`Failed to optimize: ${id}`, e);
      throw e;
    }
  }

  // 重写导入语句中的裸模块
  async function rewriteImports(code) {
    const [imports] = parse(code);
    let rewrittenCode = code;

    // 从后向前替换，避免位置偏移
    for (let i = imports.length - 1; i >= 0; i--) {
      const { s: start, e: end, n: name } = imports[i];

      // 只处理裸模块
      if (name && !name.startsWith("/") && !name.startsWith(".")) {
        // 将裸模块路径改写为 /@modules/ 开头的路径
        const rewritten = `/@modules/${name}`;
        rewrittenCode =
          rewrittenCode.slice(0, start) + rewritten + rewrittenCode.slice(end);
      }
    }

    return rewrittenCode;
  }
}

export { createDevServer };
