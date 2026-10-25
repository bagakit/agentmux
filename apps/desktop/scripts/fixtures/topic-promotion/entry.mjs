import { createElement as h } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { originalTopicAddress } from '../../../src/shared/space-addresses'
import { qualityTopics, seedTopicNavigation, topicCategory, topicWorkspace } from '../../../test/fixtures/topics-navigation-quality'
import '../../../src/renderer/src/styles/index.css'

// Only transport replies are controlled. App, Topic list, menu, dialog, store and styles
// are the production consumers; no real user content or Agent lifecycle is touched.
seedTopicNavigation()
let topics = qualityTopics.slice(0, 3).map((topic, index) => ({ ...topic,
  kind: 'topic',
  title: ['示例项目 数据运维', '产品发现与用户访谈：记录新方向里的每一次进展与重要决定', '每周项目复盘'][index],
  summary: ['把数据问题查清楚，让每天的任务稳稳运行。', '记录问题、访谈与新的发现', '决策、进展和下一步'][index] }))
const category = { ...topicCategory, title: '工作中的方向' }
useAppStore.setState(state => ({ initialize: async () => () => {}, error: null, lastError: null,
  topicCategories: [category],
  scratchTopicSnapshots: { [topicWorkspace.id]: { ...state.scratchTopicSnapshots[topicWorkspace.id], topics } },
  tabs: Object.fromEntries(Object.entries(state.tabs).map(([id, tab], index) => [id, { ...tab, name: '运维记录', title: '运维记录',
    space: { spaceId: category.spaceId, zoneId: originalTopicAddress(topicWorkspace, topics[index], state.spaceZoneBindings).zoneId },
    regions: { [tab.layout.activeRegionId]: { kind: 'file', regionId: tab.layout.activeRegionId, workspaceId: topicWorkspace.id,
      path: `topic--view--quality-${index}/research.md` } } }])) }))
let graph = desktopSpatialGraph(useAppStore.getState(), topics), revision = 1
const calls = [], controls = [], operations = new Map()
const knowledge = { topicId: topics[0].id, entryId: 'Q7vb3Jkm9XL2', title: '任务延迟的排查顺序',
  content: '先确认上游任务完成时间，再检查分区是否到齐，最后核对调度依赖。', form: 'derived', certainty: 'decision',
  sources: [{ kind: 'topic', topicId: topics[0].id }], revision: 'private-knowledge-1', updatedAt: 24 * 60 * 60 * 1000 }
let nextApply = 'partial', held = null, release = null
api.scratch.listTopics = async () => topics
api.scratch.readTopic = async (_workspace, topicId) => topics.find(topic => topic.id === topicId) ?? null
api.spaceObjects.appearance = async () => ({ local: true, icon: null })
api.files.readDirectory = async (_workspaceId, path) => ['topic.md', 'research.md', 'decisions.md', 'references'].map(name => ({ name,
  path: path ? path + '/' + name : name, isDirectory: name === 'references', isSymlink: false }))
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.files.read = async (_workspace, path) => ({ status: 'read', document: { path, revision: 'private-source-1',
  content: '# 示例项目 运维记录\n\n每天从具体的问题开始，把有用的经验留下来。\n\n## 今天一起完成的事\n\n- 检查昨晚的任务，确认数据已经按时到达。\n- 找到一次延迟的原因，记录定位方法。\n- 整理值班时常用的查询与排查步骤。\n\n## 接下来\n\n继续观察任务恢复后的运行情况。已有的对话、资料和工作位置都在这里。\n' } })
api.spatial.read = async () => ({ revision, graph })
function topicFact(topicId) {
  const topic = topics.find(item => item.id === topicId)
  if (!topic) return null
  const address = originalTopicAddress(topicWorkspace, topic, useAppStore.getState().spaceZoneBindings)
  return { topicId, hostId: 'local', zoneId: address.zoneId, directoryPath: topic.physicalDirectoryPath,
    title: topic.title, summary: topic.summary, categorySpaceIds: [category.spaceId],
    chatIds: graph.tabs.filter(tab => tab.zoneId === address.zoneId).map(tab => tab.tabId), spatialRevision: revision,
    contentKind: graph.resources['zone:' + address.zoneId]?.contentKind ?? 'topic' }
}
function complete(receipt) {
  const topic = topics.find(item => item.id === receipt.topicId)
  const address = originalTopicAddress(topicWorkspace, topic, useAppStore.getState().spaceZoneBindings)
  topics = topics.map(item => item.id === topic.id ? { ...item, kind: 'mote', soul: { content: '从每天共同处理的运维工作开始，成为可靠的长期伙伴。', path: topic.directoryPath + '/SOUL.md', version: 'private-soul-1' } } : item)
  graph = structuredClone(graph)
  graph.spaces = graph.spaces.filter(space => space.spaceId !== address.spaceId)
  graph.spaces.push({ spaceId: address.spaceId, kind: 'mote', name: topic.title, hostId: 'local', directoryPath: topic.physicalDirectoryPath,
    workspaceId: topicWorkspace.id, topicId: topic.id, projectId: null })
  if (!graph.bindings.some(binding => binding.spaceId === address.spaceId && binding.zoneId === address.zoneId)) graph.bindings.push({ spaceId: address.spaceId, zoneId: address.zoneId })
  graph.resources['zone:' + address.zoneId] = { ...graph.resources['zone:' + address.zoneId], spaceId: address.spaceId,
    topicId: topic.id, workspaceId: topicWorkspace.id, contentKind: 'mote' }
  revision += 1
  return { ...receipt, state: 'complete', stage: 'complete', topic: topicFact(topic.id), moteSpaceId: address.spaceId,
    unavailable: [], diskDurability: 'confirmed' }
}
api.topics.call = async (method, params) => {
  calls.push({ method, params: structuredClone(params) })
  if (method === 'topic.category.ls') return { categories: [category], unavailable: [] }
  if (method === 'topic.inspect') return { topic: topicFact(params.topicId), unavailable: [] }
  if (method === 'topic.knowledge.ls' || method === 'topic.knowledge.search') return { entries: params.topicId === knowledge.topicId ? [knowledge] : [], documents: [], unavailable: [], observation: { unavailable: [] } }
  if (method === 'topic.knowledge.read') return { entry: params.topicId === knowledge.topicId && params.entryId === knowledge.entryId ? knowledge : null }
  if (method === 'topic.promote.inspect') {
    const original = operations.get(params.topicId)
    if (params.operationId && original && original.operationId !== params.operationId) throw Error('Wrong original operation requested')
    return { promotion: original ?? null }
  }
  if (method === 'topic.promote.apply') {
    const original = operations.get(params.topicId)
    if (original && original.operationId !== params.operationId) throw Error('An existing promotion cannot be recreated with a different operation')
    const receipt = original ?? { operationId: params.operationId, topicId: params.topicId, state: 'partial', stage: 'spatial',
      topic: topicFact(params.topicId), moteSpaceId: null, unavailable: [], diskDurability: 'confirmed' }
    if (held) { await held; held = null }
    if (nextApply === 'partial') {
      nextApply = 'complete'
      receipt.unavailable = [{ code: 'SPATIAL_STATE_CONFLICT', message: '空间关系还未保存，原来的工作仍然可用。', recovery: '查看结果后继续本次晋升。' }]
      operations.set(params.topicId, receipt)
      return { promotion: receipt }
    }
    const result = complete(receipt)
    operations.set(params.topicId, result)
    if (nextApply === 'unknown') { nextApply = 'complete'; throw Error('连接暂时中断，晋升结果待核实。') }
    return { promotion: result }
  }
  throw Error('Unconfigured private transport: ' + method)
}
for (const name of ['launchAgent', 'launchTerminal', 'stop', 'write', 'resume', 'interrupt']) api.sessions[name] = async () => {
  controls.push(name); throw Error('Visual inspection must not invoke execution: ' + name)
}
window.agentmux = { git: { status: async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: topicWorkspace.path }) } }
createClientUiRoot(document.getElementById('root')).render(h(App))
void useAppStore.getState().setEditorRegionMode('topic-region-0', topicWorkspace.id, 'topic--view--quality-0/research.md', 'preview')
window.topicPromotionProbe = {
  ready: true, topics, workspace: topicWorkspace,
  theme(value) { document.documentElement.dataset.appearance = value; useAppStore.setState(state => ({ config: { ...state.config,
    appearance: { ...state.config.appearance, appAppearance: value } } })) },
  narrow() { useAppStore.setState({ projectRailOpen: false }) },
  showDirectory() { useAppStore.setState({ projectRailOpen: true }) },
  next(value) { nextApply = value },
  hold() { held = new Promise(done => { release = done }) },
  release() { release?.(); release = null },
  facts() { const state = useAppStore.getState(); return { calls, controls, selection: state.workbenchSpaceSelection,
    tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts,
    operations: [...operations.values()], topicCount: document.querySelectorAll('.workspace-topic-entry').length } }
}
