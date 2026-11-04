/**
 * 建会话时把委派用的 MCP 服务器挂给外部 agent。
 *
 * 挂载链路分三层，各测各的：
 *   1. runner——`session/new` / `session/resume` / `session/load` 三条建会话路径
 *      都要带上 `mcpServers`（此前写死空数组）；没传就是空数组，agent 看到的
 *      世界与不挂载时一模一样（干净降级，绝不半挂）。
 *   2. factory——挂不挂、挂什么，在这里决定：委派服务在场才挂，条目是
 *      stdio 桥接进程（node + bridge/dsh-acp-mcp-bridge.mjs），env 里带
 *      回调 URL / 宿主会话 id / 令牌。
 *   3. entry 的宿主面读取——令牌从装载行配置里读（与回调路由行同一份），
 *      服务在场按结构探测，origin 从宿主 web 服务器读。
 *
 * 条目形状按 ACP v1 的 stdio 变体（@agentclientprotocol/sdk 1.3.0 的
 * zMcpServerStdio）：`{ name, command, args, env }`——stdio 变体**不带**
 * `type` 字段（联合类型的判别字段只存在于 http/sse/acp 变体上），env 是
 * `[{ name, value }]` 有序数组而不是记录。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cursorDialect, qoderDialect } from '../src/index.ts'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort, StdioMcpServer } from '../src/runner.ts'
import { makeSessionFactory } from '../src/factory.ts'
import type { DelegationMountSurface } from '../src/factory.ts'
import { delegationMountSurface } from '../src/entry.ts'
import { DELEGATION_ROUTE_PATH, name as delegationRouteRowId } from '../src/delegation-route.ts'
import { DELEGATION_SERVICE } from '../src/delegation-contract.ts'
import type { AcpTransport } from '../src/index.ts'
import type { PresetConfig } from '../src/registry.ts'

/** 记录每次请求的假 client（照 runner.spec 的立桩法）。 */
function fakeClient() {
  const calls: { method: string; params: unknown }[] = []
  const client: AcpClientPort & { calls: typeof calls } = {
    calls,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    },
    notify: () => {},
    onFrame: () => {},
  }
  return client
}

const DECISION = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as const
const TURN = (sessionId: string) => ({ sessionId, position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

/** 一条已挂载的服务器条目（内容真假不重要，透传层只看「原样到达」）。 */
const MOUNTED: readonly StdioMcpServer[] = [{
  name: 'dsh-delegation',
  command: '/usr/bin/node',
  args: ['/bridge/dsh-acp-mcp-bridge.mjs'],
  env: [{ name: 'DSH_DELEGATION_URL', value: 'http://127.0.0.1:1/acp-agent/delegation' }],
}]

describe('AcpTurnRunner — 三条建会话路径都带上 mcpServers', () => {
  it('session/new 把传进来的服务器列表原样发给 agent', async () => {
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp', mcpServers: MOUNTED }).run(DECISION, TURN('s1'))

    const opened = client.calls.find(call => call.method === 'session/new')!
    expect((opened.params as { mcpServers: unknown }).mcpServers).toEqual(MOUNTED)
  })

  it('没传服务器时 session/new 仍是空数组（不挂载 = 与今天完全一致）', async () => {
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, TURN('s1'))

    const opened = client.calls.find(call => call.method === 'session/new')!
    expect((opened.params as { mcpServers: unknown }).mcpServers).toEqual([])
  })

  it('session/resume 接回旧会话时同样带上 mcpServers', async () => {
    const client = fakeClient()
    await new AcpTurnRunner(client, {
      cwd: '/tmp',
      dialect: qoderDialect,
      resumeOf: () => 'old-s1',
      mcpServers: MOUNTED,
    }).run(DECISION, TURN('s1'))

    const resumed = client.calls.find(call => call.method === 'session/resume')!
    expect((resumed.params as { mcpServers: unknown }).mcpServers).toEqual(MOUNTED)
  })

  it('session/load 接回旧会话时同样带上 mcpServers', async () => {
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/load') return { configOptions: [] }
      if (method === 'session/new') return { sessionId: 'fresh' }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    await new AcpTurnRunner(client, {
      cwd: '/tmp',
      dialect: cursorDialect,
      dshSessionId: 'dsh-1',
      resumeOf: () => 'old-cursor',
      mcpServers: MOUNTED,
    }).run(DECISION, TURN('dsh-1'))

    const loaded = client.calls.find(call => call.method === 'session/load')!
    expect((loaded.params as { mcpServers: unknown }).mcpServers).toEqual(MOUNTED)
  })
})

/** 记录式传输（照 factory.spec 的立桩法）：记录发出的帧，可按帧应答。 */
function recordingTransport(): AcpTransport & { readonly sent: string[]; receive(frame: string): void } {
  const sent: string[] = []
  let line: (frame: string) => void = () => {}
  return {
    sent,
    send: frame => { sent.push(frame) },
    onLine: handler => { line = handler },
    onDeath: () => {},
    lastFrameAt: () => Date.now(),
    lastDiagnosticAt: () => 0,
    stderrTail: () => [],
    close: () => {},
    receive: frame => { line(frame) },
  } as AcpTransport & { readonly sent: string[]; receive(frame: string): void }
}

/** 让排队的微任务跑完，异步应答路径先结算。 */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

const FACTORY_CONFIG: PresetConfig = {
  presets: { 'acp-claude': { agent: 'claude', command: 'claude-agent-acp', mode: 'default' } },
}

/** 委派宿主面替身：三项都健康，可按用例逐项掰坏。 */
const healthySurface = (over: Partial<DelegationMountSurface> = {}): DelegationMountSurface => ({
  servicePresent: () => true,
  token: () => 'spec-delegation-token-6f2a',
  origin: () => 'http://127.0.0.1:52526',
  ...over,
})

/** 驱动 factory 走完一次建会话，回传发出的请求帧。 */
async function openAndCollect(
  deps: { delegation?: DelegationMountSurface; dshSessionId?: string },
): Promise<{ method?: string; params?: Record<string, unknown> }[]> {
  const transport = recordingTransport()
  const factory = makeSessionFactory(FACTORY_CONFIG, {
    answerPermission: async () => ({ outcome: 'reject' as const }),
    transport: () => transport,
    ...(deps.delegation === undefined ? {} : { delegation: deps.delegation }),
  })
  const session = await factory.open('acp-claude', {
    cwd: '/tmp',
    ...(deps.dshSessionId === undefined ? {} : { dshSessionId: deps.dshSessionId }),
  })
  void session.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
  for (const frame of transport.sent) {
    const request = JSON.parse(frame) as { id?: number; method?: string }
    if (request.id === undefined) continue
    transport.receive(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: request.method === 'session/new' ? { sessionId: 's1' } : {},
    }))
    await flush()
  }
  return transport.sent.map(frame => JSON.parse(frame) as { method?: string; params?: Record<string, unknown> })
}

describe('factory — 委派在场时把桥接进程挂进 mcpServers', () => {
  it('恰好一项：名字、node 可执行、真实存在的桥接文件、三个环境变量', async () => {
    const sent = await openAndCollect({ delegation: healthySurface(), dshSessionId: 'dsh-9' })
    const opened = sent.find(frame => frame.method === 'session/new')!
    const servers = (opened.params!.mcpServers as StdioMcpServer[] | undefined) ?? []
    expect(servers).toHaveLength(1)

    const server = servers[0]!
    expect(server.name).toBe('dsh-delegation')
    // stdio 变体不带 type 字段（ACP v1 联合类型里判别字段只在 http/sse/acp 上）。
    expect('type' in server).toBe(false)
    // command 是宿主自己的 node；桥接是 `node <file>` 形式。
    expect(server.command).toBe(process.execPath)
    expect(existsSync(server.command)).toBe(true)
    expect(server.args).toHaveLength(1)
    expect(server.args[0]!.endsWith('/bridge/dsh-acp-mcp-bridge.mjs')).toBe(true)
    expect(statSync(server.args[0]!).isFile()).toBe(true)
    // env 是有序键值数组：URL 指向回调路由，SESSION 定位父会话，TOKEN 与路由行同一份。
    const env = Object.fromEntries((server.env ?? []).map(entry => [entry.name, entry.value]))
    expect(env).toEqual({
      DSH_DELEGATION_URL: `http://127.0.0.1:52526${DELEGATION_ROUTE_PATH}`,
      DSH_DELEGATION_SESSION: 'dsh-9',
      DSH_DELEGATION_TOKEN: 'spec-delegation-token-6f2a',
    })
  })

  it('委派服务缺席 → 空数组，agent 看到的世界与今天一模一样', async () => {
    const sent = await openAndCollect({ delegation: healthySurface({ servicePresent: () => false }), dshSessionId: 'dsh-9' })
    const opened = sent.find(frame => frame.method === 'session/new')!
    expect(opened.params!.mcpServers).toEqual([])
  })

  it('令牌读不到 → 不挂（不生成临时令牌）并留一行 stderr', async () => {
    const stderr: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const sent = await openAndCollect({ delegation: healthySurface({ token: () => undefined }), dshSessionId: 'dsh-9' })
      const opened = sent.find(frame => frame.method === 'session/new')!
      expect(opened.params!.mcpServers).toEqual([])
    } finally {
      process.stderr.write = original
    }
    expect(stderr.some(line => line.includes('token'))).toBe(true)
  })

  it('origin 拿不到（端口未绑定或无法构成 URL）→ 不挂', async () => {
    const sent = await openAndCollect({ delegation: healthySurface({ origin: () => undefined }), dshSessionId: 'dsh-9' })
    const opened = sent.find(frame => frame.method === 'session/new')!
    expect(opened.params!.mcpServers).toEqual([])
  })

  it('不知道自己是哪个宿主会话 → 不挂（回调无从定位父会话）', async () => {
    const sent = await openAndCollect({ delegation: healthySurface() })
    const opened = sent.find(frame => frame.method === 'session/new')!
    expect(opened.params!.mcpServers).toEqual([])
  })
})

describe('delegationMountSurface — 从宿主面读三样事实', () => {
  /** 最小宿主替身：loader 一行（回调路由行）+ 两个具名服务。 */
  const hostOf = (over: {
    loaderEntries?: object[]
    service?: unknown
    webServer?: unknown
    get?: (key: string) => unknown
  } = {}) => {
    const entries = over.loaderEntries ?? [
      { options: { id: delegationRouteRowId, config: { token: 'row-token' } } },
    ]
    return {
      loader: { entries: () => entries[Symbol.iterator]() },
      get: over.get ?? ((key: string) => {
        if (key === DELEGATION_SERVICE) return over.service
        if (key === 'webServer') return over.webServer
        return undefined
      }),
    }
  }
  const SERVICE = { delegate(request: unknown) { return Promise.resolve(request) } }

  it('令牌来自装载树里回调路由那一行的 config（fiber 优先，行还没挂上时读 options）', () => {
    expect(delegationMountSurface(hostOf()).token()).toBe('row-token')
    // 行还没挂上（fiber 未建）时配置已在 options 上——挂载判定不该因启动时序漏读。
    const pending = hostOf({ loaderEntries: [{ options: { id: delegationRouteRowId, config: { token: 'pending-token' } } }] })
    expect(delegationMountSurface(pending).token()).toBe('pending-token')
    const withFiber = hostOf({
      loaderEntries: [{ options: { id: delegationRouteRowId, config: { token: 'stale' } }, fiber: { config: { token: 'live' } } }],
    })
    expect(delegationMountSurface(withFiber).token()).toBe('live')
  })

  it('行缺席、令牌为空、没有 loader —— 一律读不到令牌（fail closed）', () => {
    expect(delegationMountSurface(hostOf({ loaderEntries: [] })).token()).toBeUndefined()
    expect(delegationMountSurface(hostOf({
      loaderEntries: [{ options: { id: delegationRouteRowId, config: { token: '' } } }],
    })).token()).toBeUndefined()
    expect(delegationMountSurface({ get: () => undefined }).token()).toBeUndefined()
  })

  it('服务在场按结构探测：有可调用的 delegate 才算在场', () => {
    expect(delegationMountSurface(hostOf({ service: SERVICE })).servicePresent()).toBe(true)
    expect(delegationMountSurface(hostOf({ service: {} })).servicePresent()).toBe(false)
    expect(delegationMountSurface(hostOf({ service: undefined })).servicePresent()).toBe(false)
    expect(delegationMountSurface({ loader: { entries: () => [][Symbol.iterator]() } }).servicePresent()).toBe(false)
  })

  it('origin 读宿主 web 服务器的 getOrigin；读不到或抛错都折成 undefined', () => {
    expect(delegationMountSurface(hostOf({ webServer: { getOrigin: () => 'http://127.0.0.1:52526' } })).origin())
      .toBe('http://127.0.0.1:52526')
    expect(delegationMountSurface(hostOf({
      webServer: { getOrigin: () => { throw new Error('origin read before the listener bound a port') } },
    })).origin()).toBeUndefined()
    expect(delegationMountSurface(hostOf({ webServer: {} })).origin()).toBeUndefined()
    expect(delegationMountSurface(hostOf({ webServer: undefined })).origin()).toBeUndefined()
  })

  it('factory 写的三个环境变量名与桥接进程读的逐字一致（跨文件钉子）', async () => {
    // 桥接是 .mjs（外部 agent 的 node 拉起，不能 import 本仓 TS），改名漂移在
    // 两边各自的测试里都能「顺手一起改」而静默通过——只有对照源码才钉得住。
    // 逐字扫描 bridge 的 process.env 读取，与 factory 真实产物里的键集比对。
    const sent = await openAndCollect({ delegation: healthySurface(), dshSessionId: 'dsh-9' })
    const opened = sent.find(frame => frame.method === 'session/new')!
    const server = (opened.params!.mcpServers as StdioMcpServer[])[0]!
    const written = new Set((server.env ?? []).map(entry => entry.name))

    const bridgeSource = readFileSync(
      fileURLToPath(new URL('../bridge/dsh-acp-mcp-bridge.mjs', import.meta.url)),
      'utf8',
    )
    // 两种读取写法都要匹配：直接下标 `process.env.DSH_X`，以及解构
    // `const { DSH_X } = process.env`。只匹配前者的话，桥接改成解构写法时
    // 这个钉子会扫不出任何变量名而静默空转——断言反而「通过」了。
    const read = new Set([
      ...[...bridgeSource.matchAll(/process\.env\.(DSH_DELEGATION_\w+)/g)].map(match => match[1]!),
      ...[...bridgeSource.matchAll(/\b(DSH_DELEGATION_\w+)\s*\}/g)].map(match => match[1]!),
      ...[...bridgeSource.matchAll(/\b(DSH_DELEGATION_\w+)\s*,/g)].map(match => match[1]!),
    ])
    // 键集相等即可：env 是数组，条目顺序对桥接进程无所谓。
    expect([...written].sort()).toEqual([...read].sort())
  })
})
