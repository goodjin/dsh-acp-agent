/**
 * Decrypting the local ZCode coding-plan credential.
 *
 * Measured 2026-10-13: `~/.zcode/v2/credentials.json` holds the api key under
 * a key like `account-provider:coding-plan:…:api-key`, the value being
 * `enc:v1:<iv>.<tag>.<ct>` in base64url, AES-256-GCM with the key derived as
 * sha256 of `zcode-credential-fallback:<platform>:<homedir>:<username>`.
 *
 * The username must come from the passwd entry for the current uid — on macOS
 * `os.login()`-style environment lookups can disagree with it and the GCM tag
 * then fails. Node's `os.userInfo()` reads the passwd entry, which is the one
 * that decrypts. The decrypted key lives in memory only; nothing here logs it.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * Where ZCode keeps its files: `<data dir>/.zcode/v2`.
 *
 * The desktop app honours `ZCODE_DATA_BASE_DIR`; so do we, so that a user who
 * moved their data directory is not left with a plugin that reads an empty
 * home directory.
 * @param env - the environment to read, defaults to this process's.
 * @returns the directory ZCode's files live in.
 */
export function zcodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['ZCODE_DATA_BASE_DIR']
  return base !== undefined && base.trim() !== ''
    ? join(base.trim(), '.zcode', 'v2')
    : join(homedir(), '.zcode', 'v2')
}

function b64url(input: string): Buffer {
  return Buffer.from(input + '='.repeat((4 - input.length % 4) % 4), 'base64url')
}

/** Derive the AES key the same way the desktop app's fallback secret does. */
export function deriveKey(over?: { platform?: string; home?: string; username?: string }): Buffer {
  const secret = `zcode-credential-fallback:${over?.platform ?? platform()}:${over?.home ?? homedir()}:${over?.username ?? userInfo().username}`
  return createHash('sha256').update(secret).digest()
}

/** Decrypt one `enc:v1:<iv>.<tag>.<ct>` value. Throws when the tag fails. */
export function decryptCredential(value: string, key: Buffer = deriveKey()): string {
  const body = value.slice('enc:v1:'.length)
  const parts = body.split('.')
  if (parts.length !== 3 || parts.some(part => part === '')) throw new Error('credential is not enc:v1:<iv>.<tag>.<ct>')
  const decipher = createDecipheriv('aes-256-gcm', key, b64url(parts[0]!))
  decipher.setAuthTag(b64url(parts[1]!))
  return Buffer.concat([decipher.update(b64url(parts[2]!)), decipher.final()]).toString('utf8')
}

/**
 * The coding-plan api key, decrypted.
 *
 * The file is read per call and the key stays in memory only — nothing here
 * writes it, and nothing here logs it. The newer ZCode keeps the key in its
 * provider configuration instead; this path is the older app's.
 */
export async function loadApiKey(credentialsFile: string): Promise<string> {
  let creds: Record<string, unknown>
  try {
    creds = JSON.parse(await readFile(credentialsFile, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`cannot read ZCode credentials at ${credentialsFile}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const key = planKeyOf(creds)
  if (key !== undefined) return key
  throw new Error('no coding-plan api key in ZCode credentials (is the desktop app logged in?)')
}

/**
 * The coding-plan api key in the encrypted credential file, if there is one.
 *
 * The older ZCode wrote it there, under `account-provider:coding-plan:…:api-key`.
 * The current app does not write that entry any more — it keeps the key in its
 * provider configuration instead — so this is the fallback for the older app.
 *
 * A file that is not there is not an error here: the caller has another place
 * to look. A file that is there but unreadable is.
 * @param credentialsFile - the encrypted credential file.
 * @returns the decrypted key, or undefined when the file holds none.
 */
export async function findApiKey(credentialsFile: string): Promise<string | undefined> {
  let creds: Record<string, unknown>
  try {
    creds = JSON.parse(await readFile(credentialsFile, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new Error(`cannot read ZCode credentials at ${credentialsFile}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return planKeyOf(creds)
}

/** The coding-plan entry of a credential file, decrypted. */
function planKeyOf(creds: Record<string, unknown>): string | undefined {
  for (const [name, value] of Object.entries(creds)) {
    if (name.startsWith('account-provider:coding-plan:') && name.endsWith(':api-key')
      && typeof value === 'string' && value.startsWith('enc:v1:')) {
      return decryptCredential(value)
    }
  }
  return undefined
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
