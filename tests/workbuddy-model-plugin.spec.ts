/**
 * WorkBuddy 这一行怎么在 DSH 的循环里应答。
 *
 * 它是**模型插件**：不拉起任何进程，DSH 自己的循环、工具、审批、取消都照旧，只把
 * 「向模型要下一句话」换成 WorkBuddy 账号下的模型。所以这一层钉的是：
 * - 只有 WorkBuddy 这一行被认下来（别的行照旧走网关）；
 * - 发给模型的历史里，工具调用与工具结果是配对的（不配对会被上游拒）；
 * - 登录后拉到的模型清单写进目录的账本（选择器以运行时清单为准），拉不到也不影响
 *   发消息（兜底清单还在）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { PresetConfig } from '../src/registry.ts'

interface Captured {
  model?: string
  messages?: readonly unknown[]
  accessToken?: string
  account?: { uid: string }
  chatUrl?: string
}

const captured: Captured = {}
let modelListFails = false
let fetches = 0
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
  selectionFilePath: () => '/tmp/workbuddy-test-selection.json',
}))

vi.mock('../src/workbuddy/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workbuddy/index.ts')>()
  return {
    ...actual,
    credentialResolver: () => async () => ({ accessToken: 'ACCESS', account: { uid: 'uid-1' } }),
    forceRefreshCredential: async () => ({ accessToken: 'ACCESS-2', account: { uid: 'uid-1' } }),
    loadCatalog: async () => {
      fetches += 1
      if (modelListFails) throw new Error('no model list')
      return {
        models: [{ id: 'auto', name: 'Auto' }, { id: 'fast-model', name: '快速' }],
        endpoint: 'https://copilot.tencent.com',
        source: 'desktop',
      }
    },
    streamWorkBuddy: (request: Captured & { endpoints?: { chatUrl: string } }) => {
      captured.model = request.model
      captured.messages = request.messages
      captured.accessToken = request.accessToken
      captured.account = request.account
      captured.chatUrl = request.endpoints?.chatUrl
      return (async function* noChunks(): AsyncGenerator<never> { /* 请求的形状才是这里的主体 */ })()
    },
  }
})

const { invalidateWorkBuddyCatalog, mergeDeclaredModels, workBuddyModelStream } = await import('../src/workbuddy-model.ts')
const { modelPluginStream } = await import('../src/model-plugins.ts')

const config = {
  presets: {
    'acp-workbuddy': { agent: 'workbuddy', models: [{ id: 'auto', name: 'Auto' }] },
    'acp-workbuddy-selfhosted': { agent: 'workbuddy', baseUrl: 'https://wb.example.com', models: [{ id: 'auto', name: 'Auto' }] },
    // 清单缓存是按 preset 记的，所以这条用另一个 id：它有自己的一份缓存。
    'acp-workbuddy-fresh': { agent: 'workbuddy', models: [{ id: 'auto', name: 'Auto' }] },
    'acp-codex': { agent: 'codex', models: [{ id: 'gpt-5', name: 'gpt-5' }] },
  },
} as unknown as PresetConfig

const request = {
  provider: 'acp:acp-workbuddy',
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  tools: [],
}

/** 收齐一个流。 */
async function drain(stream: AsyncIterable<unknown> | undefined): Promise<void> {
  if (stream === undefined) return
  for await (const _ of stream) { /* 形状在别处断言 */ }
}

const role = (message: unknown): string => (message as { role: string }).role
const callId = (message: unknown): string => (message as { toolCallId: string }).toolCallId

describe('认领哪一行', () => {
  it('只认 WorkBuddy 那一行', () => {
    const stream = workBuddyModelStream(config)
    expect(stream('acp-workbuddy', request)).toBeDefined()
    expect(stream('acp-codex', request)).toBeUndefined()
    expect(stream('nope', request)).toBeUndefined()
  })

  it('模型插件这一层把 WorkBuddy 也认下来', () => {
    expect(modelPluginStream(config)('acp-workbuddy', request)).toBeDefined()
    expect(modelPluginStream(config)('acp-codex', request)).toBeUndefined()
  })

  it('把模型与凭据交给请求层', async () => {
    await drain(workBuddyModelStream(config)('acp-workbuddy', request))
    expect(captured.model).toBe('auto')
    expect(captured.accessToken).toBe('ACCESS')
    expect(captured.account).toEqual({ uid: 'uid-1' })
  })
})

describe('历史里的工具调用', () => {
  it('工具调用与工具结果重新配对', async () => {
    const drifted = [
      { role: 'user', content: [{ type: 'text', text: '开始' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-a', name: 'Bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'acp:acp-workbuddy', model: 'auto' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '我先做别的' }],
        source: { kind: 'model', provider: 'acp:acp-workbuddy', model: 'auto' },
      },
      { role: 'tool', toolCallId: 'call-a', content: [{ type: 'text', text: '结果' }] },
    ]
    await drain(modelPluginStream(config)('acp-workbuddy', { ...request, messages: drifted }))

    const messages = captured.messages ?? []
    // 结果要紧跟在调用后面：上游收到「调用、别的、结果」会直接拒。
    expect(messages.map(role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(callId(messages[2])).toBe('call-a')
  })
})

describe('白名单', () => {
  it('这一行只提供声明过的模型，站点给的那份只用来补名字与倍率', async () => {
    invalidateWorkBuddyCatalog()
    state.recorded = undefined
    const stream = modelPluginStream({
      presets: {
        'acp-workbuddy': {
          agent: 'workbuddy',
          models: [{ id: 'hy4free', name: 'Hy4' }, { id: 'glm-5.3', name: 'GLM-5.3' }],
        },
      },
    } as unknown as PresetConfig, {
      onRuntimeModels: (presetId, models) => { state.recorded = { presetId, models } },
    })
    await drain(stream('acp-workbuddy', request))
    expect(recordedNow()?.models.map(model => model.id)).toEqual(['hy4free', 'glm-5.3'])
  })

  it('声明里有的、站点清单里没有的，照样显示（按声明写的那份）', () => {
    const merged = mergeDeclaredModels(
      [{ id: 'hy4free', name: 'Hy4', description: '兜底描述' }],
      [{ id: 'other', name: '别的' }],
    )
    expect(merged).toEqual([{ id: 'hy4free', name: 'Hy4', description: '兜底描述' }])
  })

  it('同名的模型补上 id：选择器里分得出谁是谁', () => {
    const merged = mergeDeclaredModels(
      [{ id: 'hy4free', name: 'Hy4' }, { id: 'hy4std', name: 'Hy4' }],
      [{ id: 'hy4free', name: 'Hy4' }, { id: 'hy4std', name: 'Hy4' }],
    )
    expect(merged.map(model => model.name)).toEqual(['Hy4（hy4free）', 'Hy4（hy4std）'])
  })

  it('站点清单里的名字与倍率优先于声明里的', () => {
    const merged = mergeDeclaredModels(
      [{ id: 'hy4free', name: 'Hy4', description: '兜底描述' }],
      [{ id: 'hy4free', name: 'Hy4', description: '最新旗舰（积分 x0.00）' }],
    )
    expect(merged).toEqual([{ id: 'hy4free', name: 'Hy4', description: '最新旗舰（积分 x0.00）' }])
  })
})

describe('端点', () => {
  it('预置行里写的端点要真的生效（登录与模型同源，都从它派生）', async () => {
    await drain(workBuddyModelStream(config)('acp-workbuddy-selfhosted', request))
    expect(captured.chatUrl).toBe('https://wb.example.com/v2/chat/completions')
  })

  it('没写端点时用站点给的端点（清单与模型请求打同一个地方）', async () => {
    await drain(workBuddyModelStream(config)('acp-workbuddy', request))
    expect(captured.chatUrl).toBe('https://copilot.tencent.com/v2/chat/completions')
  })
})

describe('运行时模型清单', () => {
  it('拉到的清单写进目录的账本', async () => {
    invalidateWorkBuddyCatalog()
    state.recorded = undefined
    const stream = modelPluginStream(config, {
      onRuntimeModels: (presetId, models) => { state.recorded = { presetId, models } },
    })
    await drain(stream('acp-workbuddy', request))
    expect(recordedNow()?.presetId).toBe('acp-workbuddy')
    // 这一行声明了哪些模型，就只提供哪些；站点清单里没声明的那些不进账本。
    expect(recordedNow()?.models.map(model => model.id)).toEqual(['auto'])
  })

  it('拉不到清单时不要每一轮都去拉一次', async () => {
    invalidateWorkBuddyCatalog()
    state.recorded = undefined
    modelListFails = true
    fetches = 0
    const stream = modelPluginStream(config, {
      onRuntimeModels: (presetId, models) => { state.recorded = { presetId, models } },
    })
    await drain(stream('acp-workbuddy-fresh', request))
    await drain(stream('acp-workbuddy-fresh', request))
    // 第一次试过一次就记住失败，第二轮不再去撞上游。
    expect(fetches).toBe(1)
    modelListFails = false
  })

  it('拉不到清单不影响发消息', async () => {
    invalidateWorkBuddyCatalog()
    state.recorded = undefined
    modelListFails = true
    const stream = modelPluginStream(config, {
      onRuntimeModels: (presetId, models) => { state.recorded = { presetId, models } },
    })
    await drain(stream('acp-workbuddy', request))
    expect(recordedNow()).toBeUndefined()
    expect(captured.model).toBe('auto')
    modelListFails = false
  })
})
