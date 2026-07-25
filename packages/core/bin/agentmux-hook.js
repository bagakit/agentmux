#!/usr/bin/env node
import { runAgentHookCommand } from '../dist/agent-hook-command.js'

void runAgentHookCommand().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
