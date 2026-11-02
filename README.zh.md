# @goodjin/dsh-acp-agent

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
dsh plugin --profile web add @goodjin/dsh-acp-agent
```

或在 profile 的 `package.json` 里加：

```json
{
  "dependencies": { "@goodjin/dsh-acp-agent": "^0.1.0" }
}

```

然后在 profile 的 `cordis.patch.yml` 里加入你需要的 agent preset 行。详细配置见[安装指南](https://github.com/goodjin/threadharbor/blob/main/docs/install-plugins.zh.md)。

## 要求

- DSH ≥ 0.2.1-rc.2
- Node ≥ 22.19（或 ≥ 24）
- GLM 需要安装并登录 ZCode 桌面版
- MiniMax 需要安装并登录 MiniMax Code

## 许可证

MIT
