/**
 * 隐藏清单的一代迁移：键名随插件改名（threadharbor.acpVisibility → acp-agent.acpVisibility）。
 *
 * 这份清单是用户在设置里一个个勾出来的「屏蔽哪些提供方与模型」，改名不能把它弄丢：
 * 首次读取时新键缺失、旧键在场 → 把旧值搬到新键并删掉旧键，之后只认新键。
 * 搬不动的极端情况（写失败）退回「读时兜底」，旧键保留，下次再试。
 */

import { describe, expect, it } from 'vitest'
import {
  ACP_VISIBILITY_STORAGE_KEY,
  LEGACY_ACP_VISIBILITY_STORAGE_KEY,
  startAcpVisibility,
} from '../src/client/acp-visibility.ts'
import type { AcpVisibilityStorage } from '../src/client/acp-visibility.ts'

const LEGACY_CHOICE = JSON.stringify({ hiddenAgents: ['acp:acp-grok'], hiddenModels: { 'acp:acp-codex': ['gpt-6-astra'] } })

/** 可观察删除的假 localStorage。 */
function fakeStorage(initial: Record<string, string> = {}): AcpVisibilityStorage & { dump(): Record<string, string> } {
  const store = new Map(Object.entries(initial))
  return {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: key => void store.delete(key),
    dump: () => Object.fromEntries(store),
  }
}

describe('隐藏清单键名的一代迁移', () => {
  it('旧键在场、新键缺失：搬值、删旧键，用户勾过的清单不丢', () => {
    const storage = fakeStorage({ [LEGACY_ACP_VISIBILITY_STORAGE_KEY]: LEGACY_CHOICE })
    const store = startAcpVisibility(storage)
    expect(store.get().hiddenAgents).toEqual(['acp:acp-grok'])
    expect(store.get().hiddenModels).toEqual({ 'acp:acp-codex': ['gpt-6-astra'] })
    expect(storage.getItem(ACP_VISIBILITY_STORAGE_KEY)).not.toBeNull()
    expect(storage.getItem(LEGACY_ACP_VISIBILITY_STORAGE_KEY)).toBeNull()
  })

  it('新键已在：不动旧键也不覆盖新值（此前已迁移过的常态）', () => {
    const storage = fakeStorage({
      [ACP_VISIBILITY_STORAGE_KEY]: JSON.stringify({ hiddenAgents: [], hiddenModels: {} }),
      [LEGACY_ACP_VISIBILITY_STORAGE_KEY]: LEGACY_CHOICE,
    })
    const store = startAcpVisibility(storage)
    expect(store.get().hiddenAgents).toEqual([])
    expect(storage.getItem(LEGACY_ACP_VISIBILITY_STORAGE_KEY)).not.toBeNull()
  })

  it('两把键都没有：空清单起家，不写任何键', () => {
    const storage = fakeStorage()
    const store = startAcpVisibility(storage)
    expect(store.get().hiddenAgents).toEqual([])
    expect(storage.dump()).toEqual({})
  })

  it('迁移后照常写入：set 落在新键上', () => {
    const storage = fakeStorage({ [LEGACY_ACP_VISIBILITY_STORAGE_KEY]: LEGACY_CHOICE })
    const store = startAcpVisibility(storage)
    store.set({ hiddenAgents: ['acp:acp-minimax'], hiddenModels: {} })
    expect(JSON.parse(storage.getItem(ACP_VISIBILITY_STORAGE_KEY) ?? '{}')).toMatchObject({ hiddenAgents: ['acp:acp-minimax'] })
  })

  it('没有 removeItem 的存储：退化为读时兜底，不迁移也不抛', () => {
    const storage = fakeStorage({ [LEGACY_ACP_VISIBILITY_STORAGE_KEY]: LEGACY_CHOICE })
    const bare: AcpVisibilityStorage = { getItem: storage.getItem, setItem: storage.setItem }
    const store = startAcpVisibility(bare)
    expect(store.get().hiddenAgents).toEqual(['acp:acp-grok'])
  })
})
