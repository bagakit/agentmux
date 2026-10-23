import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import type { ToolkitAgentCardField, ToolkitAgentCardReference } from '@agentmux/core/control'
import type { AgentAvatarAppearance, AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { createFirstPromptSelector, sessionStatusLabel } from './session-presentation'
import { agentDisplayName, workspaceForSession } from './workbench-tabs'
import { projectWorkspaces, type WorkspaceProject } from './workspace-projects'
import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import { formatPathForDisplay } from './copy-path-display'
import { builtInAgentProviderLabel } from '@agentmux/core/provider-id'
import type { AppState } from '../store'

export type ToolkitAgentCardFacts = {
  state: 'resolved' | 'unavailable' | 'ambiguous'
  reason?: string | undefined
  name?: string | undefined
  provider?: AgentProviderId | undefined
  status?: AgentDisplayState | undefined
  statusLabel?: string | undefined
  workspace?: string | undefined
  projectName?: string | undefined
  clientSessionId?: string | undefined
  host?: string | undefined
  sessionId?: string | undefined
  runId?: string | undefined
  executorId?: string | undefined
  appearance?: AgentAvatarAppearance | undefined
}
type State = Pick<AppState, 'config' | 'agentNames' | 'timelines' | 'localHome' | 'scratchTopicSnapshots'> & { sessions: readonly SessionSnapshot[] }
const EMPTY: ReadonlyMap<string, ToolkitAgentCardFacts> = new Map()
export const toolkitAgentCardKey = (reference: ToolkitAgentCardReference) => reference.kind === 'session'
  ? JSON.stringify(['session', reference.hostId, reference.sessionId])
  : JSON.stringify(['run', reference.hostId, reference.runId])

// All visible Toolkit consumers share one immutable Session index. It contains references,
// not a second registry or copied lifecycle facts; candidate arrays preserve ambiguity.
let indexed: readonly SessionSnapshot[] | undefined
let byReference: ReadonlyMap<string, readonly SessionSnapshot[]> = new Map()
function references(sessions: readonly SessionSnapshot[]) {
  if (sessions !== indexed) {
    const next = new Map<string, SessionSnapshot[]>()
    for (const session of sessions) {
      const keys = [toolkitAgentCardKey({ kind: 'run', hostId: session.hostId, runId: session.control.run.runId })]
      if (session.kind === 'agent' && session.control.kind === 'agent') keys.push(toolkitAgentCardKey({ kind: 'session', hostId: session.hostId, sessionId: session.control.agentSessionId }))
      for (const key of keys) { const candidates = next.get(key); if (candidates) candidates.push(session); else next.set(key, [session]) }
    }
    indexed = sessions; byReference = next
  }
  return byReference
}

export type ToolkitAgentCardResolution =
  | { state: 'resolved'; clientSessionId: string }
  | { state: 'unavailable' | 'ambiguous'; reason: string }

function resolve(candidates: readonly SessionSnapshot[] | undefined): ToolkitAgentCardResolution {
  if (!candidates?.length) return { state: 'unavailable', reason: 'Agent identity unavailable' }
  if (candidates.length !== 1) return { state: 'ambiguous', reason: 'Agent identity is ambiguous' }
  const session = candidates[0]!
  if (session.kind !== 'agent' || session.control.kind !== 'agent') return { state: 'unavailable', reason: 'Referenced Run is not an Agent Session' }
  if (session.control.hostId !== session.hostId) return { state: 'unavailable', reason: 'Agent host identity is inconsistent' }
  return { state: 'resolved', clientSessionId: session.id }
}

/** Revalidate the original reference against the same current index before presentation navigation. */
export function resolveToolkitAgentCardSession(sessions: readonly SessionSnapshot[], reference: ToolkitAgentCardReference): ToolkitAgentCardResolution {
  return resolve(references(sessions).get(toolkitAgentCardKey(reference)))
}

function project(candidates: readonly SessionSnapshot[] | undefined, fields: ReadonlySet<ToolkitAgentCardField>, state: State,
  firstPrompt: string | null, projects: readonly WorkspaceProject[], topics: ReturnType<typeof scratchTopicsForConfig>): ToolkitAgentCardFacts {
  const resolution = resolve(candidates)
  if (resolution.state !== 'resolved') return resolution
  const session = candidates![0]! as Extract<SessionSnapshot, { kind: 'agent' }>
  const avatar = fields.has('avatar'), config = state.config
  const appearance = avatar ? config?.executors[session.executorId]?.avatar ?? config?.appearance.agentAvatars?.[session.executorId] : undefined
  const workspace = fields.has('workspace') ? workspaceForSession(config, session, topics) : undefined
  const owner = workspace ? projects.find(candidate => candidate.workspaces.some(value => value.id === workspace.id)) : undefined
  return {
    state: 'resolved', clientSessionId: resolution.clientSessionId,
    name: fields.has('name') || avatar ? agentDisplayName({ userName: state.agentNames[session.id], firstPrompt,
      fallbackLabel: session.label, providerLabel: builtInAgentProviderLabel(session.providerId) }) : undefined,
    provider: fields.has('provider') || avatar ? session.providerId : undefined,
    status: fields.has('status') ? session.status.state : undefined,
    statusLabel: fields.has('status') ? sessionStatusLabel(session) : undefined,
    workspace: fields.has('workspace') ? formatPathForDisplay(session.workspacePath, {
      home: config?.hosts.find(host => host.id === session.hostId)?.kind === 'local' ? state.localHome : '', copyPathsAsAbsolute: config?.copyPathsAsAbsolute
    }) : undefined,
    projectName: owner?.name,
    host: fields.has('host') ? session.hostId : undefined,
    sessionId: fields.has('sessionId') ? session.control.agentSessionId : undefined,
    runId: fields.has('runId') ? session.control.run.runId : undefined,
    executorId: avatar ? session.executorId : undefined,
    appearance: appearance ? { ...(appearance.tint === undefined ? {} : { tint: appearance.tint }), ...(appearance.badge === undefined ? {} : { badge: appearance.badge }) } : undefined
  }
}
function same(a: ToolkitAgentCardFacts | undefined, b: ToolkitAgentCardFacts) {
  return a?.state === b.state && a.reason === b.reason && a.name === b.name && a.provider === b.provider &&
    a.clientSessionId === b.clientSessionId && a.projectName === b.projectName && a.status === b.status && a.statusLabel === b.statusLabel && a.workspace === b.workspace && a.host === b.host &&
    a.sessionId === b.sessionId && a.runId === b.runId && a.executorId === b.executorId &&
    a.appearance?.tint === b.appearance?.tint && a.appearance?.badge === b.appearance?.badge
}

export function createToolkitAgentCardSelector(refs: readonly ToolkitAgentCardReference[], fields: readonly ToolkitAgentCardField[], active: boolean) {
  const selected = new Set(fields), wanted = new Map(refs.map(reference => [toolkitAgentCardKey(reference), reference]))
  const naming = selected.has('name') || selected.has('avatar'), workspace = selected.has('workspace')
  const prompts = new Map<string, { sessionId: string; select: ReturnType<typeof createFirstPromptSelector> }>()
  let workspaces: AppConfig['workspaces'] | undefined, projects: readonly WorkspaceProject[] = []
  let scratchSnapshots: State['scratchTopicSnapshots'] | undefined, topics: ReturnType<typeof scratchTopicsForConfig> = null
  const previousInputs = new Map<string, readonly unknown[]>()
  let previous: ReadonlyMap<string, ToolkitAgentCardFacts> = EMPTY
  return (state: State): ReadonlyMap<string, ToolkitAgentCardFacts> => {
    if (!active || !selected.size || !wanted.size) return EMPTY
    if (workspace && (state.config?.workspaces !== workspaces || state.scratchTopicSnapshots !== scratchSnapshots)) {
      if (state.config?.workspaces !== workspaces) projects = projectWorkspaces(state.config?.workspaces ?? [])
      workspaces = state.config?.workspaces; scratchSnapshots = state.scratchTopicSnapshots
      topics = scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)
    }
    const index = references(state.sessions), next = new Map<string, ToolkitAgentCardFacts>()
    let changed = previous.size !== wanted.size
    for (const key of wanted.keys()) {
      const candidates = index.get(key), session = candidates?.length === 1 ? candidates[0] : undefined
      let prompt: string | null = null
      if (naming && session?.kind === 'agent' && !state.agentNames[session.id]?.trim()) {
        let source = prompts.get(key)
        if (source?.sessionId !== session.id) { source = { sessionId: session.id, select: createFirstPromptSelector(session.id) }; prompts.set(key, source) }
        prompt = source.select(state)
      } else prompts.delete(key)
      const inputs = [session, candidates?.length, naming ? state.agentNames[session?.id ?? ''] : undefined, prompt,
        selected.has('avatar') && session?.kind === 'agent' ? state.config?.executors[session.executorId]?.avatar ?? state.config?.appearance.agentAvatars?.[session.executorId] : undefined,
        workspace ? state.config?.workspaces : undefined, workspace ? state.config?.hosts : undefined,
        workspace ? state.config?.copyPathsAsAbsolute : undefined, workspace ? state.localHome : undefined,
        workspace ? topics : undefined]
      const before = previousInputs.get(key), old = previous.get(key)
      if (before && inputs.every((value, index) => value === before[index])) { next.set(key, old!); continue }
      previousInputs.set(key, inputs)
      const projected = project(candidates, selected, state, prompt, projects, topics)
      if (same(old, projected)) next.set(key, old!)
      else { next.set(key, projected); changed = true }
    }
    if (changed) previous = next
    return previous
  }
}
