/**
 * 账号段共用的排版。
 *
 * 两家（WorkBuddy、Qoder 国际版）的账号段是同一件事：显示是谁、给两个按钮。
 * 排版规则也就一样，所以放在一处：
 * - 账号信息自己一个框，独占一行；
 * - 两个按钮一样大、留出间距、齐平；
 * - 元素之间都分开，不挨在一起。
 */

/** 竖排的一列：每件之间留出间距。 */
export const ACCOUNT_COLUMN_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
} as const

/** 账号信息那个框。 */
export const ACCOUNT_BOX_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-default, rgba(0,0,0,0.12))',
  borderRadius: '8px',
} as const

/** 一行按钮：间距 8px、居中对齐、可以换行。 */
export const ACCOUNT_ACTIONS_STYLE = {
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  flexWrap: 'wrap',
} as const

/** 按钮：两个一样大、一样高。 */
export const ACCOUNT_BUTTON_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  minHeight: '28px',
  padding: '3px 12px',
  borderRadius: '6px',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: '1.4',
  whiteSpace: 'nowrap',
} as const
