import { fixturePath } from '../../scripts/lib/fixture-values.mjs'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { TopicCategory } from '@agentmux/core/control'
import type { AppConfig, ScratchTopicSnapshot } from '../../src/shared/contracts'
import { directoryIdentity, originalTopicAddress } from '../../src/shared/space-addresses'
import { scratchTopicsScope } from '../../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkbenchTab } from '../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../src/renderer/src/store'

export const topicWorkspace = { id: '__scratch__', hostId: 'local', path: fixturePath('private/topics'), name: 'Topics', kind: 'folder' as const }
export const topicCategory: TopicCategory = { categoryId: '00000000-0000-4000-8000-000000000010', hostId: 'local',
  directoryPath: fixturePath('private/categories/product'), spaceId: directoryIdentity('local', fixturePath('private/categories/product')),
  title: 'Product research', revision: 'private-category-1' }
const names = ['Design system and interaction quality', 'Product discovery and customer interviews', 'Continuous reading and terminal history',
  'Cross-device workflows', 'Knowledge sources and provenance', 'Weekly product review', 'Public API examples', 'Research archive']
export const qualityTopics: ScratchTopicSnapshot[] = names.map((title, index) => ({ id: `view:quality-${index}`, title,
  directoryPath: `topic--view--quality-${index}`, topicPath: `topic--view--quality-${index}/topic.md`,
  identityDirectoryPath: fixturePath(`private/topics/topic--view--quality-${index}`), physicalDirectoryPath: fixturePath(`private/topics/topic--view--quality-${index}`),
  summary: ['Shared language, clear states and useful details', 'Interview notes, findings and next questions', 'Reading continuity and original workfaces'][index % 3]!, collaborators: [] }))
export const topicConfig: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {}, workspaces: [topicWorkspace],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
export function seedTopicNavigation({ selected = 0, collapsed }: { selected?: number; collapsed?: boolean } = {}) {
  const tabs = Object.fromEntries(qualityTopics.slice(0, 2).map((topic, index) => {
    const tab = { ...createWorkbenchTab(`topic-tab-${index}`, { kind: 'launcher', workspaceId: topicWorkspace.id, regionId: `topic-region-${index}` }, 'Discussion'), topicId: topic.id }
    return [tab.id, tab]
  }))
  const layout = createWorkspaceLayout('topic-group', Object.keys(tabs))
  const topic = qualityTopics[selected]!
  const selection = { spaceId: topicCategory.spaceId, zoneId: originalTopicAddress(topicWorkspace, topic, {})!.zoneId,
    workspaceId: topicWorkspace.id, topicId: topic.id, tabId: `topic-tab-${selected}`, groupId: layout.activeGroupId, regionId: `topic-region-${selected}` }
  useAppStore.setState({ config: topicConfig, loading: false, sessions: [], tabs, layouts: { [topicWorkspace.id]: layout },
    activeWorkspaceId: topicWorkspace.id, mainSurface: 'workbench', workspaceTool: 'files-branches', projectRailOpen: true, toolsOpen: true,
    topicCategories: [topicCategory], spaceZoneBindings: Object.fromEntries(qualityTopics.map(item => [originalTopicAddress(topicWorkspace, item, {})!.zoneId,
      { spaceId: topicCategory.spaceId, workspaceId: topicWorkspace.id, topicId: item.id, contentKind: 'topic', relations: { [topicCategory.spaceId]: true } }])),
    scratchTopicSnapshots: { [topicWorkspace.id]: { scope: scratchTopicsScope(topicWorkspace), revision: 0, topics: qualityTopics, error: null, reading: false } },
    workbenchSpaceSelection: selection, explorerCollapsed: collapsed === undefined ? {} : { [topicWorkspace.id]: collapsed },
    fileExplorerStates: {}, workspaceFileRevisions: {}, dirtyDocuments: {}, lastActiveFileByWorkspace: {}, scratchTopicOrder: [], pinnedItems: {},
    timelines: {}, agentNames: {}, spaceObjectIcons: {}, agentComposerDrafts: { 'topic-region-0': 'Original unsent draft' },
    recentMoteAgents: {}, recoveryCandidates: [], pendingAgentLaunches: {}, warmTerminal: null })
  return { tabs, layout, selection }
}
