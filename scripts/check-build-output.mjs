#!/usr/bin/env node
/**
 * 校验随仓库发布的构建产物与源码一致。
 *
 * 社区安装走 git / npm 两条路：都不跑构建脚本，所以产物必须随仓库一起走。
 * 这个检查在 CI 与本地门禁里把「产物过期」变成红灯，而不是让用户装到一个
 * 与源码不符的版本。
 *
 * 本包的宿主产物在 lib/src/**（浏览器半边打成单文件 lib/client.js；
 * lib/src/client/** 只是打包的中间层，不入库，也不参与比对）。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = join(root, '.build-check')
const publishedRoot = join(root, 'lib/src')
rmSync(temp, { recursive: true, force: true })

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

execFileSync(process.execPath, [join(root, 'node_modules/typescript/lib/tsc.js'), '-p', 'tsconfig.build.json', '--outDir', temp], { cwd: root, stdio: 'inherit' })

// 构建输出落在 <outDir>/src/**（rootDir 是仓库根），入库产物落在 lib/src/**
const ignore = (name) => name.startsWith('client/')
const published = listFiles(publishedRoot).filter(file => !ignore(relative(publishedRoot, file)))
const rebuilt = listFiles(join(temp, 'src')).filter(file => !ignore(relative(join(temp, 'src'), file)))
const problems = []

const rebuiltByName = new Map(rebuilt.map(file => [relative(join(temp, 'src'), file), file]))
const publishedByName = new Map(published.map(file => [relative(publishedRoot, file), file]))

for (const [name, file] of rebuiltByName) {
  const shipped = publishedByName.get(name)
  if (shipped === undefined) { problems.push(`缺失产物：lib/src/${name}`); continue }
  if (hash(shipped) !== hash(file)) problems.push(`产物过期：lib/src/${name}`)
}
for (const name of publishedByName.keys()) {
  if (!rebuiltByName.has(name)) problems.push(`多余产物：lib/src/${name}`)
}

const client = join(root, 'lib/client.js')
if (!existsSync(client)) problems.push('缺失产物：lib/client.js')

rmSync(temp, { recursive: true, force: true })
if (problems.length) {
  console.error('构建产物与源码不一致，请运行 npm run build 后提交产物：')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log(`构建产物一致（lib/src ${published.length} 个文件，lib/client.js 存在）`)
