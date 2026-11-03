# @goodjin2/dsh-acp-agent

[English](README.md) | [中文](README.zh.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把外部 coding agent 接进 DSH 原生会话界面。支持 GLM（ZCode）、MiniMax、Codex、Claude、Grok、Cursor、Qoder。

## 功能

**宿主侧**（加载进 DSH 进程）：

- **ACP agent 框架** — 传输层（stdio、WebSocket）、各家帧方言、帧投影、终端与文件子协议
- **GLM（ZCode）模型客户端** — 解密本机 ZCode 登录凭据、调用 GLM Coding Plan、流式响应
- **MiniMax 模型客户端** — 读取/刷新 MiniMax Code 凭据、调用托管网关
- **Preset 分发** — 把外部 agent 注册为 DSH preset、接管会话、路由回合、处理模型切换
- **配额接口** — 宿主侧 GLM/MiniMax/Codex/Claude 配额路由（凭据不出宿主进程）
- **名册过滤** — 把标记的 preset 从新建会话选择器隐藏
- **Mermaid 资产** — 按需提供会话区 Mermaid 渲染运行时

**浏览器侧**（`./client` 入口，DSH Web 按 `dsh.client` 声明自动加载）：

- **配额胶囊** — 输入框下方的 GLM/MiniMax/Codex/Claude 胶囊，轮询宿主接口
- **模型屏蔽面板** — 设置里的「提供方与模型」屏蔽栏
- **模型标签** — 输入框的模型名显示
- **切换反馈** — 对话移到新会话时的交接提示与切换进度条
- **轮次找回** — 被中断轮次的展开入口；未进入记录请求的重发
- **ACP 进程视图** — 外部 agent 回合的终端/文件步骤渲染
- **Markdown 与 Mermaid** — 会话区展开产出文本文件；渲染 ```mermaid 代码块

## 安装

```sh
dsh plugin --profile web add @goodjin2/dsh-acp-agent
```

或在 profile 的 `package.json` 里加：

```json
{
  "dependencies": { "@goodjin2/dsh-acp-agent": "^0.1.0" }
}

```

然后在 profile 的 `cordis.patch.yml` 里加入你需要的 agent preset 行。详细配置见[安装指南](https://github.com/goodjin/threadharbor/blob/main/docs/install-plugins.zh.md)。

本仓库自带 `cordis.patch.yml`，含七条 agent preset 行、浏览器半边的登记行
（`acp-agent-client`，只有恰好叫这个包名的行才会被当成客户端行），宿主侧的
`roster-filter` / `zcode-quota` / `minimaxi-quota` / `codex-quota` / `claude-quota`
挂载，以及下面这条自报行（2026-11 从 threadharbor 伞仓迁来）。

## 不会静默消失：自报门面

载不进来的模块会连同它那一行一起消失，而它自己报不了这件事。所以本包带一个不 import
包内任何东西的叶子模块（`./health`，行 `threadharbor-health`）——别人全坏了，它照样载入
并说话。

boot 之后它打一行，点名缺哪几行、为什么缺：

```
acp-agent health: 12/13 行已挂载；未挂载 1 行 — threadharbor-minimaxi-quota（MiniMax 套餐额度接口）：SyntaxError: TypeScript parameter property is not supported in strip-only mode
```

同一份账目挂在 `GET /threadharbor/health` 上：
`{ ok, mounted, total, disabled, rows: [{ id, what, status, detail }] }`。`status` 是
`mounted`、`failed`（模块没载入，或 `apply` 抛错）、`pending`（在等注入的服务）、
`absent`（装配的行根本没进 Loader 树）、`disabled`（人主动关的，不算故障）之一。
应答里没有任何令牌或凭据。

同一行还会带时间戳追加到 `$DSH_HOME/logs/acp-agent-health.log`（每次开机一行）。这个文件
才是重点：桌面版不接宿主的 stderr，出事之后要能直接读它，不用重跑任何东西。

为什么有这一层：2026-11-03，`src/minimaxi/credential.ts` 里一句构造函数参数属性让所有
引用它的行在 DSH 的 strip-only 载入下全部失败，宿主半边与浏览器半边一起消失，任何日志里
都看不见；当时只能靠「某条配额路由存不存在」这种副作用查出来。现在有两道挡在前面的闸门：
上面这条自报行，以及 `tests/entry-loadability.spec.ts`——它用真 `node`（不经转译）把每个
宿主入口载入一遍，载不进来就不许合。

## 要求

- DSH ≥ 0.2.1-rc.2
- Node ≥ 22.19（或 ≥ 24）
- GLM 需要安装并登录 ZCode 桌面版
- MiniMax 需要安装并登录 MiniMax Code

## 许可证

MIT
