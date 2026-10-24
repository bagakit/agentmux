import { effectiveSurveyOrganization, surveyOrganizationZoneIds } from './survey-list'
import { surveyExplorationName } from './survey-exploration-name'
import type { SurveyZoneSelection } from './survey-workface'
import type { WorkbenchTab } from './workbench-tabs'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import type { MoteAvatarImage, MoteAvatarRef, MoteAvatarTarget } from '../../../shared/mote-avatars'
import type { SpaceZoneBindings } from '../../../shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicPhysicalPath } from '../../../shared/scratch-topics'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { createFocusProjectionSelector } from './focus-context'
import { topicSpaceIconTarget, type SpaceIconOverrides } from './space-object-appearance'
import { moteExpressionPresentation } from './mote-expression'
import type { RendererAgentTimelineSnapshot } from './session-state'
import { deriveFocusProjectLanes, focusProjectKey } from './focus-project-lanes'
import { focusStateMarkKind } from '@agentmux/client-ui/focus-state-mark'
import { directoryIdentity } from '../../../shared/space-addresses'
import { originalTopicAddress } from '../../../shared/space-addresses'
import { resolveMoteDefaultConversation, moteDefaultCatalog } from './mote-default-conversation'
type State = { tabs?: Record<string, WorkbenchTab> } & Omit<Parameters<ReturnType<typeof createFocusProjectionSelector>>[0], 'timelines'> & { timelines: Record<string, RendererAgentTimelineSnapshot> } & { spaceObjectIcons: SpaceIconOverrides; spaceZoneBindings: SpaceZoneBindings }
const originalFocus = createFocusProjectionSelector()
/** Only read existing presentation owners. No alternate names, statuses, identities or image store. */
export function readAgentPresentation(state: State): NonNullable<AgentMuxSpaceCatalog['agentPresentation']> {
  const sessions = new Map(state.sessions.map(value => [value.id, value]))
  const projection = originalFocus(state)
  const workspaces = new Map(state.config?.workspaces.map(value => [value.id, value]))
  const lanes = deriveFocusProjectLanes(projection.laneContexts, state.config, undefined, state.tabs ?? {}, Date.now(), state.scratchTopicSnapshots)
  const byContext = new Map(lanes.flatMap(lane => lane.contextIds.map(id => [id, lane] as const)))
  return projection.contexts.map(row => {
    const lane = byContext.get(row.id)
    const projectWorkspace = lane?.projectWorkspaceId ? workspaces.get(lane.projectWorkspaceId) : undefined
    const objectLane = lane?.objectKind === 'mote' || lane?.objectKind === 'topic'
    const projectGroup = lane && lane.projectId && (objectLane || projectWorkspace) ? { key: objectLane ? lane.id : focusProjectKey(lane.hostId, lane.projectId), projectId: lane.projectId,
      hostId: lane.hostId, name: objectLane ? lane.labels.at(-1)! : lane.labels[0]!,
      spaceId: objectLane ? lane.objectIconKey ?? null : projectWorkspace ? directoryIdentity(projectWorkspace.hostId, projectWorkspace.repoPath ?? projectWorkspace.path) : null } : undefined
    const original = sessions.get(row.id)
    const executorId = original?.kind === 'agent' ? original.executorId : undefined
    const avatar = executorId ? state.config?.executors[executorId]?.avatar ?? state.config?.appearance.agentAvatars?.[executorId] : undefined
    return { agentSessionId: original?.control.kind === 'agent' ? original.control.agentSessionId : row.id, name: row.name, project: row.workspace ? row.workspaceName : 'Project unconfirmed',
      detail: row.detail, group: row.bucket, state: row.state, providerId: row.providerId ?? '',
      stateMark: focusStateMarkKind(row), stateLabel: row.stateLabel, presenceUnknown: row.runUnobserved === true, ...(projectGroup ? { projectGroup } : {}),
      recap: row.recap ? { text: row.recap.text, source: row.recap.source } : null, ...(avatar ? { avatar } : {}) }
  })
}

/** Read the original saved preferences and their exact occurrence; no Mobile parser or preference store. */
export function readMotePresentation(state: Parameters<typeof resolveMoteDefaultConversation>[0], catalog: AgentMuxSpaceCatalog,
  topics: readonly ScratchTopicSnapshot[]): NonNullable<AgentMuxSpaceCatalog['motePresentation']> {
  return catalog.spaces.filter(space => space.kind === 'mote').map(space => {
    const workspace = state.config?.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID && value.hostId === space.hostId)
    const matches = topics.filter(value => value.id === space.topicId)
    const topic = matches.length === 1 ? matches[0] : undefined
    const source = workspace && topic ? originalTopicAddress(workspace, topic, state.spaceZoneBindings) : undefined
    const zone = source?.spaceId === space.spaceId ? catalog.zones.find(value => value.zoneId === source.zoneId) : undefined
    const content = workspace && zone?.kind === 'home' && zone.hostId === workspace.hostId && zone.workspaceId === workspace.id &&
      zone.directoryPath !== null && !zone.issue && catalog.bindings.some(value => value.spaceId === space.spaceId && value.zoneId === zone.zoneId)
      ? { zoneId: zone.zoneId, hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } : null
    const quickMode = source?.spaceId === space.spaceId && topic?.quickMode ? topic.quickMode
      : { status: 'unconfirmed' as const, message: '原 MOTE.md 配置尚未确认；原对象与会话保留，可刷新或手动选择原会话。' }
    const raw = quickMode.status === 'saved' ? quickMode.defaults.conversation : undefined
    const resolved = workspace && topic && source?.spaceId === space.spaceId && raw
      ? resolveMoteDefaultConversation(state, topic, workspace.id, moteDefaultCatalog(state, topic, raw)) : {}
    const issues = [quickMode.status === 'unconfirmed' ? quickMode.message : undefined, resolved.issue,
      !content ? '原 Mote 资料读取范围尚未确认；保存引用与健康会话保留，可刷新原目录。' : undefined, topic?.readError].filter(Boolean)
    return { spaceId: space.spaceId, content, quickMode, conversation: resolved.conversation ?? null,
      ...(issues.length ? { issue: [...new Set(issues)].join('\n') } : {}) }
  })
}
export async function readSpatialAppearance(state: State, catalog: AgentMuxSpaceCatalog, imageSpaceId: string | undefined, topics: readonly ScratchTopicSnapshot[], readAvatar: (target: MoteAvatarTarget, choice: MoteAvatarRef) => Promise<MoteAvatarImage>, readProject?: (workspaceId: string) => Promise<{ kind: string; icon: string | null }>): Promise<NonNullable<AgentMuxSpaceCatalog['appearance']>> {
  return Promise.all(catalog.spaces.map(async space => {
    const scratch = state.config?.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID && value.hostId === space.hostId)
    const topic = space.topicId ? topics.find(value => value.id === space.topicId) : undefined
    const target = scratch && topic ? topicSpaceIconTarget(scratch, topic, state.spaceZoneBindings) : undefined
    if (space.kind === 'mote' && !target) return { spaceId: space.spaceId, issue: '原 Mote 头像身份尚未确认；已保存外观保留。', expression: 'unknown' }
    const key = target?.key ?? space.spaceId
    const choice = state.spaceObjectIcons[key]
    // Reuse ProjectIcon's original filesystem owner, only for the explicitly read Space.
    // Directory lists carry a source marker, never an eager image scan or image bytes.
    if (space.kind === 'folder' && !choice) {
      if (space.spaceId !== imageSpaceId) return { spaceId: space.spaceId, preset: 'project' }
      const resource = state.config?.workspaces.find(value => directoryIdentity(value.hostId, value.repoPath ?? value.path) === space.spaceId)
      try {
        if (!resource || !readProject) throw new Error('原项目图标来源暂未确认，原项目与工作面保留。')
        const appearance = await readProject(resource.id)
        return { spaceId: space.spaceId, preset: appearance.kind === 'repository' ? 'repository' : 'directory', image: { dataUrl: appearance.icon } }
      } catch (error) { return { spaceId: space.spaceId, preset: 'project', issue: presentError(error) } }
    }

    const matching = target && scratch && topic ? state.sessions.filter(value => value.kind === 'agent' && value.hostId === scratch.hostId && (value.workspacePath === scratchTopicPhysicalPath(scratch, topic) || value.workspacePath === JSON.parse(target.key)[1])) : []
    const original = matching.length === 1 ? matching[0] : undefined
    const { expression } = moteExpressionPresentation(original, 'static', original ? state.timelines[original.id]?.liveTool : undefined)
    const motion = space.kind === 'mote' ? { expression, activities: matching.map(session => ({ agentSessionId: session.control.kind === 'agent' ? session.control.agentSessionId : session.id, hostId: session.hostId,
      runId: session.control.run.runId, ...moteExpressionPresentation(session, 'static', state.timelines[session.id]?.liveTool) })) } : {}
    if (typeof choice === 'string') return { spaceId: space.spaceId, glyph: choice, ...motion }
    if (choice?.kind === 'face') return { spaceId: space.spaceId, parts: { ...choice }, ...motion }
    const imageChoice = choice?.kind === 'series' ? choice.image : choice?.kind === 'image' ? choice : null
    if (imageChoice) {
      if (space.spaceId !== imageSpaceId) return { spaceId: space.spaceId, image: { dataUrl: null, revision: imageChoice.fileName }, ...motion }
      const workspace = target?.avatarTarget ? scratch : undefined
      try {
        if (!workspace || !space.topicId) throw new Error('The original Mote avatar target is unavailable.')
        const image = await readAvatar({ workspaceId: workspace.id, topicId: space.topicId, objectKey: key }, imageChoice)
        return { spaceId: space.spaceId, image: { dataUrl: image.dataUrl, revision: imageChoice.fileName }, ...motion }
      } catch (error) { return { spaceId: space.spaceId, image: { dataUrl: null, revision: imageChoice.fileName }, issue: presentError(error), ...motion } }
    }
    return { spaceId: space.spaceId, ...(space.topicId === PMO_TEAMS_TOPIC_ID ? { preset: 'primary-mote' } : {}), ...motion }
  }))
}

/** Preserve the original explicit research references, including temporarily missing topology. */
export function readSurveyPresentation(state: {
  surveyCollectedZones: Record<string, true>
  surveyOrganization?: import('@agentmux/core/control').AgentMuxSurveyOrganization
  surveyExplorationNames: Record<string, string>
  surveyZoneSelection: SurveyZoneSelection | null
  tabs: Record<string, WorkbenchTab>
}, catalog: AgentMuxSpaceCatalog): NonNullable<AgentMuxSpaceCatalog['survey']> {
  const zones = new Set(catalog.zones.map(zone => zone.zoneId))
  const tabsByZone = new Map<string, WorkbenchTab[]>()
  for (const tab of catalog.tabs) {
    const original = state.tabs[tab.tabId]
    if (original && tab.zoneId !== null) { if (!tabsByZone.has(tab.zoneId)) tabsByZone.set(tab.zoneId, []); tabsByZone.get(tab.zoneId)!.push(original) }
  }
  const organization = effectiveSurveyOrganization(state.surveyOrganization, state.surveyCollectedZones)
  return {
    organization,
    items: surveyOrganizationZoneIds(organization).map(zoneId => {
      const tabs = tabsByZone.get(zoneId) ?? []
      return { zoneId, name: surveyExplorationName(state.surveyExplorationNames[zoneId], tabs),
        ...(!zones.has(zoneId) ? { issue: '研究工作面暂未确认，原引用保留。' } : {}) }
    }),
    selection: state.surveyZoneSelection ? {
      zoneId: state.surveyZoneSelection.zoneId,
      selection: state.surveyZoneSelection.selection.map(({ tabId, regionId }) => ({ tabId, regionId })),
      active: state.surveyZoneSelection.active ? { ...state.surveyZoneSelection.active } : null
    } : null
  }
}
