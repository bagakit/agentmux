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
import { moteExpression } from './mote-expression'
import type { RendererAgentTimelineSnapshot } from './session-state'
type State = Omit<Parameters<ReturnType<typeof createFocusProjectionSelector>>[0], 'timelines'> & { timelines: Record<string, RendererAgentTimelineSnapshot> } & { spaceObjectIcons: SpaceIconOverrides; spaceZoneBindings: SpaceZoneBindings }
const originalFocus = createFocusProjectionSelector()
/** Only read existing presentation owners. No alternate names, statuses, identities or image store. */
export function readAgentPresentation(state: State): NonNullable<AgentMuxSpaceCatalog['agentPresentation']> {
  const sessions = new Map(state.sessions.map(value => [value.id, value]))
  return originalFocus(state).contexts.map(row => {
    const original = sessions.get(row.id)
    const executorId = original?.kind === 'agent' ? original.executorId : undefined
    const avatar = executorId ? state.config?.executors[executorId]?.avatar ?? state.config?.appearance.agentAvatars?.[executorId] : undefined
    return { agentSessionId: row.id, name: row.name, project: row.workspace ? row.workspaceName : 'Project unconfirmed',
      detail: row.detail, group: row.bucket, state: row.state, providerId: row.providerId ?? '',
      recap: row.recap ? { text: row.recap.text, source: row.recap.source } : null, ...(avatar ? { avatar } : {}) }
  })
}
export async function readSpatialAppearance(state: State, catalog: AgentMuxSpaceCatalog, imageSpaceId: string | undefined, topics: readonly ScratchTopicSnapshot[], readAvatar: (target: MoteAvatarTarget, choice: MoteAvatarRef) => Promise<MoteAvatarImage>): Promise<NonNullable<AgentMuxSpaceCatalog['appearance']>> {
  return Promise.all(catalog.spaces.map(async space => {
    const scratch = state.config?.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID && value.hostId === space.hostId)
    const topic = space.topicId ? topics.find(value => value.id === space.topicId) : undefined
    const target = scratch && topic ? topicSpaceIconTarget(scratch, topic, state.spaceZoneBindings) : undefined
    if (space.kind === 'mote' && !target) return { spaceId: space.spaceId, issue: '原 Mote 头像身份尚未确认；已保存外观保留。', expression: 'unknown' }
    const key = target?.key ?? space.spaceId
    const choice = state.spaceObjectIcons[key]
    const matching = target && scratch && topic ? state.sessions.filter(value => value.kind === 'agent' && value.hostId === scratch.hostId && (value.workspacePath === scratchTopicPhysicalPath(scratch, topic) || value.workspacePath === JSON.parse(target.key)[1])) : []
    const original = matching.length === 1 ? matching[0] : undefined
    const expression = moteExpression(original, 'static', original ? state.timelines[original.id]?.liveTool : undefined)
    const motion = space.kind === 'mote' ? { expression, activities: matching.map(session => ({ agentSessionId: session.id, runId: session.control.run.runId, expression: moteExpression(session, 'static', state.timelines[session.id]?.liveTool) })) } : {}
    if (typeof choice === 'string') return { spaceId: space.spaceId, glyph: choice, ...motion }
    if (choice?.kind === 'face') return { spaceId: space.spaceId, parts: { ...choice }, ...motion }
    if (choice?.kind === 'image') {
      if (space.spaceId !== imageSpaceId) return { spaceId: space.spaceId, image: { dataUrl: null, revision: choice.fileName }, ...motion }
      const workspace = target?.avatarTarget ? scratch : undefined
      try {
        if (!workspace || !space.topicId) throw new Error('The original Mote avatar target is unavailable.')
        const image = await readAvatar({ workspaceId: workspace.id, topicId: space.topicId, objectKey: key }, choice)
        return { spaceId: space.spaceId, image: { dataUrl: image.dataUrl, revision: choice.fileName }, ...motion }
      } catch (error) { return { spaceId: space.spaceId, image: { dataUrl: null, revision: choice.fileName }, issue: presentError(error), ...motion } }
    }
    return { spaceId: space.spaceId, ...(space.topicId === PMO_TEAMS_TOPIC_ID ? { preset: 'primary-mote' } : {}), ...motion }
  }))
}

/** Preserve the original explicit research references, including temporarily missing topology. */
export function readSurveyPresentation(state: {
  surveyCollectedZones: Record<string, true>
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
  return {
    items: Object.keys(state.surveyCollectedZones).filter(id => state.surveyCollectedZones[id] === true).map(zoneId => {
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
