/**
 * Where the coding-plan key comes from.
 *
 * ZCode's desktop app used to hand the key over in its encrypted credential
 * file, under `account-provider:coding-plan:…:api-key`. That entry is gone in
 * the current app: the key now sits in the app's own provider configuration,
 * in plain text, under the coding-plan provider's `options.apiKey`. The
 * encrypted file is still the fallback for older apps, so both are read — the
 * provider configuration first.
 *
 * The key is picked by the endpoint it belongs to, not by name: the same
 * configuration also carries the start-plan entry, whose value is a short-lived
 * JWT for a different gateway.
 */

import { describe, expect, it } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveKey } from '../src/zcode/credential.ts'
import { resolveApiKey } from '../src/zcode/glm.ts'

/** A scratch directory per test; nothing outside it is written. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'zcode-credential-'))
}

/** Write ZCode's provider configuration the way the desktop app writes it. */
async function writeConfig(dir: string, providers: Record<string, unknown>): Promise<string> {
  const file = join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ provider: providers }), 'utf8')
  return file
}

/** The coding-plan provider entry: the key plus the gateway it belongs to. */
function codingPlanProvider(apiKey: string, baseURL = 'https://open.bigmodel.cn/api/anthropic'): Record<string, unknown> {
  return { name: 'Bigmodel - Coding Plan', kind: 'anthropic', options: { apiKey, baseURL }, source: 'custom' }
}

/** The start-plan entry: a different gateway and a value that is a JWT, not a key. */
function startPlanProvider(jwt: string): Record<string, unknown> {
  return {
    name: 'Bigmodel - Start Plan',
    kind: 'anthropic',
    options: { apiKey: jwt, baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
    source: 'custom',
  }
}

/** Encrypt a value the way ZCode encrypts its credential file. */
function encrypt(plain: string): string {
  const key = deriveKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const b64 = (bytes: Buffer) => bytes.toString('base64url')
  return `enc:v1:${b64(iv)}.${b64(tag)}.${b64(body)}`
}

/** Write the encrypted credential file the older app used. */
async function writeCredentials(dir: string, entries: Record<string, string>): Promise<string> {
  const file = join(dir, 'credentials.json')
  await writeFile(file, JSON.stringify(entries), 'utf8')
  return file
}

describe('coding-plan 的 key 从哪来', () => {
  it('ZCode 自己的 provider 配置里有这一族的 key 时就用它', async () => {
    const dir = await scratch()
    const configFile = await writeConfig(dir, {
      'builtin:bigmodel-coding-plan': codingPlanProvider('plan-key-from-provider-config'),
    })
    await expect(resolveApiKey({ configFile })).resolves.toBe('plan-key-from-provider-config')
  })

  it('按地址挑那一条：start-plan 的 JWT 不会被当成 coding-plan 的 key', async () => {
    const dir = await scratch()
    const configFile = await writeConfig(dir, {
      'builtin:bigmodel-coding-plan': codingPlanProvider('plan-key-from-provider-config'),
      'builtin:bigmodel-start-plan': startPlanProvider('eyJhbGciOiJIUzI1NiJ9.start-plan-jwt'),
    })
    await expect(resolveApiKey({ configFile })).resolves.toBe('plan-key-from-provider-config')
  })

  it('ZCode 的配置里没有这一族时，回退到旧的加密凭据', async () => {
    const dir = await scratch()
    const configFile = await writeConfig(dir, {
      'builtin:zai-coding-plan': codingPlanProvider('zai-key', 'https://api.z.ai/api/anthropic'),
    })
    const credentialsFile = await writeCredentials(dir, {
      'account-provider:coding-plan:bigmodel:account:42:api-key': encrypt('legacy-encrypted-key'),
    })
    await expect(resolveApiKey({ configFile, credentialsFile })).resolves.toBe('legacy-encrypted-key')
  })

  it('两处都没有时，说清去哪儿找，并且不把任何 key 写进消息', async () => {
    const dir = await scratch()
    const configFile = await writeConfig(dir, {})
    const credentialsFile = await writeCredentials(dir, { 'bot:bot-1:credential': encrypt('unrelated-secret') })
    const failure = await resolveApiKey({ configFile, credentialsFile }).then(
      key => ({ ok: true as const, key }),
      error => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
    )
    expect(failure.ok).toBe(false)
    if (failure.ok) return
    expect(failure.message).toContain('ZCode')
    expect(failure.message).toContain(configFile)
    expect(failure.message).not.toContain('unrelated-secret')
  })

  it('重读：ZCode 里换了 key，下一次取数就是新的', async () => {
    const dir = await scratch()
    const configFile = await writeConfig(dir, {
      'builtin:bigmodel-coding-plan': codingPlanProvider('first-key'),
    })
    await expect(resolveApiKey({ configFile })).resolves.toBe('first-key')
    await writeConfig(dir, {
      'builtin:bigmodel-coding-plan': codingPlanProvider('second-key'),
    })
    await expect(resolveApiKey({ configFile })).resolves.toBe('second-key')
  })

  it('没有配置文件时不算错：旧凭据仍然认', async () => {
    const dir = await scratch()
    const credentialsFile = await writeCredentials(dir, {
      'account-provider:coding-plan:bigmodel:account:42:api-key': encrypt('legacy-encrypted-key'),
    })
    await expect(resolveApiKey({
      configFile: join(dir, 'there-is-no-config.json'),
      credentialsFile,
    })).resolves.toBe('legacy-encrypted-key')
  })
})
