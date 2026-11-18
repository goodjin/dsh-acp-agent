#!/usr/bin/env node
/**
 * 构建前先清掉 lib/。
 *
 * tsc 只覆盖同名文件，不删旧文件：源码里删掉的模块（旧路由、旧模型客户端）会留下
 * 上一次的 .js，跟着 tarball 一起发出去——用户装到的是一份含幽灵文件的包。
 * 所以构建固定从空目录开始。
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
rmSync(new URL('../lib', import.meta.url), { recursive: true, force: true })
console.log(`已清空 ${root}lib`)
