/**
 * WorkBuddy 请求的头。
 *
 * 站点**按 User-Agent 里的产品名认客户端**：不是 `WorkBuddy/版本` 形状的 UA 一律
 * 400「check ua, get coding copilot version error」——清单和模型请求都过不去。
 * 所以每一发请求都必须带这个头，这一条是「清单拿不到」和「模型请求被拒」的
 * 同一个根因。
 *
 * 这里钉住：UA 的形状、它出现在每一发请求上、以及桌面版本地目录的位置。
 */

import { describe, expect, it } from 'vitest'
import {
  desktopCatalogDir,
  workBuddyHeaders,
  WORKBUDDY_UA,
} from '../src/workbuddy/endpoints.ts'

describe('客户端标识', () => {
  it('UA 是 WorkBuddy/版本形状，后缀标出是我们发的', () => {
    expect(WORKBUDDY_UA).toMatch(/^WorkBuddy\/\d+\.\d+\.\d+/)
    expect(WORKBUDDY_UA).toContain('dsh-acp-agent')
  })

  it('每个请求都带上它', () => {
    expect(workBuddyHeaders()['user-agent']).toBe(WORKBUDDY_UA)
    expect(workBuddyHeaders({ accept: 'application/json' })['user-agent']).toBe(WORKBUDDY_UA)
  })

  it('别的头不被覆盖', () => {
    expect(workBuddyHeaders({ authorization: 'Bearer X' }).authorization).toBe('Bearer X')
  })
})

describe('桌面版的本地目录', () => {
  it('默认在 ~/.workbuddy 下，可以用环境变量换', () => {
    expect(desktopCatalogDir({})).toMatch(/\.workbuddy\/local_storage$/)
    expect(desktopCatalogDir({ WORKBUDDY_HOME: '/tmp/wb' })).toBe('/tmp/wb/local_storage')
  })
})
