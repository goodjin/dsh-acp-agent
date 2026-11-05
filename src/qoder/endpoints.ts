/**
 * Qoder 国际版的端点。
 *
 * 核对时间：2026-11-05。来源是本机 `/Applications/Qoder.app`（0.5.3）内置的
 * `@qoder-ai/qoder-agent-sdk` worker（`dist/_worker/qoder-worker-runtime.obf.mjs`）
 * ——它按品牌与环境成套地写着这些地址，国际版 prod 这一组是：
 *
 *   授权页   qoder.com            浏览器里点授权
 *   账号侧   openapi.qoder.sh     设备令牌轮询与续期
 *   账号侧   center.qoder.sh      账号信息
 *   清单侧   api3.qoder.sh        模型清单
 *   推理侧   api2-v2.qoder.sh     模型请求
 *
 * **「同源」在这里不是「同一个域名」**：这几处是同一个 prod 环境的五个域名。
 * 登录签发的令牌与模型请求必须出自同一套环境，所以默认值成组给，逐项覆盖时
 * 也要成组覆盖——覆盖一个模型地址却留着别处的登录地址，就是「登录成功、
 * 每个请求都 401」。
 */

/** 授权页（浏览器打开的那一个）。 */
export const QODER_LOGIN_BASE = 'https://qoder.com'
/** 账号侧：设备令牌轮询与续期。 */
export const QODER_OPENAPI_BASE = 'https://openapi.qoder.sh'
/** 账号侧：账号信息。 */
export const QODER_CENTER_BASE = 'https://center.qoder.sh'
/** 清单侧：模型清单。 */
export const QODER_CATALOG_BASE = 'https://api3.qoder.sh'
/** 推理侧：模型请求。 */
export const QODER_MODEL_BASE = 'https://api2-v2.qoder.sh'

/** 换登录页的环境变量。 */
export const QODER_LOGIN_BASE_ENV = 'QODER_LOGIN_BASE'
/** 换账号侧的环境变量。 */
export const QODER_OPENAPI_BASE_ENV = 'QODER_OPENAPI_BASE'
/** 换账号中心的环境变量。 */
export const QODER_CENTER_BASE_ENV = 'QODER_CENTER_BASE'
/** 换清单侧的环境变量。 */
export const QODER_CATALOG_BASE_ENV = 'QODER_CATALOG_BASE'
/** 换推理侧的环境变量。 */
export const QODER_MODEL_BASE_ENV = 'QODER_MODEL_BASE'

/** 本机 worker 的版本号，进 `Cosy-Version` 头。 */
export const QODER_CLIENT_VERSION = '1.1.79-hotfix.11'

/** 一个环境派生出来的全部地址。 */
export type QoderEndpoints = {
  /** 浏览器授权页的根。 */
  readonly loginBase: string
  /** 账号侧的根（设备令牌）。 */
  readonly openapiBase: string
  /** 账号中心的根。 */
  readonly centerBase: string
  /** 模型清单的根。 */
  readonly catalogBase: string
  /** 模型请求的根。 */
  readonly modelBase: string
  /** 设备令牌轮询：`{openapiBase}/api/v1/deviceToken/poll`。 */
  readonly pollUrl: string
  /** 设备令牌续期：`{openapiBase}/api/v1/deviceToken/refresh`。 */
  readonly refreshUrl: string
  /** 账号信息：`{centerBase}/api/v1/userinfo`。 */
  readonly accountUrl: string
  /** 模型清单：`{catalogBase}/api/v2/model/list?Encode=1`。 */
  readonly modelListUrl: string
  /** 模型请求：`{modelBase}/model/v1/chat/completions`。 */
  readonly chatUrl: string
}

function trimBase(value: string | undefined, fallback: string): string {
  const configured = (value ?? '').trim()
  return (configured === '' ? fallback : configured).replace(/\/+$/u, '')
}

/**
 * 解出全部地址。
 * @param env - 环境变量来源；测试可注入。
 * @returns 全部地址。
 */
export function resolveEndpoints(env: NodeJS.ProcessEnv = process.env): QoderEndpoints {
  const loginBase = trimBase(env[QODER_LOGIN_BASE_ENV], QODER_LOGIN_BASE)
  const openapiBase = trimBase(env[QODER_OPENAPI_BASE_ENV], QODER_OPENAPI_BASE)
  const centerBase = trimBase(env[QODER_CENTER_BASE_ENV], QODER_CENTER_BASE)
  const catalogBase = trimBase(env[QODER_CATALOG_BASE_ENV], QODER_CATALOG_BASE)
  const modelBase = trimBase(env[QODER_MODEL_BASE_ENV], QODER_MODEL_BASE)
  return {
    loginBase,
    openapiBase,
    centerBase,
    catalogBase,
    modelBase,
    pollUrl: `${openapiBase}/api/v1/deviceToken/poll`,
    refreshUrl: `${openapiBase}/api/v1/deviceToken/refresh`,
    accountUrl: `${centerBase}/api/v1/userinfo`,
    modelListUrl: `${catalogBase}/api/v2/model/list?Encode=1`,
    chatUrl: `${modelBase}/model/v1/chat/completions`,
  }
}

/** 默认的那一套（国际版 prod）。 */
export const DEFAULT_QODER_ENDPOINTS: QoderEndpoints = resolveEndpoints({})

/**
 * 客户端身份头。worker 给每个请求都带上这组头。
 * @param version - 客户端版本；缺省是本机 worker 的版本。
 * @returns 身份头。
 */
export function qoderIdentityHeaders(version: string = QODER_CLIENT_VERSION): Record<string, string> {
  return {
    'Cosy-Version': version,
    'Cosy-ClientType': '5',
    'Cosy-MachineOS': `${machineOs()}_${process.platform}`,
  }
}

/** 机器标识：与 worker 同一套写法（arm64 → aarch64）。 */
function machineOs(): string {
  if (process.arch === 'arm64') return 'aarch64'
  if (process.arch === 'x64') return 'x86_64'
  return process.arch
}
