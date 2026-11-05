# WorkBuddy 每日签到（自动领积分）设计

> 核对时间：2026-11-05
> 状态：设计已评审通过
> 归属仓库：`@goodjin2/dsh-acp-agent`（本文件在 `feat/workbuddy-daily-checkin` 分支的 worktree 里）

## 一、背景与目标

WorkBuddy 账号每天可以签到领一次积分（真机实测：每天 100 积分，连续签到另有额外奖励）。这件事现在要人手动点——插件把它自动化：**每天本地时间 10:00 自动领一次**，并让用户在设置里看得见今天签没签、连续几天、每天多少积分；万一 10:00 那一刻 DSH 没开着，下次启动补签，连续天数不断。

**成功标准**：用户什么都不用做，到了 10:00 积分自动到账；设置页能确认今天已签、连续天数与每日积分数；10:00 没开机时，下次启动自动补签；没登录时不打扰、不报错。

## 二、范围

### 做

- 查签到状态、领当天积分（宿主侧，两个接口）。
- 每天 10:00 的定时领取 + 启动时补签。
- 设置页里的一行状态与一个「立即签到」按钮。
- 宿主一条路由（GET 查状态、POST 领一次）。

### 不做

- 不做积分余额查询与配额胶囊（WorkBuddy 的积分余额接口还没定位，见 §六）。
- 不做多账号轮换（当前只有一个 WorkBuddy 账号）。
- 不做补签「昨天」的接口（站点没开放）。
- 不动浏览器半边之外的界面布局。

## 三、事实依据

来自对 `/Applications/WorkBuddy.app` 内 `app.asar` 的解包与本机实测（2026-11-05）。

### 3.1 两个接口

| 项 | 结论 | 证据 |
|---|---|---|
| 查状态 | `POST {端点}/v2/billing/meter/checkin-activity-status` | CLI 内 `getCheckinStatus()`；桌面版 `BackendProvider.getCheckinStatus()` |
| 领取 | `POST {端点}/v2/billing/meter/daily-checkin` | CLI 内 `claimDailyCheckin()`；桌面版 `DesktopAccountRepo.checkin()`（`billingPrefix = '/v2'`） |
| 请求体 | 空对象 `{}` | 两处实现都是 `post(url, {})` |
| 鉴权 | `Authorization: Bearer <accessToken>` + `X-User-Id` | 与模型请求同一套凭据 |
| 客户端标识 | `User-Agent: WorkBuddy/版本`（沿用现有 `WORKBUDDY_UA`） | 站点按 UA 里的产品名认客户端 |

实测（用插件存的那份凭据，`https://www.workbuddy.cn` 与 `https://copilot.tencent.com` 两个基址都通）：

- 查状态 → `200 {"code":0,"data":{"active":true,"today_checked_in":true,"streak_days":13,"daily_credit":100,"today_credit":100,"is_streak_day":false,…,"checkin_dates":[…]}}`
- 领取（当天已领过）→ `400 {"code":10001,"msg":"今天已签到，请明天再来"}`

### 3.2 应答字段

状态接口的 `data`（官方客户端读的字段，缺了不影响我们）：

| 字段 | 含义 |
|---|---|
| `active` | 签到活动是否在进行 |
| `today_checked_in` | 今天是否已签 |
| `streak_days` | 连续签到天数 |
| `daily_credit` | 每天给的积分 |
| `today_credit` | 今天实际到手的积分 |
| `is_streak_day` | 今天是不是有额外奖励的那天 |
| `checkin_dates` | 最近的签到日期 |

领取接口成功时 `data` 是 `{ credit, streak_days, is_streak_day }`。

### 3.3 业务码

官方客户端把领取的业务码映射成四种状态（`mapCheckinStatus`）：`1001` 已领过、`1002` 不符合条件、`1003` 活动已结束、其余为未知。本机实测今天已领过时站点回的是 `10001`（文案「今天已签到，请明天再来」）——**文案才是可靠的**，码只当辅助。

**定案**：任何非 0 业务码都算「没领到」，用站点给的 `msg` 原话报给人；`10001`/`1001` 归为「今天已领过」（不是错误）。

### 3.4 设备令牌

官方客户端领积分时额外带 `X-Device-Token`（桌面版由 TuringShield 生成）。**实测我们的请求不带也能过**：状态接口 200，领取接口回的是业务码而不是鉴权错误。定案：不实现设备令牌；若站点将来开始要求，会回明确的错误码，届时再补（见 §六）。

## 四、设计

### 4.1 模块

新增 `src/workbuddy/checkin.ts`，只做三件事，各自独立可测：

| 导出 | 作用 |
|---|---|
| `fetchCheckinStatus(options)` | 查状态 → 折成 `{ active, todayCheckedIn, streakDays, dailyCredit, todayCredit, isStreakDay, checkinDates }` |
| `claimDailyCheckin(options)` | 领一次 → 折成 `{ claimed, alreadyClaimed, credit, streakDays, message }` |
| `scheduleDailyCheckin(options)` | 每天 10:00 触发一次；`now` 与 `schedule` 可注入，测试里不真等 |

端点解析（`src/workbuddy/endpoints.ts`）补两个地址：`checkinStatusUrl` 与 `dailyCheckinUrl`，都从同一个基址派生（`{base}/v2/billing/meter/…`）——与登录、清单、模型请求同源，不同源就会重演「登录成功但请求被拒」。

### 4.2 定时与补签

- **到点领取**：每天本地时间 10:00 触发。先查状态，已签就跳过（不产生噪音日志）。
- **启动补签**：插件装载时，若本地时间已过 10:00 且今天未签，当场领一次。
- **没登录**：跳过，只记一条日志，不弹窗、不报错。
- **多开**：桌面版与网页版各自都会领，站点认得「今天已领过」，后到的自动跳过——不需要额外的互斥。
- 定时器挂在 `ctx.effect` 里：插件卸载时随之撤销（与仓库现有的 effect 作用域一致）。

时间基准：本地时间。`10:00` 写成一个常量，便于日后调整。

### 4.3 宿主路由

新路由 `GET/POST /acp-agent/workbuddy/checkin`：

- `GET` → `{ ok: true, status: { todayCheckedIn, streakDays, dailyCredit, todayCredit, … } }`；没登录 → `{ ok: false, reason: '未登录 WorkBuddy' }`。
- `POST` → 领一次 → `{ ok: true, claimed, credit, streakDays, message }`；已经领过 → `{ ok: true, alreadyClaimed: true }`；失败 → `{ ok: false, reason }`。

沿用现有路由的规矩：先 admit 后应答、取数失败折成 `200 + ok:false`（界面要能显示原因，不是「崩了」）、应答里永远没有令牌。

### 4.4 界面

设置里「WorkBuddy 账号」那一节，在账号行下面加一行：

> 每日签到：今日已签 · 连续 13 天 · 每天 100 积分　[立即签到]

- 「立即签到」按钮：点一下领一次（今天已领则显示「今天已领过了」）。
- 未登录时不显示这一行（先登录）。
- 签到状态与账号状态一起刷新（现有 `refresh` 顺带带上）。

### 4.5 错误处理

| 情况 | 表现 |
|---|---|
| 没登录 | 定时器跳过；界面不显示这一行；手动点 → 「未登录 WorkBuddy」 |
| 今天已领 | 定时器跳过；手动点 → 明确说「今天已签到」 |
| 站点不可达 / 5xx | 定时器记一条日志，不重试到死；手动点 → 界面显示原因 |
| 业务码（不符合条件 / 活动已结束） | 原话报给人（站点给的 `msg`） |

令牌不出现在任何一条消息里（沿用 `scrub`）。

## 五、测试

- `tests/workbuddy-checkin.spec.ts`：状态接口的请求形状与应答解析（字段缺失要容错）；领取接口的成功、已领（`10001`/`1001`）、不符合条件、活动已结束、未知码；令牌不进错误消息。
- 定时：下一个 10:00 的等待时长（今天还没到 10:00 / 今天已过 10:00 / 跨天）；启动补签的条件；触发后只领一次。
- `tests/workbuddy-route.spec.ts`（或既有路由用例）：GET 与 POST 两条路径；未登录时 `ok:false`。
- 界面：`tests/workbuddy-account-section.spec.ts`：状态行的文案、按钮的可用与禁用。

## 六、风险

| 风险 | 处置 |
|---|---|
| 站点将来要求设备令牌 | 会回明确错误码；届时把 TuringShield 的取法补进来（不影响其它功能） |
| 站点改字段或改地址 | 解析层容错（缺字段按默认值），地址一处派生，好改 |
| 官方客户端「今天已领」的码与实测不同（`1001` vs `10001`） | 按文案与码两路判断，任一命中即视为「已领」 |
| 插件没在跑时到点 | 启动补签（已过 10:00 且今天未签才补） |
| 时区/夏令时 | 用本地时间，跨天由「下一次 10:00」的差值算出来，不依赖 UTC |

## 七、验收

1. 真机跑一次「立即签到」：今天已领 → 界面显示「今天已签到」，不报错。
2. 把系统时间改到 10:00 之后并重启 DSH：启动补签触发，界面显示今天已签。
3. 没登录时：定时器安静跳过，日志里有一条说明。
4. 类型检查与全量测试全绿；浏览器半边改动后 `build:client` 重建产物。
