/**
 * 模型行进出目录/流水的统一类型。
 *
 * 三家厂商的块（zcode/minimaxi/workbuddy）形状完全一致，只有块、usage、finish
 * 的字段类型按厂商不同，所以公共件只放一份统一类型；各插件在自己的流里把它
 * 归一化成这一份再交回宿主。
 */

/** 一个强度档（reasoning effort）在目录里怎么显示。 */
export type CatalogEffort = {
  /** 选择的 wire 值（模型 id 里 `[suffix]` 的那一段）。 */
  readonly id: string
  /** 人类标签（`Low`/`High`/`xHigh`…），不带模型名前缀。 */
  readonly name: string
}

/** 一个模型，如目录所发布。 */
export type CatalogModel = {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  /**
   * 这个模型提供的推理强度档，存在才带。宿主的选择器只在有这一项时把「强度」当
   * 独立的轴渲染（而不是每个强度一行）；缺席就是不给强度轴。
   */
  readonly reasoning?: { readonly efforts: readonly CatalogEffort[] }
}

/** 宿主一次模型请求带进来的字段（模型插件是「模型」，这些全都要用）。 */
export type ModelTurnRequest = {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: unknown
  readonly sessionId?: unknown
  readonly messages?: readonly unknown[]
  readonly purpose?: unknown
  readonly signal?: unknown
  readonly tools?: readonly { readonly name: string; readonly description?: string; readonly parameters?: Record<string, unknown> }[]
  readonly system?: unknown
  readonly maxTokens?: unknown
}

/**
 * 模型流可能吐出的块。
 *
 * 统一了文本/推理/工具调用三类增量，与宿主循环的 block 协议一一对应；`usage`
 * 报本次用量，`finish` 收尾。
 */
export type ModelStreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: 'text' | 'reasoning' | 'tool-call' }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: { readonly type: string; readonly [key: string]: unknown } }
  | { readonly type: 'usage'; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens?: number } }
  | { readonly type: 'finish'; readonly reason: { readonly kind: string; readonly [key: string]: unknown } }
