/**
 * 真机验收：WorkBuddy 的账号、模型与一次完整回合。
 *
 * 真凭据、真网络、真站点。默认跳过，要 `WORKBUDDY_LIVE=1` 才跑：
 * ```
 * WORKBUDDY_LIVE=1 pnpm vitest run tests/workbuddy-live.spec.ts
 * ```
 *
 * 前置条件：本机已经登录 WorkBuddy（设置里的「WorkBuddy 账号」段点一次登录，
 * 或宿主路由 `POST /acp-agent/workbuddy/login` 走一遍）。凭据在
 * `~/.dsh/workbuddy/credentials.json`。
 *
 * 这一条是整条链路的验收闸门：清单拿得到、请求发得出去、流能回来、工具调用能被
 * 翻译成块。夹具（`tests/fixtures/workbuddy-stream.sse.txt`）就是照它抓的。
 */

import { describe, expect, it } from 'vitest'
import { credentialFilePath, readStoredCredential } from '../src/workbuddy/credential.ts'
import { fetchModels } from '../src/workbuddy/models.ts'
import { streamWorkBuddy } from '../src/workbuddy/chat.ts'
import type { WorkBuddyStreamChunk } from '../src/workbuddy/sse.ts'

const LIVE = process.env['WORKBUDDY_LIVE'] === '1'

/** 真机上的默认模型：这一行白名单里的第一个（hy4free 不扣积分）。 */
const MODEL = process.env['WORKBUDDY_LIVE_MODEL'] ?? 'hy4free'

describe.skipIf(!LIVE)('真机：WorkBuddy', () => {
  it('清单拿得到，模型请求能回来', async () => {
    const credential = await readStoredCredential(credentialFilePath())
    expect(credential, '本机还没登录 WorkBuddy：先在设置里登录一次').toBeDefined()

    const models = await fetchModels({ credential: credential! })
    expect(models.length).toBeGreaterThan(0)

    const chunks: WorkBuddyStreamChunk[] = []
    for await (const chunk of streamWorkBuddy({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: '回复两个字：好' }] }],
      accessToken: credential!.accessToken,
      ...(credential!.account === undefined ? {} : { account: credential!.account }),
    })) {
      chunks.push(chunk)
    }

    const text = chunks
      .filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    expect(text.length, '一次回合一个文本块都没回来').toBeGreaterThan(0)
    expect(chunks[chunks.length - 1]?.type).toBe('finish')
  }, 120_000)
})
