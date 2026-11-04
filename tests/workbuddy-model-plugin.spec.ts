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
}

const captured: Captured = {}
let modelListFails = false
/** 记下写进账本的东西；放在盒子里是因为控制流分析看不见回调里的赋值。 */
const state: { recorded?: { presetId: string; models: readonly { id: string; name: string }[] } } = {}

/** 读账本；走函数是为了绕开控制流分析对属性收窄（回调里的赋值它看不见）。 */
function recordedNow(): { presetId: string; models: readonly { id: string; name: string }[] } | undefined {
  return state.recorded
}

vi.mock('../src/workbuddy/index.ts', () => ({
  credentialResolver: () => async () => ({ accessToken: 'ACCESS', account: { uid: 'uid-1' } }),
  forceRefreshCredential: async () => ({ accessToken: 'ACCESS-2', account: { uid: 'uid-1' } }),
  fetchModels: async () => {
    if (modelListFails) throw new Error('no model list')
    return [{ id: 'auto', name: 'Auto' }, { id: 'fast-model', name: '快速' }]
  },
  streamWorkBuddy: (request: Captured) => {
    captured.model = request.model
    captured.messages = request.messages
    captured.accessToken = request.accessToken
    captured.account = request.account
    return (async function* noChunks(): AsyncGenerator<never> { /* 请求的形状才是这里的主体 */ })()
  },
}))

const { workBuddyModelStream } = await import('../src/workbuddy-model.ts')
const { modelPluginStream } = await import('../src/model-plugins.ts')

const config = {
  presets: {
    'acp-workbuddy': { agent: 'workbuddy', models: [{ id: 'auto', name: 'Auto' }] },
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

describe('运行时模型清单', () => {
  it('拉到的清单写进目录的账本', async () => {
    state.recorded = undefined
    const stream = modelPluginStream(config, {
      onRuntimeModels: (presetId, models) => { state.recorded = { presetId, models } },
    })
    await drain(stream('acp-workbuddy', request))
    expect(recordedNow()?.presetId).toBe('acp-workbuddy')
    expect(recordedNow()?.models.map(model => model.id)).toEqual(['auto', 'fast-model'])
  })

  it('拉不到清单不影响发消息', async () => {
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
