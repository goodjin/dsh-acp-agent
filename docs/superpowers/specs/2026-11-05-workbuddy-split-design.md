# WorkBuddy 从 agent-acp 拆出去（独立插件）设计

> 核对时间：2026-11-05
> 状态：设计已评审通过（对话中确认），待出实施计划
> 归属仓库：`@goodjin2/dsh-acp-agent`（本文件放在这里；实施会牵动三个仓）

## 一、背景与目标

WorkBuddy 现在住在 `@goodjin2/dsh-acp-agent` 里：它不是外部 agent（不拉进程、不走
ACP），而是**模型插件**——DSH 自己的循环跑，只把「向模型要下一句话」换成 WorkBuddy
账号下的模型。它带着自己的一整套东西：登录与凭据、模型清单、签到、套餐与积分、设置
里的一节、输入框下的积分胶囊。

目标：**把 WorkBuddy 整体搬成一个独立插件 `@goodjin2/dsh-workbuddy`，agent-acp 里
不留任何 WorkBuddy 痕迹。**

成功标准（搬家后逐条可查）：

1. agent-acp 仓里搜不到 `workbuddy`（除了历史文档里的一段说明）。
2. 模型选择器里 WorkBuddy 那组还在，模型一样、名字一样、倍率一样。
3. 不用重新登录（凭据还在原处）、模型勾选不丢（勾选文件还在原处）。
4. 设置里「WorkBuddy 账号」那一节还在：签到状态、立即签到、套餐与积分、模型清单。
5. 输入框下方的积分胶囊还在，只在选了 WorkBuddy 模型时出现。
6. agent-acp 仍然管着外部 agent 与 zcode/minimaxi/qoder-global 三个模型行，行为不变。

## 二、范围

### 做

- 抽出「模型行」的公共机制，成一个共享工具包。
- 建独立插件仓 `@goodjin2/dsh-workbuddy`，把 WorkBuddy 的宿主侧与浏览器侧代码整体搬过去。
- profile 接线（link: 依赖与 bundles）。
- agent-acp 侧删干净并回归全绿。
- 文档同步（三个仓的 README/AGENTS、容器 AGENTS.md 的仓库清单）。

### 不做

- 不改 WorkBuddy 的功能行为（不顺手重构它的内部）。
- 不改 zcode/minimaxi/qoder-global 三个模型行的行为。
- 不改宿主（DSH）的任何代码。
- 不做多账号、不做积分余额的更多口径（本次只搬，不加）。

## 三、事实依据

### 3.1 模型列表不是一个「位置」，是一组 provider 路由

模型选择器读的是宿主的全局 LLM 目录。每个插件用
`ctx.llm.registerAdapter(routes, adapter)` 注册**自己那几行 preset 对应的 provider
路由**（路由 id 是 `acp:<行 id>`），目录按 provider 分组。宿主侧接口是
`LlmAdapter`：`providerInfo` / `listModels` / `resolveModel` / `prepareCall` /
`stream` / `providerRetryPolicy`。

所以「两个插件抢模型列表」不成立；会出事的是**同一个 id 被两边同时声明**：

| 撞的地方 | id | 后果 |
|---|---|---|
| provider 路由 | `acp:acp-workbuddy` | 宿主登记适配器时冲突（它会打 `configuration conflicts with an existing provider route`），谁生效看加载顺序 |
| 挂载行 | `acp-workbuddy` | profile 里两个同名行 |
| 宿主路由路径 | `/acp-agent/workbuddy/*` | 两个插件抢同一批路径 |
| dock 条目 | `acp-agent-workbuddy-quota` | 输入框下方两枚一样的胶囊 |
| locale 命名空间 | `acpAgentClient` | 两份词典互相覆盖（谁的注册在后谁赢） |

**一边彻底不存在，就无从撞起**——这正是「agent-acp 里不留痕迹」是前提的原因。

### 3.2 有一半机制藏不住：现成的「藏」只管预设行

`roster-filter` 藏的是**预设行列表**（新会话座位那一列），不藏模型选择器。所以
「装两个、藏一个」走不通：重复的模型照样出现在选择器里。

### 3.3 公共件到底有多小

WorkBuddy 当模型插件要用到的通用东西：

| 通用件 | 现在在哪 | 行数级别 |
|---|---|---|
| provider 路由命名 | `catalog.ts`（`providerRoute` / `presetOfRoute`） | 十几行 |
| 模型行的目录适配器 | `catalog.ts`（`catalogAdapter` 里模型行那一支） | ~120 行 |
| 运行时清单账本 | `catalog-registration.ts`（`runtimeModels`） | 二十几行 |
| 档位折叠 | `catalog.ts`（`collapseEffortModels` / `collapsedToCatalog`） | 几十行 |
| 勾选文件读写 | `model-selection.ts` | 八十行 |
| 块词汇与请求类型 | `catalog.ts`、`dialects/` | 类型为主 |
| 浏览器侧胶囊机器 | `client/quota-pill.ts`（机器 + 规格表） | ~800 行 |

三个厂商的块类型（`GlmStreamChunk` / `MiniMaxStreamChunk` / `WorkBuddyStreamChunk`）
**形状完全一致**（block-start / text-delta / reasoning-delta / tool-call-delta /
block-end / usage / finish），只有 block、usage、finish 的字段类型按厂商不同——所以
公共件可以只放一份统一类型。

## 四、设计

### 四.1 三仓格局

```
dsh-plugins/
├── dsh-model-kit/      新：共享工具包（@goodjin2/dsh-model-kit，不是插件，不挂宿主行）
├── dsh-acp-agent/      现有：外部 ACP agent + zcode/minimaxi/qoder-global 三个模型行
└── dsh-workbuddy/      新：WorkBuddy 全套（独立插件）
```

`dsh-model-kit` 是**普通 npm 包**，不是插件：它没有 cordis.patch.yml、不注册任何
宿主行，只被两个插件 import。放在容器目录里，与其它插件平级（容器目录就是这些包的
家）。

### 四.2 公共件的清单（`@goodjin2/dsh-model-kit`）

宿主侧导出：

| 导出 | 形状 |
|---|---|
| `providerRoute(presetId)` / `presetOfRoute(route)` | `acp:<行 id>` / 反解 |
| `modelRowAdapter(options)` | 目录适配器（只做模型行；ACP 行不在其中） |
| `runtimeModels()` | 清单账本：`record` / `modelsOf` |
| `collapseEffortModels` / `collapsedToCatalog` | 档位折叠 |
| `readSelection` / `writeSelection` / `selectionFilePath` | 勾选文件 |
| 类型 | `ModelStreamChunk`、`ModelTurnRequest`、`CatalogModel`、`ReportedModel` |

浏览器侧导出（`@goodjin2/dsh-model-kit/client`）：配额胶囊的**机器**——规格表类型、
轮询器、行渲染、dock 注册。**规格与文案各插件自带**（谁家的胶囊谁家的词条）。

### 四.3 agent-acp 侧的改动

- 宿主侧：`catalog.ts` 拆成「ACP 行适配器」（留在本仓）与「模型行适配器」（用 kit 的）；
  `model-plugins.ts` 的插件表改成按行挑模型插件（zcode/minimaxi/qoder-global 三个）；
  `factory.ts` 的两处守卫与「哪些行由模型插件应答」的集合改成读本仓自己的名单。
- 浏览器侧：`client/quota-pill.ts` 变成「kit 的机器 + 本仓的规格表」；`locales.ts` 里
  胶囊词条留在本仓（zcode/minimaxi/codex/claude/deepseek/grok 的）。
- 删：`src/workbuddy/`、`src/workbuddy-model.ts`、`src/workbuddy-route.ts` 及其导出、
  `cordis.patch.yml` 里的 `acp-workbuddy` 与 `acp-agent-workbuddy-login` 两行、
  客户端的 WorkBuddy 设置段与胶囊规格、相关测试与文档。

### 四.4 新插件侧的内容

宿主侧：`src/workbuddy/*`（端点、请求体、SSE、鉴权、凭据、清单、签到、套餐与积分）、
`src/workbuddy-model.ts`（模型插件入口）、`src/workbuddy-route.ts`（宿主路由）、
`src/entry.ts`（宿主侧入口）。
浏览器侧：`src/client/workbuddy-account-section.tsx`、WorkBuddy 自己的词条、
胶囊规格、客户端入口。
挂载行：自己的一份 `cordis.patch.yml`——`acp-workbuddy` 预设行（binding 指向自己）+
`acp-agent-workbuddy-login` 宿主行。

### 四.5 id 与路径：全部沿用，不改

沿用是为了「搬完不用重新登录、勾选不丢、老会话继续能用」。

| 东西 | 值 | 说明 |
|---|---|---|
| 挂载行 id | `acp-workbuddy` | provider 路由随之是 `acp:acp-workbuddy`，老会话指向的就是它 |
| 宿主路由前缀 | `/acp-agent/workbuddy/*` | session / login / models / checkin / credits |
| 宿主行 id | `acp-agent-workbuddy-login` | 不改名 |
| 凭据文件 | `${DSH_HOME}/workbuddy/credentials.json` | 沿用 → 不用重新登录 |
| 勾选文件 | `${DSH_HOME}/workbuddy/selection.json` | 沿用 → 勾选不丢 |
| dock 条目 id | `acp-agent-workbuddy-quota` | 沿用 |
| 设置段 id | `acp-agent-workbuddy-account` | 沿用 |
| locale 命名空间 | `acpWorkbuddyClient`（**新**） | 不能沿用 `acpAgentClient`——两个插件注册同一命名空间会互相覆盖 |

### 四.6 迁移顺序与「每步都绿」

1. 先抽公共件：kit 建起来，agent-acp 改成用它，行为不变，全绿。
2. 再搬浏览器侧的胶囊机器进 kit，agent-acp 改用之，全绿。
3. 建新插件仓，把 WorkBuddy 的代码整体搬过去（此时两处都有 WorkBuddy，但**挂载行还没搬家**——所以不装进 profile 就不会撞）。
4. 接线：profile 里加上新插件与 kit 的 link: 依赖；新插件的 cordis.patch.yml 挂载行就位；**agent-acp 侧的挂载行此时摘掉**（否则撞 id）。
5. agent-acp 里删干净，重建客户端产物，全绿。
6. 真机验收 + 文档。

**每一步都能独立验证与回滚**（回滚 = 撤掉该步的提交）。

### 四.7 风险

| 风险 | 处置 |
|---|---|
| 抽公共件时动到 agent-acp 的行为（目录、档位折叠、胶囊） | 每步都跑全量测试；公共件的测试随代码一起搬过去，行为由测试钉住 |
| 插件间解析不到（link: 没写好） | 这是 threadharbor 踩过的坑：profile 的 package.json 必须写好 link: 依赖与 bundles，否则**静默失败**（装上了不生效、没有任何报错）。验收步骤里专门查这一点 |
| 凭据/勾选文件路径写错 → 用户要重新登录 | 沿用路径；验收时查「不用重新登录」 |
| locale 命名空间撞车 | 新插件用自己的命名空间，并在 agent-acp 里删掉 workbuddy.* 词条 |
| 两处都有 WorkBuddy 代码的那几步被误装 | 接线前不把新插件写进 profile；写进 profile 的同一步必须摘掉 agent-acp 的挂载行 |
| 客户端产物没重建 → 界面还是旧的 | 每处浏览器侧改动后都重建 `lib/client.js`（先 `tsc -p tsconfig.json` 再 `tsdown`，两步都要跑） |

## 五、验收

1. `grep -ri workbuddy dsh-acp-agent/src dsh-acp-agent/tests dsh-acp-agent/cordis.patch.yml` 无命中。
2. 桌面 profile 装上新插件与 kit；启动日志里两边的行都挂上（`acp-agent` 自报门面 18/18 之类）。
3. 模型选择器里 WorkBuddy 那组在，模型与倍率一致。
4. 设置里 WorkBuddy 那一节在：签到状态、立即签到、套餐与积分、模型清单。
5. 选 WorkBuddy 模型发一条消息：正常回；输入框下方有积分胶囊。
6. 不重新登录就能用（凭据文件仍是原路径、原内容）。
7. agent-acp：类型检查与全量测试全绿。
