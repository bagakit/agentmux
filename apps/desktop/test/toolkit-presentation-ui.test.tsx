// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
import type { SessionSnapshot } from '../src/shared/contracts'
import { fixtureEpoch, fixturePath } from '../../../test/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { ToolkitTerminalAppearance } from '../src/renderer/src/components/settings/ToolkitTerminalAppearance'
import { composerDOM } from './helpers/composer-dom-fixture'

const terminal = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: (props: unknown) => { terminal(props); return <textarea aria-label="Original terminal" defaultValue="Retained buffer" /> } }))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Command editor" value={value} readOnly /> }))
const dom = composerDOM()
const definition: ToolkitToolDefinition = { id: 'presentation-tool', revision: 'captured', name: 'Workspace shell', icon: 'terminal', mode: 'tui', enabled: true, statusBar: 'icon', workspacePath: fixturePath('toolkit'), script: '', args: [] }
const session: SessionSnapshot = { id: 'original-run', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: definition.workspacePath, label: 'Terminal', createdAt: fixtureEpoch(1), updatedAt: fixtureEpoch(1), latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: fixtureEpoch(1) }, control: { kind: 'terminal', hostId: 'local', runId: 'original-run', run: { runId: 'original-run' } } }
const snapshot: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'running', reason: null, consumerCount: 1, sequence: 1, latestConfirmed: null, admission: { executionId: 'original-execution', invocationId: 'original-invocation', definition, expectedLatestExecutionId: null, target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'original-run' }, startedAt: fixtureEpoch(1), text: '', state: 'running', reason: null } }
beforeEach(() => {
  terminal.mockClear()
  useAppStore.setState({ toolkitPresentation: {} })
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, listener) => { listener(snapshot); return { dispose() {} } })
  vi.spyOn(api.toolkit, 'get').mockResolvedValue(snapshot)
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
})
async function choose(value: string) {
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Tool terminal palette"]')!
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
it('applies a tool palette to the original presenter, follows global again, and keeps identities and input', async () => {
  const run = vi.spyOn(api.toolkit, 'run'), stop = vi.spyOn(api.toolkit, 'stop'), save = vi.spyOn(api.config, 'save')
  await dom.render(<><ToolkitTerminalAppearance toolId={definition.id} /><UserToolkitResult definition={definition} active /></>)
  const input = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Original terminal"]')!
  await act(async () => { input.focus(); input.setSelectionRange(2, 7) })
  expect(terminal.mock.lastCall![0].themeId).toBe('graphite')
  await choose('nord')
  expect(terminal.mock.lastCall![0]).toMatchObject({ themeId: 'nord', session })
  const config = useAppStore.getState().config!
  await act(async () => useAppStore.setState({ config: { ...config, appearance: { ...config.appearance, terminalTheme: 'dracula' } } }))
  expect(terminal.mock.lastCall![0].themeId).toBe('nord')
  expect(dom.container.querySelector('[aria-label="Original terminal"]')).toBe(input)
  expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(7)
  await choose('global')
  expect(terminal.mock.lastCall![0].themeId).toBe('dracula')
  await choose('workspace')
  expect(terminal.mock.lastCall![0].themeId).toBe('workspace')
  expect(dom.container.textContent).toContain('Follow this window’s theme')
  await dom.render(<ToolkitTerminalAppearance toolId="other-tool" />)
  expect(dom.container.querySelector<HTMLSelectElement>('select')!.value).toBe('global')
  expect(snapshot.definition.revision).toBe('captured')
  expect(run).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
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
