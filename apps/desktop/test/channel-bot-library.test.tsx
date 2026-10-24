// @vitest-environment happy-dom
import { act } from 'react'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import type { ConnectionConfig } from '@agentmux/core/connections'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>> | undefined
let facts: Record<string, unknown> = {}
afterEach(async () => {
  try {
    if (f && process.env.AGENTMUX_BOT_LIBRARY_ARTIFACTS) {
      const directory = resolve(process.env.AGENTMUX_BOT_LIBRARY_ARTIFACTS)
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, 'facts.json'), JSON.stringify({ ...facts, scope: 'Actual Settings through registered Main IPC, Unix Core and original File/CAS owner. Hosting route, network and image/DOM leaves are controlled; no live platform or Host-startup qualification.',
        effectMethods: writes().map(([method]) => method), parentEffectMethods: parentWrites().map(([method]) => method), chatEffectMethods: chatWrites().map(([method]) => method),
        preferenceSaves: f.saves.mock.calls.map(([input, owner]) => ({ operationId: input.operationId, target: input.target, values: input.values, owner })), fileEffects: await fileEffects(),
        retainedDraft: useAppStore.getState().agentComposerDrafts['library-retained-agent'] }, null, 2) + '\n')
    }
  } finally { await f?.close(); f = undefined; facts = {} }
})
const firstId = 'library-original-first', secondId = 'library-original-second'
const application = (id: string) => ({ domain: 'open.feishu.cn', appId: 'app-' + id })
async function ready(check: () => void) { await vi.waitFor(async () => { await f!.settle(); check() }, { timeout: 8000 }) }
const writes = () => f!.connectionCalls.mock.calls.filter(([method]) => /configure|\.create$|\.delete$|\.grant$|\.bind$|\.relink$|\.retry$/.test(method))
const parentWrites = () => f!.parentCalls.mock.calls.filter(([method]) => method !== 'space.mote.connection.ls' && method !== 'space.mote.connection.inspect')
const chatWrites = () => f!.chatRequests.mock.calls.filter(([method]) => method === 'space.mote.chat.configure' || method === 'space.mote.chat.allocate')
// moteBotUi spreads its owner; consume the writer's receipts rather than its snapshotted getter.
async function fileEffects(): Promise<Array<{ status: string }>> {
  const bytes = await readFile(resolve(f!.root, 'file-effects'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return bytes.trim() ? bytes.trim().split('\n').map(line => JSON.parse(line)) : []
}

it('manages the exact same-name bot, then explicitly selects a Mote and saves only its original default', async () => {
  f = await moteBotUi()
  // This fixture controls the hosting route, not its Core/File or business owners.
  f.hostingTarget.hostId = 'local'
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => f!.topics.list(f!.workspace))
  await act(async () => { await useAppStore.getState().refreshScratchTopics(f!.workspace.id, true) })
  for (const connectionId of [firstId, secondId]) {
    const connection: ConnectionConfig = { connectionId, adapterId: 'feishu', application: application(connectionId), label: 'Same bot name', enabled: true, credentialRef: 'controlled-library-credential' }
    expect((await f.client.call('connection.configure', { operationId: 'save-' + connectionId, expectedRevision: null, connection })).status).toBe('configured')
  }
  const first = { connectionId: firstId, application: application(firstId) }, second = { connectionId: secondId, application: application(secondId) }
  const originalRead = await f.preferences.read({ kind: 'connection', target: f.target(0) })
  expect((await f.preferences.save({ kind: 'connection', target: f.target(0), operationId: 'library-first-mote-default', baseline: moteConnectionBaseline(originalRead)!, values: { connection: first } })).status).toBe('saved')
  useAppStore.setState({ agentComposerDrafts: { 'library-retained-agent': 'Keep the original unsent draft' } })
  const before = { fileEffects: await fileEffects(), connectionWrites: writes().length, parentCalls: parentWrites().length, chatCalls: chatWrites().length }
  facts = { before, requestedConnectionId: secondId, requestedApplication: application(secondId), requestedMote: f.target(1) }
  await f.render(0, true)
  const record = (id: string) => document.querySelector<HTMLElement>(`[data-connection="${id}"]`)!
  await ready(() => expect(record(secondId)).not.toBeNull())
  expect(document.querySelectorAll('.connector-bot-list [data-connection]')).toHaveLength(2)
  expect(document.querySelector('[data-mote-identity]'), 'unselected Motes do not fill the bot library').toBeNull()
  for (const id of [firstId, secondId]) expect(record(id).textContent).toContain(application(id).appId)
  await ready(() => expect(record(firstId).querySelector('[data-identity-motes]')?.textContent).toContain('new groups'))
  const requested = record(secondId).querySelector<HTMLButtonElement>('.connector-record__open')!
  expect(requested.getAttribute('aria-label')).toContain(application(secondId).appId)
  await act(async () => requested.click())
  await ready(() => expect(document.querySelector('[data-connection-editor] [aria-label="Saved identity facts"]')).not.toBeNull())
  const detail = document.querySelector('[data-connection-editor] [aria-label="Saved identity facts"]')!
  facts.actualManagedIdentity = detail.textContent
  expect(detail.textContent, 'same-name selection reaches the exact original application').toContain(application(secondId).appId)
  expect(detail.textContent).not.toContain(application(firstId).appId)
  await f.click('Back to bots')
  await ready(() => expect(record(secondId)).not.toBeNull())
  const directory = document.querySelector<HTMLButtonElement>('[data-mote-directory]')!
  expect(directory, 'Mote use is explicit and discoverable').not.toBeNull()
  await act(async () => directory.click())
  await ready(() => expect(document.querySelectorAll('[data-mote-identity]').length).toBeGreaterThanOrEqual(2))
  const selectedMote = document.querySelector<HTMLElement>(`[data-mote-identity="${f.scopes[1]!.topic.id}"]`)!
  const identity = selectedMote.querySelector<HTMLButtonElement>('[aria-label^="View bot for"]')!
  await act(async () => identity.click())
  await ready(() => expect(document.querySelector('[data-mote-identity-panel]')?.getAttribute('data-mote-identity-panel')).toBe(f!.scopes[1]!.topic.id))
  facts.openedMoteTopicId = document.querySelector('[data-mote-identity-panel]')!.getAttribute('data-mote-identity-panel')
  const baseline = await f.preferences.read({ kind: 'connection', target: f.target(1) })
  expect(baseline.values).toEqual({ connection: null })
  expect({ fileEffects: await fileEffects(), connectionWrites: writes().length, parentCalls: parentWrites().length, chatCalls: chatWrites().length }).toEqual(before)
  expect(f.saves).not.toHaveBeenCalled()
  await f.click('Choose existing bot')
  const choice = document.querySelector<HTMLElement>('[aria-label="Mote chat bot"]')!
  await act(async () => { choice.focus(); choice.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await ready(() => expect(document.querySelectorAll('[role="menuitemradio"]').length).toBeGreaterThanOrEqual(3))
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes(application(secondId).appId))!
  expect(option).toBeDefined(); expect(option.getAttribute('aria-disabled')).not.toBe('true')
  await act(async () => option.click())
  expect(await fileEffects()).toEqual(before.fileEffects)
  await f.click('Use this bot')
  await ready(() => expect(f!.saves).toHaveBeenCalledTimes(1))
  const [input, owner] = f.saves.mock.calls[0]!
  expect(owner).toEqual(f.hostingTarget)
  expect(input).toMatchObject({ kind: 'connection', operationId: expect.any(String), target: f.target(1), baseline: moteConnectionBaseline(baseline), values: { connection: second } })
  const receipt = await f.saves.mock.results[0]!.value
  facts.receipt = { operationId: receipt.operationId, status: receipt.status, target: receipt.target, values: receipt.source && 'values' in receipt.source ? receipt.source.values : null }
  expect(receipt).toMatchObject({ operationId: input.operationId, status: 'saved', target: f.target(1), source: { values: { connection: second } } })
  expect(await fileEffects()).toEqual([...before.fileEffects, { status: 'written' }])
  const savedRead = await f.client.call('space.mote.preferences.read', { kind: 'connection', target: f.target(1) })
  expect(savedRead.kind).toBe('connection')
  const savedValues = savedRead.kind === 'connection' ? savedRead.values : null
  const originalValues = (await f.preferences.read({ kind: 'connection', target: f.target(0) })).values
  facts.savedValues = savedValues; facts.originalValues = originalValues
  expect(savedValues).toEqual({ connection: second })
  expect(originalValues).toEqual({ connection: first })
  await f.click('Back to Motes')
  await ready(() => expect(document.activeElement?.closest('[data-mote-identity]')?.getAttribute('data-mote-identity')).toBe(f!.scopes[1]!.topic.id))
  facts.returnedMote = document.activeElement?.closest('[data-mote-identity]')?.getAttribute('data-mote-identity')
  await f.click('Back to bots')
  await ready(() => expect(record(secondId)).not.toBeNull())
  facts.returnedLibrary = document.querySelectorAll('.connector-bot-list [data-connection]').length
  expect(await fileEffects()).toEqual([...before.fileEffects, { status: 'written' }])
  expect(f.saves).toHaveBeenCalledTimes(1)
  expect(writes()).toHaveLength(before.connectionWrites)
  expect(parentWrites()).toHaveLength(before.parentCalls)
  expect(chatWrites()).toHaveLength(before.chatCalls)
  expect(f.creationCount).toBe(0)
  expect(useAppStore.getState().agentComposerDrafts['library-retained-agent']).toBe('Keep the original unsent draft')
}, 30_000)
