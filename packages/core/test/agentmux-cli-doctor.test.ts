import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxClient as Client } from '../src/client.js'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../src/agent-provider.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxRuntimeDiagnostics } from '../src/types.js'

const bridge = vi.hoisted(() => ({ client: undefined as Client | undefined }))
vi.mock('../src/client.js', async original => ({ ...await original<typeof import('../src/client.js')>(),
  AgentMuxClient: vi.fn(function () { if (!bridge.client) throw new Error('private Client not prepared'); return bridge.client }) }))
vi.mock('../src/runtime-client.js', async original => ({ ...await original<typeof import('../src/runtime-client.js')>(),
  connectLocalAgentMux: vi.fn(async () => { if (!bridge.client) throw new Error('private Client not prepared'); await bridge.client.connect(); return bridge.client }) }))
let root = ''
const priorArgv = [...process.argv]
const priorExitCode = process.exitCode
let dispose: ReturnType<typeof vi.spyOn> | undefined
const runtime: AgentMuxRuntimeDiagnostics = { nodeVersion: '24.0.0', platform: 'darwin', arch: 'arm64', supported: true,
  ctxmux: { version: '0.1.0', protocolVersion: 17, sourceCommit: 'c168c0ab9cd849bfade68461b62684982c71f688', artifactPlatform: 'darwin-arm64', ready: true,
    capabilities: { transport: 'local-unix', orderedOutputBytes: true, boundedReplay: true, recoverableInput: true, resize: true, interrupt: true, completeStop: true } } }
afterEach(async () => {
  vi.restoreAllMocks(); process.argv = [...priorArgv]; process.exitCode = priorExitCode
  await bridge.client?.dispose(); bridge.client = undefined
  if(root) await rm(root, {recursive:true,force:true})
})

describe('actual doctor CLI body to public Core inspection', () => {
  it('emits the pre-connect scoped result through real Doctor and disposes normally after runtime repair', async () => {
    root = await mkdtemp(join(tmpdir(), 'amx-cli-doctor-'))
    const { AgentMuxClient } = await vi.importActual<typeof import('../src/client.js')>('../src/client.js')
    const provider = new AgentProviderRegistry().get('claude')
    const installer = new AgentManagedHookInstaller(join(root,'receipts'))
    const client = new AgentMuxClient({providers:[provider],hookInstaller:installer,store:new AgentMuxMemoryAgentSessionStore()})
    bridge.client=client
    const resolved=resolveManagedHookPlan('claude',root,{})!
    await mkdir(join(root,'.claude'));await writeFile(resolved.mutations[0]!.path,'{"secret":"never-report"}')
    const before=await readFile(resolved.mutations[0]!.path,'utf8')
    vi.spyOn(process,'cwd').mockReturnValue(root)
    vi.spyOn(client,'connect').mockImplementation(async()=>{await installer.ensure(resolved)})
    vi.spyOn(client,'runtimeIdentity').mockReturnValue({hostId:'local',buildIdentity:'fixture',protocolVersion:17,instanceId:'fixture',processId:null})
    vi.spyOn(client,'runtimeDiagnostics').mockResolvedValue(runtime)
    vi.spyOn(client,'probeAgent').mockResolvedValue({providerId:provider.id,executable:provider.executable,installed:true,capabilities:provider.catalog.capabilities})
    vi.spyOn(client,'probeExecutorAvailability').mockResolvedValue('available')
    dispose=vi.spyOn(client,'dispose')
    const inspect=vi.spyOn(client,'inspectManagedHooks')
    const lines:string[]=[]
    vi.spyOn(process.stdout,'write').mockImplementation(chunk=>{lines.push(String(chunk));return true})
    process.argv=['node','agentmux','doctor']
    await import('../src/agentmux.js')
    await vi.waitFor(()=>expect(dispose).toHaveBeenCalledOnce())
    expect(lines.length).toBe(1)
    expect((await import('../src/runtime-client.js')).connectLocalAgentMux).not.toHaveBeenCalled()
    const message=JSON.parse(lines[0]!)
    expect(message).toMatchObject({ok:true,operation:'doctor',result:{ok:true,agents:[{id:'claude',hookInstallation:{status:'not_installed',phase:'pre-connect',workspacePath:root}}]}})
    expect(message.result.agents[0].hookInstallation.targets).toEqual([{path:resolved.mutations[0]!.path,status:'not_present'}])
    expect(inspect.mock.calls).toEqual([['claude',expect.objectContaining({workspacePath:root,env:expect.any(Object)})]])
    expect(lines.join('')).not.toContain('never-report')
    expect(await readFile(resolved.mutations[0]!.path,'utf8')).not.toBe(before)
  })
})
