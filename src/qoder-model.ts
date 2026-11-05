import type { CatalogTurnRequest } from './catalog.ts'
import type { PresetConfig } from './registry.ts'
import { streamQoder } from './qoder/chat.ts'
import { resolveCredential } from './qoder/credential.ts'

export function qoderModelStream(config: PresetConfig) {
  return (presetId: string, request: CatalogTurnRequest) => {
    if (config.presets[presetId]?.agent !== 'qoder-global') return undefined
    return streamQoder(request, { credential: rejectedToken => resolveCredential({ rejectedToken }) })
  }
}
