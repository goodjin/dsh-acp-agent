/**
 * DSH 模型行的公共机制（类型、provider 路由、运行时账本、强度折叠、勾选、模型行适配）。
 *
 * 一个普通 npm 包，不是插件：不挂任何宿主行，只被 agent-acp、workbuddy 等模型行
 * 插件 import。它放「一条模型行」的通用件——provider 路由命名、目录适配器、运行时
 * 清单账本、档位折叠、勾选文件读写、统一的块/请求类型，以及浏览器侧的配额胶囊
 * 机器。规格与文案各插件自带（谁家的胶囊谁家的词条）。
 */

export * from './types.ts'
export * from './provider-route.ts'
export * from './runtime-models.ts'
export * from './efforts.ts'
export * from './selection.ts'
export * from './model-row-adapter.ts'
