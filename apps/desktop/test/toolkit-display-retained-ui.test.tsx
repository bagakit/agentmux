import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseToolkitSnapshot } from '@agentmux/core/control'
import type { ToolkitAdmission, ToolkitConfirmedResult, ToolkitScriptSnapshot, ToolkitSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
import { api } from '../src/renderer/src/lib/api'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { composerDOM } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const dom = composerDOM()
const definition: ToolkitToolDefinition = { id: 'retained-display', revision: 'captured-version', name: 'Local status', icon: 'terminal', enabled: true,
  statusBar: 'icon', workspacePath: fixturePath('display-work'), script: 'ordinary()', args: [], display: { script: 'display()', args: [] } }
const success: ToolkitConfirmedResult = { executionId: 'confirmed-display', invocationId: 'confirmed-invocation', definition, expectedLatestExecutionId: null,
  target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'confirmed-run' }, startedAt: _reshape_fixtureEpoch(0, 0, 1_000), endedAt: _reshape_fixtureEpoch(0, 0, 2_000), exitCode: 0,
  state: 'succeeded', reason: null, text: 'Previously confirmed display content' }
const admission: ToolkitAdmission = { executionId: 'original-display', invocationId: 'original-invocation', definition, expectedLatestExecutionId: success.executionId,
  target: success.target, run: null, startedAt: _reshape_fixtureEpoch(0, 0, 120_000), state: 'unknown', reason: 'Creation reply unconfirmed', text: '' }
const snapshot = (): ToolkitScriptSnapshot => ({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition,
  state: 'idle', reason: null, admission: null, latestConfirmed: null, consumerCount: 1, sequence: 1,
  display: { state: 'succeeded', reason: null, admission: null, latestConfirmed: success, sequence: 1 } })
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }) })
async function mount(initial: ToolkitSnapshot) {
  let current = parseToolkitSnapshot(initial), publish!: (value: ToolkitSnapshot) => void
  vi.spyOn(api.toolkit, 'observe').mockImplementation((id, read, _end, options) => {
    expect(id).toBe(definition.id); expect(options).toEqual({ evaluateOnDisplay: true }); publish = read; read(current); return { dispose: vi.fn() }
  })
  vi.spyOn(api.toolkit, 'get').mockImplementation(async () => current)
  const evaluate = vi.spyOn(api.toolkit, 'evaluate').mockImplementation(async () => current)
  const run = vi.spyOn(api.toolkit, 'run'), stop = vi.spyOn(api.toolkit, 'stop')
  await dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn() }}><UserToolkitResult definition={definition} active close={vi.fn()} /></SettingsNavigation.Provider>)
  return { evaluate, run, stop, async update(value: ToolkitSnapshot) { current = parseToolkitSnapshot(value); await act(async () => publish(current)) } }
}
it('retains the confirmed display and its original time throughout a new evaluation and failure', async () => {
  const f = await mount(snapshot())
  const time = () => dom.container.querySelector<HTMLTimeElement>('.performance-observation time')?.dateTime
  expect(time()).toBe(new Date(success.endedAt).toISOString())
  for (const state of ['pending', 'running', 'unknown'] as const) {
    await f.update({ ...snapshot(), sequence: 2, display: { state, reason: null, admission: { ...admission, state, text: state === 'running' ? 'Partial new output' : '' }, latestConfirmed: success, sequence: 2 } })
    expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe(success.text)
    expect(time()).toBe(new Date(success.endedAt).toISOString())
  }
  await f.update({ ...snapshot(), sequence: 3, display: { state: 'failed', reason: 'Current query failed', admission: null,
    latestConfirmed: { ...success, executionId: 'failed-display', endedAt: _reshape_fixtureEpoch(0, 0, 200_000), state: 'failed', exitCode: 1, text: '' }, lastSucceeded: success, sequence: 3 } })
  expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe(success.text)
  expect(time()).toBe(new Date(success.endedAt).toISOString())
  expect(dom.container.textContent).toContain('Current query failed')
  expect(f.run).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
it.each(['package-unavailable', 'declaration-removed', 'disabled'] as const)('continues the retained display through the real component when %s', async mode => {
  const retained = { ...snapshot(), definition: mode === 'declaration-removed' ? { ...definition, display: null } : mode === 'disabled' ? { ...definition, enabled: false } : definition,
    display: { state: 'unknown' as const, reason: admission.reason, admission, latestConfirmed: success, sequence: 2 } }
  const initial: ToolkitSnapshot = mode === 'package-unavailable' ? { schema: 'agentmux.toolkit.v1', kind: 'package-unavailable', toolId: definition.id,
    configuration: { kind: 'package', id: definition.id, revision: 'saved-package', packagePath: fixturePath('missing-package'), args: [], enabled: true, statusBar: 'icon', workspacePath: definition.workspacePath },
    reason: 'Package directory unavailable', retained } : retained
  const f = await mount(initial)
  const button = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('.toolkit-result__actions button')).find(x => x.textContent?.includes('Continue display request'))!
  expect(button).toBeDefined(); expect(button.disabled).toBe(false)
  expect(dom.container.textContent).toContain('If its Run is no longer retained')
  await act(async () => button.click())
  expect(f.evaluate).toHaveBeenCalledExactlyOnceWith(definition.id)
  expect(f.run).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
it('keeps a new display evaluation disabled while the declared package source is unavailable', async () => {
  const retained = snapshot()
  await mount({ schema: 'agentmux.toolkit.v1', kind: 'package-unavailable', toolId: definition.id,
    configuration: { kind: 'package', id: definition.id, revision: 'saved-package', packagePath: fixturePath('missing-package'), args: [], enabled: true, statusBar: 'icon', workspacePath: definition.workspacePath }, reason: 'Package directory unavailable', retained })
  const button = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('.toolkit-result__actions button')).find(x => x.textContent?.includes('Refresh display'))!
  expect(button.disabled).toBe(true)
})
