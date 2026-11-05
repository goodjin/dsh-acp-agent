/**
 * 设置里的「WorkBuddy 模型」勾选界面。
 *
 * 这里钉住：整份清单都要列出来（勾掉的也得看得见，否则站点上新了模型就再也找不
 * 回来）、勾选状态要跟宿主给的一致、勾一下要存回去、不能带工具的模型要标出来。
 */

import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import {
  filterModels,
  readWorkBuddyModels,
  saveWorkBuddySelection,
  WORKBUDDY_MODELS_SECTION_ID,
  workBuddyModelsView,
} from '../src/client/workbuddy-models-section.tsx'
import type { WorkBuddyModelList } from '../src/client/workbuddy-models-section.tsx'

/** 在元素树里找第一个满足条件的节点。 */
function find(node: unknown, match: (props: Record<string, unknown>) => boolean): ReactElement | undefined {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const element = node as ReactElement & { props?: Record<string, unknown> }
  if (element.props !== undefined && match(element.props)) return element
  return find(element.props?.children, match)
}

/** 按顺序收元素树里的文本。 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return textOf((node as { props?: { children?: unknown } }).props?.children)
}

const LIST: WorkBuddyModelList = {
  models: [
    { id: 'glm-5.3', name: 'GLM-5.3', description: '旗舰（积分 x0.69）', credits: 'x0.69', supportsToolCall: true },
    { id: 'hy4free', name: 'Hy4', credits: 'x0.00', supportsToolCall: true },
    { id: 'kling-video-v3', name: 'Kling-Video-V3', supportsToolCall: false },
  ],
  selected: ['glm-5.3'],
  custom: false,
  default: ['glm-5.3', 'hy4free'],
}

describe('问宿主', () => {
  it('拿的是整份清单与当前勾选', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({
        ok: true,
        models: LIST.models,
        selected: ['glm-5.3'],
        custom: false,
      }), { status: 200 })
    }) as unknown as typeof fetch

    const list = await readWorkBuddyModels({ fetchImpl })
    expect(calls[0]).toContain('/acp-agent/workbuddy/models')
    expect(list.models).toHaveLength(3)
    expect(list.selected).toEqual(['glm-5.3'])
    expect(list.custom).toBe(false)
  })

  it('存勾选结果时把 id 一起发过去', async () => {
    const bodies: unknown[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true, selected: ['a'] }), { status: 200 })
    }) as unknown as typeof fetch

    await saveWorkBuddySelection(['a', 'b'], { fetchImpl })
    expect(bodies).toEqual([{ ids: ['a', 'b'] }])
  })
})

describe('勾选界面', () => {
  it('整份清单都列出来：勾掉的也看得见', () => {
    const view = workBuddyModelsView({ list: LIST })
    for (const id of ['glm-5.3', 'hy4free', 'kling-video-v3']) {
      expect(find(view, props => props['data-workbuddy-model'] === id)).toBeDefined()
    }
  })

  it('勾选状态跟宿主给的一致', () => {
    const view = workBuddyModelsView({ list: LIST })
    const checked = find(view, props => props['data-workbuddy-model'] === 'glm-5.3')
    expect(checked?.props?.checked).toBe(true)
    const unchecked = find(view, props => props['data-workbuddy-model'] === 'hy4free')
    expect(unchecked?.props?.checked).toBe(false)
  })

  it('倍率与「不能带工具」都标出来', () => {
    const view = workBuddyModelsView({ list: LIST })
    expect(find(view, props => props['data-workbuddy-model-credits'] === true)).toBeDefined()
    expect(find(view, props => props['data-workbuddy-model-notool'] === true)).toBeDefined()
  })

  it('没自己勾过时说明「用的是默认那一份」，勾过就说明已自定义', () => {
    expect(textOf(workBuddyModelsView({ list: LIST }))).toContain('默认')
    const custom = workBuddyModelsView({ list: { ...LIST, custom: true } })
    expect(find(custom, props => props['data-workbuddy-models-custom'] === true)).toBeDefined()
  })

  it('勾一下把新的勾选发出去', () => {
    const toggled: { id: string; checked: boolean }[] = []
    const view = workBuddyModelsView({
      list: LIST,
      onToggle: (id, checked) => { toggled.push({ id, checked }) },
    })
    const box = find(view, props => props['data-workbuddy-model'] === 'hy4free')
    const onChange = box?.props?.onChange as ((event: { target: { checked: boolean } }) => void) | undefined
    onChange?.({ target: { checked: true } })
    expect(toggled).toEqual([{ id: 'hy4free', checked: true }])
  })

  it('有搜索框：输入的词传给外面', () => {
    const queries: string[] = []
    const view = workBuddyModelsView({
      list: LIST,
      onQueryChange: (value: string) => { queries.push(value) },
    })
    const box = find(view, props => props['data-workbuddy-models-search'] === true)
    expect(box).toBeDefined()
    const onChange = box?.props?.onChange as ((event: { target: { value: string } }) => void) | undefined
    onChange?.({ target: { value: 'glm' } })
    expect(queries).toEqual(['glm'])
  })

  it('按搜索词过滤：名字、id、倍率、描述都算', () => {
    expect(filterModels(LIST.models, 'glm').map(model => model.id)).toEqual(['glm-5.3'])
    expect(filterModels(LIST.models, 'Kling').map(model => model.id)).toEqual(['kling-video-v3'])
    expect(filterModels(LIST.models, 'x0.00').map(model => model.id)).toEqual(['hy4free'])
    expect(filterModels(LIST.models, '旗舰').map(model => model.id)).toEqual(['glm-5.3'])
    expect(filterModels(LIST.models, '  ').map(model => model.id)).toHaveLength(3)
  })

  it('搜索时列表里只剩匹配的那些', () => {
    const view = workBuddyModelsView({ list: LIST, query: 'hy4' })
    expect(find(view, props => props['data-workbuddy-model'] === 'hy4free')).toBeDefined()
    expect(find(view, props => props['data-workbuddy-model'] === 'glm-5.3')).toBeUndefined()
  })

  it('倍率是胶囊：圆角、小间距、数字等宽', () => {
    const view = workBuddyModelsView({ list: LIST })
    const pill = find(view, props => props['data-workbuddy-model-credits'] === true)
    const style = pill?.props?.style as Record<string, unknown> | undefined
    expect(style?.['borderRadius']).toBe('999px')
    expect(style?.['fontVariantNumeric']).toBe('tabular-nums')
    expect(style?.['display']).toBe('inline-flex')
  })

  it('行 id 是约定的那个', () => {
    expect(WORKBUDDY_MODELS_SECTION_ID).toBe('acp-agent-workbuddy-models')
  })
})
