// @vitest-environment happy-dom
import { act } from 'react'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { fixtureEpoch, fixturePath } from '../../../test/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const terminal = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: (props: unknown) => { terminal(props); return <textarea aria-label="Original terminal" defaultValue="Retained buffer" /> } }))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Command editor" value={value} readOnly /> }))
const dom = composerDOM()
const definition: ToolkitToolDefinition = { id: 'presentation-tool', revision: 'captured', name: 'Workspace shell', icon: 'terminal', mode: 'tui', enabled: true, statusBar: 'icon', workspacePath: fixturePath('toolkit'), script: '', args: [] }
const session: SessionSnapshot = { id: 'original-run', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: definition.workspacePath, label: 'Terminal', createdAt: fixtureEpoch(1), updatedAt: fixtureEpoch(1), latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: fixtureEpoch(1) }, control: { kind: 'terminal', hostId: 'local', runId: 'original-run', run: { runId: 'original-run' } } }
const snapshot: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'running', reason: null, consumerCount: 1, sequence: 1, latestConfirmed: null, admission: { executionId: 'original-execution', invocationId: 'original-invocation', definition, expectedLatestExecutionId: null, target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'original-run' }, startedAt: fixtureEpoch(1), text: '', state: 'running', reason: null } }
let dispose: (() => void) | undefined
beforeEach(async () => {
  terminal.mockClear()
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [{ id: 'workspace', name: 'Workspace', hostId: 'local', path: fixturePath('toolkit'), kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [], endpointWarnings: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  dispose = await useAppStore.getState().initialize()
  useAppStore.setState({ toolkitPresentation: {} })
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, listener) => { listener(snapshot); return { dispose() {} } })
  vi.spyOn(api.toolkit, 'get').mockResolvedValue(snapshot)
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
})
afterEach(() => { dispose?.(); dispose = undefined })
function pane(writer = { add: vi.fn(), update: vi.fn() }) {
  return <ToolkitSettingsPane performance={{ enabled: true, statusBar: 'icon' }} tools={[definition, { ...definition, id: 'other-tool', name: 'Other shell' }]} toolId={definition.id} active writer={writer} onSave={vi.fn()} onRemoveTool={vi.fn()} onRunTool={vi.fn()} />
}
async function choose(value: string) { await dom.click(`.toolkit-palette input[value="${value}"]`) }
async function saveTool() {
  const save = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save tool')!
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
}
it('previews palette cards until explicit Save tool, then updates the same terminal without changing execution', async () => {
  const run = vi.spyOn(api.toolkit, 'run'), stop = vi.spyOn(api.toolkit, 'stop'), configSave = vi.spyOn(api.config, 'save')
  const writer = { add: vi.fn(), update: vi.fn() }
  await dom.render(<>{pane(writer)}<UserToolkitResult definition={definition} active /></>)
  const input = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Original terminal"]')!
  await act(async () => { input.focus(); input.setSelectionRange(2, 7) })
  const initial = terminal.mock.lastCall![0].themeId
  expect(dom.container.querySelector('.toolkit-palette select')).toBeNull()
  expect(dom.container.querySelectorAll('.toolkit-palette input[type="radio"]')).toHaveLength(9)
  await choose('nord')
  expect(terminal.mock.lastCall![0].themeId).toBe(initial)
  expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBeUndefined()
  expect(dom.container.textContent).toContain('Unsaved changes')
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Changes saved')) })
  expect(terminal.mock.lastCall![0]).toMatchObject({ themeId: 'nord', session })
  expect(dom.container.querySelector('[aria-label="Original terminal"]')).toBe(input)
  expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(7)
  const config = useAppStore.getState().config!
  await act(async () => useAppStore.setState({ config: { ...config, appearance: { ...config.appearance, terminalTheme: 'dracula' } } }))
  await choose('global')
  expect(terminal.mock.lastCall![0].themeId).toBe('nord')
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(terminal.mock.lastCall![0].themeId).toBe('dracula')) })
  await choose('workspace'); await saveTool()
  await act(async () => { await vi.waitFor(() => expect(terminal.mock.lastCall![0].themeId).toBe('workspace')) })
  expect(dom.container.textContent).toContain('Follow this window’s theme')
  expect(snapshot.definition.revision).toBe('captured')
  expect(writer.update).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(configSave).not.toHaveBeenCalled()
})
it('retains separate unsaved choices across tools and restores only the selected tool', async () => {
  await dom.render(pane())
  await choose('nord')
  await dom.click('[data-tool-id="other-tool"]'); await choose('dracula')
  await dom.click(`[data-tool-id="${definition.id}"]`)
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="nord"]')!.checked).toBe(true)
  await dom.click('.toolkit-palette__summary button')
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="global"]')!.checked).toBe(true)
  await dom.click('[data-tool-id="other-tool"]')
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="dracula"]')!.checked).toBe(true)
  expect(useAppStore.getState().toolkitPresentation).toEqual({})
})
it('shows a failed palette flush as unsaved and retries the same local choice without changing tool configuration', async () => {
  const writer = { add: vi.fn(), update: vi.fn() }
  await dom.render(pane(writer)); await choose('nord')
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValueOnce(Error('Palette disk confirmation unavailable'))
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Palette disk confirmation unavailable')) })
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="nord"]')!.checked).toBe(true)
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Changes saved')) })
  expect(writer.update).not.toHaveBeenCalled()
})
it('does not acknowledge a newer palette choice with an older save reply', async () => {
  await dom.render(pane()); await choose('nord')
  let resolve!: () => void
  vi.mocked(api.ui.requestStorageFlush).mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
  await saveTool(); await choose('dracula')
  await act(async () => resolve())
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="dracula"]')!.checked).toBe(true)
  expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBe('nord')
  expect(dom.container.textContent).toContain('Unsaved changes')
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBe('dracula')) })
})
it('keeps failed-save recovery usable after another choice or restoring the last confirmed palette', async () => {
  await dom.render(pane()); await choose('nord')
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValueOnce(Error('Unconfirmed palette commit'))
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Unconfirmed palette commit')) })
  await choose('dracula'); await saveTool()
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Changes saved')) })
  expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBe('dracula')
  await choose('nord')
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValueOnce(Error('Second unconfirmed palette commit'))
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Second unconfirmed palette commit')) })
  await dom.click('.toolkit-palette__summary button')
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="dracula"]')!.checked).toBe(true)
  expect(dom.container.querySelector('.toolkit-editor__footer .settings-save-feedback')?.textContent).toContain('unconfirmed')
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Changes saved')) })
  expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBe('dracula')
})
it('retains a later restore while the combined tool save awaits its configuration receipt', async () => {
  let resolve!: (value: ToolkitToolDefinition) => void
  const writer = { add: vi.fn(), update: vi.fn(() => new Promise<ToolkitToolDefinition>(done => { resolve = done })) }
  await dom.render(pane(writer)); await choose('nord')
  const name = dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Updated shell'); name.dispatchEvent(new Event('input', { bubbles: true })) })
  await saveTool()
  await dom.click('.toolkit-palette__summary button')
  await act(async () => resolve({ ...definition, name: 'Updated shell', revision: 'saved' }))
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBe('nord')) })
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="global"]')!.checked).toBe(true)
  expect(dom.container.querySelector('.toolkit-editor__footer .settings-save-feedback')?.textContent).toBe('Unsaved changes')
  expect(dom.container.querySelectorAll('.toolkit-palette input:checked')).toHaveLength(1)
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBeUndefined()) })
  expect(writer.update).toHaveBeenCalledOnce()
})
it('saves a blank TUI command from the actual editor without requiring a finite script', async () => {
  const writer = { add: vi.fn(), update: vi.fn(async (_id, changes) => ({ ...definition, ...changes, revision: 'saved' })) }
  await dom.render(<ToolkitSettingsPane performance={{ enabled: true, statusBar: 'icon' }} tools={[definition]} toolId={definition.id} active writer={writer} onSave={vi.fn()} onRemoveTool={vi.fn()} onRunTool={vi.fn()} />)
  expect(dom.container.querySelector('[aria-label="Command editor"]')?.textContent).toBe('')
  expect(dom.container.textContent).toContain('Leave blank to open the Host’s default interactive shell')
  const name = dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')!
  await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(name, 'Updated shell'); name.dispatchEvent(new Event('input', { bubbles: true })) })
  const save = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Save tool')!
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
  expect(writer.update).toHaveBeenCalledWith(definition.id, { name: 'Updated shell' }, { name: definition.name })
})

it('keeps Workspace and Follow global previews aligned with the original window theme owner', async () => {
  const release = mountThemeRuntime(window, { appAppearance: 'light' })
  try {
    const config = useAppStore.getState().config!
    useAppStore.setState({ config: { ...config, appearance: { ...config.appearance, terminalTheme: 'workspace' } } })
    await dom.render(pane())
    const sample = (value: string) => dom.container.querySelector<HTMLInputElement>(`.toolkit-palette input[value="${value}"]`)!.closest('label')!.querySelector<HTMLElement>('.toolkit-palette__sample')!.style.background
    const light = sample('workspace'), fixed = sample('nord')
    expect(sample('global')).toBe(light)
    await choose('nord')
    await act(async () => { expect(updateThemeSelection({ appAppearance: 'dark' }).applied).toBe(true) })
    expect(sample('workspace')).not.toBe(light)
    expect(sample('global')).toBe(sample('workspace'))
    expect(sample('nord')).toBe(fixed)
    expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="nord"]')!.checked).toBe(true)
    expect(useAppStore.getState().toolkitPresentation).toEqual({})
    await act(async () => { updateThemeSelection({ appAppearance: 'light' }) })
    expect(sample('workspace')).toBe(light)
  } finally { release() }
})

it('requires explicit restore before adopting a palette changed by another writer', async () => {
  await dom.render(pane()); await choose('nord')
  await act(async () => useAppStore.getState().setToolkitPresentation(definition.id, { theme: 'dracula' }))
  await saveTool()
  expect(dom.container.textContent).toContain('saved palette changed elsewhere')
  expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBe('dracula')
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="nord"]')!.checked).toBe(true)
  await dom.click('.toolkit-palette__summary button')
  expect(dom.container.querySelector<HTMLInputElement>('.toolkit-palette input[value="dracula"]')!.checked).toBe(true)
  await saveTool()
  await act(async () => { await vi.waitFor(() => expect(dom.container.textContent).toContain('Changes saved')) })
  expect(useAppStore.getState().toolkitPresentation[definition.id]?.theme).toBe('dracula')
})
