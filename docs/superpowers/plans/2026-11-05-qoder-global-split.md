# Qoder 国际版拆成独立插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Qoder 国际版（`acp-qoder-global` 模型行）的全部功能从 `@goodjin2/dsh-acp-agent` 搬到新插件 `@goodjin2/dsh-qoder`，agent-acp 里不留任何 Qoder 国际版痕迹，搬完用户不用重新登录、模型勾选不丢、界面与行为一致。

**Architecture:** 复用已经存在的共享工具包 `@goodjin2/dsh-model-kit`（WorkBuddy 拆分时建的：provider 路由命名、模型行目录适配器、运行时清单账本、档位折叠、勾选文件、统一块类型）。Qoder 当模型插件要用到的「宿主侧公共件」kit 里都有，所以**本计划不动 kit**——只把 Qoder 自己的代码整体搬进新插件仓，改成用 kit 的类型与适配器。Qoder 与 WorkBuddy 一样自带一份 OpenAI 形状的 SSE 读取/请求体投影（各自持有，互不引用），新插件再挂自己的挂载行、接 profile 依赖，最后从 agent-acp 删干净。每一步都跑全量门禁，任何一步都能单独回滚。

**Tech Stack:** TypeScript 5.9（strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）、Node 22.19+ 内置 `fetch`（不引新依赖）、`proper-lockfile`（跨进程续期锁，随代码搬）、vitest 3、cordis 4、DSH 宿主插件 API（`llm` 适配器注册、`webServer`、`connection`、`slots`、`locale`）、`@deepseek-ai/schemastery`（入口 Config 声明）。

**Spec:** 本计划是 `docs/superpowers/specs/2026-11-05-workbuddy-split-design.md`（WorkBuddy 拆分设计）在 Qoder 国际版上的套用；Qoder 国际版接入的原始设计与协议边界见 `docs/superpowers/specs/2026-11-05-qoder-global-agent-design.md` 与 `docs/agent-acp/qoder-global.md`。冲突以这两个 spec 与本计划为准。

## Global Constraints

- 三个仓都在 `/Users/good/github/dsh-plugins/` 下：`dsh-acp-agent`（现有，源）、`dsh-model-kit`（现有，工具包，**本计划不改**）、`dsh-qoder`（新建，插件）。
- 每个任务都在**自己的工作树**里做（`using-git-worktrees`）：`.worktrees/<分支名>`，分支 `feat/<名字>`；工作树里的 `node_modules` 用软链指回主仓，别让 pnpm 在工作树里重装。
- 门禁（每个任务结束前跑，全绿才提交）：`./node_modules/.bin/tsc --noEmit`、`./node_modules/.bin/vitest run`。改了浏览器半边还要 `./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsdown`（两步都要跑：`tsdown` 打的是 `tsc` 编译出来的 `lib/src/`，只跑 `tsdown` 会出旧产物）。
- **不新增运行时依赖**：HTTP 用 Node 内置 `fetch`，文件读写用 `node:fs/promises`。`proper-lockfile` 是 Qoder 本就有的依赖（凭据跨进程续期锁），随代码搬进新插件，不算新增。
- **宿主是 TS strip-only 模式**：新插件的源码不得用参数属性、enum、namespace。注释、文档、文案一律中文；代码标识符英文。
- 令牌绝不进：日志、错误消息、宿主路由应答、测试快照。沿用 `src/qoder/credential.ts` 的既有做法（文件 0600、目录 0700）。
- **id 与路径全部沿用**（spec §四.5 同款规矩，搬完不用重新登录、勾选不丢、老会话继续能用）：
  - 挂载行（预设行）id `acp-qoder-global` → provider 路由随之是 `acp:acp-qoder-global`（kit 的 `providerRoute('acp-qoder-global')`）。
  - 宿主路由前缀 `/acp-agent/qoder-global/*`（session / login / models）。
  - 宿主行 id `acp-agent-qoder-login`，其 `name` 指向 `@goodjin2/dsh-qoder/qoder-login`。
  - 凭据文件 `${DSH_HOME}/qoder-global/credentials.json`（沿用 → 不用重新登录）。
  - 勾选文件 scope `qoder` → `${DSH_HOME}/qoder/selection.json`（沿用 → 勾选不丢）。
  - 设置段 id `acp-agent-qoder-account`，侧栏顺序 121。
- **locale 命名空间换新的**：新插件用 `acpQoderClient`（**不能**沿用 `acpAgentClient`——两个插件注册同一命名空间会互相覆盖，界面上词条变成键名）；agent-acp 侧删掉 `qoder.*` 与 `quota.qoder.*` 词条。
- 一个任务一次提交，提交信息用中文，动词开头（`feat:` / `fix:` / `docs:` / `refactor:` / `test:`）。
- **搬家期间两处都有 Qoder 国际版代码的那几步，不许把新插件写进 profile**——写了就会撞 id（同一时刻只能有一个插件声明 `acp-qoder-global` 这一行与 `acp:acp-qoder-global` 这条路由）。

## Review Focus

spec 说了、但没有哪条任务会顺手测到的输入与故障；每条都指到拥有它的那个任务，任务里必须有钉住它的测试。

1. **搬家后不用重新登录** → 凭据文件路径必须还是 `${DSH_HOME}/qoder-global/credentials.json`，且新插件读它、旧插件不再写它。（Task 1、Task 5）
2. **模型勾选不丢** → 勾选文件 scope 必须还是 `qoder`（路径 `${DSH_HOME}/qoder/selection.json`），不能写成 `qoder-global`。（Task 1、Task 5）
3. **两个插件同时装上时撞 id** → 同一时刻只能有一个插件声明 `acp-qoder-global` 这一行与 `acp:acp-qoder-global` 这条路由；接线的那一步必须同时摘掉旧的那一份。（Task 3）
4. **locale 命名空间撞车** → 两份词典注册同一命名空间时，后注册的把先注册的覆盖掉，界面上词条变成键名。新插件用 `acpQoderClient`，并有测试钉住。（Task 2、Task 4）
5. **客户端产物没重建** → 界面改动看不见，表现为「功能不见了」且不报错。每处浏览器侧改动后都重建 `lib/client.js`（先 `tsc -p tsconfig.json` 再 `tsdown`）。（Task 2、Task 4）
6. **插件间解析不到** → profile 的 package.json 少写 link: 依赖时**静默失败**：插件装上了却不生效，界面上一片空白且没有报错。装完必须查 `node_modules/@goodjin2/dsh-qoder` 在不在。（Task 3）
7. **Qoder 引用了 WorkBuddy 的私货** → 新插件若 `import` 了 agent-acp 的 `workbuddy/*`（`buildChatBody`、`readSseEvents`、`chunksFromOpenAiEvents`、`WorkBuddyStreamChunk`），打包能过但语义是 WorkBuddy 的（网关指纹改写、replay 状态），且把两个插件绑死。新插件必须自带这三件与块类型，归一到 kit 的 `ModelStreamChunk`。（Task 1）
8. **选择器里的 Qoder 模型清单时机** → 搬家后、第一次发消息之前，选择器应显示挂载行里声明的兜底清单（它就是站点真实 id 与倍率）；运行时清单在第一次发消息（`publishModels`）与设置里勾选存盘（`refreshQoderModels`）后才进账本。这是 agent-acp 现状（Qoder 行的 `ensureModels` 本就是空操作），新插件**不配 `ensureModels`** 就是保持它。验收时确认清单照常显示、且没在开选择器时反复起 Qoder SDK 进程。（Task 1、Task 5）

---

### Task 1: 建 `dsh-qoder` 仓，搬宿主侧的代码并改用 kit

**Files:**
- Create: `/Users/good/github/dsh-plugins/dsh-qoder/`（新 git 仓）
  - `package.json`（`name: @goodjin2/dsh-qoder`、`type: module`、`exports`：`"."` → `./src/entry.ts`、`"./qoder-login"` → `./src/qoder-login.ts`、`"./client"` → `./lib/client.js`、`"./package.json"`；`dsh.bundle.patch`、`dsh.client.platform: "web"`；依赖 `@goodjin2/dsh-model-kit`、`@deepseek-ai/schemastery`、`proper-lockfile`）
  - `tsconfig.base.json`、`tsconfig.json`、`vitest.config.ts`、`tsdown.config.ts`（照 dsh-workbuddy 的同名文件改：`id`/包名换成本包）
  - `src/entry.ts`、`src/qoder-login.ts`、`src/qoder-model.ts`
  - `src/qoder/`（`endpoints.ts`、`auth.ts`、`credential.ts`、`models.ts`、`catalog.ts`、`index.ts`、`chat.ts` + 新建 `sse.ts`、`openai.ts`）
  - `tests/qoder-endpoints.spec.ts`、`tests/qoder-auth.spec.ts`、`tests/qoder-credential.spec.ts`、`tests/qoder-models.spec.ts`、`tests/qoder-chat.spec.ts`、`tests/qoder-catalog.spec.ts`、`tests/qoder-model-plugin.spec.ts`、`tests/qoder-patch.spec.ts`
- Read (来源，不改): `dsh-acp-agent/src/qoder/*`、`src/qoder-model.ts`、`src/qoder-login.ts`、`dsh-workbuddy/src/workbuddy/sse.ts`、`dsh-workbuddy/src/workbuddy/openai.ts`、`dsh-model-kit/src/{types,model-row-adapter,runtime-models,selection,provider-route,efforts}.ts`、`dsh-acp-agent/src/client/qoder-account-section.tsx`（只为 Task 2 备料）

**Interfaces:**
- Consumes: kit 的 `providerRoute(presetId)`、`modelRowAdapter(options)`、`runtimeModels()`、`readSelection(scope, file?)`、`writeSelection(scope, ids, file?)`，类型 `ModelTurnRequest`、`ModelStreamChunk`、`CatalogModel`、`ReportedModel`。
- Produces（Task 2/3 按这些用）：
  ```ts
  // src/entry.ts
  export const name = '@goodjin2/dsh-qoder'
  export const Config: Schema<Config>   // schemastery
  export type Config = {
    presetId: string; agent: string
    models?: { id: string; name: string; description?: string; contextWindow?: number }[]
    collapseEfforts?: boolean; hideFromRoster?: boolean
    efforts?: { id: string; name?: string }[]
  }
  export function apply(ctx: unknown, config: Config): void
  // src/qoder-login.ts（宿主登录路由入口，Loader 行 ./qoder-login）
  export const name = 'acp-agent-qoder-login'
  export const inject = ['webServer', 'connection']
  export const SESSION_PATH = '/acp-agent/qoder-global/session'
  export const LOGIN_PATH = '/acp-agent/qoder-global/login'
  export const MODELS_PATH = '/acp-agent/qoder-global/models'
  export function apply(ctx: QoderRouteContext): void
  export function registerQoderRoutes(ctx: QoderRouteContext, deps?: QoderRouteDeps): void
  // src/qoder-model.ts（模型流；接进 entry.ts 的 modelStream）
  export function qoderModelStream(config: PresetConfig, deps?: { onRuntimeModels?: (presetId: string, models: readonly ReportedModel[]) => void }): (presetId: string, request: ModelTurnRequest) => AsyncIterable<ModelStreamChunk> | undefined
  ```

- [ ] **Step 1: 建仓**

```bash
cd /Users/good/github/dsh-plugins && mkdir dsh-qoder && cd dsh-qoder && git init
```

写 `package.json`（名字 `@goodjin2/dsh-qoder`、`exports` 如上、`files` 含 `LICENSE`/`README.md`/`cordis.patch.yml`/`lib/client.js`/`lib/client.js.map`/`src/**/*.ts`/`tsdown.config.ts`、`scripts.typecheck/test/build/build:client` 照 dsh-workbuddy、`dsh` 段照 dsh-acp-agent（`bundle.patch` + `client.platform: "web"` + `client.inject` 列 UI 包）、依赖 `@goodjin2/dsh-model-kit: link:../dsh-model-kit` + `@deepseek-ai/schemastery` + `proper-lockfile`、devDeps 含 `react`/`react-dom`/`tsdown`/`typescript`/`vitest`/`lightningcss`/`@types/node`/`@types/proper-lockfile`/`@types/react` + 浏览器侧 `@deepseek-ai/dsh-client-ui-*`）。`tsconfig.base.json`/`tsconfig.json`/`vitest.config.ts`/`tsdown.config.ts` 照 dsh-workbuddy 抄，只把 `id` 换成 `@goodjin2/dsh-qoder`。

```bash
pnpm install
```

- [ ] **Step 2: 搬自足的叶子模块与其测试**

```bash
git -C ../dsh-acp-agent archive HEAD src/qoder/endpoints.ts src/qoder/auth.ts src/qoder/credential.ts src/qoder/models.ts src/qoder/catalog.ts src/qoder/index.ts tests/qoder-endpoints.spec.ts tests/qoder-auth.spec.ts tests/qoder-credential.spec.ts tests/qoder-models.spec.ts tests/workbuddy-qoder-catalog.spec.ts | tar -x
```

把 `tests/workbuddy-qoder-catalog.spec.ts` 改名为 `tests/qoder-catalog.spec.ts`（它测的是 `src/qoder/catalog.ts` 的 SDK 拉清单，名字里的 workbuddy 是历史残留）。这些叶子模块自足（端点/登录/凭据/清单/SDK 目录），**逐字搬，不改行为与注释**。

Run: `./node_modules/.bin/vitest run tests/qoder-endpoints.spec.ts tests/qoder-auth.spec.ts tests/qoder-credential.spec.ts tests/qoder-models.spec.ts tests/qoder-catalog.spec.ts` → 全 PASS。

- [ ] **Step 3: 新建 `src/qoder/sse.ts`（OpenAI 形状的 SSE 读取与块翻译，归一到 kit 的块类型）**

照 `dsh-workbuddy/src/workbuddy/sse.ts` 抄，做三处改动，其余逐字保留（含工具调用按 `index` 归并、块序号按首次出现分配、usage/finish 判定）：

- 块类型从 `WorkBuddyStreamChunk` 换成 kit 的 `ModelStreamChunk`（`import type { ModelStreamChunk } from '@goodjin2/dsh-model-kit'`）；`WorkBuddyBlock`/`WorkBuddyUsage`/`WorkBuddyFinish` 换成等价的本地 `QoderBlock`/`QoderUsage`/`QoderFinish`（结构照旧）。
- `chunksFromOpenAiEvents` 的 finish 块**去掉 `replayState` 字段**（kit 的 `ModelStreamChunk` 的 finish 没有它；Qoder 不走网关重放）。其余 yield 的形状不变。
- `readSseEvents` 逐字保留。

签名：`export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown>`、`export async function* chunksFromOpenAiEvents(events: AsyncIterable<unknown>): AsyncGenerator<ModelStreamChunk>`。

- [ ] **Step 4: 新建 `src/qoder/openai.ts`（OpenAI Chat Completions 请求体，去掉网关指纹改写）**

照 `dsh-workbuddy/src/workbuddy/openai.ts` 抄，做两处改动：

- **删掉网关指纹那一层**：去掉 `import { sanitizeGatewayText }`、`gatewayTextMode` 字段，以及 `buildChatBody`/`projectMessages`/`assistantMessage` 里所有 `sanitizeGatewayText(...)` 调用，直接用原文。（Qoder 是国际版，没有国内网关指纹问题；WorkBuddy 的网关改写是它的私货，不进 Qoder。）
- 类型改名：`WorkBuddy*` → `Qoder*`（`QoderContentPart`/`QoderToolCall`/`QoderMessage`/`QoderTool`/`QoderBody`/`QoderChatBodyInput`）。`buildChatBody(input: QoderChatBodyInput): QoderBody` 的其余投影（消息投影、工具 schema、推理档位、相邻用户消息合并、图片按能力退化成占位）逐字保留。

`QoderChatBodyInput` 字段：`model`、`messages`、`system?`、`tools?`、`maxTokens?`、`reasoningEffort?`、`supportsImages?`（**没有** `gatewayTextMode`）。

- [ ] **Step 5: 搬并改 `src/qoder/chat.ts`**

从 agent-acp 搬过来，改三处 import 与类型：

- `../workbuddy/openai.ts` 的 `buildChatBody` → `./openai.ts` 的 `buildChatBody`。
- `../workbuddy/sse.ts` 的 `chunksFromOpenAiEvents`/`readSseEvents` → `./sse.ts`；`WorkBuddyStreamChunk` → kit 的 `ModelStreamChunk`（`streamQoder` 的返回类型变 `AsyncGenerator<ModelStreamChunk>`）。
- `../catalog.ts` 的 `CatalogTurnRequest` → kit 的 `ModelTurnRequest`（`import type { ModelTurnRequest } from '@goodjin2/dsh-model-kit'`）。
- `../selection.ts` 的 `baseIdOf` → 本仓自带的 `baseIdOf`（见 Step 8，8 行的小函数，复制过来）。

请求头、SSE 读取、401 续期重试、错误分类、`checkedEvents`（没有结束帧算中断）逐字保留。

- [ ] **Step 6: 搬并改 `src/qoder-model.ts`**

从 agent-acp 搬过来，改四处：

- `./catalog.ts` 的 `CatalogTurnRequest` → kit 的 `ModelTurnRequest`。
- `./workbuddy/sse.ts` 的 `WorkBuddyStreamChunk` → kit 的 `ModelStreamChunk`（`answer()` 的返回类型与 `qoderModelStream` 的返回类型都改）。
- `./model-selection.ts` 的 `readSelection` → kit 的 `readSelection`（`import { readSelection } from '@goodjin2/dsh-model-kit'`）。仍按 scope `qoder` 读（不变）。
- 其余（清单账本对接、TTL/重试、按模型过滤档位与最大 token 字段名、白名单合并）逐字保留。

`qoderModelStream` 的签名对齐 Interfaces：`qoderModelStream(config, deps?) => (presetId, request: ModelTurnRequest) => AsyncIterable<ModelStreamChunk> | undefined`——这正是 kit `modelRowAdapter` 的 `modelStream` 形状。

- [ ] **Step 7: 搬并改 `src/qoder-login.ts`（宿主登录路由）**

从 agent-acp 搬过来，改三处：

- `./workbuddy-login.ts` 的 `WorkBuddyRouteContext` → 本仓自带的本地窄接口 `QoderRouteContext`（见 Step 8）。`apply(ctx: QoderRouteContext)` 仍调 `registerQoderRoutes(ctx)`。
- `./model-selection.ts` 的 `readSelection`/`writeSelection` → kit 的（仍按 scope `qoder`）。
- 路由常量、`SESSION_PATH`/`LOGIN_PATH`/`MODELS_PATH`、`registerQoderRoutes` 的全部行为（admit 准入、404 当等待态、跨进程续期锁、清单缓存、勾选后重发清单）逐字保留。

- [ ] **Step 8: 复制 `baseIdOf` 与 `QoderRouteContext` 两个本地小件**

新插件不能 import agent-acp 的 `selection.ts`/`workbuddy-login.ts`。各补一份本地窄接口：

- `baseIdOf(id: string): string`（摘 `[effort]` 后缀）：从 agent-acp `src/selection.ts` 逐字复制（8 行，纯函数，无依赖）。
- `QoderRouteContext`：从 agent-acp `src/workbuddy-login.ts` 的 `WorkBuddyRouteContext` 形状复制（`effect`/`webServer.register`/`connection.admit`），改名即可。`QoderRouteDeps` 仍照 `qoder-login.ts` 现有形状（`startLogin`/`pollForToken`/`readCredential`/`writeCredential`/`fetchModels?`/`readSelection?`/`writeSelection?`）。

- [ ] **Step 9: 新建 `src/entry.ts`（宿主侧入口，只做模型行三件事）**

照 `dsh-workbuddy/src/entry.ts` 的结构新建一个**只有模型行职责**的入口：

- `Config`（schemastery）声明 `presetId`（必填）、`agent`、`models`、`collapseEfforts`、`hideFromRoster`、`efforts`。**不抄** agent-acp 的调度/接管/审批/网关那部分——模型行不需要，也不声明 `stallMs`（那是 ACP 网关看门狗的字段；模型行由原生循环直接应答，kit 的 `modelRowAdapter` 没有看门狗，WorkBuddy 的 `acp-workbuddy` 行同样不声明它）。preset 行里残留的 `stallMs: 300000` 由 schemastery 在 schema 里没声明就丢弃，无害。
- `apply(ctx, config)` 三件事：
  1. `const ledger = runtimeModels()`；`onRuntimeModels = (presetId, models) => ledger.record(presetId, models)`。
  2. `const adapter = modelRowAdapter({ presetId: config.presetId, displayName: 'Qoder 国际版', declaredModels: config.models ?? [], runtimeModelsOf: (presetId) => ledger.modelsOf(presetId), modelStream: qoderModelStream(presets, { onRuntimeModels }), collapseEfforts: config.collapseEfforts, efforts: config.efforts })`。其中 `presets` 是把 `config` 折回 `{ presets: { [config.presetId]: { agent: config.agent, models: config.models } } }`（`qoderModelStream` 靠它认行；**调用它本身就有副作用**——扫 `config.presets` 把这一行的发布口登记进 `qoder-model.ts` 的 `publishers`，所以必须在 `apply` 里调用一次，后面的流与登录路由才找得到发布口）。
     **不配 `ensureModels`**：agent-acp 现在给 Qoder 行的 `ensureModels` 是空操作（`plugin.ts` 只给 WorkBuddy 配了 `ensureWorkBuddyModels`），Qoder 的运行时清单是在**第一次发消息**（`answer()` 里的 `publishModels`，带 24h/5min TTL）与**设置里勾选存盘**（`qoder-login.ts` 调 `refreshQoderModels`）时写进账本的；在那之前选择器显示挂载行里声明的兜底清单——而那份兜底就是站点真实的 id 与倍率（见 cordis 注释），所以显示是对的。配一个会空转的 `ensureModels` 反而可能每次开选择器都起一次 Qoder SDK 进程（几秒）。**保持现状 = 不配 `ensureModels`**（kit 的适配器对 `undefined` 直接跳过）。
  3. `registryOf(ctx)?.registerAdapter([providerRoute(config.presetId)], adapter)`——取不到宿主模型目录就写一行 stderr 提示后安静返回（装上了但目录没接上，最常见的一种「不生效」）。
- 复用 dsh-workbuddy `entry.ts` 的 `registryOf(ctx)`（走 `get('llm')` 与直读两条路，取不到当没有目录）。

- [ ] **Step 10: 搬并改测试**

- `tests/qoder-chat.spec.ts`：从 agent-acp 搬，import 路径不变（`../src/qoder/chat.ts`）；若断言里出现 `WorkBuddyStreamChunk` 改成 `ModelStreamChunk`（kit）。
- `tests/qoder-model-plugin.spec.ts`（新）：从 agent-acp 的 `tests/qoder-model.spec.ts` 搬，**只保留 `qoderModelStream` 的断言**（只认 `qoder-global` 行、清单写进账本、白名单、清单拉不到不每轮撞上游、内置模型用对 max-tokens 字段名、不支持的档位不下发）。**删掉** `isModelBackedAgent`/`modelPluginStream` 的那条断言——那是 agent-acp `model-plugins.ts` 的内部名单，新插件没有这个文件（行由 entry.ts 直接接进 kit 适配器）。
- `tests/qoder-patch.spec.ts`（新）：从 agent-acp 的 `tests/qoder-global.spec.ts` 搬，改成查**本仓**的 `cordis.patch.yml`（Task 3 才写，本任务先放一条占位断言或先 skip 到 Task 3 补）与 `package.json` 的 exports（`./qoder-login`、`./client` 都在）。**删掉** `EXPECTED_ROWS` 那条（那是 agent-acp 的自报健康行）。

- [ ] **Step 11: 跑门禁，确认通过**

Run: `./node_modules/.bin/vitest run` → 全 PASS；`./node_modules/.bin/tsc --noEmit` → 无输出。

- [ ] **Step 12: 提交**

```bash
git add -A && git commit -m "feat(qoder): 独立插件的宿主侧（端点、登录、凭据、清单、请求、模型行入口）"
```

---

### Task 2: 搬浏览器侧（账号段、词条、共享 UI、客户端入口）

**Files:**
- Create: `dsh-qoder/src/client/index.ts`、`dsh-qoder/src/client/locales.ts`、`dsh-qoder/src/client/qoder-account-section.tsx`、`dsh-qoder/src/client/account-panel.tsx`、`dsh-qoder/src/client/model-checklist.tsx`
- Create: `dsh-qoder/tests/qoder-account-section.spec.ts`
- Modify: `dsh-qoder/package.json`（`files` 已含 `lib/client.js`，无需改 exports——`./client` 在 Task 1 已声明）

**Interfaces:**
- Consumes: Task 1 的 `@goodjin2/dsh-qoder/qoder-login`（路由路径常量，客户端直接写字面量路径也与之一致）、kit 的 `./client`（本任务不用胶囊机器——Qoder 没有配额胶囊）。
- Produces: 新插件的浏览器侧入口 `./client`（产物 `lib/client.js`）、locale 命名空间 `acpQoderClient`、设置段 id `acp-agent-qoder-account`（顺序 121）。

- [ ] **Step 1: 写失败测试**

`tests/qoder-account-section.spec.ts`：从 agent-acp 的 `tests/qoder-account-section.spec.ts` 搬，import 指向本仓 `src/client/…`。再加一条**命名空间**用例（本插件的词典不能注册在 `acpAgentClient` 上——两个插件注册同一命名空间会互相覆盖，界面上词条变成键名）：

```ts
it('本插件的 locale 命名空间是自己的，不是 acpAgentClient', () => {
  expect(NAMESPACE).toBe('acpQoderClient')
  expect(NAMESPACE).not.toBe('acpAgentClient')
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `./node_modules/.bin/vitest run tests/qoder-account-section.spec.ts` → FAIL（模块还没有）。

- [ ] **Step 3: 实现**

- `src/client/locales.ts`：**新的命名空间** `acpQoderClient`。把 agent-acp `src/client/locales.ts` 里的 `qoder.section.label`、`qoder.account.{signedIn,signedOut,login,relogin,refresh}` 词条搬过来（中英各一份）；`NAMESPACE`/`fallbackT`/`zh`/`en` 照 agent-acp 同名文件的结构。**DeepSeek/WorkBuddy/其它家的词条不搬**。`RuntimeT` 类型照旧。
- `src/client/account-panel.tsx`：从 agent-acp 逐字复制（48 行，纯样式对象，无 import）。
- `src/client/model-checklist.tsx`：从 agent-acp 逐字复制（206 行，只 import `fallbackT`——指向本仓的 `./locales.ts`）。
- `src/client/qoder-account-section.tsx`：从 agent-acp 搬，改两处：
  - `import { NAMESPACE, fallbackT } from './locales.ts'`（本仓的）；
  - `import type { WorkBuddyAccountSlotHost } from './workbuddy-account-section.tsx'` → 换成本地 `QoderAccountSlotHost`（形状同 agent-acp：`{ inject(key, cb): unknown; register(options, component): unknown }`）。`registerQoderAccountSection(slots: QoderAccountSlotHost, label, t?)` 的签名跟着改。
  - 路由常量、视图纯函数、`QoderAccountSection` 组件逐字保留。
- `src/client/index.ts`：照 agent-acp 的客户端入口抄一份**只做三件事**：注册本插件词典（`ctx.locale.register('acpQoderClient', { zh, en })`，disposer 挂 `ctx.effect`）、注册 Qoder 账号段（`registerQoderAccountSection(slots, () => t('qoder.section.label'), t)`）、返回收尾 disposer。**不抄** agent-acp 的 model label/配额胶囊/ACP 可见性/接管卡片等——那些是 ACP 框架与 DeepSeek/WorkBuddy 的私事，Qoder 只需要账号段。`apply` 的 `safeRegister`/`say` 兜底照抄（一个表面报错不该让整条客户端 entry 失败）。

- [ ] **Step 4: 跑测试与构建**

```bash
./node_modules/.bin/vitest run tests/qoder-account-section.spec.ts
./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsdown
grep -c "acp-agent-qoder-account" lib/client.js
```

Expected: 测试 PASS；`lib/client.js` 里应有账号段 id（`grep` ≥ 1）。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(qoder): 独立插件的浏览器侧（账号设置段、词条、客户端入口）"
```

---

### Task 3: 接线——挂载行搬家 + profile 依赖

**Files:**
- Create: `dsh-qoder/cordis.patch.yml`
- Modify: `dsh-acp-agent/cordis.patch.yml`（**摘掉** `acp-qoder-global` 预设行与 `acp-agent-qoder-login` 宿主行）
- Modify: `~/.dsh/profiles/desktop/package.json`（加 link: 依赖与 bundles）

**Interfaces:**
- Consumes: Task 1/2 的包。
- Produces: 桌面 profile 里装上新插件，Qoder 国际版那行由新插件提供；agent-acp 不再声明该行。

- [ ] **Step 1: 新插件写自己的挂载行**

`dsh-qoder/cordis.patch.yml` 三行（照 agent-acp 现有那三行抄，binding 指向本包）：

- 预设行 `acp-qoder-global`（`name: '@deepseek-ai/dsh-agent-preset'`）：`config` 里 `id: acp-qoder-global`、`name: Qoder 国际版`、`order: 56`、`plugins: [ { id: acp-qoder-global-binding, name: '@goodjin2/dsh-qoder', config: { presetId: acp-qoder-global, agent: qoder-global, hideFromRoster: true, stallMs: 300000, efforts: [low/medium/high/max/xhigh], models: […15 条兜底清单…] } } ]`。**模型清单、`efforts`、`order: 56`、`stallMs: 300000` 逐字照 agent-acp 现有 `acp-qoder-global` 行抄**（只把 binding 的 `name` 从 `@goodjin2/dsh-acp-agent` 改成 `@goodjin2/dsh-qoder`）。`collapseEfforts` 不写（默认折叠，与现状一致）。
- 宿主行 `acp-agent-qoder-login`（`name: '@goodjin2/dsh-qoder/qoder-login'`）。
- 浏览器半边行 `acp-qoder-client`（`name: '@goodjin2/dsh-qoder'`，`config: { clientOnly: true, presetId: acp-qoder-client, agent: codex }`）：DSH 不按 `package.json` 的 `dsh.client` 自动装载浏览器包，只有 name 恰好等于包名的 Loader 行才会进 `window.__DSH_BOOT__`；少了这一行，设置里的 Qoder 账号段整块不注册且宿主日志一个字没有。

- [ ] **Step 2: agent-acp 摘掉那两行（同一步做）**

在 agent-acp 的 `cordis.patch.yml` 里删掉 `acp-qoder-global` 预设行（含其 binding）与 `acp-agent-qoder-login` 宿主行。**同一步做**，否则两个插件同时声明同一行 id 与同一条路由。（agent-acp 里的 Qoder **代码**留到 Task 4 删——代码留着不影响运行，profile 里已经不挂那两行了。）

- [ ] **Step 3: profile 接线**

`~/.dsh/profiles/desktop/package.json`：`dependencies` 加 `"@goodjin2/dsh-qoder": "link:/Users/good/github/dsh-plugins/dsh-qoder"`（kit 已由 agent-acp 的 `link:../dsh-model-kit` 解析进 profile，无需再加）；`dsh.profile.bundles` 数组加 `"@goodjin2/dsh-qoder"`。

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

**装完必须查解析**：确认 `node_modules/@goodjin2/dsh-qoder` 在（少一个就是静默失败：装上了不生效、界面上什么都没有）。`node_modules/@goodjin2/dsh-model-kit` 也应在（由 agent-acp 带入）。

- [ ] **Step 4: 提交**

```bash
cd /Users/good/github/dsh-plugins/dsh-qoder && git add cordis.patch.yml && git commit -m "feat(qoder): 自己的挂载行（预设行、登录路由行、浏览器半边行）"
cd ../dsh-acp-agent && git add cordis.patch.yml && git commit -m "refactor(acp-agent): Qoder 国际版的挂载行交给独立插件"
```

---

### Task 4: 从 agent-acp 里删干净

**Files:**
- Delete: `dsh-acp-agent/src/qoder/`（整个目录）、`src/qoder-model.ts`、`src/qoder-login.ts`、`src/client/qoder-account-section.tsx`
- Delete: `dsh-acp-agent/tests/qoder-*.spec.ts`（含 `workbuddy-qoder-catalog.spec.ts`，Task 1 已搬走）
- Modify: `dsh-acp-agent/package.json`（删 `./qoder-login` 导出）、`src/model-plugins.ts`、`src/catalog.ts`、`src/health.ts`、`src/client/index.ts`、`src/client/locales.ts`

**Interfaces:**
- Consumes: Task 1/2/3。
- Produces: agent-acp 里没有任何 Qoder 国际版痕迹；CN 版 `acp-qoder`（走 ACP 的 Qoder CN）与所有其它行行为不变。

- [ ] **Step 1: 删代码与接线**

按 spec §四.3 逐项删：

- `package.json`：删 `exports` 里的 `"./qoder-login"`。
- `src/model-plugins.ts`：删 `import { qoderModelStream }`、`plugins` 数组里的 `qoderModelStream(config, deps)`、`MODEL_BACKED_AGENTS` 里的 `'qoder-global'`。
- `src/catalog.ts`：删 `DISPLAY` 表里的 `'qoder-global': 'Qoder 国际版'`。
- `src/health.ts`：删 `EXPECTED_ROWS` 里的 `acp-qoder-global` 与 `acp-agent-qoder-login` 两行。
- `src/client/index.ts`：删 `import { registerQoderAccountSection }` 与 `registerQoderAccountSection(slots, …)` 调用。
- `src/client/locales.ts`：删 `qoder.section.label`/`qoder.account.*` 的 zh/en 词条与类型联合里的那几行（`'qoder.section.label'`、`'qoder.account.signedIn'|'signedOut'|'login'|'relogin'|'refresh'`）。
- 删文件：`src/qoder/`、`src/qoder-model.ts`、`src/qoder-login.ts`、`src/client/qoder-account-section.tsx`、`tests/qoder-*.spec.ts`。

**注意别误删 CN 版**：`acp-qoder`（`agent: qoder`）、`dialects/qoder.ts`、`qoderProgressProbe`、`stdioEnvFor('qoder')` 那些是**国内版** ACP agent，与本次无关，一行都不动。

- [ ] **Step 2: 跑门禁与构建**

```bash
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run
./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsdown
grep -c "qoder-global" lib/client.js
```

Expected: 测试全绿（与改动前同样红绿；若改动前就有红的，红的还是同一批，本任务不许新增红灯）；产物里 `grep -c qoder-global` 应为 0。

- [ ] **Step 3: 查干净了没**

```bash
grep -rni "qoder-global\|qoderGlobal" src tests cordis.patch.yml package.json
```

Expected: 无命中（`docs/agent-acp/qoder-global.md` 与 README 里的国际版段落，Task 5 一并处理）。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "refactor(acp-agent): 删掉 Qoder 国际版（已搬进独立插件）"
```

---

### Task 5: 真机验收与文档

**Files:**
- Create: `dsh-qoder/README.md`、`dsh-qoder/docs/agent-acp/qoder-global.md`（从 agent-acp 搬过去并改写归属）
- Modify: `dsh-acp-agent/docs/agent-acp/qoder-global.md`（删或改指向新插件）、`dsh-acp-agent/README.md` 与 `README.zh.md`、`docs/agent-acp/README.md`（国际版段落指向新插件）
- Modify: `/Users/good/github/dsh-plugins/AGENTS.md`（仓库清单补 `dsh-model-kit`/`dsh-workbuddy`/`dsh-qoder`，条数与归属映射对齐；「外部 agent / 模型行」归属里 Qoder 国际版指向 `dsh-qoder`）

**Interfaces:**
- Consumes: 前面全部。
- Produces: 文档与容器清单对齐；三个仓都能从 GitHub 正常安装。

- [ ] **Step 1: 搬文档**

`dsh-acp-agent/docs/agent-acp/qoder-global.md` 搬到 `dsh-qoder/docs/agent-acp/qoder-global.md`，开头的归属改成新插件（「这一篇是国际版，由 `@goodjin2/dsh-qoder` 提供」）。agent-acp 的 README（`README.md`/`README.zh.md`/`docs/agent-acp/README.md`）里「Qoder 国际版」那一段：保留「国内版 ACP 预置」一句，国际版改为指向 `@goodjin2/dsh-qoder`。

- [ ] **Step 2: 写新插件 README**

`dsh-qoder/README.md`：说清这个插件是什么（Qoder 国际版模型行：宿主侧设备码登录、清单、OpenAI 兼容的模型流；浏览器侧账号设置段）、依赖 `@goodjin2/dsh-model-kit`、挂载行 id（`acp-qoder-global` / `acp-agent-qoder-login` / `acp-qoder-client`）、凭据与勾选文件路径（`${DSH_HOME}/qoder-global/credentials.json`、`${DSH_HOME}/qoder/selection.json`）、环境变量覆盖（`QODER_*_BASE`/`QODER_LOGIN_BASE` 等，照 `endpoints.ts`）。

- [ ] **Step 3: 更新容器 AGENTS.md**

仓库清单：当前文档写「6 个仓库」已过时（WorkBuddy 拆分已加了 `dsh-model-kit` 与 `dsh-workbuddy`，本次再加 `dsh-qoder`）。把清单与条数改成实际，归属映射里「外部 agent 接入 / 模型行」一项补：Qoder 国际版 → `dsh-qoder`；并注明 `dsh-qoder` 与 `dsh-workbuddy` 都依赖 `dsh-model-kit`、彼此互不依赖。

- [ ] **Step 4: 真机验收（逐条）**

1. `grep -rni "qoder-global" dsh-acp-agent/src dsh-acp-agent/tests dsh-acp-agent/cordis.patch.yml` 无命中；
2. 重启 DSH 桌面 App，启动日志里 `acp-qoder-global` 行由 `@goodjin2/dsh-qoder` 挂上（新插件那一行），agent-acp 自报门面仍在；
3. 模型选择器里「Qoder 国际版」那组在，15 个模型与倍率一致；
4. 设置里「Qoder 国际版账号」段在：登录、检查授权、模型清单（勾选）；
5. 选一个 Qoder 模型发一条消息能回；模型清单登录后能拉到（选择器以运行时清单为准）；
6. **不用重新登录**就能用（凭据文件仍是 `${DSH_HOME}/qoder-global/credentials.json`、原内容）；
7. **模型勾选不丢**（`${DSH_HOME}/qoder/selection.json` 还在原路径、原内容）；
8. **长回合不被误杀**：选一个会长时间思考（几十秒不出帧）的模型发一条长消息，确认能正常回——模型行经 kit 适配器应答，没有看门狗；若宿主对模型行有默认 120 秒超时会把它杀掉，则在此暴露，需给 kit 的 `modelRowAdapter` 加一个超时档（这是本计划唯一可能反直觉的点，重点验这一条）；
9. agent-acp：类型检查与全量测试全绿。

- [ ] **Step 5: 提交与推送**

```bash
cd /Users/good/github/dsh-plugins/dsh-qoder && git add -A && git commit -m "docs(qoder): 独立插件的说明与对照"
cd ../dsh-acp-agent && git add -A && git commit -m "docs(acp-agent): Qoder 国际版指向独立插件"
```

三个仓（`dsh-qoder`、`dsh-acp-agent`、`dsh-model-kit` 若动过）各自 `git push`；新插件要能从 GitHub 正常安装——确认 `dsh-qoder/package.json` 的 `name`/`version`/`repository` 与 `main` 分支上的可发布状态都对。
