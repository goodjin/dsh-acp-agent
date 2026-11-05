import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialFilePath, readCredential, resolveCredential, writeCredential } from '../src/qoder/credential.ts'

const roots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qoder-cred-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Qoder 国际版的凭据存放', () => {
  it('凭据文件在自己的目录里，不碰 Qoder 桌面版的东西', () => {
    expect(credentialFilePath()).toContain('qoder-global')
    expect(credentialFilePath()).not.toContain('.qoder/')
  })

  it('已存在的目录也会被收紧到 0700，文件是 0600', async () => {
    const root = await scratch()
    const dir = join(root, 'qoder-global')
    await mkdir(dir, { mode: 0o755 })
    const file = join(dir, 'credentials.json')
    await writeCredential({ accessToken: 'a', machineId: 'm' }, file)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('存进去再读出来是一个样', async () => {
    const root = await scratch()
    const file = join(root, 'credentials.json')
    await writeCredential({ accessToken: 'a', refreshToken: 'r', machineId: 'm', account: { uid: 'u', nickname: 'n' } }, file)
    expect(await readCredential(file)).toEqual({ accessToken: 'a', refreshToken: 'r', machineId: 'm', account: { uid: 'u', nickname: 'n' } })
  })

  it('两个进程同时要续期只续一次，后来者用新令牌', async () => {
    const root = await scratch()
    const file = join(root, 'credentials.json')
    await writeCredential({ accessToken: 'old', refreshToken: 'r1', machineId: 'm', expiresAt: 1 }, file)
    const mock = vi.fn().mockResolvedValue(Response.json({ device_token: 'rotated', refresh_token: 'r2' }))
    const [a, b] = await Promise.all([
      resolveCredential({ file, fetchImpl: mock }),
      resolveCredential({ file, fetchImpl: mock }),
    ])
    expect(mock).toHaveBeenCalledTimes(1)
    expect(a.accessToken).toBe('rotated')
    expect(b.accessToken).toBe('rotated')
    expect((await readCredential(file))?.refreshToken).toBe('r2')
  })

  it('令牌被上游拒绝时立刻换一次', async () => {
    const root = await scratch()
    const file = join(root, 'credentials.json')
    await writeCredential({ accessToken: 'old', refreshToken: 'r1', machineId: 'm', expiresAt: Date.now() + 3600_000 }, file)
    const mock = vi.fn().mockResolvedValue(Response.json({ device_token: 'rotated', refresh_token: 'r2' }))
    const credential = await resolveCredential({ file, fetchImpl: mock, rejectedToken: 'old' })
    expect(mock).toHaveBeenCalledTimes(1)
    expect(credential.accessToken).toBe('rotated')
  })

  it('没登录时说清楚要登录', async () => {
    const root = await scratch()
    await expect(resolveCredential({ file: join(root, 'none.json') })).rejects.toThrow('登录')
  })

  it('文件坏了当作没登录，不把坏内容当凭据', async () => {
    const root = await scratch()
    const file = join(root, 'credentials.json')
    await writeFile(file, '{ 这不是 JSON', { mode: 0o600 })
    expect(await readCredential(file)).toBeUndefined()
    await expect(resolveCredential({ file })).rejects.toThrow('登录')
  })
})
