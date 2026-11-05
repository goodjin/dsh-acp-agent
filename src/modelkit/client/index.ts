/**
 * 浏览器侧的公共机器：配额胶囊。
 *
 * 一个普通 npm 包的子路径入口，指向源码；由 agent-acp、workbuddy 等插件的
 * tsdown 在打包客户端产物时一并内联。规格常量与 quota.* 词条不进这里——
 * 谁家的胶囊谁家的口径与词典。
 */

export {
  createQuotaPoller,
  loginChipOf,
  loginOfferOfBody,
  creditPillOf,
  loginChip,
  pillOf,
  registerQuotaDockPills,
  routeQuotaFetcher,
  sameLoginOffer,
  QuotaPillRow,
} from './quota-pill-machine.tsx'
export type {
  QuotaPillServices,
  QuotaWindow,
  QuotaWindows,
  QuotaAnswer,
  QuotaPillSpec,
  QuotaLoginOffer,
  QuotaPoller,
  DockSlotHost,
} from './quota-pill-machine.tsx'
