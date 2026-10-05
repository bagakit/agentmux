import { parseDemandContentReferences } from './content-references.js'
import { randomUUID } from 'node:crypto'
import { DemandNameChangeError, openDemandStore } from './demand-store.js'
import { DEMAND_CLI_SCHEMA, DEMAND_PRIORITIES, DEMAND_STATUSES, type CreateDemandInput, type DemandNameContext, type DemandPriority, type DemandStatus, type UpdateDemandInput } from './demand-types.js'
import { DemandStoreError } from './errors.js'
import { parseAlignmentProposal, parseGroundingProposal } from './goals.js'

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
    for (const key of ['revision', 'submission-id', 'confirmed-at', 'accepted-at', 'executor-id', 'to-executor', 'from-executor', 'participations', 'creation-origin', 'requester-as-supervisor']) {
      if (parsed.options.has(key)) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Goal acknowledgement and original provenance are owner facts. Assign accurate Sessions instead of an Executor.')
    }
    if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
      stdout(helpText())
      return 0
    }
    const root = option(parsed.options, 'root') ?? env.AGENTMUX_DEMAND_ROOT
    if (!root) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Demand CLI requires --root or AGENTMUX_DEMAND_ROOT')
    const lockTimeoutMs = numberOption(parsed.options, 'lock-timeout-ms')
    const store = openDemandStore(lockTimeoutMs === undefined ? { root } : { root, lockTimeoutMs })
    const uid = process.getuid?.()
    const nameContext: DemandNameContext = {
      actor: uid === undefined ? { kind: 'unknown', id: null, verified: false } : { kind: 'device', id: `uid:${uid}`, verified: true },
      source: 'local-cli', entryPoint: `agentmux-demand.${parsed.command}`, transport: 'local-process',
      location: { demandRoot: store.root, cwd: process.cwd(), processId: String(process.pid) }
    }
    const result = await execute(parsed.command, parsed.options, store, nameContext, requestId)
    stdout(JSON.stringify({ schemaVersion: DEMAND_CLI_SCHEMA, requestId, operation: parsed.command, ...result }))
    return 0
  } catch (error) {
    const serialized = error instanceof DemandStoreError
      ? { code: error.code, phase: error.phase, path: error.path, message: error.message, ...(error instanceof DemandNameChangeError ? { nameChange: error.nameChange, commitStatus: error.commitStatus } : {}) }
      : { code: 'CLI_ERROR', phase: 'validate', path: '', message: error instanceof Error ? error.message : String(error) }
    const output = JSON.stringify({ schemaVersion: DEMAND_CLI_SCHEMA, requestId, ok: false, error: serialized })
    stderr(output)
    return 1
  }
}

async function execute(command: string, options: Map<string, string[]>, store: ReturnType<typeof openDemandStore>, context: DemandNameContext, requestId: string): Promise<Record<string, unknown>> {
  if (command === 'list') {
    const snapshot = await store.snapshot()
    return { revision: snapshot.revision, demands: snapshot.demands }
  }
  if (command === 'show') {
    const demand = await store.get(required(options, 'id'))
    if (!demand) throw new DemandStoreError('NOT_FOUND', 'validate', store.storePath, `Demand ${required(options, 'id')} was not found`)
    return { revision: (await store.snapshot()).revision, demand }
  }
  if (command === 'name-history') {
    const offset = numberOption(options, 'offset')
    const limit = numberOption(options, 'limit')
    return await store.listNameChanges(required(options, 'id'), { ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) })
  }
  if (command === 'create') {
    const input: CreateDemandInput = { title: required(options, 'title'), sessionIds: options.get('session-id') ?? [], ...relationPatch(options) }
    const refs = option(options, 'content-refs'); if (refs !== undefined) input.contentRefs = parseDemandContentReferences(JSON.parse(refs))
    const id = option(options, 'id'); if (id !== undefined) input.id = id
    const description = option(options, 'description'); if (description !== undefined) input.description = description
    const status = statusOption(options, 'status'); if (status !== undefined) input.status = status
    const priority = priorityOption(options, 'priority'); if (priority !== undefined) input.priority = priority
    const projectId = option(options, 'project-id'); if (projectId !== undefined) input.projectId = projectId
    const projectName = option(options, 'project-name'); if (projectName !== undefined) input.projectName = projectName
    const receipt = await store.create(input, { context, operationId: option(options, 'operation-id') ?? requestId })
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'update') {
    const patch: UpdateDemandInput = relationPatch(options)
    const refs = option(options, 'content-refs'); if (refs !== undefined) patch.contentRefs = parseDemandContentReferences(JSON.parse(refs))
    const title = option(options, 'title'); if (title !== undefined) patch.title = title
    const description = option(options, 'description'); if (description !== undefined) patch.description = description
    const status = statusOption(options, 'status'); if (status !== undefined) patch.status = status
    const priority = priorityOption(options, 'priority'); if (priority !== undefined) patch.priority = priority
    const projectId = option(options, 'project-id'); if (projectId !== undefined) patch.projectId = projectId
    const projectName = option(options, 'project-name'); if (projectName !== undefined) patch.projectName = projectName
    const alignment = option(options, 'alignment'); if (alignment !== undefined) patch.alignment = parseAlignmentProposal(JSON.parse(alignment))
    const grounding = option(options, 'grounding'); if (grounding !== undefined) patch.grounding = parseGroundingProposal(JSON.parse(grounding))
    const expectedRevision = numberOption(options, 'expected-revision')
    const expectedUpdatedAt = numberOption(options, 'expected-updated-at')
    const receipt = await store.update(required(options, 'id'), patch, { context, operationId: option(options, 'operation-id') ?? requestId, ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) })
    return { receipt, demand: receipt.demand, revision: receipt.revision }
  }
  if (command === 'propose-alignment' || command === 'propose-grounding') {
    const id = required(options, 'id')
    const proposal: unknown = JSON.parse(required(options, 'proposal'))
    const receipt = command === 'propose-alignment'
      ? await store.proposeAlignment(id, parseAlignmentProposal(proposal))
      : await store.proposeGrounding(id, parseGroundingProposal(proposal))
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
    const patch: UpdateDemandInput = relationPatch(options)
    const projectId = option(options, 'project-id'); if (projectId !== undefined) patch.projectId = projectId
    const projectName = option(options, 'project-name'); if (projectName !== undefined) patch.projectName = projectName
    const expectedUpdatedAt = numberOption(options, 'expected-updated-at')
    const receipt = await store.update(id, patch, { context, operationId: option(options, 'operation-id') ?? requestId, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) })
    const activity = await store.addActivity(id, { kind: 'assignment', message: booleanOption(options, 'start') ? 'Assigned; execution was explicitly requested, not submitted by this file tool.' : 'Assigned without starting execution.', actorId: option(options, 'actor-id') ?? null })
    return { receipt, activity: activity.demand.activities.at(-1), demand: activity.demand, revision: activity.revision, startRequested: booleanOption(options, 'start') }
  }
  if (command === 'start') {
    const id = required(options, 'id')
    const patch: UpdateDemandInput = { status: 'in_progress' }
    const projectId = option(options, 'project-id'); if (projectId !== undefined) patch.projectId = projectId
    const projectName = option(options, 'project-name'); if (projectName !== undefined) patch.projectName = projectName
    const updated = await store.update(id, patch)
    const sessionId = option(options, 'session-id')
    const linked = sessionId === undefined ? updated : await store.linkSession(id, sessionId)
    const activity = await store.addActivity(id, { kind: 'execution-requested', message: 'Execution was requested but was not submitted by this filesystem tool.', actorId: context.actor.id })
    return { receipt: updated, linkedReceipt: linked, activity: activity.demand.activities.at(-1), demand: activity.demand, revision: activity.revision, sessionId: sessionId ?? null, submitted: false }
  }
  if (command === 'handoff') {
    const id = required(options, 'id')
    const sessionId = option(options, 'to-session')
    const patch = relationPatch(options)
    if (sessionId && patch.assigneeSessionIds === undefined) patch.assigneeSessionIds = [sessionId]
    const expectedUpdatedAt = numberOption(options, 'expected-updated-at')
    const updated = await store.update(id, patch, { context, operationId: option(options, 'operation-id') ?? requestId, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) })
    const activity = await store.addActivity(id, { kind: 'handoff', message: `Handoff to ${(patch.assigneeSessionIds ?? []).join(', ') || 'unassigned'}.`, actorId: context.actor.id })
    return { receipt: updated, demand: activity.demand, revision: activity.revision, sessionId: sessionId ?? null }
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
      if (['no-start', 'start', 'clear-assignees', 'clear-supervisor'].includes(key)) { options.set(key, ['true']); continue }
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
  return `agentmux-demand — filesystem Demand store\n\nUsage:\n  agentmux-demand --root <directory> list\n  agentmux-demand --root <directory> create --title <title> [options]\n  agentmux-demand --root <directory> show --id <id>\n  agentmux-demand --root <directory> update --id <id> [options]\n  agentmux-demand --root <directory> propose-alignment --id <id> --proposal <json>\n  agentmux-demand --root <directory> propose-grounding --id <id> --proposal <json>\n  agentmux-demand --root <directory> delete --id <id> --confirm delete\n  agentmux-demand --root <directory> link-session --id <id> --session-id <id>\n  agentmux-demand --root <directory> unlink-session --id <id> --session-id <id>\n  agentmux-demand --root <directory> link-project --id <id> --project-id <id>\n  agentmux-demand --root <directory> unlink-project --id <id>\n  agentmux-demand --root <directory> decision-log --id <id> --question <text> --decision <text> [--rationale <text>]\n  agentmux-demand --root <directory> activity --id <id> --kind <kind> --message <text>\n  agentmux-demand --root <directory> assign --id <id> [--project-id <id>] [--assignee-session-id <id>] [--start]\n  agentmux-demand --root <directory> start --id <id> [--session-id <id>] [--project-id <id>] [--assignee-session-id <id>]\n  agentmux-demand --root <directory> handoff --id <id> --assignee-session-id <id> [--to-session <id>]\n\nCreate/update/assign/handoff accept repeatable --assignee-session-id, --clear-assignees, --supervisor-session-id or --clear-supervisor. Assignment does not start execution unless --start is explicit; this filesystem CLI never submits input.\nTitle update accepts --operation-id <id> and --expected-revision <revision>.\nRead structured title history with name-history --id <id> [--offset <n>] [--limit <1..100>].\nCreate/update accept --content-refs <json> for exact content provenance. Update appends sources and accepts --expected-updated-at <ms> from the original record.\nUpdate also accepts --alignment <json> and --grounding <json>. Proposals never confirm goals or accept results.\nThe root must be explicit with --root or AGENTMUX_DEMAND_ROOT.`
}

function relationPatch(options: Map<string, string[]>): Pick<UpdateDemandInput, 'assigneeSessionIds' | 'supervisorSessionId'> {
  const patch: Pick<UpdateDemandInput, 'assigneeSessionIds' | 'supervisorSessionId'> = {}
  if (options.has('assignee-session-id')) patch.assigneeSessionIds = options.get('assignee-session-id')!
  if (options.has('clear-assignees')) patch.assigneeSessionIds = []
  const supervisor = option(options, 'supervisor-session-id')
  if (supervisor !== undefined && options.has('clear-supervisor')) throw new DemandStoreError('INVALID_INPUT', 'validate', '', 'Choose or clear the Supervisor explicitly, not both.')
  if (supervisor !== undefined) patch.supervisorSessionId = supervisor
  if (options.has('clear-supervisor')) patch.supervisorSessionId = null
  return patch
}
