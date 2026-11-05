/** Separate store: never modifies Qoder desktop/CLI credentials. */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { record, refreshCredential } from './auth.ts'
import type { Credential } from './auth.ts'

export function credentialFilePath(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qoder-global', 'credentials.json')
}
export async function readCredential(file = credentialFilePath()): Promise<Credential | undefined> {
  let value: unknown
  try { value = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Qoder 凭据无法读取，请重新登录')
  }
  const c = record(value)
  if (typeof c.accessToken !== 'string' || !c.accessToken || typeof c.machineId !== 'string' || !c.machineId) return undefined
  return {
    accessToken: c.accessToken, machineId: c.machineId,
    ...(typeof c.refreshToken === 'string' ? { refreshToken: c.refreshToken } : {}),
    ...(typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt) ? { expiresAt: c.expiresAt } : {}),
    ...(typeof record(c.account).uid === 'string' ? { account: {
      uid: record(c.account).uid as string,
      ...(typeof record(c.account).nickname === 'string' ? { nickname: record(c.account).nickname as string } : {}),
    } } : {}),
  }
}
async function prepare(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await chmod(dirname(file), 0o700)
}
async function writeUnlocked(c: Credential, file: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(c), { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
}
async function locked<T>(file: string, action: () => Promise<T>): Promise<T> {
  await prepare(file)
  const release = await lockfile.lock(file, { realpath: false, retries: { retries: 60, minTimeout: 100, maxTimeout: 500 }, stale: 60_000 })
  try { return await action() } finally { await release() }
}
export async function writeCredential(c: Credential, file = credentialFilePath()): Promise<void> {
  await locked(file, () => writeUnlocked(c, file))
}
/** Serialize refresh across processes; a second caller adopts the first caller's rotated token. */
export async function resolveCredential(options: { file?: string; rejectedToken?: string; fetchImpl?: typeof fetch } = {}): Promise<Credential> {
  const file = options.file ?? credentialFilePath()
  return locked(file, async () => {
    const old = await readCredential(file)
    if (!old) throw new Error('Qoder 国际版未登录：请在设置 → Qoder 国际版账号中登录')
    const rejected = options.rejectedToken === old.accessToken
    if (!rejected && (old.expiresAt === undefined || old.expiresAt > Date.now() + 60_000)) return old
    const next = await refreshCredential(old, options.fetchImpl)
    await writeUnlocked(next, file)
    return next
  })
}
