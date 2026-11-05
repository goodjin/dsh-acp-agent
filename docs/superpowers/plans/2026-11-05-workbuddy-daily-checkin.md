# WorkBuddy 每日签到（自动领积分）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@goodjin2/dsh-acp-agent` 里让 WorkBuddy 每天本地时间 10:00 自动领当天积分；设置页能看见今天签没签、连续天数与每日积分，并有一个「立即签到」按钮；10:00 没开机时下次启动补签。

**Architecture:** 新增 `src/workbuddy/checkin.ts`（查状态、领一次、每天定时三件事，纯逻辑可单测）；端点解析补两个地址；宿主加一条 `GET/POST /acp-agent/workbuddy/checkin` 路由并在 `ctx.effect` 里起定时器；浏览器侧在「WorkBuddy 账号」那一节加一行状态与一个按钮。凭据沿用现有那份（`~/.dsh/workbuddy/credentials.json`），令牌不进日志、不进应答。

**Tech Stack:** TypeScript 5.9（strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）、Node 22.19+ 内置 `fetch`（不引新依赖）、vitest 3、DSH 宿主插件 API（`webServer` / `connection` / `effect`）。

**Spec:** `docs/superpowers/specs/2026-11-05-workbuddy-daily-checkin-design.md`（同分支，先读它；本计划是它的可执行化，冲突以 spec 为准）

## Global Constraints

- 仓库：`/Users/good/github/dsh-plugins/dsh-acp-agent`，工作区 `.worktrees/feat-workbuddy-checkin`（分支 `feat/workbuddy-daily-checkin`）。所有改动只在这个 worktree 里做。
- 门禁（每个任务结束前跑，全绿才提交）：`pnpm typecheck`、`pnpm test`（worktree 里 `pnpm` 会自作主张重装依赖，直接用 `./node_modules/.bin/tsc --noEmit` 与 `./node_modules/.bin/vitest run`）。改了浏览器半边还要 `pnpm build:client`。
- 不新增依赖。
- 注释、文档、文案一律中文（本仓库惯例）；代码标识符英文。
- 令牌绝不进：日志、错误消息、宿主路由应答。沿用 `src/workbuddy/chat.ts` 的 `scrub`。
- 路由路径一律 `/acp-agent/` 前缀。
- 端点一处派生：签到地址与登录、清单、模型请求同一个基址。
- 注释与文档里的日期写「2026-11-05」。
- 一个任务一次提交，提交信息用中文，动词开头（`feat:` / `fix:` / `docs:` / `test:`）。

## Review Focus

spec 说了、但没有哪条任务会顺手测到的输入与故障：

1. **没登录就到点** → 定时器安静跳过，不抛错、不弹窗，只记一条日志。（Task 3）
2. **今天已经领过** → 不当成错误；站点回 `10001`（实测）或 `1001`（官方客户端的映射）都要认。（Task 2）
3. **令牌出现在错误消息里** → 任何失败路径的消息都不得含 access token。（Task 2）
4. **10:00 时应用没开** → 下次启动补签；没到 10:00 不补。（Task 3）
5. **多开与重复触发** → 同一个 DSH 进程里定时器只排一次；站点已领过就跳过。（Task 3、Task 2）

---

### Task 1: 端点解析补两个地址

**Files:**
- Modify: `src/workbuddy/endpoints.ts`
- Test: `tests/workbuddy-openai.spec.ts`（端点解析的用例在那儿）

- [ ] **Step 1: 写失败测试**

在 `tests/workbuddy-openai.spec.ts` 的「端点解析」里加：

```ts
expect(endpoints.checkinStatusUrl).toBe('https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status')
expect(endpoints.dailyCheckinUrl).toBe('https://www.workbuddy.cn/v2/billing/meter/daily-checkin')
```

并断言换站（`WORKBUDDY_BASE_URL=https://copilot.tencent.com`）时两处一起换。

- [ ] **Step 2: 跑测试，确认失败**

Run: `./node_modules/.bin/vitest run tests/workbuddy-openai.spec.ts`
Expected: FAIL —— `checkinStatusUrl` 是 undefined。

- [ ] **Step 3: 实现**

在 `WorkBuddyEndpoints` 里加两个字段，在 `resolveEndpoints` 里派生（`${base}/v2/billing/meter/…`）。

- [ ] **Step 4: 跑测试，确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/workbuddy/endpoints.ts tests/workbuddy-openai.spec.ts
git commit -m "feat(workbuddy): 端点解析补上签到与领积分的地址"
```

---

### Task 2: 签到模块（查状态、领一次）

**Files:**
- Create: `src/workbuddy/checkin.ts`
- Test: `tests/workbuddy-checkin.spec.ts`

- [ ] **Step 1: 写失败测试**

`tests/workbuddy-checkin.spec.ts` 覆盖：

- `fetchCheckinStatus`：请求是 POST、地址是 `checkinStatusUrl`、带 `authorization` 与 `x-user-id`；应答 `data` 折成 `{ active, todayCheckedIn, streakDays, dailyCredit, todayCredit, isStreakDay, checkinDates }`；缺字段时按默认值（0 / false / 空数组）而不是崩。
- `claimDailyCheckin`：
  - `code === 0` → `{ claimed: true, credit, streakDays }`；
  - `code === 10001` 或 `1001` → `{ claimed: false, alreadyClaimed: true }`（不是错误）；
  - 其它非 0 码 → `{ claimed: false, message: 站点的 msg }`；
  - HTTP 失败 → 抛错，消息里有状态码，且**没有令牌**。

- [ ] **Step 2: 跑测试，确认失败**

Run: `./node_modules/.bin/vitest run tests/workbuddy-checkin.spec.ts`
Expected: FAIL —— `Cannot find module '../src/workbuddy/checkin.ts'`

- [ ] **Step 3: 实现 `src/workbuddy/checkin.ts`**

导出：

```ts
export type WorkBuddyCheckinStatus = {
  readonly active: boolean
  readonly todayCheckedIn: boolean
  readonly streakDays: number
  readonly dailyCredit: number
  readonly todayCredit: number
  readonly isStreakDay: boolean
  readonly checkinDates: readonly string[]
}
export type WorkBuddyCheckinResult = {
  readonly claimed: boolean
  readonly alreadyClaimed: boolean
  readonly credit: number
  readonly streakDays: number
  readonly message?: string | undefined
}
export async function fetchCheckinStatus(options: {...}): Promise<WorkBuddyCheckinStatus>
export async function claimDailyCheckin(options: {...}): Promise<WorkBuddyCheckinResult>
```

选项：`{ credential, endpoints?, fetchImpl? }`；错误消息用 `scrub` 抹令牌。

- [ ] **Step 4: 跑测试，确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/workbuddy/checkin.ts tests/workbuddy-checkin.spec.ts
git commit -m "feat(workbuddy): 查签到状态与领当天积分"
```

---

### Task 3: 每天 10:00 的定时与启动补签

**Files:**
- Modify: `src/workbuddy/checkin.ts`
- Test: `tests/workbuddy-checkin.spec.ts`

- [ ] **Step 1: 写失败测试**

覆盖：

- `nextRunDelay(now, hour, minute)`：今天还没到 10:00 → 到 10:00 的毫秒差；今天已过 10:00 → 到明天 10:00 的差；跨月跨年（12 月 31 日 23:00 → 1 月 1 日 10:00）。
- `shouldCatchUp(now, hour, minute)`：已过 10:00 → true；没过 → false。
- `startDailyCheckin`：到点触发一次后会再排下一次；触发时先查状态，已签就跳过（不再发领取请求）；没登录时什么都不发；返回一个停掉定时器的函数。

`now` 与 `schedule`（`{ setTimeout, clearTimeout }`）都要可注入，测试里不真等。

- [ ] **Step 2: 跑测试，确认失败**

- [ ] **Step 3: 实现**

在 `src/workbuddy/checkin.ts` 里加：

```ts
export const DAILY_CHECKIN_HOUR = 10
export const DAILY_CHECKIN_MINUTE = 0
export function nextRunDelay(now: Date, hour: number, minute: number): number
export function shouldCatchUp(now: Date, hour: number, minute: number): boolean
export function startDailyCheckin(options: {...}): () => void
```

`startDailyCheckin` 的行为：装载时若 `shouldCatchUp` 为真且今天未签 → 立刻领一次；然后排下一次 10:00，触发后再排下一次。领的时候先查状态，已签就跳过。

- [ ] **Step 4: 跑测试，确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/workbuddy/checkin.ts tests/workbuddy-checkin.spec.ts
git commit -m "feat(workbuddy): 每天 10:00 自动签到，启动时补签"
```

---

### Task 4: 宿主路由与定时器的装载

**Files:**
- Modify: `src/workbuddy-route.ts`
- Test: `tests/workbuddy-route.spec.ts`（若没有就新建；既有路由用例在 `tests/` 下找同名文件）

- [ ] **Step 1: 写失败测试**

覆盖新路由 `/acp-agent/workbuddy/checkin`：

- `GET`：已登录 → `{ ok: true, status: {…} }`；未登录 → `{ ok: false, reason }`。
- `POST`：领到 → `{ ok: true, claimed: true, credit }`；已领 → `{ ok: true, alreadyClaimed: true }`；失败 → `{ ok: false, reason }`。
- 应答里没有令牌。
- 定时器在插件装载时启动、在 effect 结束时撤销（用注入的 `schedule` 立桩断言）。

- [ ] **Step 2: 跑测试，确认失败**

- [ ] **Step 3: 实现**

- 在 `src/workbuddy-route.ts` 里加 `WORKBUDDY_CHECKIN_ROUTE_PATH = '/acp-agent/workbuddy/checkin'`；
- 在 `registerWorkBuddyRoutes` 里注册这条路由（GET 查状态 / POST 领一次）；
- 在 `ctx.effect` 里起 `startDailyCheckin`（凭据缺失时安静跳过）。

- [ ] **Step 4: 跑测试，确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/workbuddy-route.ts tests/workbuddy-route.spec.ts
git commit -m "feat(workbuddy): 签到路由与每天 10:00 的定时器"
```

---

### Task 5: 设置页里的签到状态与「立即签到」

**Files:**
- Modify: `src/client/workbuddy-account-section.tsx`
- Modify: `src/client/locales.ts`（文案）
- Test: `tests/workbuddy-account-section.spec.ts`

- [ ] **Step 1: 写失败测试**

覆盖：

- 状态行：已签 → 「今日已签 · 连续 13 天 · 每天 100 积分」；未签 → 「今日未签 · 每天 100 积分」。
- 未登录时不显示这一行。
- 「立即签到」按钮：点击 → 发一次 POST；今天已领 → 按钮禁用或显示「今天已领过了」。

- [ ] **Step 2: 跑测试，确认失败**

- [ ] **Step 3: 实现**

- 浏览器侧新增 `WORKBUDDY_CHECKIN_URL = '/acp-agent/workbuddy/checkin'`；
- 在账号区加状态行与按钮，文案进 `locales.ts`（中英各一份）；
- 刷新账号状态时顺带取签到状态。

- [ ] **Step 4: 跑测试，确认通过**

- [ ] **Step 5: 重建浏览器产物并提交**

```bash
./node_modules/.bin/tsc -p tsconfig.json && ./node_modules/.bin/tsdown
git add src/client lib
git commit -m "feat(workbuddy): 设置页显示每日签到状态并能立即签到"
```

---

### Task 6: 文档与收尾

**Files:**
- Modify: `docs/agent-acp/workbuddy.md`

- [ ] **Step 1: 补文档**

加一节「每日签到」：两个接口、业务码、定时与补签的规则、设置页怎么看、风险（设备令牌）。

- [ ] **Step 2: 跑门禁**

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

全绿才提交。

- [ ] **Step 3: 提交**

```bash
git add docs/agent-acp/workbuddy.md
git commit -m "docs(workbuddy): 补每日签到这一节"
```

- [ ] **Step 4: 合并回主干**

主工作区有未提交的改动（qoder 与账号区的在改内容），合并前要确认不覆盖它们。
