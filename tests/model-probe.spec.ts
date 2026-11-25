/**
 * 通用 ACP 探针：起进程 → initialize → session/new → 读清单 → 回收进程。
 *
 * 覆盖任务验收关心的几件事：
 * - 读得到清单（qoder 的 models.availableModels 与 configOptions 两种形状）；
 * - 读不到时给得出**原因**（没登录、认证失败、空清单、超时、起不来），
 *   并且带上登录命令；
 * - 无论从哪条路出来，进程都被回收。
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpProbeError, loginCommandFor, probeAcpModels } from '../src/model-probe.ts'
import { StdioAcpTransport } from '../src/transport.ts'
import type { AcpTransport } from '../src/transport.ts'

/** 会喂帧的假 transport：记录发出的行，测试手工投递应答。 */
function fakeTransport(): AcpTransport & {
  readonly sent: string[]
  deliver(frame: unknown): void
  die(reason: string): void
  closeCount(): number
  shutdownCount(): number
} {
  const sent: string[] = []
  let handler: (line: string) => void = () => {}
  let death: (reason: string) => void = () => {}
  let closes = 0
  let shutdowns = 0
  const transport = {
    sent,
    send: (line: string) => { sent.push(line) },
    onLine: (next: (line: string) => void) => { handler = next },
    onDeath: (next: (reason: string) => void) => { death = next },
    lastFrameAt: () => 0,
    lastDiagnosticAt: () => 0,
    stderrTail: () => [] as readonly string[],
    close: () => { closes += 1 },
    shutdown: async () => { shutdowns += 1 },
    deliver: (frame: unknown) => { handler(JSON.stringify(frame)) },
    die: (reason: string) => { death(reason) },
    closeCount: () => closes,
    shutdownCount: () => shutdowns,
  }
  return transport as typeof transport & AcpTransport
}

/** 真机 session/new 应答的清单形状。 */
function availableModels(models: readonly { modelId: string; name: string }[]): unknown {
  return { jsonrpc: '2.0', id: 2, result: { sessionId: 'ext-probe-1', models: { availableModels: models } } }
}

/** 探针发问后，等它把请求发出去。 */
function tick(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

describe('probeAcpModels（stdio 探针）', () => {
  it('qoder：读到 agent 自报的 availableModels，结束后进程被回收', async () => {
    const transport = fakeTransport()
    const probe = probeAcpModels({
      agent: 'qoder',
      command: '/Users/good/.local/bin/qoderclicn',
      createTransport: async () => transport,
    })
    await tick()
    expect(transport.sent.some(line => line.includes('"initialize"')), '探针发过 initialize').toBe(true)
    transport.deliver({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'qoderclicn-login' }] } })
    await tick()
    expect(transport.sent.some(line => line.includes('"session/new"')), '探针发过 session/new').toBe(true)
    transport.deliver(availableModels([
      { modelId: 'auto', name: 'Auto (default)' },
      { modelId: 'qmodel_38max', name: 'Qwen3.8-Max' },
    ]))
    const models = await probe
    expect(models.map(model => model.id)).toEqual(['auto', 'qmodel_38max'])
    expect(transport.shutdownCount() + transport.closeCount()).toBeGreaterThan(0)
  })

  it('qoder：走 configOptions 的清单形状也读得到', async () => {
    const transport = fakeTransport()
    const probe = probeAcpModels({
      agent: 'qoder',
      command: 'qoderclicn',
      createTransport: async () => transport,
    })
    await tick()
    transport.deliver({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await tick()
    transport.deliver({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 'ext-probe-2',
        configOptions: [{ id: 'model', category: 'model', options: [{ value: 'fast', name: 'Fast' }] }],
      },
    })
    const models = await probe
    expect(models).toEqual([{ id: 'fast', name: 'Fast' }])
  })

  it('空清单：原因是「清单为空」，不是假成功；进程仍被回收', async () => {
    const transport = fakeTransport()
    const probe = probeAcpModels({
      agent: 'qoder',
      command: 'qoderclicn',
      createTransport: async () => transport,
    })
    await tick()
    transport.deliver({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await tick()
    transport.deliver(availableModels([]))
    await expect(probe).rejects.toMatchObject({ reason: 'empty-list' })
    expect(transport.shutdownCount() + transport.closeCount()).toBeGreaterThan(0)
  })

  it('超时：原因是「超时」，进程仍被回收', async () => {
    const transport = fakeTransport()
    await expect(probeAcpModels({
      agent: 'qoder',
      command: 'qoderclicn',
      timeoutMs: 20,
      createTransport: async () => transport,
    })).rejects.toMatchObject({ reason: 'timeout' })
    expect(transport.shutdownCount() + transport.closeCount()).toBeGreaterThan(0)
  })

  it('没登录：session/new 拒绝后补一次 authenticate，仍拿不到就带登录命令失败', async () => {
    const transport = fakeTransport()
    const probe = probeAcpModels({
      agent: 'qoder',
      command: '/Users/good/.local/bin/qoderclicn',
      createTransport: async () => transport,
    })
    await tick()
    transport.deliver({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'qoderclicn-login' }] } })
    await tick()
    // session/new 拒绝：未登录。
    transport.deliver({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32000, message: 'Authentication required: Authentication is required.' },
    })
    await tick()
    // 探针补了一次 authenticate（methodId 取自 initialize 的 authMethods）。
    const authenticate = transport.sent.find(line => line.includes('"authenticate"'))
    expect(authenticate, '补了一次 authenticate').toBeDefined()
    expect(authenticate).toContain('qoderclicn-login')
    // authenticate 也失败：原因是「没登录」，并带上登录命令。
    transport.deliver({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'Authentication required' } })
    await expect(probe).rejects.toMatchObject({ reason: 'not-logged-in', login: 'qoderclicn login' })
    expect(transport.shutdownCount() + transport.closeCount()).toBeGreaterThan(0)
  })

  it('没登录：补一次 authenticate 后成功，就照常读到清单', async () => {
    const transport = fakeTransport()
    const probe = probeAcpModels({
      agent: 'qoder',
      command: 'qoderclicn',
      createTransport: async () => transport,
    })
    await tick()
    transport.deliver({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'qoderclicn-login' }] } })
    await tick()
    transport.deliver({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required' } })
    await tick()
    transport.deliver({ jsonrpc: '2.0', id: 3, result: {} })
    await tick()
    // 补过 authenticate 之后的重试是新的请求（id 4）。
    transport.deliver({ jsonrpc: '2.0', id: 4, result: { sessionId: 'ext-probe-3', models: { availableModels: [{ modelId: 'fast', name: 'Fast' }] } } })
    const models = await probe
    expect(models.map(model => model.id)).toEqual(['fast'])
  })

  it('起不来：原因是「起不来」', async () => {
    const transport = fakeTransport()
    const probe = probeAcpModels({
      agent: 'qoder',
      command: '/nope/qoderclicn',
      createTransport: async () => transport,
    })
    await tick()
    transport.die('acp agent /nope/qoderclicn could not run: spawn ENOENT')
    await expect(probe).rejects.toMatchObject({ reason: 'spawn-failed' })
  })

  it('起不来（构造传输就抛）：也是「起不来」，不是别的错', async () => {
    await expect(probeAcpModels({
      agent: 'qoder',
      command: 'qoderclicn',
      createTransport: async () => { throw new Error('spawn ENOENT') },
    })).rejects.toMatchObject({ reason: 'spawn-failed' })
  })
})

describe('登录命令', () => {
  it('qoder/cursor：从命令本身推出来（CN 版说 qoderclicn login）', () => {
    expect(loginCommandFor('qoder', '/Users/good/.local/bin/qoderclicn')).toBe('qoderclicn login')
    expect(loginCommandFor('cursor', '/Users/good/.local/bin/cursor-agent')).toBe('cursor-agent login')
  })

  it('不知道登录方式的 agent 不猜：没有登录命令', () => {
    expect(loginCommandFor('grok', '/usr/local/bin/grok')).toBeUndefined()
    expect(loginCommandFor('claude', '/usr/local/bin/claude-agent-acp')).toBeUndefined()
  })
})

describe('AcpProbeError', () => {
  it('带原因码与登录命令，是可判别的错误', () => {
    const error = new AcpProbeError('not-logged-in', 'no login', 'qoderclicn login')
    expect(error).toBeInstanceOf(Error)
    expect(error.reason).toBe('not-logged-in')
    expect(error.login).toBe('qoderclicn login')
  })
})

describe('回收：探针走过的进程树都不留下', () => {
  it('agent 自己起的帮手（cursor 那种 worker server）也跟着走', async () => {
    // 真进程：agent 起一个自己的子进程，把子进程的 pid 写进文件。
    const dir = await mkdtemp(join(tmpdir(), 'acp-probe-'))
    const pidFile = join(dir, 'child.pid')
    const script = join(dir, 'agent.mjs')
    await writeFile(script, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
setTimeout(() => {}, 120000)
`)
    const transport = new StdioAcpTransport({
      command: process.execPath,
      args: [script],
      cwd: dir,
      detached: true,
    })
    // 等 agent 把 pid 写下来。
    let helperPid = 0
    for (let attempt = 0; attempt < 50 && helperPid === 0; attempt += 1) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
      try {
        helperPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
      } catch {
        helperPid = 0
      }
    }
    expect(helperPid, 'agent 起了自己的帮手').toBeGreaterThan(0)
    await transport.shutdown(2000)
    // agent 与它的帮手都得没了（信号走的是整个进程组）。
    expect(alive(helperPid), '帮手还在').toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})

/** 这个 pid 还活着吗（信号 0 只问「还在不在」）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
