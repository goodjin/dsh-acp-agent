/**
 * 外部 agent 委派调用的宿主回调路由。
 *
 * 链路：外部 agent 的 delegate 工具 → bridge/dsh-acp-mcp-bridge.mjs（stdio MCP，
 * agent 自己拉起的独立进程）→ POST 本路由 → 宿主服务 superpowers.delegation
 * （superpowers 侧起 DSH 子代理、阻塞等结果）。
 *
 * 为什么鉴权不走 `ctx.connection.admit`：它检查的是浏览器凭据（cookie，或
 * `/connect?token=` 换来的签名 cookie）。来回调的是本机子进程，两样都没有，
 * `admit` 会一律 401。所以本路由用自己的令牌：请求头 `x-dsh-delegation-token`
 * 与路由行配置 `config.token` 逐字比。令牌只有这一份来源——会话侧把同一个值
 * 放进桥接进程的 env；两处各配各的会让回调永远 401。
 *
 * 另有一份按 `(sessionId, task)` 记的已完成结果缓存：委派可能跑得比 MCP 工具
 * 调用的超时还久（桥接进程 10 分钟就断），agent 超时后再问同一标识时，子代理
 * 多半早已跑完——直接把已完成的结果交回去，不必重跑。缓存挂在本次注册的
 * 闭包里：进程内存、不落盘、随行卸载一起消失。失败的委派不写缓存，否则一次
 * 失败会被缓存成永久失败。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { DELEGATION_SERVICE, isDelegationResult } from './delegation-contract.ts'
import type { DelegationResult } from './delegation-contract.ts'

export const name = 'acp-agent-delegation-route'

/**
 * 只注入 webServer：路由得有个地址可打。委派服务按 `ctx.get` 现取——它缺席是
 * 请求时的 503，不是这一行装不上的理由；connection 更不注入，鉴权与它无关。
 */
export const inject = ['webServer']

/** exact 路由路径；桥接进程的回调 URL 指到这里。 */
export const DELEGATION_ROUTE_PATH = '/acp-agent/delegation'

/** 桥接进程回传令牌的请求头（小写：node 把头名归一成小写）。 */
const TOKEN_HEADER = 'x-dsh-delegation-token'

/** 路由行配置：`token` 是回调令牌的唯一来源（Task 7 从同一行读给桥接进程）。 */
export interface DelegationRouteConfig {
  token?: string
}

/** 桥接进程送来的请求体（DelegationRequest 去掉进程内才有意义的 signal）。 */
export interface DelegationRequestBody {
  sessionId: string
  skill?: string
  task: string
  brief: string
}

/** 委派服务的最小面：宿主面一律按结构读取，缺 `delegate` 就当服务缺席。 */
export interface DelegationServiceLike {
  delegate(request: DelegationRequestBody): Promise<unknown>
}

/** 这个入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface DelegationRouteContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
    }): (() => void) | void
  }
  /** 取宿主服务；缺这一面时委派服务一律视为缺席（503）。 */
  get?(service: string): unknown
}

/**
 * 装载入口：挂上这条 exact 路由。
 *
 * @param ctx - 宿主上下文（effect / webServer / get）。
 * @param config - 路由行配置；`token` 缺失或为空时一切回调都 401（fail closed），
 *   宁可委派不可用，也不让无令牌的回调凭空放行。
 */
export function apply(ctx: DelegationRouteContext, config: DelegationRouteConfig = {}): void {
  // 缓存在本次注册的闭包里：一次注册一份，重复注册不共享旧账（照 zcode 配额路由的写法）。
  const cache = new Map<string, DelegationResult>()
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DELEGATION_ROUTE_PATH,
        async handler(request, response) {
          await handleCallback(request, response, config, cache, ctx)
        },
      }),
    'acp-agent-delegation-route: 委派回调路由',
  )
}

/** 一次回调的完整处理：令牌 → 方法 → body → 缓存 → 委派服务。 */
async function handleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  config: DelegationRouteConfig,
  cache: Map<string, DelegationResult>,
  ctx: DelegationRouteContext,
): Promise<void> {
  // 令牌先行：配置里没有可用令牌时（没配或空串）没有任何值能对上，天然 fail closed。
  const expected = typeof config.token === 'string' && config.token !== '' ? config.token : undefined
  const presented = headerOf(request, TOKEN_HEADER)
  if (expected === undefined || presented !== expected) {
    respondText(response, 401, 'unauthorized')
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
    response.end('method not allowed')
    return
  }
  const parsed = parseDelegationRequest(await readBody(request))
  if (!parsed.ok) {
    respondText(response, 400, `invalid delegation request: ${parsed.reason}`)
    return
  }
  // 缓存命中优先于服务在场与否：结果已经完成，不需要服务再参与。
  const key = cacheKeyOf(parsed.value)
  const cached = cache.get(key)
  if (cached !== undefined) {
    respondJson(response, 200, JSON.stringify(cached))
    return
  }
  const service = delegationServiceOf(ctx)
  if (service === undefined) {
    respondText(response, 503, `委派服务不可用：${DELEGATION_SERVICE} 未发布或不可调用`)
    return
  }
  let outcome: unknown
  try {
    outcome = await service.delegate(parsed.value)
  } catch (error) {
    // 错误文本原样回到桥接进程（它再转给 agent）；委派服务的错可能带上下文，
    // 令牌绝不能跟着出去——到这一层的令牌必然非空，可以放心按它做替换。
    respondText(response, 500, redactToken(`委派服务出错：${messageOf(error)}`, expected))
    return
  }
  // 跨插件来的载荷只认形状：不认识的结果不当成功回（桥接进程也会拒），更不进缓存。
  const result = asDelegationResult(outcome)
  if (result === undefined) {
    respondText(response, 500, redactToken('委派服务出错：返回的载荷不是 DelegationResult', expected))
    return
  }
  cache.set(key, result)
  respondJson(response, 200, JSON.stringify(result))
}

/**
 * 把委派服务的应答收窄成 DelegationResult：契约的 `isDelegationResult` 只回
 * 布尔（两边契约逐字同形，不便改成类型谓词），判定与收窄在这一个函数里对齐。
 */
function asDelegationResult(value: unknown): DelegationResult | undefined {
  return isDelegationResult(value) ? (value as DelegationResult) : undefined
}

/** 读单个请求头的第一个值（node 的头值可能是数组）。 */
function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

/** 累积请求体到读完，按 UTF-8 解码。 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析结果：要么是一份可转交的 DelegationRequest，要么是一句能点名的拒因。 */
type ParsedRequest = { ok: true; value: DelegationRequestBody } | { ok: false; reason: string }

/** 解析并校验请求体：跨进程边界来的 JSON 只能信结构。 */
function parseDelegationRequest(raw: string): ParsedRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: '正文不是 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '正文不是 JSON 对象' }
  }
  const record = parsed as Record<string, unknown>
  for (const field of ['sessionId', 'task', 'brief'] as const) {
    const value = record[field]
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, reason: `${field} 缺失或不是非空字符串` }
    }
  }
  const skill = record.skill
  if (skill !== undefined && (typeof skill !== 'string' || (skill as string).trim() === '')) {
    return { ok: false, reason: 'skill 若提供须为非空字符串' }
  }
  // 只转交认识的四个字段：多出来的键不透传给委派服务。
  return {
    ok: true,
    value: {
      sessionId: record.sessionId as string,
      task: record.task as string,
      brief: record.brief as string,
      ...(skill === undefined ? {} : { skill }),
    },
  }
}

/** 缓存键：`(sessionId, task)` 序列化成数组——分隔符不可撞，两个维度都参与。 */
function cacheKeyOf(request: DelegationRequestBody): string {
  return JSON.stringify([request.sessionId, request.task])
}

/** 按结构读委派服务：取不到、不是对象、没有可调用的 `delegate`，都算缺席。 */
function delegationServiceOf(ctx: DelegationRouteContext): DelegationServiceLike | undefined {
  const found = ctx.get?.(DELEGATION_SERVICE)
  if (found === undefined || found === null || typeof found !== 'object') return undefined
  return typeof (found as { delegate?: unknown }).delegate === 'function'
    ? (found as DelegationServiceLike)
    : undefined
}

/** 错误的人话形式（不要栈：这文本要原样回到 agent 那侧）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把文本里所有令牌出现处换成占位符（split/join 替换全部出现，与桥接进程同一做法）。 */
function redactToken(text: string, token: string): string {
  return text.split(token).join('[redacted]')
}

/** 纯文本应答：no-store（这一路的缓存归宿主闭包里的 Map，不许任何一环替我们缓存）。 */
function respondText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** JSON 应答：no-store + 固定长度（照 zcode 配额路由的写法）。 */
function respondJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}
