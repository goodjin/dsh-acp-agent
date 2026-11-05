/**
 * 凭据的存放与解析。
 *
 * 令牌有两个去处：宿主进程的内存，和本机一份只属于当前用户的文件。文件 0600、
 * 目录 0700——它是一把能直接当账号用的钥匙，权限松了等于把账号送人。
 *
 * 取凭据这一层要回答的是「现在能不能发请求」：
 * - 没有凭据 → 需要登录（这是结论，不是 401）；
 * - 令牌快过期 → 先续期再发，并把新令牌写回文件；
 * - 刷新令牌也过期 → 回到需要登录。
 *
 * 令牌不出现在任何一条消息里。
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fetchAccount, refreshSession } from './auth.ts'
import type { WorkBuddyAccount, WorkBuddyCredential } from './auth.ts'
import { resolveEndpoints } from './endpoints.ts'
import type { WorkBuddyEndpoints } from './endpoints.ts'

export type { WorkBuddyAccount, WorkBuddyCredential }

/** 令牌剩余有效期不足这么多时就先续期。 */
const MIN_VALIDITY_MS = 60_000

/** 凭据文件相对 DSH 目录的位置。 */
const CREDENTIALS_RELATIVE_PATH = 'workbuddy/credentials.json'

/** 「需要登录」这个结论。 */
export class WorkBuddyAuthRequiredError extends Error {
  constructor(message = 'WorkBuddy 未登录：请先在设置里登录 WorkBuddy') {
    super(message)
    this.name = 'WorkBuddyAuthRequiredError'
  }
}

export type CredentialStoreOptions = {
  /** 凭据文件；缺省是 DSH 目录下的那个。 */
  readonly file?: string | undefined
  readonly endpoints?: WorkBuddyEndpoints | undefined
  readonly fetchImpl?: typeof fetch | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}

/** 凭据文件的位置。 */
export function credentialFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME'] !== undefined && env['DSH_HOME'] !== ''
    ? env['DSH_HOME']
    : join(homedir(), '.dsh')
  return join(home, ...CREDENTIALS_RELATIVE_PATH.split('/'))
}

/**
 * 读出存着的凭据。
 * @param file - 凭据文件；缺省用默认位置。
 * @returns 凭据；没有文件或文件坏了都是 `undefined`。
 */
export async function readStoredCredential(file?: string): Promise<WorkBuddyCredential | undefined> {
  const path = file ?? credentialFilePath()
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const accessToken = typeof record['accessToken'] === 'string' ? record['accessToken'] : ''
    if (accessToken === '') return undefined
    const refreshToken = typeof record['refreshToken'] === 'string' ? record['refreshToken'] : undefined
    const expiresAt = typeof record['expiresAt'] === 'number' ? record['expiresAt'] : undefined
    const account = isRecord(record['account'])
      ? {
        uid: typeof record['account']['uid'] === 'string' ? record['account']['uid'] : '',
        ...(typeof record['account']['nickname'] === 'string' ? { nickname: record['account']['nickname'] } : {}),
        ...(typeof record['account']['enterpriseId'] === 'string' ? { enterpriseId: record['account']['enterpriseId'] } : {}),
      }
      : undefined
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(account === undefined || account.uid === '' ? {} : { account }),
    }
  } catch {
    return undefined
  }
}

/**
 * 把凭据写下来（只属于当前用户）。
 * @param credential - 要存的凭据。
 * @param file - 凭据文件；缺省用默认位置。
 */
export async function writeStoredCredential(credential: WorkBuddyCredential, file?: string): Promise<void> {
  const path = file ?? credentialFilePath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // mkdir 的 mode 也只在目录新建时生效；已存在的目录权限不会变，所以补一次收紧。
  await chmod(dirname(path), 0o700).catch(() => {})
  await writeFile(path, JSON.stringify(credential), { encoding: 'utf8', mode: 0o600 })
  // 同理：writeFile 的 mode 只在文件新建时生效。
  await chmod(path, 0o600).catch(() => {})
}

/**
 * 删掉存着的凭据。
 * @param file - 凭据文件；缺省用默认位置。
 */
export async function clearStoredCredential(file?: string): Promise<void> {
  const path = file ?? credentialFilePath()
  await rm(path, { force: true }).catch(() => {})
}

/**
 * 取一份可用的凭据：没有就续期，续不了就报「需要登录」。
 *
 * 返回的解析函数是给模型请求那一侧用的：它每次发请求前问一次，问到的永远是
 * 「此刻还能用」的令牌。
 * @param options - 文件、端点与 fetch 实现。
 * @returns 解析函数。
 */
export function credentialResolver(options: CredentialStoreOptions = {}): () => Promise<WorkBuddyCredential> {
  const file = options.file ?? credentialFilePath(options.env)
  const endpoints = options.endpoints ?? resolveEndpoints(undefined, options.env)
  const fetchImpl = options.fetchImpl ?? fetch
  return async () => {
    const stored = await readStoredCredential(file)
    if (stored === undefined) throw new WorkBuddyAuthRequiredError()
    const expiresAt = stored.expiresAt
    if (expiresAt === undefined || expiresAt - Date.now() > MIN_VALIDITY_MS) return stored

    const refreshToken = stored.refreshToken
    if (refreshToken === undefined || refreshToken === '') {
      throw new WorkBuddyAuthRequiredError('WorkBuddy 登录已过期：请重新登录')
    }
    let refreshed: WorkBuddyCredential
    try {
      refreshed = await refreshSession({ refreshToken, endpoints, fetchImpl })
    } catch {
      throw new WorkBuddyAuthRequiredError('WorkBuddy 登录已过期：请重新登录')
    }
    const account = refreshed.account ?? stored.account
    const credential: WorkBuddyCredential = {
      accessToken: refreshed.accessToken,
      ...(refreshed.refreshToken === undefined ? {} : { refreshToken: refreshed.refreshToken }),
      ...(refreshed.expiresAt === undefined ? {} : { expiresAt: refreshed.expiresAt }),
      ...(account === undefined ? {} : { account }),
    }
    if (credential.account === undefined) {
      const fetched = await fetchAccount({ accessToken: credential.accessToken, endpoints, fetchImpl }).catch(() => undefined)
      if (fetched !== undefined) {
        await writeStoredCredential({ ...credential, account: fetched }, file).catch(() => {})
        return { ...credential, account: fetched }
      }
    }
    await writeStoredCredential(credential, file).catch(() => {})
    return credential
  }
}

/**
 * 把账户信息补进存着的凭据。
 *
 * 登录拿到的令牌里没有账户信息（uid、企业 id），而模型请求要带 `X-User-Id`、
 * 界面要显示是谁——所以登录之后补一次，补上就存回去。
 * @param account - 账户信息。
 * @param file - 凭据文件；缺省用默认位置。
 * @returns 补好之后的凭据；没有存过凭据时是 `undefined`。
 */
export async function attachAccount(
  account: WorkBuddyAccount,
  file?: string,
): Promise<WorkBuddyCredential | undefined> {
  const path = file ?? credentialFilePath()
  const stored = await readStoredCredential(path)
  if (stored === undefined) return undefined
  const credential: WorkBuddyCredential = { ...stored, account }
  await writeStoredCredential(credential, path)
  return credential
}

/**
 * 强制续期一次。
 *
 * 令牌被服务端作废（401）时用：不等它自然过期，直接拿刷新令牌换一对新的。成功
 * 就写回文件，失败就返回 `undefined`（调用方据此说「需要重新登录」）。
 * @param options - 文件、端点与 fetch 实现。
 * @returns 新的凭据，或 `undefined`（续不了）。
 */
export async function forceRefreshCredential(
  options: CredentialStoreOptions = {},
): Promise<WorkBuddyCredential | undefined> {
  const file = options.file ?? credentialFilePath(options.env)
  const endpoints = options.endpoints ?? resolveEndpoints(undefined, options.env)
  const fetchImpl = options.fetchImpl ?? fetch
  const stored = await readStoredCredential(file)
  if (stored === undefined) return undefined
  const refreshToken = stored.refreshToken
  if (refreshToken === undefined || refreshToken === '') return undefined
  let refreshed: WorkBuddyCredential
  try {
    refreshed = await refreshSession({ refreshToken, endpoints, fetchImpl })
  } catch {
    return undefined
  }
  const account = refreshed.account ?? stored.account
  const credential: WorkBuddyCredential = {
    accessToken: refreshed.accessToken,
    ...(refreshed.refreshToken === undefined ? {} : { refreshToken: refreshed.refreshToken }),
    ...(refreshed.expiresAt === undefined ? {} : { expiresAt: refreshed.expiresAt }),
    ...(account === undefined ? {} : { account }),
  }
  await writeStoredCredential(credential, file).catch(() => {})
  return credential
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
