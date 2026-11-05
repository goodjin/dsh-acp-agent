/**
 * provider 路由命名。
 *
 * 一条模型行对应宿主目录里的一个 provider，路由 id 是 `acp:<行 id>`——由预设 id
 * 派生而非存下来，所以跨调用稳定、且能把预设 id 自己带回来。
 */

const ROUTE_PREFIX = 'acp:'

/**
 * 一个预设对应的 provider 路由。
 * @param presetId - 行 id。
 * @returns `acp:<行 id>` 形态的路由。
 */
export function providerRoute(presetId: string): string {
  return `${ROUTE_PREFIX}${presetId}`
}

/**
 * 一条路由所代表的预设，非 acp 路由返回 `undefined`。
 * @param route - provider 路由。
 * @returns 行 id 或 undefined。
 */
export function presetOfRoute(route: string): string | undefined {
  return route.startsWith(ROUTE_PREFIX) ? route.slice(ROUTE_PREFIX.length) : undefined
}
