/**
 * WorkBuddy 的账号登录。
 *
 * 流程是它自己那套：先向站点要一个 state 与一个登录网址，浏览器里授权完，站点把
 * 令牌绑在这个 state 上，客户端轮询就能拿到。轮询期间站点回的是「还在登录中」的
 * 业务码（11217），不是错误——把它当错误处理，登录就永远失败。
 *
 * 这一层钉住：pending 与失败的区分、续期、账户信息，以及**登录接口那几个
 * 「不要带鉴权」的头**——带上旧令牌反而会拿到 401。
 */

import { describe, expect, it } from 'vitest'
import { fetchAccount, pollForToken, refreshSession, startLogin } from '../src/workbuddy/auth.ts'

/** 记下每次请求的地址与头。 */
function recorder(responses: readonly unknown[]): {
  fetchImpl: typeof fetch
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  let index = 0
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    const body = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

describe('开始登录', () => {
  it('要 state 与登录网址，头里声明「不要带鉴权」', async () => {
    const { fetchImpl, calls } = recorder([
      { code: 0, data: { state: 'st-1', authUrl: 'https://www.workbuddy.cn/login?platform=workbuddy&state=st-1' } },
    ])
    const start = await startLogin({ fetchImpl })

    expect(start).toEqual({ state: 'st-1', url: 'https://www.workbuddy.cn/login?platform=workbuddy&state=st-1' })
    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/v2/plugin/auth/state?platform=workbuddy')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-no-authorization']).toBe('true')
    expect(headers['x-no-user-id']).toBe('true')
    expect(headers['x-no-enterprise-id']).toBe('true')
    expect(headers['x-no-department-info']).toBe('true')
    expect(headers['x-domain']).toBe('www.workbuddy.cn')
  })

  it('站点没给登录网址就报错', async () => {
    const { fetchImpl } = recorder([{ code: 0, data: { data: { state: 'st-1' } } }])
    await expect(startLogin({ fetchImpl })).rejects.toThrow(/登录/)
  })
})

describe('轮询令牌', () => {
  it('「还在登录中」不算错误，继续等', async () => {
    const { fetchImpl, calls } = recorder([
      { code: 11217, msg: 'login ing...' },
      { code: 0, data: { accessToken: 'ACCESS', refreshToken: 'REFRESH', expiresIn: 3600 } },
    ])
    const credential = await pollForToken({ state: 'st-1', fetchImpl, intervalMs: 0 })

    expect(credential.accessToken).toBe('ACCESS')
    expect(credential.refreshToken).toBe('REFRESH')
    expect(credential.expiresAt).toBeGreaterThan(Date.now() + 3_000_000)
    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/v2/plugin/auth/token?state=st-1')
    expect(calls).toHaveLength(2)
  })

  it('等到超时就说没等到登录', async () => {
    const { fetchImpl } = recorder([{ code: 11217, msg: 'login ing...' }])
    await expect(pollForToken({ state: 'st-1', fetchImpl, intervalMs: 0, timeoutMs: 30 }))
      .rejects.toThrow(/登录/)
  })

  it('别的业务码直接报错，不傻等', async () => {
    const { fetchImpl, calls } = recorder([{ code: 40001, msg: 'state expired' }])
    await expect(pollForToken({ state: 'st-1', fetchImpl, intervalMs: 0, timeoutMs: 5_000 })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
})

describe('续期与账户', () => {
  it('续期带刷新令牌，成功后拿到新令牌', async () => {
    const { fetchImpl, calls } = recorder([
      { code: 0, data: { accessToken: 'ACCESS-2', refreshToken: 'REFRESH-2', expiresIn: 3600 } },
    ])
    const credential = await refreshSession({ refreshToken: 'REFRESH', fetchImpl })

    expect(credential.accessToken).toBe('ACCESS-2')
    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/v2/plugin/auth/token/refresh')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-refresh-token']).toBe('REFRESH')
    expect(headers['x-auth-refresh-source']).toBe('plugin')
  })

  it('账户信息带访问令牌去要', async () => {
    const { fetchImpl, calls } = recorder([
      { code: 0, data: { uid: 'uid-1', nickname: '某人', enterpriseId: 'ent-9' } },
    ])
    const account = await fetchAccount({ accessToken: 'ACCESS', fetchImpl })

    expect(account).toEqual({ uid: 'uid-1', nickname: '某人', enterpriseId: 'ent-9' })
    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/v2/plugin/account')
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer ACCESS')
  })

  it('账户应答缺内容就报错', async () => {
    const { fetchImpl } = recorder([{ code: 0, data: undefined }])
    await expect(fetchAccount({ accessToken: 'ACCESS', fetchImpl })).rejects.toThrow()
  })
})
