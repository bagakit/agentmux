// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { MeshSettingsPane } from '../src/renderer/src/components/settings/MeshSettingsPane'
import { tailcatConnectionDraft } from '../src/renderer/src/lib/tailcat-connection-draft'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import type { AppConfig, HostConfig } from '../src/shared/contracts'

const phase = process.env.CONNECTION_EDIT_PHASE
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const lateServer = 'later-server-key  ', lateAllowed = '  nodekey:' + 'cd'.repeat(32) + '  \n\n', lateRemote = 'later-remote-client'
const opaque = { incoming: { 'opaque-incoming': { future: 'keep-incoming-bytes' } }, hosts: { 'opaque-host': { future: 'keep-host-bytes' } } }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
type Call = { input: unknown }

if (phase) it('Connection settings restart phase uses the original native user document', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const directory = process.env.CONNECTION_EDIT_ROOT!, user = new WorkbenchUserStateStore(join(directory, 'workbench-user-state.json'))
  await writeFile(join(directory, phase + '-process.json'), JSON.stringify({ pid: process.pid }))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json')), configureCalls: Call[] = []
  let configReads = 0, configWrites = 0
  const local: HostConfig = { id: 'local', kind: 'local', label: 'This Mac', tailcat: { enabled: false, keyFile: 'original-server', allowedClients: [] } }
  const config: AppConfig = { ...structuredClone(composerConfig), hosts: [
    local,
    { id: 'studio', kind: 'ssh', label: 'Studio', hostname: '', transport: 'tailcat', runtimeId: 'original-studio-runtime', tailcat: { address: 'tc-original-private', keyFile: 'original-client' } },
  ], workspaces: [{ id: 'workspace', kind: 'folder', hostId: 'local', name: 'Original workspace', path: directory }] }
  const session = { ...composerSession('original-connection-editor-agent'), workspacePath: directory }
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
  vi.spyOn(api.config, 'get').mockImplementation(async () => { configReads++; return structuredClone(config) })
  const configSave = vi.spyOn(api.config, 'save').mockImplementation(async next => { configWrites++; return next })
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
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async host => ({ routeHostId: host.id, configuration: host, tailcat: { state: 'disabled' } }) as never)
  vi.spyOn(api.hosts, 'network').mockRejectedValue(Error('External network observation is controlled'))
  vi.spyOn(api.mesh, 'call').mockRejectedValue(Error('Mesh Network is not the listener owner'))
  vi.spyOn(api.nodePublishing, 'call').mockRejectedValue(Error('Node publication is not the listener owner'))
  vi.spyOn(api.hosts, 'configureTailcat').mockImplementation(async input => {
    configureCalls.push({ input: structuredClone(input) })
    return await new Promise<never>(() => {})
  })
  const onSave = vi.fn(async () => {})
  const dispose = await useAppStore.getState().initialize()
  if (phase === 'write') useAppStore.setState({ tailcatConnectionDrafts: structuredClone(opaque) })
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  const show = async (hostId = 'local') => act(async () => root.render(<MeshSettingsPane config={config} active onSave={onSave} navigationRequest={{ section: 'hosts', hostId }} />))
  const visibleIncoming = () => [...container.querySelectorAll<HTMLElement>('[data-settings-field="incoming"]')]
    .filter(node => !node.hidden && !node.closest('[hidden]') && !node.inert && !node.closest('[inert]'))
  const incomingInput = (label: string) => visibleIncoming()[0]?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`) ?? undefined
  const input = async (element: HTMLInputElement | HTMLTextAreaElement | undefined, value: string) => {
    expect(element, 'the visible local Host Connection must contain the incoming editor').not.toBeUndefined()
    await act(async () => {
      const prototype = element!.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element!.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const click = async (selector: string, scope?: HTMLElement) => {
    const button = (scope ?? container).querySelector<HTMLButtonElement>(selector)
    expect(button, selector).not.toBeNull(); await act(async () => button!.click())
  }
  const selectHost = async (id: string) => {
    await click('[aria-label="List"]'); await click(`[data-host-disclosure="${id}"] [data-host-panel="connection"]`)
  }
  const drafts = (raw: unknown) => tailcatConnectionDraft((raw as Record<string, Record<string, unknown>>).incoming?.local)
  const hostDrafts = (raw: unknown) => tailcatConnectionDraft((raw as Record<string, Record<string, unknown>>).hosts?.studio)
  await show()
  await vi.waitFor(() => expect(visibleIncoming()).toHaveLength(1))
  if (phase === 'write') {
    await input(incomingInput('Tailcat server key'), 'submitted-server')
    await click('[data-settings-save-bar] button', visibleIncoming()[0])
    await vi.waitFor(() => expect(configureCalls).toHaveLength(1))
    await input(incomingInput('Tailcat server key'), lateServer); await input(incomingInput('Tailcat allowed clients'), lateAllowed)
    await selectHost('studio')
    const remote = container.querySelector<HTMLInputElement>('[aria-label="Tailcat client key"]')
    expect(remote).not.toBeNull(); await input(remote!, lateRemote)
    await selectHost('local')
    let acknowledgedRaw = ''
    await vi.waitFor(async () => {
      acknowledgedRaw = (await user.read())!
      const doc = JSON.parse(acknowledgedRaw), raw = doc.state.tailcatConnectionDrafts
      expect(drafts(raw)?.value).toMatchObject({ tailcat: { keyFile: lateServer } })
      expect(drafts(raw)?.allowedText).toBe(lateAllowed)
      expect(hostDrafts(raw)?.value).toMatchObject({ tailcat: { keyFile: lateRemote } })
      expect(raw.hostSelection).toMatchObject({ hostId: 'local' })
      expect(raw.incoming['opaque-incoming']).toEqual(opaque.incoming['opaque-incoming'])
      expect(raw.hosts['opaque-host']).toEqual(opaque.hosts['opaque-host'])
      const observation = user.observe()
      expect(observation.contentDigest).toMatch(/^[0-9a-f]{64}$/u)
      expect(observation.lastConfirmedWrite).toMatchObject({ diskDurability: 'confirmed', contentDigest: observation.contentDigest })
    }, { timeout: 5000, interval: 40 })
    expect(configSave).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    await writeFile(join(directory, 'writer-ready.json'), JSON.stringify({ pid: process.pid, configureCalls, configReads, configWrites,
      documentSHA256: hash(acknowledgedRaw), writer: user.observe(), originalSession: session }))
    await new Promise(() => {})
  } else {
    const before = JSON.parse(await readFile(join(directory, 'writer-ready.json'), 'utf8'))
    expect(process.pid).not.toBe(before.pid)
    await vi.waitFor(() => expect(incomingInput('Tailcat server key')?.value).toBe(lateServer))
    expect(incomingInput('Tailcat allowed clients')?.value).toBe(lateAllowed)
    const restored = useAppStore.getState().tailcatConnectionDrafts as Record<string, any>
    expect(restored.hostSelection).toMatchObject({ hostId: 'local' })
    expect(restored.incoming['opaque-incoming']).toEqual(opaque.incoming['opaque-incoming'])
    expect(restored.hosts['opaque-host']).toEqual(opaque.hosts['opaque-host'])
    expect(hostDrafts(restored)?.value).toMatchObject({ tailcat: { keyFile: lateRemote } })
    await selectHost('studio')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Tailcat client key"]')?.value).toBe(lateRemote)
    await selectHost('local')
    expect(incomingInput('Tailcat allowed clients')?.value).toBe(lateAllowed)
    expect(configureCalls).toHaveLength(0); expect(configReads).toBe(1); expect(configSave).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions.find(item => item.id === session.id)).toMatchObject({ processState: 'running', control: before.originalSession.control })
    expect(stop).not.toHaveBeenCalled()
    await writeFile(join(directory, 'reader-result.json'), JSON.stringify({ pid: process.pid, configureCalls, configReads, configWrites,
      nativeDocumentPath: user.path, originalSession: useAppStore.getState().sessions.find(item => item.id === session.id), restored }))
    await act(async () => root.unmount()); dispose(); container.remove()
  }
})
else it('the relocated Connection editors restore exact incoming and Host drafts from the original native document after SIGKILL without replay or reseed', async () => {
  const directory = await mkdtemp('/tmp/connection-edit-'), config = resolve('apps/desktop/test/connection-settings-persistence.config.mts')
  const children: Array<{ child: ReturnType<typeof spawn>; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; done: boolean }> = []
  const workerPids: number[] = [], evidence = process.env.CONNECTION_EDIT_EVIDENCE
  const run = (next: string) => {
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--testNamePattern', 'Connection settings restart phase'], {
      cwd: process.cwd(), env: { ...process.env, CONNECTION_EDIT_PHASE: next, CONNECTION_EDIT_ROOT: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout!.on('data', data => { output += data }); child.stderr!.on('data', data => { output += data })
    const value: { child: ReturnType<typeof spawn>; done: boolean; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } = { child, done: false, ended: new Promise((yes, no) => { child.once('error', no); child.once('exit', (code, signal) => { value.done = true; yes({ code, signal }) }) }) }
    children.push(value); return { ...value, output: () => output, hasEnded: () => value.done }
  }
  try {
    const writer = run('write'); let ready: { pid: number; documentSHA256: string; configureCalls: Call[] } | undefined
    for (let attempt = 0; attempt < 1200 && !ready; attempt++) {
      try { ready = JSON.parse(await readFile(join(directory, 'writer-ready.json'), 'utf8')) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
      if (!ready) { if (writer.hasEnded()) break; await pause(50) }
    }
    expect(ready, writer.output()).toBeDefined(); workerPids.push(ready!.pid)
    expect(hash((await new WorkbenchUserStateStore(join(directory, 'workbench-user-state.json')).read())!)).toBe(ready!.documentSHA256)
    expect(ready!.configureCalls).toHaveLength(1)
    process.kill(ready!.pid, 'SIGKILL')
    expect((await writer.ended).code).not.toBe(0)
    const reader = run('read'), result = await reader.ended
    expect(result.code, reader.output()).toBe(0)
    const restored = JSON.parse(await readFile(join(directory, 'reader-result.json'), 'utf8')); workerPids.push(restored.pid)
    expect(restored.pid).not.toBe(ready!.pid)
    expect(restored.configureCalls).toHaveLength(0); expect(restored.configReads).toBe(1); expect(restored.configWrites).toBe(0)
    expect(restored.restored.hostSelection).toMatchObject({ hostId: 'local' })
    expect(restored.restored.incoming['opaque-incoming']).toEqual(opaque.incoming['opaque-incoming'])
    expect(restored.restored.hosts['opaque-host']).toEqual(opaque.hosts['opaque-host'])
    if (evidence) {
      for (const file of ['writer-ready.json', 'reader-result.json']) await writeFile(join(evidence, file), await readFile(join(directory, file)))
      await writeFile(join(evidence, 'process-logs.txt'), writer.output() + '\n' + reader.output())
      await writeFile(join(evidence, 'behavior.json'), JSON.stringify({ behaviorAssertionsPassed: true, documentSHA256: ready!.documentSHA256,
        writerKilledWithoutExitFlush: true, readerIsNewProcess: true, incomingAndHostDraftsRestored: true, hostSelectionRestored: true,
        opaqueRecordsRetained: true, noConfigureReplay: true, noConfigReseed: true, originalSessionUnchanged: true,
        scope: 'Actual Mesh/Host React editors, AppStore hydration/partialize and native WorkbenchUserStateStore. External configuration and listener protocol leaves controlled; no real user state touched.' }, null, 2))
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
    for (const pid of new Set(workerPids)) if (!exited(pid)) process.kill(pid, 'SIGKILL')
    await vi.waitFor(() => expect(workerPids.every(exited)).toBe(true), { timeout: 5000 })
    await rm(directory, { recursive: true, force: true })
    const rootFact = { path: directory, absent: await access(directory).then(() => false, () => true) }
    const processes = [...new Set([...children.map(value => value.child.pid!), ...workerPids])].map(pid => ({ pid, exited: exited(pid) }))
    const cleanup = { passed: rootFact.absent && processes.every(value => value.exited), root: rootFact, processes }
    if (evidence) await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
    expect(cleanup.root.absent && cleanup.processes.every(value => value.exited)).toBe(true)
  }
}, 120_000)
