/**
 * 自报门面：本包的 13 条装载行到底挂上没有。
 *
 * 2026-11-03 现场：一句不可擦除的 TS 写法（构造函数参数属性）让模块 import 直接失败，
 * Loader 那一行拿不到 fiber，宿主半边与浏览器半边一起消失——设置里的「屏蔽提供方与
 * 模型」没了、模型前缀没了、配额胶囊也没了，而能看见的地方一个字都没有。事后我们能
 * 查出来，靠的是「某条配额路由存不存在」这种副作用；纯界面消失是无迹可寻的。
 *
 * 所以这一行只做两件事：
 *   1. boot 之后在一行里说清「挂了几行、缺哪几行、为什么缺」，成功也说一声；
 *   2. 把同一份账目挂到一条只读路由上（`/threadharbor/health`），运维和下一次出事的
 *      我们不必再靠猜，也不必等界面消失才发现。
 *
 * 三个设计约束，都是被上面那场事故逼出来的：
 *   - **本模块不 import 包内任何东西。** 它得在主入口坏掉时还能载入，否则自报门面跟着
 *     一起消失。只用 node 内置类型。
 *   - **装配出清单但没挂上的行仍然在树里。** Loader 的条目先建、再 import；import 失败
 *     只是让 `fiber` 空着。所以「在树里 / 有 fiber」两个事实分开看：没有 fiber 就是没挂
 *     上，模块的原始错误靠重导入一次取回（语法/链接错误重导入返回同一份错误，不重复
 *     干活；这也是宿主自己 audit 起来的做法）。
 *   - **fiber 的三种「不是 active」要分开说**：等依赖服务（pending）、apply 抛错
 *     （failed）、已释放（disposed）。把它们糊成一句「没挂上」，下次又要从头查。
 *
 * 计数口径：`mounted` 只数真正 active 的行；`disabled` 单列（那是人主动关的，不是故障）；
 * `failed` / `pending` / `absent` 都算未挂载。
 */

/** fiber 状态：cordis 的取值，这里只读来分类，不写。 */
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3
const FIBER_DISPOSED = 4

/** 只读路由：给人（和 curl）看这份账目。 */
export const HEALTH_ROUTE_PATH = '/threadharbor/health'

/** 一条装载行的期望：id 与「它在界面上是什么」，缺行时日志里说得出人话。 */
export interface RowExpectation {
  id: string
  what: string
}

/**
 * 本包在 profile 里装配的 13 条行。
 *
 * 这份清单是「应该挂上的样子」，与 cordis.patch.yml 的 insert 段一一对应。硬编码是为了
 * 能发现「装配的清单根本没进树」（absent）——如果从补丁文件反推，清单丢了就一起丢了，
 * 反而查不出来。加行时要同时改这里与 cordis.patch.yml。
 */
export const EXPECTED_ROWS: readonly RowExpectation[] = [
  { id: 'acp-agent-client', what: '浏览器半边登记行（缺它整块界面不进浏览器清单）' },
  { id: 'threadharbor-roster-filter', what: '名册过滤器（设置里的屏蔽提供方与模型）' },
  { id: 'threadharbor-zcode-quota', what: 'GLM 套餐额度接口' },
  { id: 'threadharbor-minimaxi-quota', what: 'MiniMax 套餐额度接口' },
  { id: 'threadharbor-codex-quota', what: 'Codex 额度接口' },
  { id: 'threadharbor-claude-quota', what: 'Claude 额度接口' },
  { id: 'acp-codex', what: 'Codex 预置' },
  { id: 'acp-claude', what: 'Claude 预置' },
  { id: 'acp-grok', what: 'Grok 预置' },
  { id: 'acp-cursor', what: 'Cursor 预置' },
  { id: 'acp-zcode', what: 'ZCode 预置' },
  { id: 'acp-minimax', what: 'MiniMax 预置' },
  { id: 'acp-qoder', what: 'Qoder 预置' },
]

/** 一行的核对结果。 */
export type RowStatus = 'mounted' | 'pending' | 'failed' | 'absent' | 'disabled'

/** 核对后的行：期望 + 树里的实际情况。 */
export interface AuditRow extends RowExpectation {
  status: RowStatus
  /** 树里那一行的模块名（absent 时没有）。 */
  name?: string
  /** 为什么是现在这个状态：模块的原始错误、缺的服务名、或一句话说明。 */
  detail?: string
}

/** Loader 的条目面（窄接口，测试立桩照这个来）。 */
export interface LoaderEntryLike {
  options: { id?: string; name?: string }
  fiber?: {
    state?: number
    inject?: Record<string, unknown>
    ctx?: { get?(service: string): unknown }
    await?(): Promise<unknown>
  } | undefined
  disabled?: boolean
  parent?: { tree?: { import(name: string): Promise<unknown> } } | undefined
}

/** 审计的开关。 */
export interface AuditOptions {
  /** 重导入一次拿失败模块的原始错误（默认开）。关掉就只报「模块没载入」。 */
  captureImportErrors?: boolean
}

/** 把任意错误文本压成一行——这条日志必须是单行的。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 取一条错误的人话形式：只留类型与消息，不要栈。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return oneLine(`${error.name}: ${error.message}`)
  return oneLine(String(error))
}

/** 该行缺哪些注入服务（pending 的判据，照宿主 auditStartupEntries 的写法）。 */
function missingServicesOf(entry: LoaderEntryLike): string[] {
  const fiber = entry.fiber
  if (fiber === undefined) return []
  const declared = Object.keys(fiber.inject ?? {})
  return declared.filter(service => fiber.ctx?.get?.(service) === undefined)
}

/** 重导入一次，取回模块载入失败的原因；拿不到就返回 undefined（条目没有 import 面）。 */
async function importFailure(entry: LoaderEntryLike): Promise<string | undefined> {
  const importModule = entry.parent?.tree?.import
  if (typeof importModule !== 'function') return undefined
  try {
    await importModule.call(entry.parent?.tree, entry.options.name ?? '')
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/** 取一条「有 fiber 但没跑起来」的错误：只有 failed 才等，pending 等了会挂。 */
async function fiberFailure(entry: LoaderEntryLike): Promise<string | undefined> {
  const fiber = entry.fiber
  if (fiber === undefined) return undefined
  if (fiber.state !== FIBER_FAILED || typeof fiber.await !== 'function') return undefined
  try {
    await fiber.await()
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * 核对每一条期望行在 Loader 树里的实际情况。
 *
 * @param entries - Loader 的全部条目（`ctx.loader.entries()`）；别的插件的条目会被忽略。
 * @param options - 是否重导入取原始错误。
 * @returns 与 {@link EXPECTED_ROWS} 同序、同长的核对结果。
 */
export async function auditRows(
  entries: Iterable<LoaderEntryLike>,
  options: AuditOptions = {},
): Promise<AuditRow[]> {
  const captureImportErrors = options.captureImportErrors ?? true
  const byId = new Map<string, LoaderEntryLike>()
  for (const entry of entries) {
    const id = entry.options?.id
    if (typeof id === 'string' && id !== '') byId.set(id, entry)
  }

  const rows: AuditRow[] = []
  for (const expected of EXPECTED_ROWS) {
    const entry = byId.get(expected.id)
    if (entry === undefined) {
      rows.push({
        ...expected,
        status: 'absent',
        detail: '装配的清单里没有这一行（bundle 补丁没进来，或 profile 的 bundles 少了本包）',
      })
      continue
    }
    const name = entry.options.name
    if (entry.disabled === true) {
      rows.push({ ...expected, status: 'disabled', name, detail: '这一行被 disabled 关掉了' })
      continue
    }
    if (entry.fiber === undefined) {
      const importError = captureImportErrors ? await importFailure(entry) : undefined
      rows.push({
        ...expected,
        status: 'failed',
        name,
        detail: importError ?? '模块没有载入（import 失败；没留下原因）',
      })
      continue
    }
    const state = entry.fiber.state
    if (state === FIBER_ACTIVE) {
      rows.push({ ...expected, status: 'mounted', name })
      continue
    }
    if (state === FIBER_FAILED) {
      const error = await fiberFailure(entry)
      rows.push({ ...expected, status: 'failed', name, detail: error ?? 'apply 抛错（没留下原因）' })
      continue
    }
    if (state === FIBER_DISPOSED) {
      rows.push({ ...expected, status: 'failed', name, detail: 'fiber 已释放（disposed）' })
      continue
    }
    if (state === FIBER_PENDING) {
      const missing = missingServicesOf(entry)
      rows.push({
        ...expected,
        status: 'pending',
        name,
        detail: missing.length === 0 ? '在等依赖服务（说不出缺哪个）' : `在等依赖服务：${missing.join('、')}`,
      })
      continue
    }
    rows.push({ ...expected, status: 'failed', name, detail: `fiber 状态 ${String(state)}（不是 active）` })
  }
  return rows
}

/** 一行汇总：挂了几行、缺哪几行、为什么缺。必须是单行。 */
export function summarizeAudit(rows: readonly AuditRow[]): string {
  const total = rows.length
  const mounted = rows.filter(row => row.status === 'mounted').length
  const disabled = rows.filter(row => row.status === 'disabled')
  const problems = rows.filter(row => row.status === 'failed' || row.status === 'pending' || row.status === 'absent')

  const head = `acp-agent health: ${mounted}/${total} 行已挂载`
  const disabledNote = disabled.length === 0 ? '' : `（另有 ${disabled.length} 行被禁用：${disabled.map(row => row.id).join('、')}）`
  if (problems.length === 0) return oneLine(`${head}${disabledNote}`)

  const detail = problems.map(row => `${row.id}（${row.what}）：${reasonOf(row)}`).join('；')
  return oneLine(`${head}${disabledNote}；未挂载 ${problems.length} 行 — ${detail}`)
}

/** 把一条未挂载行的原因说成一句话。 */
function reasonOf(row: AuditRow): string {
  if (row.status === 'pending') return row.detail ?? '在等依赖服务'
  if (row.status === 'absent') return row.detail ?? '树里没有这一行'
  if (row.status === 'disabled') return row.detail ?? '被禁用'
  return row.detail ?? '没有原因'
}

/** 路由与外面看的账目形状。 */
export interface HealthPayload {
  ok: boolean
  mounted: number
  total: number
  disabled: readonly string[]
  rows: readonly AuditRow[]
}

/** 把核对结果折成一份应答（ok 只看有没有未挂载的行，被禁用的不算）。 */
export function healthPayload(rows: readonly AuditRow[]): HealthPayload {
  const mounted = rows.filter(row => row.status === 'mounted').length
  const disabled = rows.filter(row => row.status === 'disabled').map(row => row.id)
  return {
    ok: mounted === rows.length - disabled.length,
    mounted,
    total: rows.length,
    disabled,
    rows,
  }
}

/** 定时跑审计的排法器（默认下一轮宏任务；测试换成立即执行）。 */
export type Schedule = (run: () => void) => unknown

/** installHealth 的可替换面（生产空着，测试换掉时间与出口）。 */
export interface InstallHealthDeps {
  /** 什么时候跑那次 boot 审计；默认下一轮宏任务。 */
  schedule?: Schedule
  /** 撤掉排期的回调（默认按 handle 当 setTimeout 清）。 */
  cancel?: (handle: unknown) => void
  /** 重导入取原始错误；默认开。 */
  captureImportErrors?: boolean
}

/** 最小宿主面：只取用得上的几项，缺了也要能载入（非 web 面没有 webServer）。 */
export interface HealthContext {
  logger?: { warn?(message: string): void } | undefined
  loader?: { entries(): Iterable<LoaderEntryLike>; await?(): Promise<unknown> } | undefined
  get?(service: string): unknown
  inject?(deps: string[], body: (child: unknown) => void): unknown
  effect?(factory: () => unknown, label?: string): unknown
  webServer?: { register(route: { kind: 'exact'; path: string; handler(req: unknown, res: unknown): void | Promise<void> }): (() => void) | void } | undefined
  connection?: { admit(request: unknown): { rejection?: number } | { peer?: unknown } } | undefined
}

/** 插件名：Loader 用它显示装载日志。 */
export const name = 'threadharbor-health'

/** 找 Loader 服务：注入面与 `get` 两条路都试（不同宿主面只给其中之一）。 */
function loaderOf(ctx: HealthContext): HealthContext['loader'] {
  const direct = ctx.loader
  if (direct !== undefined && typeof direct.entries === 'function') return direct
  const viaGet = ctx.get?.('loader')
  if (typeof viaGet === 'object' && viaGet !== null && typeof (viaGet as { entries?: unknown }).entries === 'function') {
    return viaGet as HealthContext['loader']
  }
  return undefined
}

/** 打一行：logger 与 stderr 各一份（和本包其它行的 report 一致）。 */
function reporter(ctx: HealthContext): (message: string) => void {
  return (message: string) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // logger 自己坏了不该带走这一行。
    }
    process.stderr.write(`[threadharbor] ${message}\n`)
  }
}

/**
 * 装载自报门面：排一次 boot 审计，并挂上只读路由。
 *
 * @param ctx - 宿主上下文。
 * @param deps - 可替换的排期与出口，测试用。
 */
export function installHealth(ctx: HealthContext, deps: InstallHealthDeps = {}): void {
  const say = reporter(ctx)
  const schedule = deps.schedule ?? ((run: () => void) => setTimeout(run, 0))
  const cancel = deps.cancel ?? ((handle: unknown) => {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>)
  })

  /** 现算一份账目，不说话（路由每次要新鲜的）。 */
  const collect = async (): Promise<AuditRow[]> => {
    const loader = loaderOf(ctx)
    if (loader === undefined) return []
    try {
      await loader.await?.()
    } catch {
      // Loader 启动报错由宿主自己抛；这里只核对我们这些行。
    }
    return await auditRows(loader.entries(), {
      captureImportErrors: deps.captureImportErrors ?? true,
    })
  }

  /** boot 后那一次：算完必须说一行，成功也说。 */
  const announce = async (): Promise<void> => {
    if (loaderOf(ctx) === undefined) {
      say('acp-agent health: 拿不到 loader 服务，无法核对本包的行（自报门面失效）')
      return
    }
    try {
      say(summarizeAudit(await collect()))
    } catch (error) {
      say(`acp-agent health: 核对失败：${messageOf(error)}`)
    }
  }

  const handle = schedule(() => { void announce() })
  if (ctx.effect !== undefined) ctx.effect(() => () => cancel(handle), 'threadharbor: health audit')
  else if (typeof handle === 'object' && handle !== null) { /* 没有 effect 面时交给进程退出 */ }

  /** 只读路由：GET 返回账目 JSON，准入照官方那套（先 admit，再应答）。 */
  const registerRoute = (child: HealthContext): void => {
    const webServer = child.webServer
    if (webServer === undefined) return
    try {
      webServer.register({
        kind: 'exact',
        path: HEALTH_ROUTE_PATH,
        async handler(request: unknown, response: unknown) {
          const res = response as {
            writeHead(status: number, head?: Record<string, string>): void
            end(body?: string): void
          }
          const admission = child.connection?.admit(request)
          if (admission !== undefined && admission !== null && 'rejection' in admission && typeof admission.rejection === 'number') {
            res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          const method = (request as { method?: string } | null)?.method
          if (method !== undefined && method !== 'GET') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
            res.end('method not allowed')
            return
          }
          let payload: HealthPayload
          try {
            payload = healthPayload(await collect())
          } catch (error) {
            payload = { ok: false, mounted: 0, total: EXPECTED_ROWS.length, disabled: [], rows: [] }
            say(`acp-agent health: 路由核对失败：${messageOf(error)}`)
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        },
      })
    } catch (error) {
      say(`acp-agent health: 路由注册失败：${messageOf(error)}`)
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], child => registerRoute(child as HealthContext))
    return
  }
  if (ctx.webServer !== undefined) registerRoute(ctx)
}

/** DSH 插件的入口：安装自报门面。 */
export function apply(ctx: HealthContext): void {
  installHealth(ctx)
}
