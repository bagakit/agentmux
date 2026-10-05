import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { fixturePath as hygieneFixturePath } from '../scripts/lib/fixture-values.mjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolkitAdmission, ToolkitConfirmedResult, ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
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
const text = (url: string | null, devices = [{ label: 'My phone', value: 'Online' }]) => JSON.stringify({ schema: 'agentmux.toolkit.result.v1', summary: '1 authorized', items: devices, links: url ? [{ label: 'Phone connection link', url }] : [], notice: 'Connect both devices to the same Wi-Fi.' })
function result(invocationId = 'previous-request', url: string | null = originalURL): ToolkitConfirmedResult {
  return { executionId: 'execution-' + invocationId, invocationId, definition, expectedLatestExecutionId: null, action: null,
    target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'run-' + invocationId }, startedAt: _reshape_fixtureEpoch(0, 0, 1), endedAt: _reshape_fixtureEpoch(0, 0, 2), state: 'succeeded', reason: null, exitCode: 0, text: text(url) }
}
function unknown(): ToolkitAdmission {
  const { endedAt: _end, exitCode: _exit, ...base } = result('original-unknown')
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
  it('keeps clipboard failure with Copy instead of declaring current connection unavailable', async () => {
    const f = fixture(); f.clipboard.mockRejectedValue(new Error('clipboard is locked'))
    await render(); await click('Copy link')
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
  it('copies the display confirmed full URL used by the code without evaluating or generating another link', async () => {
    const f = fixture(); await render(); await click('Copy link')
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
    expect(f.clipboard).not.toHaveBeenCalled(); await click('Copy link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(originalURL); expect(f.action).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })
  it.each([false, true])('continues only the original ordinary request, generic=%s, while current display copying stays available', async generic => {
    const admission = unknown(), f = fixture({ state: 'unknown', reason: admission.reason, admission })
    await render(generic)
    if (!generic) { await click('Copy link'); expect(f.clipboard).toHaveBeenCalledWith(currentURL) }
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
    await render(); await click('Copy link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(currentURL)
    expect(dom.container.querySelector('.phone-connection__updated time')?.getAttribute('datetime')).toBe(new Date(saved.endedAt).toISOString())
    expect(dom.container.textContent).toContain('current-display-failed'); expect(dom.container.textContent).toContain('Saved code · current details not confirmed')
    expect(button('Refresh').disabled).toBe(false)
  })
  it('keeps the code readable and copyable after a read gap and allows an explicit display retry', async () => {
    const f = fixture(); await render()
    f.get.mockRejectedValueOnce(new Error('observation-offline'))
    f.evaluate.mockRejectedValueOnce(new Error('display-unavailable'))
    await click('Refresh'); await click('Copy link')
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
