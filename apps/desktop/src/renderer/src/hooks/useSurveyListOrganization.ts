import { useMemo, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxSurveyOrganization } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { effectiveSurveyOrganization, surveyOrganizationZoneIds } from '../lib/survey-list'

export type SurveyItemGrouping = {
  groups: AgentMuxSurveyOrganization['groups']
  currentGroupId: string | null
  onMove(groupId: string | null): void
  onNewGroup(): void
}

/** Edit one list document; the original read remains the expected value through each interaction. */
export function moveSurveyListItem(base: AgentMuxSurveyOrganization, zoneId: string, target: string | null, index?: number): AgentMuxSurveyOrganization {
  const next = { ungrouped: base.ungrouped.filter(id => id !== zoneId),
    groups: base.groups.map(group => ({ ...group, zoneIds: group.zoneIds.filter(id => id !== zoneId) })) }
  const ids = target === null ? next.ungrouped : next.groups.find(group => group.groupId === target)?.zoneIds
  if (ids) ids.splice(index ?? ids.length, 0, zoneId)
  return next
}

export function useSurveyListOrganization() {
  const stored = useAppStore(state => state.surveyOrganization)
  const collected = useAppStore(state => state.surveyCollectedZones)
  const write = useAppStore(state => state.setSurveyOrganization)
  const [error, setError] = useState<string | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const effective = useMemo(() => effectiveSurveyOrganization(stored, collected), [stored, collected])
  // Append newly collected entries without dropping the saved positions of closed or missing originals.
  const editable = useMemo(() => {
    const known = new Set(surveyOrganizationZoneIds(stored))
    return { ...stored, ungrouped: [...stored.ungrouped, ...effective.ungrouped.filter(id => !known.has(id))] }
  }, [stored, effective])
  async function commit(next: AgentMuxSurveyOrganization, expected: AgentMuxSurveyOrganization) {
    try {
      const report = await write(next, expected)
      setError(report.issues.map(issue => `${issue.message} ${issue.recovery}`).join(' ') || null)
      return report
    } catch (cause) { setError(presentError(cause)); return null }
  }
  function groupingFor(zoneId: string, expected = stored): SurveyItemGrouping {
    const original = expected === stored ? editable : { ...expected, ungrouped: [...expected.ungrouped,
      ...effective.ungrouped.filter(id => !surveyOrganizationZoneIds(expected).includes(id))] }
    return { groups: original.groups, currentGroupId: original.groups.find(group => group.zoneIds.includes(zoneId))?.groupId ?? null,
      onMove: groupId => { void commit(moveSurveyListItem(original, zoneId, groupId), expected) },
      onNewGroup: () => {
        const groupId = mintObjectId()
        const next = moveSurveyListItem({ ...original, groups: [...original.groups, { groupId, name: 'New group', collapsed: false, zoneIds: [] }] }, zoneId, groupId)
        void commit(next, expected)
        if (useAppStore.getState().surveyOrganization.groups.some(group => group.groupId === groupId)) setRenamingGroupId(groupId)
      } }
  }
  return { stored, effective, editable, error, commit, groupingFor, renamingGroupId, setRenamingGroupId }
}
export type SurveyListOrganizationModel = ReturnType<typeof useSurveyListOrganization>
