import { randomUUID } from 'node:crypto'
import { openDemandStore } from './demand-store.js'
import { DEMAND_CLI_SCHEMA, DEMAND_PRIORITIES, DEMAND_STATUSES, type CreateDemandInput, type DemandPriority, type DemandStatus, type UpdateDemandInput } from './demand-types.js'
import { DemandStoreError } from './errors.js'

export type DemandCliIO = {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  env?: NodeJS.ProcessEnv
}

type ParsedArgs = {
  command: string
  options: Map<string, string[]>
}

export async function runDemandCli(argv: readonly string[], io: DemandCliIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(`${text}\n`))
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(`${text}\n`))
  const env = io.env ?? process.env
  const requestId = randomUUID()
  try {
    const parsed = parseArgs(argv)
    if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
      stdout(helpText())
      return 0
    }
    const root = option(parsed.options, 'root') ?? env.AGENTMUX_DEMAND_ROOT
    if (!root) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Demand CLI requires --root or AGENTMUX_DEMAND_ROOT')
    const lockTimeoutMs = numberOption(parsed.options, 'lock-timeout-ms')
    const store = openDemandStore(lockTimeoutMs === undefined ? { root } : { root, lockTimeoutMs })
    const result = await execute(parsed.command, parsed.options, store)
    stdout(JSON.stringify({ schemaVersion: DEMAND_CLI_SCHEMA, requestId, operation: parsed.command, ...result }))
    return 0
  } catch (error) {
    const serialized = error instanceof DemandStoreError
      ? { code: error.code, phase: error.phase, path: error.path, message: error.message }
      : { code: 'CLI_ERROR', phase: 'validate', path: '', message: error instanceof Error ? error.message : String(error) }
    const output = JSON.stringify({ schemaVersion: DEMAND_CLI_SCHEMA, requestId, ok: false, error: serialized })
    stderr(output)
    return 1
  }
}

async function execute(command: string, options: Map<string, string[]>, store: ReturnType<typeof openDemandStore>): Promise<Record<string, unknown>> {
  if (command === 'list') {
    const snapshot = await store.snapshot()
    return { revision: snapshot.revision, demands: snapshot.demands }
  }
  if (command === 'show') {
    const demand = await store.get(required(options, 'id'))
    if (!demand) throw new DemandStoreError('NOT_FOUND', 'validate', store.storePath, `Demand ${required(options, 'id')} was not found`)
    return { revision: (await store.snapshot()).revision, demand }
  }
  if (command === 'create') {
    const input: CreateDemandInput = { title: required(options, 'title'), sessionIds: options.get('session-id') ?? [] }
    const id = option(options, 'id'); if (id !== undefined) input.id = id
    const description = option(options, 'description'); if (description !== undefined) input.description = description
    const status = statusOption(options, 'status'); if (status !== undefined) input.status = status
    const priority = priorityOption(options, 'priority'); if (priority !== undefined) input.priority = priority
    const projectId = option(options, 'project-id'); if (projectId !== undefined) input.projectId = projectId
    const projectName = option(options, 'project-name'); if (projectName !== undefined) input.projectName = projectName
    const executorId = option(options, 'executor-id'); if (executorId !== undefined) input.executorId = executorId
    const receipt = await store.create(input)
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'update') {
    const patch: UpdateDemandInput = {}
    const title = option(options, 'title'); if (title !== undefined) patch.title = title
    const description = option(options, 'description'); if (description !== undefined) patch.description = description
    const status = statusOption(options, 'status'); if (status !== undefined) patch.status = status
    const priority = priorityOption(options, 'priority'); if (priority !== undefined) patch.priority = priority
    const projectId = option(options, 'project-id'); if (projectId !== undefined) patch.projectId = projectId
    const projectName = option(options, 'project-name'); if (projectName !== undefined) patch.projectName = projectName
    const executorId = option(options, 'executor-id'); if (executorId !== undefined) patch.executorId = executorId
    const receipt = await store.update(required(options, 'id'), patch)
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'link-session' || command === 'unlink-session') {
    const id = required(options, 'id')
    const sessionId = required(options, 'session-id')
    const receipt = command === 'link-session' ? await store.linkSession(id, sessionId) : await store.unlinkSession(id, sessionId)
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'link-project') {
    const receipt = await store.linkProject(required(options, 'id'), required(options, 'project-id'), option(options, 'project-name'))
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'unlink-project') {
    const receipt = await store.unlinkProject(required(options, 'id'))
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'decision-log') {
    const receipt = await store.addDecision(required(options, 'id'), {
      question: required(options, 'question'),
      decision: required(options, 'decision'),
      rationale: option(options, 'rationale') ?? '',
      actorId: option(options, 'actor-id') ?? null,
    })
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'activity') {
    const receipt = await store.addActivity(required(options, 'id'), {
      kind: required(options, 'kind'),
      message: required(options, 'message'),
      actorId: option(options, 'actor-id') ?? null,
    })
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'assign') {
    const id = required(options, 'id')
    const patch: UpdateDemandInput = {}
    const projectId = option(options, 'project-id'); if (projectId !== undefined) patch.projectId = projectId
    const projectName = option(options, 'project-name'); if (projectName !== undefined) patch.projectName = projectName
    const executorId = option(options, 'executor-id'); if (executorId !== undefined) patch.executorId = executorId
    const receipt = await store.update(id, patch)
    const activity = await store.addActivity(id, { kind: 'assignment', message: booleanOption(options, 'no-start') ? 'Assigned without starting execution.' : 'Assigned; execution start was explicitly requested.', actorId: option(options, 'actor-id') ?? null })
    return { receipt, activity: activity.demand.activities.at(-1), demand: activity.demand, revision: activity.revision, startRequested: !booleanOption(options, 'no-start') }
  }
  if (command === 'start') {
    const id = required(options, 'id')
    const patch: UpdateDemandInput = { status: 'in_progress' }
    const projectId = option(options, 'project-id'); if (projectId !== undefined) patch.projectId = projectId
    const projectName = option(options, 'project-name'); if (projectName !== undefined) patch.projectName = projectName
    const executorId = option(options, 'executor-id'); if (executorId !== undefined) patch.executorId = executorId
    const updated = await store.update(id, patch)
    const sessionId = option(options, 'session-id')
    const linked = sessionId === undefined ? updated : await store.linkSession(id, sessionId)
    const activity = await store.addActivity(id, { kind: 'execution-started', message: sessionId ? `Execution started with Session ${sessionId}.` : 'Execution start requested; no Session was attached.', actorId: option(options, 'actor-id') ?? null })
    return { receipt: updated, linkedReceipt: linked, activity: activity.demand.activities.at(-1), demand: activity.demand, revision: activity.revision, sessionId: sessionId ?? null }
  }
  if (command === 'handoff') {
    const id = required(options, 'id')
    const executorId = option(options, 'to-executor')
    const updated = await store.update(id, executorId === undefined ? {} : { executorId })
    const sessionId = option(options, 'to-session')
    const linked = sessionId === undefined ? updated : await store.linkSession(id, sessionId)
    const from = option(options, 'from-executor') ?? 'unknown'
    const activity = await store.addActivity(id, { kind: 'handoff', message: `Handoff from ${from} to ${executorId ?? 'unassigned'}${sessionId ? ` with Session ${sessionId}` : ''}.`, actorId: option(options, 'actor-id') ?? null })
    return { receipt: updated, linkedReceipt: linked, activity: activity.demand.activities.at(-1), demand: activity.demand, revision: activity.revision, fromExecutorId: from, toExecutorId: executorId ?? null, sessionId: sessionId ?? null }
  }
  if (command === 'remove' || command === 'delete') {
    if (option(options, 'confirm') !== 'delete') throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Deleting a Demand requires --confirm delete')
    const receipt = await store.remove(required(options, 'id'))
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  throw new DemandStoreError('INVALID_INPUT', 'validate', '', `Unknown Demand command: ${command}`)
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv]
  let command: string | undefined
  const options = new Map<string, string[]>()
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token) continue
    if (!token.startsWith('--')) {
      if (command) throw new DemandStoreError('INVALID_INPUT', 'validate', '', `Unexpected argument: ${token}`)
      command = token
      continue
    }
    const key = token.slice(2)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      if (key === 'no-start') { options.set(key, ['true']); continue }
      throw new DemandStoreError('INVALID_INPUT', 'validate', '', `Missing value for --${key}`)
    }
    const values = options.get(key) ?? []
    values.push(value)
    options.set(key, values)
    index += 1
  }
  return { command: command ?? 'help', options }
}

function option(options: Map<string, string[]>, key: string): string | undefined {
  return options.get(key)?.at(-1)
}

function required(options: Map<string, string[]>, key: string): string {
  const value = option(options, key)
  if (!value) throw new DemandStoreError('INVALID_INPUT', 'validate', '', `--${key} is required`)
  return value
}

function numberOption(options: Map<string, string[]>, key: string): number | undefined {
  const value = option(options, key)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DemandStoreError('INVALID_INPUT', 'validate', '', `--${key} must be a non-negative integer`)
  return parsed
}

function booleanOption(options: Map<string, string[]>, key: string): boolean {
  return option(options, key) === 'true'
}

function statusOption(options: Map<string, string[]>, key: string): DemandStatus | undefined {
  const value = option(options, key)
  if (value === undefined) return undefined
  if (!(DEMAND_STATUSES as readonly string[]).includes(value)) throw new DemandStoreError('INVALID_INPUT', 'validate', '', `--${key} must be one of ${DEMAND_STATUSES.join(', ')}`)
  return value as DemandStatus
}

function priorityOption(options: Map<string, string[]>, key: string): DemandPriority | undefined {
  const value = option(options, key)
  if (value === undefined) return undefined
  if (!(DEMAND_PRIORITIES as readonly string[]).includes(value)) throw new DemandStoreError('INVALID_INPUT', 'validate', '', `--${key} must be one of ${DEMAND_PRIORITIES.join(', ')}`)
  return value as DemandPriority
}

function helpText(): string {
  return `agentmux-demand — filesystem Demand store\n\nUsage:\n  agentmux-demand --root <directory> list\n  agentmux-demand --root <directory> create --title <title> [options]\n  agentmux-demand --root <directory> show --id <id>\n  agentmux-demand --root <directory> update --id <id> [options]\n  agentmux-demand --root <directory> delete --id <id> --confirm delete\n  agentmux-demand --root <directory> link-session --id <id> --session-id <id>\n  agentmux-demand --root <directory> unlink-session --id <id> --session-id <id>\n  agentmux-demand --root <directory> link-project --id <id> --project-id <id>\n  agentmux-demand --root <directory> unlink-project --id <id>\n  agentmux-demand --root <directory> decision-log --id <id> --question <text> --decision <text> [--rationale <text>]\n  agentmux-demand --root <directory> activity --id <id> --kind <kind> --message <text>\n  agentmux-demand --root <directory> assign --id <id> [--project-id <id>] [--executor-id <id>] [--no-start]\n  agentmux-demand --root <directory> start --id <id> [--session-id <id>] [--project-id <id>] [--executor-id <id>]\n  agentmux-demand --root <directory> handoff --id <id> --to-executor <id> [--to-session <id>]\n\nThe root must be explicit with --root or AGENTMUX_DEMAND_ROOT.`
}
