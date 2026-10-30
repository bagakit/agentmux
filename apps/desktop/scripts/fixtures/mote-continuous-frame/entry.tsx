// Compose the original complete App fixture; specialize only finite public resource facts.
import '../mote-cooperation/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import type { ScratchTopic } from '../../../src/shared/scratch-topics'
const workspace = useAppStore.getState().config!.workspaces.find(item => item.id === '__scratch__')!
const qualify = (topic: ScratchTopic) => ({ ...topic,
  physicalDirectoryPath: workspace.path + '/' + scratchTopicDirectoryName(topic.id),
  confirmedDirectoryPaths: [workspace.path + '/' + scratchTopicDirectoryName(topic.id)] })
const list = api.scratch.listTopics, readTopic = api.scratch.readTopic
api.scratch.listTopics = async (...args) => (await list(...args)).map(qualify)
api.scratch.readTopic = async (...args) => { const topic = await readTopic(...args); return topic ? qualify(topic) : null }
function refreshScope() {
  useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, snapshot]) => [id,
    snapshot.topics ? { ...snapshot, topics: snapshot.topics.map(qualify) } : snapshot])) }))
}
refreshScope()
const readFile = api.files.readPublic
api.files.readPublic = async params => {
  const prior = await readFile(params)
  const logical = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
  const resourcePath = (prior.resource?.zonePath.slice(workspace.path.length + 1) ?? logical) + '/' + params.path
  const content = params.path === 'BEHAVIOR.md' ? '---\nversion: 1\npreferences:\n  engagement: I\n  information: S\n  decisions: T\n  approach: J\n---\n'
    : params.path === 'SOUL.md' ? '# SOUL\n\nKeep the original direction and finish useful work.\n'
    : params.path === 'MEMORY.md' ? '# Memory\n\nOriginal decisions stay close to their sources.\n'
    : prior.result.status === 'read' ? prior.result.document.content : null
  return { ...prior, resource: prior.resource ? { ...prior.resource, path: resourcePath } : null,
    result: content === null ? prior.result : { status: 'read' as const, document: { path: resourcePath, revision: 'sha256:' + 'b'.repeat(64), content } } }
}
api.goals.execute = async request => {
  if (request.operation === 'demand.list') return { operation: 'demand.list', demands: [] }
  throw new Error('This private frame fixture allows only original Goal reads')
}
api.schedule.list = async () => ({ schedules: [], executionScope: 'connected-host' })
const capture = (window as unknown as { moteCooperationCapture: { longNames(): void; restore(): void } }).moteCooperationCapture
const longNames = capture.longNames, restore = capture.restore
capture.longNames = () => { longNames(); refreshScope() }
capture.restore = () => { restore(); refreshScope() }
