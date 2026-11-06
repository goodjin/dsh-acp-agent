/**
 * The coding-plan key ZCode's own provider configuration carries.
 *
 * Measured 2026-11-06 against the ZCode desktop app 3.17.2: the app no longer
 * keeps the coding-plan key in its encrypted credential file. It writes it into
 * its own provider configuration — `config.json` next to `credentials.json` —
 * in plain text, under that provider entry's `options.apiKey`, right next to
 * the `options.baseURL` the entry serves. That value is what the gateway
 * accepts as `x-api-key`.
 *
 * The configuration carries more than one provider. The start-plan entry holds
 * a short-lived JWT and serves a different gateway; the user's own API-key
 * entry serves yet another. So the entry is picked by the gateway it serves,
 * not by its name.
 *
 * The file is read on every lookup, never cached: the desktop app rewrites it
 * when the user signs in again or switches plans, and a key that is one
 * re-login old is a key that no longer works.
 */

import { readFile } from 'node:fs/promises'

/** The key one provider entry carries, and which entry carried it. */
export type PlanProviderKey = {
  /** The key itself. Never logged, never written out. */
  readonly key: string
  /** The provider entry's name in the configuration (`builtin:bigmodel-coding-plan`). */
  readonly provider: string
  /** The gateway that entry serves. */
  readonly baseURL: string
}

/**
 * The coding-plan key the provider configuration holds for one gateway.
 *
 * A file that is not there is not an error: the older app kept the key
 * elsewhere, and the caller falls back to that. A file that is there but
 * unreadable is an error — it means the desktop app's own state is broken.
 * @param configFile - ZCode's provider configuration (`…/config.json`).
 * @param base - the coding-plan gateway wanted, as a base or a messages URL.
 * @returns the key and the entry that carried it, or undefined when the
 * configuration holds nothing for that gateway.
 */
export async function readPlanProviderKey(configFile: string, base: string): Promise<PlanProviderKey | undefined> {
  const wanted = planBase(base)
  const entries = await readProviderEntries(configFile)
  if (entries === undefined) return undefined
  const byGateway = entries.find(entry => planBase(entry.baseURL) === wanted)
  if (byGateway !== undefined) return byGateway
  // No entry serves that gateway by name-matching the URL: fall back to the
  // coding-plan entry of the family the gateway belongs to.
  const family = familyProvider(wanted)
  if (family === undefined) return undefined
  return entries.find(entry => entry.provider === family)
}

/**
 * The provider entries of ZCode's configuration that carry a key.
 *
 * @param configFile - ZCode's provider configuration.
 * @returns the entries, or undefined when the file is not there.
 */
async function readProviderEntries(configFile: string): Promise<PlanProviderKey[] | undefined> {
  let raw: string
  try {
    raw = await readFile(configFile, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new Error(`cannot read ZCode's provider configuration at ${configFile}: ${describe(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`cannot read ZCode's provider configuration at ${configFile}: ${describe(error)}`)
  }
  const providers = isRecord(parsed) ? parsed['provider'] : undefined
  if (!isRecord(providers)) return []
  const entries: PlanProviderKey[] = []
  for (const [provider, entry] of Object.entries(providers)) {
    if (!isRecord(entry)) continue
    const options = isRecord(entry['options']) ? entry['options'] : undefined
    if (options === undefined) continue
    const key = options['apiKey']
    const baseURL = options['baseURL']
    if (typeof key !== 'string' || key.trim() === '') continue
    if (typeof baseURL !== 'string' || baseURL.trim() === '') continue
    entries.push({ key: key.trim(), provider, baseURL: baseURL.trim() })
  }
  return entries
}

/**
 * The gateway a base or messages URL belongs to.
 *
 * `https://open.bigmodel.cn/api/anthropic` and the messages URL the app
 * posts to are the same gateway; the `/v1` and `/v1/messages` suffixes are
 * the request shape, not a different provider.
 * @param url - a coding-plan base or a messages URL.
 * @returns the gateway without its request suffixes.
 */
export function planBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, '')
  return trimmed.replace(/\/v1\/messages$/u, '').replace(/\/v1$/u, '')
}

/**
 * The coding-plan provider entry of the family a gateway belongs to.
 * @param base - the gateway.
 * @returns the provider entry's name, or undefined for an unknown family.
 */
function familyProvider(base: string): string | undefined {
  let host: string
  try {
    host = new URL(base).hostname
  } catch {
    return undefined
  }
  if (host === 'bigmodel.cn' || host.endsWith('.bigmodel.cn')) return 'builtin:bigmodel-coding-plan'
  if (host === 'z.ai' || host.endsWith('.z.ai')) return 'builtin:zai-coding-plan'
  return undefined
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
