import { agentInteractionActiveRequest, type AgentMuxClient, type AgentMuxAgentSession, type AgentMuxRpcServiceOptions } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { displayLabelDocument, nameTargetKey } from '@agentmux/core/spatial-graph'
import { currentAgentSemanticStatus } from '@agentmux/core/agent-status'
import { projectRunProcessStatus, runExitFacts } from '@agentmux/core/run-status'
import { projectConversationSummary } from '@agentmux/core/conversation'
import { resolveAgentName, firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { launcherTimelineRecap } from '@agentmux/client-ui/conversation-recap'
import { agentPresentationState } from '@agentmux/client-ui/agent-presentation'
import { focusStateMarkKind } from '@agentmux/client-ui/focus-state-mark'
import { configuredAgentFallbackLabel, readPresentationConfiguration, type PresentationConfiguration } from './presentation-configuration.js'
import { ScratchTopics } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID, workspaceOwnsSessionPath } from './mote-topic-model.js'
import { directoryIdentity, homeZoneId } from './mote-model.js'
import { createHostMoteAvatarRead } from './mote-avatar-read.js'

type Client = AgentMuxClient | AgentMuxHostedClient
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const emptyConfiguration = (): PresentationConfiguration => ({ workspaces: [], executors: {}, appearance: {} })
/** Original durable positions + fresh Core facts. This owner has no screen or configuration store. */
export function createHostSpatialPresentation(options: { configurationPath?: string; clients(): readonly { hostId: string; client: Client }[] }): NonNullable<AgentMuxRpcServiceOptions['spatialPresentation']> {
  const topics = new ScratchTopics()
  return async ({ graph, catalog, target, imageSpaceId }, context) => {
    context.signal?.throwIfAborted()
    let configuration = emptyConfiguration(), configurationIssue: string | undefined
    try {
      if (options.configurationPath) configuration = await readPresentationConfiguration(options.configurationPath)
      else configurationIssue = 'The original Workspace presentation configuration is unavailable. Original spatial references and Agent input remain available.'
    } catch (error) { configurationIssue = message(error) }
    const names = displayLabelDocument(graph).labels
    const zones = new Map(catalog.zones.map(zone => [zone.zoneId, zone])), tabs = new Map(catalog.tabs.map(tab => [tab.tabId, tab]))
    const spaces = new Map(catalog.spaces.map(space => [space.spaceId, space]))
    const bySession = new Map<string, typeof catalog.regions>()
    for (const region of catalog.regions) if (region.agentSessionId) {
      const previous = bySession.get(region.agentSessionId) ?? []; previous.push(region); bySession.set(region.agentSessionId, previous)
    }
    const clients = options.clients()
    const unplaced = new Map<string, AgentMuxAgentSession>()
    // The complete Focus directory includes original unplaced local Sessions.
    // A scoped Space/Tab read never discovers or reads these unrelated histories.
    if (Object.keys(target).length === 0) {
      const local = clients.filter(route => route.hostId === 'local')
      if (local.length === 1) try {
        for (const session of await local[0]!.client.readAgentSessions()) if (session.hostId === 'local' && !bySession.has(session.agentSessionId)) {
          bySession.set(session.agentSessionId, []); unplaced.set(session.agentSessionId, session)
        }
      } catch (error) { configurationIssue = [configurationIssue, message(error)].filter(Boolean).join('\n') }
    }
    const agentPresentation = await Promise.all([...bySession].map(async ([agentSessionId, regions]) => {
      context.signal?.throwIfAborted()
      const owners = new Set(regions.flatMap(region => region.execution ? [region.execution.hostId] : []))
      const hostId = owners.size === 1 ? [...owners][0]! : unplaced.get(agentSessionId)?.hostId
      const routes = hostId === undefined ? [] : clients.filter(route => route.hostId === hostId)
      const client = routes.length === 1 ? routes[0]!.client : undefined
      let session: AgentMuxAgentSession | null = null, issue: string | undefined
      try {
        if (client) session = await client.readAgentSession(agentSessionId)
        if (!client || !session || session.agentSessionId !== agentSessionId || session.hostId !== 'local' && session.hostId !== hostId) {
          session = null; issue = 'The original execution Host observation is unconfirmed. Original positions and Session identity are retained; reconnect its exact Host.'
        }
      } catch (error) { issue = message(error) }
      const known = session
      const [observed, conversation] = await Promise.allSettled([
        client && known ? client.statusAgent(agentSessionId) : Promise.resolve(null),
        client && known ? client.sessionTimeline(agentSessionId) : Promise.resolve(undefined)
      ])
      const status = observed.status === 'fulfilled' ? observed.value : null
      if (observed.status === 'rejected') issue = message(observed.reason)
      const exact = status?.session.agentSessionId === agentSessionId && status.session.hostId === known?.hostId
        && status.session.run.runId === known?.run.runId ? status : null
      if (status && !exact) issue = 'The original Session changed during this observation. Its directory and input remain available; refresh this same Session.'
      const timeline = conversation.status === 'fulfilled' && conversation.value?.agentSessionId === agentSessionId ? conversation.value : undefined
      if (conversation.status === 'rejected') issue = [issue, message(conversation.reason)].filter(Boolean).join('\n')
      const original = exact?.session ?? known
      const resource = original ? configuration.workspaces.find(workspace => workspaceOwnsSessionPath(workspace, { ...original, hostId: hostId! })) : undefined
      const place = regions[0] && tabs.get(regions[0].tabId), zone = place?.zoneId ? zones.get(place.zoneId) : undefined
      const ownerSpaces = zone ? catalog.bindings.filter(binding => binding.zoneId === zone.zoneId).map(binding => spaces.get(binding.spaceId)).filter(Boolean) : []
      const project = resource?.name ?? (ownerSpaces.length === 1 ? ownerSpaces[0]!.name : 'Project unconfirmed')
      const statusFact = exact ? exact.run.state === 'running' ? currentAgentSemanticStatus(exact.session.semanticStatus)
        ?? projectRunProcessStatus({ state: exact.run.state, source: 'run-process', observedAt: exact.run.observedAt, ...runExitFacts(exact.run) })
        : projectRunProcessStatus({ state: exact.run.state, source: 'run-process', observedAt: exact.run.observedAt, ...runExitFacts(exact.run) })
        : { state: 'disconnected' as const, source: 'run-process' as const, observedAt: 0 }
      const records = timeline ? projectConversationSummary({ agentSessionId, timeline }) : []
      const latest = records.filter(record => record.role === 'message' || record.role === 'observation').at(-1)
      const latestItem = timeline?.items.filter(item => item.kind !== 'lifecycle').at(-1)
      const result = Boolean(latest && (latest.role === 'observation' || latest.author?.kind === 'agent') && latest.rawId === latestItem?.id
        && latest.original.kind === 'captured' && latest.original.item.status === 'complete' && latest.content.trim())
      const facts = { kind: 'agent' as const, status: statusFact, processState: exact?.run.state ?? 'interrupted' as const,
        runUnobserved: !exact, pendingInteraction: original ? agentInteractionActiveRequest(original.pendingInteraction) : undefined,
        currentActivity: original?.currentActivity }
      const presentation = agentPresentationState(facts, exact?.observation, result)
      const recap = launcherTimelineRecap(records)
      const projectRoot = resource ? configuration.workspaces.find(workspace => workspace.hostId === resource.hostId && workspace.path === (resource.repoPath ?? resource.path)) ?? resource : undefined
      const projectGroup = projectRoot ? { key: JSON.stringify([projectRoot.hostId, projectRoot.id]), projectId: projectRoot.id, hostId: projectRoot.hostId, name: projectRoot.name, spaceId: directoryIdentity(projectRoot.hostId, projectRoot.repoPath ?? projectRoot.path) } : undefined
      const executor = original ? configuration.executors[original.executorId] : undefined
      const avatar = executor?.avatar ?? (original ? configuration.appearance.agentAvatars?.[original.executorId] : undefined)
      const label = names[nameTargetKey({ kind: 'agent-session', id: agentSessionId })]?.value
      const fallback = original ? configuredAgentFallbackLabel(configuration, { ...original, hostId: hostId! }) : agentSessionId
      return { agentSessionId, name: resolveAgentName({ userName: label, firstPrompt: firstPromptFromTimeline(timeline), fallback }).name,
        project, detail: issue ?? statusFact.detail ?? recap?.text ?? presentation.stateLabel, group: presentation.bucket,
        state: presentation.state, providerId: original?.providerId ?? '', recap: recap ? { text: recap.text, source: recap.source } : null,
        stateLabel: presentation.stateLabel, presenceUnknown: !exact,
        stateMark: focusStateMarkKind({ ...presentation, activitySemantic: exact?.observation.semantic, runUnobserved: !exact, processState: exact?.run.state }),
        ...(avatar ? { avatar } : {}), ...(projectGroup ? { projectGroup } : {}) }
    }))
    const motePresentation = await Promise.all(catalog.spaces.filter(space => space.kind === 'mote').map(async space => {
      const workspace = configuration.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID && value.hostId === space.hostId)
      const home = catalog.zones.find(zone => zone.zoneId === homeZoneId(space.spaceId) && zone.workspaceId === workspace?.id && zone.hostId === workspace.hostId)
      try {
        const topic = workspace && space.topicId ? await topics.read(workspace, space.topicId) : null
        const quickMode = topic?.quickMode ?? { status: 'unconfirmed' as const, message: 'The original MOTE.md preferences are unconfirmed. Original conversations and manual navigation remain available.' }
        const saved = quickMode.status === 'saved' ? quickMode.defaults.conversation : undefined
        const region = saved && catalog.regions.find(region => region.regionId === saved.regionId && region.tabId === saved.tabId)
        const confirmed = saved && region?.agentSessionId === saved.sessionId && (!region.execution || region.execution.hostId === saved.hostId)
          && catalog.locations.some(location => location.spaceId === space.spaceId && location.displayWorkspaceId === saved.displayWorkspaceId
            && location.groupId === saved.groupId && location.tabId === saved.tabId && location.regionId === saved.regionId)
        return { spaceId: space.spaceId, quickMode, content: workspace && home ? { zoneId: home.zoneId, hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } : null,
          conversation: confirmed ? saved : null, ...(saved && !confirmed ? { issue: 'The saved default conversation is unconfirmed at its original location. Keep its original reference and refresh the same Mote.' } : {}) }
      } catch (error) { return { spaceId: space.spaceId, content: null, quickMode: { status: 'unconfirmed' as const, message: message(error) }, conversation: null, issue: message(error) } }
    }))
    const appearance = await Promise.all(catalog.spaces.map(async space => {
      const choice = configuration.appearance.spaceObjectIcons?.[space.spaceId]
      const base = { spaceId: space.spaceId, ...(configurationIssue ? { issue: configurationIssue } : {}) }
      if (typeof choice === 'string') return { ...base, glyph: choice }
      if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
        const value = choice as Record<string, unknown>
        if (value.kind === 'face') return { ...base, parts: Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }
        const image = value.kind === 'series' ? value.image : choice
        if (image && typeof image === 'object' && !Array.isArray(image) && typeof (image as Record<string, unknown>).fileName === 'string') {
          const revision = (image as Record<string, unknown>).fileName as string
          if (imageSpaceId === space.spaceId && options.configurationPath && space.topicId) {
            try {
              const workspace = configuration.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID && value.hostId === space.hostId)
              if (workspace) {
                const read = await createHostMoteAvatarRead({ configurationPath: options.configurationPath }).read({ workspaceId: workspace.id, topicId: space.topicId, objectKey: space.spaceId })
                return { ...base, image: { dataUrl: read.image?.dataUrl ?? null, revision }, ...(read.issues.length ? { issue: read.issues.join('\n') } : {}) }
              }
            } catch (error) { return { ...base, image: { dataUrl: null, revision }, issue: message(error) } }
          }
          return { ...base, image: { dataUrl: null, revision } }
        }
      }
      return { ...base, ...(space.kind === 'folder' ? { preset: 'project' } : {}) }
    }))
    return { agentPresentation, motePresentation, appearance }
  }
}
