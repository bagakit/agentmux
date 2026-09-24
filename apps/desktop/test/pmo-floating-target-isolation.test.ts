import { createWorkspaceLayout } from '@agentmux/layout'
import { expect, it } from 'vitest'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { pmoTeamsTopicFloatingTargetTabId } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

it('keeps the saved target authoritative over a different focus, order or delayed Tab restoration', () => {
  const other = { ...createWorkbenchTab('other-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
    regionId: 'other-region', sessionId: 'other-agent' }), topicId: PMO_TEAMS_TOPIC_ID }
  const saved = { open: false, preview: false, targetTabId: 'saved-tab' }
  expect(pmoTeamsTopicFloatingTargetTabId(saved, { [other.id]: other }, createWorkspaceLayout('group', [other.id]), 'other-agent')).toBe('saved-tab')
  expect(pmoTeamsTopicFloatingTargetTabId(saved, {}, undefined, null)).toBe('saved-tab')
})
