import { openToolkitMenu } from './helpers/toolkit-menu'
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseToolkitSnapshot, type ToolkitScriptSnapshot, type ToolkitSnapshot, type ToolkitToolDefinition } from '@agentmux/core/control'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
const definition: ToolkitToolDefinition = { id: 'motion-result', revision: 'same-definition', name: 'Original result', icon: 'terminal', enabled: true, statusBar: 'icon', workspacePath: fixturePath('motion-tool'), script: 'ordinary()', args: [], display: { script: 'display()', args: [] } }
function snapshot(state: 'running' | 'succeeded' | 'unknown' = 'running'): ToolkitScriptSnapshot {
  const success = { executionId: 'last-confirmed', invocationId: 'confirmed-call', definition, expectedLatestExecutionId: null, target: { workspacePath: definition.workspacePath }, run: { hostId: 'local', runId: 'confirmed-run' }, startedAt: _historyFixtureEpoch(0, 0, 100), endedAt: _historyFixtureEpoch(0, 0, 200), exitCode: 0, state: 'succeeded' as const, reason: null, text: 'Original confirmed output' }
  return parseToolkitSnapshot({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'idle', reason: null, admission: null, latestConfirmed: null, consumerCount: 1, sequence: 1,
    display: { state, reason: null, admission: state === 'succeeded' ? null : { executionId: 'current-display', invocationId: 'current-call', definition, expectedLatestExecutionId: success.executionId, target: success.target, run: state === 'running' ? { hostId: 'local', runId: 'current-run' } : null, startedAt: _historyFixtureEpoch(0, 0, 300), state, reason: null, text: '' }, latestConfirmed: success, sequence: 1 } }) as ToolkitScriptSnapshot
}
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }) })
function view(active = true) { return <SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn() }}><UserToolkitResult definition={definition} active={active} close={vi.fn()} /></SettingsNavigation.Provider> }
function refresh() { const button = [...dom.container.querySelectorAll<HTMLButtonElement>('.performance-actions button')].find(button => /display/.test(button.textContent ?? '')); expect(button, 'real display action').toBeDefined(); return button! }
it('stops the retained running decoration after the real observation onError while keeping output, Run and actions', async () => {
  let ended!: (reason: string) => void
  const release = vi.fn()
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read, onError) => { ended = onError; read(snapshot()); return { dispose: release } })
  const run = vi.spyOn(api.toolkit, 'run'), stop = vi.spyOn(api.toolkit, 'stop')
  await dom.render(view())
  const output = dom.container.querySelector('[data-toolkit-output]')!, button = refresh()
  expect(output.textContent).toBe('Original confirmed output')
  expect(button.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  const beforeDisabled = button.disabled
  await act(async () => ended('Current result observation unavailable'))
  expect(refresh()).toBe(button); expect(button.querySelector('[data-icon-animation="spin"]')).toBeNull()
  expect(dom.container.textContent).toContain('Result unconfirmed')
  expect(dom.container.textContent).toContain('Current result observation unavailable')
  expect(dom.container.querySelector('[data-toolkit-output]')).toBe(output)
  expect(output.textContent).toBe('Original confirmed output')
  expect(button.disabled).toBe(beforeDisabled) // The original displayRunning gate is unchanged.
  await openToolkitMenu(dom.container)
  expect([...dom.container.querySelectorAll<HTMLButtonElement>('.performance-actions button')].find(action => action.textContent?.trim() === 'Run saved tool')?.disabled).toBe(true) // Existing read-error admission rule.
  expect(release).toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})
it('keeps actual local evaluation waiting visible even with a retained observation error, then settles without running or stopping the tool', async () => {
  let ended!: (reason: string) => void, done!: (value: ToolkitSnapshot) => void
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read, onError) => { ended = onError; read(snapshot('succeeded')); return { dispose: vi.fn() } })
  const evaluate = vi.spyOn(api.toolkit, 'evaluate').mockImplementation(() => new Promise(resolve => { done = resolve }))
  vi.spyOn(api.toolkit, 'get').mockResolvedValue(snapshot('succeeded'))
  const run = vi.spyOn(api.toolkit, 'run'), stop = vi.spyOn(api.toolkit, 'stop')
  await dom.render(view())
  await act(async () => ended('Observation ended'))
  const button = refresh(); expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(button.querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  expect(button.disabled).toBe(true)
  await act(async () => done(snapshot('succeeded')))
  expect(button.querySelector('[data-icon-animation="spin"]')).toBeNull()
  expect(evaluate).toHaveBeenCalledExactlyOnceWith(definition.id)
  expect(run).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})
it('a retained but inactive result stays readable and static without stopping its original execution', async () => {
  const stop = vi.spyOn(api.toolkit, 'stop')
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read) => { read(snapshot()); return { dispose: vi.fn() } })
  await dom.render(view()); expect(refresh().querySelector('[data-icon-animation="spin"]')).not.toBeNull()
  await dom.render(view(false)); expect(refresh().querySelector('[data-icon-animation="spin"]')).toBeNull()
  expect(dom.container.querySelector('[data-toolkit-output]')?.textContent).toBe('Original confirmed output')
  expect(stop).not.toHaveBeenCalled()
})
