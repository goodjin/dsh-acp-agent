/**
 * The MiniMax model catalog, copied from MiniMax Code's own first-run catalog.
 *
 * Upstream: `packages/config/src/minimax-model-catalog.ts` in
 * MiniMax-AI/minimax-code, which is derived from models.dev (MIT — the notice
 * is in NOTICE.md next to this file).
 *
 * The only change from upstream is the type import: upstream pulls `ModelConfig`
 * out of a 93 KB `config.ts` we do not vendor, so the two fields this plugin
 * reads are declared here instead. The values are untouched.
 *
 * `thinking_config.mode` is the fact that decides a request: `forced_on` models
 * reject `thinking: { type: 'disabled' }` outright, `switchable` models accept it.
 * `thinking.effortOptions` is the depth ladder such a model publishes.
 */
const MINIMAX_M3_FILE_API_CAPABILITIES = {
    support_files_api: true,
    files_api_upload_endpoint: '/v1/files/upload',
    max_image_bytes_inline: 10_485_760,
    max_video_bytes_inline: 52_428_800,
    max_request_body_bytes: 67_108_864,
    max_attachments_count: 4,
};
export const MINIMAX_MODELS = {
    'MiniMax-M3': {
        name: 'MiniMax-M3',
        attachment: true,
        reasoning: true,
        tool_call: true,
        temperature: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 512000, output: 128000 },
        contextWindowOptions: [512000, 1000000],
        contextWindowOptionHints: { '1000000': 'higher_usage' },
        options: { reasoningSummary: 'auto' },
        thinking_config: { mode: 'switchable', default_value: 'true' },
        variants: {
            'none-thinking': { thinking: { type: 'disabled' } },
            thinking: { thinking: { type: 'adaptive' } },
        },
        capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
    },
    'MiniMax-M3.1-Flash': {
        name: 'M3.1-Flash',
        attachment: true,
        reasoning: true,
        tool_call: true,
        temperature: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 512000, output: 128000 },
        contextWindowOptions: [512000, 1000000],
        contextWindowOptionHints: { '1000000': 'higher_usage' },
        options: { reasoningSummary: 'auto' },
        thinking: {
            effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort: 'default',
        },
        thinking_config: { mode: 'forced_on' },
        variants: {
            'none-thinking': { thinking: { type: 'disabled' } },
            thinking: { thinking: { type: 'adaptive' } },
        },
        capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
    },
    'MiniMax-M2.7-highspeed': {
        name: 'MiniMax-M2.7-highspeed',
        attachment: false,
        reasoning: true,
        tool_call: true,
        temperature: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200000, output: 128000 },
    },
    'MiniMax-M2.7': {
        name: 'MiniMax-M2.7',
        attachment: false,
        reasoning: true,
        tool_call: true,
        temperature: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200000, output: 128000 },
    },
};
/**
 * Whether a model may be asked not to think.
 *
 * `forced_on` models answer `thinking: { type: 'disabled' }` with an error, so
 * the request has to leave the switch alone for them. A model the catalog does
 * not carry is treated as switchable — the published models that cannot be
 * switched off are the ones that say so.
 */
export function canDisableThinking(model) {
    return MINIMAX_MODELS[model]?.thinking_config?.mode !== 'forced_on';
}
