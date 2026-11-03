/**
 * 「去授权」那一枚的纯逻辑与画法。
 *
 * 单独成一个模块，是因为 `quota-pill.ts` 依赖 `@deepseek-ai/dsh-client-ui-primitives`
 * （浏览器包里才装得上 `clsx` 等依赖），在 node 里 import 不了，测试也就进不去。
 * 这里只引 react，宿主应答的解析、相等比较与元素形状都能直接在单测里断言。
 *
 * 令牌永远不在这份数据里：宿主只回地址与用户码。
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'

/** 登录过期时宿主给的授权信息（只含地址与用户码，不含任何令牌）。 */
export type QuotaLoginOffer = {
  readonly url: string
  /** 设备授权码；用户可能需要在网页里手输。 */
  readonly userCode?: string
  /** 这条地址的有效秒数。 */
  readonly expiresInSec?: number
}

/** 文案座位：与插件其余部分同一个 `t`。 */
export type LoginChipT = (key: string, params?: Record<string, string | number>) => string

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只放行 http(s)：宿主给的地址也不该把别家 scheme 塞进 `<a href>`。 */
function hrefOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const base = typeof window === 'undefined' ? 'http://localhost' : window.location.href
    const { protocol } = new URL(value, base)
    return protocol === 'https:' || protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

/**
 * 从宿主应答里取「去授权」信息。
 *
 * 只在 `needsLogin === true` 时认；地址不合规、形状不对都当没有——普通网络故障
 * 不该被画成「该去授权」。
 * @param body - 宿主路由的 JSON 应答。
 * @returns 授权信息，或 undefined。
 */
export function loginOfferOfBody(body: Record<string, unknown>): QuotaLoginOffer | undefined {
  if (body['needsLogin'] !== true) return undefined
  const raw = body['login']
  if (!isRecord(raw)) return undefined
  const url = hrefOf(raw['url'])
  if (url === null) return undefined
  const userCode = typeof raw['userCode'] === 'string' && raw['userCode'] !== '' ? raw['userCode'] : undefined
  const expiresInSec = typeof raw['expiresInSec'] === 'number' && Number.isFinite(raw['expiresInSec'])
    ? raw['expiresInSec']
    : undefined
  return {
    url,
    ...(userCode === undefined ? {} : { userCode }),
    ...(expiresInSec === undefined ? {} : { expiresInSec }),
  }
}

/**
 * 两条授权信息是否等价（只比地址与用户码——有效期变短不该让这一枚重画）。
 * @param left - 旧值。
 * @param right - 新值。
 * @returns 是否等价。
 */
export function sameLoginOffer(left: QuotaLoginOffer | undefined, right: QuotaLoginOffer | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.url === right.url && left.userCode === right.userCode
}

/**
 * 画「去授权」那一行：一句说明 + 一个链接，带授权码时一并写出来。
 *
 * 链接是普通 `<a target="_blank">`：桌面外壳把 `_blank` 交给系统浏览器，网页里由
 * DSH 的链接路由处理——与文件卡片里的链接同一条路，不自己开窗。
 * @param login - 授权信息。
 * @param t - 文案座位。
 * @param options - 图标与 data-* 名前缀（各家用自己的口径标记）。
 * @returns 这一行元素。
 */
export function loginChipOf(
  login: QuotaLoginOffer,
  t: LoginChipT,
  options: { readonly provider?: string; readonly icon?: ReactNode } = {},
): ReactNode {
  const provider = options.provider ?? 'quota'
  return createElement('div', {
    'data-quota-login': true,
    [`data-${provider}-quota-login`]: true,
    title: t('quota.login.title'),
    style: {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      gap: '8px',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      color: 'var(--dsw-alias-label-tertiary)',
    },
  },
    ...(options.icon === undefined ? [] : [options.icon]),
    createElement('span', null, t('quota.login.title')),
    createElement('a', {
      href: login.url,
      target: '_blank',
      rel: 'noreferrer noopener',
      'data-quota-login-link': true,
      style: { color: 'var(--dsw-alias-brand-primary, inherit)', textDecoration: 'underline' },
    }, t('quota.login.cta')),
    ...(login.userCode === undefined ? [] : [
      createElement('code', { key: 'code', 'data-quota-login-code': true }, t('quota.login.code', { code: login.userCode })),
    ]),
  )
}
