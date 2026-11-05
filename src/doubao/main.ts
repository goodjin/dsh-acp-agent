#!/usr/bin/env node
/**
 * The Doubao browser agent, as a standalone ACP service.
 *
 * The plugin's runner spawns an agent and speaks ACP to it over stdio, so
 * this file is what a preset row points at. Everything it needs is decided
 * by the environment:
 *
 *   DOUBAO_ACP_PORT   devtools port of the Doubao desktop app (default 9555)
 *   DOUBAO_ACP_APP    path of the Doubao executable (default the app in /Applications)
 *
 * The agent starts the app itself when no devtools port is open, and says so
 * on stderr — stdout carries the protocol and nothing else.
 */

import { DoubaoAcpAgent, runStdioAgent } from './agent.ts'

const agent = new DoubaoAcpAgent({
  onDiagnostic: line => process.stderr.write(`${line}\n`),
})

process.stderr.write('doubao-acp: ready on stdio\n')
runStdioAgent(agent)
