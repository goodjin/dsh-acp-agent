/**
 * 站点那份模型清单——借 Qoder 应用自带的 SDK 拿。
 *
 * 为什么不自己发请求（2026-11-05 实测）：
 * - 清单接口的真实地址是 `{api3}/api/v2/model/list`，**少了 `/algo` 会 404**；
 * - 加上 `/algo` 之后是 **403 `Signature invalid`**——签名由 Qoder 自己的**原生
 *   模块**算（`qodercontext_prepareRequest`），不是 JS 能复刻的；
 * - 应用缓存的清单（`~/.qoder/.models/<uid>/catalog-v7`）是加密的，读不出来。
 *
 * 所以：**让应用自己的 SDK 去算这个签名**。它以 `--sdk` 模式跑起来，用 stdio 说
 * NDJSON 的控制协议；我们把令牌给它，它去把清单拉回来。
 *
 * 拿到清单有两个用处：选择器里能列出真实模型（带倍率与档位），以及**每个模型支持
 * 哪些档位**——档位发错了服务端会拒，而各模型的档位并不相同。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** 清单里的一个模型。 */
export type QoderCatalogModel = {
  readonly id: string
  readonly name: string
  /** 官方倍率（如 `0.8`）。 */
  readonly credits?: string | undefined
  /** 这个模型支持的推理档位。 */
  readonly efforts?: readonly string[] | undefined
  /** 上下文长度（输入 token 上限）。 */
  readonly contextWindow?: number | undefined
  readonly supportsImages?: boolean | undefined
}

/** Qoder 应用里 SDK 的位置（国际版与国内版各一处）。 */
const SDK_CANDIDATES = [
  '/Applications/Qoder.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs',
  '/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs',
]

/** 与 SDK 对应的可执行文件。 */
const BINARY_CANDIDATES = [
  '/Applications/Qoder.app/Contents/MacOS/Qoder',
  '/Applications/Qoder CN.app/Contents/MacOS/Qoder',
]

/** 一次清单请求的选项。 */
export type CatalogFetchOptions = {
  /** 访问令牌。 */
  readonly accessToken: string
  /** 账号 id（站点按它决定给哪份清单）。 */
  readonly uid?: string | undefined
  /** 超时（毫秒）。 */
  readonly timeoutMs?: number | undefined
  /** 换掉「起 SDK 进程」这一步（测试用）。 */
  readonly spawnSdk?: (sdkPath: string, authFile: string) => ChildProcessWithoutNullStreams | undefined
  /** 换一个 SDK 路径（测试用）。 */
  readonly sdkPath?: string | undefined
}

/** 找到本机 Qoder 的 SDK；没装就返回 `undefined`。 */
export function findQoderSdk(): { binary: string; sdk: string } | undefined {
  for (const [index, sdk] of SDK_CANDIDATES.entries()) {
    const binary = BINARY_CANDIDATES[index]
    if (binary !== undefined && existsSync(sdk) && existsSync(binary)) return { binary, sdk }
  }
  return undefined
}

/**
 * 借 SDK 拉一次模型清单。
 *
 * 流程：起 SDK（`--sdk` 模式，stdin/stdout 说 NDJSON）→ `daemon.initialize`
 * （带上令牌）→ `daemon.get_models`（`fetchStrategy: "live"` 强制去远端拉）→
 * 关掉进程。
 * @param options - 令牌、账号与超时。
 * @returns 清单；拉不到（没装 Qoder、超时、协议对不上）时是空数组。
 */
export async function fetchCatalogViaSdk(options: CatalogFetchOptions): Promise<QoderCatalogModel[]> {
  const found = options.sdkPath === undefined ? findQoderSdk() : { binary: BINARY_CANDIDATES[0] ?? '', sdk: options.sdkPath }
  if (found === undefined || found.binary === '') return []
  const timeoutMs = options.timeoutMs ?? 90_000
  const authFile = `/tmp/qoder-sdk-auth-${process.pid}.json`
  writeFileSync(authFile, JSON.stringify({ type: 'accessToken', accessToken: options.accessToken }), { mode: 0o600 })
  const spawnImpl = options.spawnSdk ?? ((sdk: string, file: string) => spawn(found.binary, [sdk, '--sdk'], {
    env: { ...process.env, QODER_SDK_AUTH_PAYLOAD_FILE: file },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams)
  const child = spawnImpl(found.sdk, authFile)
  if (child === undefined) {
    unlinkSync(authFile)
    return []
  }
  try {
    return await askDaemonForModels(child, options.uid ?? '', timeoutMs)
  } catch {
    return []
  } finally {
    try { child.kill() } catch { /* 已经走了 */ }
    try { unlinkSync(authFile) } catch { /* 已经走了 */ }
  }
}

/** 跟 daemon 说两句话，把模型清单要回来。 */
function askDaemonForModels(
  child: ChildProcessWithoutNullStreams,
  uid: string,
  timeoutMs: number,
): Promise<QoderCatalogModel[]> {
  return new Promise((resolve) => {
    let seq = 0
    const pending = new Map<string, (response: Record<string, unknown>) => void>()
    const reader = createInterface({ input: child.stdout })
    const finish = (models: QoderCatalogModel[]) => {
      reader.close()
      resolve(models)
    }
    reader.on('line', (line) => {
      if (line.trim() === '') return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (message['type'] !== 'control_response') return
      const response = message['response']
      if (typeof response !== 'object' || response === null) return
      const record = response as Record<string, unknown>
      const id = record['request_id']
      if (typeof id !== 'string') return
      const resolver = pending.get(id)
      if (resolver === undefined) return
      pending.delete(id)
      resolver(record)
    })

    const request = (method: string, extra: Record<string, unknown>, timeout: number) => new Promise<Record<string, unknown>>((resolve) => {
      const id = `r${++seq}`
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({
        type: 'control_request',
        request_id: id,
        request: { method, subtype: method, type: method, requestId: id, ...extra },
      })}\n`)
      setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        resolve({ subtype: 'error', error: '超时' })
      }, timeout)
    })

    void (async () => {
      // 令牌不写进协议：daemon 自己从 QODER_SDK_AUTH_PAYLOAD_FILE 读那份文件。
      const initialized = await request('daemon.initialize', {
        daemon_protocol_version: 2,
        sdk_version: 'dsh-acp-agent',
        capabilities: ['multi_session_v2'],
      }, timeoutMs)
      if (initialized['subtype'] !== 'success') {
        finish([])
        return
      }
      const models = await request('daemon.get_models', { fetchStrategy: 'live', uid }, timeoutMs)
      const response = models['response']
      const list = typeof response === 'object' && response !== null
        ? (response as Record<string, unknown>)['models']
        : undefined
      finish(Array.isArray(list) ? list.map(toCatalogModel) : [])
    })()
  })
}

/** 把 daemon 给的模型条目折成我们自己的形状。 */
function toCatalogModel(entry: unknown): QoderCatalogModel {
  const record = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
  const id = typeof record['modelId'] === 'string' ? record['modelId'] : ''
  const name = typeof record['displayName'] === 'string' && record['displayName'] !== ''
    ? record['displayName']
    : id
  const factor = record['priceFactor']
  const efforts = record['efforts']
  const context = record['maxInputTokens']
  return {
    id,
    name,
    ...(typeof factor === 'number' ? { credits: String(factor) } : {}),
    ...(Array.isArray(efforts) ? { efforts: efforts.filter((effort): effort is string => typeof effort === 'string') } : {}),
    ...(typeof context === 'number' && context > 0 ? { contextWindow: context } : {}),
    ...(typeof record['isVl'] === 'boolean' ? { supportsImages: record['isVl'] } : {}),
  }
}
