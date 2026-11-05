/**
 * Qoder 国际版的凭据存放。
 *
 * 单独一份，**不读也不写 Qoder 桌面版自己的凭据**——它在应用自己的加密存储里，
 * 插件不该去碰；我们走自己的设备码登录，令牌只留在宿主进程与这份文件里。
 *
 * 目录 `~/.dsh/qoder-global/`（`DSH_HOME` 可改）：文件 0600、目录 0700。
 * **目录已存在时也要收紧**——`mkdir` 的 mode 只在新建时生效，这是真实踩到的坑。
 *
 * 续期要跨进程串行：两个进程同时发现令牌快到期时，只有一个该去续，另一个
 * 直接用换过的新令牌。
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { refreshCredential } from './auth.ts'
import type { QoderAccount, QoderCredential } from './auth.ts'

/** 令牌快到期的这一刻之前就换（留一分钟余量）。 */
const EXPIRY_MARGIN_MS = 60_000

/** 凭据文件的位置。 */
export function credentialFilePath(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qoder-global', 'credentials.json')
}

/**
 * 读凭据。
 * @param file - 文件位置；缺省是默认那一份。
 * @returns 凭据；没有、坏了或缺关键字段时是 `undefined`（当作没登录）。
 */
export async function readCredential(file: string = credentialFilePath()): Promise<QoderCredential | undefined> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // 读不到（权限、目录不在）不是「没登录」，要让人看见。
    throw new Error('Qoder 凭据无法读取，请检查权限')
  }
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    // 文件坏了：当作没登录，让人重新登录一次。
    return undefined
  }
  const data = record(value)
  const accessToken = data['accessToken']
  const machineId = data['machineId']
  if (typeof accessToken !== 'string' || accessToken === '') return undefined
  if (typeof machineId !== 'string' || machineId === '') return undefined
  const refreshToken = data['refreshToken']
  const expiresAt = data['expiresAt']
  const account = record(data['account'])
  const uid = account['uid']
  const nickname = account['nickname']
  return {
    accessToken,
    machineId,
    ...(typeof refreshToken === 'string' && refreshToken !== '' ? { refreshToken } : {}),
    ...(typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    ...(typeof uid === 'string' && uid !== '' ? {
      account: { uid, ...(typeof nickname === 'string' && nickname !== '' ? { nickname } : {}) },
    } : {}),
  }
}

/**
 * 把账号信息补进存着的凭据。
 *
 * 登录之后令牌里未必有昵称；补一次，界面上就能显示「金山」而不是一串 uid。
 * @param account - 账号信息。
 * @param file - 凭据文件；缺省用默认位置。
 * @returns 补好之后的凭据；没有存过凭据时是 `undefined`。
 */
export async function attachAccount(
  account: QoderAccount,
  file: string = credentialFilePath(),
): Promise<QoderCredential | undefined> {
  const stored = await readCredential(file)
  if (stored === undefined) return undefined
  const credential: QoderCredential = { ...stored, account }
  await writeCredential(credential, file)
  return credential
}

/** 目录建好并收紧到 0700（已存在也要收紧）。 */
async function prepare(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await chmod(dirname(file), 0o700)
}

/** 原子写（临时文件 + rename），临时文件用 0600。 */
async function writeUnlocked(credential: QoderCredential, file: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(credential), { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
}

/** 拿文件锁再做事。 */
async function locked<T>(file: string, action: () => Promise<T>): Promise<T> {
  await prepare(file)
  const release = await lockfile.lock(file, {
    realpath: false,
    retries: { retries: 60, minTimeout: 100, maxTimeout: 500 },
    stale: 60_000,
  })
  try {
    return await action()
  } finally {
    await release()
  }
}

/**
 * 写凭据。
 * @param credential - 凭据。
 * @param file - 文件位置；缺省是默认那一份。
 */
export async function writeCredential(credential: QoderCredential, file: string = credentialFilePath()): Promise<void> {
  await locked(file, () => writeUnlocked(credential, file))
}

/**
 * 取一份能用的凭据：必要时续期。
 *
 * 续期在锁里做，所以两个进程同时要续期时只有一个真的去续；另一个看到文件里
 * 已经是新令牌就直接用。
 *
 * @param options - 文件位置、被上游拒绝的旧令牌、fetch 实现。
 * @returns 能用的凭据。
 */
export async function resolveCredential(options: {
  readonly file?: string | undefined
  readonly rejectedToken?: string | undefined
  readonly fetchImpl?: typeof fetch | undefined
} = {}): Promise<QoderCredential> {
  const file = options.file ?? credentialFilePath()
  return locked(file, async () => {
    const stored = await readCredential(file)
    if (!stored) throw new Error('Qoder 国际版未登录：请在设置 → Qoder 国际版账号中登录')
    const rejected = options.rejectedToken !== undefined && options.rejectedToken === stored.accessToken
    const expired = stored.expiresAt !== undefined && stored.expiresAt <= Date.now() + EXPIRY_MARGIN_MS
    if (!rejected && !expired) return stored
    const next = await refreshCredential(stored, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) })
    await writeUnlocked(next, file)
    return next
  })
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
