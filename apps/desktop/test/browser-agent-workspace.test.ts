// @vitest-environment happy-dom
import '../scripts/fixtures/survey-tab-composition/native-listener.setup'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, LocalExecutionHost, parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '@agentmux/core'
import type { BrowserAgentWorkspaceSource } from '@agentmux/core/control'
import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { prepareSourceCoreCli } from './helpers/source-core-cli.mjs'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { ConfigOwner } from '../src/main/config-owner'
import { prepareBrowserAgentWorkspace } from '../src/main/browser-agent-workspace'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const P1 = '11111111-1111-4111-8111-111111111111', P2 = '22222222-2222-4222-8222-222222222222'
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'amux-agent-directory-')); roots.push(home)
  const original = { id: '__scratch__', hostId: 'local', path: join(home, 'scratch'), name: 'Scratch', kind: 'folder' as const }
  const config = await configOwnerFixture({ workspaces: [original] })
  const sources = new Map<string, BrowserAgentWorkspaceSource>([
    ['page', { browserId: 'page', workspaceId: original.id, mode: 'normal', profileId: P1 }],
    ['other', { browserId: 'other', workspaceId: original.id, mode: 'normal', profileId: P2 }],
    ['private', { browserId: 'private', workspaceId: original.id, mode: 'private', profileId: null }]])
  const labels = new Map([[P1, 'Same name'], [P2, 'Same name']])
  const ports = { config: config.owner, browser: (id: string) => sources.get(id) ?? null,
    profileLabel: (id: string) => labels.get(id), host: () => new LocalExecutionHost(), home: async () => home }
  return { ...config, ports, home, sources, labels, original }
}

describe('survey-directory: Main original Browser and resource owners', () => {
  it('prepares actual Profile folders, persists original registration and keeps rename/default independent', async () => {
    const f = await fixture(), a = await prepareBrowserAgentWorkspace({ browserId: 'page' }, f.ports)
    const b = await prepareBrowserAgentWorkspace({ browserId: 'other' }, f.ports)
    expect(a.outcome).toBe('ready'); expect(b.outcome).toBe('ready')
    expect(a.directory.path).toBe(join(f.home, '.agentmux/survey', P1))
    expect(b.directory.path).toBe(join(f.home, '.agentmux/survey', P2))
    expect((await stat(a.directory.path!)).isDirectory()).toBe(true)
    expect(a.workspace?.id).not.toBe(b.workspace?.id)
    f.labels.set(P1, 'Renamed'); f.labels.set(P2, 'Default now')
    const renamed = await prepareBrowserAgentWorkspace({ browserId: 'page' }, f.ports)
    expect(renamed.workspace).toEqual(a.workspace); expect(renamed.profileLabel).toBe('Renamed')
    expect((await f.disk()).workspaces.filter(w => w.path === a.directory.path)).toHaveLength(1)
    const parsed = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'receipt', ok: true,
      operation: 'browser.agent-workspace.prepare', result: a })
    expect(parsed.ok).toBe(true)
    expect(() => parseRpcControlResult('browser.agent-workspace.prepare', { ...a, source: { ...a.source, browserId: 'other' } }, { browserId: 'page' })).toThrow('another target')
  })
  it('isolates private Browser identity, never a null-Profile Capsule or explicit project', async () => {
    const f = await fixture()
    f.sources.set('private2', { ...f.sources.get('private')!, browserId: 'private2' })
    const one = await prepareBrowserAgentWorkspace({ browserId: 'private' }, f.ports)
    const two = await prepareBrowserAgentWorkspace({ browserId: 'private2' }, f.ports)
    expect(dirname(one.directory.path!)).toBe(join(f.home, '.agentmux/survey/private'))
    expect(one.source.browserId).toBe('private')
    expect(two.directory.path).not.toBe(one.directory.path)
    f.sources.set('capsule', { browserId: 'capsule', workspaceId: '__scratch__', mode: 'normal', profileId: null })
    expect(await prepareBrowserAgentWorkspace({ browserId: 'capsule' }, f.ports)).toMatchObject({ scope: 'existing', workspace: { id: '__scratch__' }, directory: { status: 'not-required' } })
    await f.owner.update(config => ({ ...config, workspaces: [...config.workspaces, { id: 'project', hostId: 'local', path: join(f.home, 'project'), name: 'Project', kind: 'folder' }] }))
    f.sources.set('project-page', { browserId: 'project-page', workspaceId: 'project', mode: 'normal', profileId: P1 })
    const project = await prepareBrowserAgentWorkspace({ browserId: 'project-page' }, f.ports)
    expect(project.scope).toBe('existing'); expect(project.workspace?.path).toBe(join(f.home, 'project'))
  })
  it.each([{kind:'dots',id:'..'},{kind:'slashes',id:'private/../owner'},{kind:'long opaque id',id:'browser-owner-'.repeat(32)}])('keeps an allowed $kind private Browser identity inside its own directory',async ({id})=>{
    const f=await fixture();f.sources.set(id,{browserId:id,workspaceId:'__scratch__',mode:'private',profileId:null})
    const prepared=await prepareBrowserAgentWorkspace({browserId:id},f.ports)
    expect(prepared.outcome).toBe('ready');expect(prepared.source.browserId).toBe(id)
    expect(dirname(prepared.directory.path!)).toBe(join(f.home,'.agentmux/survey/private'))
    expect(basename(prepared.directory.path!)).toMatch(/^[a-f0-9]{64}$/u)
    expect((await stat(prepared.directory.path!)).isDirectory()).toBe(true)
    const again=await prepareBrowserAgentWorkspace({browserId:id},f.ports)
    expect(again.workspace?.id).toBe(prepared.workspace?.id)
    expect(again.source.browserId).toBe(id)
  })
  it('concurrent preparation reuses one saved location and keeps unrelated configuration', async () => {
    const f = await fixture()
    await f.owner.update(config => ({ ...config, workspaces: [...config.workspaces, { id: 'unrelated', name: 'Other folder', hostId: 'local', path: join(f.home, 'unrelated'), kind: 'folder' }] }))
    const results = await Promise.all([1, 2, 3].map(() => prepareBrowserAgentWorkspace({ browserId: 'page' }, f.ports)))
    expect(results.every(row => row.outcome === 'ready')).toBe(true)
    expect(new Set(results.map(row => row.workspace?.id)).size).toBe(1)
    expect((await f.disk()).workspaces.some(item => item.id === 'unrelated')).toBe(true)
    expect((await f.disk()).workspaces.filter(w => w.path === results[0]!.directory.path)).toHaveLength(1)
  })
  it('refuses stale environment without preparing another Profile, retaining the original Browser', async () => {
    const f = await fixture(), before = structuredClone(f.sources.get('page'))
    await expect(prepareBrowserAgentWorkspace({ browserId: 'page', expected: { workspaceId: '__scratch__', mode: 'normal', profileId: P2 } }, f.ports)).rejects.toThrow('changed')
    expect(f.sources.get('page')).toEqual(before)
    expect((await f.disk()).workspaces).toHaveLength(1)
  })
  it('keeps directory and registration failures separate without falling back to Scratch', async () => {
    const f = await fixture(); await mkdir(join(f.home, '.agentmux'), { recursive: true }); await writeFile(join(f.home, '.agentmux/survey'), 'existing file')
    const failed = await prepareBrowserAgentWorkspace({ browserId: 'page' }, f.ports)
    expect(failed).toMatchObject({ outcome: 'unconfirmed', registration: 'not-attempted', workspace: null, issue: { step: 'directory' } })
    expect((await f.disk()).workspaces).toHaveLength(1)
    await rm(join(f.home, '.agentmux/survey'))
    f.save.mockRejectedValueOnce(new Error('configuration durable ACK missing'))
    const unknown = await prepareBrowserAgentWorkspace({ browserId: 'page' }, f.ports)
    expect(unknown).toMatchObject({ outcome: 'unconfirmed', directory: { status: 'confirmed' }, registration: 'unconfirmed', workspace: null, issue: { step: 'registration' } })
    expect((await stat(unknown.directory.path!)).isDirectory()).toBe(true)
    expect(f.sources.get('page')?.workspaceId).toBe('__scratch__')
  })
  it('actual current Source CLI/RPC reaches the Main directory and original durable ConfigOwner', async () => {
    const f = await fixture(), core = await privateRpcCorePort(join(f.home, 'sessions.json'), join(f.home, 'messages.ndjson'))
    const calls: string[] = []
    const server = new AgentMuxControlServer({ socketPath: join(f.home, 'control.sock'), coreClients: core.clients, execute: async request => {
      calls.push(request.operation)
      if (request.operation !== 'browser.agent-workspace.prepare') throw new Error('Unexpected operation')
      return { operation: request.operation, ...await prepareBrowserAgentWorkspace(request, f.ports) }
    } })
    let prepared: Awaited<ReturnType<typeof prepareSourceCoreCli>> | undefined
    try {
      if (!process.env.SURVEY_DIRECTORY_CLI) prepared = await prepareSourceCoreCli()
      const cli = process.env.SURVEY_DIRECTORY_CLI || prepared!.cliPath
      await server.start()
      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli!, 'browser', 'agent-workspace', 'prepare', '--browser', 'page'], { env: objectCliEnvironment(f.home), stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
        child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }))
      })
      expect(output.code, output.stderr).toBe(0)
      const answer = JSON.parse(output.stdout).result
      expect(answer.directory.path).toBe(join(f.home, '.agentmux/survey', P1))
      expect(answer.outcome).toBe('ready'); expect(calls).toEqual(['browser.agent-workspace.prepare'])
      expect((await f.disk()).workspaces.some(item => item.id === answer.workspace.id && item.path === answer.directory.path)).toBe(true)
      expect((await stat(answer.directory.path)).isDirectory()).toBe(true)
    } finally { await server.stop(); await core.dispose(); await prepared?.cleanup() }
  })
  it('reports a missing Host home as unknown and keeps a re-bound resource out of registration', async () => {
    const f = await fixture()
    const missing = await prepareBrowserAgentWorkspace({ browserId: 'page' }, { ...f.ports, home: async () => { throw new Error('Original Host home unavailable') } })
    expect(missing).toMatchObject({ outcome: 'unconfirmed', directory: { path: null, status: 'unconfirmed' }, registration: 'not-attempted', workspace: null })
    let release!: (value: string) => void
    const waiting = new Promise<string>(done => { release = done })
    const pending = prepareBrowserAgentWorkspace({ browserId: 'page' }, { ...f.ports, home: () => waiting })
    await f.owner.update(config => ({ ...config, workspaces: config.workspaces.map(item => item.id === '__scratch__' ? { ...item, path: join(f.home, 'rebound') } : item) }))
    release(f.home)
    const changed = await pending
    expect(changed).toMatchObject({ outcome: 'unconfirmed', directory: { status: 'confirmed' }, registration: 'not-attempted', workspace: null, issue: { step: 'source' } })
    expect((await f.disk()).workspaces).toHaveLength(1)
  })
  it('reconciles an actual written resource after a lost registration ACK instead of minting a replacement', async () => {
    const f=await fixture()
    f.save.mockImplementationOnce(async next=>{await f.store.save(next);throw new Error('Original configuration write applied but ACK lost')})
    const unknown=await prepareBrowserAgentWorkspace({browserId:'page'},f.ports)
    expect(unknown.registration).toBe('unconfirmed')
    const written=(await f.disk()).workspaces.find(item=>item.path===unknown.directory.path)!
    expect(written.id).toBeTruthy()
    const observed=await prepareBrowserAgentWorkspace({browserId:'page'},f.ports)
    expect(observed.outcome).toBe('ready');expect(observed.workspace?.id).toBe(written.id)
  })
  it('a queued disjoint edit merges the actual written resource before saving its own change', async () => {
    const f=await fixture()
    let entered!:()=>void, release!:()=>void
    const writing=new Promise<void>(done=>{entered=done}), ack=new Promise<void>(done=>{release=done})
    f.save.mockImplementationOnce(async next=>{await f.store.save(next);entered();await ack;throw new Error('Write applied; original ACK lost')})
    const pending=prepareBrowserAgentWorkspace({browserId:'page'},f.ports)
    await writing
    const original=(await f.disk()).workspaces.find(item=>item.path===join(f.home,'.agentmux/survey',P1))!
    const queued=f.owner.update(config=>({...config,workspaces:[...config.workspaces,{id:'later-folder',name:'Later folder',hostId:'local',path:join(f.home,'later'),kind:'folder'}]}))
    release();expect((await pending).registration).toBe('unconfirmed');await queued
    const disk=await f.disk()
    expect(disk.workspaces.find(item=>item.path===original.path)?.id).toBe(original.id)
    expect(disk.workspaces.some(item=>item.id==='later-folder')).toBe(true)
    expect(f.owner.current.workspaces.find(item=>item.path===original.path)?.id).toBe(original.id)
    expect(f.save).toHaveBeenCalledTimes(2)
  })
  it('does not overwrite an actual written resource when readback confirmation fails', async () => {
    const f=await fixture()
    f.save.mockImplementationOnce(async next=>{await f.store.save(next);throw new Error('Write applied; ACK lost')})
    const first=await prepareBrowserAgentWorkspace({browserId:'page'},f.ports)
    const bytes=await f.bytes(), original=(await f.disk()).workspaces.find(item=>item.path===first.directory.path)!
    const confirm=vi.spyOn(f.store,'confirmSaved').mockRejectedValueOnce(new Error('Original file/parent ACK remains unavailable'))
    const second=await prepareBrowserAgentWorkspace({browserId:'page'},f.ports)
    expect(second).toMatchObject({outcome:'unconfirmed',registration:'unconfirmed',issue:{step:'registration'}})
    expect(await f.bytes()).toBe(bytes);expect(f.save).toHaveBeenCalledOnce()
    expect(f.runtime.commit).not.toHaveBeenCalled();expect(f.runtime.discard).toHaveBeenCalledOnce()
    const third=await prepareBrowserAgentWorkspace({browserId:'page'},f.ports)
    expect(third.workspace?.id).toBe(original.id);expect(third.outcome).toBe('ready')
    expect(f.save).toHaveBeenCalledOnce();expect(confirm).toHaveBeenCalledTimes(2)
    expect(f.runtime.commit).toHaveBeenCalledOnce()
    expect(confirm.mock.invocationCallOrder[1]!).toBeLessThan(vi.mocked(f.runtime.commit).mock.invocationCallOrder[0]!)
  })
  it('does not invent disk confirmation for an owner without a readback capability', async () => {
    const f=await fixture(), save=vi.fn(async()=>{throw new Error('Save unknown')}), publish=vi.fn()
    const owner=new ConfigOwner({read:()=>f.owner.current,save,publish})
    await expect(owner.update(config=>({...config,workspaces:[...config.workspaces,{id:'unconfirmed',name:'Unknown',hostId:'local',path:join(f.home,'unknown'),kind:'folder'}]}))).rejects.toThrow('Save unknown')
    await expect(owner.update(config=>config)).rejects.toThrow('readback is unavailable')
    expect(save).toHaveBeenCalledOnce();expect(publish).not.toHaveBeenCalled()
  })
  it('rejects malformed exact source conditions at the public request codec', () => {
    expect(() => parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'request', operation: 'browser.agent-workspace.prepare', browserId: 'page',
      expected: { workspaceId: '__scratch__', mode: 'private', profileId: P1 } })).toThrow()
  })
})
