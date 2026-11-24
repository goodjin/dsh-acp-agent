/**
 * 「刷新模型列表」整条链的接线与文案：
 * - 声明行真的在 cordis.patch.yml 里、package.json 真的导出那个子路径、health
 *   自报清单真的期望它——三处少一处都是「装上但不存在」的静默失败；
 * - applyAcpPlugin 真的把自己的刷新器登记进共享表（claude 那条还能直接调通）；
 * - locales 的八种界面语言都带全刷新文案；
 * - 浏览器半边：折文案的口径 + 设置段只给 ACP 行画按钮。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { applyAcpPlugin, type AcpPluginContext } from '../src/plugin.ts'
import { clearModelRefreshers, modelRefresherOf } from '../src/model-refresh.ts'
import { EXPECTED_ROWS } from '../src/health.ts'
import { createAcpCatalogStore } from '../src/client/acp-visibility-catalog.ts'
import { startAcpVisibility } from '../src/client/acp-visibility.ts'
import { AcpVisibilityPanel } from '../src/client/acp-visibility-panel.tsx'
import { refreshMessage, requestModelRefresh } from '../src/client/model-refresh.ts'
import { de, en, es, fr, ja, pt, ru, zh, fallbackT } from '../src/client/locales.ts'
import type { ModelRefreshReply } from '../src/client/model-refresh.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH = readFileSync(`${ROOT}/cordis.patch.yml`, 'utf8')
const PACKAGE = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as {
  exports?: Record<string, { types?: string; default?: string }>
}

/** 新增刷新文案的全部键。 */
const REFRESH_KEYS = [
  'acpVisibility.refresh.button',
  'acpVisibility.refresh.named',
  'acpVisibility.refresh.refreshing',
  'acpVisibility.refresh.upstream',
  'acpVisibility.refresh.familyWindow',
  'acpVisibility.refresh.unverified',
  'acpVisibility.refresh.reread',
  'acpVisibility.refresh.codexHint',
  'acpVisibility.refresh.busy',
  'acpVisibility.refresh.failed',
  'acpVisibility.refresh.qoderHint',
  'acpVisibility.refresh.anotherPlugin',
] as const

describe('接线：声明行 / 导出 / 自报清单', () => {
  it('cordis.patch.yml 有一行挂 model-refresh 路由', () => {
    expect(PATCH).toMatch(/- id: acp-agent-model-refresh\n      name: '@goodjin2\/dsh-acp-agent\/model-refresh'/)
  })

  it('package.json 导出该子路径，入口指向路由模块（types 是源码、default 是产物）', () => {
    const entry = PACKAGE.exports?.['./model-refresh']
    expect(entry?.types).toBe('./src/model-refresh-route.ts')
    expect(entry?.default).toBe('./lib/src/model-refresh-route.js')
  })

  it('health 自报清单期望这一行（加行要两处同改）', () => {
    expect(EXPECTED_ROWS.map(row => row.id)).toContain('acp-agent-model-refresh')
  })
})

describe('接线：applyAcpPlugin 登记刷新器', () => {
  it('挂载后共享表里查得到该预置的刷新器', () => {
    clearModelRefreshers()
    const context = {
      on: () => { return () => {} },
    } as unknown as AcpPluginContext
    applyAcpPlugin(context, 'acp-grok', {
      agent: 'grok',
      command: '/Users/good/.local/bin/grok',
      models: [{ id: 'grok-4.7', name: 'Grok 4.7', contextWindow: 1100000 }],
    }, { install: () => {} })
    expect(modelRefresherOf('acp-grok')).toBeDefined()
  })

  it('claude 行的刷新器可直接调：如实回「已重读」，不写账本', async () => {
    clearModelRefreshers()
    const context = {
      on: () => { return () => {} },
    } as unknown as AcpPluginContext
    applyAcpPlugin(context, 'acp-claude', {
      agent: 'claude',
      url: 'ws://127.0.0.1:2419',
      models: [{ id: 'claude-opus', name: 'Opus' }],
    }, { install: () => {} })
    const refresher = modelRefresherOf('acp-claude')
    expect(refresher).toBeDefined()
    await expect(refresher?.()).resolves.toEqual({ ok: true, kind: 'reread', agent: 'claude' })
    clearModelRefreshers()
  })
})

describe('文案：八种界面语言都带全刷新键', () => {
  const dictionaries = { zh, en, ja, es, fr, de, ru, pt }
  it('每种语言 10 个键全有且非空', () => {
    for (const [language, dictionary] of Object.entries(dictionaries)) {
      for (const key of REFRESH_KEYS) {
        const value = dictionary[key]
        expect(value, `${language} 缺 ${key}`).toBeDefined()
        expect(value?.length, `${language} 的 ${key} 是空的`).toBeGreaterThan(0)
      }
    }
  })

  it('zh 与 en 的按钮文案是「刷新模型列表 / Refresh model list」', () => {
    expect(zh['acpVisibility.refresh.button']).toBe('刷新模型列表')
    expect(en['acpVisibility.refresh.button']).toBe('Refresh model list')
  })
})

describe('折文案：应答形状 → 一句话', () => {
  it('upstream：总数与新增，附窗口说明', () => {
    const reply: ModelRefreshReply = { ok: true, kind: 'upstream', total: 13, added: 10, familyWindow: 6, unverifiedWindow: 4 }
    const line = refreshMessage(reply, fallbackT)
    expect(line).toContain('已刷新：13 个模型（新增 10 个）')
    expect(line).toContain('6 个新增模型的上下文窗口沿用同族声明值')
    expect(line).toContain('4 个模型未验证上下文窗口')
  })

  it('upstream：没有新增就没有窗口注脚', () => {
    const line = refreshMessage({ ok: true, kind: 'upstream', total: 4, added: 0, familyWindow: 0, unverifiedWindow: 0 }, fallbackT)
    expect(line).toBe('已刷新：4 个模型（新增 0 个）。')
  })

  it('reread：如实说明；codex 附去 dsh-codex 的提示', () => {
    expect(refreshMessage({ ok: true, kind: 'reread' }, fallbackT))
      .toContain('该提供方暂不支持从上游拉取清单')
    const codex = refreshMessage({ ok: true, kind: 'reread', hint: 'codex' }, fallbackT)
    expect(codex).toContain('dsh-codex 插件的设置段')
  })

  it('busy 与失败：原因进文案', () => {
    expect(refreshMessage({ ok: false, code: 'busy', error: 'a refresh is already running' }, fallbackT))
      .toBe('刷新正在进行中，请等它完成。')
    expect(refreshMessage({ ok: false, error: 'serve refused to start' }, fallbackT))
      .toBe('刷新失败：serve refused to start')
  })

  it('not-ours：按 hint 指路到对应插件，未知提供方给通用文案，不透内部腔', () => {
    expect(refreshMessage({ ok: false, code: 'not-ours', hint: 'codex', error: 'internal detail' }, fallbackT))
      .toContain('dsh-codex 插件的设置段')
    expect(refreshMessage({ ok: false, code: 'not-ours', hint: 'qoder', error: 'internal detail' }, fallbackT))
      .toContain('dsh-qoder 插件的设置段')
    const generic = refreshMessage({ ok: false, code: 'not-ours', error: 'internal detail' }, fallbackT)
    expect(generic).toContain('这个提供方由另一个插件挂载')
    // 内部错误腔绝不进文案
    expect(generic).not.toContain('internal detail')
    expect(refreshMessage({ ok: false, code: 'not-ours', hint: 'codex', error: 'internal detail' }, fallbackT))
      .not.toContain('internal detail')
  })
})

describe('浏览器取数：坏情况都折成 ok:false，从不 reject', () => {
  it('POST 到刷新路由，带 preset；成功应答原样返回', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, kind: 'upstream', total: 13, added: 10, familyWindow: 6, unverifiedWindow: 4 }), { status: 200 })
    }) as typeof fetch
    const reply = await requestModelRefresh(fetchImpl, 'grok')
    expect(calls[0]?.url).toBe('/acp-agent/models/refresh')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(String((calls[0]?.init?.body as BodyInit))).toBe(JSON.stringify({ preset: 'grok' }))
    expect(reply).toEqual({ ok: true, kind: 'upstream', total: 13, added: 10, familyWindow: 6, unverifiedWindow: 4 })
  })

  it('网络异常 / 非 JSON / 怪形状 / busy 都落 ok:false', async () => {
    const boom = (async () => { throw new Error('network gone') }) as unknown as typeof fetch
    expect(await requestModelRefresh(boom, 'grok')).toEqual({ ok: false, error: 'network gone' })
    const noJson = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch
    const noJsonReply = await requestModelRefresh(noJson, 'grok')
    expect(noJsonReply.ok).toBe(false)
    expect((noJsonReply as { error: string }).error).toContain('502')
    const weird = (async () => new Response(JSON.stringify({ hello: 1 }), { status: 200 })) as unknown as typeof fetch
    expect((await requestModelRefresh(weird, 'grok')).ok).toBe(false)
    const busy = (async () => new Response(JSON.stringify({ ok: false, code: 'busy', error: 'running' }), { status: 200 })) as typeof fetch
    expect(await requestModelRefresh(busy, 'grok')).toEqual({ ok: false, code: 'busy', error: 'running' })
  })
})

describe('设置段：只给 ACP 行画刷新按钮', () => {
  it('ACP 行有按钮，内置提供方没有；成功与失败行反馈占位可用', async () => {
    const CATALOG = {
      groups: [
        { id: 'acp:grok', name: 'Grok', models: [{ id: 'grok-4.7', name: 'Grok 4.7' }] },
        { id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
      ],
      failures: [],
    }
    const storage = {
      getItem: () => null,
      setItem: () => {},
    }
    const visibility = startAcpVisibility(storage)
    const catalog = createAcpCatalogStore(async () => ({ ok: true, value: CATALOG }))
    await catalog.load(true)
    const html = renderToString(createElement(AcpVisibilityPanel, { visibility, catalog }))
    expect(html).toContain('刷新模型列表')
    expect(html).toContain('aria-label="刷新 Grok 的模型列表"')
    // 内置提供方（非 acp: 路由）没有按钮：刷新语义只对 ACP 预置成立。
    expect(html).not.toContain('aria-label="刷新 DeepSeek 的模型列表"')
    expect(html).toContain('data-agent="grok"')
  })
})
