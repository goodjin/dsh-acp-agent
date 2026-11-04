# 外部 agent 的委派落到 DSH 侧

> 核对时间：2026-11-05
> 状态：设计已定，尚未实现
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
判据用会话头的 `origin === 'subagent'`（宿主给受委派子会话打���标记，
见 `src/entry.ts:550` 造影子子会话时用的同一个字段），或 `delegationDepth > 0`。
两道判定都要加：`ctx.on('agent/created')` 那条（`src/plugin.ts:404` 附近）与
预设改选那条。

**其三：路由表的语义要分清。**
superpowers 的钉表里多数技能指向 `acp:` 前缀路由。按「一张表，原语义不变」的决定，
这些钉子保持今天的含义（由那个外部 agent 应答）；指向 DSH 原生供应商的钉子
（`zai-coding-cn` / `minimax-cn` / `iquest` 等），孩子才真的在 DSH 里跑、
真的用 DSH 的工具。**这是既有语义，不是本设计引入的**——今天的 superpowers 委派就是这样。
想让某个技能用上 DSH 的工具，在设置里把那一行的钉子改指原生供应商即可。

### 一个必须先解决的事实：孩子的工具从哪来

孩子继承**父会话的预设组合**。ACP 预设（`acp-codex` 等）的插件清单目前**只有绑定行**
（`cordis.patch.yml` 里 `acp-codex` / `acp-claude` / … 各自的 `plugins:` 只有一项），
所以这样起出来的孩子会拿到一张空工具表。

修法：在 ACP 预设里补上 DSH 的常用工具行（bash、fs、fs-search、todo）。
这是 acp-agent 自己补丁文件里的事，不跨插件。对 ACP 驱动的**父**会话本身无害：
它的回合由外部 agent 驱动，DSH 的工具不会被它用到；工具表只在 DSH 侧跑模型时才有意义。

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

选**本机 HTTP 路由 + 每次会话一枚随机令牌**：

- 插件在宿主 web 服务器上注册一条 exact 路由，校验令牌（不是浏览器凭据——
  来回调的是本机子进程，不是浏览器）。
- 令牌由 DSH 在建会话时生成，随 `mcpServers` 的 `env` 交给 agent，agent 拉起
  桥接进程时带上它。
- 桥接进程是最小 MCP 服务端：处理 `initialize` / `tools/list` / `tools/call`，
  收到 `tools/call` 就把参数 POST 给宿主路由，把结果当工具结果回去。

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
桥接进程、宿主路由、委派服务、接管排除守卫、ACP 预设补工具行。
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
| 某家不认客户端提供的 MCP 服务器 | 阶段 0 探针先量；不认则该家只能走别的通道（见开放问题） |
| agent 不理我们的工具，仍用原生委派 | 阶段 2 用 prompt 引导；阶段 3 硬接管 |
| 子代理跑得比 MCP 工具超时久 | 见 §失败与降级最后一行 |
| 桥接进程的 `env` 没被 agent 传给子进程 | 阶段 0 探针第 4 项先量 |

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

## 实施落点

**dsh-acp-agent**

| 位置 | 改什么 |
|---|---|
| `src/runner.ts:2216`、`:2243` | `session/new` 与 `session/load`/`resume` 的 `mcpServers` 带上我们的服务器 |
| `src/dispatch.ts` / `src/plugin.ts` | 接管判定排除委派来源的会话 |
| 新增（宿主行） | 注册回调路由；提供桥接进程 |
| `cordis.patch.yml` | ACP 预设补 DSH 工具行 |

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
