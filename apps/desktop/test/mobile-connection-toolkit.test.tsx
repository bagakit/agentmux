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
  statusBar: 'icon', workspacePath: hygieneFixturePath('tmp/phone'), script: 'status()', args: [], actions: [{ id: 'link', label: 'Generate connection link', script: 'link()', args: [] }] }
const text = (url: string | null, devices = [{ label: 'My phone', value: 'Online' }]) => JSON.stringify({ schema: 'agentmux.toolkit.result.v1', summary: '1 online · 1 authorized', items: devices, links: url ? [{ label: 'Phone connection link', url }] : [], notice: 'Connect both devices to the same Wi-Fi.' })
function result(invocationId = 'previous-request', url: string | null = originalURL): ToolkitConfirmedResult {
  return { executionId: 'execution-' + invocationId, invocationId, definition, expectedLatestExecutionId: null, action: null,
    target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'run-' + invocationId }, startedAt: _reshape_fixtureEpoch(0, 0, 1), endedAt: _reshape_fixtureEpoch(0, 0, 2), state: 'succeeded', reason: null, exitCode: 0, text: text(url) }
}
function fixture() {
  let current: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'succeeded', reason: null,
    admission: null, latestConfirmed: result(), consumerCount: 1, sequence: 1 }
  let listener: (value: ToolkitScriptSnapshot) => void = () => {}
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const dispose = vi.fn()
  vi.spyOn(api.toolkit, 'observe').mockImplementation((id, read) => { expect(id).toBe(definition.id); listener = read; read(current); return { dispose } })
  const get = vi.spyOn(api.toolkit, 'get').mockImplementation(async () => current)
  const run = vi.spyOn(api.toolkit, 'run').mockImplementation(async () => current)
  const action = vi.spyOn(api.toolkit, 'action').mockImplementation(async () => current)
  return { clipboard, get, run, action, dispose, current: () => current,
    async publish(change: Partial<ToolkitScriptSnapshot>) { current = { ...current, ...change, sequence: current.sequence + 1 }; await act(async () => listener(current)) },
    complete(invocationId: string, url: string | null) { current = { ...current, latestConfirmed: result(invocationId, url), admission: null, state: 'succeeded', sequence: current.sequence + 1 }; listener(current); return current } }
}
async function render(generic = false) {
  await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn() }}>
    {generic ? <UserToolkitResult definition={definition} active close={() => {}} /> : <MobileConnectionResult active close={() => {}} />}
  </SettingsNavigation.Provider>)
}
async function click(label: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  expect(button, label).toBeDefined(); await act(async () => button!.click())
}
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }) })

describe('phone Toolkit consumes original scripts and exact connection results', () => {
  it('opens the production status bar entry without executing a script or changing authorization', async () => {
    const f = fixture()
    useAppStore.setState({ config: { ...composerConfig, toolkit: { tools: [], performance: { enabled: false }, mobileConnection: { enabled: true } } } })
    await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn() }}><div className="window-status-bar"><ToolkitStatusBar /></div></SettingsNavigation.Provider>)
    const entry = dom.container.querySelector<HTMLButtonElement>('[data-toolkit-id="builtin:mobile-connection"]')!
    expect(entry).not.toBeNull(); await act(async () => entry.click())
    expect(document.querySelector('[role="dialog"][aria-label="Phone connection"]')).not.toBeNull()
    expect(document.querySelector('svg[role="img"] title')?.textContent).toBe('Phone connection QR code')
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled(); expect(f.clipboard).not.toHaveBeenCalled()
  })
  it('copies the same confirmed full URL as the displayed code without generating another link', async () => {
    const f = fixture(); await render(); await click('Copy link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(originalURL)
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(originalURL)
    expect(dom.container.querySelector('svg[role="img"]')).not.toBeNull()
    expect(f.run).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled()
  })
  it('explicitly generates a new code through the saved action and then copies its exact result', async () => {
    const f = fixture(); f.action.mockImplementation(async (_id, _action, input) => f.complete(input.invocationId, currentURL))
    await render(); await click('New code')
    expect(f.action).toHaveBeenCalledExactlyOnceWith(definition.id, 'link', { invocationId: expect.any(String), expectedRevision: definition.revision,
      sourceExecutionId: 'execution-previous-request', expectedAdmissionExecutionId: null })
    expect(f.clipboard).not.toHaveBeenCalled(); await click('Copy link')
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(currentURL); expect(f.action).toHaveBeenCalledOnce()
  })
  it('keeps the displayed code while refreshing original device facts', async () => {
    const f = fixture(); f.run.mockImplementation(async (_id, input) => f.complete(input.invocationId, null))
    await render(); await click('Refresh devices'); await click('Copy link')
    expect(f.run).toHaveBeenCalledOnce(); expect(f.clipboard).toHaveBeenCalledWith(originalURL)
    expect((dom.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(originalURL)
  })
  it.each([false, true])('continues an unbound original request with exact identities, generic=%s, and keeps saved copy available', async generic => {
    const f = fixture(), prior = result('original-unknown')
    const { endedAt: _end, exitCode: _exit, ...base } = prior
    const admission: ToolkitAdmission = { ...base, run: null, text: '', state: 'unknown', reason: 'Execution restored; exact Run outcome needs confirmation.',
      action: { id: 'link', sourceExecutionId: 'execution-previous-request', expectedAdmissionExecutionId: null } }
    await render(generic); await f.publish({ state: 'unknown', reason: admission.reason, admission })
    expect(dom.container.textContent).toContain('the script may run now')
    expect(f.action).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
    if (!generic) { await click('Copy link'); expect(f.clipboard).toHaveBeenCalledWith(originalURL) }
    await click('Continue original request')
    expect(f.action).toHaveBeenCalledExactlyOnceWith(definition.id, 'link', { invocationId: admission.invocationId, expectedRevision: definition.revision,
      sourceExecutionId: admission.action!.sourceExecutionId, expectedAdmissionExecutionId: null })
    expect(f.run).not.toHaveBeenCalled()
  })
  it('keeps the saved connection readable and copyable after an observation failure', async () => {
    const f = fixture(); await render(); f.get.mockRejectedValueOnce(new Error('original-observation-offline'))
    await act(async () => { await f.publish({ state: 'unknown', reason: 'original-observation-offline' }) })
    await click('Copy link'); expect(f.clipboard).toHaveBeenCalledWith(originalURL)
    expect(dom.container.textContent).toContain('Connection request is unconfirmed')
  })
})
