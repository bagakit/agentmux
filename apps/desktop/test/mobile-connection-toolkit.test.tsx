import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { fixturePath as hygieneFixturePath } from '../scripts/lib/fixture-values.mjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolkitAdmission, ToolkitConfirmedResult, ToolkitScriptSnapshot, ToolkitToolDefinition, ToolkitResultDocument, ToolkitRunInput } from '@agentmux/core/control'
import { MobileConnectionResult } from '../src/renderer/src/components/toolkit/MobileConnectionResult'
import { ToolkitStatusBar } from '../src/renderer/src/components/toolkit/ToolkitStatusBar'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { MOBILE_CONNECTION_TOOL_ID } from '../src/shared/toolkit-preferences'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const originalURL = 'http://192.0.2.12:8443/#offer=original-complete-offer'
const currentURL = 'http://192.0.2.24:8443/#offer=current-complete-offer'
const definition: ToolkitToolDefinition = { id: MOBILE_CONNECTION_TOOL_ID, revision: 'original-version', name: 'Phone connection', icon: 'smartphone', enabled: true,
  statusBar: 'icon', workspacePath: hygieneFixturePath('tmp/phone'), script: 'status()', args: [], display: { script: 'currentConnection()', args: [] },
  actions: [{ id: 'link', label: 'Generate connection link', script: 'link()', args: [] }] }
const connectionDocument = (url: string | null, devices = [{ label: 'My phone', value: 'Connected' }]): ToolkitResultDocument => ({ schema: 'agentmux.toolkit.result.v1', summary: '1 authorized', items: devices, links: url ? [{ label: 'Phone connection link', url }] : [], notice: 'Connect both devices to the same Wi-Fi.' })
function result(invocationId = 'previous-request', url: string | null = originalURL): ToolkitConfirmedResult {
  return { executionId: 'execution-' + invocationId, invocationId, definition, expectedLatestExecutionId: null, action: null,
    target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'run-' + invocationId }, startedAt: _reshape_fixtureEpoch(0, 0, 1), endedAt: _reshape_fixtureEpoch(0, 0, 2), state: 'succeeded', reason: null, exitCode: 0, document: connectionDocument(url), text: 'Native diagnostic on the terminal stream\n' + JSON.stringify(connectionDocument(url)) }
}
function unknown(): ToolkitAdmission {
  const { endedAt: _end, exitCode: _exit, document: _document, ...base } = result('original-unknown')
  return { ...base, run: null, text: '', state: 'unknown', reason: 'Execution restored; exact Run outcome needs confirmation.',
    action: { id: 'link', sourceExecutionId: 'execution-previous-request', expectedAdmissionExecutionId: null } }
}
function fixture(change: Partial<ToolkitScriptSnapshot> = {}) {
  let current: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'succeeded', reason: null,
    admission: null, latestConfirmed: result(), consumerCount: 1, sequence: 1,
    display: { state: 'succeeded', reason: null, admission: null, latestConfirmed: result('display-current', currentURL), sequence: 1 }, ...change }
  let listener: (value: ToolkitScriptSnapshot) => void = () => {}
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const dispose = vi.fn()
  const observe = vi.spyOn(api.toolkit, 'observe').mockImplementation((id, read) => { expect(id).toBe(definition.id); listener = read; read(current); return { dispose } })
  const get = vi.spyOn(api.toolkit, 'get').mockImplementation(async () => current)
  const run = vi.spyOn(api.toolkit, 'run').mockImplementation(async () => current)
  const action = vi.spyOn(api.toolkit, 'action').mockImplementation(async () => current)
  const evaluate = vi.spyOn(api.toolkit, 'evaluate').mockImplementation(async () => current)
  return { clipboard, get, run, action, evaluate, observe, dispose, current: () => current,
    async publish(change: Partial<ToolkitScriptSnapshot>) { current = { ...current, ...change, sequence: current.sequence + 1 }; await act(async () => listener(current)) },
    complete(url: string) { current = { ...current, display: { state: 'succeeded', reason: null, admission: null, latestConfirmed: result('display-refreshed', url), sequence: current.display!.sequence + 1 }, sequence: current.sequence + 1 }; listener(current); return current } }
}
async function render(generic = false, extra: { copyOnRun?: boolean; primaryActionId?: string } = {}) {
  await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn() }}>
    {generic ? <UserToolkitResult definition={definition} active close={() => {}} {...extra} /> : <MobileConnectionResult active close={() => {}} />}
  </SettingsNavigation.Provider>)
}
function button(label: string) {
  const node = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  expect(node, label).toBeDefined(); return node!
}
async function click(label: string) { await act(async () => button(label).click()) }
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }) })

describe('phone Toolkit consumes the independent display program', () => {
  it.each(['', 'Native bridge diagnostic\n', 'Warning: native logger unavailable\nDebug: using the original process\n'])('uses the typed document independently of terminal diagnostics %j', async diagnostics => {
    const confirmed = { ...result('display-diagnostics', currentURL), text: diagnostics + JSON.stringify(connectionDocument(originalURL)) }
    const f = fixture({ display: { state: 'succeeded', reason: null, admission: null, latestConfirmed: confirmed, sequence: 2 } })
    await render(); await click('Copy shown link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(currentURL)
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(currentURL)
    expect(dom.container.querySelector('svg[role="img"]')).not.toBeNull()
    expect(dom.container.textContent).not.toContain('Current connection details are unavailable')
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled()
  })
  it.each(['missing', 'unavailable'] as const)('keeps a typed saved QR and original time after a fresh mount with a %s machine result', async kind => {
    const saved = { ...result('saved-machine-document', currentURL), endedAt: _reshape_fixtureEpoch(0, 0, 1234) }
    const { document: _document, ...plain } = result('current-no-document', originalURL)
    const latest = kind === 'missing' ? plain : { ...plain, document: null, reason: 'Authenticated machine document was invalid' }
    const f = fixture({ display: { state: 'succeeded', reason: latest.reason, admission: null, latestConfirmed: latest, lastSucceeded: saved, sequence: 3 } })
    for (let mount = 0; mount < 2; mount++) {
      await render(); await click('Copy shown link')
      expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(currentURL)
      expect(dom.container.querySelector('.phone-connection__updated time')?.getAttribute('datetime')).toBe(new Date(saved.endedAt).toISOString())
      expect(dom.container.textContent).toContain('Saved code · current details not confirmed')
      expect(dom.container.querySelector('.phone-connection__service')?.textContent).toContain('Current connection details are unavailable')
      expect(button('Retry connection').disabled).toBe(false)
      await dom.render(<p>Closed</p>)
    }
    expect(f.clipboard.mock.calls).toEqual([[currentURL], [currentURL]])
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled()
  })
  it('shows a retryable service window for a successful plain JSON-looking result without interpreting its URL', async () => {
    const { document: _document, ...plain } = result('plain-json-looking', currentURL)
    fixture({ latestConfirmed: plain, display: { state: 'succeeded', reason: null, admission: null, latestConfirmed: plain, sequence: 1 } })
    await render()
    expect(dom.container.querySelector('svg[role="img"]')).toBeNull()
    expect(dom.container.querySelector('.phone-connection__service')?.textContent).toContain('Current connection details are unavailable')
    expect(button('Retry connection').disabled).toBe(false)
    expect(dom.container.querySelector('textarea')).toBeNull()
  })
  it('keeps clipboard failure with Copy instead of declaring current connection unavailable', async () => {
    const f = fixture(); f.clipboard.mockRejectedValue(new Error('clipboard is locked'))
    await render(); await click('Copy shown link')
    expect(dom.container.textContent).toContain('Could not copy the link')
    expect(dom.container.textContent).not.toContain('Current connection details are unavailable')
    expect(button('Refresh').disabled).toBe(false)
    expect(f.evaluate).not.toHaveBeenCalled()
  })
  it('keeps original request continuation failure with its old service window', async () => {
    const f = fixture({ state: 'unknown', admission: unknown(), reason: 'Original receipt unconfirmed' })
    f.action.mockRejectedValue(new Error('original request confirmation unavailable'))
    await render(); await click('Continue original request')
    expect(dom.container.querySelector('[data-toolkit-previous-request]')?.textContent).toContain('original request confirmation unavailable')
    expect(dom.container.textContent).not.toContain('Current connection details are unavailable')
    expect(button('Refresh').disabled).toBe(false)
    expect(f.evaluate).not.toHaveBeenCalled()
  })
  it('opens the production status bar entry with display evaluation opt-in and no ordinary action or clipboard change', async () => {
    const f = fixture()
    useAppStore.setState({ config: { ...composerConfig, toolkit: { tools: [], performance: { enabled: false }, mobileConnection: { enabled: true } } } })
    await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn() }}><div className="window-status-bar"><ToolkitStatusBar /></div></SettingsNavigation.Provider>)
    const entry = dom.container.querySelector<HTMLButtonElement>('[data-toolkit-id="builtin:mobile-connection"]')!
    expect(entry).not.toBeNull(); await act(async () => entry.click())
    expect(document.querySelector('[role="dialog"][aria-label="Phone connection"]')).not.toBeNull()
    expect(document.querySelector('svg[role="img"] title')?.textContent).toBe('Phone connection QR code')
    expect(f.observe).toHaveBeenCalledWith(definition.id, expect.any(Function), expect.any(Function), { evaluateOnDisplay: true })
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled(); expect(f.clipboard).not.toHaveBeenCalled()
  })
  it('copies the explicitly shown full URL from details without evaluating or generating another link', async () => {
    const f = fixture(); await render(); await click('Copy shown link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(currentURL)
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(currentURL)
    expect(dom.container.querySelector('svg[role="img"]')).not.toBeNull()
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled()
  })
  it('refreshes current QR and devices through evaluate while keeping the original unknown request intact', async () => {
    const admission = unknown(), f = fixture({ state: 'unknown', reason: admission.reason, admission })
    f.evaluate.mockImplementation(async () => f.complete(originalURL))
    await render(); expect(button('Refresh').disabled).toBe(false); await click('Refresh')
    expect(f.evaluate).toHaveBeenCalledExactlyOnceWith(definition.id)
    expect(f.current().admission).toBe(admission); expect(f.current().state).toBe('unknown')
    expect(dom.container.querySelector('[data-toolkit-previous-request] summary')?.textContent).toContain('Previous link request is unconfirmed')
    expect(dom.container.querySelector('[data-toolkit-previous-request]')?.hasAttribute('open')).toBe(false)
    expect(dom.container.textContent).not.toContain('current details not confirmed')
    expect(f.clipboard).not.toHaveBeenCalled(); await click('Copy shown link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(originalURL); expect(f.action).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })
  it.each([false, true])('continues only the original ordinary request, generic=%s, while current display copying stays available', async generic => {
    const admission = unknown(), f = fixture({ state: 'unknown', reason: admission.reason, admission })
    await render(generic)
    if (!generic) { await click('Copy shown link'); expect(f.clipboard).toHaveBeenCalledWith(currentURL) }
    if (generic) {
      await act(async () => { const more = button('More'); more.focus(); more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
      expect(dom.container.querySelector('[role="menu"]')).not.toBeNull()
    }
    await click('Continue original request')
    expect(f.action).toHaveBeenCalledExactlyOnceWith(definition.id, 'link', { invocationId: admission.invocationId, expectedRevision: definition.revision,
      sourceExecutionId: admission.action!.sourceExecutionId, expectedAdmissionExecutionId: null })
    expect(f.run).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled()
  })
  it('makes an unknown display request retryable without inventing a new invocation in Renderer', async () => {
    const f = fixture({ display: { state: 'unknown', reason: 'display-receipt-unavailable', admission: { ...unknown(), action: null }, latestConfirmed: result('display-current', currentURL), sequence: 2 } })
    await render(); expect(button('Refresh').disabled).toBe(false); await click('Refresh')
    expect(f.evaluate).toHaveBeenCalledExactlyOnceWith(definition.id)
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled()
  })
  it('retains durable last successful display code and time when mounted after a failed evaluation', async () => {
    const saved = { ...result('saved-display', currentURL), endedAt: _reshape_fixtureEpoch(0, 0, 1234) }, failed = { ...result('failed-display', null), state: 'failed' as const, reason: 'current-display-failed', exitCode: 1, endedAt: _reshape_fixtureEpoch(0, 0, 2345) }
    const f = fixture({ display: { state: 'failed', reason: failed.reason, admission: null, latestConfirmed: failed, lastSucceeded: saved, sequence: 3 } })
    await render(); await click('Copy shown link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(currentURL)
    expect(dom.container.querySelector('.phone-connection__updated time')?.getAttribute('datetime')).toBe(new Date(saved.endedAt).toISOString())
    expect(dom.container.textContent).toContain('current-display-failed'); expect(dom.container.textContent).toContain('Saved code · current details not confirmed')
    expect(button('Refresh').disabled).toBe(false)
  })
  it('keeps the code readable and copyable after a read gap and allows an explicit display retry', async () => {
    const f = fixture(); await render()
    f.get.mockRejectedValueOnce(new Error('observation-offline'))
    f.evaluate.mockRejectedValueOnce(new Error('display-unavailable'))
    await click('Refresh'); await click('Copy shown link')
    expect(f.clipboard).toHaveBeenCalledWith(currentURL)
    expect(dom.container.textContent).toContain('observation-offline'); expect(button('Refresh').disabled).toBe(false)
  })
  it('does not renew display observation on an ordinary parent rerender and releases it on close', async () => {
    const f = fixture(); await render(); await render()
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.evaluate).not.toHaveBeenCalled()
    await dom.render(<p>Closed</p>); expect(f.dispose).toHaveBeenCalledOnce()
    await render(); expect(f.observe).toHaveBeenCalledTimes(2)
  })
  it('generic display links copy the displayed URL even with legacy primary action preferences', async () => {
    const f = fixture(); await render(true, { copyOnRun: true, primaryActionId: 'link' })
    await click('Copy Phone connection link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(currentURL)
    expect(f.action).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled()
  })
  it('generic display refresh and configured actions keep distinct display and ordinary result baselines', async () => {
    const f = fixture(); await render(true); await click('Refresh display')
    expect(f.evaluate).toHaveBeenCalledExactlyOnceWith(definition.id)
    await click('Generate connection link')
    expect(f.action).toHaveBeenCalledExactlyOnceWith(definition.id, 'link', { invocationId: expect.any(String), expectedRevision: definition.revision,
      sourceExecutionId: 'execution-previous-request', expectedAdmissionExecutionId: null })
    expect(f.run).not.toHaveBeenCalled()
  })
})

function freshResult(input: ToolkitRunInput, url = originalURL): ToolkitConfirmedResult {
  return { ...result(input.invocationId, url), expectedLatestExecutionId: input.expectedLatestExecutionId }
}
async function beginFresh(f: ReturnType<typeof fixture>, input: ToolkitRunInput) {
  const { endedAt: _ended, exitCode: _exit, document: _document, ...execution } = freshResult(input)
  await f.publish({ display: { ...f.current().display!, state: 'running', admission: { ...execution, state: 'running', reason: null } } })
  return f.current()
}
async function finishFresh(f: ReturnType<typeof fixture>, value: ToolkitConfirmedResult) {
  await f.publish({ display: { state: value.state, reason: value.reason, admission: null, latestConfirmed: value, sequence: f.current().display!.sequence + 1 } })
}

describe('explicit current phone link copy', () => {
  it('waits for its exact fresh display execution before copying the same new code and full URL', async () => {
    const f = fixture()
    f.evaluate.mockImplementation(async (_id, input) => beginFresh(f, input!))
    await render(); await click('Refresh & copy link')
    const input = f.evaluate.mock.calls[0]![1]!
    expect(input).toEqual({ invocationId: expect.any(String), expectedRevision: definition.revision, expectedLatestExecutionId: 'execution-display-current' })
    expect(input.invocationId).not.toBe('display-current')
    expect(f.clipboard).not.toHaveBeenCalled()
    expect(button('Reading current link…').disabled).toBe(true)
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(currentURL)
    await f.publish({ display: { ...f.current().display!, latestConfirmed: result('unrelated-display', originalURL) } })
    expect(f.clipboard).not.toHaveBeenCalled()
    await finishFresh(f, freshResult(input))
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(originalURL)
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(originalURL)
    expect(dom.container.querySelector('svg[role="img"]')).not.toBeNull()
    expect(dom.container.textContent).toContain('Current connection link copied.')
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled()
  })

  it.each(['failed', 'stopped', 'missing-document', 'different-execution', 'different-target', 'different-version'] as const)
  ('retains the shown original link without copying an unusable fresh result: %s', async kind => {
    const f = fixture(); f.evaluate.mockImplementation(async (_id, input) => beginFresh(f, input!))
    await render(); await click('Refresh & copy link')
    const value = freshResult(f.evaluate.mock.calls[0]![1]!)
    if (kind === 'failed' || kind === 'stopped') Object.assign(value, { state: kind, reason: 'Original fresh lookup failed', document: null })
    if (kind === 'missing-document') value.document = null
    if (kind === 'different-execution') value.executionId = 'another-execution'
    if (kind === 'different-target') value.target = { workspacePath: '/different-original-target' }
    if (kind === 'different-version') value.definition = { ...definition, revision: 'different-version' }
    await finishFresh(f, value)
    expect(f.clipboard).not.toHaveBeenCalled()
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(currentURL)
    expect(dom.container.textContent).not.toContain('Current connection link copied.')
    await click('Copy shown link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith((dom.container.querySelector('textarea') as HTMLTextAreaElement).value)
    expect(f.evaluate).toHaveBeenCalledTimes(1); expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled()
  })

  it.each(['close', 'revision', 'saved-copy'] as const)('does not late-copy after the original intent changes: %s', async change => {
    const f = fixture(); f.evaluate.mockImplementation(async (_id, input) => beginFresh(f, input!))
    await render(); await click('Refresh & copy link')
    const input = f.evaluate.mock.calls[0]![1]!
    if (change === 'close') await dom.render(<p>Closed</p>)
    if (change === 'revision') await f.publish({ definition: { ...definition, revision: 'changed-revision' } })
    if (change === 'saved-copy') await click('Copy shown link')
    await finishFresh(f, freshResult(input))
    expect(f.clipboard.mock.calls).toEqual(change === 'saved-copy' ? [[currentURL]] : [])
    expect(f.evaluate).toHaveBeenCalledOnce()
  })

  it('pins the latest display terminal baseline instead of the last successful QR or ordinary result', async () => {
    const failed = { ...result('failed-display', null), state: 'failed' as const, reason: 'Original failed read' }
    const f = fixture({ display: { state: 'failed', reason: failed.reason, admission: null, latestConfirmed: failed, lastSucceeded: result('older-success', currentURL), sequence: 3 } })
    f.evaluate.mockImplementation(async (_id, input) => beginFresh(f, input!))
    await render(); await click('Refresh & copy link')
    expect(f.evaluate.mock.calls[0]![1]).toMatchObject({ expectedLatestExecutionId: failed.executionId })
    expect(f.clipboard).not.toHaveBeenCalled()
  })
})

it('replaces a previous refresh failure with the exact successful fresh-copy observation', async () => {
  const f = fixture(); f.evaluate.mockRejectedValueOnce(new Error('Previous original refresh failed'))
  await render(); await click('Refresh')
  expect(dom.container.textContent).toContain('Previous original refresh failed')
  f.evaluate.mockImplementation(async (_id, input) => beginFresh(f, input!))
  await click('Refresh & copy link')
  await finishFresh(f, freshResult(f.evaluate.mock.calls[1]![1]!))
  expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(originalURL)
  expect(dom.container.textContent).not.toContain('Current connection details are unavailable')
  expect(dom.container.textContent).not.toContain('Previous original refresh failed')
  expect(dom.container.textContent).not.toContain('Saved code · current details not confirmed')
})
