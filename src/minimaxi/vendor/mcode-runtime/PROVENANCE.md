# mcode-runtime（搬运自 MiniMax Code 的运行时事实）

模型目录与托管网关地址是从 MiniMax 官方 `minimax-code` 仓库搬来的**事实**，不是我们自己维护的清单——官方加模型、加区域，我们跟进一次即可。

## 上游

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/MiniMax-AI/minimax-code> |
| 路径 | `packages/config/src/model-catalog.ts`、`packages/config/src/config.ts` |
| 搬运日期 | 2026-10-20 |
| 上游提交 | 核对时 main 分支 tree SHA `c21e88ef88b1688546fdd579614a54c04626e67b` |
| 另一来源 | 桌面版 `MiniMax Code.app`（2026-10-30 对着已安装的 app.asar 抄 `OPEN_PLATFORM_BASE_URLS`：额度接口在开放平台上，开源仓库里没有这张表） |

## 相对上游改了什么

| 文件 | 改动 |
|---|---|
| `endpoints.ts` | 只抄 `PRESET_BASE_URLS` 与 `LEGACY_MANAGED_PRESET_BASE_URLS`。其余环境在上游开源树里是 `.example.invalid` 占位，没有真值可抄。**2026-10-30 追加 `OPEN_PLATFORM_BASE_URLS`**（cn `www.minimaxi.com` / en `platform.minimax.io` 等八条）：额度胶囊要读开放平台的 `coding_plan/remains`，这张表来自桌面版 `MemoryQuotaTransport` 的 `OPEN_PLATFORM_ORIGINS`，staging/test/dev 各档照抄桌面版真值。 |
| `model-catalog.ts` | 数值一字未改。唯一改动是把上游从 93 KB 的 `config.ts` 引来的 `ModelConfig` / `ModelCapabilitiesConfig` 两个类型就地声明，并删掉本插件用不到的文件上传能力字段的引用。文件内的 models.dev 出处说明见 `NOTICE.md`。 |

## 稳定性

托管网关地址（`agent.minimax.cn` / `agent.minimax.io` 的 `/mavis/api/v1/llm/v1`）是产品内部路由，**官方文档没有承诺过稳定性**。抄过来是为了跟官方保持一致，不是为了它稳定。真出问题时先看这里是否已被官方改动。

## 怎么跟着官方更新

覆盖上游两个文件 → 保留上表的类型改动 → 更新本文件的日期与提交 → 跑本包测试。

## 每日签到的契约（2026-11-07 核对）

签到（daily check-in）的**契约**抄自上游两处，不在本目录的搬运范围内，但出处记在这里：

| 抄的东西 | 上游路径 | 用在哪 |
| --- | --- | --- |
| 面板与领取应答的形状、校验规则、连续天数的算法 | `packages/shared/src/daily-signin.ts` | `src/minimaxi/checkin.ts` |
| 两条地址（`/minimax-cloud/api/v1/signin/status` 与 `…/claim`）与请求头的形状 | `packages/tui/src/checkin/http-gateway.ts` | `src/minimaxi/checkin.ts` |

上游的 `createPublicGatewayRequest`（`packages/tui/src/runtime/public-gateway.ts`）是那两枚
md5 头的出处，与本目录 `src/minimaxi/gateway.ts` 里读额度用的那套**同一对常量**；
签到那侧多带 `client=mcode` 与 `desktop_version` 两个客户端标记。

核对时间 2026-11-07（cn/prod 登录）：状态接口返回 7 天一轮的面板，当天可领 400 积分
（连签第 4、7 天是 1000）。

