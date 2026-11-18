/**
 * 状态帧的读法：ACP 里「agent 现在在干什么」的那几帧。
 *
 * 状态帧和内容帧不是一类东西。它们不产出文字，却决定「静默」两个字是否成立：
 * codex 用 `session_info_update._meta.codex.threadStatus` 报 active/idle，
 * 而它压缩上下文时一个帧都不发（2026-10-27 实测）——状态只能从最后一次上报里读。
 *
 * 这里只做归类，不写任何东西：什么时候提示、提示在哪，由调用方决定。
 */
function recordOf(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
function stringOf(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** codex 的 activeFlags 词表（codex app-server 的 ThreadActiveFlag）。 */
const ACTIVE_FLAG_LABELS = {
    waitingOnApproval: '等待审批',
    waitingOnUserInput: '等待用户输入',
};
function codexStatusOf(status) {
    const type = stringOf(status['type']);
    if (type === undefined)
        return undefined;
    if (type === 'idle') {
        return { key: 'codex:idle', label: 'codex 空闲', working: false, notable: false };
    }
    if (type === 'systemError') {
        return { key: 'codex:systemError', label: 'codex 内部错误', working: false, notable: true };
    }
    if (type === 'notLoaded') {
        return { key: 'codex:notLoaded', label: 'codex 会话未加载', working: false, notable: true };
    }
    if (type === 'active') {
        const flags = Array.isArray(status['activeFlags'])
            ? status['activeFlags'].filter((flag) => typeof flag === 'string')
            : [];
        if (flags.length === 0) {
            return { key: 'codex:active', label: 'codex 正在处理', working: true, notable: false };
        }
        const labels = flags.map(flag => ACTIVE_FLAG_LABELS[flag] ?? flag);
        return {
            key: `codex:active:${[...flags].sort().join(',')}`,
            label: `codex 正在处理（${labels.join('、')}）`,
            working: true,
            notable: true,
        };
    }
    return { key: `codex:${type}`, label: `codex 状态：${type}`, working: true, notable: true };
}
function compactionOf(update) {
    const status = stringOf(update['status']) ?? 'unknown';
    if (status === 'in_progress') {
        return { key: 'compaction:in_progress', label: 'codex 正在压缩上下文', working: true, notable: false };
    }
    if (status === 'completed') {
        return { key: 'compaction:completed', label: '上下文压缩完成', working: true, notable: false };
    }
    if (status === 'failed') {
        const error = stringOf(update['error']);
        return {
            key: 'compaction:failed',
            label: `上下文压缩失败${error === undefined ? '' : `：${error}`}`,
            working: true,
            notable: false,
        };
    }
    if (status === 'cancelled') {
        return { key: 'compaction:cancelled', label: '上下文压缩已取消', working: true, notable: false };
    }
    return { key: `compaction:${status}`, label: `上下文压缩：${status}`, working: true, notable: false };
}
/**
 * 从一帧里读出状态，读不出就是 undefined。
 *
 * 只看 `session/update`（含厂商私有包装里带 `update` 的那种）。标题、目标、用法
 * 这类帧不是状态：它们各自有展示位（遥测汇总/用量行），塞进「最后状态」只会让
 * 超时消息里出现一句和死活无关的话。
 */
export function readSessionStatus(frame) {
    if (frame.method === undefined)
        return undefined;
    const update = recordOf(recordOf(frame.params)['update']);
    const kind = stringOf(update['sessionUpdate']);
    if (kind === 'session_info_update') {
        const codex = recordOf(recordOf(update['_meta'])['codex']);
        const status = recordOf(codex['threadStatus']);
        return codexStatusOf(status);
    }
    if (kind === 'compaction_update')
        return compactionOf(update);
    if (kind === 'current_mode_update') {
        const modeId = stringOf(update['currentModeId']);
        return modeId === undefined
            ? undefined
            : { key: `mode:${modeId}`, label: `模式切换：${modeId}`, working: true, notable: true };
    }
    return undefined;
}
