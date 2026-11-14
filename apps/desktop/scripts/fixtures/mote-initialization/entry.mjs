// Reuse the complete production App and its ordinary durable Store initialize.
// The shared fixture controls public ports only; it never replaces an App component.
import './storage-port.mjs'
import '../mote-shared-space-frame/entry.mjs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkspaceLayout } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, parseMoteQuickMode, serializeMoteQuickMode, topicPublicCopy } from '@agentmux/host/mote-model'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { effectiveMoteQuickSave } from '@agentmux/core/mote-preferences'
import { readResolvedTheme, updateThemeSelection } from '@agentmux/client-ui/theme'

const phase = new URLSearchParams(location.search).get('phase'), restore = phase === 'initialization-restore'
const initial = useAppStore.getState(), scratch = initial.config.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID)
const topicId = PMO_TEAMS_TOPIC_ID, root = scratchTopicDirectoryName(topicId), absolute = scratch.path + '/' + root
const spaceId = directoryIdentity(scratch.hostId, absolute), zoneId = homeZoneId(spaceId)
const dataKey = 'agentmux.private-mote-initialization-files.v1'
const files = JSON.parse(localStorage.getItem(dataKey) ?? 'null') ?? {
  [root + '/topic.md']: '# Mote\n\nA thoughtful partner for your ideas and everyday work.\n\n## Shared context\n\nKeep decisions grounded in the original sources. Ask before changing direction.\n',
  [root + '/SOUL.md']: '# Mote\n\nA thoughtful partner. Preserve original decisions and ask before changing direction.\n',
  [root + '/MEMORY.md']: '# Memory\n\nNo shared notes yet.\n',
  [root + '/MOTE.md']: serializeMoteQuickMode('', { executorId: 'cck3' })
}
const calls = [], remember = () => localStorage.setItem(dataKey, JSON.stringify(files))
const digest = async value => 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('')
const revisions = new Map(await Promise.all(Object.values(files).map(async value => [value, await digest(value)])))
const revision = value => { const result = revisions.get(value); if (!result) throw Error('Original controlled content has no revision'); return result }
const defaults = () => { const result = parseMoteQuickMode(files[root + '/MOTE.md']); if (result.status !== 'valid') throw Error('Controlled original settings invalid'); return result.defaults }
const topic = () => ({ id: topicId, kind: 'mote', ...topicPublicCopy(files[root + '/topic.md']), directoryPath: absolute, identityDirectoryPath: absolute, physicalDirectoryPath: absolute,
  topicPath: absolute + '/topic.md', collaborators: [], soul: { path: absolute + '/SOUL.md', content: files[root + '/SOUL.md'], version: revision(files[root + '/SOUL.md']) },
  quickMode: { status: 'saved', version: revision(files[root + '/MOTE.md']), defaults: defaults() } })
const resource = path => ({ hostId: scratch.hostId, workspaceId: scratch.id, workspacePath: scratch.path, zoneId, zonePath: absolute, path: root + '/' + path })
const read = path => files[path] === undefined ? { status: 'deleted' } : { status: 'read', document: { path, content: files[path], revision: revision(files[path]) } }
const readPublic = params => { if (params.expectedResource.hostId !== scratch.hostId || params.expectedResource.workspaceId !== scratch.id || params.expectedResource.workspacePath !== scratch.path || params.spaceId !== spaceId || params.zoneId !== zoneId) throw Error('Wrong original controlled Mote resource'); return { resource: resource(params.path), result: read(root + '/' + params.path) } }
api.files.readPublic = async params => readPublic(params)
api.files.read = async (workspaceId, path) => { if (workspaceId !== scratch.id) throw Error('Wrong original Workspace'); return read(path) }
api.files.readDirectory = async () => []
api.files.write = async (workspaceId, input) => {
  if (workspaceId !== scratch.id || files[input.path] === undefined) throw Error('Wrong original write')
  if (revision(files[input.path]) !== input.expectedRevision) return { status: 'conflict', observedRevision: revision(files[input.path]) }
  files[input.path] = input.content; revisions.set(input.content, await digest(input.content)); remember(); calls.push({ operation: 'write', path: input.path })
  return { status: 'written', revision: revision(input.content), content: input.content }
}
api.scratch.listTopics = async () => [topic()]
api.scratch.ensureMote = async (_workspace, id) => { if (id !== topicId) throw Error('Wrong original Mote'); return topic() }
api.scratch.readTopic = async (_workspace, id) => id === topicId ? topic() : null
api.motePreferences.read = async input => {
  const source = readPublic({ ...input.target, path: 'MOTE.md' })
  return { ...input, status: 'ready', source, defaults: defaults(), main: true, issue: null,
    choices: { executors: [{ id: 'cck3', name: 'cck3', providerId: 'codex' }], conversations: [], destinations: [] },
    maintenance: { status: 'unbound', schedule: null, issue: null } }
}
api.motePreferences.save = async input => {
  if (input.baseline.document.revision !== revision(files[root + '/MOTE.md'])) return { kind: 'quick', target: input.target, operationId: input.operationId, status: 'refused-before-write', source: null, message: 'Original settings changed' }
  files[root + '/MOTE.md'] = serializeMoteQuickMode(files[root + '/MOTE.md'], effectiveMoteQuickSave(input)); revisions.set(files[root + '/MOTE.md'], await digest(files[root + '/MOTE.md'])); remember(); calls.push({ operation: 'save-quick', operationId: input.operationId })
  return { kind: 'quick', target: input.target, operationId: input.operationId, status: 'saved', source: { resource: resource('MOTE.md'), document: read(root + '/MOTE.md').document, defaults: defaults() }, message: null }
}
api.moteDialogue.read = async input => ({ main: { target: input.target, identity: { hostId: scratch.hostId, moteId: topicId }, status: 'ready', resource: resource('MOTE.md'), documentRevision: revision(files[root + '/MOTE.md']), roleRevision: 'original-empty-role', current: null, issue: null },
  links: [], incarnation: 'private-original-dialogue', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
remember()
const cck3 = { label: 'cck3', providerId: 'codex', command: 'not-executed', args: [], env: {}, injectAgentMuxGuide: false }
const config = { ...initial.config, executors: { cck3 } }
useAppStore.setState({ config, scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), topics: [topic()], revision: 1, reading: false, error: null } },
  executorDetections: { ['local\0cck3']: { state: 'ready', input: { executorId: 'cck3', providerId: 'codex', command: cck3.command, env: {}, host: config.hosts.find(value => value.id === 'local') } } } })
if (!restore) {
  const tab = { ...createWorkbenchTab('original-initialization-tab', { kind: 'launcher', regionId: 'original-initialization-region', workspaceId: scratch.id }, 'New discussion'), topicId, space: { spaceId, zoneId } }
  useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: scratch.id, tabs: { [tab.id]: tab }, layouts: { [scratch.id]: createWorkspaceLayout('original-initialization-group', [tab.id]) },
    workbenchSpaceSelection: { spaceId, zoneId, workspaceId: scratch.id, groupId: 'original-initialization-group', tabId: tab.id, regionId: 'original-initialization-region', topicId }, projectRailOpen: false, toolsOpen: false })
} else if (!useAppStore.getState().tabs['original-initialization-tab']) throw Error('Original durable Tab missing after actual Renderer restart')
await useAppStore.getState().openScratchTopic(topicId, scratch.id)
window.moteInit = { ready: true, phase, facts: () => {
  const state = useAppStore.getState()
  return { tabs: state.tabs, layouts: state.layouts, selection: state.workbenchSpaceSelection, drafts: useLauncherState.getState().drafts, files, calls: [...window.sharedFrameProof.facts().calls, ...calls], errors: window.sharedFrameSetup.errors,
    profilePage: document.querySelector('[data-mote-page]')?.getAttribute('data-mote-page'), theme: readResolvedTheme().mode }
}, theme: value => { const result = updateThemeSelection({ ...config.appearance, appAppearance: value }); if (!result.applied) throw Error(result.reason) } }
