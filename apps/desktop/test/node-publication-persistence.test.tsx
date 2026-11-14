// @vitest-environment happy-dom
import { act } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { NodePublishingOwner } from '../../../packages/core/src/node-publishing-owner'
import { NetworkNodeSettingsPane } from '../src/renderer/src/components/settings/NetworkNodeSettingsPane'
import { useAppStore } from '../src/renderer/src/store'
import { nodePublicationDraftForRuntime } from '../src/renderer/src/lib/node-publication-draft'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'

const phase = process.env.NODE_EDIT_PHASE, runtimeId = 'original-edit-runtime'
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

if (phase) it('Node publication restart phase uses the original native user document', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const directory = process.env.NODE_EDIT_ROOT!, user = new WorkbenchUserStateStore(join(directory, 'workbench-user-state.json'))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json')), nodeState = join(directory, 'node')
  await mkdir(nodeState, { recursive: true })
  const node = new NodePublishingOwner({ stateDirectory: nodeState, runtimeId, ownerInstanceId: 'private-' + phase })
  const original = await node.call('settings.node.inspect', {}), calls: Array<{ method: string; input: unknown }> = []
  const config = { ...composerConfig, hosts: [{ id: 'local', kind: 'local' as const, label: 'Original local node' }, { id: 'farm', kind: 'ssh' as const, label: 'Original private remote node', hostname: 'private.invalid', runtimeId }], workspaces: [{ id: 'workspace', kind: 'folder' as const, hostId: 'local', name: 'Original workspace', path: directory }] }
  const session = { ...composerSession(), workspacePath: directory }
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  vi.spyOn(api.nodePublishing, 'owner').mockImplementation(async (target, method, input) => {
    expect(target).toEqual({hostId:'farm',expectedRuntimeId:runtimeId}); calls.push({ method, input: structuredClone(input) })
    if (method === 'settings.node.configure') return await new Promise<never>(() => {})
    return await node.call(method, input) as never
  })
  const dispose = await useAppStore.getState().initialize()
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  await act(async () => root.render(<NetworkNodeSettingsPane config={config} navigationRequest={{section:'network-node',hostId:'farm'}} active onClose={() => {}} onNavigate={() => {}} />))
  for (let attempt = 0; attempt < 100 && !container.querySelector('[name="alias"]'); attempt++) await act(async () => { await pause(10) })
  expect(container.querySelector('[name="alias"]'), container.textContent ?? '').not.toBeNull()
  const input = async (name: string, value: string) => act(async () => {
    const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (phase === 'write') {
    await input('alias', 'original-draft')
    await act(async () => container.querySelector<HTMLButtonElement>('.network-node-save button')!.click())
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'settings.node.configure')).toHaveLength(1))
    const pending = nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts, runtimeId)?.pending
    expect(pending?.operationId).toBeTruthy()
    expect(pending?.phase).toBe('in-flight')
    expect(calls.filter(call => call.method === 'settings.node.configure')).toHaveLength(1)
    await input('alias', 'later-draft')
    await input('allowedPaths', join(directory, 'published '))
    await input('deniedPaths', join(directory, 'published ', 'private '))
    await input('defaultPath', join(directory, 'published '))
    // No test checkpoint or graceful-exit flush: the original bounded writer owns custody.
    await pause(900)
    expect(user.observe().lastConfirmedWrite?.diskDurability).toBe('confirmed')
    expect((await node.call('settings.node.inspect', {})).policy).toEqual(original.policy)
    await writeFile(join(directory, 'writer-ready.json'), JSON.stringify({ pid: process.pid, operationId: pending!.operationId, phase: pending!.phase, writer: user.observe(), calls, originalPolicy: original.policy }))
    await new Promise(() => {}) // Parent kills this precise worker, before any cleanup/exit hook.
  } else {
    const before = JSON.parse(await readFile(join(directory, 'writer-ready.json'), 'utf8'))
    expect(process.pid).not.toBe(before.pid)
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('[name="alias"]')?.value).toBe('later-draft'))
    expect(container.querySelector<HTMLTextAreaElement>('[name="allowedPaths"]')?.value).toBe(join(directory, 'published '))
    expect(container.querySelector<HTMLTextAreaElement>('[name="deniedPaths"]')?.value).toBe(join(directory, 'published ', 'private '))
    expect(container.querySelector<HTMLInputElement>('[name="defaultPath"]')?.value).toBe(join(directory, 'published '))
    await vi.waitFor(() => expect(calls.some(call => call.method === 'settings.node.inspect' && (call.input as { operationId?: string }).operationId === before.operationId)).toBe(true))
    expect(calls.filter(call => call.method === 'settings.node.configure')).toHaveLength(0)
    expect((await node.call('settings.node.inspect', {})).policy).toEqual(before.originalPolicy)
    expect(useAppStore.getState().sessions.find(item => item.id === session.id)?.processState).toBe('running'); expect(stop).not.toHaveBeenCalled()
    await writeFile(join(directory, 'reader-result.json'), JSON.stringify({ pid: process.pid, originalOperationId: before.operationId, calls, draft: nodePublicationDraftForRuntime(useAppStore.getState().nodePublicationDrafts, runtimeId), originalPolicyUnchanged: true }))
    await act(async () => root.unmount()); dispose(); container.remove()
  }
})
else it('the actual Node editor restores its original pending operation and later directory draft after abrupt process exit without replay', async () => {
  const directory = await mkdtemp('/tmp/nn-edit-'), config = resolve(process.cwd(), 'apps/desktop/test/node-publication-persistence.config.mts')
  const children: ReturnType<typeof spawn>[] = []
  const run = (next: string) => {
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--testNamePattern', 'Node publication restart phase'], {
      cwd: process.cwd(), env: { ...process.env, NODE_EDIT_PHASE: next, NODE_EDIT_ROOT: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child); let output = ''; child.stdout!.on('data', data => { output += data }); child.stderr!.on('data', data => { output += data })
    return { child, output: () => output, ended: new Promise<number | null>((yes, no) => { child.once('error', no); child.once('exit', yes) }) }
  }
  try {
    const writer = run('write'); let ready: { pid: number; operationId: string } | undefined
    for (let attempt = 0; attempt < 1200 && !ready; attempt++) {
      try { ready = JSON.parse(await readFile(join(directory, 'writer-ready.json'), 'utf8')) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
      if (!ready) { if (writer.child.exitCode !== null) throw Error(writer.output()); await pause(50) }
    }
    expect(ready, writer.output()).toBeDefined()
    process.kill(ready!.pid, 'SIGKILL')
    expect(await writer.ended).not.toBe(0)
    const reader = run('read'); expect(await reader.ended, reader.output()).toBe(0)
    const restored = JSON.parse(await readFile(join(directory, 'reader-result.json'), 'utf8'))
    expect(restored.originalOperationId).toBe(ready!.operationId)
    expect(restored.draft.pending, 'The departed producer becomes unknown, then its exact not-recorded read closes only that reference').toBeUndefined()
    if (process.env.NODE_EDIT_EVIDENCE) {
      for (const file of ['writer-ready.json', 'reader-result.json']) await writeFile(join(process.env.NODE_EDIT_EVIDENCE, file), await readFile(join(directory, file)))
      await writeFile(join(process.env.NODE_EDIT_EVIDENCE, 'process-logs.txt'), writer.output() + '\n' + reader.output())
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
})
