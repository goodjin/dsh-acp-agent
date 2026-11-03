/**
 * MiniMax 积分（余额）的取数口径。
 *
 * 2026-11 现场：胶囊上的积分一直是 0，而这台机器明明还有两万两千积分。
 * 真机探针（2026-11-03，cn/prod 登录）把上游三份应答都取了下来：
 *
 * - 个人工作区 `get_user_extra_info`：`total_remains_credit: 0`（旧字段，迁到
 *   开放平台计费后一直是 0），但同时带着 `opcredit_balance: 22000`；
 * - 会员应答 `get_membership_info`：`total_remains_credit: 22000`、
 *   `opcredit_balance: 22000`，以及 `op_credit_summary.total_remaining_amount:
 *   "22000"`——**是字符串**，不是数字；
 * - 开放平台 `coding_plan/remains`：只有窗口，没有积分。
 *
 * 我们读错在两处：
 *
 * 1. 数字解析只认 number，上游改成字符串后 `total_remaining_amount` 直接被丢掉；
 * 2. 个人工作区的旧字段 `total_remains_credit` 是 0，而它是「合法的 0」，
 *    把会员应答里真正的余额短路掉了（`??` 不会往后走）。
 *
 * 桌面版 MiniMax Code 自己的投影（app.asar 里的取余额那段）是：先取会员应答的
 * `op_credit_summary.total_remaining_amount`（字符串按数字解析），再退到
 * `opcredit_balance`。这里照它来。
 */

import { describe, expect, it } from 'vitest'
import { fetchMiniMaxQuota } from '../src/minimaxi/quota.ts'
import type { MiniMaxCredential } from '../src/minimaxi/index.ts'

const CREDENTIAL: MiniMaxCredential = {
  accessToken: 'test-access-token',
  expiresAtMs: Date.now() + 3_600_000,
  region: 'cn',
  buildEnv: 'prod',
  baseUrl: 'https://api.minimax.test/anthropic',
}

/** 一份与真机同形的上游应答（2026-11-03 cn/prod 实测）。 */
function upstream(overrides: {
  personal?: Record<string, unknown>
  membership?: Record<string, unknown>
} = {}): typeof fetch {
  const personal = {
    workspace_id: 0,
    workspace_type: 0,
    total_remains_credit: 0,
    op_group_id: '1999459129545986565',
    opcredit_balance: 22000,
    has_token_plan: true,
    token_plan_tier: 'Max',
    ...overrides.personal,
  }
  const membership = {
    total_remains_credit: 22000,
    opcredit_balance: 22000,
    has_token_plan: true,
    token_plan_tier: 'Max',
    op_credit_summary: {
      total_remaining_amount: '22000',
      purchased_remaining_amount: '22000',
      free_remaining_amount: '0',
    },
    ...overrides.membership,
  }
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
    if (url.includes('/v1/api/user/info')) {
      return json({ data: { userInfo: { realUserID: 'u-1' } } })
    }
    if (url.includes('/matrix/api/v1/user/get_user_extra_info')) {
      return json({ data: { workspaces: [personal] } })
    }
    if (url.includes('/matrix/api/v1/commerce/get_membership_info')) {
      return json({ data: membership })
    }
    if (url.includes('/coding_plan/remains')) {
      return json({
        data: {
          model_remains: [{
            model_name: 'general',
            current_interval_status: 1,
            current_interval_remaining_percent: 11,
            current_weekly_status: 3,
            current_weekly_remaining_percent: 100,
          }],
        },
      })
    }
    return new Response('unexpected', { status: 404 })
  }) as unknown as typeof fetch
}

describe('MiniMax 积分取数', () => {
  it('会员应答里的字符串余额被读成数字', async () => {
    const quota = await fetchMiniMaxQuota({ credential: CREDENTIAL, fetchImpl: upstream() })
    expect(quota?.credit?.remaining).toBe(22000)
  })

  it('个人工作区的旧字段是 0 时，不把真正的余额短路掉', async () => {
    const quota = await fetchMiniMaxQuota({
      credential: CREDENTIAL,
      fetchImpl: upstream({ personal: { total_remains_credit: 0, opcredit_balance: 22000 } }),
    })
    expect(quota?.credit?.remaining).toBe(22000)
  })

  it('会员应答缺 summary 时，退到 opcredit_balance', async () => {
    const quota = await fetchMiniMaxQuota({
      credential: CREDENTIAL,
      fetchImpl: upstream({ membership: { op_credit_summary: undefined, opcredit_balance: 22000 } }),
    })
    expect(quota?.credit?.remaining).toBe(22000)
  })

  it('带千分位的字符串余额也读得出来', async () => {
    const quota = await fetchMiniMaxQuota({
      credential: CREDENTIAL,
      fetchImpl: upstream({ membership: { op_credit_summary: { total_remaining_amount: '32,500' } } }),
    })
    expect(quota?.credit?.remaining).toBe(32500)
  })

  it('会员应答完全没有积分字段时，用工作区的 opcredit_balance', async () => {
    const quota = await fetchMiniMaxQuota({
      credential: CREDENTIAL,
      fetchImpl: upstream({
        membership: { op_credit_summary: undefined, opcredit_balance: undefined, total_remains_credit: undefined },
        personal: { total_remains_credit: 0, opcredit_balance: 22000 },
      }),
    })
    expect(quota?.credit?.remaining).toBe(22000)
  })
})
