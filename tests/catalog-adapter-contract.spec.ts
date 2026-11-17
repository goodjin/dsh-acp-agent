/**
 * The contract between our catalog adapter and the host's LLM service.
 *
 * The host calls some adapter methods unconditionally: it asks every
 * registered adapter for its retry policy at registration time, and it asks
 * for the image pricing of a route while it measures a session's tokens. A
 * class-based adapter inherits the host's defaults for those; an object
 * adapter states them itself. An adapter that omits one does not lose that
 * one route — it takes down every route the host touches while measuring,
 * which is how a model switch dies as a TypeError before it even runs.
 */

import { describe, expect, it } from 'vitest'
import { catalogAdapter, providerRoute } from '../src/catalog.ts'
import { grokDialect } from '../src/index.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419', model: 'grok-4.7' },
  },
}

const modelsOf = () => [{ id: 'grok-4.7', name: 'Grok 4.7' }]

/** The adapter as the host sees it: the object it registered. */
const adapter = catalogAdapter(CONFIG, { modelsOf, dialectOf: () => grokDialect })

/** The methods the host calls without asking whether they exist. */
const HOST_CALLED = [
  'providerInfo',
  'providerRetryPolicy',
  'listModels',
  'resolveModel',
  'prepareCall',
  'stream',
  'imageRequestPricing',
  'imageRequestTarget',
] as const

describe('acp 目录适配器与宿主的契约', () => {
  it('宿主无条件调用的方法，适配器都得有', () => {
    const missing = HOST_CALLED.filter(name => typeof (adapter as unknown as Record<string, unknown>)[name] !== 'function')
    expect(missing).toEqual([])
  })

  it('图像计价：本路由不声明（undefined 即「没有」，宿主据此用自己的中性估算）', () => {
    const pricing = (adapter as unknown as { imageRequestPricing: (p: string, m: string) => unknown })
      .imageRequestPricing('acp:acp-grok', 'grok-4.7')
    expect(pricing).toBeUndefined()
  })

  it('图像投影：沿用宿主默认——尺寸与字节上限原样交出去', () => {
    const target = (adapter as unknown as {
      imageRequestTarget: (p: string, m: string, image: unknown) => unknown
    }).imageRequestTarget('acp:acp-grok', 'grok-4.7', { width: 640, height: 480, bytes: 4096 })
    expect(target).toEqual({ width: 640, height: 480, maxBytes: 4096 })
  })
})

describe('模型行的重试策略', () => {
  const ZCODE_CONFIG: PresetConfig = {
    presets: { 'acp-zcode': { agent: 'zcode', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] } },
  }
  const DEPS = { modelsOf: () => [{ id: 'glm-5.3', name: 'GLM 5.3' }], dialectOf: () => undefined }
  const zcodeAdapter = catalogAdapter(ZCODE_CONFIG, DEPS)
  const externalAdapter = catalogAdapter({
    presets: { 'acp-claude': { agent: 'claude', command: 'claude-agent-acp' } },
  }, DEPS)

  it('zcode 路由交出有界策略：SERVER/TRANSPORT/TIMEOUT/RATE_LIMIT 可重试，5s 起步 4 次封顶', () => {
    const policy = zcodeAdapter.providerRetryPolicy(providerRoute('acp-zcode'))
    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['SERVER', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT'],
      initialDelayMs: 5_000,
      maxDelayMs: 60_000,
      jitterRatio: 0.1,
    })
  })

  it('外部 agent 路由不交策略（undefined 即宿主默认）', () => {
    expect(externalAdapter.providerRetryPolicy(providerRoute('acp-claude'))).toBeUndefined()
  })
})
