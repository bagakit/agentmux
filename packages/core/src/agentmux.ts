#!/usr/bin/env node
import process from 'node:process'
import { connectLocalAgentMux } from './runtime-client.js'
import { diagnoseAgentMux, type AgentMuxDoctorReport } from './doctor.js'
import { AgentMuxError } from './errors.js'

const USAGE = [
  'Usage:',
  '  agentmux doctor [--json]'
].join('\n')

type ParsedFlags = {
  values: Map<string, string>
  booleans: Set<string>
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag?.startsWith('--')) throw new AgentMuxError(USAGE, 'INVALID_CLI_ARGUMENT')
    if (values.has(flag) || booleans.has(flag)) {
      throw new AgentMuxError(`Duplicate option: ${flag}`, 'INVALID_CLI_ARGUMENT')
    }
    if (flag === '--json') {
      booleans.add(flag)
      continue
    }
    throw new AgentMuxError(`Unsupported option: ${flag}`, 'INVALID_CLI_ARGUMENT')
  }
  return { values, booleans }
}

function printDoctor(report: AgentMuxDoctorReport): void {
  process.stdout.write(`AgentMux doctor: ${report.ok ? 'PASS' : 'FAIL'}\n`)
  if (report.host.reachable) {
    process.stdout.write(
      `Host: ${report.host.hostId} · ${report.host.buildIdentity} · protocol ${report.host.protocolVersion}\n`
    )
  } else {
    process.stdout.write(`Host: unavailable · ${report.host.error}\n`)
  }
  if (report.runtime) {
    process.stdout.write(
      `CtxMux: ${report.runtime.ctxmux.version} · ${report.runtime.ctxmux.artifactPlatform} · ${report.runtime.ctxmux.ready ? 'ready' : 'invalid'}\n`
    )
  }
  for (const agent of report.agents) {
    process.stdout.write(
      `${agent.probe === 'found' ? 'OK' : agent.probe === 'missing' ? 'WARN' : 'BLOCKED'} ${agent.label} (${agent.executable})\n`
    )
  }
  if (report.runtimeAction) process.stdout.write(`Action: ${report.runtimeAction}\n`)
}

async function doctor(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args)
  const client = await connectLocalAgentMux()
  try {
    const report = await diagnoseAgentMux({ client, hostKind: 'local' })
    if (flags.booleans.has('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else printDoctor(report)
    return report.ok ? 0 : 1
  } finally {
    await client.dispose()
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args[0] === 'doctor') return await doctor(args.slice(1))
  throw new AgentMuxError(USAGE, 'INVALID_CLI_ARGUMENT')
}

void main().then((exitCode) => {
  process.exitCode = exitCode
}, (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
