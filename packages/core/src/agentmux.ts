#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { connectLocalAgentMux } from './runtime-client.js'
import { diagnoseAgentMux, type AgentMuxDoctorReport } from './doctor.js'
import { requestAgentMuxDesktopFocus } from './desktop-focus-control.js'
import { AgentMuxError } from './errors.js'
import { AgentMuxClient, type AgentMuxAgentRuntimeStatus } from './client.js'
import type { AgentMuxAgentSessionLookup } from './agent-session-registry.js'
import type { AgentMuxViewFocusTarget } from './runtime.js'
import type { AgentMuxAgentSession } from './types.js'
import {
  AGENTMUX_CLI_HELP,
  AGENTMUX_CLI_SKILL,
  agentMuxCommandHelp
} from './agentmux-cli-help.js'

const VERSION = '0.1.0'

type ParsedFlags = {
  values: Map<string, string>
  booleans: Set<string>
}

function requestsCommandHelp(args: readonly string[]): boolean {
  return args.some((argument, index) => (
    (argument === '--help' || argument === '-h') &&
    args[index - 1] !== '--text' &&
    args[index - 1] !== '--after-byte'
  ))
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
    if (!flag?.startsWith('--')) throw new AgentMuxError(AGENTMUX_CLI_HELP, 'INVALID_CLI_ARGUMENT')
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
    if (value === undefined || (value.startsWith('--') && flag !== '--text')) {
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

function identifier(value: string | undefined, label: string): string {
  if (!value || value.startsWith('--')) {
    throw new AgentMuxError(`${label} is required.`, 'INVALID_CLI_ARGUMENT')
  }
  return value
}

function lookupSubject(args: readonly string[]): {
  lookup: AgentMuxAgentSessionLookup
  rest: readonly string[]
} {
  const kind = args[0]
  if (kind === 'agent-session') {
    return {
      lookup: { kind, agentSessionId: identifier(args[1], 'Agent Session id') },
      rest: args.slice(2)
    }
  }
  if (kind === 'provider-native') {
    return {
      lookup: {
        kind,
        providerId: identifier(args[1], 'Provider id'),
        sessionId: identifier(args[2], 'Provider native session id')
      },
      rest: args.slice(3)
    }
  }
  if (kind === 'acp-native') {
    return {
      lookup: {
        kind,
        adapterId: identifier(args[1], 'ACP adapter id'),
        sessionId: identifier(args[2], 'ACP session id')
      },
      rest: args.slice(3)
    }
  }
  if (kind === 'run') {
    return {
      lookup: { kind, run: { runId: identifier(args[1], 'Run id') } },
      rest: args.slice(2)
    }
  }
  throw new AgentMuxError('Agent lookup kind is invalid.', 'INVALID_CLI_ARGUMENT')
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
  if (report.host.action) process.stdout.write(`Host action: ${report.host.action}\n`)
  if (report.runtime) {
    process.stdout.write(
      `CtxMux: ${report.runtime.ctxmux.version} · ${report.runtime.ctxmux.artifactPlatform} · ${report.runtime.ctxmux.ready ? 'ready' : 'invalid'}\n`
    )
    const capabilities = report.runtime.ctxmux.capabilities
    process.stdout.write(
      `CtxMux capabilities: ${capabilities.transport} · ordered bytes · bounded replay · recoverable input · resize · interrupt · complete stop\n`
    )
  }
  process.stdout.write(
    `Hosts: Local ${report.hosts.local.status} · Remote ${report.hosts.remote.status}\n`
  )
  if (report.hosts.local.action) process.stdout.write(`Local action: ${report.hosts.local.action}\n`)
  process.stdout.write(`Remote action: ${report.hosts.remote.action}\n`)
  for (const agent of report.agents) {
    process.stdout.write(
      `${agent.probe === 'found' ? 'OK' : agent.probe === 'missing' ? 'WARN' : 'BLOCKED'} ${agent.label} (${agent.executable}) · Hook ${agent.hook.kind} · ACP ${agent.acp.kind} · Permission ${agent.permission}\n`
    )
    if (agent.action) process.stdout.write(`  Action: ${agent.action}\n`)
  }
  if (report.runtimeAction) process.stdout.write(`Action: ${report.runtimeAction}\n`)
}

function printStatus(status: AgentMuxAgentRuntimeStatus): void {
  process.stdout.write(
    `${status.session.agentSessionId}\t${status.session.agentId}\t${status.run.state}\t${status.run.runId}\t${status.session.workspacePath}\n`
  )
}

function printResolved(session: AgentMuxAgentSession): void {
  process.stdout.write(
    `${session.agentSessionId}\t${session.agentId}\t${session.run.runId}\t${session.workspacePath}\n`
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
  const client = new AgentMuxClient()
  try {
    const report = await diagnoseAgentMux({ client })
    if (flags.booleans.has('--json')) printJson(report)
    else printDoctor(report)
    return report.ok ? 0 : 1
  } finally {
    await client.dispose()
  }
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

async function resolveSession(args: readonly string[]): Promise<number> {
  const target = lookupSubject(args)
  const flags = parseFlags(target.rest, new Set(['--json']), new Set())
  return await withClient(async (client) => {
    const session = client.resolveAgentSession(target.lookup)
    if (flags.booleans.has('--json')) printJson(session)
    else printResolved(session)
    return 0
  })
}

async function switchView(args: readonly string[]): Promise<number> {
  let target: AgentMuxViewFocusTarget
  let rest: readonly string[]
  if (args[0] === 'terminal-view') {
    target = { kind: 'terminal-view', viewId: identifier(args[1], 'Terminal View id') }
    rest = args.slice(2)
  } else {
    const parsed = lookupSubject(args)
    const agentSessionId = await withClient(async (client) => (
      client.resolveAgentSession(parsed.lookup).agentSessionId
    ))
    target = { kind: 'agent-session', agentSessionId }
    rest = parsed.rest
  }
  const flags = parseFlags(rest, new Set(['--json']), new Set())
  const focused = await requestAgentMuxDesktopFocus(target)
  if (flags.booleans.has('--json')) printJson(focused)
  else process.stdout.write(`switch ok: ${focused.kind} ${focused.viewId}\n`)
  return 0
}

async function action(
  name: 'send' | 'interrupt' | 'resume' | 'stop',
  args: readonly string[]
): Promise<number> {
  const target = subject(args)
  const flags = parseFlags(
    target.rest,
    new Set(['--json']),
    name === 'send' || name === 'resume' ? new Set(['--text']) : new Set()
  )
  return await withClient(async (client) => {
    let result: unknown
    if (name === 'send') {
      const text = flags.values.get('--text')
      if (text === undefined) throw new AgentMuxError('--text is required.', 'INVALID_CLI_ARGUMENT')
      await client.submitAgentPrompt({
        agentSessionId: target.agentSessionId,
        operationId: randomUUID(),
        prompt: text
      })
    } else if (name === 'interrupt') {
      await client.signalAgent(target.agentSessionId, 'SIGINT')
    } else if (name === 'resume') {
      const prompt = flags.values.get('--text')
      if (prompt === undefined) throw new AgentMuxError('--text is required.', 'INVALID_CLI_ARGUMENT')
      result = await client.resumeAgent({
        agentSessionId: target.agentSessionId,
        operationId: randomUUID(),
        prompt
      })
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
    await client.releaseRunAttachment(attached.attachment.run)
    return 0
  })
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${AGENTMUX_CLI_HELP}\n`)
    return 0
  }
  if (args.length === 1 && args[0] === '--skill') {
    process.stdout.write(`${AGENTMUX_CLI_SKILL}\n`)
    return 0
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
    process.stdout.write(`agentmux ${VERSION}\n`)
    return 0
  }
  if (requestsCommandHelp(args.slice(1))) {
    const help = agentMuxCommandHelp(args[0] ?? '')
    if (!help) throw new AgentMuxError(AGENTMUX_CLI_HELP, 'INVALID_CLI_ARGUMENT')
    process.stdout.write(`${help}\n`)
    return 0
  }
  if (args[0] === 'doctor') return await doctor(args.slice(1))
  if (args[0] === 'list') return await list(args.slice(1))
  if (args[0] === 'resolve') return await resolveSession(args.slice(1))
  if (args[0] === 'switch') return await switchView(args.slice(1))
  if (args[0] === 'status') return await status(args.slice(1))
  if (args[0] === 'attach') return await attach(args.slice(1))
  if (args[0] === 'send' || args[0] === 'interrupt' || args[0] === 'resume' || args[0] === 'stop') {
    return await action(args[0], args.slice(1))
  }
  throw new AgentMuxError(AGENTMUX_CLI_HELP, 'INVALID_CLI_ARGUMENT')
}

void main().then((exitCode) => {
  process.exitCode = exitCode
}, (error) => {
  if (error instanceof AgentMuxError) process.stderr.write(`${error.code}: ${error.message}\n`)
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
