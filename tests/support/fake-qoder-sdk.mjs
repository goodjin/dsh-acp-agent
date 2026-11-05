/**
 * 假 Qoder SDK daemon：说一样的 NDJSON 控制协议，但清单是写死的。
 *
 * 真 daemon 的握手：initialize → get_models。假件照着来，测试就能不依赖
 * Qoder 应用、也不碰网络。
 */
import { createInterface } from 'node:readline'

const MODELS = [
  { modelId: 'gmodel', displayName: 'GLM-5.3', priceFactor: 0.8, maxInputTokens: 180000, efforts: ['high', 'low', 'max'], isVl: true },
  { modelId: 'mmodel', displayName: 'MiniMax-M3.1-Flash', priceFactor: 0.1, maxInputTokens: 180000, efforts: ['medium'], isVl: true },
]

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.trim() === '') return
  const frame = JSON.parse(line)
  const id = frame.request_id
  const method = frame.request?.method
  if (method === 'daemon.initialize') {
    process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { daemon_protocol_version: 2 } } })}\n`)
    return
  }
  if (method === 'daemon.get_models') {
    process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { models: MODELS } } })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: '不支持' } })}\n`)
})
