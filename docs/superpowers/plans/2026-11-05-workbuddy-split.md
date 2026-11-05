# WorkBuddy 拆成独立插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 WorkBuddy 的全部功能从 `@goodjin2/dsh-acp-agent` 搬到新插件 `@goodjin2/dsh-workbuddy`，agent-acp 里不留任何 WorkBuddy 痕迹，搬完用户不用重新登录、模型勾选不丢、界面与行为一致。

**Architecture:** 先把「模型行」的公共机制抽成共享工具包 `@goodjin2/dsh-model-kit`（provider 路由命名、模型行目录适配器、清单账本、档位折叠、勾选文件、块类型，以及浏览器侧的配额胶囊机器），agent-acp 改用它并保持行为不变；再建独立插件仓把 WorkBuddy 整体搬过去；最后从 agent-acp 删干净。每一步都跑全量门禁，任何一步都能单独回滚。

**Tech Stack:** TypeScript 5.9（strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）、Node 22.19+ 内置 `fetch`（不引新依赖）、vitest 3、cordis 4、DSH 宿主插件 API（`llm` 适配器注册、`webServer`、`connection`、`slots`、`locale`）。

**Spec:** `docs/superpowers/specs/2026-11-05-workbuddy-split-design.md`（同仓，先读它；本计划是它的可执行化，冲突以 spec 为准）

## Global Constraints

- 三个仓都在 `/Users/good/github/dsh-plugins/` 下：`dsh-model-kit`（新，工具包）、`dsh-acp-agent`（现有）、`dsh-workbuddy`（新，插件）。
- 每个任务都在**自己的工作树**里做（`using-git-worktrees`）：`.worktrees/<分支名>`，分支 `feat/<名字>`；工作树里的 `node_modules` 用软链指回主仓，别让 pnpm 在工作树里重装。
- 门禁（每个任务结束前跑，全绿才提交）：`./node_modules/.bin/tsc --noEmit`、`./node_modules/.bin/vitest run`。改了浏览器半边还要 `./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsdown`（两步都要跑：`tsdown` 打的是 `tsc` 编译出来的 `lib/src/`，只跑 `tsdown` 会出旧产物）。
- **不新增运行时依赖**：HTTP 用 Node 内置 `fetch`，文件读写用 `node:fs/promises`。
- **宿主是 TS strip-only 模式**：kit 与新插件的源码不得用参数属性（constructor parameter properties）、enum、namespace——它们会被宿主直接加载。注释、文档、文案一律中文；代码标识符英文。
- 令牌绝不进：日志、错误消息、宿主路由应答、测试快照。沿用 `src/workbuddy/chat.ts` 的 `scrub`。
- **id 与路径全部沿用**（spec §四.5）：挂载行 `acp-workbuddy`、provider 路由 `acp:acp-workbuddy`、宿主路由前缀 `/acp-agent/workbuddy/*`、宿主行 `acp-agent-workbuddy-login`、凭据 `${DSH_HOME}/workbuddy/credentials.json`、勾选 `${DSH_HOME}/workbuddy/selection.json`、dock 条目 `acp-agent-workbuddy-quota`、设置段 `acp-agent-workbuddy-account`。
- **locale 命名空间换新的**：新插件用 `acpWorkbuddyClient`（不能用 `acpAgentClient`——两个插件注册同一命名空间会互相覆盖）；agent-acp 侧删掉 `workbuddy.*` 词条。
- 一个任务一次提交，提交信息用中文，动词开头（`feat:` / `fix:` / `docs:` / `refactor:` / `test:`）。
- **搬家期间两处都有 WorkBuddy 代码的那几步，不许把新插件写进 profile**——写了就会撞 id（spec §3.1）。

## Review Focus

spec 说了、但没有哪条任务会顺手测到的输入与故障；每条都指到拥有它的那个任务，任务里必须有钉住它的测试。

1. **搬家后不用重新登录** → 凭据文件路径必须还是 `${DSH_HOME}/workbuddy/credentials.json`，且新插件读它、旧插件不再写它。（Task 4、Task 7）
2. **模型勾选不丢** → 勾选文件路径必须还是 `${DSH_HOME}/workbuddy/selection.json`。（Task 1、Task 5）
3. **两个插件同时装上时撞 id** → 同一时刻只能有一个插件声明 `acp-workbuddy` 这一行与 `acp:acp-workbuddy` 这条路由；接线的那一步必须同时摘掉旧的那一份。（Task 6）
4. **locale 命名空间撞车** → 两份词典注册同一命名空间时，后注册的把先注册的覆盖掉，界面上词条变成键名。（Task 5、Task 7）
5. **客户端产物没重建** → 界面改动看不见，表现为「功能不见了」且不报错。（Task 5、Task 7）
6. **插件间解析不到** → profile 的 package.json 少写 link: 依赖时**静默失败**：插件装上了却不生效，界面上一片空白且没有报错。（Task 6）

---

### Task 1: 建 `dsh-model-kit` 仓，抽出宿主侧的公共件

**Files:**
- Create: `/Users/good/github/dsh-plugins/dsh-model-kit/`（新 git 仓）
  - `package.json`（`name: @goodjin2/dsh-model-kit`、`type: module`、`exports`：`"."` → `./src/index.ts`）
  - `tsconfig.json`、`tsconfig.base.json`、`vitest.config.ts`（照 dsh-acp-agent 的同名文件改路径）
  - `src/provider-route.ts`、`src/runtime-models.ts`、`src/efforts.ts`、`src/selection.ts`、`src/types.ts`、`src/model-row-adapter.ts`、`src/index.ts`
  - `tests/provider-route.spec.ts`、`tests/runtime-models.spec.ts`、`tests/efforts.spec.ts`、`tests/selection.spec.ts`、`tests/model-row-adapter.spec.ts`
- Read (来源，不改): `dsh-acp-agent/src/catalog.ts`（`providerRoute`、`presetOfRoute`、`collapseEffortModels`、`collapsedToCatalog`、`CatalogModel`）、`dsh-acp-agent/src/catalog-registration.ts`（`runtimeModels`）、`dsh-acp-agent/src/model-selection.ts`、`dsh-acp-agent/src/selection.ts`（`baseIdOf`）

**Interfaces:**
- Consumes: 无（这是最底层的一个任务）。
- Produces（后续任务按这些名字用）：
  ```ts
  // src/provider-route.ts
  export function providerRoute(presetId: string): string
  export function presetOfRoute(route: string): string | undefined
  // src/runtime-models.ts
  export type ReportedModel = { readonly id: string; readonly name: string; readonly description?: string }
  export interface RuntimeModels {
    record(presetId: string, models: readonly ReportedModel[]): void
    modelsOf(presetId: string): readonly ReportedModel[] | undefined
  }
  export function runtimeModels(): RuntimeModels
  // src/efforts.ts
  export type CollapsedModel = { readonly baseId: string; readonly displayName: string; readonly description?: string; readonly efforts?: readonly string[] }
  export function collapseEffortModels(models: readonly { id: string; name: string; description?: string }[]): CollapsedModel[]
  export function collapsedToCatalog(provider: string, model: CollapsedModel, efforts?: readonly string[]): CatalogModel
  // src/selection.ts
  export function selectionFilePath(scope: string, env?: NodeJS.ProcessEnv): string
  export function readSelection(scope: string, file?: string): Promise<readonly string[] | undefined>
  export function writeSelection(scope: string, ids: readonly string[], file?: string): Promise<void>
  // src/types.ts
  export type CatalogModel = { readonly provider: string; readonly id: string; readonly name: string; readonly description?: string }
  export type ModelTurnRequest = {
    readonly provider: string; readonly model: string
    readonly reasoningEffort?: unknown; readonly sessionId?: unknown
    readonly messages?: readonly unknown[]; readonly purpose?: unknown; readonly signal?: unknown
    readonly tools?: readonly { readonly name: string; readonly description?: string; readonly parameters?: Record<string, unknown> }[]
    readonly system?: unknown; readonly maxTokens?: unknown
  }
  export type ModelStreamChunk =
    | { readonly type: 'block-start'; readonly index: number; readonly blockType: 'text' | 'reasoning' | 'tool-call' }
    | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
    | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
    | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
    | { readonly type: 'block-end'; readonly index: number; readonly block: { readonly type: string; readonly [key: string]: unknown } }
    | { readonly type: 'usage'; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens?: number } }
    | { readonly type: 'finish'; readonly reason: { readonly kind: string; readonly [key: string]: unknown } }
  // src/model-row-adapter.ts
  export type ModelRowAdapterOptions = {
    readonly presetId: string
    readonly displayName: string
    readonly declaredModels: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
    readonly runtimeModelsOf?: ((presetId: string) => readonly ReportedModel[] | undefined) | undefined
    readonly ensureModels?: ((presetId: string) => Promise<void>) | undefined
    readonly modelStream?: ((presetId: string, request: ModelTurnRequest) => AsyncIterable<ModelStreamChunk> | undefined) | undefined
    readonly collapseEfforts?: boolean | undefined
    readonly efforts?: readonly string[] | undefined
  }
  export type ModelRowAdapterLike = {
    providerInfo(provider: string): { id: string; name: string }
    listModels(provider: string): Promise<readonly CatalogModel[]>
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<CatalogModel>
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: CatalogModel; stream(options: ModelTurnRequest): AsyncIterable<ModelStreamChunk> }>
    stream(options: ModelTurnRequest): AsyncIterable<ModelStreamChunk>
    providerRetryPolicy(provider: string): undefined
  }
  export function modelRowAdapter(options: ModelRowAdapterOptions): ModelRowAdapterLike
  ```

- [ ] **Step 1: 建仓**

```bash
cd /Users/good/github/dsh-plugins
mkdir dsh-model-kit && cd dsh-model-kit && git init
```

写 `package.json`（`name: "@goodjin2/dsh-model-kit"`、`"type": "module"`、`"exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }`、devDependencies 与 dsh-acp-agent 同版本：`typescript`、`vitest`、`@types/node`），`tsconfig.json` 与 `tsconfig.base.json` 照 dsh-acp-agent 的抄（`include` 换成 `src`/`tests`，`outDir: lib`），`vitest.config.ts` 照抄。

```bash
pnpm install
```

- [ ] **Step 2: 写失败测试**

`tests/provider-route.spec.ts`：`providerRoute('acp-workbuddy')` 是 `'acp:acp-workbuddy'`；`presetOfRoute('acp:acp-workbuddy')` 是 `'acp-workbuddy'`；`presetOfRoute('别的')` 是 `undefined`。

`tests/runtime-models.spec.ts`：`record` 后 `modelsOf` 拿到同一批；`modelsOf` 对没记过的行是 `undefined`；记进来的模型里 `id` 不是字符串的被丢掉。

`tests/efforts.spec.ts`：`collapseEffortModels` 把 `base[low]`、`base[high]` 折成一条（baseId 是 `base`）；`collapsedToCatalog` 产出 `{ provider, id, name }`。

`tests/selection.spec.ts`：`selectionFilePath('workbuddy', { DSH_HOME: '/tmp/x' })` 是 `/tmp/x/workbuddy/selection.json`；`readSelection` 对没有的文件是 `undefined`；`writeSelection` 写完能读回来。

`tests/model-row-adapter.spec.ts`：`providerInfo` 返回 `{ id: 'acp:acp-workbuddy', name: 'WorkBuddy' }`；`listModels` 先调 `ensureModels`，再按「运行时清单优先、否则声明的那份」给模型；`resolveModel` 对折叠过的 base 也认得；`stream` 把请求交给 `modelStream` 并原样转它的块；`providerRetryPolicy` 返回 `undefined`。

- [ ] **Step 3: 跑测试，确认失败**

Run: `cd /Users/good/github/dsh-plugins/dsh-model-kit && ./node_modules/.bin/vitest run`
Expected: FAIL —— 模块还没有。

- [ ] **Step 4: 实现**

把 dsh-acp-agent 里的对应实现搬过来（`providerRoute`/`presetOfRoute`、`runtimeModels`、`collapseEffortModels`/`collapsedToCatalog`、`model-selection.ts` 全文），逐字保留行为与注释，只把类型改成 kit 自己的。

`model-row-adapter.ts` 从 dsh-acp-agent 的 `catalog.ts` 的 `catalogAdapter` 里**只取模型行那一支**（`providerInfo`/`listModels`/`resolveModel`/`prepareCall`/`stream` 的模型分支/`providerRetryPolicy`），去掉 ACP 行与网关那一支（网关是 agent-acp 自己的事）。

`src/index.ts` 重新导出上面列出的全部符号。

**kit 里不许带 agent-acp 的私货**：适配器不得引用网关、调度、审批、会话接管那些
ACP 专有的东西（WorkBuddy 插件不需要，agent-acp 的 ACP 行也不走 kit 的适配器）。

- [ ] **Step 5: 跑测试，确认通过**

Run: `./node_modules/.bin/vitest run` → 全部 PASS；再 `./node_modules/.bin/tsc --noEmit` → 无输出。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(model-kit): 模型行的公共件（路由命名、适配器、账本、档位、勾选文件）"
```

---

### Task 2: agent-acp 改用 `dsh-model-kit`（宿主侧），行为不变

**Files:**
- Modify: `dsh-acp-agent/package.json`（加 `"@goodjin2/dsh-model-kit": "link:../dsh-model-kit"`）
- Modify: `dsh-acp-agent/src/catalog.ts`、`src/catalog-registration.ts`、`src/model-plugins.ts`、`src/model-selection.ts`、`src/selection.ts`
- Modify: `dsh-acp-agent/tests/catalog.spec.ts` 等相关用例（若引用了搬走的符号，改成从 kit 引）

**Interfaces:**
- Consumes: Task 1 的全部导出。
- Produces: agent-acp 的宿主侧行为不变；`dsh-acp-agent` 依赖 `@goodjin2/dsh-model-kit`。

- [ ] **Step 1: 装上依赖**

```bash
cd /Users/good/github/dsh-plugins/dsh-acp-agent && pnpm install
```

（`link:` 依赖在本仓 `node_modules` 里建软链；确认 `node_modules/@goodjin2/dsh-model-kit` 存在。）

- [ ] **Step 2: 换 import**

把 `src/catalog.ts` 里的 `providerRoute`/`presetOfRoute`/`collapseEffortModels`/`collapsedToCatalog`/`CatalogModel`、`src/catalog-registration.ts` 里的 `runtimeModels`、`src/model-selection.ts` 全文，改为从 `@goodjin2/dsh-model-kit` 引；本仓里不再重复定义。

`src/model-plugins.ts` 里 `CatalogTurnRequest` 换成 kit 的 `ModelTurnRequest`（形状一致，是同一个类型改名）。

- [ ] **Step 3: 跑全量门禁**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`
Expected: 与改动前同样的结果（改动前若有别的在改的用例是红的，红的还得是同一批；本任务不许新增红灯）。

- [ ] **Step 4: 提交**

```bash
git add package.json pnpm-lock.yaml src tests && git commit -m "refactor(acp-agent): 宿主侧公共件改用 dsh-model-kit"
```

---

### Task 3: 浏览器侧的配额胶囊机器搬进 kit

**Files:**
- Create: `dsh-model-kit/src/client/quota-pill-machine.tsx`、`dsh-model-kit/src/client/index.ts`
- Create: `dsh-model-kit/tests/quota-pill-machine.spec.ts`
- Modify: `dsh-model-kit/package.json`（加 `exports["./client"]` → `./src/client/index.ts`）
- Modify: `dsh-acp-agent/src/client/quota-pill.ts`（改成「kit 的机器 + 本仓的规格表」）
- Modify: `dsh-acp-agent/src/client/index.ts`（import 改从 kit 引）

**Interfaces:**
- Consumes: Task 1 的 `ModelStreamChunk` 无关；本任务自足。
- Produces:
  ```ts
  // @goodjin2/dsh-model-kit/client
  export type QuotaWindow = { kind: 'five-hour' | 'weekly'; used?: number; total?: number; percent?: number; unlimited?: boolean; windowSeconds?: number; resetAt?: number }
  export type QuotaCredit = { remaining?: number; used?: number; limit?: number; recharge?: number; bonus?: number; extra?: string; groups?: readonly { name: string; total: number; remain: number; used: number }[] }
  export type QuotaWindows = { level?: string; fiveHour?: QuotaWindow; weekly?: QuotaWindow; credit?: QuotaCredit; tier?: string }
  export type QuotaAnswer = { ok: true; quota: QuotaWindows } | { ok: false; error: string; login?: QuotaLoginOffer }
  export type QuotaPillSpec = { provider: string; providerId?: string; prefix?: string; showCredit: boolean; routePath?: string; dockId: string; dockOrder: number }
  export function createQuotaPoller(deps: { fetchQuota(): Promise<QuotaAnswer>; setInterval?: (h: () => void, ms: number) => unknown; clearInterval?: (h: unknown) => void; intervalMs?: number; report?: (m: string) => void }): QuotaPoller
  export function routeQuotaFetcher(fetchImpl?: typeof fetch, routePath?: string): () => Promise<QuotaAnswer>
  export function registerQuotaDockPills(slots: DockSlotHost, poller: QuotaPoller, services: Partial<QuotaPillServices>, spec: QuotaPillSpec): () => void
  export function QuotaPillRow(props: { useQuota: unknown; useModelDirectory: unknown; useLogin: unknown; visible?: boolean; t: RuntimeT; spec: QuotaPillSpec }): ReactNode
  export function pillOf(window: QuotaWindow, t: RuntimeT, spec: QuotaPillSpec, tier?: string): ReactNode
  export function creditPillOf(credit: QuotaCredit, t: RuntimeT, spec: QuotaPillSpec, tier?: string): ReactNode
  export function loginChip(login: QuotaLoginOffer, t: RuntimeT, spec?: QuotaPillSpec): ReactNode
  export type QuotaPillServices = { modelDirectories?: unknown; sessions?: { subagentAddress(sessionId: string): string | undefined } }
  export type DockSlotHost = { inject(key: string, callback: () => unknown): unknown; register(options: { name: string; id?: string; order?: number; locale?: string; inject?: () => unknown }, component: unknown): unknown }
  ```

- [ ] **Step 1: 写失败测试**

`dsh-model-kit/tests/quota-pill-machine.spec.ts`：把 dsh-acp-agent 里 `tests/quota-pill-registration.spec.ts` 与 `tests/grok-pill.spec.ts` 的用例搬过来（规格表按 provider 认、画法、变色方向、dock 注册）。

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd dsh-model-kit && ./node_modules/.bin/vitest run tests/quota-pill-machine.spec.ts` → FAIL（模块还没有）。

- [ ] **Step 3: 实现**

把 `dsh-acp-agent/src/client/quota-pill.ts` 里的**机器**搬进 kit：规格表类型、轮询器、`routeQuotaFetcher`、`registerQuotaDockPills`、`QuotaPillRow`、`pillOf`、`creditPillOf`、`loginChip`、以及各家 provider 的**词条键映射**（`titleKey`/`creditKeys`——它们只是键名，词条本身留在各插件的词典里）。

**规格与词条不进 kit**：agent-acp 的六张规格表（zcode/minimaxi/codex/claude/deepseek/grok）与它们的 `quota.*` 词条留在 agent-acp。

`provider` 字段的类型从固定联合改成 `string`（各插件自报），因此 `titleKey`/`creditKeys` 的分支要改成查表：表放在 kit 里，默认回退到 minimaxi 的键名。

- [ ] **Step 4: agent-acp 改用 kit 的机器**

`dsh-acp-agent/src/client/quota-pill.ts` 变成薄壳：从 `@goodjin2/dsh-model-kit/client` 引机器，本仓保留六张规格表与 `GLM_QUOTA_PILL_SPEC` 等常量。

`dsh-acp-agent/src/client/index.ts` 的 import 跟着改。

- [ ] **Step 5: 跑门禁与构建**

```bash
cd dsh-acp-agent && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run
./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsdown
grep -c "acpAgentClient" lib/client.js
```

Expected: 测试与改动前一致；产物里应有各家的规格 id。

- [ ] **Step 6: 提交**

kit 与 agent-acp 各一次提交：

```bash
cd dsh-model-kit && git add -A && git commit -m "feat(model-kit): 浏览器侧的配额胶囊机器"
cd ../dsh-acp-agent && git add -A && git commit -m "refactor(acp-agent): 配额胶囊改用 kit 的机器"
```

---

### Task 4: 建 `dsh-workbuddy` 仓，搬宿主侧的代码

**Files:**
- Create: `/Users/good/github/dsh-plugins/dsh-workbuddy/`（新 git 仓）
  - `package.json`（`name: "@goodjin2/dsh-workbuddy"`、`"type": "module"`、`exports`：`"."` → `./src/entry.ts`、`"./client"` → `./lib/client.js`、`"./workbuddy-login"` → `./src/workbuddy-route.ts`）
  - `tsconfig.json`、`tsconfig.base.json`、`vitest.config.ts`、`tsdown.config.ts`（照 dsh-acp-agent 改）
  - `src/entry.ts`、`src/workbuddy-route.ts`、`src/workbuddy-model.ts`
  - `src/workbuddy/*`（端点、请求体、SSE、鉴权、凭据、清单、签到、套餐与积分、网关指纹改写）
  - `tests/*`（照搬 dsh-acp-agent 的 `tests/workbuddy-*.spec.ts`）
- Delete (from agent-acp, **本任务先不删**): 见 Task 7

**Interfaces:**
- Consumes: Task 1 的 `ModelTurnRequest`/`ModelStreamChunk`/`providerRoute`/`runtimeModels`/`readSelection`/`writeSelection`/`modelRowAdapter`。
- Produces: `@goodjin2/dsh-workbuddy` 的宿主侧入口与行。

- [ ] **Step 1: 建仓**

```bash
cd /Users/good/github/dsh-plugins && mkdir dsh-workbuddy && cd dsh-workbuddy && git init
```

`package.json` 照 dsh-acp-agent 抄（名字、exports、devDependencies），依赖加
`"@goodjin2/dsh-model-kit": "link:../dsh-model-kit"`。

```bash
pnpm install
```

- [ ] **Step 2: 搬宿主侧代码**

`git -C ../dsh-acp-agent archive HEAD src/workbuddy src/workbuddy-model.ts src/workbuddy-route.ts tests/workbuddy-*.spec.ts | tar -x` （把 agent-acp 已提交的那份搬过来），然后改：

- `src/workbuddy-model.ts`：改用 kit 的 `ModelTurnRequest` 与 `runtimeModels`；`CatalogTurnRequest` → `ModelTurnRequest`。
- `src/workbuddy-route.ts`：路由常量与路径全部沿用；`ModelStreamChunk` 无关。
- `src/entry.ts`：照 dsh-acp-agent 的 `src/entry.ts` 抄一个**只有模型行职责**的入口：
  - `Config` 用 schemastery 声明 `presetId`（必填）、`agent`、`models`、`collapseEfforts`、`hideFromRoster`；
  - `apply(ctx, config)` 只做三件事：
    1. `ctx.llm.registerAdapter([providerRoute(config.presetId)], modelRowAdapter({...}))`——把 WorkBuddy 这条 provider 路由挂进宿主的模型目录；
    2. `modelRowAdapter` 的 `modelStream` 接 `workBuddyModelStream(config, deps)`，`ensureModels` 接 `ensureWorkBuddyModels`；
    3. `runtimeModelsOf` 接本插件自己那份 `runtimeModels()` 账本（`onRuntimeModels` 往里写）。
  - **不要**抄 agent-acp 的调度/接管/审批那部分——那是外部 agent 的事，模型行不需要。

- [ ] **Step 3: 跑测试，确认通过**

Run: `cd dsh-workbuddy && ./node_modules/.bin/vitest run` → 全 PASS；`./node_modules/.bin/tsc --noEmit` → 无输出。

（此时 agent-acp 里的那份还在，两处代码并存是**故意的**：新插件还没进 profile。）

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat(workbuddy): 独立插件的宿主侧（登录、清单、请求、签到、套餐与积分）"
```

---

### Task 5: 搬浏览器侧（设置段、词条、胶囊规格、客户端入口）

**Files:**
- Create: `dsh-workbuddy/src/client/workbuddy-account-section.tsx`、`dsh-workbuddy/src/client/locales.ts`、`dsh-workbuddy/src/client/index.ts`
- Create: `dsh-workbuddy/tests/workbuddy-account-section.spec.ts`、`dsh-workbuddy/tests/workbuddy-pill.spec.ts`
- Modify: `dsh-workbuddy/package.json`、`dsh-workbuddy/tsdown.config.ts`

**Interfaces:**
- Consumes: Task 3 的 `@goodjin2/dsh-model-kit/client`。
- Produces: 新插件的浏览器侧入口 `./client`（产物 `lib/client.js`）。

- [ ] **Step 1: 写失败测试**

把 dsh-acp-agent 的 `tests/workbuddy-account-section.spec.ts` 与 `tests/workbuddy-pill.spec.ts` 搬过来改 import（指向新仓的 `src/client/…`）。

再加一条**命名空间**的用例（本插件的词典不能注册在 `acpAgentClient` 上——两个插件
注册同一命名空间会互相覆盖，界面上词条变成键名）：

```ts
it('本插件的 locale 命名空间是自己的，不是 acpAgentClient', () => {
  expect(NAMESPACE).toBe('acpWorkbuddyClient')
  expect(NAMESPACE).not.toBe('acpAgentClient')
})
```

- [ ] **Step 2: 跑测试，确认失败**

- [ ] **Step 3: 实现**

- `src/client/locales.ts`：**新的命名空间** `acpWorkbuddyClient`；把 agent-acp 词典里的 `workbuddy.*` 与 `quota.workbuddy.*` 词条搬过来（中英各一份）；DeepSeek/其它家的词条不搬。
- `src/client/workbuddy-account-section.tsx`：照搬，路由常量沿用。
- `src/client/index.ts`：照 dsh-acp-agent 的客户端入口抄一份，但只做三件事——注册自己的 locale 词典（`ctx.locale.register('acpWorkbuddyClient', { zh, en })`）、注册 WorkBuddy 的设置段、注册 WorkBuddy 那一条积分胶囊规格（用 kit 的机器）。
- `tsdown.config.ts`：照 dsh-acp-agent 的抄，`entry` 指向本仓 `lib/src/client/index.js`，banner/footer 里的 id 换成本包名。

- [ ] **Step 4: 跑测试与构建**

```bash
./node_modules/.bin/vitest run tests/workbuddy-account-section.spec.ts tests/workbuddy-pill.spec.ts
./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsdown
grep -c "workbuddy-credits" lib/client.js
```

Expected: 产物里有 WorkBuddy 的设置段与胶囊规格。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(workbuddy): 独立插件的浏览器侧（设置段、签到、套餐与积分、积分胶囊）"
```

---

### Task 6: 接线：挂载行搬家 + profile 依赖

**Files:**
- Create: `dsh-workbuddy/cordis.patch.yml`
- Modify: `dsh-acp-agent/cordis.patch.yml`（**摘掉** `acp-workbuddy` 预设行与 `acp-agent-workbuddy-login` 宿主行）
- Modify: `~/.dsh/profiles/desktop/package.json`（加两个 link: 依赖与 bundles）

**Interfaces:**
- Consumes: Task 4/5 的包。
- Produces: 桌面 profile 里装上了新插件与 kit，WorkBuddy 那行由新插件提供。

- [ ] **Step 1: 新插件写自己的挂载行**

`dsh-workbuddy/cordis.patch.yml` 抄 agent-acp 那两行（`acp-workbuddy` 预设行：binding 指向 `@goodjin2/dsh-workbuddy`、`presetId: acp-workbuddy`、`agent: workbuddy`、`hideFromRoster: true`、12 个模型、`collapseEfforts: false`；`acp-agent-workbuddy-login` 宿主行：name 指向 `@goodjin2/dsh-workbuddy/workbuddy-login`）。

- [ ] **Step 2: agent-acp 摘掉那两行**

同一份改动里把 agent-acp 的 `cordis.patch.yml` 里那两行删掉——**同一步做**，否则两个插件同时声明同一行 id 与同一条路由。

（这个任务只动挂载行；agent-acp 里的**代码**留到 Task 7 删——代码留着不影响运行，profile 里已经不挂那两行了。）

- [ ] **Step 3: profile 接线**

`~/.dsh/profiles/desktop/package.json`：
`dependencies` 加 `"@goodjin2/dsh-workbuddy": "link:/Users/good/github/dsh-plugins/dsh-workbuddy"` 与 `"@goodjin2/dsh-model-kit": "link:/Users/good/github/dsh-plugins/dsh-model-kit"`；
`dsh.profile.bundles` 数组加 `"@goodjin2/dsh-workbuddy"`。

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

**装完必须查解析**：确认 `node_modules/@goodjin2/dsh-workbuddy` 与 `node_modules/@goodjin2/dsh-model-kit` 都在（少一个就是静默失败：装上了不生效、界面上什么都没有）。

- [ ] **Step 4: 真机验证这一版能用**

重启 DSH 桌面 App；看启动日志里两边的行都挂上（agent-acp 自报门面 + 新插件的行）；打开设置，WorkBuddy 那一节在（签到、套餐与积分、模型清单）；模型选择器里 WorkBuddy 那组在；选一个 WorkBuddy 模型发消息能回；输入框下方有积分胶囊。

- [ ] **Step 5: 提交**

```bash
cd dsh-workbuddy && git add cordis.patch.yml && git commit -m "feat(workbuddy): 自己的挂载行"
cd ../dsh-acp-agent && git add cordis.patch.yml && git commit -m "refactor(acp-agent): 挂载行交给独立的 workbuddy 插件"
```

---

### Task 7: 从 agent-acp 里删干净

**Files:**
- Delete: `dsh-acp-agent/src/workbuddy/`（整个目录）、`src/workbuddy-model.ts`、`src/workbuddy-route.ts`
- Delete: `dsh-acp-agent/tests/workbuddy-*.spec.ts`（Task 4 已搬走的那些）
- Modify: `dsh-acp-agent/package.json`（删 `./workbuddy-login` 导出）、`src/index.ts`、`src/model-plugins.ts`、`src/factory.ts`、`src/catalog.ts`、`src/plugin.ts`、`src/health.ts`
- Modify: `dsh-acp-agent/src/client/index.ts`、`src/client/locales.ts`、`src/client/quota-pill.ts`
- Modify: `dsh-acp-agent/docs/agent-acp/README.md`（对照表去掉 WorkBuddy 那行）

**Interfaces:**
- Consumes: Task 4/5/6。
- Produces: agent-acp 里没有任何 WorkBuddy 痕迹。

- [ ] **Step 1: 删代码与接线**

按 spec §四.3 逐项删：目录与入口文件、package.json 的导出、`model-plugins.ts` 的插件表接线、`factory.ts` 两处守卫的名单（名单里去掉 `workbuddy`）、`catalog.ts` 的显示名表与类型并集、`plugin.ts` 的清单接线、客户端的设置段注册与胶囊规格、词典里的 `workbuddy.*` 与 `quota.workbuddy.*` 词条。

- [ ] **Step 2: 跑门禁与构建**

```bash
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run
./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsdown
grep -c "workbuddy" lib/client.js
```

Expected: 测试全绿（与改动前同样红绿）；产物里 `grep -c workbuddy` 应为 0。

- [ ] **Step 3: 查干净了没**

```bash
grep -ri workbuddy src tests cordis.patch.yml package.json
```

Expected: 无命中（文档 `docs/agent-acp/workbuddy.md` 可以改成指向新插件的说明，或一并删掉）。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "refactor(acp-agent): 删掉 WorkBuddy（已搬进独立插件）"
```

---

### Task 8: 真机验收与文档

**Files:**
- Create: `dsh-workbuddy/README.md`、`dsh-workbuddy/README.zh.md`、`dsh-workbuddy/docs/agent-acp/workbuddy.md`（从 agent-acp 搬过去并改写）
- Create: `dsh-model-kit/README.md`（这个包是干什么的、谁在用）
- Modify: `/Users/good/github/dsh-plugins/AGENTS.md`（仓库清单：6 → 8 个；归属映射加一条）

**Interfaces:**
- Consumes: 前面全部。
- Produces: 文档与清单对齐。

- [ ] **Step 1: 搬文档**

`dsh-acp-agent/docs/agent-acp/workbuddy.md` 搬到新插件的 `docs/agent-acp/workbuddy.md`，开头的归属改成新插件；agent-acp 的对照表里 WorkBuddy 那行指向新插件。

- [ ] **Step 2: 更新容器 AGENTS.md**

仓库清单加 `dsh-model-kit`（共享工具包，不是插件）与 `dsh-workbuddy`（WorkBuddy 独立插件）；归属映射里「WorkBuddy 相关」指向 `dsh-workbuddy`；写清依赖关系：workbuddy 与 acp-agent 都依赖 model-kit。

- [ ] **Step 3: 真机验收（spec §五逐条）**

1. `grep -ri workbuddy dsh-acp-agent/src dsh-acp-agent/tests dsh-acp-agent/cordis.patch.yml` 无命中；
2. 桌面 profile 装上新插件与 kit，启动日志里两边的行都挂上；
3. 模型选择器里 WorkBuddy 那组在，模型与倍率一致；
4. 设置里那一节在：签到、立即签到、套餐与积分、模型清单；
5. 选 WorkBuddy 模型发一条消息能回，输入框下方有积分胶囊；
6. 不用重新登录（凭据文件仍是原路径、原内容，登录态还在）；
7. 模型勾选不丢（`selection.json` 还在原路径，勾的模型仍在选择器里）；
8. agent-acp：类型检查与全量测试全绿。

- [ ] **Step 4: 提交**

```bash
cd dsh-workbuddy && git add -A && git commit -m "docs(workbuddy): 独立插件的说明与对照"
cd ../dsh-model-kit && git add -A && git commit -m "docs(model-kit): 这个包是什么、谁在用"
cd .. && git -C dsh-plugins status  # 容器目录不是 git 仓；AGENTS.md 的改动手动落盘
```

- [ ] **Step 5: 推与发布**

三个仓各自推送（`git push`）；新插件要能从 GitHub 正常安装——确认 `package.json` 的
`name`/`version`/`repository` 与 `main` 分支上的可发布状态都对。
