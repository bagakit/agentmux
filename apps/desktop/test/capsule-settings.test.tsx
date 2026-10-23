// @vitest-environment happy-dom
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import type { CapsuleInspection, CapsuleMethod, CapsuleParamsMap, CapsulePort, CapsuleResultMap } from '@agentmux/core/capsule'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { api } from '../src/renderer/src/lib/api'
import { CapsuleSettingsPane } from '../src/renderer/src/components/settings/CapsuleSettingsPane'
import { capsuleSettingsModule } from '../src/renderer/src/components/settings/modules/capsule'
import { settingsCatalog, settingsModules } from '../src/renderer/src/components/settings/settings-modules'
import { createClientUiRoot } from './helpers/client-ui-render'

vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea aria-label="Unused script fixture" /> }))

let directory: string, source: string, nextRoot: string, owner: NodeCapsuleOwner, service: AgentMuxRpcService
let container: HTMLDivElement, root: Root, original: CapsuleInspection, second: CapsuleInspection
let calls: Array<{ method: CapsuleMethod; params: CapsuleParamsMap[CapsuleMethod] }>
let transport: CapsulePort['call']
let inFlight: Set<Promise<unknown>>
const principal = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'capsule-settings-fixture-user' } }
const clone = <T,>(value: T): T => structuredClone(value)
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  directory = await mkdtemp(join(tmpdir(), 'capsule-settings-'))
  source = join(directory, 'original-build'); nextRoot = join(directory, 'new-managed-root')
  await mkdir(source); await writeFile(join(source, 'index.html'), '<!doctype html><title>Original build</title>Retained content')
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'state') })
  original = await owner.call('capsule.create', { operationId: 'fixture-original-page', sourcePath: source, title: 'Original page' })
  second = await owner.call('capsule.create', { operationId: 'fixture-second-page', sourcePath: source, title: 'Second page' })
  service = new AgentMuxRpcService({ coreClients: () => [], capsules: owner })
  calls = []
  inFlight = new Set()
  transport = <M extends CapsuleMethod>(method: M, params: CapsuleParamsMap[M]) => service.call(method, params, principal) as Promise<CapsuleResultMap[M]>
  vi.spyOn(api.capsules, 'call').mockImplementation(((method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    calls.push({ method, params: clone(params) })
    const promise = transport(method, params); inFlight.add(promise)
    void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise))
    return promise
  }) as CapsulePort['call'])
  vi.spyOn(api.ui, 'chooseDirectory').mockResolvedValue(null)
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); service.dispose(); await owner.close(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

function element<T extends HTMLElement = HTMLElement>(label: string, scope: ParentNode = container): T {
  const found = scope.querySelector<T>(`[aria-label="${label}"]`)
  expect(found, `Connected field: ${label}`).not.toBeNull(); expect(found!.isConnected).toBe(true); return found!
}
async function change(label: string, value: string, scope: ParentNode = container) {
  const input = element<HTMLInputElement | HTMLSelectElement>(label, scope)
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function settleTransport() { while (inFlight.size) await act(async () => { await Promise.allSettled([...inFlight]) }) }
async function click(text: string, scope: ParentNode = container, settle = true) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(button, `Connected action: ${text}`).toBeDefined(); await act(async () => button!.click())
  if (settle) await settleTransport()
}
async function mount() { await act(async () => root.render(<CapsuleSettingsPane />)); await settleTransport() }
async function selectPage(title: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.capsule-settings__pages button')].find(node => node.textContent?.includes(title))
  expect(button).toBeDefined(); await act(async () => button!.click())
  await settleTransport()
  return [...container.querySelectorAll<HTMLElement>('[aria-label="Selected Capsule"]')].find(node => !node.parentElement!.hidden)!
}
const mutations = (method: CapsuleMethod) => calls.filter(call => call.method === method)

it('registers one real resource module with static summary and discoverable fields', async () => {
  expect(settingsModules.filter(module => module.id === 'capsule')).toHaveLength(1)
  expect(settingsCatalog.searchResults('managed').some(result => result.module.id === 'capsule')).toBe(true)
  expect(capsuleSettingsModule.savedSummary()).toBe('Persistent pages, isolation and interaction')
  await act(async () => root.render(<capsuleSettingsModule.Pane active config={undefined as never} onClose={() => {}} onNavigate={() => {}} />))
  await settleTransport()
  expect(element<HTMLInputElement>('New Capsule content root').value).toBe((await owner.call('capsule.config.inspect', {})).config.contentRoot)
  for (const target of capsuleSettingsModule.searchTargets) expect(container.querySelector(`[data-settings-field="${target.id}"]`)).not.toBeNull()
  expect(container.textContent).toContain('Original page'); expect(mutations('capsule.open')).toHaveLength(0)
})

it('saves domain defaults with the original revision and preserves existing absolute page resources', async () => {
  await mount(); await change('Default Capsule run mode', 'injected'); await change('Default Capsule content management', 'path'); await change('New Capsule content root', nextRoot)
  await click('Save defaults')
  const input = mutations('capsule.config.update')[0]!.params as CapsuleParamsMap['capsule.config.update']
  expect(input).toMatchObject({ expectedRevision: 1, changes: { defaultMode: 'injected', defaultStorageMode: 'path', contentRoot: nextRoot } })
  expect(input.changes).not.toHaveProperty('enabled')
  const page = await owner.call('capsule.inspect', { capsuleId: original.record.capsuleId })
  expect(page.record).toMatchObject({ capsuleId: original.record.capsuleId, contentRoot: original.record.contentRoot, mode: 'isolated', storageMode: 'managed' })
  expect(mutations('capsule.update')).toHaveLength(0)
})

it('preserves edits made while a defaults save is pending and uses its confirmed revision next', async () => {
  await mount(); const response = deferred<CapsuleResultMap['capsule.config.update']>(), real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => method === 'capsule.config.update' ? response.promise : real(method, params)) as CapsulePort['call']
  await change('New Capsule content root', nextRoot); await click('Save defaults', container, false)
  await change('New Capsule content root', join(directory, 'later-root'))
  const input = mutations('capsule.config.update')[0]!.params as CapsuleParamsMap['capsule.config.update']
  const confirmed = await real('capsule.config.update', input)
  await act(async () => response.resolve(confirmed)); await settleTransport()
  expect(element<HTMLInputElement>('New Capsule content root').value).toBe(join(directory, 'later-root'))
  expect(container.textContent).toContain('Unsaved defaults')
  transport = real; await click('Save defaults')
  expect(mutations('capsule.config.update')[1]!.params).toMatchObject({ expectedRevision: 2, changes: { contentRoot: join(directory, 'later-root') } })
})

it('queries a lost original defaults operation without replaying it', async () => {
  await mount(); const real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    const result = await real(method, params); if (method === 'capsule.config.update') throw new Error('Original reply disconnected'); return result
  }) as CapsulePort['call']
  await change('New Capsule content root', nextRoot); await click('Save defaults')
  await change('New Capsule content root', join(directory, 'retained-edit'))
  await click('Check original operation')
  expect(mutations('capsule.config.update')).toHaveLength(1)
  const first = mutations('capsule.config.update')[0]!.params as CapsuleParamsMap['capsule.config.update']
  expect(mutations('capsule.operation.inspect')[0]!.params).toEqual({ operationId: first.operationId })
  expect(element<HTMLInputElement>('New Capsule content root').value).toBe(join(directory, 'retained-edit'))
  expect(container.textContent).toContain('The original operation is confirmed')
})

it('keeps an unobserved original operation locked while allowing the draft and other pages', async () => {
  await mount(); const real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    if (method === 'capsule.config.update') throw new Error('Transport result unknown')
    if (method === 'capsule.operation.inspect') return { operation: null }
    return real(method, params)
  }) as CapsulePort['call']
  await change('New Capsule content root', nextRoot); await click('Save defaults'); await click('Check original operation')
  expect(mutations('capsule.config.update')).toHaveLength(1)
  await change('New Capsule content root', join(directory, 'editable'))
  expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Save defaults')!.disabled).toBe(true)
  const detail = await selectPage('Original page'); await click('Open page', detail)
  expect(mutations('capsule.open')).toHaveLength(1); expect(container.textContent).toContain('The original operation is still unconfirmed')
})

it('retains a conflicting draft and adopts a newer CAS baseline only after explicit review', async () => {
  await mount(); await change('New Capsule content root', nextRoot)
  await owner.call('capsule.config.update', { operationId: 'external-config-edit', expectedRevision: 1, changes: { defaultMode: 'injected' } })
  await click('Save defaults'); await click('Check original operation'); await click('Read current defaults')
  expect(element<HTMLInputElement>('New Capsule content root').value).toBe(nextRoot)
  await click('Keep edits on current revision'); await click('Save defaults')
  expect(mutations('capsule.config.update')[1]!.params).toMatchObject({ expectedRevision: 2, changes: { contentRoot: nextRoot } })
  expect((await owner.call('capsule.config.inspect', {})).config.defaultMode).toBe('injected')
})

it('imports the chosen path and modes through public RPC and opens or copies the same Capsule', async () => {
  await mount()
  const importDetails = container.querySelector<HTMLDetailsElement>('details[data-settings-field="capsule-import"]')!
  await act(async () => importDetails.querySelector<HTMLElement>('summary')!.click())
  expect(importDetails.open).toBe(true)
  await change('Capsule source directory', source); await change('New Capsule name', 'Imported review'); await change('New Capsule content management', 'path'); await change('New Capsule run mode', 'injected')
  await act(async () => element<HTMLInputElement>('New Capsule is a SPA').click())
  await click('Import page')
  const input = mutations('capsule.create')[0]!.params
  expect(input).toMatchObject({ sourcePath: source, storageMode: 'path', mode: 'injected', routing: 'spa' })
  expect(mutations('capsule.open')).toHaveLength(0)
  const imported = (await owner.call('capsule.ls', {})).capsules.find(page => page.record.title === 'Imported review')!
  expect(imported.record.contentRoot).toBe(await realpath(source))
  const detail = await selectPage('Imported review'); await click('Copy Capsule link', detail)
  expect(api.ui.writeClipboardText).toHaveBeenCalledWith(`amux://capsule/${imported.record.capsuleId}`)
  await click('Open page', detail)
  expect(mutations('capsule.open')[0]!.params).toMatchObject({ capsuleId: imported.record.capsuleId })
  expect(detail.textContent).toContain('This Host has no Browser presentation adapter')
})

it('updates only the exact selected page and keeps its draft across page selection', async () => {
  await mount(); const detail = await selectPage('Original page')
  await change('Capsule page name', 'Edited original', detail); await selectPage('Second page'); const restored = await selectPage('Original page')
  expect(element<HTMLInputElement>('Capsule page name', restored).value).toBe('Edited original')
  await click('Save page', restored)
  expect(mutations('capsule.update')[0]!.params).toMatchObject({ capsuleId: original.record.capsuleId, expectedRevision: 1, changes: { title: 'Edited original' } })
  expect((mutations('capsule.update')[0]!.params as CapsuleParamsMap['capsule.update']).changes).not.toHaveProperty('sourcePath')
  expect((await owner.call('capsule.inspect', { capsuleId: second.record.capsuleId })).record.title).toBe('Second page')
})

it('preserves registered pages on partial reads and rejects a late directory choice over newer input', async () => {
  await mount(); const choice = deferred<string | null>(); vi.mocked(api.ui.chooseDirectory).mockReturnValue(choice.promise)
  await click('Choose directory'); await change('New Capsule content root', nextRoot); await act(async () => choice.resolve(join(directory, 'late-choice')))
  expect(element<HTMLInputElement>('New Capsule content root').value).toBe(nextRoot)
  const real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => method === 'capsule.ls' ? { capsules: [], issues: [{ stage: 'registry', code: 'UNREADABLE', message: 'One registry entry could not be read.', recovery: 'Read the original owner again.' }] } : real(method, params)) as CapsulePort['call']
  await click('Refresh pages')
  expect(container.textContent).toContain('Original page'); expect(container.textContent).toContain('Page directory is incomplete')
  expect(mutations('capsule.config.update')).toHaveLength(0)
})

it('keeps an unknown page operation and later edits when another page is selected', async () => {
  await mount(); const detail = await selectPage('Original page'), real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    const result = await real(method, params); if (method === 'capsule.update') throw new Error('Original page update reply disconnected'); return result
  }) as CapsulePort['call']
  await change('Capsule page name', 'Published name', detail); await click('Save page', detail)
  await change('Capsule page name', 'Later retained draft', detail)
  await selectPage('Second page'); const restored = await selectPage('Original page')
  expect(restored.textContent).toContain('Original page update reply disconnected')
  expect(element<HTMLInputElement>('Capsule page name', restored).value).toBe('Later retained draft')
  await click('Check original operation', restored)
  expect(mutations('capsule.update')).toHaveLength(1)
  expect(element<HTMLInputElement>('Capsule page name', restored).value).toBe('Later retained draft')
})

it('keeps newer saved defaults when an earlier committed receipt arrives late', async () => {
  await mount(); const response = deferred<CapsuleResultMap['capsule.config.update']>(), real = transport
  transport = (async (method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => method === 'capsule.config.update' ? response.promise : real(method, params)) as CapsulePort['call']
  await change('New Capsule content root', nextRoot); await click('Save defaults', container, false)
  const first = await real('capsule.config.update', mutations('capsule.config.update')[0]!.params as CapsuleParamsMap['capsule.config.update'])
  const latestRoot = join(directory, 'newer-external-root')
  await owner.call('capsule.config.update', { operationId: 'later-external-config', expectedRevision: 2, changes: { contentRoot: latestRoot } })
  // This read is independent of the intentionally delayed save receipt.
  await click('Read current defaults', container, false)
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('Saved: ' + latestRoot) })
  await change('New Capsule content root', join(directory, 'later-local-draft'))
  await act(async () => response.resolve(first)); await settleTransport()
  expect(container.textContent).toContain('Saved: ' + latestRoot)
  expect(element<HTMLInputElement>('New Capsule content root').value).toBe(join(directory, 'later-local-draft'))
  expect(container.textContent).toContain('Saved defaults changed')
})
