/**
 * 宿主侧路由入口要的那点上下文。
 *
 * 登录/模型清单这类路由要 effect 挂清理、webServer 注册、connection 收人——这三样
 * 凑齐就够开一条 exact 路由。它不分厂商：谁的登录行来要都行，名字里别写死某一家。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface RouteContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
    }): (() => void) | void
  }
  connection: {
    admit(request: IncomingMessage): { rejection: number } | { peer: unknown }
  }
}
