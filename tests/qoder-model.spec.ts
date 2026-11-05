/**
 * Qoder 国际版这一行怎么在 DSH 的循环里应答。
 *
 * 它是**模型行**：不拉起任何进程，DSH 自己的循环、工具、审批、取消都照旧，只把
 * 「向模型要下一句话」换成 Qoder 国际版账号下的模型。这一层钉的是：
 * - 只有 `qoder-global` 这一行被认下来（CN 版的 `qoder` 行照旧走 CLI）；
 * - 登录后拉到的模型清单写进目录的账本（选择器以运行时清单为准）；
 * - 清单拉不到不影响发消息，而且不会每一轮都去撞一次上游；
 * - 模型不支持的推理档位不下发。
 */

import { describe, expect, it, vi } from 'vitest'
import type { PresetConfig } from '../src/registry.ts'

interface Captured {
  model?: string
  reasoningEffort?: string
  messages?: readonly unknown[]
  maxTokensField?: string
}

const captured: Captured = {}
let fetches = 0
let modelListFails = false
/** 记下写进账本的东西；放在盒子里是因为控制流分析看不见回调里的赋值。 */
const state: { recorded?: { presetId: string; models: readonly { id: string; name: string }[] } } = {}

/** 读账本；走函数是为了绕开控制流分析对属性收窄（回调里的赋值它看不见）。 */
function recordedNow(): { presetId: string; models: readonly { id: string; name: string }[] } | undefined {
  return state.recorded
}

// 测试不该依赖本机真实的勾选文件（~/.dsh/*/selection.json）：钉死成「没勾过」。
vi.mock('../src/model-selection.ts', () => ({
  readSelection: async () => undefined,
  writeSelection: async () => {},
  clearSelection: async () => {},
  selectionFilePath: () => '/tmp/qoder-test-selection.json',
}))

vi.mock('../src/qoder/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/qoder/index.ts')>()
  return {
    ...actual,
    resolveCredential: async () => ({ accessToken: 'ACCESS', machineId: 'mid' }),
    fetchModels: async () => {
      fetches += 1
      if (modelListFails) throw new Error('no model list')
      return [{ id: 'auto', name: 'Qwen 3.8 Max', efforts: ['low', 'high'] }]
    },
    streamQoder: (request: Captured, deps: { maxTokensField?: string }) => {
      captured.model = request.model
      captured.reasoningEffort = typeof request.reasoningEffort === 'string' ? request.reasoningEffort : undefined
      captured.messages = request.messages
      captured.maxTokensField = deps.maxTokensField
      return (async function* noChunks(): AsyncGenerator<never> { /* 请求的形状才是这里的主体 */ })()
    },
  }
})

const { qoderModelStream } = await import('../src/qoder-model.ts')
const { modelPluginStream, isModelBackedAgent } = await import('../src/model-plugins.ts')

const config = {
  presets: {
    // 清单缓存按 preset 记，所以这两条各用各的 id。
    global: { agent: 'qoder-global', models: [{ id: 'auto', name: 'Auto' }] },
    global2: { agent: 'qoder-global', models: [{ id: 'auto', name: 'Qwen 3.8 Max' }] },
    global4: { agent: 'qoder-global', models: [{ id: 'auto', name: 'Auto' }] },
    global3: { agent: 'qoder-global', models: [{ id: 'auto', name: 'Auto' }] },
    cn: { agent: 'qoder', models: [{ id: 'auto', name: 'Qwen 3.8 Max' }] },
  },
} as unknown as PresetConfig

const request = {
  provider: 'acp:global',
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  tools: [],
}

async function drain(stream: AsyncIterable<unknown> | undefined): Promise<void> {
  if (stream === undefined) return
  for await (const _ of stream) { /* 形状在别处断言 */ }
}

describe('Qoder 国际版的模型行', () => {
  it('只认 qoder-global 这一行，CN 版那行不动', () => {
    expect(isModelBackedAgent('qoder-global')).toBe(true)
    expect(isModelBackedAgent('qoder')).toBe(false)
    const stream = modelPluginStream(config)
    expect(stream('global', request)).toBeDefined()
    expect(stream('cn', request)).toBeUndefined()
  })

  it('把这一轮的历史原样发给模型', async () => {
    await drain(modelPluginStream(config)('global', request))
    expect(captured.messages).toEqual(request.messages)
    expect(captured.model).toBe('auto')
  })

  it('拉到清单后写进目录的账本', async () => {
    const reports: { presetId: string; models: readonly { id: string; name: string }[] }[] = []
    const stream = qoderModelStream(config, { onRuntimeModels: (presetId, models) => { reports.push({ presetId, models }) } })
    await drain(stream('global2', request))
    expect(reports).toHaveLength(1)
    expect(reports[0]?.presetId).toBe('global2')
    expect(reports[0]?.models.map(model => model.id)).toEqual(['auto'])
  })

  it('这一行只提供声明过的模型（白名单）：站点清单里没声明的不进账本', async () => {
    const reports: { presetId: string; models: readonly { id: string; name: string }[] }[] = []
    const stream = qoderModelStream(config, { onRuntimeModels: (presetId, models) => { reports.push({ presetId, models }) } })
    await drain(stream('global4', request))
    expect(reports[0]?.models.map(model => model.id)).toEqual(['auto'])
  })

  it('清单拉不到不影响发消息，但也不会每轮都去撞一次上游', async () => {
    modelListFails = true
    const before = fetches
    const stream = qoderModelStream(config)
    await drain(stream('global3', request))
    await drain(stream('global3', request))
    expect(fetches - before).toBe(1)
    modelListFails = false
  })

  it('清单还没拉到时，内置模型也用对最大 token 字段名', async () => {
    modelListFails = true
    const stream = qoderModelStream(config)
    await drain(stream('global3', { ...request, model: 'auto' } as never))
    expect(captured.maxTokensField).toBe('max_completion_tokens')
    modelListFails = false
  })

  it('模型不支持的推理档位不下发，模型支持的原样发', async () => {
    const stream = qoderModelStream(config)
    await drain(stream('global', { ...request, reasoningEffort: 'medium' } as never))
    expect(captured.reasoningEffort).toBeUndefined()
    await drain(stream('global', { ...request, reasoningEffort: 'high' } as never))
    expect(captured.reasoningEffort).toBe('high')
  })
})
