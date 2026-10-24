import { expect, it } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { FOCUS_SOURCE_TYPES, focusLaneOrigins } from '../src/renderer/src/lib/focus-lane-origin'
import type { FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/contracts'
import type { SpaceZoneBindings } from '../src/shared/space-addresses'

const emptyCatalog = (): AgentMuxSpaceCatalog => ({ spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [] })
const content = (bindings: SpaceZoneBindings = {}) => ({ bindings, categories: [] })
function lane(id: string, overrides: Partial<FocusProjectLane> = {}): FocusProjectLane {
  return { id, workspaceId: 'workspace', projectId: 'project', projectWorkspaceId: 'workspace', name: 'Project', labels: ['Project'],
    path: fixturePath(id), hostId: 'local', topicId: null, activeAgentIds: [id], contextIds: [id], recovery: null, summary: null, ...overrides }
}
function view(id: string, zoneId = id) {
  return { tab: createWorkbenchTab(id, { regionId: id, workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: id }),
    fact: { tabId: id, zoneId, workspaceId: 'workspace', name: id, regionIds: [id] } }
}

it('exposes all source choices and retains Topic/Mote classification alongside Survey', () => {
  expect(FOCUS_SOURCE_TYPES).toEqual(['project', 'topic', 'mote', 'survey', 'unknown'])
  const views = [view('topic-agent'), view('mote-agent')]
  const lanes = [lane('topic-agent', { topicId: 'topic-object', objectKind: 'topic' }), lane('mote-agent', { topicId: 'mote-object', objectKind: 'mote' })]
  const catalog = { ...emptyCatalog(), tabs: views.map(item => item.fact) }
  const origins = focusLaneOrigins(lanes, catalog, Object.fromEntries(views.map(item => [item.tab.id, item.tab])),
    [{ zoneId: 'topic-agent', name: 'Same label' }, { zoneId: 'mote-agent', name: 'Same label' }], content())
  expect(origins.get('topic-agent')?.contextTypes).toEqual(new Map([['topic-agent', ['topic', 'survey']]]))
  expect(origins.get('mote-agent')?.contextTypes).toEqual(new Map([['mote-agent', ['mote', 'survey']]]))
  expect([...origins.values()].map(origin => origin.kind)).toEqual(['topic', 'mote'])
})

it('keeps Survey membership on the exact Context in a mixed Project lane', () => {
  const views = [view('survey-agent'), view('ordinary-agent')]
  const original = lane('mixed', { contextIds: ['survey-agent', 'ordinary-agent'] })
  const origins = focusLaneOrigins([original], { ...emptyCatalog(), tabs: views.map(item => item.fact) },
    Object.fromEntries(views.map(item => [item.tab.id, item.tab])), [{ zoneId: 'survey-agent', name: 'Exploration' }], content())
  expect(origins.get('mixed')?.contextTypes).toEqual(new Map([
    ['survey-agent', ['project', 'survey']], ['ordinary-agent', ['project']]
  ]))
  expect(origins.get('mixed')?.kind).toBe('mixed')
})

it('keeps unknown classification explicit and does not use the default Project heading as a fact', () => {
  const unknownTopic = lane('unknown-topic', { topicId: 'unread-topic', objectKind: 'unknown' })
  const missing = lane('missing', { projectWorkspaceId: null })
  const scratch = lane('scratch', { projectWorkspaceId: SCRATCH_WORKSPACE_ID, workspaceId: SCRATCH_WORKSPACE_ID })
  const original = view('unknown-topic')
  const origins = focusLaneOrigins([unknownTopic, missing, scratch], { ...emptyCatalog(), tabs: [original.fact] },
    { [original.tab.id]: original.tab }, [{ zoneId: 'unknown-topic', name: 'Project / Topic / Mote' }], content())
  expect(origins.get('unknown-topic')?.contextTypes).toEqual(new Map([['unknown-topic', ['unknown', 'survey']]]))
  expect(origins.get('missing')?.contextTypes).toEqual(new Map([['missing', ['unknown']]]))
  expect(origins.get('scratch')?.contextTypes).toEqual(new Map([['scratch', ['unknown']]]))
  expect(origins.get('missing')?.kind).toBe('project')
})

it('uses only a Context’s confirmed same-Host Project binding when its original workspace is unavailable', () => {
  const ids = ['confirmed', 'unbound', 'foreign', 'container', 'not-project']
  const views = ids.map(id => view(id))
  const original = lane('members', { projectWorkspaceId: null, contextIds: ids })
  const catalog: AgentMuxSpaceCatalog = { ...emptyCatalog(), tabs: views.map(item => item.fact), spaces: [
    { spaceId: 'project', kind: 'folder', hostId: 'local', directoryPath: fixturePath('project'), name: 'Same name', projectId: 'original-project' },
    { spaceId: 'foreign', kind: 'folder', hostId: 'other-host', directoryPath: fixturePath('project'), name: 'Same name', projectId: 'original-project' },
    { spaceId: 'container', kind: 'container', hostId: 'local', directoryPath: fixturePath('project'), name: 'Same name', projectId: null },
    { spaceId: 'not-project', kind: 'folder', hostId: 'local', directoryPath: fixturePath('project'), name: 'Same name', projectId: null }
  ], bindings: [{ zoneId: 'confirmed', spaceId: 'project' }, ...['foreign', 'container', 'not-project'].map(id => ({ zoneId: id, spaceId: id }))] }
  const origins = focusLaneOrigins([original], catalog, Object.fromEntries(views.map(item => [item.tab.id, item.tab])), [], content())
  expect(origins.get('members')?.contextTypes).toEqual(new Map([
    ['confirmed', ['project']], ['unbound', ['unknown']], ['foreign', ['unknown']], ['container', ['unknown']], ['not-project', ['unknown']]
  ]))
})

it('retains a detached content object’s Survey relation through its exact original object or content binding', () => {
  const topic = lane('topic', { topicId: 'original-topic', objectKind: 'topic' })
  const mote = lane('mote', { topicId: 'original-mote', objectKind: 'mote' })
  const unrelated = lane('unrelated', { topicId: 'different-topic', objectKind: 'topic' })
  const catalog: AgentMuxSpaceCatalog = { ...emptyCatalog(), spaces: [
    { spaceId: 'topic-space', kind: 'topic', hostId: 'local', directoryPath: fixturePath('topic'), name: 'Topic', projectId: null, topicId: 'original-topic' }
  ], zones: [{ zoneId: 'mote-zone', workspaceId: 'workspace', kind: 'home', hostId: 'local', directoryPath: fixturePath('mote'), branch: null }],
    bindings: [{ zoneId: 'topic-zone', spaceId: 'topic-space' }] }
  const origins = focusLaneOrigins([topic, mote, unrelated], catalog, {},
    [{ zoneId: 'topic-zone', name: 'Topic view' }, { zoneId: 'mote-zone', name: 'Mote view' }],
    content({ 'mote-zone': { spaceId: 'mote-space', workspaceId: 'workspace', topicId: 'original-mote', contentKind: 'mote' } }))
  expect(origins.get('topic')?.contextTypes).toEqual(new Map([['topic', ['topic', 'survey']]]))
  expect(origins.get('mote')?.contextTypes).toEqual(new Map([['mote', ['mote', 'survey']]]))
  expect(origins.get('unrelated')?.contextTypes).toEqual(new Map([['unrelated', ['topic']]]))
})

it('does not join a detached object to another Host or workspace’s content binding', () => {
  const original = lane('topic', { topicId: 'shared-topic-id', objectKind: 'topic' })
  const catalog: AgentMuxSpaceCatalog = { ...emptyCatalog(), spaces: [
    { spaceId: 'foreign-topic', kind: 'topic', hostId: 'foreign', directoryPath: fixturePath('topic'), name: 'Topic', projectId: null, topicId: 'shared-topic-id' }
  ], zones: [{ zoneId: 'foreign-workspace', workspaceId: 'other-workspace', kind: 'home', hostId: 'local', directoryPath: fixturePath('topic'), branch: null }],
    bindings: [{ zoneId: 'foreign-host', spaceId: 'foreign-topic' }] }
  const origins = focusLaneOrigins([original], catalog, {}, [{ zoneId: 'foreign-host', name: 'Foreign Host' }, { zoneId: 'foreign-workspace', name: 'Foreign Workspace' }],
    content({ 'foreign-workspace': { spaceId: 'topic-space', workspaceId: 'other-workspace', topicId: 'shared-topic-id', contentKind: 'topic' } }))
  expect(origins.get('topic')?.contextTypes).toEqual(new Map([['topic', ['topic']]]))
})
