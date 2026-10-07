import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { split } from 'shlex'
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { HostExecutorSettings } from '../src/renderer/src/components/settings/HostExecutorSettings'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { executorDetectionLabel } from '../src/renderer/src/lib/executor-detection'
import { composerDOM } from './helpers/composer-dom-fixture'
import type { AgentExecutorConfig, AppConfig } from '../src/shared/contracts'

const dom = composerDOM()
let config: AppConfig
beforeEach(async () => {
  config = await api.config.get()
  const providers = await api.providers.list()
  config = { ...config, executors: { wrapper: { label: 'Review wrapper', providerId: providers[0]!.id,
    command: _historyFixturePath("opt/Agent Tools/wrapper"), args: ['--model', 'literal model', '', 'quote"value', '$HOME'], env: {}, injectAgentMuxGuide: true } } }
  useAppStore.setState({ config, providerCatalog: providers, executorDetections: {}, hostExecutorInventories: {},
    detectExecutors: vi.fn(async () => {}), discoverHostExecutors: vi.fn(async () => {}) })
})
async function fill(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  expect(node).not.toBeNull()
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function preview() { return dom.container.querySelector('[aria-label="Configured launch preview"]')! }
it('preview: editable executable and argv are adjacent and round-trip draft boundaries through save', async () => {
  const save = vi.fn(async (_next: Record<string, AgentExecutorConfig>) => {})
  await dom.render(<AgentSettingsPane config={config} onSave={save} />)
  const args = dom.container.querySelector('[aria-label="Executor arguments"]')!
  expect(args.closest('details'), 'Arguments must remain visible beside the executable').toBeNull()
  expect(args.hasAttribute('hidden'), 'Arguments must be visible').toBe(false)
  const argv = [_historyFixturePath("opt/Agent Tools/wrapper"), '--model', 'literal model', '', 'quote"value', '$HOME']
  expect(split(preview().querySelector('code')!.textContent!)).toEqual(argv)
  await fill('[aria-label="Executor arguments"]', '--model "next model" "" "back\\\\slash"')
  expect(split(preview().querySelector('code')!.textContent!)).toEqual([argv[0], '--model', 'next model', '', 'back\\slash'])
  // A whole command in executable remains visibly ONE file name, not an inferred shell line.
  await fill('[aria-label="Executor executable"]', _historyFixturePath("opt/Agent Tools/wrapper --flag"))
  expect(split(preview().querySelector('code')!.textContent!)[0]).toBe(_historyFixturePath("opt/Agent Tools/wrapper --flag"))
  const button = [...dom.container.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Save all executors')!
  await act(async () => button.click())
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ wrapper: expect.objectContaining({
    command: _historyFixturePath("opt/Agent Tools/wrapper --flag"), args: ['--model', 'next model', '', 'back\\slash']
  }) }), config.executors)
})
it('unfinished: preserves incomplete arguments, recovers its preview and never saves on edit', async () => {
  const save = vi.fn(async () => {})
  await dom.render(<AgentSettingsPane config={config} onSave={save} />)
  await fill('[aria-label="Executor arguments"]', '--model "unfinished')
  expect(preview().textContent).toContain('Complete the argument quoting')
  expect(preview().querySelector('code')).toBeNull()
  expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Executor arguments"]')!.value).toBe('--model "unfinished')
  expect(save).not.toHaveBeenCalled()
  await fill('[aria-label="Executor arguments"]', '--model "finished"')
  expect(split(preview().querySelector('code')!.textContent!)).toEqual([_historyFixturePath("opt/Agent Tools/wrapper"), '--model', 'finished'])
})
it('host: registration uses the same literal program and visible arguments in the original API', async () => {
  const register = vi.spyOn(api.executors, 'register').mockImplementation(async (hostId, input) => ({ routeHostId: hostId, runtimeId: 'controlled-runtime', executor: { executorId: input.executorId, label: input.config.label, providerId: input.config.providerId, command: input.config.command, source: 'registered', configRevision: 'captured-revision', availability: 'unknown' } }))
  await dom.render(<HostExecutorSettings config={config} active />)
  const button = [...dom.container.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Register command')!
  await act(async () => button.click())
  await fill('[aria-label="Host Executor ID"]', 'literal-wrapper')
  await fill('[aria-label="Host Executor name"]', 'Literal')
  await fill('[aria-label="Host Executor command"]', _historyFixturePath("opt/Other Tools/runner"))
  await fill('[aria-label="Host Executor arguments"]', '--name "two words" ""')
  expect(split(preview().querySelector('code')!.textContent!)).toEqual([_historyFixturePath("opt/Other Tools/runner"), '--name', 'two words', ''])
  const commit = dom.container.querySelector<HTMLButtonElement>('.agent-settings-card .primary-button')!
  await act(async () => commit.click())
  expect(register).toHaveBeenCalledWith('local', expect.objectContaining({ executorId: 'literal-wrapper', config: expect.objectContaining({
    command: _historyFixturePath("opt/Other Tools/runner"), args: ['--name', 'two words', '']
  }) }))
})
it('label: missing reports lookup rather than installation, retaining distinct check and file-type failures', () => {
  expect(executorDetectionLabel({ state: 'missing' })).toBe('Not found')
  expect(executorDetectionLabel({ state: 'missing', result: { availability: 'missing', executable: 'wrapper',
    cause: { code: 'EXECUTABLE_NOT_FOUND', message: 'Exact lookup failed' } } } as never)).toBe('Not found')
  expect(executorDetectionLabel({ state: 'missing', result: { availability: 'missing', executable: 'directory',
    cause: { code: 'EXECUTABLE_NOT_FILE', message: 'Directory' } } } as never)).toBe('Not available')
  expect(executorDetectionLabel({ state: 'error', detail: 'EIO' })).toBe('Check failed')
})
