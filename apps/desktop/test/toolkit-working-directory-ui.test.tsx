// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError, TOOLKIT_WORKSPACE_PATH_ERROR_DETAIL, type ToolkitScriptSnapshot, type ToolkitToolConfiguration, type ToolkitToolDefinition } from '@agentmux/core/control'
import { fixtureEpoch, fixturePath } from '../../../test/fixture-values.mjs'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea aria-label="Test script source" /> }))
const dom = composerDOM(), home = fixturePath('host-home')
const original = (mode: 'script' | 'tui' = 'script'): ToolkitToolDefinition => ({ id: 'directory-tool', revision: 'original-definition', mode, name: 'Directory tool', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: fixturePath('original-directory'), script: 'exec /bin/sh', args: [] })

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  useAppStore.setState({ localHome: home })
  vi.spyOn(api.toolkit, 'list').mockResolvedValue([])
  vi.spyOn(api.toolkit, 'observe').mockReturnValue({ dispose: vi.fn() })
})

function model(tools: ToolkitToolConfiguration[] = []) {
  const writer = {
    add: vi.fn(async (id, value) => ({ ...value, id, revision: 'accepted-definition' })),
    update: vi.fn(async (id, changes) => ({ ...tools.find(tool => tool.id === id)!, ...changes, revision: 'accepted-definition' }))
  }
  const run = vi.fn(async () => 'Admitted')
  const pane = (active = true) => <ToolkitSettingsPane tools={tools} active={active} performance={{ enabled: true, statusBar: 'icon' }} writer={writer} onSave={vi.fn()} onRemoveTool={vi.fn()} onRunTool={run} />
  return { writer, run, pane }
}

function button(label: string, root: ParentNode = dom.container) {
  const value = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  expect(value, label).toBeDefined()
  return value!
}
async function click(label: string, root: ParentNode = dom.container) { await act(async () => button(label, root).click()) }
function directory() { return dom.container.querySelector<HTMLInputElement>('input[aria-label="Fixed working directory"]')! }
async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }

describe('Toolkit working directory in the real Settings consumers', () => {
  it.each(['inline', 'package'] as const)('starts a new %s draft in the fixed default and saves the authored shorthand', async kind => {
    const m = model(); await dom.render(m.pane())
    await click(kind === 'inline' ? 'New custom tool' : 'Install package')
    expect(directory().value).toBe('~/.agentmux')
    expect(dom.container.querySelector('.toolkit-directory__preview code')?.textContent).toBe(`${home}/.agentmux`)
    if (kind === 'inline') await fill(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')!, 'New tool')
    else await fill(dom.container.querySelector<HTMLInputElement>('input[aria-label="Package directory"]')!, fixturePath('extension'))
    await click(kind === 'inline' ? 'Save tool' : 'Install package', dom.container.querySelector('.toolkit-editor__footer')!)
    expect(m.writer.add).toHaveBeenCalledOnce()
    expect(m.writer.add.mock.calls[0]?.[1].workspacePath).toBe('~/.agentmux')
    expect(m.run).not.toHaveBeenCalled()
  })

  it.each(['inline', 'package'] as const)('keeps an invalid %s draft and puts the exact format error beside the field', async kind => {
    const tool: ToolkitToolConfiguration = kind === 'inline' ? original() : { id: 'package-tool', revision: 'original-package', kind: 'package', packagePath: fixturePath('extension'), workspacePath: fixturePath('original-directory'), enabled: true, statusBar: 'icon', args: [] }
    const m = model([tool]); await dom.render(m.pane())
    for (const value of ['relative/project', '$PROJECT/work']) {
      await fill(directory(), value)
      expect(directory().value).toBe(value)
      expect(directory().getAttribute('aria-invalid')).toBe('true')
      const error = dom.container.querySelector('.toolkit-editor__directory .settings-inline-error')!
      expect(error.textContent).toContain('Relative paths have no fixed base')
      expect(directory().getAttribute('aria-describedby')).toContain(error.id)
      expect(button(kind === 'inline' ? 'Save tool' : 'Save preferences').disabled).toBe(true)
    }
    expect(m.writer.update).not.toHaveBeenCalled()
    await fill(directory(), '${HOME}/My project/../output')
    expect(directory().getAttribute('aria-invalid')).toBeNull()
    expect(dom.container.querySelector('.toolkit-directory__preview code')?.textContent).toBe(`${home}/My project/../output`)
    await click(kind === 'inline' ? 'Save tool' : 'Save preferences')
    expect(m.writer.update).toHaveBeenCalledWith(tool.id, { workspacePath: '${HOME}/My project/../output' }, { workspacePath: tool.workspacePath })
  })

  it('keeps saving available while home is unknown and refreshes the preview when it becomes known', async () => {
    useAppStore.setState({ localHome: '' })
    const m = model(); await dom.render(m.pane()); await click('New custom tool')
    await fill(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')!, 'Home unavailable')
    expect(directory().getAttribute('aria-invalid')).toBeNull()
    expect(dom.container.querySelector('.toolkit-editor__directory')?.textContent).toContain('You can still save')
    expect(button('Save tool').disabled).toBe(false)
    await click('Save tool')
    expect(m.writer.add.mock.calls[0]?.[1].workspacePath).toBe('~/.agentmux')
    await act(async () => useAppStore.setState({ localHome: home }))
    expect(dom.container.querySelector('.toolkit-directory__preview code')?.textContent).toBe(`${home}/.agentmux`)
    expect(directory().value).toBe('~/.agentmux')
  })

  it('preserves literal absolute paths and uses local home independently of focused workspaces', async () => {
    const m = model([original()]); await dom.render(m.pane())
    const literal = `${fixturePath('workspace link')}/../output with spaces `
    await fill(directory(), literal)
    expect(dom.container.querySelector('.toolkit-directory__preview code')?.textContent).toBe(literal)
    await fill(directory(), '$HOME/project')
    await act(async () => useAppStore.setState({ activeWorkspaceId: 'unrelated-focused-workspace' }))
    expect(directory().value).toBe('$HOME/project')
    expect(dom.container.querySelector('.toolkit-directory__preview code')?.textContent).toBe(`${home}/project`)
    expect(m.writer.update).not.toHaveBeenCalled()
  })

  it.each(['inline', 'package'] as const)('places a tagged Host directory failure by the %s field without disabling retry or misclassifying other errors', async kind => {
    useAppStore.setState({ localHome: '' })
    const m = model(), message = 'The Host home directory is unavailable.'
    m.writer.add.mockRejectedValueOnce(new AgentMuxError(message, 'HOST_HOME_UNAVAILABLE', TOOLKIT_WORKSPACE_PATH_ERROR_DETAIL))
      .mockRejectedValueOnce(new AgentMuxError('A different directory operation failed.', 'HOST_HOME_UNAVAILABLE', TOOLKIT_WORKSPACE_PATH_ERROR_DETAIL + '.unrelated'))
    await dom.render(m.pane()); await click(kind === 'inline' ? 'New custom tool' : 'Install package')
    if (kind === 'inline') await fill(dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')!, 'Retained draft')
    else await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Package directory"]')!, fixturePath('extension'))
    const footer = dom.container.querySelector('.toolkit-editor__footer')!, label = kind === 'inline' ? 'Save tool' : 'Install package'
    await click(label, footer)
    const fieldError = dom.container.querySelector('.toolkit-editor__directory [role="alert"]')!
    expect(fieldError).not.toBeNull()
    expect(fieldError.textContent).toContain(message)
    expect(directory().getAttribute('aria-describedby')).toContain(fieldError.id)
    expect(footer.textContent).not.toContain(message)
    expect(directory().value).toBe('~/.agentmux')
    expect(button(label, footer).disabled).toBe(false)
    await click(label, footer)
    expect(dom.container.querySelector('.toolkit-editor__directory [role="alert"]')).toBeNull()
    expect(footer.textContent).toContain('A different directory operation failed.')
    expect(button(label, footer).disabled).toBe(false)
    await click(label, footer)
    expect(m.writer.add).toHaveBeenCalledTimes(3)
    expect(footer.querySelector('[role="alert"]')).toBeNull()
    expect(m.run).not.toHaveBeenCalled()
  })

  it('opens the native chooser for its owning document and keeps cancellation and failure recoverable', async () => {
    const chosen = fixturePath('selected folder'), documentIdentity = { windowId: 'settings-window', documentGeneration: 'settings-document' }
    const choose = vi.spyOn(api.ui, 'chooseDirectory').mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Folder dialog unavailable')).mockResolvedValueOnce(chosen)
    const m = model([original()])
    await dom.render(<WorkbenchDocumentContext.Provider value={{ document, window: documentIdentity }}>{m.pane()}</WorkbenchDocumentContext.Provider>)
    await fill(directory(), '~/project')
    await click('Choose folder…')
    expect(choose).toHaveBeenCalledWith({ defaultPath: `${home}/project` }, documentIdentity)
    expect(directory().value).toBe('~/project')
    await click('Choose folder…')
    expect(dom.container.querySelector('.toolkit-editor__directory [role="alert"]')?.textContent).toContain('Folder dialog unavailable')
    expect(button('Save tool').disabled).toBe(false)
    expect(directory().disabled).toBe(false)
    await click('Choose folder…')
    expect(directory().value).toBe(chosen)
    expect(dom.container.querySelector('.toolkit-editor__directory [role="alert"]')).toBeNull()
    expect(m.writer.update).not.toHaveBeenCalled()
  })

  it('does not overwrite later typing even when the path returns to its original value', async () => {
    const held = deferred<string | null>(), choose = vi.spyOn(api.ui, 'chooseDirectory').mockReturnValue(held.promise)
    const m = model([original()]); await dom.render(m.pane())
    const before = directory().value
    await click('Choose folder…')
    expect(button('Choosing…').disabled).toBe(true)
    expect(directory().disabled).toBe(false)
    await fill(directory(), '~/later edit'); await fill(directory(), before)
    await act(async () => held.resolve(fixturePath('late selection')))
    expect(directory().value).toBe(before)
    expect(button('Choose folder…').disabled).toBe(false)
    expect(choose).toHaveBeenCalledOnce()
  })

  it('discards a chooser reply after leaving the editor and reopening it', async () => {
    const held = deferred<string | null>(); vi.spyOn(api.ui, 'chooseDirectory').mockReturnValue(held.promise)
    const m = model([original()]); await dom.render(m.pane())
    await click('Choose folder…')
    await dom.render(m.pane(false)); await dom.render(m.pane(true))
    await act(async () => held.resolve(fixturePath('stale selection')))
    expect(directory().value).toBe(original().workspacePath)
  })

  it('keeps the original TUI Stop reachable when the directory draft has a format error', async () => {
    const tool = original('tui')
    const snapshot: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: tool.id, definition: tool, state: 'running', reason: null, consumerCount: 1, sequence: 1, latestConfirmed: null,
      admission: { executionId: 'original-execution', invocationId: 'original-invocation', definition: tool, expectedLatestExecutionId: null, target: { workspacePath: tool.workspacePath }, run: { hostId: 'local', runId: 'original-run' }, startedAt: fixtureEpoch(1), text: '', state: 'running', reason: null } }
    vi.mocked(api.toolkit.observe).mockImplementation((_id, callback) => { callback(snapshot); return { dispose: vi.fn() } })
    vi.spyOn(api.toolkit, 'get').mockResolvedValue(snapshot)
    const stop = vi.spyOn(api.toolkit, 'stop').mockResolvedValue(snapshot)
    const m = model([tool]); await dom.render(m.pane()); await fill(directory(), 'invalid/relative')
    expect(button('Save tool').disabled).toBe(true)
    expect(button('Stop').disabled).toBe(false)
    await click('Stop')
    expect(stop).toHaveBeenCalledWith(tool.id, 'original-execution')
    expect(m.writer.update).not.toHaveBeenCalled()
    expect(directory().value).toBe('invalid/relative')
  })
})
