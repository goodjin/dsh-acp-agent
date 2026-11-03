import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const id = '@goodjin2/dsh-acp-agent'
const root = fileURLToPath(new URL('.', import.meta.url))
const cssPrefix = '\0threadharbor-css:'
const cssSuffix = '.mjs'
const externals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-layout/client',
  '@deepseek-ai/dsh-client-ui-primitives',
])

export default defineConfig({
  // tsc -b 先把 src/ 编译到 lib/src/（包根 rootDir），这里从中间层打包浏览器
  // bundle：单文件 CJS，ModuleLoader banner 与 dsh-client 同款。
  entry: { client: `${root}lib/src/client/index.js` },
  outDir: `${root}lib`,
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  minify: true,
  clean: false,
  external: [...externals],
  noExternal: (specifier: string) => !externals.has(specifier),
  plugins: [{
    name: 'threadharbor-css-modules',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      const emitted = new URL(source, `file://${importer}`).pathname
      const file = existsSync(emitted) ? emitted : emitted.replace('/lib/src/', '/src/')
      return `${cssPrefix}${file}${cssSuffix}`
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(cssPrefix)) return null
      const file = virtualId.slice(cssPrefix.length, -cssSuffix.length)
      this.addWatchFile(file)
      // lightningcss 的 [hash] 以文件名为种子：传绝对路径会让类名哈希随构建目录变化
      // （.worktrees/… vs 主仓 → 同一份 CSS 出不同的 hash，产物每次都“变脏”）。
      // 本包的 .module.css 基名唯一，传基名即可让哈希只由内容决定、跨目录可复现。
      const result = transform({
        filename: basename(file),
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // 按键名排序再输出：lightningcss 的 exports 来自 Rust 侧的哈希表，遍历顺序
      // 每个进程都不同（HashMap 的随机种子），不排序的话同一份源码每次构建产物字节
      // 都不一样——入库产物永远“脏”，DSH 还会因为 rev 变化白白热替换一次插件。
      const classes: Record<string, string> = {}
      const exported = Object.entries(result.exports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, value] of exported) classes[local] = value.name
      const css = result.code.toString()
      const tag = `${id}/${basename(file)}`
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tag = ${JSON.stringify(tag)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tag) + ']') === null) {",
        "  const element = document.createElement('style');",
        `  element.dataset.plugin = ${JSON.stringify(id)};`,
        '  element.dataset.pluginCss = tag;',
        '  element.textContent = css;',
        '  document.head.appendChild(element);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    inlineDynamicImports: true,
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    sourcemapPathTransform: (source: string) => isAbsolute(source) ? relative(root, source).replaceAll('\\', '/') : source,
  },
})
