/**
 * 档位折叠：把同一 base 的多个强度档并成一条，并把强度收进独立的轴。
 *
 * 「强度是自己的选择」和「不出现重复模型」要同时成立：一个以 `base[low]`…
 * `base[ultra]` 发布的模型并成一条 `base`，把每个强度收进来，于是选择器只显示
 * 这个模型一次、强度作为单独的轴（宿主的选择器只在模型给出 `reasoning.efforts`
 * 时才渲染强度的子控件）。裸 id 的模型原样返回——不臆造强度，也不并出重复行。
 */

import type { CatalogEffort, CatalogModel } from './types.ts'

/** 折叠后的一条 base 模型：base id、显示名、声明的描述、以及它提供的强度（没有就是 undefined）。 */
export type CollapsedModel = {
  /** 剥掉 `[effort]` 后缀的 base wire id。 */
  readonly baseId: string
  /** 这一条 base 的显示名。 */
  readonly displayName: string
  /** agent 报上来的声明描述，没有就是 undefined。 */
  readonly description?: string
  /** 这个模型提供的强度（wire 值），agent 只发裸 id 时是 undefined。 */
  readonly efforts: readonly string[] | undefined
}

/**
 * 强度的显示名：只写强度本身，不重复模型名。
 * @param effort - `[suffix]` 里的原始写法。
 * @returns 只含强度本身的标签。
 */
export function effortLabelOf(effort: string): string {
  const known: Record<string, string> = {
    none: 'None',
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'xHigh',
    max: 'Max',
    ultra: 'Ultra',
  }
  const normalized = effort.trim().toLowerCase()
  const label = known[normalized]
  if (label !== undefined) return label
  return normalized === '' ? effort : `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
}

/**
 * 把模型 id 拆成 base 与强度后缀。
 *
 * 有些 agent 按强度一个模型发一条 `base[effort]`；另一些只发裸 id。带后缀的拆出
 * base 与 effort，裸 id 返回 undefined，调用方据此并条而不必假设固定的强度词表。
 */
function splitEffort(id: string): { base: string; effort: string } | undefined {
  const open = id.lastIndexOf('[')
  if (open === -1 || !id.endsWith(']')) return undefined
  const base = id.slice(0, open)
  const effort = id.slice(open + 1, -1)
  if (base === '' || effort === '' || effort.includes(']') || effort.includes('[')) return undefined
  return { base, effort }
}

/** 从带 ` (effort)` 后缀的显示名里剥出 base 模型的标签。 */
function baseName(name: string, effort: string): string {
  const suffix = `(${effort})`
  return name.endsWith(suffix) ? name.slice(0, -suffix.length).trim() : name
}

/**
 * 把同 base 的模型并成一条，收进各自的强度。
 * @param models - 一行 agent 提供的模型，可能带 `[effort]` 后缀。
 * @returns 每个 base 一条，首次出现的顺序；裸 id 按显示名并条。
 */
export function collapseEffortModels(models: readonly { id: string; name: string; description?: string }[]): CollapsedModel[] {
  const order: string[] = []
  const byBase = new Map<string, { wireId?: string; displayName: string; description?: string; count: number; efforts: string[] }>()
  for (const model of models) {
    const split = splitEffort(model.id)
    if (split === undefined) {
      // 裸 id 的行：按显示名并条，而不是 wire id。
      const existing = byBase.get(model.name)
      if (existing === undefined) {
        order.push(model.name)
        byBase.set(model.name, { wireId: model.id, displayName: model.name, count: 1, ...(model.description === undefined ? {} : { description: model.description }), efforts: [] })
      } else {
        existing.count += 1
        if (existing.description === undefined && model.description !== undefined) existing.description = model.description
      }
      continue
    }
    const existing = byBase.get(split.base)
    if (existing === undefined) {
      order.push(split.base)
      byBase.set(split.base, { displayName: baseName(model.name, split.effort), ...(model.description === undefined ? {} : { description: model.description }), count: 1, efforts: [split.effort] })
      continue
    }
    existing.count += 1
    if (existing.description === undefined && model.description !== undefined) existing.description = model.description
    if (!existing.efforts.includes(split.effort)) existing.efforts.push(split.effort)
  }
  return order.map(base => {
    const entry = byBase.get(base) as { wireId?: string; displayName: string; description?: string; count: number; efforts: string[] }
    // 裸 id 行带真 wire id；带后缀的行用剥掉后缀的 base id。
    return {
      baseId: entry.wireId ?? base,
      displayName: entry.displayName,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      // 裸 id 行没有强度（efforts 停在 []）；带后缀的行把收集到的强度并出去。
      efforts: entry.efforts.length === 0 ? undefined : entry.efforts,
    }
  })
}

/**
 * 一个强度档（reasoning effort）在目录里怎么显示。
 */
export type DeclaredEffort = { readonly id: string; readonly name?: string }

/**
 * 把一条折叠后的 base 模型转成目录里发布的模型。
 *
 * 强度来源有两条：模型 id 里归并出来的（`base[effort]`），或者行声明的。前者
 * 优先——它带着 wire id。任一来源都没有就不给强度轴。
 *
 * 行声明的强度可以带自定义显示名（`name`）；带了就用它，没带才回退到
 * {@link effortLabelOf}。模型 id 归并出来的强度只带 wire 值，标签一律现算。
 * @param provider - 目标 provider 路由。
 * @param model - 折叠后的一条 base。
 * @param declaredEfforts - 行声明的强度，仅在模型本身没带强度时兜底。
 * @returns 目录里发布的模型。
 */
export function collapsedToCatalog(
  provider: string,
  model: CollapsedModel,
  declaredEfforts?: readonly DeclaredEffort[],
): CatalogModel {
  const source: CatalogEffort[] | undefined = model.efforts !== undefined
    ? model.efforts.map(id => ({ id, name: effortLabelOf(id) }))
    : declaredEfforts?.map(effort => ({ id: effort.id, name: effort.name ?? effortLabelOf(effort.id) }))
  const efforts = source === undefined || source.length === 0 ? undefined : source
  return {
    provider,
    id: model.baseId,
    name: model.displayName,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(efforts === undefined ? {} : { reasoning: { efforts } }),
  }
}
