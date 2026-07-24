#!/usr/bin/env node
import process from 'node:process'
import { connectLocalAgentMux } from './runtime-client.js'
import { diagnoseAgentMux, type AgentMuxDoctorReport } from './doctor.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxClient, AgentMuxAgentRuntimeStatus } from './client.js'

const USAGE = [
  'Usage:',
  '  agentmux doctor [--json]',
  '  agentmux list [--json]',
  '  agentmux status <agent-session-id> [--json]',
  '  agentmux send <agent-session-id> --text <prompt> [--json]',
  '  agentmux interrupt <agent-session-id> [--json]',
  '  agentmux attach <agent-session-id> [--after-byte <n>] [--json]',
  '  agentmux resume <agent-session-id> [--json]',
  '  agentmux stop <agent-session-id> [--json]'
].join('\n')

type ParsedFlags = {
  values: Map<string, string>
  booleans: Set<string>
}

function parseFlags(
  args: readonly string[],
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>
): ParsedFlags {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag?.startsWith('--')) throw new AgentMuxError(USAGE, 'INVALID_CLI_ARGUMENT')
    if (values.has(flag) || booleans.has(flag)) {
      throw new AgentMuxError(`Duplicate option: ${flag}`, 'INVALID_CLI_ARGUMENT')
    }
    if (booleanFlags.has(flag)) {
      booleans.add(flag)
      continue
    }
    if (!valueFlags.has(flag)) {
      throw new AgentMuxError(`Unsupported option: ${flag}`, 'INVALID_CLI_ARGUMENT')
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new AgentMuxError(`Missing value for ${flag}.`, 'INVALID_CLI_ARGUMENT')
    }
    values.set(flag, value)
    index += 1
  }
  return { values, booleans }
}

function subject(args: readonly string[]): { agentSessionId: string; rest: readonly string[] } {
  const agentSessionId = args[0]
  if (!agentSessionId || agentSessionId.startsWith('--')) {
    throw new AgentMuxError('Agent Session id is required.', 'INVALID_CLI_ARGUMENT')
  }
  return { agentSessionId, rest: args.slice(1) }
}

function afterByte(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AgentMuxError('--after-byte must be a non-negative safe integer.', 'INVALID_CLI_ARGUMENT')
  }
  return parsed
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
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

function printStatus(status: AgentMuxAgentRuntimeStatus): void {
  process.stdout.write(
    `${status.session.agentSessionId}\t${status.session.agentId}\t${status.run.state}\t${status.run.runId}\t${status.session.workspacePath}\n`
  )
}

async function withClient<T>(operation: (client: AgentMuxClient) => Promise<T>): Promise<T> {
  const client = await connectLocalAgentMux()
  try {
    return await operation(client)
  } finally {
    await client.dispose()
  }
}

async function doctor(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, new Set(['--json']), new Set())
  return await withClient(async (client) => {
    const report = await diagnoseAgentMux({ client, hostKind: 'local' })
    if (flags.booleans.has('--json')) printJson(report)
    else printDoctor(report)
    return report.ok ? 0 : 1
  })
}

async function list(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, new Set(['--json']), new Set())
  return await withClient(async (client) => {
    const statuses = await Promise.all(
      client.agentSessions().map(async (session) => await client.statusAgent(session.agentSessionId))
    )
    if (flags.booleans.has('--json')) printJson(statuses)
    else for (const status of statuses) printStatus(status)
    return 0
  })
}

async function status(args: readonly string[]): Promise<number> {
  const target = subject(args)
  const flags = parseFlags(target.rest, new Set(['--json']), new Set())
  return await withClient(async (client) => {
    const result = await client.statusAgent(target.agentSessionId)
    if (flags.booleans.has('--json')) printJson(result)
    else printStatus(result)
    return 0
  })
}

async function action(
  name: 'send' | 'interrupt' | 'resume' | 'stop',
  args: readonly string[]
): Promise<number> {
  const target = subject(args)
  const flags = parseFlags(
    target.rest,
    new Set(['--json']),
    name === 'send' ? new Set(['--text']) : new Set()
  )
  return await withClient(async (client) => {
    let result: unknown
    if (name === 'send') {
      const text = flags.values.get('--text')
      if (text === undefined) throw new AgentMuxError('--text is required.', 'INVALID_CLI_ARGUMENT')
      await client.submitAgentPrompt(target.agentSessionId, text)
    } else if (name === 'interrupt') {
      await client.signalAgent(target.agentSessionId, 'SIGINT')
    } else if (name === 'resume') {
      result = await client.resumeAgent({ agentSessionId: target.agentSessionId })
    } else {
      await client.stopAgent(target.agentSessionId)
    }
    if (flags.booleans.has('--json')) {
      printJson({ ok: true, action: name, agentSessionId: target.agentSessionId, ...(result ? { result } : {}) })
    } else {
      process.stdout.write(`${name} ok: ${target.agentSessionId}\n`)
    }
    return 0
  })
}

async function attach(args: readonly string[]): Promise<number> {
  const target = subject(args)
  const flags = parseFlags(target.rest, new Set(['--json']), new Set(['--after-byte']))
  return await withClient(async (client) => {
    const currentRunId = client.agentSession(target.agentSessionId).run.runId
    let finish: (() => void) | null = null
    const completed = new Promise<void>((resolve) => { finish = resolve })
    const unsubscribe = client.onEvent((event) => {
      if (!('run' in event) || event.run.runId !== currentRunId) return
      if (event.type === 'terminal-output') {
        if (!flags.booleans.has('--json')) process.stdout.write(event.data)
      }
      if (event.type === 'process-state' && event.state !== 'running') finish?.()
    })
    const attached = await client.reattachAgent(
      target.agentSessionId,
      afterByte(flags.values.get('--after-byte'))
    )
    if (flags.booleans.has('--json')) {
      printJson({
        session: attached.session,
        run: attached.attachment.run,
        replay: attached.attachment.replay,
        gap: attached.attachment.gap
      })
    } else {
      for (const event of attached.attachment.replay) process.stdout.write(event.data)
    }
    if (!flags.booleans.has('--json') && attached.attachment.run.state === 'running') {
      const interrupted = () => finish?.()
      process.once('SIGINT', interrupted)
      try {
        await completed
      } finally {
        process.off('SIGINT', interrupted)
      }
    }
    unsubscribe()
    await client.releaseAgentAttachment(target.agentSessionId)
    return 0
  })
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args[0] === 'doctor') return await doctor(args.slice(1))
  if (args[0] === 'list') return await list(args.slice(1))
  if (args[0] === 'status') return await status(args.slice(1))
  if (args[0] === 'attach') return await attach(args.slice(1))
  if (args[0] === 'send' || args[0] === 'interrupt' || args[0] === 'resume' || args[0] === 'stop') {
    return await action(args[0], args.slice(1))
  }
  throw new AgentMuxError(USAGE, 'INVALID_CLI_ARGUMENT')
}

void main().then((exitCode) => {
  process.exitCode = exitCode
}, (error) => {
  if (error instanceof AgentMuxError) process.stderr.write(`${error.code}: ${error.message}\n`)
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
