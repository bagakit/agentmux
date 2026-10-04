import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolkitConfirmedResult, ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const oldURL = 'http://192.0.2.10:4700/mobile/#offer=historical-private-offer'
const currentURL = 'http://192.0.2.44:4700/mobile/#offer=current-private-offer'
const tool: ToolkitToolDefinition = { id: 'connection-example', revision: 'saved-v1', name: 'Connection example',
  icon: 'smartphone', enabled: true, statusBar: 'icon', workspacePath: _hygiene_fixturePath("private/toolkit"), script: 'queryCurrentStatus()', args: [],
  actions: [{ id: 'current-link', label: 'Current link', script: 'readOriginalOwnerLink()', args: [] }] }
const document = (url: string | null) => JSON.stringify({ schema: 'agentmux.toolkit.result.v1', summary: 'Connection link',
  items: [], links: url ? [{ label: 'Connection link', url }] : [], notice: '' })
function result(invocationId: string, url: string | null = currentURL, state: ToolkitConfirmedResult['state'] = 'succeeded', definition = tool): ToolkitConfirmedResult {
  return { executionId: `execution-${invocationId}`, invocationId, definition, expectedLatestExecutionId: null,
    target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: `run-${invocationId}` },
    startedAt: 1, endedAt: 2, exitCode: state === 'succeeded' ? 0 : 1, state, reason: null, text: document(url) }
}
function fixture() {
  let current: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: tool.id, definition: tool,
    state: 'succeeded', reason: null, admission: null, latestConfirmed: result('historical', oldURL), consumerCount: 1, sequence: 1 }
  let publish!: (value: ToolkitScriptSnapshot) => void
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const observe = vi.spyOn(api.toolkit, 'observe').mockImplementation((id, read) => { expect(id).toBe(tool.id); publish = read; read(current); return { dispose: vi.fn() } })
  const get = vi.spyOn(api.toolkit, 'get').mockImplementation(async id => { expect(id).toBe(tool.id); return current })
  const action = vi.spyOn(api.toolkit, 'action').mockImplementation(async () => current)
  const run = vi.spyOn(api.toolkit, 'run').mockImplementation(async () => current)
  return { clipboard, observe, get, action, run, current: () => current,
    publish: async (change: Partial<ToolkitScriptSnapshot>) => { current = { ...current, ...change, sequence: current.sequence + 1 }; await act(async () => publish(current)) } }
}
async function render(copyOnRun = true, primaryActionId: string | undefined = 'current-link') {
  await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn() }}>
    <UserToolkitResult definition={tool} active close={() => {}} copyOnRun={copyOnRun} {...(primaryActionId ? { primaryActionId } : {})} runLabel="Generate & copy link" />
  </SettingsNavigation.Provider>)
}
function copy() { const node = dom.container.querySelector<HTMLButtonElement>('[aria-label="Copy Connection link"]'); expect(node).not.toBeNull(); return node! }
async function pressCopy() { await act(async () => copy().click()) }
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }) })

describe('Toolkit result Copy consumes the current original action receipt', () => {
  it('refreshes a historical URL through primary action and copies only this successful invocation', async () => {
    const f = fixture(); await render()
    await pressCopy()
    expect(f.action).toHaveBeenCalledExactlyOnceWith(tool.id, 'current-link', {
      invocationId: expect.any(String), expectedRevision: tool.revision, sourceExecutionId: 'execution-historical', expectedAdmissionExecutionId: null })
    expect(f.clipboard).not.toHaveBeenCalled()
    expect(copy().disabled).toBe(true)
    expect(dom.container.querySelector('textarea[aria-label="Connection link"]')?.getAttribute('readonly')).not.toBeNull()
    expect((dom.container.querySelector('textarea[aria-label="Connection link"]') as HTMLTextAreaElement).value).toBe(oldURL)
    await f.publish({ latestConfirmed: result('other-invocation') })
    expect(f.clipboard).not.toHaveBeenCalled()
    const invocationId = f.action.mock.calls[0]![2].invocationId
    await f.publish({ latestConfirmed: result(invocationId) })
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(currentURL)
    expect(dom.container.textContent).toContain('Link copied')
    expect(copy().disabled).toBe(false)
    expect(f.run).not.toHaveBeenCalled()
  })

  it.each(['failed', 'stopped'] as const)('does not copy a matched %s result or its old URL', async state => {
    const f = fixture(); await render(); await pressCopy()
    await f.publish({ state, latestConfirmed: result(f.action.mock.calls[0]![2].invocationId, oldURL, state) })
    expect(f.clipboard).not.toHaveBeenCalled()
    expect(dom.container.textContent).not.toContain('Link copied')
    expect(copy().disabled).toBe(false)
    expect(f.action).toHaveBeenCalledOnce()
  })

  it('does not copy a historical URL or replay after an action receipt is unknown', async () => {
    const f = fixture()
    f.action.mockRejectedValueOnce(Object.assign(new Error('Original action receipt unknown'), { code: 'CONTROL_UNAVAILABLE', detail: 'unknown' }))
    await render(); await pressCopy()
    expect(f.clipboard).not.toHaveBeenCalled()
    expect(dom.container.textContent).toContain('Original action receipt unknown')
    expect((dom.container.querySelector('textarea[aria-label="Connection link"]') as HTMLTextAreaElement).value).toBe(oldURL)
    await f.publish({ state: 'unknown', reason: 'Original execution unconfirmed' })
    await pressCopy()
    expect(copy().disabled).toBe(true)
    expect(f.action).toHaveBeenCalledOnce(); expect(f.run).not.toHaveBeenCalled()
    expect(f.clipboard).not.toHaveBeenCalled()
  })

  it('retains historical reading when current action eligibility is withdrawn', async () => {
    const f = fixture(); await render()
    await f.publish({ definition: { ...tool, enabled: false } })
    expect(copy().disabled).toBe(true)
    await pressCopy()
    expect(f.action).not.toHaveBeenCalled(); expect(f.clipboard).not.toHaveBeenCalled()
    expect((dom.container.querySelector('textarea[aria-label="Connection link"]') as HTMLTextAreaElement).value).toBe(oldURL)
  })

  it('keeps ordinary Custom copying its original URL, independent of new action eligibility', async () => {
    const f = fixture(); await render(false)
    await f.publish({ definition: { ...tool, enabled: false }, state: 'unknown' })
    expect(copy().disabled).toBe(false)
    await pressCopy()
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(oldURL)
    expect(f.action).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })

  it('bootstraps the original entry when its captured revision changed and copies only the ensuing current action', async () => {
    const f = fixture(), next = { ...tool, revision: 'saved-v2' }
    await render(); await f.publish({ definition: next }); await pressCopy()
    expect(f.run).toHaveBeenCalledExactlyOnceWith(tool.id, { invocationId: expect.any(String), expectedRevision: next.revision, expectedLatestExecutionId: 'execution-historical' })
    expect(f.action).not.toHaveBeenCalled(); expect(f.clipboard).not.toHaveBeenCalled()
    const entryInvocationId = f.run.mock.calls[0]![1].invocationId
    await f.publish({ latestConfirmed: result(entryInvocationId, null, 'succeeded', next) })
    expect(f.action).toHaveBeenCalledExactlyOnceWith(tool.id, 'current-link', {
      invocationId: expect.any(String), expectedRevision: next.revision, sourceExecutionId: `execution-${entryInvocationId}`, expectedAdmissionExecutionId: null })
    expect(f.clipboard).not.toHaveBeenCalled()
    await f.publish({ latestConfirmed: result(f.action.mock.calls[0]![2].invocationId, currentURL, 'succeeded', next) })
    expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(currentURL)
  })
})
