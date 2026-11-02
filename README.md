# @goodjin/dsh-acp-agent

[English](README.md) | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that connects external coding agents to DSH's native session interface. Supports GLM (ZCode), MiniMax, Codex, Claude, Grok, Cursor, and Qoder.

## What it does

- **ACP agent framework** — transports (stdio, WebSocket), per-agent dialects, frame projection, terminal & file sub-protocols
- **GLM (ZCode) model client** — decrypts local ZCode login, calls GLM Coding Plan, streams responses
- **MiniMax model client** — reads/refreshes MiniMax Code credentials, calls managed gateway
- **Preset dispatch** — registers external agents as DSH presets, takes over sessions, routes turns, handles model switching
- **Quota pills** — host-side GLM/MiniMax/Codex/Claude quota endpoints for the composer's quota display
- **Roster filter** — hides marked presets from the new-session picker
- **Mermaid asset** — serves the Mermaid rendering runtime on demand

## Install

From GitHub Packages:

```sh
# Set up auth (one-time)
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc
echo "@goodjin:registry=https://npm.pkg.github.com" >> ~/.npmrc

dsh plugin --profile web add @goodjin/dsh-acp-agent
```

Or add to your profile's `package.json`:

```json
{
  "dependencies": { "@goodjin/dsh-acp-agent": "^0.1.0" }
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
