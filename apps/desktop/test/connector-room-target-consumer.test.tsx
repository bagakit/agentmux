// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey.js'
import { AgentConnectorDialog } from '../src/renderer/src/components/AgentConnectorDialog.js'
import { retainConnectorRoomIntent, useAppStore } from '../src/renderer/src/store.js'
import type { ConnectorRoomIntent } from '../src/renderer/src/lib/connector-room-intent.js'

const f = connectorJourneyFixture()
const target = { executionHostId: 'local', agentSessionId: 'original-agent' }
function intent(operationId: string): ConnectorRoomIntent {
  return { method: 'connection.room.create', target: structuredClone(target), phase: 'may-have-dispatched', input: {
    ...target, operationId, connectionId: f.config.connectionId, expectedConnectionRevision: 1, name: 'Original Session group', members: []
  } }
}

it('the mounted Session-only creator freezes no Region and preserves the original operation after public inspection', async () => {
  if (f.session.kind !== 'agent') throw Error('Original fixture Session must be an Agent')
  await f.dom.render(<AgentConnectorDialog original={{ target, session: f.session, name: 'Original Session' }} mode="create" onClose={() => {}} returnFocus={() => null} />)
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector<HTMLButtonElement>('[data-connector-create]') ?? [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Create group')).toBeDefined() })
  await f.button('Create group')
  await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'connection.room.create')).toHaveLength(1))
  const call = f.calls.find(call => call.method === 'connection.room.create')!, input = call.input as { operationId: string }
  const saved = useAppStore.getState().connectorRoomIntents[input.operationId]
  expect(saved).toBeDefined(); expect(saved!.target).toEqual(target); expect(saved!.input).toEqual(call.input)
  expect(saved!.target).not.toHaveProperty('regionAnchor'); expect(saved!.input).not.toHaveProperty('regionAnchor')
  expect(saved!.phase).toBe('may-have-dispatched')
  expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.connectorRoomIntents[input.operationId]).toEqual(saved)
  await f.original.unchanged()
})

it('the actual Store persists and rehydrates a Session-only submitted intent without changing its operation or phase', async () => {
  const submitted = intent('session-only-original-operation')
  await expect(retainConnectorRoomIntent(submitted)).resolves.toMatchObject({ localStorageWritten: true })
  const persisted = localStorage.getItem('agentmux-workbench-v1')!
  expect(JSON.parse(persisted).state.connectorRoomIntents[submitted.input.operationId]).toEqual(submitted)
  useAppStore.setState({ connectorRoomIntents: {} }); localStorage.setItem('agentmux-workbench-v1', persisted)
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().connectorRoomIntents[submitted.input.operationId]).toEqual(submitted)
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toEqual([])
  await f.original.unchanged()
})

it('the actual Store rejects one-sided or foreign Regions while retaining matching original Region and Session-only intents', async () => {
  const unanchored = intent('no-region-retained'), anchored = intent('exact-region-retained')
  anchored.target.regionAnchor = { regionId: 'original-region' }
  if (!('executionHostId' in anchored.input)) throw Error('Expected original room-create target')
  anchored.input.regionAnchor = { regionId: 'original-region' }
  await retainConnectorRoomIntent(unanchored); await retainConnectorRoomIntent(anchored)
  for (const [operationId, inputRegion, targetRegion] of [['only-input-region', 'original-region', null], ['only-target-region', null, 'original-region'], ['foreign-region', 'original-region', 'foreign-region']] as const) {
    const altered = intent(operationId)
    if (!('executionHostId' in altered.input)) throw Error('Expected original room-create target')
    if (inputRegion) altered.input.regionAnchor = { regionId: inputRegion }
    if (targetRegion) altered.target.regionAnchor = { regionId: targetRegion }
    await expect(retainConnectorRoomIntent(altered)).rejects.toThrow('exact original connector intent')
  }
  expect(useAppStore.getState().connectorRoomIntents).toEqual({ [unanchored.input.operationId]: unanchored, [anchored.input.operationId]: anchored })
  const persisted = localStorage.getItem('agentmux-workbench-v1')!
  useAppStore.setState({ connectorRoomIntents: {} }); localStorage.setItem('agentmux-workbench-v1', persisted); await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().connectorRoomIntents).toEqual({ [unanchored.input.operationId]: unanchored, [anchored.input.operationId]: anchored })
  expect(f.calls.filter(call => call.method === 'connection.room.create')).toEqual([])
})
