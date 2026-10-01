import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
// This mounted proof exercises the actual App route and Settings consumers. Native transport is separate.
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: ({ value, onChange }: { value: string; onChange(value: string): void }) => <textarea aria-label="Script test field" value={value} onChange={event => onChange(event.target.value)} /> }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { ToolkitToolDefinition, ToolkitScriptSnapshot } from '@agentmux/core/control'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const tools: ToolkitToolDefinition[] = ['a', 'b'].map(id => ({ id, revision: `revision-${id}`, name: `Tool ${id}`, icon: 'terminal', enabled: true, statusBar: 'label', workspacePath: _hygiene_fixturePath("work"), script: 'console.log(1)', args: [] }))
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(1), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1480)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return new DOMRect(0, 0, this.matches('button,[data-measure-tool]') ? 22 : 0, 26) })
  vi.spyOn(api.toolkit, 'observe').mockImplementation((id, read) => {
    const value: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: id, definition: tools.find(tool => tool.id === id)!, state: 'idle', reason: null, admission: null, latestConfirmed: null, sequence: 1, consumerCount: 1 }
    read(value); return { dispose: vi.fn() }
  })
  vi.spyOn(api.toolkit, 'run')
  useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [{ id: 'one', keyword: 'one', label: 'Original prompt', body: 'Original saved prompt' }], toolkit: { performance: { enabled: false, statusBar: 'icon' }, tools } }, loading: false, initialize: async () => () => {}, detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}), providerCatalog: await api.providers.list() })
})
function node<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  expect(found, `Nonempty owning App control: ${selector}`).not.toBeNull()
  expect(found!.isConnected).toBe(true)
  return found!
}
async function configure(id: string) {
  await act(async () => { node<HTMLButtonElement>(`[data-toolkit-id="${id}"]`).click() })
  const configure = Array.from(document.querySelectorAll<HTMLButtonElement>('.toolkit-result__actions button')).find(button => button.textContent?.trim() === 'Configure')
  expect(configure?.isConnected).toBe(true)
  await act(async () => { configure!.click() })
}
describe('public Configure through the real App navigation owner', () => {
  it('dismisses only the hover layer while the real Prompt input receives Escape and keeps its original panel, focus and draft', async () => {
    await dom.render(<App />)
    await act(async () => { node<HTMLButtonElement>('.surface-navigation [aria-label="Settings"]').click() })
    await act(async () => { node<HTMLButtonElement>('.settings-sidebar [data-settings-target="prompts"]').click() })
    const panel = node('.settings-page'), input = node<HTMLTextAreaElement>('[data-prompt-editor] textarea'), observed: boolean[] = []
    input.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) observed.push(event.defaultPrevented) })
    const authored = '  Keep this original Prompt draft\n中文输入  '
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, authored); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(2, 6) })
    await act(async () => { node('[data-toolkit-id="a"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 140)) })
    expect(document.querySelectorAll('[role="dialog"][aria-label="Tool a"]')).toHaveLength(1)
    expect(document.activeElement).toBe(input)
    const ime = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })
    await act(async () => { input.dispatchEvent(ime) })
    expect(document.querySelectorAll('[role="dialog"][aria-label="Tool a"]')).toHaveLength(1)
    expect(observed).toEqual([]); expect(ime.defaultPrevented).toBe(false)
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { input.dispatchEvent(escape) })
    expect(observed).toEqual([false])
    expect(escape.defaultPrevented).toBe(false)
    expect(document.querySelector('[role="dialog"][aria-label="Tool a"]')).toBeNull()
    expect(node('.settings-page')).toBe(panel)
    expect(node<HTMLTextAreaElement>('[data-prompt-editor] textarea')).toBe(input)
    expect(input.value).toBe(authored); expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6])
  })
  it.each(['library', 'general'] as const)('returns to the same tool from %s without closing Settings, remounting the pane or dropping its authored draft', async (destination) => {
    const sessions = useAppStore.getState().sessions, drafts = useAppStore.getState().agentComposerDrafts
    await dom.render(<App />)
    await configure('a')
    const panel = node('.settings-page'), pane = node('.toolkit-workbench'), name = node<HTMLInputElement>('.toolkit-editor__name input')
    expect(node('[data-tool-editor]').dataset.toolEditor).toBe('a')
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Keep this unsaved name'); name.dispatchEvent(new Event('input', { bubbles: true })) })
    if (destination === 'library') {
      const back = Array.from(pane.querySelectorAll<HTMLButtonElement>('.toolkit-editor button')).find(button => button.textContent?.trim() === 'Back to tools')
      expect(back?.isConnected).toBe(true)
      await act(async () => { back!.click() })
      expect(pane.dataset.view).toBe('library')
    } else {
      await act(async () => { node<HTMLButtonElement>('.settings-sidebar [data-settings-target="general"]').click() })
      expect(panel.dataset.settingsPage).toBe('general')
      expect(node('[data-settings-pane="toolkit"]').hidden).toBe(true)
    }
    await configure('a')
    expect(node('.settings-page')).toBe(panel)
    expect(panel.dataset.settingsPage).toBe('toolkit')
    expect(node('.toolkit-workbench')).toBe(pane)
    expect(pane.dataset.view).toBe('editor')
    expect(node('[data-tool-editor]').dataset.toolEditor).toBe('a')
    expect(node<HTMLInputElement>('.toolkit-editor__name input')).toBe(name)
    expect(name.value).toBe('Keep this unsaved name')
    expect(node('[data-settings-pane="toolkit"]').hidden).toBe(false)
    expect(useAppStore.getState().sessions).toBe(sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    expect(api.toolkit.run).not.toHaveBeenCalled()
  })
})
