# @goodjin2/dsh-acp-agent

[English](README.md) | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that connects external coding agents to DSH's native session interface. Supports GLM (ZCode), MiniMax, Codex, Claude, Grok, Cursor, and Qoder.

## What it does

**Host side** (loads in the DSH process):

- **ACP agent framework** — transports (stdio, WebSocket), per-agent dialects, frame projection, terminal & file sub-protocols
- **GLM (ZCode) model client** — decrypts local ZCode login, calls GLM Coding Plan, streams responses
- **MiniMax model client** — reads/refreshes MiniMax Code credentials, calls managed gateway
- **Preset dispatch** — registers external agents as DSH presets, takes over sessions, routes turns, handles model switching
- **Quota endpoints** — host-side GLM/MiniMax/Codex/Claude quota routes (credentials never leave the host process)
- **Roster filter** — hides marked presets from the new-session picker
- **Mermaid asset** — serves the Mermaid rendering runtime on demand

**Browser side** (`./client` entry, auto-loaded by DSH Web via the `dsh.client` declaration):

- **Quota pills** — the GLM/MiniMax/Codex/Claude pills under the composer, polling the host routes
- **Model visibility panel** — settings section to hide providers and models from the pickers
- **Model label** — the composer's model chip
- **Switch feedback** — handover notice and switch progress bar when the conversation moves to a new session
- **Turn recovery** — the expand button for interrupted no-text turns; resend for requests that never entered the transcript
- **ACP process view** — terminal/file step rendering for external agent turns
- **Markdown turn & Mermaid** — read/expand deliverable text files in the conversation; render ```mermaid blocks

## Install

From GitHub Packages:

```sh
# Set up auth (one-time)
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc
echo "@goodjin:registry=https://npm.pkg.github.com" >> ~/.npmrc

dsh plugin --profile web add @goodjin2/dsh-acp-agent
```

Or add to your profile's `package.json`:

```json
{
  "dependencies": { "@goodjin2/dsh-acp-agent": "^0.1.0" }
}
```

Then add the agent presets you want to your profile's `cordis.patch.yml`. See the [installation guide](https://github.com/goodjin/threadharbor/blob/main/docs/install-plugins.zh.md) for details.

## Requirements

- DSH ≥ 0.2.1-rc.2
- Node ≥ 22.19 (or ≥ 24)
- For GLM: ZCode desktop app installed and logged in
- For MiniMax: MiniMax Code installed and logged in

## Publish

```sh
gh auth refresh -h github.com -s write:packages
NODE_AUTH_TOKEN=$(gh auth token) npm publish --registry https://npm.pkg.github.com
```

## License

MIT
