/**
 * MCP 桥接进程（bridge/dsh-acp-mcp-bridge.mjs）的行为测试。
 *
 * 桥接进程是外部 agent 在 stdio MCP 传输下自己拉起的独立 node 进程——
 * 不经过本仓的 strip-only 加载器，所以测试也按真实用法来：spawn 真进程、
 * 往 stdin 写 JSON-RPC 帧、从 stdout 逐行读应答（stdio 传输的帧格式：
 * 每行恰好一个 JSON 对象）；宿主回调路由用本地 node:http 假服务器扮演。
 * 断言全部对着协议行为与转发行为，不碰桥接进程内部。
 */

import { spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const BRIDGE_PATH = fileURLToPath(new URL('../bridge/dsh-acp-mcp-bridge.mjs', import.meta.url))

const TOKEN = 'test-delegation-token-0123456789abcdef'
const SESSION_ID = 'parent-session-1'
const DELEGATION_RESULT = { output: '子代理的最终文本', model: 'inherited', childId: 'child-1' }

/** stdio 传输里每行一帧；应答按 id 与请求关联 */
interface Frame {
  jsonrpc?: unknown
  id?: unknown
  result?: {
    protocolVersion?: unknown
    capabilities?: { tools?: unknown }
    serverInfo?: { name?: unknown; version?: unknown }
    tools?: Array<{
      name?: string
      inputSchema?: { type?: string; properties?: Record<string, { type?: string }>; required?: string[] }
    }>
    isError?: boolean
    content?: Array<{ type?: string; text?: string }>
  }
  error?: { code?: number; message?: string }
}

interface CapturedRequest {
  method?: string
  url?: string
  headers: Record<string, unknown>
  body: unknown
}

/** 拉起真实桥接进程；记录 stdout 帧、stderr 与退出码，按 id 关联请求应答 */
function startBridge(envOverrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const proc = spawn(process.execPath, [BRIDGE_PATH], { env })

  const frames: Frame[] = []
  const stderrChunks: string[] = []
  const waiters = new Map<unknown, (frame: Frame) => void>()
  let closed = false
  let closeReason = ''

  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (line.trim() === '') return
    const frame: Frame = JSON.parse(line)
    frames.push(frame)
    // 先入列再唤醒等待者：等某帧到达时它一定已经在 frames 里，计数断言无竞态
    waiters.get(frame.id)?.(frame)
    waiters.delete(frame.id)
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))
  // spawn 失败（文件不存在）与进程退出都让等待者立刻失败，而不是干等超时
  proc.on('close', (code) => {
    closed = true
    closeReason = `桥接进程已退出（退出码 ${String(code)}）`
    for (const reject of pendingRejects) reject(new Error(closeReason))
    pendingRejects.length = 0
  })
  const pendingRejects: Array<(error: Error) => void> = []

  function write(frame: Record<string, unknown>): void {
    proc.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  function waitFor(id: unknown): Promise<Frame> {
    const arrived = frames.find((frame) => frame.id === id)
    if (arrived) return Promise.resolve(arrived)
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error(closeReason))
        return
      }
      const timer = setTimeout(() => {
        waiters.delete(id)
        pendingRejects.splice(pendingRejects.indexOf(reject), 1)
        reject(new Error(`等待 id=${String(id)} 的应答超时`))
      }, 4000)
      pendingRejects.push(reject)
      waiters.set(id, (frame) => {
        clearTimeout(timer)
        pendingRejects.splice(pendingRejects.indexOf(reject), 1)
        resolve(frame)
      })
    })
  }

  let nextId = 1
  async function request(method: string, params?: unknown): Promise<Frame> {
    const id = nextId++
    write({ jsonrpc: '2.0', id, method, params })
    return waitFor(id)
  }

  function notify(method: string): void {
    write({ jsonrpc: '2.0', method })
  }

  /** 走一遍真实客户端的握手：initialize 请求 → 等应答 → notifications/initialized 通知 */
  async function connect(): Promise<Frame> {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' },
    })
    notify('notifications/initialized')
    return init
  }

  return {
    proc,
    frames,
    request,
    notify,
    connect,
    write,
    stderrText: () => stderrChunks.join(''),
    exited: new Promise<number | null>((resolve) => proc.once('close', (code) => resolve(code))),
    kill: () => proc.kill(),
  }
}

type Bridge = ReturnType<typeof startBridge>

/** 假宿主：按序捕获每个请求，应答由用例给定 */
async function startHost(
  respond: (req: CapturedRequest, res: ServerResponse) => void,
): Promise<{ url: string; captured: CapturedRequest[]; close: () => Promise<void> }> {
  const captured: CapturedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const item: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw === '' ? null : JSON.parse(raw),
      }
      captured.push(item)
      respond(item, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    // 路径用 Task 6 约定的回调路由路径，钉住「URL 环境变量被原样使用」
    url: `http://127.0.0.1:${port}/acp-agent/delegation`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function replyText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(body)
}

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function bridgeEnv(url: string): Record<string, string> {
  return {
    DSH_DELEGATION_URL: url,
    DSH_DELEGATION_TOKEN: TOKEN,
    DSH_DELEGATION_SESSION: SESSION_ID,
  }
}

function okResult(_req: CapturedRequest, res: ServerResponse): void {
  replyJson(res, 200, DELEGATION_RESULT)
}

const bridges: Bridge[] = []
const hosts: Array<{ close: () => Promise<void> }> = []

function setUp(url?: string): Bridge {
  const bridge = startBridge(bridgeEnv(url ?? 'http://127.0.0.1:9/acp-agent/delegation'))
  bridges.push(bridge)
  return bridge
}

afterEach(async () => {
  for (const bridge of bridges) bridge.kill()
  bridges.length = 0
  for (const host of hosts) await host.close()
  hosts.length = 0
})

describe('MCP 桥接进程（stdio 服务端）', () => {
  it('initialize 应答 2025-06-18 协议版本、tools 能力与本插件名', async () => {
    const bridge = setUp()
    const init = await bridge.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: '测试客户端', version: '0.0.0' },
    })

    expect(init.jsonrpc).toBe('2.0')
    expect(init.error).toBeUndefined()
    // 协议版本必须是日期串 '2025-06-18'，不是数字
    expect(init.result?.protocolVersion).toBe('2025-06-18')
    expect(init.result?.capabilities?.tools).toBeDefined()
    expect(init.result?.serverInfo?.name).toBe('dsh-acp-agent')
    expect(typeof init.result?.serverInfo?.version).toBe('string')
    expect(init.result?.serverInfo?.version).not.toBe('')
  })

  it('notifications/initialized 是通知，不产生任何响应帧', async () => {
    const bridge = setUp()
    await bridge.connect()
    const list = await bridge.request('tools/list', {})

    expect(list.result?.tools).toHaveLength(1)
    // initialize 与 tools/list 两个应答都已入列；若通知被误答了一帧，这里会数出 3 帧。
    // 帧按处理顺序写出，tools/list 的应答到了，通知的假应答必然已在前面临。
    expect(bridge.frames).toHaveLength(2)
  })

  it('initialize 之前到的请求不应答，initialize 本身仍正常应答', async () => {
    const bridge = setUp()
    bridge.write({ jsonrpc: '2.0', id: 900, method: 'tools/list' })
    const init = await bridge.request('initialize', { protocolVersion: '2025-06-18' })

    expect(init.result?.protocolVersion).toBe('2025-06-18')
    expect(bridge.frames).toHaveLength(1)
    expect(bridge.frames.some((frame) => frame.id === 900)).toBe(false)
    // 丢弃不能是静默的：stderr 要留痕，排查「工具怎么不见了」时才有线索
    expect(bridge.stderrText()).toContain('tools/list')
  })

  it('tools/list 恰好暴露一个工具 delegate，task/brief 必填、skill 可选', async () => {
    const bridge = setUp()
    await bridge.connect()

    const list = await bridge.request('tools/list', {})
    const tools = list.result?.tools ?? []
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('delegate')

    const schema = tools[0]?.inputSchema
    expect(schema?.type).toBe('object')
    expect(schema?.required ?? []).toEqual(expect.arrayContaining(['task', 'brief']))
    expect(schema?.properties?.task?.type).toBe('string')
    expect(schema?.properties?.brief?.type).toBe('string')
    expect(schema?.properties?.skill?.type).toBe('string')
    expect(schema?.required ?? []).not.toContain('skill')
  })

  it('tools/call delegate 向宿主回调路由 POST 委派载荷，并回子代理输出', async () => {
    const host = await startHost(okResult)
    hosts.push(host)
    const bridge = setUp(host.url)
    await bridge.connect()

    const call = await bridge.request('tools/call', {
      name: 'delegate',
      arguments: { task: '标签', brief: '给孩子的完整任务书' },
    })

    expect(call.error).toBeUndefined()
    expect(call.result?.isError).toBeUndefined()
    expect(call.result?.content).toEqual([{ type: 'text', text: DELEGATION_RESULT.output }])

    expect(host.captured).toHaveLength(1)
    const forwarded = host.captured[0]!
    expect(forwarded.method).toBe('POST')
    expect(forwarded.url).toBe('/acp-agent/delegation')
    expect(forwarded.headers['content-type']).toBe('application/json')
    // 令牌经请求头带给回调路由（Task 6 约定的鉴权头），不进 URL 也不进载荷
    expect(forwarded.headers['x-dsh-delegation-token']).toBe(TOKEN)
    expect(forwarded.body).toEqual({ sessionId: SESSION_ID, task: '标签', brief: '给孩子的完整任务书' })
  })

  it('skill 有值时进转发体，缺省时不含该键', async () => {
    const host = await startHost(okResult)
    hosts.push(host)
    const bridge = setUp(host.url)
    await bridge.connect()

    await bridge.request('tools/call', {
      name: 'delegate',
      arguments: { skill: 'test-driven-development', task: '标签一', brief: '任务书一' },
    })
    await bridge.request('tools/call', {
      name: 'delegate',
      arguments: { task: '标签二', brief: '任务书二' },
    })

    expect(host.captured.map((req) => req.body)).toEqual([
      { sessionId: SESSION_ID, skill: 'test-driven-development', task: '标签一', brief: '任务书一' },
      { sessionId: SESSION_ID, task: '标签二', brief: '任务书二' },
    ])
  })

  it('宿主回 500 时工具结果为 isError，文本含宿主错误且不泄漏令牌', async () => {
    const host = await startHost((req, res) => {
      // 宿主错误文本里掺令牌，模拟上游漏了：桥接进程是最后一道过滤
      replyText(res, 500, `委派服务抛了错 ${TOKEN}`)
    })
    hosts.push(host)
    const bridge = setUp(host.url)
    await bridge.connect()

    const call = await bridge.request('tools/call', {
      name: 'delegate',
      arguments: { task: '标签', brief: '任务书' },
    })

    expect(call.result?.isError).toBe(true)
    const text = call.result?.content?.[0]?.text ?? ''
    expect(text).toContain('委派服务抛了错')
    expect(text).toContain('500')
    expect(text).not.toContain(TOKEN)
  })

  it('宿主回 2xx 但载荷不是 DelegationResult 时回 isError', async () => {
    const badPayloads = [{ foo: 'bar' }, { output: '有 output', model: '缺 childId' }]
    let served = 0
    const host = await startHost((req, res) => {
      replyJson(res, 200, badPayloads[served++ % badPayloads.length])
    })
    hosts.push(host)
    const bridge = setUp(host.url)
    await bridge.connect()

    for (const _payload of badPayloads) {
      const call = await bridge.request('tools/call', {
        name: 'delegate',
        arguments: { task: '标签', brief: '任务书' },
      })
      expect(call.result?.isError).toBe(true)
      expect(call.result?.content?.[0]?.text).toContain('DelegationResult')
    }
  })

  it('tools/call 点名别的工具时回 isError 并说明只有 delegate', async () => {
    const host = await startHost(okResult)
    hosts.push(host)
    const bridge = setUp(host.url)
    await bridge.connect()

    const call = await bridge.request('tools/call', {
      name: 'Task',
      arguments: { task: '标签', brief: '任务书' },
    })

    expect(call.result?.isError).toBe(true)
    expect(call.result?.content?.[0]?.text).toContain('delegate')
    // 未知工具不该打到宿主
    expect(host.captured).toHaveLength(0)
  })

  it('task 或 brief 缺失/为空时回 isError 并指出字段名，不发起回调', async () => {
    const host = await startHost(okResult)
    hosts.push(host)
    const bridge = setUp(host.url)
    await bridge.connect()

    const cases = [
      { label: '缺 task', args: { brief: '任务书' }, field: 'task' },
      { label: '缺 brief', args: { task: '标签' }, field: 'brief' },
      { label: 'task 是空串', args: { task: '', brief: '任务书' }, field: 'task' },
      { label: 'brief 是空白', args: { task: '标签', brief: '   ' }, field: 'brief' },
      { label: 'skill 不是字符串', args: { task: '标签', brief: '任务书', skill: 3 }, field: 'skill' },
    ]
    for (const testCase of cases) {
      const call = await bridge.request('tools/call', { name: 'delegate', arguments: testCase.args })
      expect(call.result?.isError, testCase.label).toBe(true)
      expect(call.result?.content?.[0]?.text, testCase.label).toContain(testCase.field)
    }
    expect(host.captured).toHaveLength(0)
  })

  it('缺少 DSH_DELEGATION_URL 时启动即失败：stderr 一行、退出码 1', async () => {
    const bridge = startBridge({
      DSH_DELEGATION_URL: undefined,
      DSH_DELEGATION_TOKEN: TOKEN,
      DSH_DELEGATION_SESSION: SESSION_ID,
    })
    bridges.push(bridge)

    const code = await bridge.exited
    expect(code).toBe(1)
    // 点名缺失的环境变量：进程拉不起来时，stderr 是排查「为什么」的唯一线索。
    // 没有这句断言，本用例会在「文件根本不存在」时因错误的原因通过。
    expect(bridge.stderrText()).toContain('DSH_DELEGATION_URL')
  })
})
