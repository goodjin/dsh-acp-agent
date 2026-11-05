/**
 * 凭据的存放与解析。
 *
 * 令牌有两个去处：宿主进程的内存，和本机一份只属于当前用户的文件。文件必须只有
 * 当前用户能读（0600），目录同理（0700）——它是一把能直接当账号用的钥匙。
 *
 * 这一层钉住四件事：
 * 1. 存在哪、权限对不对；
 * 2. 没登录时给的是「需要登录」这个可读的结论，而不是一串 401；
 * 3. 令牌快过期时先续期再发，并且把新令牌写回文件；
 * 4. **任何一条错误消息里都不含令牌**。
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attachAccount,
  clearStoredCredential,
  credentialFilePath,
  credentialResolver,
  readStoredCredential,
  writeStoredCredential,
  WorkBuddyAuthRequiredError,
} from '../src/workbuddy/credential.ts'
import type { WorkBuddyCredential } from '../src/workbuddy/credential.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-credential-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 假 fetch：按调用顺序回不同的响应。 */
function fakeFetch(responses: readonly unknown[]): { fetchImpl: typeof fetch; calls: { url: string }[] } {
  const calls: { url: string }[] = []
  let index = 0
  const fetchImpl: typeof fetch = async (url) => {
    calls.push({ url: String(url) })
    const body = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

describe('存放位置', () => {
  it('默认在 DSH 自己的目录下，DSH_HOME 说了算', () => {
    expect(credentialFilePath({})).toMatch(/\.dsh\/workbuddy\/credentials\.json$/)
    expect(credentialFilePath({ DSH_HOME: '/tmp/dsh-home' })).toBe('/tmp/dsh-home/workbuddy/credentials.json')
  })

  it('写出来的文件只有当前用户能读', async () => {
    const file = join(dir, 'credentials.json')
    await writeStoredCredential({ accessToken: 'ACCESS', refreshToken: 'REFRESH' }, file)
    const info = await stat(file)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('目录也只有当前用户能进（已经存在的目录也要收紧）', async () => {
    const nested = join(dir, 'nested')
    await mkdir(nested, { recursive: true, mode: 0o755 })
    await chmod(nested, 0o755)
    await writeStoredCredential({ accessToken: 'ACCESS' }, join(nested, 'credentials.json'))
    const info = await stat(nested)
    expect(info.mode & 0o777).toBe(0o700)
  })

  it('读回来是原来那份，没有文件时是空而不是报错', async () => {
    const file = join(dir, 'credentials.json')
    expect(await readStoredCredential(file)).toBeUndefined()
    const credential: WorkBuddyCredential = {
      accessToken: 'ACCESS',
      refreshToken: 'REFRESH',
      expiresAt: Date.now() + 3_600_000,
      account: { uid: 'uid-1', nickname: '某人' },
    }
    await writeStoredCredential(credential, file)
    expect(await readStoredCredential(file)).toEqual(credential)
  })

  it('补上账户信息后存回去：模型请求要带 X-User-Id，界面要显示是谁', async () => {
    const file = join(dir, 'credentials.json')
    await writeStoredCredential({ accessToken: 'ACCESS' }, file)
    const updated = await attachAccount({ uid: 'uid-1', nickname: '某人' }, file)
    expect(updated?.account).toEqual({ uid: 'uid-1', nickname: '某人' })
    const stored = await readStoredCredential(file)
    expect(stored?.account?.uid).toBe('uid-1')
    expect(stored?.accessToken).toBe('ACCESS')
  })

  it('没存过凭据时补账户是空，不凭空造一份', async () => {
    expect(await attachAccount({ uid: 'uid-1' }, join(dir, 'none.json'))).toBeUndefined()
  })

  it('清掉之后就没有了', async () => {
    const file = join(dir, 'credentials.json')
    await writeStoredCredential({ accessToken: 'ACCESS' }, file)
    await clearStoredCredential(file)
    expect(await readStoredCredential(file)).toBeUndefined()
  })
})

describe('取凭据', () => {
  it('没登录时说的是「需要登录」', async () => {
    const file = join(dir, 'credentials.json')
    const resolve = credentialResolver({ file, fetchImpl: fakeFetch([]).fetchImpl })
    await expect(resolve()).rejects.toBeInstanceOf(WorkBuddyAuthRequiredError)
    await expect(resolve()).rejects.toThrow(/登录/)
  })

  it('令牌还新鲜就直接用', async () => {
    const file = join(dir, 'credentials.json')
    await writeStoredCredential({
      accessToken: 'ACCESS',
      refreshToken: 'REFRESH',
      expiresAt: Date.now() + 3_600_000,
      account: { uid: 'uid-1' },
    }, file)
    const { fetchImpl, calls } = fakeFetch([])
    const resolve = credentialResolver({ file, fetchImpl })
    const credential = await resolve()
    expect(credential.accessToken).toBe('ACCESS')
    expect(calls).toHaveLength(0)
  })

  it('快过期时先续期，并把新令牌写回文件', async () => {
    const file = join(dir, 'credentials.json')
    await writeStoredCredential({
      accessToken: 'OLD',
      refreshToken: 'REFRESH',
      expiresAt: Date.now() + 10_000,
      account: { uid: 'uid-1' },
    }, file)
    const { fetchImpl, calls } = fakeFetch([
      { code: 0, data: { accessToken: 'NEW', refreshToken: 'REFRESH-2', expiresIn: 3600 } },
      { code: 0, data: { uid: 'uid-1', nickname: '某人' } },
    ])
    const resolve = credentialResolver({ file, fetchImpl })
    const credential = await resolve()

    expect(credential.accessToken).toBe('NEW')
    expect(calls[0]?.url).toContain('/auth/token/refresh')
    const stored = JSON.parse(await readFile(file, 'utf8')) as WorkBuddyCredential
    expect(stored.accessToken).toBe('NEW')
  })

  it('刷新令牌也过期了就是需要登录', async () => {
    const file = join(dir, 'credentials.json')
    await writeStoredCredential({
      accessToken: 'OLD',
      refreshToken: 'REFRESH',
      expiresAt: Date.now() + 10_000,
    }, file)
    const { fetchImpl } = fakeFetch([{ code: 40001, msg: 'refresh token expired' }])
    const resolve = credentialResolver({ file, fetchImpl })
    await expect(resolve()).rejects.toBeInstanceOf(WorkBuddyAuthRequiredError)
  })

  it('续期成功但账户信息没要到，不影响拿令牌', async () => {
    const file = join(dir, 'credentials.json')
    await writeStoredCredential({
      accessToken: 'OLD',
      refreshToken: 'REFRESH',
      expiresAt: Date.now() + 10_000,
    }, file)
    const { fetchImpl } = fakeFetch([
      { code: 0, data: { accessToken: 'NEW', refreshToken: 'REFRESH-2', expiresIn: 3600 } },
      { code: 0, data: undefined },
    ])
    const resolve = credentialResolver({ file, fetchImpl })
    const credential = await resolve()
    expect(credential.accessToken).toBe('NEW')
  })

  it('错误消息里没有令牌', async () => {
    const file = join(dir, 'credentials.json')
    await writeStoredCredential({
      accessToken: 'SECRET-ACCESS-TOKEN',
      refreshToken: 'SECRET-REFRESH-TOKEN',
      expiresAt: Date.now() + 10_000,
    }, file)
    const { fetchImpl } = fakeFetch([{ code: 40001, msg: 'expired' }])
    const resolve = credentialResolver({ file, fetchImpl })
    let message = ''
    try {
      await resolve()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain('SECRET-ACCESS-TOKEN')
    expect(message).not.toContain('SECRET-REFRESH-TOKEN')
  })

  it('存坏的文件当没有凭据，而不是崩掉', async () => {
    const file = join(dir, 'credentials.json')
    await writeFile(file, '不是 JSON', 'utf8')
    const resolve = credentialResolver({ file, fetchImpl: fakeFetch([]).fetchImpl })
    await expect(resolve()).rejects.toBeInstanceOf(WorkBuddyAuthRequiredError)
  })
})
