/**
 * 设置段「选择可用模型」勾选的宿主侧入口。
 *
 * 一条 exact 路由，GET/POST 同一路径：
 * - GET  → 列出 6 个内置 preset 各自的 RAW 模型清单 + 用户勾了哪些；
 * - POST → 保存某个 preset 的勾选（落盘 `${DSH_HOME}/acp-<preset>/selection.json`）。
 *
 * 浏览器侧（acp-selection-section.ts）读 RAW 全量画勾选框、POST 落盘，然后让
 * 输入框模型选择器重发模型目录——它的目录此刻已是宿主按勾选过滤后的结果。
 *
 * 与 model-refresh 路由一样：所有应答都是 HTTP 200 + JSON。浏览器把 `ok:false`
 * 折成一行本地化失败提示，500 不会比这个信封多告诉它任何东西。准入走
 * `connection.admit`，与 quota / refresh 路由同款（401 unauthorized，否则
 * forbidden）。
 *
 * 一个不在本插件负责的 preset（别的插件挂的 provider）回结构化的 `not-ours`：
 * 设置段目录里只有本插件的 6 行会画勾选框，但路由仍按名字防御性地答一句，
 * 不把内部查找错误透给用户。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { clearSelection, currentSelection, writeSelection } from './selection.ts'
import { ACP_SELECTION_SCOPES, isAcpSelectionScope } from './selection.ts'
import { modelsOfPreset } from './catalog-registration.ts'
import type { PresetConfig } from './registry.ts'

/** 一份 RAW 模型清单的最小形状（设置段据此画勾选框）。 */
type ModelLike = { readonly id: string; readonly name: string }

export const name = 'acp-agent-selection'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** exact 路由路径；浏览器侧的勾选段按这个常量取数。 */
export const SELECTION_ROUTE_PATH = '/acp-agent/selection'

/** 这个入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface SelectionContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
    }): (() => void) | void
  }
  connection: {
    admit(request: IncomingMessage): { rejection: number } | { peer: unknown }
  }
}

/** 注册时可选的注入面（测试用）；生产空着。 */
export interface SelectionRouteDeps {
  /** 换一份 preset 配置读取器（测试注入假件；缺省走模块登记表）。 */
  readonly configOf?: () => PresetConfig | undefined
  /** 换一个「读某 preset 的 RAW 模型清单」函数（测试注入；缺省走 modelsOfPreset）。 */
  readonly modelsOf?: (presetId: string) => readonly ModelLike[]
  /** 换一个 scope 白名单查询表（测试注入；缺省走 selection.ts 的内存快照）。 */
  readonly selectionOf?: (scope: string) => readonly string[] | undefined
  /** 换一个落盘口（测试注入；缺省走 selection.ts 的 write/clear）。 */
  readonly persist?: {
    write(scope: string, ids: readonly string[]): Promise<void>
    clear(scope: string): Promise<void>
  }
}

/** 一个 preset 的勾选段视图：RAW 清单 + 用户勾了哪些。 */
export interface PresetSelectionView {
  /** preset id（`acp-codex`…），也是 scope 去掉 `acp-` 前缀外的全名。 */
  readonly preset: string
  /** 落盘 scope（`acp-codex`…）。 */
  readonly scope: string
  /** 提供方在模型选择器里的显示名。 */
  readonly name: string
  /** 该 preset 的 RAW 模型全量（设置段据此画勾选框，不受白名单过滤）。 */
  readonly models: readonly { id: string; name: string }[]
  /** 用户勾了的模型 id；`undefined` = 没勾过（默认全在）。 */
  readonly selected: readonly string[] | undefined
  /** 是否用户自己改过（`selected !== undefined`）。 */
  readonly custom: boolean
}

/** GET 应答。 */
export interface SelectionListReply {
  readonly ok: true
  readonly presets: readonly PresetSelectionView[]
}

/** POST 应答。`selected` 在场 = 保存成这份子集；缺省 = 回到默认那一份（全在）。 */
export interface SelectionSaveReply {
  readonly ok: true
  readonly scope: string
  readonly selected?: readonly string[]
}

/** POST 失败应答（结构化的 not-ours，浏览器按它指路）。 */
export interface SelectionNotOursReply {
  readonly ok: false
  readonly code: 'not-ours'
  readonly error: string
}

type Reply = SelectionListReply | SelectionSaveReply | SelectionNotOursReply | { ok: false; error: string }

/**
 * 装载入口：挂上这条 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；测试换假件。
 */
export function apply(ctx: SelectionContext, deps: SelectionRouteDeps = {}): void {
  registerSelectionRoute(ctx, deps)
}

/**
 * 注册勾选读写路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；测试换假件。
 */
export function registerSelectionRoute(ctx: SelectionContext, deps: SelectionRouteDeps = {}): void {
  const configOf = deps.configOf ?? (() => undefined)
  const modelsOf = deps.modelsOf ?? ((presetId: string) => {
    const config = configOf()
    return config === undefined ? [] : modelsOfPreset(config, { dialectFor: () => undefined }, presetId)
  })
  const selectionOf = deps.selectionOf ?? currentSelection
  const persist = deps.persist ?? { write: writeSelection, clear: clearSelection }
  const list = (): SelectionListReply => {
    const config = configOf()
    const presets: PresetSelectionView[] = []
    for (const scope of ACP_SELECTION_SCOPES) {
      const preset = scope
      const raw = config?.presets[preset]
      const models = (modelsOf(preset) ?? []).map(model => ({
        id: model.id,
        name: model.name,
      }))
      presets.push({
        preset,
        scope,
        name: presetDisplayName(preset, raw?.agent),
        models,
        selected: selectionOf(scope),
        custom: selectionOf(scope) !== undefined,
      })
    }
    return { ok: true, presets }
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SELECTION_ROUTE_PATH,
        async handler(req, res) {
          // 拒绝分支照抄官方 /api 的写法：状态码原样，短体固定。
          const admission = ctx.connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          try {
            if (req.method === 'GET') {
              respondJson(res, list())
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' })
              res.end('method not allowed')
              return
            }
            const body = await readBody(req)
            const preset = typeof body['preset'] === 'string' ? body['preset'].trim() : ''
            if (!isAcpSelectionScope(preset)) {
              // 不是本插件负责的 preset：结构化的 not-ours，别越界代管。
              respondJson(res, notOurs(preset))
              return
            }
            // 回到默认那一份（全在）= 删掉落盘文件。两条路都触发它，和 UI
            // 对齐：无 ids 字段（restore-default），或 ids 是空数组（用户把
            // 最后一个模型也取消勾选，UI 本就发 undefined，但路由层也防御性
            // 把空数组当「清空」——applySelection([]) 与 applySelection(undefined)
            // 行为虽一致，落盘语义却不同：写 [] 是「用户勾了零个」的留痕，
            // 删文件是「从没勾过」的默认态，后者才是诚实的「回到默认」）。
            const ids = body['ids']
            const clean = ids === undefined
              ? []
              : (Array.isArray(ids)
                  ? ids.filter((id): id is string => typeof id === 'string' && id !== '')
                  : [])
            if (clean.length === 0) {
              await persist.clear(preset)
              respondJson(res, { ok: true, scope: preset })
            } else {
              await persist.write(preset, clean)
              respondJson(res, { ok: true, scope: preset, selected: clean })
            }
          } catch (error) {
            respondJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'acp-agent-selection: selection route',
  )
}

/**
 * 一个 preset 在设置段里的显示名。
 *
 * 内置 preset 的友好名（Codex/Claude/…）：配置对象（AcpPresetConfig）不带
 * `name`，所以按 agent id 给一份固定标签，未知 agent 退回 preset id 本身。
 * @param preset - preset id（`acp-codex`…）。
 * @param agent - 该 preset 的 agent id。
 * @returns 显示名。
 */
function presetDisplayName(preset: string, agent: string | undefined): string {
  const labels: Readonly<Record<string, string>> = {
    codex: 'Codex',
    claude: 'Claude',
    grok: 'Grok',
    cursor: 'Cursor',
    zcode: 'ZCode',
    minimaxi: 'MiniMax',
  }
  const byAgent = agent === undefined ? undefined : labels[agent]
  return byAgent ?? preset.replace(/^acp-/, '')
}

/**
 * 别的插件挂载的 provider：回结构化的 not-ours。
 *
 * 内置 preset id 是 `acp-` 前缀；别的插件（codex 全局行等）用别的名字。按
 * scope 归属认领，命中本插件的 6 个之一之外一律指路到对应插件的设置段。
 * @param preset - 设置段目录里那一行的 preset id。
 */
export function notOurs(preset: string): SelectionNotOursReply {
  return {
    ok: false,
    code: 'not-ours',
    error: `${preset} is not mounted by this plugin — manage its model selection from its own settings section`,
  }
}

/** 读请求体；超过 64 KiB 当作没有（本路由只收一个 preset 字符串 + ids 数组）。 */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) return {}
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** JSON 应答：no-store（结果归浏览器即时展示，不许任何一环替我们缓存）。 */
function respondJson(res: ServerResponse, payload: Reply | { ok: false; error: string }): void {
  const body = JSON.stringify(payload)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
