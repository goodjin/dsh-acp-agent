/**
 * DSH 委派桥接进程：一个最小的 stdio MCP 服务端。
 *
 * 为什么是纯 JavaScript ESM 而不是本仓的 TypeScript：这个进程由外部 agent
 * （codex / claude / cursor / qoder / grok）在 stdio MCP 传输下自己拉起，
 * 跑在 agent 环境的 node 里，不受 DSH strip-only 加载器管辖——它必须是
 * 任何 node 都能直接运行的普通 JS，没有编译步骤。同理它不 import 本仓
 * 任何模块（src/ 下都是 TS），委派结果的契约形状就在本地校验。
 *
 * 委派链路：外部 agent（stdin/stdout 上的 MCP 客户端）↔ 本进程 ↔
 * 宿主回调路由（HTTP）↔ superpowers 委派服务。
 *
 * 帧格式按 stdio 传输规范：stdout 每行恰好一个 JSON-RPC 对象；日志走 stderr，
 * 绝不污染 stdout（多一个字节都会让客户端的帧解析错位）。
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** MCP 规范 2025-06-18 的版本号是日期串，不是数字 */
const PROTOCOL_VERSION = '2025-06-18'
const SERVER_NAME = 'dsh-acp-agent'
const DELEGATE_TOOL_NAME = 'delegate'
/** 一次委派不该无限挂住：十分钟是给子代理跑完的宽限上限 */
const CALLBACK_TIMEOUT_MS = 600000
/** Task 6 回调路由约定的鉴权头：令牌走头，不进 URL 也不进载荷 */
const TOKEN_HEADER = 'x-dsh-delegation-token'

const callbackUrl = process.env.DSH_DELEGATION_URL
const callbackToken = process.env.DSH_DELEGATION_TOKEN
const sessionId = process.env.DSH_DELEGATION_SESSION

// 宿主回调地址是委派链路的唯一入口：拿不到它，本进程没有任何存在意义。
// 起不来就立刻失败退出（码 1），agent 会当「桥接进程起不来」退回原生委派。
if (typeof callbackUrl !== 'string' || callbackUrl === '') {
  process.stderr.write(
    'dsh-acp-mcp-bridge: 缺少环境变量 DSH_DELEGATION_URL（宿主回调路由的 URL），无法提供委派工具，进程退出\n',
  )
  process.exit(1)
}

function warn(message) {
  process.stderr.write(`dsh-acp-mcp-bridge: ${message}\n`)
}

/**
 * 版本号只用于 serverInfo 元数据。从本包 package.json 读——写死会在发版时
 * 悄悄过期；读不到也不挡服务，退占位值保住 initialize 能应答。
 */
function readServerVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
  } catch {
    // 落到下面的占位路径
  }
  warn('未能从 package.json 读到版本号，serverInfo.version 用占位值 0.0.0')
  return '0.0.0'
}

/** 错误文本会原样回到 agent：令牌与回调 URL 绝不能出现在里面 */
function redact(text) {
  let out = String(text)
  if (typeof callbackToken === 'string' && callbackToken !== '') {
    out = out.split(callbackToken).join('[redacted]')
  }
  return out.split(callbackUrl).join('[redacted]')
}

const delegateToolSpec = {
  name: DELEGATE_TOOL_NAME,
  description: '把任务委派给 DSH 侧的子代理执行，阻塞等到其最终文本后返回',
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: '技能名；缺省走通用子代理' },
      task: { type: 'string', description: '任务的短标签' },
      brief: { type: 'string', description: '给子代理的完整任务书（子代理看不到当前对话）' },
    },
    required: ['task', 'brief'],
  },
}

/**
 * DelegationResult 的就地校验（与本仓 src/delegation-contract.ts 同形，但不
 * import 它——桥接进程不许依赖 TS 源）。跨进程边界来的 JSON 只能信结构。
 */
function isDelegationResult(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.output === 'string' &&
    typeof value.model === 'string' &&
    typeof value.childId === 'string'
  )
}

let initialized = false

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function reply(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result })
}

function replyProtocolError(id, code, message) {
  writeFrame({ jsonrpc: '2.0', id, error: { code, message: redact(message) } })
}

/** 工具级失败用 isError 的工具结果表达（而非 JSON-RPC error）：调用方要能从结果里读到失败原因 */
function replyToolError(id, message) {
  reply(id, { isError: true, content: [{ type: 'text', text: redact(message) }] })
}

/** 网络层失败只报符号性原因（如 ECONNREFUSED），不回显可能含地址的原文 */
function describeNetworkError(error) {
  if (error?.name === 'TimeoutError') return `宿主回调 ${CALLBACK_TIMEOUT_MS / 1000} 秒内没有应答`
  if (error?.name === 'AbortError') return '宿主回调请求被中止'
  return error?.cause?.code ?? error?.message ?? '网络错误'
}

async function handleToolsCall(id, params) {
  if (
    params === null ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    params.name !== DELEGATE_TOOL_NAME
  ) {
    replyToolError(id, `未知工具 ${JSON.stringify(params?.name)}：本服务端只提供 ${DELEGATE_TOOL_NAME} 一个工具`)
    return
  }

  const rawArgs = params.arguments
  const args = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? rawArgs : {}

  for (const field of ['task', 'brief']) {
    const value = args[field]
    if (typeof value !== 'string' || value.trim() === '') {
      replyToolError(id, `参数 ${field} 必填且须为非空字符串`)
      return
    }
  }
  if (args.skill !== undefined && (typeof args.skill !== 'string' || args.skill.trim() === '')) {
    replyToolError(id, '参数 skill 若提供须为非空字符串')
    return
  }
  const skill = typeof args.skill === 'string' ? args.skill : undefined

  const payload = { sessionId, task: args.task, brief: args.brief }
  if (skill !== undefined) payload.skill = skill

  let response
  try {
    response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(typeof callbackToken === 'string' && callbackToken !== '' ? { [TOKEN_HEADER]: callbackToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    })
  } catch (error) {
    replyToolError(id, `委派回调未送达（${describeNetworkError(error)}）`)
    return
  }

  const bodyText = await response.text()
  if (!response.ok) {
    replyToolError(id, `委派失败：宿主回调路由回 HTTP ${response.status}，${bodyText}`)
    return
  }

  let data
  try {
    data = JSON.parse(bodyText)
  } catch {
    replyToolError(id, '委派失败：宿主回调路由回的正文不是 JSON')
    return
  }
  if (!isDelegationResult(data)) {
    replyToolError(id, '委派失败：宿主回调路由回的载荷不是 DelegationResult（应有 output/model/childId 三个字符串字段）')
    return
  }

  reply(id, { content: [{ type: 'text', text: data.output }] })
}

const serverVersion = readServerVersion()

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim()
  if (text === '') return

  let message
  try {
    message = JSON.parse(text)
  } catch (error) {
    warn(`丢弃无法解析的帧：${error?.message ?? error}`)
    return
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    warn('丢弃不是 JSON 对象的帧')
    return
  }
  if (typeof message.method !== 'string' || message.method === '') {
    // 没有 method 的帧只可能是对端响应；本服务端不发请求，收到即无意义
    return
  }
  if (message.id === undefined || message.id === null) {
    // 通知一律不回响应：notifications/initialized 若被应答，客户端会把它当成
    // 自己某个请求的回包，帧序列就此错位
    return
  }

  if (message.method === 'initialize') {
    initialized = true
    reply(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: serverVersion },
    })
    return
  }
  if (!initialized) {
    // 规范要求初始化是第一段交互；提前到的请求不应答，只在 stderr 留痕，
    // 否则「工具怎么不见了」会变成无声无息的谜团
    warn(`初始化完成前丢弃请求：${message.method}`)
    return
  }

  if (message.method === 'tools/list') {
    reply(message.id, { tools: [delegateToolSpec] })
    return
  }
  if (message.method === 'tools/call') {
    handleToolsCall(message.id, message.params).catch((error) => {
      replyToolError(message.id, `桥接进程内部错误：${error?.stack ?? error}`)
    })
    return
  }

  replyProtocolError(message.id, -32601, `未知方法：${message.method}`)
})

process.stdin.on('close', () => {
  // stdio 传输的生命周期跟着客户端走：stdin 断了，服务端没有继续存在的意义
  process.exit(0)
})

process.stdout.on('error', (error) => {
  // agent 先走一步时 stdout 会断；安静退出，别抛 EPIPE 堆栈吓人
  if (error?.code === 'EPIPE') process.exit(0)
  throw error
})
