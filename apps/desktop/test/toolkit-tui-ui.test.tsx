// @vitest-environment happy-dom
import { act, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
import type { SessionSnapshot } from '../src/shared/contracts'
import { fixtureEpoch, fixturePath } from '../../../test/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { ToolkitPopover } from '../src/renderer/src/components/performance/PerformancePopover'
import { ToolkitSettingsPane } from '../src/renderer/src/components/settings/ToolkitSettingsPane'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { TuiToolkitSettings } from '../src/renderer/src/components/toolkit/TuiToolkitResult'
import { composerDOM } from './helpers/composer-dom-fixture'

const terminal = vi.hoisted(() => vi.fn())
// This boundary verifies the product hands its authoritative Session to the shared terminal.
// Native attachment, input and replay are qualified by the runtime consumer tests.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: (props: unknown) => { terminal(props); return <textarea aria-label="Shared terminal input" /> } }))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: ({ value, onChange, mode }: { value: string; onChange(value: string): void; mode?: string }) => <textarea aria-label="Command editor" data-mode={mode} value={value} onChange={event => onChange(event.target.value)} /> }))
const dom = composerDOM()
const definition = (mode: 'script' | 'tui' = 'tui'): ToolkitToolDefinition => ({ id: 'local-tui', mode, revision: 'saved-command', name: 'Local terminal', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: fixturePath('toolkit'), script: 'exec /bin/sh', args: [] })
const running = (): ToolkitScriptSnapshot => {
  const tool = definition()
  return { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: tool.id, definition: tool, state: 'running', reason: null, consumerCount: 1, sequence: 1, latestConfirmed: null,
    admission: { executionId: 'original-execution', invocationId: 'original-invocation', definition: tool, expectedLatestExecutionId: null, target: { workspacePath: tool.workspacePath }, run: { hostId: 'local', runId: 'original-run' }, startedAt: fixtureEpoch(1), text: '', state: 'running', reason: null } }
}
const session = (): Extract<SessionSnapshot, { kind: 'terminal' }> => ({
  id: 'original-run', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: fixturePath('toolkit'), label: 'Terminal', createdAt: fixtureEpoch(1), updatedAt: fixtureEpoch(1), latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: fixtureEpoch(1) },
  control: { kind: 'terminal', hostId: 'local', runId: 'original-run', run: { runId: 'original-run' } }
})
function observe(value: ToolkitScriptSnapshot) {
  const dispose = vi.fn()
  let publish!: (value: ToolkitScriptSnapshot) => void
  let fail!: (reason: string) => void
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, callback, onError) => { publish = callback; fail = onError!; callback(value); return { dispose } })
  vi.spyOn(api.toolkit, 'get').mockResolvedValue(value)
  return { dispose, publish: (next: ToolkitScriptSnapshot) => publish(next), fail: (reason: string) => fail(reason) }
}
beforeEach(() => {
  terminal.mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(1), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})

describe('TUI toolkit product presentation', () => {
  it('keeps state and controls in the title of the captured presenter, retaining the original terminal on unknown observation', async () => {
    const value = { ...running(), definition: { ...definition('script'), revision: 'edited-mode' } }
    const reading = observe(value)
    const authoritative = session()
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(authoritative)
    const stop = vi.spyOn(api.toolkit, 'stop'), run = vi.spyOn(api.toolkit, 'run')
    function Consumer() {
      const [selected, select] = useState<string | symbol | null>(null)
      return <ToolkitPopover toolId={value.toolId} name={value.definition.name} icon={<span />} selectedToolId={selected} onSelectTool={select}>{close => <UserToolkitResult definition={value.definition} active close={close} />}</ToolkitPopover>
    }
    await dom.render(<Consumer />); await dom.click('[data-toolkit-id="local-tui"]')
    const panel = document.querySelector('.performance-popover')!, header = panel.querySelector('.toolkit-tui__header')!
    expect(header.querySelector('h2')?.textContent).toBe(value.definition.name)
    expect(header.querySelector('[role="status"]')?.textContent).toBe('Running')
    expect(header.querySelector('[aria-label="Stop command"]')).not.toBeNull()
    expect(header.querySelector('[aria-label="Check status"]')).not.toBeNull()
    expect(panel.querySelector('[aria-label="Resize terminal panel"]')).not.toBeNull()
    expect(panel.querySelector('.toolkit-tui__status')).toBeNull()
    expect(panel.querySelector('footer')).toBeNull()
    expect(panel.textContent).not.toContain('Interactive terminal')
    const input = panel.querySelector('textarea')!
    await act(async () => { input.focus(); reading.fail('Observation disconnected') })
    expect(header.querySelector('[role="status"]')?.textContent).toBe('Observation unavailable')
    expect(header.querySelector('[data-state="unknown"]')).not.toBeNull()
    expect(panel.querySelector('.toolkit-tui__notices')?.textContent).toContain('The original terminal is kept')
    expect(panel.querySelector('textarea')).toBe(input); expect(document.activeElement).toBe(input)
    expect((header.querySelector('[aria-label="Stop command"]') as HTMLButtonElement).disabled).toBe(false)
    expect(stop).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled()
  })
  it('opens the captured TUI Run after a mode edit and preserves it across observation failure and close', async () => {
    const value = { ...running(), definition: { ...definition('script'), revision: 'edited-mode' } }
    const reading = observe(value)
    const authoritative = session()
    const refresh = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(authoritative)
    const stop = vi.spyOn(api.toolkit, 'stop'), run = vi.spyOn(api.toolkit, 'run')
    await dom.render(<UserToolkitResult definition={value.definition} active close={vi.fn()} />)
    expect(api.toolkit.observe).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(authoritative.control)
    expect(terminal.mock.lastCall?.[0]).toMatchObject({ session: authoritative, autoFocus: false, visible: true })
    expect(terminal.mock.lastCall?.[0].linkOrigin).toBeUndefined()
    expect(dom.container.textContent).toContain('keeps its captured command')
    refresh.mockRejectedValue(new Error('Observation disconnected'))
    const check = [...dom.container.querySelectorAll('button')].find(button => button.textContent?.includes('Check status'))!
    await act(async () => check.click())
    expect(dom.container.textContent).toContain('Observation disconnected')
    expect(dom.container.querySelector('[aria-label="Shared terminal input"]')).not.toBeNull()
    await dom.render(<></>)
    expect(reading.dispose).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled()
  })
  it('accepts only the latest same-Run metadata read when replies arrive out of order', async () => {
    observe(running())
    const original = session(), refresh = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(original)
    await dom.render(<UserToolkitResult definition={definition()} active close={vi.fn()} />)
    let older!: (value: SessionSnapshot) => void, newer!: (value: SessionSnapshot) => void
    refresh.mockImplementationOnce(() => new Promise(resolve => { older = resolve })).mockImplementationOnce(() => new Promise(resolve => { newer = resolve }))
    const read = terminal.mock.lastCall![0].onRefreshSession
    let first!: Promise<SessionSnapshot>, second!: Promise<SessionSnapshot>
    await act(async () => { first = read(original.control); second = read(original.control) })
    const ended = { ...original, processState: 'exited' as const, status: { state: 'done' as const, source: 'run-process' as const, observedAt: fixtureEpoch(2) } }
    await act(async () => { newer(ended); await second })
    expect(terminal.mock.lastCall![0].session.processState).toBe('exited')
    await act(async () => { older(original); await first })
    expect(terminal.mock.lastCall![0].session.processState).toBe('exited')
  })
  it('retires a pending Check status with its original TUI view', async () => {
    const reading = observe(running())
    const refresh = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session())
    await dom.render(<UserToolkitResult definition={definition()} active />)
    const reconnect = vi.fn(async () => {})
    const register = terminal.mock.lastCall![0].onObservationRefresh
    register(reconnect)
    let release!: (value: ToolkitScriptSnapshot) => void
    vi.mocked(api.toolkit.get).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Check status"]')!.click())
    await dom.render(<></>)
    register(null)
    await act(async () => { release(running()) })
    expect(reading.dispose).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce(); expect(reconnect).not.toHaveBeenCalled()
  })
  it('does not redirect a pending Check status to a replacement Run', async () => {
    const reading = observe(running())
    const original = session(), refresh = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(original)
    await dom.render(<UserToolkitResult definition={definition()} active />)
    const previous = vi.fn(async () => {}), replacement = vi.fn(async () => {})
    terminal.mock.lastCall![0].onObservationRefresh(previous)
    let release!: (value: ToolkitScriptSnapshot) => void
    vi.mocked(api.toolkit.get).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Check status"]')!.click())
    const next = running()
    next.admission = { ...next.admission!, run: { hostId: 'local', runId: 'replacement-run' } }
    refresh.mockResolvedValue({ ...original, id: 'replacement-run', control: { kind: 'terminal', hostId: 'local', runId: 'replacement-run', run: { runId: 'replacement-run' } } })
    await act(async () => reading.publish(next))
    terminal.mock.lastCall![0].onObservationRefresh(replacement)
    await act(async () => { release(next) })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(previous).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled()
  })
  it('keeps an ordinary captured result in its original presenter when the saved mode changes to TUI', async () => {
    const original = definition('script')
    delete original.mode
    const value: ToolkitScriptSnapshot = { ...running(), definition: definition(), admission: null, state: 'succeeded', latestConfirmed: {
      executionId: 'script-execution', invocationId: 'script-invocation', definition: original, expectedLatestExecutionId: null, target: { workspacePath: original.workspacePath }, run: { hostId: 'local', runId: 'script-run' }, startedAt: fixtureEpoch(1), endedAt: fixtureEpoch(1), text: 'Original script result', state: 'succeeded', reason: null, exitCode: 0
    } }
    observe(value)
    const refresh = vi.spyOn(api.sessions, 'refresh')
    await dom.render(<UserToolkitResult definition={value.definition} active close={vi.fn()} />)
    expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe('Original script result')
    expect(terminal).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled()
  })
  it('offers an explicit start after loading failed before execution admission', async () => {
    const value: ToolkitScriptSnapshot = { ...running(), state: 'idle', admission: null,
      reason: 'TUI loading was not admitted: configuration changed.' }
    observe(value)
    const run = vi.spyOn(api.toolkit, 'run').mockResolvedValue(value)
    await dom.render(<UserToolkitResult definition={value.definition} active close={vi.fn()} />)
    expect(dom.container.textContent).toContain(value.reason)
    const start = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Start')!
    expect(start.disabled).toBe(false)
    await act(async () => start.click())
    expect(run).toHaveBeenCalledWith(value.toolId, { invocationId: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{12}$/u),
      expectedRevision: value.definition.revision, expectedLatestExecutionId: null })
  })
  it('keeps an exact Stop action reachable from settings after hiding the tool', async () => {
    const value = { ...running(), definition: { ...definition(), enabled: false } }
    observe(value)
    const stop = vi.spyOn(api.toolkit, 'stop').mockResolvedValue(value)
    const run = vi.spyOn(api.toolkit, 'run'), refresh = vi.spyOn(api.sessions, 'refresh')
    await dom.render(<TuiToolkitSettings definition={value.definition} active />)
    const button = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Stop')!
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(stop).toHaveBeenCalledWith(value.toolId, 'original-execution')
    expect(run).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(terminal).not.toHaveBeenCalled()
  })
  it('leaves Escape and focus with the interactive terminal inside the popover', async () => {
    const input = vi.fn(), outside = vi.fn()
    document.addEventListener('keydown', outside)
    function Consumer() {
      const [selected, select] = useState<string | symbol | null>(null)
      return <ToolkitPopover toolId="local-tui" name="Local terminal" icon={<span />} selectedToolId={selected} onSelectTool={select}>{close => <><button data-toolkit-close onClick={close}>Close terminal</button><div data-toolkit-terminal><textarea aria-label="Terminal input" onKeyDown={event => { if (event.key === 'Escape') input() }} /></div></>}</ToolkitPopover>
    }
    await dom.render(<Consumer />); await dom.click('[data-toolkit-id="local-tui"]')
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Terminal input"]')!
    field.focus()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => field.dispatchEvent(event))
    expect(input).toHaveBeenCalledOnce(); expect(event.defaultPrevented).toBe(false)
    expect(outside).not.toHaveBeenCalled()
    document.removeEventListener('keydown', outside)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull(); expect(document.activeElement).toBe(field)
  })
  it('saves an explicit TUI command from the editor without a second renderer launch', async () => {
    const add = vi.fn(async (id, value) => ({ ...value, id, revision: 'saved-tui' }))
    const run = vi.fn()
    vi.spyOn(api.toolkit, 'observe').mockReturnValue({ dispose: vi.fn() })
    await dom.render(<ToolkitSettingsPane tools={[]} active performance={{ enabled: true, statusBar: 'icon' }} writer={{ add, update: vi.fn() }} onSave={vi.fn()} onRemoveTool={vi.fn()} onRunTool={run} />)
    await dom.click('.toolkit-workbench__toolbar .toolkit-workbench__create')
    await dom.click('input[value="tui"]')
    expect(dom.container.querySelector('[aria-label="Evaluate when displayed"]')).toBeNull()
    expect(dom.container.querySelector('[aria-label="Shell command"]')).not.toBeNull()
    const name = dom.container.querySelector<HTMLInputElement>('.toolkit-editor__name input')!
    const directory = dom.container.querySelector<HTMLInputElement>('.toolkit-editor__directory input')!
    await act(async () => {
      for (const [node, value] of [[name, 'Interactive shell'], [directory, fixturePath('toolkit')]] as const) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
        node.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await dom.click('.toolkit-editor .primary-button')
    expect(add).toHaveBeenCalledOnce()
    expect(add.mock.calls[0]?.[1]).toMatchObject({ mode: 'tui', script: 'exec /bin/sh\n', actions: [] })
    expect(add.mock.calls[0]?.[1]).not.toHaveProperty('display')
    expect(run).not.toHaveBeenCalled()
  })
})
