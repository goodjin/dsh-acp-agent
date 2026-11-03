/**
 * 「登录过期了去哪儿授权」这条链。
 *
 * 上游 MiniMax Code 的凭据由官方 OAuth core 维护（自动刷新 + 跨进程锁），过期到
 * 刷新令牌也救不回来时，唯一有用的是设备授权：拿到 `verification_uri_complete`
 * 让人点开确认，客户端在后台轮询并把新凭据写回同一份 `auth.json`。
 *
 * 这里钉三件事：
 * - 拿到提示就返回（不等人授权完），第二次调用复用缓存、不重复开流程；
 * - 提示过期后重新开；
 * - 流程失败 / 迟迟不给提示时如实报错，供应答层退回账户站点。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  LOGIN_PROMPT_TIMEOUT_MS,
  accountOrigin,
  beginDeviceLogin,
  cachedLoginPrompt,
  clearLoginPrompt,
  loginUrlHint,
  promptUrl,
} from '../src/minimaxi/login.ts'
import type { LoginManager, MiniMaxLoginPrompt } from '../src/minimaxi/login.ts'

const PROMPT: MiniMaxLoginPrompt = {
  userCode: 'AB12-CD34',
  verificationUri: 'https://account.minimax.cn/device',
  verificationUriComplete: 'https://account.minimax.cn/device?user_code=AB12-CD34',
  expiresInSec: 300,
}

/** 一个假登录管理器：把提示交出去，然后「一直轮询」（返回悬着的 promise）。 */
function fakeManager(prompt: MiniMaxLoginPrompt = PROMPT): { manager: LoginManager; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    manager: {
      login(options?: { onDeviceAuthorization?: (prompt: MiniMaxLoginPrompt) => void }): Promise<unknown> {
        calls += 1
        options?.onDeviceAuthorization?.(prompt)
        return new Promise(() => {}) // 真实流程会一直轮询到用户确认
      },
    },
  }
}

afterEach(() => { clearLoginPrompt() })

describe('设备授权提示', () => {
  it('拿到提示就返回，并把它缓存下来', async () => {
    const { manager, calls } = fakeManager()
    const prompt = await beginDeviceLogin({ manager })
    expect(prompt).toEqual(PROMPT)
    expect(promptUrl(prompt)).toBe(PROMPT.verificationUriComplete)
    expect(cachedLoginPrompt()).toEqual(PROMPT)

    // 第二次：复用缓存，不再开新流程（配额胶囊每 30 秒就会问一次）。
    const again = await beginDeviceLogin({ manager })
    expect(again).toEqual(PROMPT)
    expect(calls()).toBe(1)
  })

  it('提示过期后重新开一次', async () => {
    let clock = 1_000
    const { manager, calls } = fakeManager()
    await beginDeviceLogin({ manager, now: () => clock })
    expect(calls()).toBe(1)
    clock += (PROMPT.expiresInSec + 1) * 1000
    expect(cachedLoginPrompt(() => clock)).toBeUndefined()
    await beginDeviceLogin({ manager, now: () => clock })
    expect(calls()).toBe(2)
  })

  it('流程在给出提示前就失败：如实抛错', async () => {
    const manager: LoginManager = {
      login: () => Promise.reject(new Error('endpoint unavailable')),
    }
    await expect(beginDeviceLogin({ manager })).rejects.toThrow('endpoint unavailable')
    expect(cachedLoginPrompt()).toBeUndefined()
  })

  it('迟迟拿不到提示：超时报错而不是永远挂着', async () => {
    const manager: LoginManager = { login: () => new Promise(() => {}) }
    await expect(beginDeviceLogin({ manager, timeoutMs: 20 })).rejects.toThrow(String(20))
  })

  it('默认期限足够慢网络回来', () => {
    expect(LOGIN_PROMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
  })
})

describe('授权地址的兜底', () => {
  it('有缓存就给出带用户码的完整地址', async () => {
    await beginDeviceLogin({ manager: fakeManager().manager })
    expect(loginUrlHint('cn', 'prod')).toBe(PROMPT.verificationUriComplete)
  })

  it('没有缓存时退回账户站点（仅 prod 有稳定地址）', () => {
    expect(loginUrlHint('cn', 'prod')).toBe('https://account.minimax.cn')
    expect(loginUrlHint('en', 'prod')).toBe('https://account.minimax.io')
    expect(loginUrlHint('cn', 'staging')).toBeUndefined()
    expect(accountOrigin('cn', 'test')).toBeUndefined()
  })
})
