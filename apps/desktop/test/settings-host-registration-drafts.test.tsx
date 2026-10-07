// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxHostExecutorOwner } from '@agentmux/core'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import type { AppConfig, HostExecutorConfiguration } from '../src/shared/contracts'
const dom = composerDOM()
let directory: string, config: AppConfig, owner: AgentMuxHostExecutorOwner
let release: () => void, receipt: HostExecutorConfiguration | undefined
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amux-host-registration-'))
  config = await api.config.get()
  const catalog = await api.providers.list()
  owner = new AgentMuxHostExecutorOwner({ path: join(directory, 'executors.json'), runtimeId: 'controlled-runtime', catalog: () => catalog })
  useAppStore.setState({ config, providerCatalog: catalog, activeWorkspaceId: null, hostExecutorInventories: {},
    detectExecutors: vi.fn(async () => {}), discoverHostExecutors: vi.fn(async () => {}) })
  receipt = undefined
  let first = true
  const pending = new Promise<void>(done => { release = done })
  vi.spyOn(api.executors, 'register').mockImplementation(async (hostId, input) => {
    const result = { ...await owner.configure(input), routeHostId: hostId }
    if (first) { first = false; receipt = result; await pending }
    return result
  })
})
afterEach(async () => { await act(async () => { release(); await Promise.allSettled(vi.mocked(api.executors.register).mock.results.map(result => result.value)) }); await rm(directory, { recursive: true, force: true }) })
async function fill(label: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="Host Executor ${label}"]`)!
  expect(node).not.toBeNull()
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const field = (label: string) => dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="Host Executor ${label}"]`)!
const submit = () => dom.click('.settings-host-executor-actions .primary-button')
async function waitForReceipt() {
  for (let i = 0; i < 100 && !receipt; i++) await act(async () => { await new Promise(done => setTimeout(done, 5)) })
  expect(receipt, 'The actual Core registry write completed before its delayed API reply').toBeDefined()
}
async function mount() {
  await dom.render(<SettingsPanel initialSection="agents" onClose={() => {}} />)
  await act(async () => {
    const scope = dom.container.querySelector<HTMLSelectElement>('[aria-label="Executor configuration scope"]')!
    scope.value = 'host'; scope.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Register command')!.click())
  await fill('ID', 'controlled-wrapper'); await fill('name', 'Captured registration')
  await fill('command', '/bin/sh'); await fill('arguments', '-c "printf literal"'); await fill('environment', '{"LITERAL":"$HOME stays literal"}')
}
it('preserves every later registration field through the actual Settings -> API -> Core receipt', async () => {
  await mount(); const argsNode = field('arguments')
  await submit(); await waitForReceipt()
  await fill('ID', 'later-wrapper'); await fill('name', 'Later authored name'); await fill('command', '/bin/echo')
  await fill('arguments', '"later literal" ""'); await fill('environment', '{"LATER":"not submitted"}')
  const providers = useAppStore.getState().providerCatalog
  await act(async () => { const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Host Executor Provider"]')!; select.value = providers[1]!.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await dom.click('.settings-host-executor-actions input[type="checkbox"]')
  await act(async () => release())
  expect(field('arguments')).toBe(argsNode); expect(field('arguments').value).toBe('"later literal" ""')
  expect(field('environment').value).toBe('{"LATER":"not submitted"}')
  expect(field('ID').value).toBe('later-wrapper'); expect(field('name').value).toBe('Later authored name'); expect(field('command').value).toBe('/bin/echo')
  expect(dom.container.querySelector<HTMLSelectElement>('[aria-label="Host Executor Provider"]')!.value).toBe(providers[1]!.id)
  expect(dom.container.querySelector<HTMLInputElement>('.settings-host-executor-actions input')!.checked).toBe(false)
  expect(dom.container.textContent).toContain('Your later edits are not registered yet')
  const disk = JSON.parse(await readFile(join(directory, 'executors.json'), 'utf8'))
  expect(disk.executors['controlled-wrapper']).toMatchObject({ label: 'Captured registration', command: '/bin/sh', args: ['-c', 'printf literal'], env: { LITERAL: '$HOME stays literal' } })
  expect(disk.executors).not.toHaveProperty('later-wrapper')
  expect(api.executors.register).toHaveBeenCalledOnce()
})
it('uses only the original acknowledged revision for later explicit same-target edits and preserves a conflict', async () => {
  await mount(); await submit(); await waitForReceipt()
  await fill('arguments', '"second literal"'); await act(async () => release())
  const originalRevision = receipt!.executor.configRevision
  await submit()
  await act(async () => { await vi.mocked(api.executors.register).mock.results[1]!.value })
  expect(vi.mocked(api.executors.register).mock.calls[1]![1].expectedRevision).toBe(originalRevision)
  expect(field('arguments')).toBeNull()
  const calls = vi.mocked(api.executors.register).mock.calls
  const second = await vi.mocked(api.executors.register).mock.results[1]!.value
  await owner.configure({ ...calls[1]![1], expectedRevision: second.executor.configRevision, config: { ...calls[1]![1].config, label: 'External writer' } })
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Register command')!.click())
  await fill('name', 'Keep my conflicting draft'); await submit()
  await act(async () => { await vi.mocked(api.executors.register).mock.results[2]!.value.catch(() => {}) })
  expect(field('name').value).toBe('Keep my conflicting draft')
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('configuration changed')
  expect(api.executors.register).toHaveBeenCalledTimes(3)
  expect(vi.mocked(api.executors.register).mock.calls[2]![1].expectedRevision).toBe(second.executor.configRevision)
})
it('closes an unchanged submission and retains its literal values when reopened', async () => {
  await mount(); await submit(); await waitForReceipt(); await act(async () => release())
  expect(field('arguments')).toBeNull()
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Register command')!.click())
  expect(field('arguments').value).toBe('-c "printf literal"')
  expect(field('environment').value).toBe('{"LITERAL":"$HOME stays literal"}')
})

it.each(['label', 'connection'] as const)('binds an acknowledged revision to the execution target, independent of a %s change', async change => {
  await mount(); await submit(); await waitForReceipt()
  await fill('arguments', 'later'); await act(async () => release())
  await act(async () => {
    const current = useAppStore.getState().config!
    useAppStore.setState({ config: { ...current, hosts: current.hosts.map((host, i) => i ? host : change === 'label'
      ? { ...host, label: 'A display rename' } : { id: host.id, label: host.label, kind: 'ssh', hostname: 'another-host.invalid' }) } })
  })
  await submit()
  await act(async () => { await vi.mocked(api.executors.register).mock.results[1]!.value.catch(() => {}) })
  expect(vi.mocked(api.executors.register).mock.calls[1]![1].expectedRevision).toBe(change === 'label' ? receipt!.executor.configRevision : undefined)
  if (change === 'connection') expect(field('arguments').value).toBe('later')
})

it('retains the original draft and never replays a write whose response is unavailable', async () => {
  vi.mocked(api.executors.register).mockImplementationOnce(async (_hostId, input) => {
    await owner.configure(input)
    throw new Error('Original registration response unavailable')
  })
  await mount(); await submit()
  await act(async () => { await vi.mocked(api.executors.register).mock.results[0]!.value.catch(() => {}) })
  expect(field('arguments').value).toBe('-c "printf literal"')
  expect(field('environment').value).toBe('{"LITERAL":"$HOME stays literal"}')
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('Original registration response unavailable')
  expect(api.executors.register).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(join(directory, 'executors.json'), 'utf8')).executors['controlled-wrapper']).toBeDefined()
})
