import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
const { build } = createRequire(new URL('../../host/package.json', import.meta.url))('esbuild')
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ path: '', phase: 'none' as 'none' | 'before-replace' | 'after-replace' }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (path: any, ...args: any[]) => {
    if (fault.phase === 'before-replace' && String(path).startsWith(fault.path + '.') && args[0] === 'wx') {
      fault.phase = 'none'; throw new Error('Injected before-replace write failure')
    }
    const handle = await (fs.open as any)(path, ...args)
    if (fault.phase === 'after-replace' && String(path) === dirname(fault.path) && args[0] === 'r') {
      fault.phase = 'none'; handle.sync = async () => { throw new Error('Injected after-replace directory ACK failure') }
    }
    return handle
  } }
})
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, session: { fromPartition: () => ({}) }, BrowserWindow: class {} }))

import * as core from '@agentmux/core'
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'

const cleanup: Array<() => Promise<unknown>> = []
const facts: unknown[] = []
afterAll(async () => { if (process.env.AGENTMUX_PROFILE_CREATION_EVIDENCE) await writeFile(process.env.AGENTMUX_PROFILE_CREATION_EVIDENCE,
  JSON.stringify({ schema: 'agentmux.profile-creation-proof.v1', scope: 'Private resources; actual compiled CLI/Host/Desktop Main/Store and real owner/client document processes. Runtime byte I/O and Electron path are bounded test ports; no live App or Browser data touched.', facts }, null, 2) + '\n') })
const actor = { kind: 'agent' as const, id: 'original-creation-agent', verified: true }
afterEach(async () => { fault.phase = 'none'; for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function composition() {
  const original = await rpcOwnerFixture([actor.id, 'other-creation-agent'], core); cleanup.push(original.close)
  const path = join(original.root, 'browser-profiles.json'), socketPath = join(original.root, 'host.sock'), desktopPath = join(original.root, 'desktop.sock')
  const store = new BrowserProfileStore(path), profiles = new BrowserProfileManager(store, {
    prepare: () => undefined, apply: async () => {}, observe: () => undefined
  } as never)
  await profiles.initialize()
  const desktop = new core.AgentMuxControlServer({ socketPath: desktopPath, coreClients: original.coreClients,
    execute: async (request, context) => {
      if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected non-Profile operation')
      return executeBrowserProfileControl(request, { profiles } as never, context?.actor, context?.location.hostId ? { hostId: context.location.hostId } : undefined)
    } })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => false
    for (const name of ['status','identity','input','observeOutput','attach','detach','stop']) inner.kernel[name] = original.inner.kernel[name]
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: desktopPath,
      mobileBuildDirectory: join(original.root, 'no-mobile') })
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  cleanup.push(() => host.dispose())
  const env = objectCliEnvironment(original.root, { AGENTMUX_CONTROL_SOCKET: socketPath,
    AGENTMUX_AGENT_SESSION_ID: actor.id, AGENTMUX_AGENT_CAPABILITY: original.capability })
  // Explicit endpoint avoids resolving a different local App or any installed Runtime.
  const run = async (args: string[], success = true, who = actor.id) => {
    const reply = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'browser', 'profile', ...args],
      { ...env, AGENTMUX_AGENT_SESSION_ID: who })
    if (success) { expect(reply.code, reply.stderr + reply.stdout).toBe(0); return objectCliReceipt(JSON.parse(reply.stdout)).result as any }
    expect(reply.code).not.toBe(0); return reply
  }
  return { original, path, store, profiles, run }
}

describe('Profile creation original identity transactions', () => {
  it('compiled CLI crosses the actual Host→Desktop forward into all five original Store transactions', async () => {
    const f = await composition()
    const create = await f.run(['create','--operation-id','create-original','--label','Same label'])
    const sourceId = create.creation.receipt.createdId
    expect(create.creation.receipt).toMatchObject({ actor, action: 'browser.profile.create', createdKind: 'profile' })
    const source = f.profiles.listProfiles().find(value => value.id === sourceId)!
    const copyArgs = ['copy','--operation-id','copy-original','--profile',sourceId,'--expected-revision',source.revision,'--label','Same label']
    const copy = await f.run(copyArgs), copyId = copy.creation.receipt.createdId
    expect(copyId).not.toBe(sourceId)
    await f.profiles.updateProfile(sourceId, { notes: 'later source edit' }, source.revision)
    const rawBeforeRepeat = await readFile(f.path, 'utf8')
    expect((await f.run(copyArgs)).creation.receipt.createdId).toBe(copyId)
    expect(await readFile(f.path, 'utf8')).toBe(rawBeforeRepeat)
    let revision = f.profiles.listRevision()
    const folderArgs = ['folder','create','--operation-id','folder-original','--expected-revision',String(revision),'--label','Same label']
    const folder = await f.run(folderArgs)
    revision = f.profiles.listRevision()
    const view = await f.run(['view','create','--operation-id','view-original','--expected-revision',String(revision),'--label','Same label','--query','{"sort":"name"}'])
    const proxy = await f.run(['proxy','create','--operation-id','proxy-original','--edit','{"label":"Same label","server":"http://proxy.invalid:8080"}'])
    // Its first-call collection CAS is stale, but the original receipt is authoritative first.
    expect((await f.run(folderArgs)).creation.receipt.createdId).toBe(folder.creation.receipt.createdId)
    for (const result of [create, copy, folder, view, proxy]) {
      const operationId = result.creation.operationId
      const inspected = await f.run(['creation','inspect','--operation-id',operationId])
      expect(inspected.creation.receipt).toEqual(result.creation.receipt)
      expect(inspected.creation.current).toEqual({ createdId: result.creation.receipt.createdId, state: 'present' })
      expect(inspected.creation.durability).toBe('unconfirmed')
      expect(await f.run(['creation','inspect','--operation-id',operationId], false, 'other-creation-agent')).toMatchObject({ code: 1 })
    }
    await f.run(['create','--operation-id','create-original','--label','Changed intent'], false)
    await f.run(['create','--operation-id','create-original','--label','Same label'], false, 'other-creation-agent')
    const metadata = JSON.parse(await readFile(f.path, 'utf8'))
    expect(metadata.creationReceipts).toHaveLength(5)
    expect(metadata.creationReceipts.every((value: any) => value.actor.hostId === 'local')).toBe(true)
    await expect(f.store.inspectCreation('create-original', { ...actor, hostId: 'other-host' } as typeof actor)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(new Set(metadata.creationReceipts.map((value: any) => value.createdId)).size).toBe(5)
    expect(JSON.stringify(metadata.creationReceipts)).not.toContain('proxy.invalid')
    const bytes = await readFile(f.path)
    expect((await f.run(['creation','inspect','--operation-id','unobserved-original'])).creation).toMatchObject({ receipt: null, current: { state: 'unknown' } })
    expect(await readFile(f.path)).toEqual(bytes)
    facts.push({ scenario: 'five-kinds-compiled-host-desktop', operations: metadata.creationReceipts.map((value: any) => ({ operationId: value.operationId, createdId: value.createdId, action: value.action, actor: value.actor })), exactRepeatPreservedBytes: true, staleSourceAndCollectionRepeat: true, otherActorReadWriteDenied: true })
  })

  it('metadata replacement and original receipt are atomic before/after directory ACK failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-profile-creation-disk-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'browser-profiles.json'), store = new BrowserProfileStore(path)
    await store.list(); fault.path = path
    const request = { operation: 'browser.profile.create' as const, operationId: 'disk-original', label: 'Original disk identity' }
    const before = await readFile(path)
    fault.phase = 'before-replace'
    await expect(store.createIdentity(request, actor)).rejects.toThrow('before-replace')
    expect(await readFile(path)).toEqual(before)
    expect((await store.inspectCreation(request.operationId, actor)).receipt).toBeNull()
    fault.phase = 'after-replace'
    await expect(store.createIdentity(request, actor)).rejects.toThrow('after-replace')
    const reopened = new BrowserProfileStore(path), inspection = await reopened.inspectCreation(request.operationId, actor)
    expect(inspection.receipt?.createdId).toBeTruthy(); expect(inspection.durability).toBe('unconfirmed')
    const committed = await readFile(path)
    expect((await reopened.createIdentity(request, actor)).creation.receipt).toEqual(inspection.receipt)
    expect(await readFile(path)).toEqual(committed)
    expect((await reopened.list()).profiles).toHaveLength(2)
    facts.push({ scenario: 'before-after-replace', operationId: request.operationId, createdId: inspection.receipt!.createdId, beforeReplaceUnchanged: true, afterReplaceUnconfirmed: true, repeatPreservedBytes: true })
  })

  it('a real original-owner process reopens the same receipt after rename/removal and same-label concurrent creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-profile-creation-process-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'browser-profiles.json'), bundle = join(root, 'original-owner.mjs')
    const source = join(import.meta.dirname, '../src/main/browser-profile-store.ts')
    // Only Electron's path provider is a test port. Bundle the actual original Store and real durable writer.
    await build({ stdin: { contents: `import {BrowserProfileStore} from ${JSON.stringify(source)};
      const store=new BrowserProfileStore(process.argv[2]); const actor=${JSON.stringify(actor)};
      const request=JSON.parse(process.argv[3]);
      const result=request.operation==='inspect' ? await store.inspectCreation(request.operationId,actor)
        : request.operation==='rename' ? await store.updateProfile(request.id,{label:request.label},request.revision)
        : request.operation==='remove-folder' ? await store.deleteFolder(request.id,request.revision)
        : await store.createIdentity(request,actor);
      process.stdout.write(JSON.stringify(result));`, resolveDir: process.cwd(), sourcefile: 'profile-original-owner.mjs' },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
      plugins: [{ name: 'electron-path-port', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'private-path' }))
        builder.onLoad({ filter: /.*/, namespace: 'private-path' }, () => ({ contents: "export const app={getPath:()=>process.cwd()}" }))
      } }] })
    const execute = promisify(execFile)
    const run = async (request: unknown) => JSON.parse((await execute(process.execPath, [bundle, path, JSON.stringify(request)], {
      env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }
    })).stdout)
    // Resolve package imports from the private bundle without changing the installed App.
    const { symlink } = await import('node:fs/promises')
    await symlink(join(process.cwd(), 'apps/desktop/node_modules'), join(root, 'node_modules'), 'dir')
    const original = await run({ operation: 'browser.profile.create', operationId: 'process-original', label: 'Original identity' })
    const id = original.creation.receipt.createdId, profile = original.snapshot.profiles.find((value: any) => value.id === id)
    await run({ operation: 'rename', id, label: 'Later name', revision: profile.revision })
    const bytes = await readFile(path)
    expect((await run({ operation: 'inspect', operationId: 'process-original' })).receipt).toEqual(original.creation.receipt)
    expect((await run({ operation: 'browser.profile.create', operationId: 'process-original', label: 'Original identity' })).creation.receipt).toEqual(original.creation.receipt)
    expect(await readFile(path)).toEqual(bytes)
    const store = new BrowserProfileStore(path), snapshot = await store.list()
    const folderRequest = { operation: 'browser.profile.folder.create' as const, operationId: 'folder-process-original', label: 'Original folder', expectedRevision: snapshot.revision }
    const folder = await run(folderRequest)
    await run({ operation: 'remove-folder', id: folder.creation.receipt.createdId, revision: folder.snapshot.revision })
    expect(await run({ operation: 'inspect', operationId: folderRequest.operationId })).toMatchObject({ receipt: folder.creation.receipt,
      current: { state: 'removed', createdId: folder.creation.receipt.createdId } })
    const concurrent = await Promise.all(['same-name-one','same-name-two'].map(operationId => store.createIdentity({ operation: 'browser.profile.create', operationId, label: 'Same concurrent name' }, actor)))
    expect(new Set(concurrent.map(value => value.creation.receipt!.createdId)).size).toBe(2)
    expect((await store.list()).profiles.filter(value => value.label === 'Same concurrent name')).toHaveLength(2)
    facts.push({ scenario: 'real-owner-process-reopen', operationId: 'process-original', createdId: id, renamePreservedReceipt: true, removedFolderPreservedReceipt: true, sameLabelDistinctIds: concurrent.map(value => value.creation.receipt!.createdId) })
  })

  it('the real client pending algorithm and original Desktop document survive a process reopen without another creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-profile-creation-pending-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const metadata = join(root, 'browser-profiles.json'), document = join(root, 'workbench.json'), bundle = join(root, 'original-client.mjs')
    await writeFile(document, JSON.stringify({ state: { originalDraft: 'retained later input' }, version: 1 }))
    const { symlink } = await import('node:fs/promises')
    await symlink(join(process.cwd(), 'apps/desktop/node_modules'), join(root, 'node_modules'), 'dir')
    const source = (name: string) => join(import.meta.dirname, '../src/', name)
    await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'profile-original-client.mjs', contents: `
      import {readFile} from 'node:fs/promises';
      import {WorkbenchUserStateStore} from ${JSON.stringify(source('main/workbench-user-state.ts'))};
      import {BrowserProfileStore} from ${JSON.stringify(source('main/browser-profile-store.ts'))};
      import {createProfileCreationClient} from ${JSON.stringify(source('renderer/src/lib/browser-profile-creations.ts'))};
      import {createWorkbenchUserDocument} from ${JSON.stringify(source('renderer/src/lib/workbench-user-storage.ts'))};
      const [metadata,document,mode,label]=process.argv.slice(2);const store=new BrowserProfileStore(metadata);await store.list();
      const actor=${JSON.stringify(actor)};let created=0;
      const storage={getItem:()=>null,length:0,key:()=>null,removeItem:()=>{},setItem:()=>{},clear:()=>{}};
      const nativeDocument=new WorkbenchUserStateStore(document);
      const owner=createWorkbenchUserDocument({readWorkbenchState:()=>nativeDocument.read(),
        importWorkbenchState:value=>nativeDocument.importIfAbsent(value),
        writeWorkbenchState:value=>nativeDocument.write(value)},()=>storage);
      const submit=createProfileCreationClient({createProfileIdentity:async input=>{created++;const result=await store.createIdentity(input,actor);
          if(mode==='lost')throw new Error('Injected lost original reply');return {revision:result.snapshot.revision,creation:result.creation}},
        inspectProfileCreation:async operationId=>{if(mode==='lost')throw new Error('Injected unavailable reader');return {revision:(await store.list()).revision,creation:await store.inspectCreation(operationId,actor)}}},owner);
      let result,error;try{result=await submit({operation:'browser.profile.create',label})}catch(cause){error=cause.message}
      process.stdout.write(JSON.stringify({result,error,created,document:JSON.parse(await readFile(document,'utf8')),profiles:(await store.list()).profiles}));
    ` }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', define: { __AGENTMUX_WEB_PREVIEW__: 'false' },
      plugins: [{ name: 'original-client-host-ports', setup(builder: any) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'private-port' }))
        builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'private-port' }))
        builder.onLoad({ filter: /.*/, namespace: 'private-port' }, (args: any) => ({ contents: args.path === 'electron'
          ? 'export const app={getPath:()=>process.cwd()}' : 'export const api={ui:{},browser:{}}' }))
      } }] })
    const execute = promisify(execFile), run = async (mode: string, label = 'Original unfinished creation') => JSON.parse((await execute(process.execPath,
      [bundle, metadata, document, mode, label])).stdout)
    const first = await run('lost')
    expect(first.created, JSON.stringify(first)).toBe(1); expect(first.error).toContain('awaiting confirmation')
    const pending = JSON.parse(first.document.desktopFragments.browserProfileCreations)['browser.profile.create']
    expect(pending).toMatchObject({ label: 'Original unfinished creation', operationId: expect.any(String) })
    const next = await run('reopen')
    expect(next.created).toBe(0)
    expect(next.result.creation.operationId).toBe(pending.operationId)
    expect(next.profiles).toHaveLength(2)
    expect(next.document.state).toEqual({ originalDraft: 'retained later input' })
    expect(JSON.parse(next.document.desktopFragments.browserProfileCreations)).toEqual({})
    // A different later draft does not get cleared or adopted as the older creation's payload.
    const again = await run('lost', 'Earlier proxy-free input')
    const later = await run('reopen', 'Keep later name input')
    expect(later.created).toBe(0); expect(later.error).toContain('Your later input is retained')
    expect(later.profiles).toHaveLength(3)
    expect(again.created).toBe(1)
    facts.push({ scenario: 'real-client-document-process-reopen', operationId: pending.operationId, createdId: next.result.creation.receipt.createdId, reopenedCreatedCalls: next.created, originalDraftPreserved: true, laterDifferentDraftNotConsumed: true })
  })

  it('keeps a compact exact receipt at ten thousand historical creations without putting history into ordinary lists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-profile-creation-cost-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'browser-profiles.json'), store = new BrowserProfileStore(path)
    const first = await store.createIdentity({ operation: 'browser.profile.create', operationId: 'cost-seed', label: 'Live original' }, actor)
    const metadata = JSON.parse(await readFile(path, 'utf8'))
    // Synthetic retained-history cost fixture; it does not claim ten thousand real Browser operations.
    metadata.creationReceipts = Array.from({ length: 10_000 }, (_, index) => ({ ...first.creation.receipt, operationId: 'cost-history-' + index, createdId: 'historical-' + index }))
    await writeFile(path, JSON.stringify(metadata))
    const start = performance.now()
    const created = await store.createIdentity({ operation: 'browser.profile.create', operationId: 'cost-measured-original', label: 'Measured new identity' }, actor)
    const saveMs = performance.now() - start
    const bytes = (await readFile(path)).byteLength, snapshot = await store.list()
    expect(snapshot.profiles).toHaveLength(3)
    expect(snapshot).not.toHaveProperty('creationReceipts')
    expect((await store.inspectCreation('cost-measured-original', actor)).receipt).toEqual(created.creation.receipt)
    facts.push({ scenario: 'synthetic-history-cost', historicalReceipts: 10_000, resultingMetadataBytes: bytes, realSingleCreationSaveMs: saveMs, ordinarySnapshotIncludesHistory: false })
  })
})
