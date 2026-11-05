/**
 * The model plugins, in one place.
 *
 * A preset that is itself a model answers the loop's request instead of opening
 * an ACP session. There is more than one such row — GLM through the local ZCode
 * login, MiniMax through the local MiniMax Code login — and the catalogue takes
 * a single answerer, so this picks the one that owns the preset. Each row is
 * asked in turn and declines by returning nothing.
 */

import type { ModelTurnRequest } from '@goodjin2/dsh-model-kit'
import { minimaxiModelStream } from './minimaxi-model.ts'
import type { PresetConfig } from './registry.ts'
import { pairToolResults } from './tool-pairing.ts'
import { qoderModelStream } from './qoder-model.ts'
import { zcodeModelStream } from './zcode-model.ts'
import type { MiniMaxStreamChunk } from './minimaxi/index.ts'
import type { GlmStreamChunk } from './zcode/index.ts'

/**
 * One answerer for every model row. Returning nothing leaves the request on the
 * gateway path, which is what a preset no plugin claims should get.
 */
export function modelPluginStream(
  config: PresetConfig,
  deps?: {
    /** 把某个 agent 自报的模型清单写进目录账本（选择器以它为准）。 */
    readonly onRuntimeModels?: ((presetId: string, models: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[]) => void) | undefined
  },
): (presetId: string, request: ModelTurnRequest) => AsyncIterable<GlmStreamChunk | MiniMaxStreamChunk> | undefined {
  const plugins = [zcodeModelStream(config), minimaxiModelStream(config), qoderModelStream(config, deps)]
  return (presetId, request) => {
    const paired = withPairedResults(request)
    for (const plugin of plugins) {
      const stream = plugin(presetId, paired)
      if (stream !== undefined) return stream
    }
    return undefined
  }
}

/**
 * The request with its tool calls paired to their results again.
 *
 * Both model rows answer in the anthropic messages format, which wants every
 * tool call answered by the tool results of the very next user message. The
 * session log does not always hold them in that order — a background subagent
 * call that never got its result has it written at the tail of the log — and
 * the provider refuses such a request outright.
 */
function withPairedResults(request: ModelTurnRequest): ModelTurnRequest {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return { ...request, messages: pairToolResults(messages) }
}

/**
 * The rows answered inside DSH's own loop. A row on this list has no transport
 * of its own — no child process, no socket — so every place that asks "does
 * this row have a dialect, or is it a model?" must read the same list. Listing
 * one of them in a second place is how a row ends up mounted and inert.
 */
const MODEL_BACKED_AGENTS = new Set(['zcode', 'minimaxi', 'qoder-global'])

export function isModelBackedAgent(agent: string | undefined): boolean {
  return agent !== undefined && MODEL_BACKED_AGENTS.has(agent)
}

/**
 * Which rows are answered in place, for the startup log. A row that no plugin
 * claims would otherwise look identical to a working one until someone sends a
 * message and gets the gateway's answer instead of the model's.
 */
export function describeClaimedModels(config: PresetConfig): string {
  const claimed: string[] = []
  for (const [presetId, preset] of Object.entries(config.presets)) {
    if (isModelBackedAgent(preset.agent)) claimed.push(`${presetId}=${preset.agent}`)
  }
  return claimed.length === 0 ? 'none' : claimed.join(' ')
}
