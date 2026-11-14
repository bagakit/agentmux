import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { NodeResources } from '@agentmux/core/node-publishing'
import { api } from '../src/renderer/src/lib/api.js'
import { ClusterMachinesPane } from '../src/renderer/src/components/settings/ClusterMachinesPane.js'
import { nodeTrendPoints } from '../src/renderer/src/components/settings/node-resource-view.js'
import { clusterResourceFixture } from './helpers/cluster-resource-fixture.js'

const directory = resolve(process.env.AGENTMUX_CLUSTER_RESOURCE_EVIDENCE ?? '.local/state/mesh-cluster-overview/resources-proof')
const cleanup: Array<() => void | Promise<void>> = [], roots: string[] = [], pids: number[] = [], facts: unknown[] = []
let container: HTMLDivElement, root: Root
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async ({ task }) => {
  const errors: unknown[] = []
  try { await act(async () => root.unmount()) } catch (error) { errors.push(error) }
  container.remove()
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  const rootFacts = await Promise.all(roots.splice(0).map(async path => ({ path, absent: await access(path).then(() => false, () => true) })))
  const processes = pids.splice(0).map(pid => ({ pid, exited: !alive(pid) }))
  if (rootFacts.some(root => !root.absent) || processes.some(process => !process.exited)) errors.push(Error('Private Cluster resource processes remain'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, task.name.startsWith('rejects') ? 'foreign-consumer.json' : 'resources-consumer.json'), JSON.stringify({ test: task.name, facts: facts.splice(0), cleanup: { roots: rootFacts, processes, errors: errors.map(String) } }, null, 2) + '\n')
  if (errors.length) throw new AggregateError(errors, 'Private Cluster resource cleanup')
})
async function fixture() {
  const f = await clusterResourceFixture(); cleanup.push(f.close)
  roots.push(...f.originals.map(original => original.root)); pids.push(...f.originals.flatMap(original => [original.ownerProcess.pid!, original.nativeProcessId!]))
  // Only the transport leaf is borrowed. Every response comes from the actual
  // Renderer adapter, registered Main handlers and original Core OS sampler.
  vi.spyOn(api.nodePublishing, 'call').mockImplementation(f.renderer.call)
  vi.spyOn(api.nodePublishing, 'owner').mockImplementation(f.renderer.owner)
  return f
}
const card = (id: string) => container.querySelector<HTMLElement>(`[data-cluster-host="${id}"]`)!
const state = (id: string) => card(id)?.querySelector('.cluster-machine-state')?.textContent
const render = async (f: Awaited<ReturnType<typeof fixture>>, active = true) => { await act(async () => root.render(createElement(ClusterMachinesPane, { hosts: f.hosts, active }))) }
const settled = async () => { await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('.cluster-machines-heading button')?.disabled).toBe(false), { timeout: 20000, interval: 40 }) }
const refresh = async (id: string) => { await act(async () => card(id).querySelector<HTMLButtonElement>('.cluster-machine-footer button')!.click()); await settled() }
function measurements(f: Awaited<ReturnType<typeof fixture>>, hostId: string, method: string): Array<Extract<NodeResources, { status: 'available' }>> {
  return f.calls.filter(call => call.hostId === hostId && call.method === method).flatMap(call => {
    const value = call.result as NodeResources | undefined
    return value?.status === 'available' ? [value] : []
  })
}
function cliResult(value: { code: number | null; stdout: string; stderr: string }): NodeResources {
  expect(value.code, value.stderr || value.stdout).toBe(0); return JSON.parse(value.stdout).result as NodeResources
}

it('Machines consume real private and published Core OS samples through Renderer Main and the saved original carriers; CLI and withdrawal agree', async () => {
  const f = await fixture(); await f.setupPublication(true)
  await render(f, false)
  expect(f.calls.some(call => call.method === 'settings.node.resources' || call.method === 'node.resources')).toBe(false)
  await render(f); await settled()
  expect(state('local')).toBe('Sampled'); expect(state('published-device')).toBe('Sampled')
  expect(card('local').textContent).toContain('Private owner view')
  expect(card('published-device').textContent).toContain('Published resources')
  const privateSamples = measurements(f, 'local', 'settings.node.resources'), publicSamples = measurements(f, 'published-device', 'node.resources')
  expect(privateSamples).toHaveLength(2); expect(publicSamples).toHaveLength(2)
  expect(f.calls.filter(call => call.hostId === 'published-device' && call.method === 'settings.node.resources')).toMatchObject([{ code: 'CONTROL_PERMISSION_DENIED' }])
  for (const [index, samples] of [privateSamples, publicSamples].entries()) {
    const owner = f.originals[index]!.owner
    for (const reply of samples) {
      expect(reply.node.runtimeId).toBe(owner.runtimeId); expect(reply.sample.node).toEqual(reply.node)
      expect(reply.sample.policyRevision).toBe(reply.policyRevision)
      expect(reply.sample.processId).toBe(owner.processId); expect(reply.sample.processId).not.toBe(process.pid)
      expect(reply.sample.cpu.state).toBe('available'); expect(reply.sample.memory.state).toBe('available'); expect(reply.sample.filesystem.state).toBe('available')
    }
    expect(samples[1]!.sample.observedAt - samples[0]!.sample.observedAt).toBeGreaterThanOrEqual(550)
    const expected = nodeTrendPoints(samples.map(reply => ({ at: reply.sample.observedAt, sample: reply.sample }))).at(-1)!
    expect(expected.hostCpu).not.toBeNull()
    const hostId = f.hosts[index]!.id, cpu = [...card(hostId).querySelectorAll('.cluster-machine-meter')].find(node => node.querySelector('span')?.textContent === 'Host CPU')!
    expect(cpu.querySelector('strong')?.textContent).toBe(expected.hostCpu!.toFixed(1) + '%')
    expect(card(hostId).querySelector('.cluster-machine-details')?.textContent).toContain(String(owner.processId))
  }
  const ownCli = cliResult(await f.cli(0, ['settings', 'node', 'resources']))
  const publicCli = cliResult(await f.cli(1, ['node', 'resources', '--expected-runtime', f.originals[1]!.owner.runtimeId]))
  expect(ownCli).toMatchObject({ status: 'available', node: { runtimeId: f.originals[0]!.owner.runtimeId }, sample: { processId: f.originals[0]!.owner.processId } })
  expect(publicCli).toMatchObject({ status: 'available', policyRevision: publicSamples[1]!.policyRevision, node: { runtimeId: f.originals[1]!.owner.runtimeId }, sample: { processId: f.originals[1]!.owner.processId } })
  const privateCount = privateSamples.length
  await f.setupPublication(false); await refresh('published-device')
  expect(state('published-device')).toBe('Not shared'); expect(state('local')).toBe('Sampled')
  expect(card('published-device').textContent).not.toContain(String(f.originals[1]!.owner.processId))
  expect(measurements(f, 'local', 'settings.node.resources')).toHaveLength(privateCount)
  const withheld = cliResult(await f.cli(1, ['node', 'resources', '--expected-runtime', f.originals[1]!.owner.runtimeId]))
  expect(withheld.status).toBe('withheld'); expect(withheld).not.toHaveProperty('sample')
  // A device cannot turn a published-read fallback into private owner access.
  await expect(f.renderer.owner({ hostId: 'published-device', expectedRuntimeId: f.originals[1]!.owner.runtimeId }, 'settings.node.resources', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.renderer.call('node.resources', { hostId: 'published-device', expectedRuntimeId: f.originals[0]!.owner.runtimeId })).rejects.toMatchObject({ code: 'NODE_RUNTIME_MISMATCH' })
  facts.push({ originalOwners: f.originals.map(original => original.owner), actualLoadedOwners: await f.loadedOriginalOwners(), desktopSocket: f.desktop.path, privateSamples, publicSamples, ownCli, publicCli, withheld, actualIntervalMs: privateSamples[1]!.sample.observedAt - privateSamples[0]!.sample.observedAt, devicePrivateDenied: true, cliSameOriginalProcess: true, unrelatedPrivateReadCountRetained: privateCount })
}, 90000)

it('rejects a foreign resource revision after real Main sampling and keeps the original last sample and unrelated machine', async () => {
  const f = await fixture(); await f.setupPublication(true); await render(f); await settled()
  expect(state('local')).toBe('Sampled'); expect(state('published-device')).toBe('Sampled')
  const original = measurements(f, 'published-device', 'node.resources').at(-1)!, privateCount = measurements(f, 'local', 'settings.node.resources').length
  let injected = 0
  f.transformRendererReplies((method, value) => {
    const envelope = value as { ok: boolean; value?: NodeResources }
    if (method !== 'node.resources' || !envelope.ok || envelope.value?.status !== 'available') return value
    // Corrupt only the source binding after an actual original Core sample has
    // crossed Main. Successful metric values are never manufactured by a stub.
    const changed = structuredClone(envelope)
    if (changed.value?.status !== 'available') throw Error('Real sample missing at the explicit fault boundary')
    changed.value.sample.policyRevision = 'foreign-resource-policy-revision'
    injected++
    return changed
  })
  await refresh('published-device')
  expect(state('published-device')).toBe('Read unavailable')
  expect(injected).toBe(1)
  expect(card('published-device').textContent).toContain('Measurements belong to another original Runtime or resource revision')
  expect(card('published-device').textContent).toContain('Last confirmed')
  expect(card('published-device').textContent).toContain(String(original.sample.processId))
  expect(state('local')).toBe('Sampled')
  expect(measurements(f, 'local', 'settings.node.resources')).toHaveLength(privateCount)
  f.transformRendererReplies(undefined); await refresh('published-device')
  expect(state('published-device')).toBe('Sampled')
  facts.push({ originalOwner: f.originals[1]!.owner, actualLoadedOwners: await f.loadedOriginalOwners(), originalRetainedSample: original, injectedAfterActualMainSample: injected, mismatchedField: 'sample.policyRevision', unrelatedPrivateReadCountRetained: privateCount, explicitRefreshRecovered: true })
}, 90000)
