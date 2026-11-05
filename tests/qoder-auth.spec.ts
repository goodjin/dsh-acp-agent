import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  credentialOfPoll,
  credentialOfRefresh,
  pollForToken,
  refreshCredential,
  startLogin,
} from '../src/qoder/auth.ts'

describe('Qoder 国际版的设备码登录', () => {
  it('授权地址带上 PKCE 参数，verifier 不进浏览器', () => {
    const login = startLogin({ machineId: 'mid' })
    const url = new URL(login.url)
    expect(url.origin).toBe('https://qoder.com')
    expect(url.pathname).toBe('/device/selectAccounts')
    expect(url.searchParams.get('challenge_method')).toBe('S256')
    expect(url.searchParams.get('challenge')).toBe(createHash('sha256').update(login.verifier).digest('base64url'))
    expect(url.searchParams.get('nonce')).toBe(login.nonce)
    expect(url.searchParams.get('machine_id')).toBe('mid')
    expect(url.searchParams.get('client_id')).toBe('e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
    expect(login.url).not.toContain(login.verifier)
  })

  it('每次登录的随机量都不一样', () => {
    const a = startLogin()
    const b = startLogin()
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.verifier).not.toBe(b.verifier)
  })

  it('轮询把 404 当成还没授权', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ token: 'v', expires_in: 3600, user_id: 'uid', user_name: 'n' }))
    const credential = await pollForToken(startLogin({ machineId: 'mid' }), { fetchImpl: mock, intervalMs: 0 })
    expect(credential.accessToken).toBe('v')
    expect(credential.account).toEqual({ uid: 'uid', nickname: 'n' })
    expect(mock.mock.calls[0]?.[0]).toContain('https://openapi.qoder.sh/api/v1/deviceToken/poll?')
  })

  it('轮询应答是顶层的 token，不是 data.data', () => {
    expect(() => credentialOfPoll({ data: { token: 'x' } }, 'mid')).toThrow()
    expect(() => credentialOfPoll({}, 'mid')).toThrow()
  })

  it('轮询应答的到期时间两种写法都认', () => {
    expect(credentialOfPoll({ token: 't', expires_at: '2030-01-01T00:00:00Z' }, 'm').expiresAt)
      .toBe(Date.parse('2030-01-01T00:00:00Z'))
    expect(credentialOfPoll({ token: 't', expires_in: 60 }, 'm').expiresAt).toBeGreaterThan(Date.now())
  })

  it('续期取 device_token，机器标识一起送上', async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({
      device_token: 'new', refresh_token: 'r2', expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }))
    const credential = await refreshCredential({ accessToken: 'old', refreshToken: 'r1', machineId: 'mid' }, { fetchImpl: mock })
    expect(credential.accessToken).toBe('new')
    expect(credential.refreshToken).toBe('r2')
    const body = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body['refresh_token']).toBe('r1')
    expect(body['machine_id']).toBe('mid')
  })

  it('续期应答没有新 refresh_token 时保留旧的', () => {
    const credential = credentialOfRefresh({ device_token: 'd' }, 'mid')
    expect(credential.accessToken).toBe('d')
  })

  it('失败信息里不出现令牌', async () => {
    await expect(refreshCredential(
      { accessToken: 'secret-access', refreshToken: 'secret-refresh', machineId: 'mid' },
      { fetchImpl: vi.fn().mockResolvedValue(new Response('secret-refresh', { status: 500 })) },
    )).rejects.toThrow(/HTTP 500/)
    await expect(refreshCredential(
      { accessToken: 'secret-access', refreshToken: 'secret-refresh', machineId: 'mid' },
      { fetchImpl: vi.fn().mockResolvedValue(new Response('secret-refresh', { status: 500 })) },
    )).rejects.not.toThrow(/secret/)
  })

  it('没有 refresh_token 时说清楚要重新登录', async () => {
    await expect(refreshCredential(
      { accessToken: 'a', machineId: 'm' },
      { fetchImpl: vi.fn() },
    )).rejects.toThrow('登录')
  })

  it('已经取消的轮询不再发请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const mock = vi.fn()
    await expect(pollForToken(startLogin(), { fetchImpl: mock, signal: controller.signal })).rejects.toThrow()
    expect(mock).not.toHaveBeenCalled()
  })
})
