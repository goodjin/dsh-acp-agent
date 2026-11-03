/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的测试替身。
 *
 * 那个包只在浏览器包里装得上（它的依赖不在本仓库的 node 依赖图里），在 node 里
 * import 会因缺 `clsx` 让整条测试文件都起不来——于是任何想测浏览器模块的用例都
 * 进不去。这里只给出会画到的几个图标，形状够 React 识别即可；真实图标由构建产物
 * 决定，测试只关心结构与文案。
 */

import type { ReactNode } from 'react'

/** 一个什么都不渲染的图标组件。 */
function icon(): (props: { size?: number }) => ReactNode {
  return () => null
}

export const IconDatabaseOutlineRegular = icon()
export const IconGaugeOutlineRegular = icon()
export const IconWarningOutlineRegular = icon()
