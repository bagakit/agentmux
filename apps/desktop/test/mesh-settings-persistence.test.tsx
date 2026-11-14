// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { MeshNetworkConfiguration, MeshNetworkSettings, MeshNetworkInspection } from '@agentmux/core/mesh-network'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { MeshNetworkSettings as Editor } from '../src/renderer/src/components/settings/MeshNetworkSettings'
import { meshDraftForRuntime } from '../src/renderer/src/lib/mesh-settings-draft'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'

const phase = process.env.MESH_EDIT_PHASE, runtimeId = 'original-mesh-edit-runtime'
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const submittedNetwork = 'submitted-original-mesh'
const lateNetwork = 'later-network  ', latePeers = 'amux-mesh:unfinished-peer-code  \n  '
const lateOffer = '{"offer":{"serverId":"original-publisher","daemonPublicKeyB64":  '
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const configuration: MeshNetworkConfiguration = { role: 'disabled', networkId: 'original-network', members: [], peers: [], advertisedIngress: [], publishers: [], endpointAccess: { allowedClientKeys: [] } }
const settings: MeshNetworkSettings = { owner: { runtimeId, ownerInstanceId: 'original-controlled-Core' }, identity: null, revision: 'original-revision', configuration, operation: null }
const observation: MeshNetworkInspection = { owner: settings.owner, identity: null, source: 'none', activeRevision: null, desiredRevision: null,
  apply: { state: 'disabled' }, gateway: { state: 'disabled' }, network: null, endpoint: { state: 'not-provided' }, observedAt: 1, coverage: { configuredOrigins: 0, observedOrigins: 0, complete: true } }

type Call = { method: string; input: unknown }
if (phase) it('Mesh settings restart phase uses the original native user document', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const directory = process.env.MESH_EDIT_ROOT!, user = new WorkbenchUserStateStore(join(directory, 'workbench-user-state.json'))
  await writeFile(join(directory, phase + '-process.json'), JSON.stringify({ pid: process.pid }))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json')), calls: Call[] = []
  const config = { ...composerConfig, workspaces: [{ id: 'workspace', kind: 'folder' as const, hostId: 'local', name: 'Original workspace', path: directory }] }
  const session = { ...composerSession('original-mesh-editor-agent'), workspacePath: directory }
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
  // This is a controlled Core protocol boundary. Actual Core/Host/Native and
  // ciphertext routing are proved separately; this case owns native user-data custody.
  vi.spyOn(api.mesh, 'call').mockImplementation(async (method, input, options) => {
    calls.push({ method, input: structuredClone(input) })
    if (method === 'settings.mesh.configure') {
      expect(phase).toBe('write'); expect(options?.expectedOwner).toEqual(settings.owner)
      return await new Promise<never>(() => {})
    }
    if (method === 'settings.mesh.inspect') return structuredClone(settings) as never // op:null is unknown, never a not-applied receipt.
    if (method === 'mesh.inspect') return structuredClone(observation) as never
    throw Error('This test never selects another endpoint')
  })
  const dispose = await useAppStore.getState().initialize()
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  await act(async () => root.render(<Editor active />))
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Mesh network"]'), container.textContent ?? '').not.toBeNull())
  const input = async (label: string, value: string) => act(async () => {
    const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (phase === 'write') {
    await input('Mesh network', submittedNetwork)
    await act(async () => container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.click())
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'settings.mesh.configure')).toHaveLength(1))
    const pending = meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, runtimeId)!.pending!
    expect(pending).toMatchObject({ phase: 'in-flight', expectedRevision: settings.revision, submitted: { networkId: submittedNetwork }, submittedForm: { networkId: submittedNetwork } })
    expect(pending.operationId).toBeTruthy()
    await input('Mesh network', lateNetwork); await input('Mesh peer codes', latePeers); await input('Original Mesh endpoint offer', lateOffer)
    let acknowledgedRaw = ''
    // Passive observation only: no test checkpoint, exit hook, or forced flush.
    // The actual bounded native writer must acknowledge the exact late edit bytes.
    await vi.waitFor(async () => {
      acknowledgedRaw = await readFile(user.path, 'utf8')
      const doc = JSON.parse(acknowledgedRaw), saved = meshDraftForRuntime(doc.state.meshSettingsDrafts, runtimeId)
      expect(saved?.form).toMatchObject({ networkId: lateNetwork, peers: latePeers })
      expect(saved?.linkInput).toBe(lateOffer); expect(saved?.pending).toEqual(pending)
      expect(user.observe().lastConfirmedWrite).toMatchObject({ diskDurability: 'confirmed', contentDigest: hash(acknowledgedRaw) })
    }, { timeout: 5000, interval: 40 })
    expect(stop).not.toHaveBeenCalled()
    await writeFile(join(directory, 'writer-ready.json'), JSON.stringify({ pid: process.pid, runtimeId, operationId: pending.operationId, pending,
      late: { networkId: lateNetwork, peers: latePeers, offer: lateOffer }, calls, documentSHA256: hash(acknowledgedRaw), writer: user.observe(), originalSession: session }))
    await new Promise(() => {}) // Parent SIGKILLs this precise writer, without cleanup or exit flush.
  } else {
    const before = JSON.parse(await readFile(join(directory, 'writer-ready.json'), 'utf8'))
    expect(process.pid).not.toBe(before.pid)
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('[aria-label="Mesh network"]')?.value).toBe(lateNetwork))
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Mesh peer codes"]')!.value).toBe(latePeers)
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Original Mesh endpoint offer"]')!.value).toBe(lateOffer)
    await vi.waitFor(() => expect(calls.some(call => call.method === 'settings.mesh.inspect' && (call.input as { operationId?: string }).operationId === before.operationId)).toBe(true))
    const restored = meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, runtimeId)!
    expect(restored.pending).toEqual({ ...before.pending, phase: 'unknown' })
    expect(restored.form).toMatchObject({ networkId: lateNetwork, peers: latePeers }); expect(restored.linkInput).toBe(lateOffer)
    expect(calls.filter(call => call.method === 'settings.mesh.configure')).toHaveLength(0)
    expect(useAppStore.getState().sessions.find(item => item.id === session.id)).toMatchObject({ processState: 'running', control: before.originalSession.control })
    expect(stop).not.toHaveBeenCalled(); expect(container.textContent).toContain('original save is not recorded')
    await writeFile(join(directory, 'reader-result.json'), JSON.stringify({ pid: process.pid, originalOperationId: before.operationId, calls, draft: restored,
      nativeDocumentPath: user.path, originalSession: useAppStore.getState().sessions.find(item => item.id === session.id), noConfigureReplay: true, noStop: true }))
    await act(async () => root.unmount()); dispose(); container.remove()
  }
})
else it('the actual Mesh editor restores exact pending input and later text from its original native document after SIGKILL without replay', async () => {
  const directory = await mkdtemp('/tmp/mesh-edit-'), config = resolve('apps/desktop/test/mesh-settings-persistence.config.mts')
  const children: Array<{ child: ReturnType<typeof spawn>; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; done: boolean }> = []
  const workerPids: number[] = [], evidence = process.env.MESH_EDIT_EVIDENCE
  const run = (next: string) => {
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--testNamePattern', 'Mesh settings restart phase'], {
      cwd: process.cwd(), env: { ...process.env, MESH_EDIT_PHASE: next, MESH_EDIT_ROOT: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout!.on('data', data => { output += data }); child.stderr!.on('data', data => { output += data })
    const value: { child: ReturnType<typeof spawn>; done: boolean; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } = { child, done: false, ended: new Promise((yes, no) => { child.once('error', no); child.once('exit', (code, signal) => { value.done = true; yes({ code, signal }) }) }) }
    children.push(value); return { ...value, output: () => output, hasEnded: () => value.done }
  }
  try {
    const writer = run('write'); let ready: { pid: number; operationId: string; pending: unknown; documentSHA256: string } | undefined
    for (let attempt = 0; attempt < 1200 && !ready; attempt++) {
      try { ready = JSON.parse(await readFile(join(directory, 'writer-ready.json'), 'utf8')) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
      if (!ready) { if (writer.hasEnded()) throw Error(writer.output()); await pause(50) }
    }
    expect(ready, writer.output()).toBeDefined(); workerPids.push(ready!.pid)
    // Verify the exact acknowledged native bytes before killing its producer.
    expect(hash(await readFile(join(directory, 'workbench-user-state.json'), 'utf8'))).toBe(ready!.documentSHA256)
    process.kill(ready!.pid, 'SIGKILL')
    expect((await writer.ended).code).not.toBe(0)
    const reader = run('read'), result = await reader.ended
    expect(result.code, reader.output()).toBe(0)
    const restored = JSON.parse(await readFile(join(directory, 'reader-result.json'), 'utf8')); workerPids.push(restored.pid)
    expect(restored.originalOperationId).toBe(ready!.operationId)
    expect(restored.draft.pending).toEqual({ ...ready!.pending as object, phase: 'unknown' })
    expect(restored.noConfigureReplay && restored.noStop).toBe(true)
    if (evidence) {
      for (const file of ['writer-ready.json', 'reader-result.json']) await writeFile(join(evidence, file), await readFile(join(directory, file)))
      await writeFile(join(evidence, 'process-logs.txt'), writer.output() + '\n' + reader.output())
      await writeFile(join(evidence, 'behavior.json'), JSON.stringify({ behaviorAssertionsPassed: true, originalOperationId: ready!.operationId, nativeDocumentSHA256: ready!.documentSHA256,
        writerKilledWithoutExitFlush: true, readerIsNewProcess: restored.pid !== ready!.pid, nullOperationRetainsUnknown: true, originalInputAndLateDraftRestored: true,
        scope: 'Actual production Mesh React editor, AppStore hydration/partialize and native WorkbenchUserStateStore durable file. API protocol/session observations controlled; this does not claim actual Core execution or Native Agent health.' }, null, 2))
    }
  } finally {
    for (const value of children) if (!value.done) { value.child.kill('SIGKILL'); await value.ended }
    for (const next of ['write', 'read']) {
      const pid = await readFile(join(directory, next + '-process.json'), 'utf8').then(raw => (JSON.parse(raw) as { pid: number }).pid, cause => {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw cause
      })
      if (pid !== undefined) workerPids.push(pid)
    }
    const exited = (pid: number) => { try { process.kill(pid, 0); return false } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error } }
    // Failure cleanup is bounded to the exact worker IDs recorded by this
    // private case; killing a Vitest launcher alone can leave its worker alive.
    for (const pid of new Set(workerPids)) if (!exited(pid)) process.kill(pid, 'SIGKILL')
    await vi.waitFor(() => expect(workerPids.every(exited)).toBe(true), { timeout: 5000 })
    await rm(directory, { recursive: true, force: true })
    const rootFact = { path: directory, absent: await access(directory).then(() => false, () => true) }
    const processes = [...new Set([...children.map(value => value.child.pid!), ...workerPids])].map(pid => ({ pid, exited: exited(pid) }))
    const cleanup = { passed: rootFact.absent && processes.every(value => value.exited), root: rootFact, processes }
    if (evidence) await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
    expect(cleanup.root.absent && cleanup.processes.every(value => value.exited)).toBe(true)
  }
})
