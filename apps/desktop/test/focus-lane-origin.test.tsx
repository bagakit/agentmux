// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { focusLaneOrigins } from '../src/renderer/src/lib/focus-lane-origin'
import type { FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

function scene() {
  const ids = ['topic', 'mote', 'survey', 'ordinary', 'unknown']
  const lanes = ids.map(id => ({ id, workspaceId: id, projectId: id, projectWorkspaceId: null, name: 'Same name', labels: ['Parent', 'Same name'], path: fixturePath(id), hostId: 'local',
    topicId: ['topic', 'mote', 'unknown'].includes(id) ? id : null, objectKind: id === 'topic' || id === 'mote' ? id : undefined,
    activeAgentIds: [id], contextIds: [id], recovery: null, summary: null }) as FocusProjectLane)
  const tabs = Object.fromEntries(ids.map(id => [id, createWorkbenchTab(id, { regionId: id, workspaceId: id, kind: 'agent', phase: 'attached', sessionId: id })]))
  const catalog: AgentMuxSpaceCatalog = { spaces: [
    { spaceId: 'category-a', kind: 'container', hostId: 'local', name: 'Research', directoryPath: fixturePath('research'), projectId: null },
    { spaceId: 'category-b', kind: 'container', hostId: 'local', name: 'Engineering', directoryPath: fixturePath('engineering'), projectId: null }
  ], zones: [], tabs: ids.map(id => ({ tabId: id, zoneId: id, workspaceId: id, name: id, regionIds: [id] })), regions: [], locations: [],
    bindings: [{ spaceId: 'category-a', zoneId: 'topic' }, { spaceId: 'category-b', zoneId: 'topic' }] }
  const content = { bindings: {}, categories: catalog.spaces.map(space => ({ categoryId: space.spaceId, hostId: space.hostId, spaceId: space.spaceId, title: space.name, directoryPath: space.directoryPath, revision: null })) }
  return { lanes, tabs, catalog, content }
}

it('keeps confirmed Topic/Mote names and all Category bindings; Survey is an explicit display source', () => {
  const { lanes, tabs, catalog, content } = scene()
  const origins = focusLaneOrigins(lanes, catalog, tabs, [{ zoneId: 'survey', name: 'Protocol exploration' }], content)
  expect([...origins.values()].map(origin => origin.kind)).toEqual(['topic', 'mote', 'survey', 'project', 'unknown'])
  expect(origins.get('topic')?.locations).toEqual(['Research', 'Engineering'])
  expect(origins.get('survey')?.locations).toEqual(['Protocol exploration'])
  const html = renderToStaticMarkup(createElement(FocusProjectLanes, { lanes, origins, visible: false, selectedProjectKey: 'all', onSelect() {}, renderLane: (_lane, heading) => heading }))
  const container = document.createElement('div'); container.innerHTML = html
  expect([...container.querySelectorAll<HTMLElement>('[data-focus-source]')].map(row => row.dataset.focusSource)).toEqual(['topic', 'mote', 'survey', 'project', 'unknown'])
  expect(container.querySelector('[data-lane-id="topic"] .focus-project-lanes__source')?.textContent).toBe('Topic · Research / Engineering')
  expect(container.querySelector('[data-lane-id="mote"] .focus-project-lanes__label')?.textContent).toBe('Same name')
  expect(container.querySelector('[data-lane-id="unknown"] .focus-project-lanes__source')?.textContent).toBe('Source unknown')
})

it('does not infer Survey from paths or collapse Topic and Survey relations', () => {
  const { lanes, tabs, catalog, content } = scene()
  const origins = focusLaneOrigins(lanes, catalog, tabs, [{ zoneId: 'topic', name: 'Secondary display' }], content)
  expect(origins.get('topic')?.kind).toBe('topic')
  expect(origins.get('topic')?.locations).toEqual(['Research', 'Engineering', 'Survey · Secondary display'])
  expect(origins.get('survey')?.kind).toBe('project')
  const mixed = { ...lanes[2]!, contextIds: ['survey', 'ordinary'] }
  expect(focusLaneOrigins([mixed], catalog, tabs, [{ zoneId: 'survey', name: 'Exploration' }], content).get('survey')?.kind).toBe('mixed')
  const missing = focusLaneOrigins([lanes[0]!], { ...catalog, bindings: [] }, {}, [], content)
  expect(missing.get('topic')?.locations).toEqual(['Location unknown'])
})

it('retains exact same-named Category locations for a Topic without an open Tab', () => {
  const { lanes, catalog, content } = scene()
  const categories = content.categories.map(category => ({ ...category, title: 'Shared name' }))
  const original = { ...catalog, spaces: catalog.spaces.map(space => ({ ...space, name: 'Shared name' })),
    zones: [{ zoneId: 'topic', workspaceId: 'topic', hostId: 'local', kind: 'home' as const, directoryPath: fixturePath('topic'), branch: null }] }
  const origins = focusLaneOrigins([lanes[0]!], original, {}, [], { categories,
    bindings: { topic: { spaceId: 'original-topic-content', workspaceId: 'topic', topicId: 'topic', contentKind: 'topic' } } })
  expect(origins.get('topic')?.locations).toEqual(['Shared name', 'Shared name'])
  expect(origins.get('topic')?.addresses).toEqual(['Shared name · category-a', 'Shared name · category-b'])
})
