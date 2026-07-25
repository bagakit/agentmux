#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import type { AgentMuxAgentSessionLookup } from './agent-session-registry.js'
import {
  AGENTMUX_CLI_HELP,
  AGENTMUX_CLI_SKILL,
  agentMuxCommandHelp
} from './agentmux-cli-help.js'
import { AgentMuxClient } from './client.js'
import {
  AGENTMUX_COMPOSITION_SCHEMA_VERSION,
  type AgentMuxRegionPlacement,
  type AgentMuxRelativeRegion
} from './composition.js'
import { requestAgentMuxComposition } from './composition-control.js'
import { AgentMuxError } from './errors.js'
import { connectLocalAgentMux } from './runtime-client.js'
import { OrderedSessionOutputFollow } from './session-output-follow.js'

const VERSION = '0.1.0'
const CLI_SCHEMA_VERSION = 1 as const
const PLACEMENTS: readonly AgentMuxRegionPlacement[] = [
  'tab', 'split-left', 'split-right', 'split-up', 'split-down'
]

type FlagKind = 'boolean' | 'value' | 'data'
type ParsedFlags = {
  values: Map<string, string>
  booleans: Set<string>
}

function cliError(message: string): AgentMuxError {
  return new AgentMuxError(message, 'INVALID_CLI_ARGUMENT')
}

function parseFlags(args: readonly string[], specs: Readonly<Record<string, FlagKind>>): ParsedFlags {
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag?.startsWith('--')) throw cliError(`Unexpected argument: ${flag ?? ''}`)
    if (values.has(flag) || booleans.has(flag)) throw cliError(`Duplicate option: ${flag}`)
    const kind = specs[flag]
    if (!kind) throw cliError(`Unsupported option: ${flag}`)
    if (kind === 'boolean') {
      booleans.add(flag)
      continue
    }
    const value = args[index + 1]
    if (value === undefined || (kind === 'value' && value.startsWith('--'))) {
      throw cliError(`Missing value for ${flag}.`)
    }
    values.set(flag, value)
    index += 1
  }
  return { values, booleans }
}

function identifier(value: string | undefined, label: string): string {
  if (!value || value.startsWith('--')) throw cliError(`${label} is required.`)
  return value
}

function requiredFlag(flags: ParsedFlags, name: string, label: string): string {
  return identifier(flags.values.get(name), label)
}

function requiredData(flags: ParsedFlags, name: string, label: string): string {
  const value = flags.values.get(name)
  if (value === undefined) throw cliError(`${label} is required.`)
  return value
}

function sessionSubject(args: readonly string[]): { agentSessionId: string; rest: readonly string[] } {
  return {
    agentSessionId: identifier(args[0], 'Agent Session id'),
    rest: args.slice(1)
  }
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
        sessionId: identifier(args[2], 'ACP native session id')
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
  throw cliError('Agent lookup kind is invalid.')
}

function afterByte(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw cliError('--after-byte must be a non-negative safe integer.')
  }
  return parsed
}

function placement(value: string | undefined): AgentMuxRegionPlacement {
  const resolved = value ?? 'split-right'
  if (!PLACEMENTS.includes(resolved as AgentMuxRegionPlacement)) {
    throw cliError('--placement must be tab, split-left, split-right, split-up, or split-down.')
  }
  return resolved as AgentMuxRegionPlacement
}

function relativeRegion(value: string | undefined): AgentMuxRelativeRegion {
  const resolved = value ?? 'self'
  return resolved === 'self'
    ? { kind: 'self' }
    : { kind: 'region', regionId: identifier(resolved, 'Relative Region id') }
}

function managedCaller(): { agentSessionId: string } {
  const agentSessionId = process.env.AGENTMUX_AGENT_SESSION_ID?.trim()
  if (process.env.AGENTMUX_ENV !== '1' || !agentSessionId) {
    throw new AgentMuxError(
      'This command requires an AgentMux-managed Agent caller.',
      'MANAGED_AGENT_CONTEXT_REQUIRED'
    )
  }
  return { agentSessionId }
}

function writeJson(value: unknown, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`)
}

function printSuccess(operation: string, result: unknown): void {
  writeJson({ schemaVersion: CLI_SCHEMA_VERSION, operation, result })
}

function printStream(operation: string, event: string, result: unknown): void {
  writeJson({ schemaVersion: CLI_SCHEMA_VERSION, operation, event, result })
}

async function withClient<T>(operation: (client: AgentMuxClient) => Promise<T>): Promise<T> {
  const client = await connectLocalAgentMux()
  try {
    return await operation(client)
  } finally {
    await client.dispose()
  }
}

async function contextCommand(args: readonly string[]): Promise<number> {
  parseFlags(args, {})
  const receipt = await requestAgentMuxComposition({
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId: randomUUID(),
    operation: 'context',
    caller: managedCaller()
  })
  if (receipt.operation !== 'context') {
    throw new AgentMuxError('Composition context receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  printSuccess(receipt.operation, receipt.result)
  return 0
}

async function launchCommand(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, {
    '--agent': 'value',
    '--prompt': 'data',
    '--placement': 'value',
    '--relative-to': 'value'
  })
  const receipt = await requestAgentMuxComposition({
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId: randomUUID(),
    operation: 'launch',
    caller: managedCaller(),
    executorId: requiredFlag(flags, '--agent', 'Agent Executor id'),
    ...(flags.values.has('--prompt') ? { prompt: flags.values.get('--prompt')! } : {}),
    placement: placement(flags.values.get('--placement')),
    relativeTo: relativeRegion(flags.values.get('--relative-to'))
  })
  if (receipt.operation !== 'launch') {
    throw new AgentMuxError('Composition launch receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  printSuccess(receipt.operation, receipt.result)
  return 0
}

async function sessionList(args: readonly string[]): Promise<number> {
  parseFlags(args, {})
  return await withClient(async (client) => {
    const sessions = await Promise.all(client.agentSessions().map(async (session) => (
      await client.statusAgent(session.agentSessionId)
    )))
    printSuccess('session.list', { sessions })
    return 0
  })
}

async function sessionResolve(args: readonly string[]): Promise<number> {
  const target = lookupSubject(args)
  parseFlags(target.rest, {})
  return await withClient(async (client) => {
    printSuccess('session.resolve', { session: client.resolveAgentSession(target.lookup) })
    return 0
  })
}

async function sessionStatus(args: readonly string[]): Promise<number> {
  const target = sessionSubject(args)
  parseFlags(target.rest, {})
  return await withClient(async (client) => {
    printSuccess('session.status', { status: await client.statusAgent(target.agentSessionId) })
    return 0
  })
}

async function sessionAction(
  operation: 'session.send' | 'session.interrupt' | 'session.resume' | 'session.stop',
  args: readonly string[]
): Promise<number> {
  const target = sessionSubject(args)
  const needsText = operation === 'session.send' || operation === 'session.resume'
  const flags = parseFlags(target.rest, needsText ? { '--text': 'data' } : {})
  return await withClient(async (client) => {
    if (operation === 'session.send') {
      await client.submitAgentPrompt({
        agentSessionId: target.agentSessionId,
        operationId: randomUUID(),
        prompt: requiredData(flags, '--text', 'Prompt text')
      })
      printSuccess(operation, { agentSessionId: target.agentSessionId })
    } else if (operation === 'session.interrupt') {
      await client.signalAgent(target.agentSessionId, 'SIGINT')
      printSuccess(operation, { agentSessionId: target.agentSessionId })
    } else if (operation === 'session.resume') {
      const session = await client.resumeAgent({
        agentSessionId: target.agentSessionId,
        operationId: randomUUID(),
        prompt: requiredData(flags, '--text', 'Resume prompt')
      })
      printSuccess(operation, { session })
    } else {
      const session = client.agentSession(target.agentSessionId)
      await client.stopAgent(target.agentSessionId, session.run)
      printSuccess(operation, { agentSessionId: target.agentSessionId })
    }
    return 0
  })
}

async function sessionOutput(args: readonly string[]): Promise<number> {
  const target = sessionSubject(args)
  const flags = parseFlags(target.rest, { '--after-byte': 'value', '--follow': 'boolean' })
  const follow = flags.booleans.has('--follow')
  const requestedAfterByte = afterByte(flags.values.get('--after-byte'))
  return await withClient(async (client) => {
    const runId = client.agentSession(target.agentSessionId).run.runId
    let finish: ((value: { state: string; exitCode?: number; exitSignal?: string }) => void) | null = null
    const completed = new Promise<{ state: string; exitCode?: number; exitSignal?: string }>((resolve) => {
      finish = resolve
    })
    const orderedFollow = new OrderedSessionOutputFollow(
      runId,
      requestedAfterByte,
      (event) => {
        printStream('session.output', 'output', {
          runId: event.runId,
          replay: event.replay,
          startByte: event.startByte,
          endByte: event.endByte,
          data: event.data
        })
      },
      (event) => finish?.(event)
    )
    const unsubscribe = follow
      ? client.onEvent((event) => orderedFollow.accept(event))
      : () => {}
    let attached: Awaited<ReturnType<AgentMuxClient['reattachAgent']>> | null = null
    try {
      attached = await client.reattachAgent(target.agentSessionId, requestedAfterByte)
      if (!follow) {
        printSuccess('session.output', {
          session: attached.session,
          run: attached.attachment.run,
          replay: attached.attachment.replay,
          gap: attached.attachment.gap
        })
        return 0
      }
      printStream('session.output', 'attached', {
        session: attached.session,
        run: attached.attachment.run,
        gap: attached.attachment.gap
      })
      orderedFollow.finishReplay(attached.attachment.replay)
      if (attached.attachment.run.state !== 'running') {
        printStream('session.output', 'end', { runId, state: attached.attachment.run.state })
        return 0
      }
      const interrupted = (): void => finish?.({ state: 'reader-interrupted' })
      process.once('SIGINT', interrupted)
      try {
        const ended = await completed
        printStream('session.output', 'end', { runId, ...ended })
      } finally {
        process.off('SIGINT', interrupted)
      }
      return 0
    } finally {
      unsubscribe()
      if (attached) await client.releaseRunAttachment(attached.attachment.run)
    }
  })
}

async function regionOpen(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, {
    '--session': 'value',
    '--placement': 'value',
    '--relative-to': 'value'
  })
  const receipt = await requestAgentMuxComposition({
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId: randomUUID(),
    operation: 'region.open',
    caller: managedCaller(),
    agentSessionId: requiredFlag(flags, '--session', 'Agent Session id'),
    placement: placement(flags.values.get('--placement')),
    relativeTo: relativeRegion(flags.values.get('--relative-to'))
  })
  if (receipt.operation !== 'region.open') {
    throw new AgentMuxError('Composition Region open receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  printSuccess(receipt.operation, receipt.result)
  return 0
}

async function regionFocus(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { '--region': 'value' })
  const receipt = await requestAgentMuxComposition({
    schemaVersion: AGENTMUX_COMPOSITION_SCHEMA_VERSION,
    requestId: randomUUID(),
    operation: 'region.focus',
    regionId: requiredFlag(flags, '--region', 'Region id')
  })
  if (receipt.operation !== 'region.focus') {
    throw new AgentMuxError('Composition Region focus receipt is invalid.', 'COMPOSITION_PROTOCOL_ERROR')
  }
  printSuccess(receipt.operation, receipt.result)
  return 0
}

function operationPath(args: readonly string[]): string | null {
  if (args[0] === 'context' || args[0] === 'launch') return args[0]
  if ((args[0] === 'session' || args[0] === 'region') && args[1]) return `${args[0]}.${args[1]}`
  if (args[0] === 'session' || args[0] === 'region') return args[0]
  return null
}

function requestsHelp(args: readonly string[]): boolean {
  return args.some((argument, index) => (
    (argument === '--help' || argument === '-h') &&
    args[index - 1] !== '--text' &&
    args[index - 1] !== '--prompt'
  ))
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
  if (requestsHelp(args)) {
    const help = agentMuxCommandHelp(operationPath(args) ?? '')
    if (!help) throw cliError('Unknown command. Run agentmux --help.')
    process.stdout.write(`${help}\n`)
    return 0
  }
  if (args[0] === 'context') return await contextCommand(args.slice(1))
  if (args[0] === 'launch') return await launchCommand(args.slice(1))
  if (args[0] === 'session') {
    if (args[1] === 'list') return await sessionList(args.slice(2))
    if (args[1] === 'resolve') return await sessionResolve(args.slice(2))
    if (args[1] === 'status') return await sessionStatus(args.slice(2))
    if (args[1] === 'send') return await sessionAction('session.send', args.slice(2))
    if (args[1] === 'interrupt') return await sessionAction('session.interrupt', args.slice(2))
    if (args[1] === 'output') return await sessionOutput(args.slice(2))
    if (args[1] === 'resume') return await sessionAction('session.resume', args.slice(2))
    if (args[1] === 'stop') return await sessionAction('session.stop', args.slice(2))
  }
  if (args[0] === 'region') {
    if (args[1] === 'open') return await regionOpen(args.slice(2))
    if (args[1] === 'focus') return await regionFocus(args.slice(2))
  }
  throw cliError('Unknown command. Run agentmux --help.')
}

const attemptedOperation = operationPath(process.argv.slice(2))
void main().then((exitCode) => {
  process.exitCode = exitCode
}, (error) => {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'AGENTMUX_FAILED'
  writeJson({
    schemaVersion: CLI_SCHEMA_VERSION,
    operation: attemptedOperation,
    error: { code, message: error instanceof Error ? error.message : String(error) }
  }, process.stderr)
  process.exitCode = 1
})
