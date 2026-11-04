/**
 * 委派服务的载荷契约（与 dsh-superpowers 的 lib/delegation-contract.js 逐字同形）。
 *
 * 两个插件互不 import：acp-agent 负责通路（把外部 agent 的委派请求送进宿主），
 * superpowers 负责委派实现（按这份形状发布宿主服务）。跨插件只经宿主服务
 * 对接——一个服务名 + 一份载荷形状——所以两边各写一份契约，靠约定与对照
 * 测试钉住形状。改这里必须同步改对面副本；两仓都在场时，
 * tests/delegation-contract.spec.ts 的对照用例会抓住漂移。
 */

/** 宿主服务名：superpowers 侧按这个名字发布委派服务，acp-agent 侧按这个名字取。 */
export const DELEGATION_SERVICE = 'superpowers.delegation'

/** 委派请求：父 DSH 会话请宿主替它起一个子代理。 */
export type DelegationRequest = {
  /** 父 DSH 会话 id */
  readonly sessionId: string
  /** 技能名；缺省 = 走「其他子代理」那一行 */
  readonly skill?: string
  /** 短标签 */
  readonly task: string
  /** 给孩子的完整任务书（孩子看不到本对话） */
  readonly brief: string
  /** 取消 */
  readonly signal?: AbortSignal
}

/** 委派结果：子代理跑完后的最小回报面。 */
export type DelegationResult = {
  /** 子代理的最终文本 */
  readonly output: string
  /** 实际路由；未钉定 = 'inherited' */
  readonly model: string
  /** 子会话 id */
  readonly childId: string
}

/**
 * 收到的值是不是一份 DelegationResult。
 *
 * 载荷跨插件、跨进程边界走，对面来的东西永远是 unknown——判定只认形状
 * （三字段齐全且都是 string），不认识就丢，不在半路抛错把通路弄崩。
 * @param value - 任意来路的值
 * @returns 是合法 DelegationResult 才返回 true
 */
export function isDelegationResult(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.output === 'string'
    && typeof record.model === 'string'
    && typeof record.childId === 'string'
  )
}
