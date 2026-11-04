# 外部 agent 委派落到 DSH 侧 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部 agent（codex / claude / cursor / qoder / grok）想派子代理时，调我们挂上去的委派工具；委派由 DSH 侧执行，孩子在 DSH 里跑、用 DSH 的工具，模型与技能按 superpowers 的钉表解析。

**Architecture:** 三段各归其位。acp-agent 负责通路（建会话时挂 stdio MCP 服务器、起桥接进程、宿主开一条本地回调路由、接管排除守卫）；superpowers 负责委派实现（读钉表定模型、内联技能正文、起一次性 DSH 子代理、等结果）；两边通过一个宿主服务对接，谁都不 import 谁。

**Tech Stack:** TypeScript（DSH 插件，strip-only 加载）、Cordis 服务、Node 内建 http、vitest（acp-agent）/ node:test 风格脚本（superpowers）。

**Spec:** `docs/agent-acp/delegation-design.md`（同仓，已提交于 `feat/acp-delegation`）

## Global Constraints

- 本仓库只写 TypeScript 源码（`main` 指向 `src/entry.ts`），宿主以 strip-only 模式加载；**不得引入需要编译步骤的产物**，除非该产物已在 `files` 字段里显式列出。
- **不得从 `@deepseek-ai/dsh-*` 运行时包 import 任何东西**（本仓库的既有规矩：`src/entry.ts` 顶部注释「No imports from the DSH runtime packages」）。宿主面一律按结构读取，缺失即拒绝。
- 插件行**不得泄漏服务**（`src/entry.ts:16-18`）：宿主注册表会审计挂载行，泄漏即整棵预设回滚。事件监听不算，提供服务才算。
- 两个仓库**互不 import**。跨插件只经宿主服务对接：一个服务名 + 一份载荷形状。
- superpowers 的 `cordis.patch.yml` 必须与 `preset/agent.cordis.yml` 同步；`scripts/test-preset-sync.mjs` 的 `HOST_PLANE_ROWS` 白名单是唯一允许的「不在预设清单里的行」来源，新增主机侧行必须同时加进该白名单。
- superpowers 的 `cordis.patch.yml` **必须是一个顶层数组**（`AGENTS.md:94`）。
- 宿主服务缺失时**干净降级**：不挂 MCP 服务器，agent 看到的世界与今天一模一样。绝不半挂（挂了服务器但工具调用必失败）。
- 委派是**阻塞**的：工具调用返回时必须带着子代理的最终文本。
- 每个任务结束提交一次；提交信息用中文，句式为 `feat: …` / `fix: …` / `test: …` / `docs: …`。
- 改动只在 worktree 里做：`dsh-acp-agent/.worktrees/feat-acp-delegation` 与 `dsh-superpowers/.worktrees/feat-delegation-service`。主工作区只收验证过的合并结果。

## Review Focus

以下几类输入/状况规格隐含、但任何任务的测试都没覆盖，最容易咬人：

- **委派子会话被 ACP 行二次接管**：孩子在 DSH 里起，工具却变成外部 agent 的。期望：子会话带 `origin: 'subagent'`，接管判定必须跳过它。
- **模型路由钉在 `acp:` 前缀**：期望语义不变——由那个外部 agent 应答，孩子只是会话壳。期望：**不**报「找不到模型」之类的错。
- **superpowers 未安装 / 委派服务缺席**：期望：完全不挂 MCP 服务器，agent 的工具列表与今天完全一致。
- **桥接进程起不来或 agent 不理它**：期望：委派工具缺席，agent 退回原生委派，今天的行为。
- **子代理跑得比 MCP 工具调用超时久**：期望：agent 侧看到明确失败；子代理继续跑完，结果按任务标识缓存，再次询问同一标识时拿到已完成的结果。
- **技能目录里没有该技能**：期望：委派明确失败并报出技能名，不静默退回默认模型。
- **宿主回调路由路径被别的插件占了**：期望：报名报错，不静默降级成「永远失败」。

---

### Task 1: 接管排除守卫

**Files:**
- Modify: `src/dispatch.ts`（`presetIdOf` 附近的接管判定处）
- Modify: `src/plugin.ts`（`ctx.on('agent/created')` 处理器，约 404 行；以及预设改选那条路径）
- Test: `tests/delegation-guard.spec.ts`

**Interfaces:**
- Consumes: 宿主会话头（`agent.session.header`）上的 `origin?: 'subagent'` 与 `delegationDepth?: number`。
- Produces: `export function isDelegatedChild(agent: unknown): boolean`（`src/dispatch.ts`）——判定一个 agent 是否是受委派产生的子会话。

- [ ] **Step 1: 写失败的测试**

在 `tests/delegation-guard.spec.ts` 写：

```ts
import { describe, expect, it } from 'vitest'
import { isDelegatedChild } from '../src/dispatch.ts'

describe('受委派子会话的接管排除', () => {
  it('会话头带 delegationDepth>0 的 agent 是受委派子会话', () => {
    expect(isDelegatedChild({ session: { header: { delegationDepth: 1 } } })).toBe(true)
    expect(isDelegatedChild({ session: { header: { delegationDepth: 2 } } })).toBe(true)
  })

  it('普通会话不是受委派子会话', () => {
    expect(isDelegatedChild({ session: { header: { agentPreset: 'acp-codex' } } })).toBe(false)
  })

  it('没有会话头的 agent 不是受委派子会话', () => {
    expect(isDelegatedChild({})).toBe(false)
  })

  it('origin=subagent 但没有 delegationDepth 的会话不算受委派子会话', () => {
    // origin 是粗粒度的来源标记；ACP 行自己造的影子子会话也带它。
    // 判据用 delegationDepth —— 宿主对「这是受委派产生的」的记账。
    expect(isDelegatedChild({ session: { header: { origin: 'subagent' } } })).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/delegation-guard.spec.ts`
Expected: FAIL，报 `isDelegatedChild` 未导出（SyntaxError / undefined is not a function）。

- [ ] **Step 3: 实现 `isDelegatedChild`**

在 `src/dispatch.ts` 中新增导出函数，签名：

```ts
export function isDelegatedChild(agent: unknown): boolean
```

读 `agent.session?.header?.delegationDepth`，是正数即返回 true；其余一律 false（无 `session`、无 `header`、字段缺失或非数）。

**判据只用 `delegationDepth`，不用 `origin`**：`origin === 'subagent'` 是粗粒度的来源标记，ACP 行自己造的影子子会话（`src/entry.ts:544`）也带它；`delegationDepth` 才是宿主对「这是受委派产生的」的记账，与深度上限用的是同一个事实。所有读取都按结构进行并逐层做类型守卫。

- [ ] **Step 4: 把守卫接到两条接管路径上**

在 `src/plugin.ts`：

1. `ctx.on('agent/created')` 处理器里，在 `deps.install(agent, presetId, dialect, table)` 之前加一道早退：`if (isDelegatedChild(agent)) return`。
2. 预设改选那条路径（监听 `session/event` 里预设被选中的事件，最终也走到 `deps.install`）同样在 install 之前早退。

从 `src/dispatch.ts` 导入 `isDelegatedChild`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/delegation-guard.spec.ts tests/dispatch.spec.ts`
Expected: PASS（既有 dispatch 测试不回归）。

- [ ] **Step 6: 提交**

```bash
cd dsh-acp-agent/.worktrees/feat-acp-delegation
git add src/dispatch.ts src/plugin.ts tests/delegation-guard.spec.ts
git commit -m "feat: 受委派的子会话不�� ACP 行接管"
```

---

### Task 2: ACP 预设补上 DSH 工具行

**Files:**
- Modify: `cordis.patch.yml`（`acp-codex` / `acp-claude` / `acp-grok` / `acp-cursor` / `acp-qoder` 五个预设的 `plugins:` 清单）
- Test: `tests/acp-preset-tools.spec.ts`

**Interfaces:**
- Consumes: 宿主包 `@deepseek-ai/dsh-tool-bash`、`@deepseek-ai/dsh-tool-fs`、`@deepseek-ai/dsh-tool-fs-search`、`@deepseek-ai/dsh-tool-todo`（名字与 superpowers 预设里用的一致）。
- Produces: 每个 ACP 预设的 `plugins:` 清单里含这四行，供子会话继承。

- [ ] **Step 1: 写失败的测试**

在 `tests/acp-preset-tools.spec.ts` 写：读 `cordis.patch.yml` 文本，断言五个 ACP 预设（`acp-codex`、`acp-claude`、`acp-grok`、`acp-cursor`、`acp-qoder`）的 `plugins:` 段落里都出现 `dsh-tool-bash`、`dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-todo` 四个包名。

（解析方式照抄本仓已有的 yml 文本断言风格：逐行匹配 `- id:` 与 `name:`，按预设 id 切片。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/acp-preset-tools.spec.ts`
Expected: FAIL，`acp-codex` 预设缺 `dsh-tool-bash`。

- [ ] **Step 3: 在五个 ACP 预设的 plugins 清单里补四行**

在 `cordis.patch.yml` 里每个 ACP 预设的 `plugins:` 下追加（id 用预设内唯一的名字，name 用宿主包名）：

```yaml
          - id: acp-tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
          - id: acp-tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: acp-tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
          - id: acp-tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
```

`acp-zcode` 与 `acp-minimax` **不动**——它们是模型插件路线，不走 ACP。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/acp-preset-tools.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd dsh-acp-agent/.worktrees/feat-acp-delegation
git add cordis.patch.yml tests/acp-preset-tools.spec.ts
git commit -m "feat: ACP 预设补上 DSH 工具行，供子会话继承"
```

---

### Task 3: 宿主服务契约（两边共享的形状）

**Files:**
- Create: `src/delegation-contract.ts`（acp-agent）
- Create: `lib/delegation-contract.js`（superpowers）
- Test: `tests/delegation-contract.spec.ts`（acp-agent）、`scripts/test-delegation-contract.mjs`（superpowers）

**Interfaces:**
- Produces: 服务名常量 `DELEGATION_SERVICE = 'superpowers.delegation'`；载荷类型 `DelegationRequest` 与 `DelegationResult`。

两个仓库各写一份同名同形的契约文件，**内容逐字一致**（acp-agent 用 TypeScript，superpowers 用 JavaScript）。理由：跨仓库不 import，形状靠约定与一份对照测试钉住。

载荷形状（两边一致）：

```
DelegationRequest = {
  sessionId: string        // 父 DSH 会话 id
  skill?: string           // 技能名；缺省 = 走「其他子代理」那一行
  task: string             // 短标签
  brief: string            // 给孩子的完整任务书（孩子看不到本对话）
  signal?: AbortSignal     // 取消
}

DelegationResult = {
  output: string           // 子代理的最终文本
  model: string            // 实际路由；未钉定 = 'inherited'
  childId: string          // 子会话 id
}
```

- [ ] **Step 1: 写失败的测试（acp-agent 侧）**

`tests/delegation-contract.spec.ts`：断言 `DELEGATION_SERVICE === 'superpowers.delegation'`，且导出的 `isDelegationResult(value)` 对 `{output, model, childId}` 返回 true、对缺字段的对象返回 false。

- [ ] **Step 2: 写失败的测试（superpowers 侧）**

`scripts/test-delegation-contract.mjs`：断言同一常量与同一个 `isDelegationResult` 行为。

- [ ] **Step 3: 跑两侧测试确认失败**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/delegation-contract.spec.ts` → FAIL（模块不存在）
Run: `cd dsh-superpowers && node scripts/test-delegation-contract.mjs` → FAIL（模块不存在）

- [ ] **Step 4: 实现两侧契约文件**

acp-agent `src/delegation-contract.ts`：

```ts
export const DELEGATION_SERVICE = 'superpowers.delegation'
export type DelegationRequest = {
  readonly sessionId: string
  readonly skill?: string
  readonly task: string
  readonly brief: string
  readonly signal?: AbortSignal
}
export type DelegationResult = {
  readonly output: string
  readonly model: string
  readonly childId: string
}
export function isDelegationResult(value: unknown): boolean
```

superpowers `lib/delegation-contract.js`：同一常量、同一两个类型的等价 JSDoc、同一 `isDelegationResult` 实现。

- [ ] **Step 5: 加一道两侧形状对照测试**

在 acp-agent 的 `tests/delegation-contract.spec.ts` 里加一个用例：读 `../../dsh-superpowers/lib/delegation-contract.js`（相对路径，用 `new URL` 解析），断言它的 `DELEGATION_SERVICE` 与 `isDelegationResult` 行为与本仓一致。**该用例在 superpowers 仓不在场时跳过**（`it.skipIf`），不得因此失败。

- [ ] **Step 6: 跑两侧测试确认通过**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/delegation-contract.spec.ts` → PASS
Run: `cd dsh-superpowers && node scripts/test-delegation-contract.mjs` → PASS

- [ ] **Step 7: 提交（两个仓库各一次）**

```bash
cd dsh-acp-agent/.worktrees/feat-acp-delegation
git add src/delegation-contract.ts tests/delegation-contract.spec.ts
git commit -m "feat: 委派服务的载荷契约"

cd dsh-superpowers
git add lib/delegation-contract.js scripts/test-delegation-contract.mjs
git commit -m "feat: 委派服务的载荷契约"
```

---

### Task 4: superpowers 侧的委派实现

**Files:**
- Create: `lib/delegation-service.js`（superpowers）
- Modify: `lib/settings-schema.js`（若需导出钉表解析给服务用）
- Modify: `package.json`（`exports` 加 `"./delegation-service"`，`files` 加 `lib/delegation-service.js`——注意 `files` 已有 `lib` 整目录，无需改）
- Modify: `cordis.patch.yml`（加主机侧行）
- Test: `scripts/test-delegation-service.mjs`（superpowers）

**Interfaces:**
- Consumes: 宿主服务 `ctx.subagents`（`startContinuable`）、`ctx.agents`、`ctx.configEditor`；钉表解析用 `lib/settings-schema.js` 的 `resolveRoute`；技能清单用 `lib/delegable-skills.js` 的 `DELEGABLE_SKILLS`。
- Produces: 宿主服务 `superpowers.delegation`，方法 `delegate(request: DelegationRequest): Promise<DelegationResult>`。

- [ ] **Step 1: 写失败的测试**

`scripts/test-delegation-service.mjs`（照 `scripts/test.mjs` 的自研 harness 风格：`test(name, run)` + `assert`）覆盖：

1. 钉表命中某技能时，起子代理用的 `agentOptions` 就是钉表那一行（provider/model 原样）。
2. 钉表未命中该技能、但有默认行时，用默认行。
3. 技能名不在 `DELEGABLE_SKILLS` 里 → 委派失败，错误文本含该技能名。
4. 技能正文被内联进孩子的初始提示：断言提示文本含 SKILL.md 正文里的一句原文，且含技能目录绝对路径。
5. 返回值形状：`{output, model, childId}`，`model` 为实际路由字符串。

测试用替身注入宿主面：`ctx` 提供假 `subagents.startContinuable`（记下 request 并返回一个可 resolve 的 childId）、假 `agents`、假 `configEditor`（返回钉表）。**测试不得依赖真实模型或真实子代理。**

- [ ] **Step 2: 跑测试确认失败**

Run: `cd dsh-superpowers && node scripts/test-delegation-service.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现委派服务**

`lib/delegation-service.js` 导出 `name = 'superpowers-delegation-service'`、`inject = ['subagents', 'agents', 'configEditor']`、`apply(ctx, config)`。

`apply` 里 `ctx.provide('superpowers.delegation', { delegate })`（服务名取自 `lib/delegation-contract.js` 的 `DELEGATION_SERVICE`）。

`delegate(request)` 的步骤：

1. 校验 `request.sessionId` / `task` / `brief` 非空，缺则抛错并带上字段名。
2. 技能名（`request.skill` 缺省或空白 → null）必须在 `DELEGABLE_SKILLS` 内，否则抛错，错误文本含该技能名。
3. 读钉表：用 `lib/settings-schema.js` 的 `resolveRoute(settings, skill)`。钉表读法照抄 `lib/skill-delegation.js` 的 `hostDelegationConfig(ctx)`（`ctx.get('configEditor')` → 找 `options.id === NAMESPACE` 的行 → 读 `fiber.config` → `unvolatile`）。
4. 读技能正文：从本包 `preset/skills/<skill>/SKILL.md` 读全文；技能目录绝对路径 = `preset/skills/<skill>` 的绝对路径（用 `fileURLToPath(new URL(..., import.meta.url))` 解析，不依赖 cwd）。
5. 组装孩子提示：技能正文 + 技能目录绝对路径 + `request.brief`。提示用 `[{ type: 'text', text }]`。
6. 起子代理：`ctx.subagents.startContinuable({ provider: 'spawn', label: '[<skill>] <task>' 或 '[通用] <task>', signal, request: { parent, prompt, ...(route ? { agentOptions: route } : {}) } })`。`parent` 从 `ctx.agents.get(request.sessionId)` 取；取不到就抛错并报出 sessionId。
7. 等结果：这是**一次性**语义——本实现**不用** `startContinuable`，改用 `ctx.subagents.start('spawn', {...})` 的 one-shot 路径：它返回一个 `SubagentRun`，其 `result` 是一个 promise，resolve 出 `{ output, structured?, stopReason }`。用 `await run.result` 取最终输出，再 `await run.dispose()`。输出转成纯文本（`output` 是 ContentBlock[]，取 `type === 'text'` 的 `text` 拼接）。
   - **若 `ctx.subagents.start` 不可用**：退回 `startContinuable` + 轮询不可行 → 报明确错误「宿主只提供可续聊子代理，无法阻塞等结果」。
8. 返回 `{ output, model, childId }`：`model` 用钉表解析出的 `provider/model` 串；未钉定（route 为 null）时用 `'inherited'`；`childId` 取 `run.id`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd dglob…` → 修正：`cd dsh-superpowers && node scripts/test-delegation-service.mjs`
Expected: PASS。

- [ ] **Step 5: 把服务挂进宿主组合**

`cordis.patch.yml` 顶层数组里加一行（id 与 `scripts/test-preset-sync.mjs` 的 `HOST_PLANE_ROWS` 白名单同步加）：

```yaml
    - id: superpowers-delegation-service
      name: '@goodjin2/dsh-superpowers/delegation-service'
```

`package.json` 的 `exports` 加：

```json
    "./delegation-service": "./lib/delegation-service.js",
```

`scripts/test-preset-sync.mjs` 的 `HOST_PLANE_ROWS` 加 `'superpowers-delegation-service'`。

- [ ] **Step 6: 跑 superpowers 全套检查**

Run: `cd dsh-superpowers && npm test && npm run check`
Expected: 两个都退出 0；preset↔声明同步测试通过。

- [ ] **Step 7: 提交**

```bash
cd dsh-superpowers
git add lib/delegation-service.js lib/settings-schema.js package.json cordis.patch.yml scripts/test-delegation-service.mjs scripts/test-preset-sync.mjs
git commit -m "feat: 委派服务——按钉表定模型、内联技能正文、起 DSH 子代理"
```

---

### Task 5: 桥接进程（MCP stdio 服务端）

**Files:**
- Create: `src/mcp-bridge.ts`（acp-agent）——但**不能**是 TypeScript 源直接跑：宿主以 strip-only 模式加载 `.ts`，而这里需要一个**独立可执行文件**被 agent 拉起。
- Create: `bridge/dsh-acp-mcp-bridge.mjs`（acp-agent，纯 JavaScript ESM，`files` 里要带）
- Modify: `package.json`（`files` 加 `bridge/`）
- Test: `tests/mcp-bridge.spec.ts`

**Interfaces:**
- Consumes: 环境变量 `DSH_DELEGATION_URL`（宿主回调路由的完整 URL，含会话令牌）、`DSH_DELEGATION_SESSION`（父 DSH 会话 id）。
- Produces: 一个 stdio MCP 服务器，向 agent 暴露**一个**工具 `delegate`（参数：`skill?`、`task`、`brief`）。

- [ ] **Step 1: 写失败的测试**

`tests/mcp-bridge.spec.ts` 用 `node:child_process` 的 `spawn` 拉起 `bridge/dsh-acp-mcp-bridge.mjs`，往它的 stdin 写 MCP JSON-RPC 帧，逐字断言：

1. `initialize` 请求 → 响应里 `protocolVersion` 是字符串、`capabilities.tools` 存在、`serverInfo.name` 是本插件名。
2. `tools/list` → 响应里恰有一个工具，名 `delegate`，其 `inputSchema` 含 `task`、`brief` 两个必填属性。
3. `tools/call`（参数 `task`、`brief`）→ 桥接进程向 `DSH_DELEGATION_URL` 发一次 HTTP POST（测试里用 `node:http` 起一个假宿主），假宿主回 JSON `{output, model, childId}` → 桥接进程把 `output` 作为工具结果文本回给 agent。
4. `tools/call` 时宿主回 500 → 桥接进程回 `isError: true` 的工具结果，文本含宿主给的错误。

断言用的 MCP 帧格式按 stdio 传输规范：每行一个 JSON 对象。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/mcp-bridge.spec.ts`
Expected: FAIL（桥接文件不存在）。

- [ ] **Step 3: 实现桥接进程**

`bridge/dsh-acp-mcp-bridge.mjs`：

- 读 stdin 的行（`readline`），每行一个 JSON-RPC 消息；往 stdout 写响应，**每行一个 JSON 对象，不带其它输出**（stderr 可写日志）。
- 支持三个方法：`initialize`（回 `protocolVersion` 用 `'2025-06-18'`、`capabilities: { tools: {} }`、`serverInfo: { name: 'dsh-acp-agent', version: <包版本> }`）、`tools/list`、`tools/call`；另支持 `notifications/initialized` 这类通知（不回响应）。
- `tools/call` 的 `name` 必须是 `delegate`，否则回 `isError: true` 并说明只有这一个工具。
- `delegate` 的入参校验：`task` 与 `brief` 必填非空字符串，缺失回 `isError: true` 并指出缺哪个。`skill` 可选。
- 转发：向 `process.env.DSH_DELEGATION_URL` 发 `POST`，`Content-Type: application/json`，body 是 `{ sessionId: process.env.DSH_DELEGATION_SESSION, skill, task, brief }`。超时用 `AbortSignal.timeout(600000)`（十分钟；一次委派不该无限挂住）。
- 宿主回 2xx 且 JSON 形状对 → 工具结果 `{ content: [{ type: 'text', text: output }] }`。
- 宿主回非 2xx 或形状不对 → 工具结果 `{ isError: true, content: [{ type: 'text', text: <错误文本> }] }`；错误文本不得包含令牌或 URL。
- 找不到 `DSH_DELEGATION_URL` 环境变量 → 启动即往 stderr 写一行并退出码 1（agent 拉起失败即「桥接进程起不来」，agent 退回原生委派）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/mcp-bridge.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd dsh-acp-agent/.worktrees/feat-acp-delegation
git add bridge/dsh-acp-mcp-bridge.mjs package.json tests/mcp-bridge.spec.ts
git commit -m "feat: stdio MCP 桥接进程——把委派调用转给宿主回调路由"
```

---

### Task 6: 宿主回调路由

**Files:**
- Create: `src/delegation-route.ts`（acp-agent，主机侧行）
- Modify: `package.json`（`exports` 加 `"./delegation-route"`，`files` 加 `src/**/*.ts`——已有）
- Test: `tests/delegation-route.spec.ts`

**Interfaces:**
- Consumes: 宿主服务 `superpowers.delegation`（Task 4 提供）、`ctx.webServer`、`ctx.connection`；请求头 `x-dsh-delegation-token`；body 为 `DelegationRequest` 的 JSON。
- Produces: 路由 `POST /acp-agent/delegation`，成功回 200 + `DelegationResult` JSON；令牌不符回 401；body 不合法回 400；委派服务缺席回 503。
- 另产出：一份**按 `(sessionId, task)` 记的已完成结果缓存**——委派跑超 MCP 工具调用超时后，agent 再问同一标识时直接拿到已完成的结果，不必重跑。缓存挂在路由行的闭包里，进程内存，不落盘。

- [ ] **Step 1: 写失败的测试**

`tests/delegation-route.spec.ts` 照 `tests/zcode-quota.spec.ts` 的 rig 风格（假 `webServer.register` 捕获路由、假 `connection`）：

1. 令牌正确 + 委派服务在场 → 200，body 是委派服务返回的结果。
2. 令牌缺失或不符 → 401，body 不含委派结果。
3. body 缺 `task` → 400。
4. 委派服务缺席（`ctx.get` 返回 undefined）→ 503，且 body 含「委派服务不可用」字样。
5. 委派服务抛错 → 500，body 含错误文本，且**不含令牌**。
6. 同一 `(sessionId, task)` 第二次请求 → 200，且**不再调用委派服务**（断言替身的服务没被第二次调用），body 是第一次的结果。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/delegation-route.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现回调路由**

`src/delegation-route.ts`：

```ts
export const name = 'acp-agent-delegation-route'
export const DELEGATION_ROUTE_PATH = '/acp-agent/delegation'
export function apply(ctx: DelegationRouteContext): void
```

- 令牌校验：读 `req.headers['x-dsh-delegation-token']`，与**路由行配置里的** `config.token` 逐字比。令牌缺失或不符 → 401，body 为固定短文本。
  - **令牌只有一份来源**：路由行配置。桥接进程拿到的同一个值由 Task 7 从宿主配置读出后放进 `env`。两处各自生成会让回调永远校验不过。
- body 解析：读请求体（累积 chunk，`JSON.parse`），失败或缺 `task`/`brief`/`sessionId` → 400。
- 结果缓存：以 `(sessionId, task)` 为键。请求命中已完成的键 → 直接回 200 与缓存结果，**不调委派服务**。委派成功后写入缓存。
- 委派调用：`ctx.get(DELEGATION_SERVICE)`；缺席 → 503。`delegate(body)` 的结果回 200 + JSON。
- 委派抛错 → 500，body 只含错误消息，**必须过滤掉令牌**（用 `.replace(token, '[redacted]')` 一类处理）。**失败的委派不写缓存**——否则一次失败会被缓存成永久失败。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/delegation-route.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd dsh-acp-agent/.worktrees/feat-acp-delegation
git add src/delegation-route.ts package.json tests/delegation-route.spec.ts
git commit -m "feat: 委派回调路由——校验令牌后转交委派服务"
```

---

### Task 7: 把 MCP 服务器挂进会话

**Files:**
- Modify: `src/runner.ts`（`doOpen` 里 `session/new` 与 `session/load`/`resume` 的 `mcpServers`，约 2214-2244 行）
- Modify: `src/factory.ts`（把桥接进程的可执行路径与令牌传给 runner）
- Modify: `src/entry.ts`（读取宿主服务 `superpowers.delegation`；缺席时不挂 MCP）
- Test: `tests/mcp-attach.spec.ts`

**Interfaces:**
- Consumes: 宿主服务 `superpowers.delegation` 的**存在性**（决定挂不挂）；宿主配置里回调路由那一行的 `config.token`（令牌的唯一来源）；`ctx.webServer` 的 `getOrigin()`/端口（拼回调 URL）；桥接进程绝对路径。
- Produces: `session/new` 与 `session/load`/`resume` 的 `mcpServers` 数组含一项 `{ type: 'stdio', name: 'dsh-delegation', command: <node 可执行路径>, args: [<桥接 .mjs 绝对路径>], env: [...] }`。

- [ ] **Step 1: 写失败的测试**

`tests/mcp-attach.spec.ts`：用假 client 驱动 `AcpTurnRunner` 走一次 `session/new`，断言发给 agent 的 `mcpServers`：

1. 委派服务在场 → 数组恰有一项，`name` 是 `dsh-delegation`，`command` 指向一个存在的可执行（node），`args[0]` 指向仓库里真实存在的桥接 `.mjs` 文件，`env` 里含 `DSH_DELEGATION_URL` 与 `DSH_DELEGATION_SESSION`。
2. 委派服务缺席 → `mcpServers` 是空数组。
3. `session/load`/`resume` 路径同样带 `mcpServers`（现在写死空数组）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/mcp-attach.spec.ts`
Expected: FAIL（`mcpServers` 仍是空数组）。

- [ ] **Step 3: 实现挂载**

1. `src/entry.ts`：读宿主服务 `superpowers.delegation`（用 `src/delegation-contract.ts` 的 `DELEGATION_SERVICE`）。**在** `deps.install` 之前，把「委派服务在场」这一事实与委派所需的宿主面传给 factory/runner：委派服务本身（供回调路由用）、回调路由的 URL 与令牌。
2. `src/factory.ts`：从**宿主配置**读回调路由那一行的 `config.token`（令牌只有这一份来源，见 Task 6 Step 3），拼出回调 URL `${origin}/acp-agent/delegation`，并把桥接进程的可执行路径与 `.mjs` 绝对路径准备好。
   - 可执行路径：宿主自己的 `process.execPath`（node）。桥接文件路径：从本包位置解析（`new URL('../bridge/dsh-acp-mcp-bridge.mjs', import.meta.url)`）。
   - 令牌放 `env`：`DSH_DELEGATION_TOKEN`（与路由行的 `config.token` 同一个值）、`DSH_DELEGATION_URL`、`DSH_DELEGATION_SESSION`。
   - 令牌读不到（路由行没配 `config.token`）→ **不挂 MCP 服务器**，并在 stderr 记一行；不生成临时令牌——临时令牌会让回调路由的校验永远不过。
3. `src/runner.ts`：`session/new` 与 `session/load`/`resume` 的 `mcpServers` 从「写死空数组」改成「传进来的服务器列表」；委派服务缺席时传空数组。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/mcp-attach.spec.ts tests/runner.spec.ts`
Expected: PASS（既有 runner 测试不回归——注意既有测试断言了 `mcpServers: []`，需要按新语义更新）。

- [ ] **Step 5: 提交**

```bash
cd dsh-acp-agent/.worktrees/feat-acp-delegation
git add src/runner.ts src/factory.ts src/entry.ts tests/mcp-attach.spec.ts
git commit -m "feat: 建会话时挂上委派用的 MCP 服务器"
```

---

### Task 8: 端到端串起来（软接管）

**Files:**
- Modify: `src/factory.ts` 或 `src/runner.ts`（在发给 agent 的 prompt 里加引导语，按预设开关）
- Modify: `src/registry.ts`（预设配置加 `delegationHint?: boolean`）
- Test: `tests/delegation-hint.spec.ts`

**Interfaces:**
- Consumes: 预设配置 `delegationHint`（`AcpPresetConfig` 新字段，默认 false）。
- Produces: 发给 agent 的 prompt 文本在开关打开时含一句引导：需要子代理就调 `delegate` 工具，别用它自带的 Task/Agent 工具。

- [ ] **Step 1: 写失败的测试**

`tests/delegation-hint.spec.ts`：

1. `delegationHint: true` 的预设 → 发出的 prompt 含引导语，且含工具名 `delegate`。
2. `delegationHint` 缺省或 false → 发出的 prompt **不含**引导语。
3. 引导语不得出现在发给用户的会话记录里（只进 prompt）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/delegation-hint.spec.ts`
Expected: FAIL（开关不存在）。

- [ ] **Step 3: 实现引导语**

- `src/registry.ts`：`AcpPresetConfig` 加 `readonly delegationHint?: boolean`。
- 组装 prompt 处（`src/runner.ts` 的 `promptContent` 之后、发往 `session/prompt` 之前）按开关追加引导句。引导句里点明工具名 `delegate`，并说明「用这个，别用你自己的 Task/Agent 工具」。
- 引导语只进 prompt 载荷，不进会话日志。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && npx vitest run tests/delegation-hint.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd dsh-acp-agent/.worktrees/feat-acp-delegation
git add src/runner.ts src/registry.ts tests/delegation-hint.spec.ts
git commit -m "feat: 委派引导语——让外部 agent 优先用我们的委派工具"
```

---

### Task 9: 真机探针

**Files:**
- Modify: `tests/live.spec.ts`（加一组「MCP 委派探针」）
- Create: `docs/agent-acp/mcp-probe.md`（实测记录）

**Interfaces:**
- Consumes: Task 7 挂上的 MCP 服务器；五家真实二进制。
- Produces: 一份实测记录，写明哪家会连、会列出工具、会真的调用。

- [ ] **Step 1: 写探针用例**

在 `tests/live.spec.ts` 加一组（同样受 `ACP_AGENT_LIVE_ACP=1` 门控）：对五家各跑一轮真实会话，prompt 里请 agent「调用 delegate 工具做一件小事」，断言：

- 桥接进程收到了 `initialize`；
- 桥接进程收到了 `tools/list`；
- 桥接进程收到了 `tools/call`；
- （若走通了）工具结果里带着子代理的输出。

**任何一家失败不许跳过**——失败也要记进实测记录。

- [ ] **Step 2: 跑探针**

Run: `cd dsh-acp-agent/.worktrees/feat-acp-delegation && ACP_AGENT_LIVE_ACP=1 npx vitest run tests/live.spec.ts`
Expected: 记录每家的实际表现。

- [ ] **Step 3: 写实测记录**

`docs/agent-acp/mcp-probe.md`：逐家写「会连 / 会列工具 / 会调用 / 结果是否正确」，以及**哪些家需要额外环境**（例如 codex 是否需要 `--acp` 之外的开关、cursor 的 `authenticate` 前置、qoder 的登录前置）。日期写当天。

- [ ] **Step 4: 提交**

```bash
cd dsh-acp-agent/.worktrees/feat-acp-delegation
git add tests/live.spec.ts docs/agent-acp/mcp-probe.md
git commit -m "test: 真机探针——五家认不认客户端提供的 MCP 服务器"
```

---

### Task 10: 装到桌面 profile 并跑通

**Files:**
- Modify: `~/.dsh/profiles/desktop/cordis.patch.yml`（加委派路由主机侧行；把 `delegationHint` 打开给要试的 ACP 预设）
- Modify: `~/.dsh/profiles/desktop/package.json`（若需要新依赖）

**Interfaces:**
- Consumes: Task 4 的 `superpowers-delegation-service` 主机侧行、Task 6 的 `acp-agent-delegation-route` 主机侧行。
- Produces: 桌面版里一条能跑通的委派链路。

- [ ] **Step 1: 在 profile 里挂两行主机侧行**

`~/.dsh/profiles/desktop/cordis.patch.yml` 顶层加：

```yaml
- id: superpowers-delegation-service
  name: "@goodjin2/dsh-superpowers/delegation-service"
- id: acp-agent-delegation-route
  name: "@goodjin2/dsh-acp-agent/delegation-route"
  config:
    token: "<随机 32 字节 hex>"
```

令牌用 `openssl rand -hex 32` 生成，**只写进 profile，不进任何仓库**。

这枚令牌是**唯一来源**：Task 6 的路由行拿它校验，Task 7 的挂载从同一行读出后放进桥接进程的 `env`。两处若各自生成，回调永远校验不过。

- [ ] **Step 2: 重装两个插件并重启桌面版**

按 `dsh-plugins/AGENTS.md` 的规矩：改完插件要重新安装，让 profile 指过来；桌面版改动后**重建产物并重启 App**，否则界面加载的仍是旧产物。

- [ ] **Step 3: 端到端手测**

在桌面版开一个 ACP 预设会话，要求 agent「派一个子代理去做 X」，观察：

- 桥接进程有 `tools/call`（看宿主日志）；
- 会话树里出现一个子会话，血缘指向父会话；
- 子会话的模型与钉表一致；
- 子代理用 DSH 的工具（bash/fs）干活，而不是外部 agent 的工具。

- [ ] **Step 4: 把装法写回设计文档**

profile 不在仓库里，不提交。**但**要在 `docs/agent-acp/delegation-design.md` 里补一句「装法：profile 里加这两行（路由行带 `config.token`）+ 重装插件 + 重启」。

---

## 计划自检

- 规格覆盖：规格的每一节都有对应任务——通路（Task 5/6/7）、委派实现（Task 4）、接缝（Task 3）、接管排除（Task 1）、工具来源（Task 2）、技能内联（Task 4 Step 3）、路由语义（Task 4 Step 3 第 3 点，钉表 `acp:` 路由原样透传）、失败与降级（Task 4/5/6/7 各自的缺席分支 + Review Focus）、阶段划分（Task 9 = 阶段 0，Task 8 = 阶段 2；阶段 3 逐家硬接管**不在本计划内**——规格里已列为非目标）。
- 步骤粒度：每个步骤只做一件事，且带可验证的结果。
- 类型一致：`DelegationRequest`/`DelegationResult`/`DELEGATION_SERVICE` 在 Task 3 定义，Task 4/5/6/7 全部按它用。
- 比例：计划 10 个任务，与规格的规模相称；正文以签名与断言为主，没有把实现抄成代码。
