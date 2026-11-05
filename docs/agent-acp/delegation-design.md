# 外部 agent 的委派落到 DSH 侧

> 核对时间：2026-11-05
> 状态：已实现（通路、委派服务、真机探针均完成；装法见 §装法）
> 涉及仓库：`@goodjin2/dsh-acp-agent`（通路）、`@goodjin2/dsh-superpowers`（委派实现）

## 一句话

外部 agent（codex / claude / cursor / qoder / grok）想派子代理时，不再由它自己派，
而是调我们挂上去的委派工具；委派由 DSH 侧执行，孩子在 DSH 里跑、用 DSH 的工具，
模型与技能按 superpowers 的钉表解析。

## 目标与非目标

**目标**

1. 外部 agent 的子代理由 DSH 执行，跑在 DSH 的工具上。
2. 子代理的模型、技能由 superpowers 插件的设置决定（一张钉表，原语义不变）。
3. 委派是**阻塞**的：agent 调完工具即拿到子代理的最终结果。
4. superpowers 没装、或任何一环不可用时，外部 agent 的行为与今天完全一致。

**非目标**

- 不关闭任何一家的原生委派（那是后面的阶段，见 §八）。
- 不改 superpowers 现有的技能作用域决定。
- 不新增第二张路由表。

## 现状与关键事实

### 外部 agent 的委派今天跑在哪里

外部 agent 决定派子代理的动作发生在它**自己进程内部**。DSH 只能在结果帧到达时看见，
那时子代理已经用 agent 自带的工具和模型干完活了。

`src/subagent-sessions.ts` 开头写明了这个边界：外部 agent 派出的子代理运行在它自己的
进程里，DSH 只把出生帧、思考增量、终态帧投影成一个 DSH 子会话「只展示，不执行」。
这条投影路径**保留不动**——它服务的是外部 agent 自己派生的子代理，与本设计正交。

### DSH 侧的委派能力已经完整

superpowers 的 `lib/skill-delegation.js` 里，`delegate_skill` 工具已经做到：
读宿主设置里的钉表 → 按技能定 provider/model → `ctx.subagents.startContinuable`
起 DSH 子会话 → 子代理继承父会话预设因而拿到工具、技能、模型。

缺的不是执行能力，而是「让外部 agent 的委派请求落到这条路上来」的那一段。

### 客户端往 agent 塞工具的正规通道只有一个

ACP 协议里，客户端往 agent 提供模型的唯一入口是 `session/new` 的 `mcpServers`
（[ACP session-setup](https://agentclientprotocol.com/protocol/v1/session-setup)）。
本插件现在写死空数组：`src/runner.ts:2216`（`session/new`）与
`src/runner.ts:2243`（`session/load` / `session/resume`）。

五家的 MCP 能力（实测，见 `docs/agent-acp/README.md` 的能力表）：

| | grok | codex | claude | Cursor | Qoder |
|---|---|---|---|---|---|
| `mcpCapabilities.http` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `mcpCapabilities.sse` | ✅ | ❌ | ✅ | ✅ | ✅ |

规范另有一条：v1 要求**所有 agent 必须支持 stdio 传输**。覆盖面因此以 stdio 最广。

### 三个必须先解决的问题

**其一：stdio 传输下，是 agent 拉起 MCP 服务进程。**
MCP 的关系里，agent 是 MCP 客户端，DSH 是服务端。stdio 传输由客户端拉起服务端进程，
所以 `session/new` 递给 agent 的是 **command / args / env**，agent 自己 spawn。
这意味着桥接进程由 agent 拉起，它要回调 DSH 宿主另找通道（§三）。

**其二：DSH 侧起的孩子会被 ACP 行一起接管。**
委派子代理走宿主标准通道，孩子继承父会话的预设组合，会话头里记着父会话的预设名
（`acp-codex` 等）。ACP 行的接管判定读的就是这个预设名
（`src/dispatch.ts:310` 的 `presetIdOf`）。结果是我们辛苦在 DSH 里起的子代理，
又被外部 agent 接管去驱动，工具又变回外部 agent 的。

**必须在接管判定上加一道排除：委派来源的会话不接管。**
判据用会话头的 `delegationDepth > 0`（宿主给受委派子会话记的深度，与深度上限用同一个
字段，见 `src/entry.ts` 造影子子会话时的写法）。**不用 `origin === 'subagent'`**：它是
粗粒度的来源标签，回答「谁造的」而不是「在血缘的哪一层」。
注意这两条对本行自己造的影子子会话是等价的（影子会话两个都带），影子会话真正的豁免
在更早一步——它的会话头没有预设名，接管判定在 `presetIdOf` 就早退了，走不到这道守卫
（详见 `src/dispatch.ts` 里 `isDelegatedChild` 的注释）。
两道判定都要加：`ctx.on('agent/created')` 那条与预设改选那条。

**其三：路由表的语义要分清。**
superpowers 的钉表里多数技能指向 `acp:` 前缀路由。按「一张表，原语义不变」的决定，
这些钉子保持今天的含义（由那个外部 agent 应答）；指向 DSH 原生供应商的钉子
（`zai-coding-cn` / `minimax-cn` / `iquest` 等），孩子才真的在 DSH 里跑、
真的用 DSH 的工具。**这是既有语义，不是本设计引入的**——今天的 superpowers 委派就是这样。
想让某个技能用上 DSH 的工具，在设置里把那一行的钉子改指原生供应商即可。

### 一个必须先解决的事实：孩子的工具从哪来

孩子继承**父会话的预设组合**。ACP 预置（`acp-codex` 等）的插件清单只有绑定行
（`cordis.patch.yml` 里 `acp-codex` / `acp-claude` / … 各自的 `plugins:` 只有一项），
所以**只做继承**的话，这样起出来的孩子会拿到一张空工具表。

**曾经尝试过、并且已经推翻的修法**：在 ACP 预置里补上 DSH 的常用工具行（bash、fs、
fs-search、todo）。看起来无害——父会话的回合由外部 agent 驱动，DSH 的工具本来就用不上——
但实测（2026-11-05）代价是致命的：预置的 `plugins` 一旦多挂插件，宿主就不再把这家的模型
列进模型目录，codex/claude/grok/cursor/qoder/豆包**整组从模型选择器里消失**
（`/api/session/modelCatalog` 的 `routableProviders` 从 9 个掉到 4 个），宿主侧不报错、
也没有 failure 条目。所以这四行已经全部撤回，`tests/acp-preset-tools.spec.ts` 反过来
钉住「预置里只许有绑定行」。

**真正的修法（按这个做）**：从委派那一侧指定孩子挂哪个预置。宿主的子代理请求支持
`agentPreset`（`dsh-subagent`：`startActivation` 的 `request.agentPreset`，缺席时
同步沿用父会话的预置）——委派服务起孩子时显式挂一个**带工具**的预置（如 `standard`
或 `superpowers`），provider/model 仍按钉表给。这样父会话的预置保持只读形态，
孩子拿到的是完整工具组合。

## 方案总览

三段，各归其位：

| 段 | 归谁 | 职责 |
|---|---|---|
| 通路 | dsh-acp-agent | 建会话时挂 MCP 服务器；提供 stdio 桥接进程；宿主开一条本地路由承接工具调用；接管排除守卫 |
| 委派实现 | dsh-superpowers | 读自己的钉表定模型；读技能正文；起 DSH 子代理；等结果 |
| 接缝 | 宿主服务 | superpowers 发布一个委派服务，acp-agent 按名取；取不到就完全不挂 MCP |

**接缝用宿主服务而不是互相 import**，是为了守住本目录「插件互不依赖」的规矩：
两边只认一个服务名和一份载荷形状，谁都没引用谁。这是本设计里唯一新增的跨插件约定。

### 数据流

```
外部 agent 收到任务
  → 调我们的委派工具（MCP tools/call）
  → 桥接进程把调用转给宿主本地路由（HTTP，带会话令牌）
  → 路由交给 superpowers 的委派服务
  → 服务读钉表定模型、读技能正文、起 DSH 子代理
  → 子代理在 DSH 里跑完
  → 结果原路返回给 agent（工具结果）
```

孩子是**一次性**的：这样「等结果」就是等一个完成信号，语义干净。
它仍是真实 DSH 会话，带父会话血缘，照样出现在会话树里。

### 委派服务契约

superpowers 发布的服务（名字待定，例如 `superpowers.delegation`），方法一个：

```
delegate(request) → result

request: {
  skill?: string          // 技能名；缺省 = 走「其他子代理」那一行
  task: string            // 短标签
  brief: string           // 给孩子的完整任务书（孩子看不到本对话）
  sessionId: string       // 父 DSH 会话 id，用于取父 agent 与工作区
  signal: AbortSignal     // 取消
}

result: {
  output: string          // 子代理的最终文本
  model: string           // 实际用的路由；未钉定 = 'inherited'
  childId: string         // 子会话 id（可观测用）
}
```

服务内部：读钉表 → 定 route → 读自己包里的 SKILL.md 正文 → 起一次性子代理 →
等结果 → 回文本。**技能正文内联**（连同技能目录的绝对路径一并写进任务书，
孩子有 fs 工具，需要时自己读 references/ 与 scripts/），因此与预设组合无关，
也不改 superpowers 现有的技能作用域决定。

### 桥接进程与回调通道

桥接进程由 **agent 拉起**（stdio 传输的必然结果），所以它要回调 DSH 宿主另找通道。

选**本机 HTTP 路由 + 一枚长期令牌**：

- 插件在宿主 web 服务器上注册一条 exact 路由，校验令牌（不是浏览器凭据——
  来回调的是本机子进程，不是浏览器）。令牌比对是定长的（`timingSafeEqual`）。
- **令牌只有一个来源**：宿主行 `acp-agent-delegation-route` 的 `config.token`，
  在 profile 里配一次、长期不变（32 字节 hex）。会话侧从同一行现读同一个值，
  放进 `mcpServers` 的 `env` 交给 agent，agent 拉起桥接进程时带上它。
  **不按会话现生成**：两处各配各的会让回调永远 401，而现生成的令牌在一次重连后
  就对不上了。该行留空 = 回调一律拒绝（fail closed），那是默认形态。
- 桥接进程是最小 MCP 服务端：处理 `initialize` / `tools/list` / `tools/call`，
  收到 `tools/call` 就把参数 POST 给宿主路由，把结果当工具结果回去。
- 结果按 `(sessionId, task, brief)` 缓存已完成的那一份，供「工具调用超时后 agent 再问
  同一件事」时补领；brief 进键，否则同名标签配不同任务书会静默拿到上一次的答案。

宿主路由调 superpowers 的委派服务；服务不存在 → 路由返回明确错误 →
桥接进程把它变成工具错误 → agent 知道这条路不通。

**不用 web 服务器承载 MCP 本身**（不做 MCP-over-HTTP）：宿主只带 MCP 客户端
（`dsh-mcp-client` 是连出去用的），服务端这一侧要自己实现；
而我们只需要一个**回调**通道，HTTP exact 路由在本仓已有成熟用法
（`src/zcode-quota.ts` 等配额路由）。

## 失败与降级

| 情形 | 表现 |
|---|---|
| superpowers 没装 / 委派服务不存在 | 干脆不挂 MCP 服务器；agent 看到的世界与今天一模一样 |
| 桥接进程起不来 / agent 不理 | 委派工具缺席；agent 退回它自己的原生委派；今天的行为 |
| 宿主路由路径被占 | 报名报错，不静默 |
| 钉表里某技能的 route 不可用 | 该技能这一行委派明确失败，报名字；其余技能不受影响 |
| 子代理跑超 MCP 工具调用超时 | agent 侧看到超时错误；子代理继续跑完，结果按任务标识缓存，agent 再次询问同一标识时拿到已完成的结果 |

## 分阶段

**阶段 0：探针，不是功能。**
挂一个只会报一个假工具的最小 stdio MCP 服务器，五家各跑一轮真机，看：

1. 哪家会连（`initialize` 有没有回）；
2. 哪家会列出工具（`tools/list` 有没有回）；
3. 哪家会真的调用（`tools/call` 有没有到）；
4. 拉起桥接进程时 `env` 有没有传下去（令牌能不能到）。

**这一轮的结论直接决定后面是软接管还是此路不通。** 现有真机验收脚本
（`tests/live.spec.ts`，需设 `ACP_AGENT_LIVE_ACP=1`）就是干这个的，
跑一轮要几分钟墙钟时间。原始帧存 `tests/fixtures/captured-frames.<agent>.json`。

**阶段 1：通路与委派实现。**
桥接进程、宿主路由、委派服务、接管排除守卫。
五家统一的一轮基建，先不追求 agent 会不会用。

**阶段 2：软接管。**
在发出去的 prompt 里加一句「需要子代理就调我们的委派工具，别用你自带的 Task/Agent 工具」。
做成按预设开关，不默认污染每一句 prompt。
然后抓帧看各家选不选我们的工具。

**阶段 3：逐家硬接管。**
评估每家能不能关掉原生委派：codex 有 `collaboration_mode` 这个配置项可调，
其余几家得各自试。这一阶段各家行为不同，逐家推进。

## 验证

- 真机抓帧存成夹具（仓库现有做法），单测照着夹具钉死帧形状与投影规则。
- 接管排除守卫：单测证明一个委派子会话不被 ACP 行接管，一个普通 ACP 会话照旧被接管。
- 委派服务：单测证明钉表路由解析、技能正文内联、子代理起法与结果回传。
- 降级：单测证明服务缺席时不挂 MCP 服务器。
- 端到端：DSH 侧的子会话在会话树里能看见、血缘正确、模型与钉表一致。

## 风险与开放问题

| 风险 | 应对 |
|---|---|
| 某家不认客户端提供的 MCP 服务器 | **已量（2026-11-05）**：五家全认、全列工具；四家会调，cursor 不调。见 `docs/agent-acp/mcp-probe.md` |
| agent 不理我们的工具，仍用原生委派 | 阶段 2 用 prompt 引导（`delegationHint`，默认关）；阶段 3 硬接管。cursor 明确指示下也不调，引导语对它无效 |
| 子代理跑得比 MCP 工具超时久 | 见 §失败与降级最后一行（桥接 10 分钟超时 + 路由的结果缓存供补领） |
| 桥接进程的 `env` 没被 agent 传给子进程 | **已量**：五家都把 `env` 传给了 MCP 子进程（探针实收三个变量）。桌面宿主另有一坑：`command` 是 Electron 二进制，已补 `ELECTRON_RUN_AS_NODE=1` |

**开放问题**

1. codex-acp 2.5.0 的 `sessionCapabilities` 里有 `systemPrompt`
   （`docs/agent-acp/codex.md:122`）。若客户端真能设会话系统提示，
   引导语就该走那里而不是拼进 prompt 文本——更干净，也不污染用户输入。
   阶段 0 顺带验。
2. 委派子代理若自己又想委派，深度怎么算。宿主有 `delegationDepth` 机制，
   但外部 agent 的原生多级委派尚未实测（`docs/agent-acp/README.md` 记为未验证）。
3. 一次性子代理与 superpowers 现有的可续聊子代理（`delegate_skill` 走的是
   `startContinuable`）语义不同：一次性拿完结果即弃，不可续聊。
   本设计取一次性（因为要阻塞等结果）；若日后要可续聊，委派服务再加一个方法即可。

## 装法

两行都是**主机侧行**（不能进任何预设的插件清单，否则会被宿主的服务泄漏审计整块回滚）：

1. `superpowers-delegation-service` —— 随 `@goodjin2/dsh-superpowers` 这个 bundle 的 patch
   自动挂上，装插件就有，profile 不用写。
2. `acp-agent-delegation-route` —— 同样随 `@goodjin2/dsh-acp-agent` 的 patch 挂上，但
   默认 `config.token` 是空串（fail closed）。要在桌面版真的用起来，profile 的
   `cordis.patch.yml` 里加一条**覆盖项**（patch 按 id 覆盖，`config` 是整体替换、不是深合并）：

   ```yaml
   - id: acp-agent-delegation-route
     config:
       token: "<openssl rand -hex 32>"
   ```

   令牌只写进本机 profile，**不进任何仓库**。它是唯一来源：会话侧从同一行现读。

其余就是常规的「重装插件 / 重启 App」：两个包都是 `link:` 到本机 checkout，宿主直接
读源码（`src/*.ts` 与 `lib/*.js` 都是源码形态），所以改完**只需重启**，没有构建产物要对齐。
`delegationHint`（引导语）是预设级开关、默认关：实测四家不靠它也会调，而它唯一想影响的
cursor 明确指示下也不调，所以默认不开。

## 实施落点

**dsh-acp-agent**

| 位置 | 改什么 |
|---|---|
| `src/runner.ts:2216`、`:2243` | `session/new` 与 `session/load`/`resume` 的 `mcpServers` 带上我们的服务器 |
| `src/dispatch.ts` / `src/plugin.ts` | 接管判定排除委派来源的会话 |
| 新增（宿主行） | 注册回调路由；提供桥接进程 |
| 委派服务侧 | 起孩子时显式指定 `agentPreset`（见「孩子的工具从哪来」）；**不要**往 ACP 预置里加插件行 |

**dsh-superpowers**

| 位置 | 改什么 |
|---|---|
| 新增（宿主行） | 发布委派服务；实现路由解析、技能正文内联、子代理起法、等结果 |
| `lib/skill-delegation.js` | 复用其已有的路由解析与技能清单，不重写 |

## 明确不做

- 不关闭任何一家的原生委派（阶段 3 之后再说）。
- 不改 superpowers 现有的技能作用域决定。
- 不新增第二张路由表。
- 不把委派塞进 `zcode` / `minimax` 那两条模型插件路线——它们不走 ACP，
  DSH 自己的循环已经在管它们的工具。
