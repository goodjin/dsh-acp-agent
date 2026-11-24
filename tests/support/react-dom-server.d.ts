/**
 * react-dom/server 的最小声明：渲染设置段做接线冒烟时只用到 renderToString。
 * devDependencies 没挂 @types/react-dom（构建产物不进浏览器 DOM 树），这里
 * 按测试用到的面声明，类型别全开。
 */

declare module 'react-dom/server' {
  export function renderToString(element: unknown): string
}
