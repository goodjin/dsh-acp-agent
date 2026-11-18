/**
 * MiniMax as a model, not as an ACP agent.
 *
 * Same contract as the GLM plugin: the native loop already reads files, runs
 * commands, asks for approval, cancels, and writes the session. This only
 * answers the model request — take the local MiniMax Code login, call the
 * managed gateway, and hand the text and tool calls back.
 */
import { streamMiniMax } from "./minimaxi/index.js";
/** The preset's own agent name that marks a row as this model plugin. */
const AGENT = 'minimaxi';
export function minimaxiModelStream(config) {
    return (presetId, request) => {
        if (config.presets[presetId]?.agent !== AGENT)
            return undefined;
        const tools = normalizeTools(request.tools);
        return streamMiniMax({
            model: request.model,
            messages: Array.isArray(request.messages) ? request.messages : [],
            ...(typeof request.reasoningEffort === 'string' && request.reasoningEffort !== ''
                ? { reasoningEffort: request.reasoningEffort }
                : {}),
            ...(typeof request.system === 'string' ? { system: request.system } : {}),
            ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
            ...(request.signal instanceof AbortSignal ? { signal: request.signal } : {}),
            ...(tools === undefined ? {} : { tools }),
        });
    };
}
function normalizeTools(tools) {
    if (tools === undefined)
        return undefined;
    return tools.flatMap(tool => {
        if (typeof tool?.name !== 'string' || tool.name === '')
            return [];
        return [{
                name: tool.name,
                ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
                ...(tool.parameters !== undefined && typeof tool.parameters === 'object' ? { parameters: tool.parameters } : {}),
            }];
    });
}
