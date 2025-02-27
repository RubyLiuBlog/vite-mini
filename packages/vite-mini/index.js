/**
 * 1.一个开发服务器，通过options.port 传入监听某个端口
 * 2.TreeShaking 通过esbuild去做
 * 3.对css，js，image 等静态文件的处理
 * 4.对vue文件的支持，通过vue的compiler-sfc去解析vue的单文件组件
 */
import fs from 'node:fs/promises'
import path, { format } from 'node:path'
import koa from 'koa'
import { parse } from 'es-module-lexer'
import MagicString from 'magic-string'
import { parse as vueParse, compileTemplate } from '@vue/compiler-sfc'

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
        const url = context.request.url === '/' ? '/index.html' : context.request.url;
        if (url.endsWith('.html')) {
            // 读取html文件
            const htmlPath = path.resolve(rootDir, url.slice(1));
            const html = await fs.readFile(htmlPath, 'utf-8');
            context.type = 'text/html';
            context.body = html;
        }
        else if (url.endsWith('.js')) {
            // 处理js文件
            const jsPath = path.resolve(rootDir, url.slice(1));
            const code = await fs.readFile(jsPath, 'utf-8');
            // 1. 解析import语句
            code =  resolveImports (js, path.dirname(jsPath));

            // 2. TreeShaking ( 使用 esbuild)
            const transformed = await esbuild.transform(code, {
                loader: 'js',
                treeShaking: true, // 开启TreeShaking
                format: 'esm', // 输出格式为ES Module
            });
            context.body = transformed.code;
            context.type = 'application/javascript';
        }
    })
    app.listen(port, () => { console.log(`Server listening on port ${port}`)})
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
        if (importPath.startsWith('/')) {
            continue;
        }
        // 2. 相对路径
        const resolvedPath = path.resolve(currentDir, importPath);
        const normalizedPath = '/' + path.relative(process.cwd(), resolvedPath).replace(/\\/g, '/'); // windows 兼容
        magicString.overwrite(start, end, normalizedPath);
    }
    return magicString.toString();
   
}


export { createDevServer }
