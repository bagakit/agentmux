#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import type { AgentMuxAgentSessionLookup } from './agent-session-registry.js'
import { AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from './agentmux-cli-help.js'
import { AgentMuxClient } from './client.js'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  type AgentMuxControlCaller,
  type AgentMuxOpenDestination
} from './control.js'
import { requestAgentMuxControl } from './control-host.js'
import { AgentMuxError } from './errors.js'
import { connectLocalAgentMux } from './runtime-client.js'
import { OrderedSessionOutputFollow } from './session-output-follow.js'

const VERSION = '0.1.0'
const CLI_SCHEMA_VERSION = 1 as const
type FlagKind = 'boolean' | 'value' | 'data'
type ParsedFlags = { values: Map<string, string>; booleans: Set<string> }

function cliError(message: string): AgentMuxError { return new AgentMuxError(message, 'INVALID_CLI_ARGUMENT') }

function parseFlags(args: readonly string[], specs: Readonly<Record<string, FlagKind>>): ParsedFlags {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag?.startsWith('--')) throw cliError(`Unexpected argument: ${flag ?? ''}`)
    if (values.has(flag) || booleans.has(flag)) throw cliError(`Duplicate option: ${flag}`)
    const kind = specs[flag]
    if (!kind) throw cliError(`Unsupported option: ${flag}`)
    if (kind === 'boolean') { booleans.add(flag); continue }
    const value = args[index + 1]
    if (value === undefined || (kind === 'value' && value.startsWith('--'))) throw cliError(`Missing value for ${flag}.`)
    values.set(flag, value); index += 1
  }
  return { values, booleans }
}

function identifier(value: string | undefined, label: string): string {
  if (!value || value.startsWith('--')) throw cliError(`${label} is required.`)
  return value
}

function requiredData(flags: ParsedFlags, name: string, label: string): string {
  const value = flags.values.get(name)
  if (value === undefined) throw cliError(`${label} is required.`)
  return value
}

function exactlyOne(flags: ParsedFlags, names: readonly string[], label: string): string {
  const present = names.filter((name) => flags.values.has(name))
  if (present.length !== 1) throw cliError(`${label} requires exactly one of ${names.join(', ')}.`)
  return present[0]!
}

function managedCaller(): AgentMuxControlCaller {
  const agentSessionId = process.env.AGENTMUX_AGENT_SESSION_ID?.trim()
  if (process.env.AGENTMUX_ENV !== '1' || !agentSessionId) throw new AgentMuxError('This command requires an AgentMux-managed Agent caller.', 'MANAGED_AGENT_CONTEXT_REQUIRED')
  return { agentSessionId }
}

function callerForSelf(value: string): AgentMuxControlCaller | undefined {
  return value === 'self' ? managedCaller() : undefined
}

function sessionId(value: string): string { return value === 'self' ? managedCaller().agentSessionId : identifier(value, 'Agent Session id') }
function requestBase() { return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID() } as const }
function writeJson(value: unknown, stream: NodeJS.WritableStream = process.stdout): void { stream.write(`${JSON.stringify(value)}\n`) }
function printSuccess(operation: string, result: unknown): void { writeJson({ schemaVersion: CLI_SCHEMA_VERSION, operation, result }) }
function printStream(operation: string, event: string, result: unknown): void { writeJson({ schemaVersion: CLI_SCHEMA_VERSION, operation, event, result }) }

async function withClient<T>(operation: (client: AgentMuxClient) => Promise<T>): Promise<T> {
  const client = await connectLocalAgentMux()
  try { return await operation(client) } finally { await client.dispose() }
}

async function inspectCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, {
    '--session': 'value', '--run': 'value', '--tab': 'value', '--region': 'value',
    '--provider-native': 'value', '--provider': 'value', '--acp-native': 'value', '--adapter': 'value'
  })
  const selector = exactlyOne(flags, ['--session', '--run', '--tab', '--region', '--provider-native', '--acp-native'], 'inspect')
  if (selector === '--tab') {
    const value = flags.values.get(selector)!
    const owner = callerForSelf(value)
    const receipt = await requestAgentMuxControl({
      ...requestBase(), operation: 'inspect.tab',
      target: value === 'self' ? { kind: 'self' } : { kind: 'tab', tabId: identifier(value, 'Tab id') },
      ...(owner ? { caller: owner } : {})
    })
    printSuccess(receipt.operation, receipt.result); return 0
  }
  if (selector === '--region') {
    const value = flags.values.get(selector)!
    const owner = callerForSelf(value)
    const receipt = await requestAgentMuxControl({
      ...requestBase(), operation: 'inspect.region',
      target: value === 'self' ? { kind: 'self' } : { kind: 'region', regionId: identifier(value, 'Region id') },
      ...(owner ? { caller: owner } : {})
    })
    printSuccess(receipt.operation, receipt.result); return 0
  }
  return await withClient(async (client) => {
    let lookup: AgentMuxAgentSessionLookup
    if (selector === '--session') lookup = { kind: 'agent-session', agentSessionId: sessionId(flags.values.get(selector)!) }
    else if (selector === '--run') lookup = { kind: 'run', run: { runId: identifier(flags.values.get(selector), 'Run id') } }
    else if (selector === '--provider-native') {
      lookup = { kind: 'provider-native', providerId: identifier(flags.values.get('--provider'), 'Provider id'), sessionId: identifier(flags.values.get(selector), 'Provider-native session id') }
    } else {
      lookup = { kind: 'acp-native', adapterId: identifier(flags.values.get('--adapter'), 'ACP adapter id'), sessionId: identifier(flags.values.get(selector), 'ACP-native session id') }
    }
    const session = client.resolveAgentSession(lookup)
    printSuccess('inspect.session', { session })
    return 0
  })
}

async function listCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== 'agents' && args[0] !== 'sessions') throw cliError('list requires agents or sessions.')
  parseFlags(args.slice(1), {})
  if (args[0] === 'agents') {
    const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'list.agents' })
    printSuccess(receipt.operation, receipt.result)
    return 0
  }
  return await withClient(async (client) => {
    const sessions = await Promise.all(client.agentSessions().map(async (session) => await client.statusAgent(session.agentSessionId)))
    printSuccess('list.sessions', { sessions }); return 0
  })
}

function openDestination(flags: ParsedFlags): { destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller } {
  const selected = exactlyOne(flags, ['--left-of', '--right-of', '--above', '--below', '--new-tab-after', '--in-region'], 'open')
  const value = flags.values.get(selected)!
  const owner = callerForSelf(value)
  if (selected === '--new-tab-after') return { destination: { kind: 'new-tab', after: value === 'self' ? { kind: 'self' } : { kind: 'tab', tabId: identifier(value, 'Tab id') } }, ...(owner ? { caller: owner } : {}) }
  if (selected === '--in-region') return { destination: { kind: 'launcher', regionId: identifier(value, 'Launcher Region id') } }
  const direction = selected === '--left-of' ? 'left' : selected === '--right-of' ? 'right' : selected === '--above' ? 'up' : 'down'
  return { destination: { kind: 'split', direction, region: value === 'self' ? { kind: 'self' } : { kind: 'region', regionId: identifier(value, 'Region id') } }, ...(owner ? { caller: owner } : {}) }
}

async function openCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== 'agent') throw cliError('open currently supports agent.')
  const flags = parseFlags(args.slice(1), {
    '--agent': 'value', '--session': 'value', '--prompt': 'data',
    '--left-of': 'value', '--right-of': 'value', '--above': 'value', '--below': 'value',
    '--new-tab-after': 'value', '--in-region': 'value'
  })
  const contentFlag = exactlyOne(flags, ['--agent', '--session'], 'open agent')
  if (contentFlag === '--session' && flags.values.has('--prompt')) throw cliError('--prompt is valid only with --agent.')
  const placement = openDestination(flags)
  const receipt = await requestAgentMuxControl({
    ...requestBase(), operation: 'open.agent',
    content: contentFlag === '--agent'
      ? { kind: 'new-agent', executorId: identifier(flags.values.get(contentFlag), 'Agent Executor id'), ...(flags.values.has('--prompt') ? { prompt: flags.values.get('--prompt')! } : {}) }
      : { kind: 'agent-session', agentSessionId: identifier(flags.values.get(contentFlag), 'Agent Session id') },
    ...placement
  })
  printSuccess(receipt.operation, receipt.result); return 0
}

async function sendCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--to-session': 'value', '--to-region': 'value', '--to-tab': 'value', '--text': 'data' })
  const selected = exactlyOne(flags, ['--to-session', '--to-region', '--to-tab'], 'send')
  const value = flags.values.get(selected)!
  const owner = selected === '--to-session' ? callerForSelf(value) : undefined
  const target = selected === '--to-session'
    ? value === 'self' ? { kind: 'self' } as const : { kind: 'agent-session', agentSessionId: identifier(value, 'Agent Session id') } as const
    : selected === '--to-region'
      ? { kind: 'region', regionId: identifier(value, 'Region id') } as const
      : { kind: 'tab', tabId: identifier(value, 'Tab id') } as const
  const receipt = await requestAgentMuxControl({ ...requestBase(), operation: 'send', target, text: requiredData(flags, '--text', 'Message text'), ...(owner ? { caller: owner } : {}) })
  printSuccess(receipt.operation, receipt.result); return 0
}

async function focusCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--region': 'value', '--tab': 'value' })
  const selected = exactlyOne(flags, ['--region', '--tab'], 'focus')
  const value = flags.values.get(selected)!
  const receipt = await requestAgentMuxControl({
    ...requestBase(), operation: 'focus',
    target: selected === '--region' ? { kind: 'region', regionId: identifier(value, 'Region id') } : { kind: 'tab', tabId: identifier(value, 'Tab id') }
  })
  printSuccess(receipt.operation, receipt.result); return 0
}

function afterByte(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw cliError('--after-byte must be a non-negative safe integer.')
  return parsed
}

async function outputCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--session': 'value', '--after-byte': 'value', '--follow': 'boolean' })
  const agentSessionId = sessionId(identifier(flags.values.get('--session'), 'Agent Session id'))
  const follow = flags.booleans.has('--follow')
  const requestedAfterByte = afterByte(flags.values.get('--after-byte'))
  return await withClient(async (client) => {
    const runId = client.agentSession(agentSessionId).run.runId
    let finish: ((value: { state: string; exitCode?: number; exitSignal?: string }) => void) | null = null
    const completed = new Promise<{ state: string; exitCode?: number; exitSignal?: string }>((resolve) => { finish = resolve })
    const ordered = new OrderedSessionOutputFollow(runId, requestedAfterByte, (event) => printStream('output', 'output', { runId: event.runId, replay: event.replay, startByte: event.startByte, endByte: event.endByte, data: event.data }), (event) => finish?.(event))
    const unsubscribe = follow ? client.onEvent((event) => ordered.accept(event)) : () => {}
    let attached: Awaited<ReturnType<AgentMuxClient['reattachAgent']>> | null = null
    try {
      attached = await client.reattachAgent(agentSessionId, requestedAfterByte)
      if (!follow) { printSuccess('output', { session: attached.session, run: attached.attachment.run, replay: attached.attachment.replay, gap: attached.attachment.gap }); return 0 }
      printStream('output', 'attached', { session: attached.session, run: attached.attachment.run, gap: attached.attachment.gap })
      ordered.finishReplay(attached.attachment.replay)
      if (attached.attachment.run.state !== 'running') { printStream('output', 'end', { runId, state: attached.attachment.run.state }); return 0 }
      const interrupted = (): void => finish?.({ state: 'reader-interrupted' })
      process.once('SIGINT', interrupted)
      try { printStream('output', 'end', { runId, ...await completed }) } finally { process.off('SIGINT', interrupted) }
      return 0
    } finally { unsubscribe(); if (attached) await client.releaseRunAttachment(attached.attachment.run) }
  })
}

async function sessionMutation(operation: 'interrupt' | 'resume' | 'stop', args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, operation === 'resume' ? { '--session': 'value', '--text': 'data' } : { '--session': 'value' })
  const value = identifier(flags.values.get('--session'), 'Agent Session id')
  const owner = callerForSelf(value)
  const target = value === 'self' ? { kind: 'self' } as const : { kind: 'agent-session', agentSessionId: value } as const
  const receipt = operation === 'resume'
    ? await requestAgentMuxControl({
        ...requestBase(), operation, target,
        text: requiredData(flags, '--text', 'Resume text'),
        ...(owner ? { caller: owner } : {})
      })
    : operation === 'interrupt'
      ? await requestAgentMuxControl({ ...requestBase(), operation, target, ...(owner ? { caller: owner } : {}) })
      : await requestAgentMuxControl({ ...requestBase(), operation, target, ...(owner ? { caller: owner } : {}) })
  printSuccess(receipt.operation, receipt.result); return 0
}

function operationPath(args: readonly string[]): string | null {
  if (args[0] === 'open' && args[1]) return `${args[0]}.${args[1]}`
  return args[0] ?? null
}
function requestsHelp(args: readonly string[]): boolean {
  return args.some((argument, index) => (argument === '--help' || argument === '-h') && args[index - 1] !== '--text' && args[index - 1] !== '--prompt')
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') { process.stdout.write(`${AGENTMUX_CLI_HELP}\n`); return 0 }
  if (args.length === 1 && args[0] === '--skill') { process.stdout.write(`${AGENTMUX_CLI_SKILL}\n`); return 0 }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) { process.stdout.write(`agentmux ${VERSION}\n`); return 0 }
  if (requestsHelp(args)) {
    const help = agentMuxCommandHelp(operationPath(args) ?? '')
    if (!help) throw cliError('Unknown command. Run agentmux --help.')
    process.stdout.write(`${help}\n`); return 0
  }
  if (args[0] === 'inspect') return await inspectCommand(args.slice(1))
  if (args[0] === 'list') return await listCommand(args.slice(1))
  if (args[0] === 'open') return await openCommand(args.slice(1))
  if (args[0] === 'send') return await sendCommand(args.slice(1))
  if (args[0] === 'focus') return await focusCommand(args.slice(1))
  if (args[0] === 'output') return await outputCommand(args.slice(1))
  if (args[0] === 'interrupt') return await sessionMutation('interrupt', args.slice(1))
  if (args[0] === 'resume') return await sessionMutation('resume', args.slice(1))
  if (args[0] === 'stop') return await sessionMutation('stop', args.slice(1))
  throw cliError('Unknown command. Run agentmux --help.')
}

const attemptedOperation = operationPath(process.argv.slice(2))
void main().then((exitCode) => { process.exitCode = exitCode }, (error) => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'AGENTMUX_FAILED'
  const candidates = typeof error === 'object' && error !== null && 'candidates' in error ? error.candidates : undefined
  writeJson({ schemaVersion: CLI_SCHEMA_VERSION, operation: attemptedOperation, error: { code, message: error instanceof Error ? error.message : String(error), ...(candidates ? { candidates } : {}) } }, process.stderr)
  process.exitCode = 1
})
