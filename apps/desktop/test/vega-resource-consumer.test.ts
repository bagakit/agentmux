// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import ts from 'typescript'
import { LocalExecutionHost, SshExecutionHost } from '../../../packages/core/src/execution-host'
import { runProcess } from '../../../packages/core/src/process-runner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FilePreviewResources } from '../src/main/file-preview-resources'
import { assertSenderTrusted, senderTrust, type PrivilegedChannel } from '../src/main/ipc-sender-trust'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { WORKSPACE_FILE_MAX_BYTES } from '../src/shared/workspace-file-bytes'
import { previewVisibility } from './helpers/preview-visibility'

const bridge = vi.hoisted(() => ({
  api: null as any, config: { workspaces: [] as any[] }, listeners: new Set<(...args: any[]) => void>(),
  pauseNative: false, pauseRemote: false, releases: new Map<number, () => void>(), remote: [] as Array<import('node:child_process').ChildProcess>, native: [] as Array<import('node:child_process').ChildProcess>, closed: [] as Promise<void>[],
}))
const processProbe = await vi.hoisted(async () => {
  const { default: native } = await import('node:child_process')
  const { syncBuiltinESMExports } = await import('node:module')
  const spawn = native.spawn
  native.spawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    const isNative = args[1]?.[0] === '--workspace-file'
    const isRemoteRead = args[0] === '/bin/sh' && args[1]?.[1]?.includes('agentmux-bounded-read')
    if (isNative || isRemoteRead) {
      (isNative ? bridge.native : bridge.remote).push(child)
      bridge.closed.push(new Promise<void>(resolve => child.once('close', () => resolve())))
      if (isNative && bridge.pauseNative || isRemoteRead && bridge.pauseRemote) {
        if (isNative) bridge.pauseNative = false
        else bridge.pauseRemote = false
        const end = child.stdin!.end.bind(child.stdin)
        child.stdin!.end = (() => child.stdin) as typeof child.stdin.end
        bridge.releases.set(child.pid!, () => { child.stdin!.end = end; end('') })
        child.once('close', () => bridge.releases.delete(child.pid!))
      }
    }
    return child
  }) as typeof spawn
  syncBuiltinESMExports()
  return { restore() { native.spawn = spawn; syncBuiltinESMExports() } }
})
afterAll(() => processProbe.restore())
vi.mock('../src/renderer/src/lib/api', () => ({ api: { files: {
  readPreviewResource: (...args: any[]) => bridge.api.readPreviewResource(...args),
  cancelPreviewResource: (...args: any[]) => bridge.api.cancelPreviewResource(...args)
} } }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore:
  Object.assign((selector: (state: unknown) => unknown) => selector({ config: bridge.config }), {
    getState: () => ({ config: bridge.config }),
    subscribe: (listener: (...args: any[]) => void) => { bridge.listeners.add(listener); return () => bridge.listeners.delete(listener) }
  })
}))
import { createWorkspaceVegaLoader } from '../src/renderer/src/lib/file-formats/workspace-vega-loader'
import { VegaFilePreview } from '../src/renderer/src/components/file-preview/VegaFilePreview'

const roots: string[] = [], disposals: Array<() => void> = []
afterEach(async () => {
  disposals.splice(0).forEach(dispose => dispose())
  for (const child of [...bridge.native, ...bridge.remote]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await Promise.all(bridge.closed.splice(0))
  bridge.native.length = 0; bridge.remote.length = 0; bridge.pauseNative = false; bridge.pauseRemote = false; bridge.releases.clear()
  expect(bridge.listeners.size).toBe(0)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function fixture(remote = false, injectRead?: (script: string) => string) {
  const base = await mkdtemp(join(tmpdir(), 'amx-vega-resource-')); roots.push(base)
  const path = join(base, 'workspace'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: 'original', name: 'Original', hostId: remote ? 'private-ssh' : 'local', kind: 'folder', path }
  bridge.config = { workspaces: [workspace] }
  const transport = vi.fn(async (_command: string, args: readonly string[], options: any) => {
    // Real SshExecutionHost serializes the remote invocation and forwards its
    // cancellation to the real process runner. Only the network hop is private.
    return runProcess('/bin/sh', ['-c', (bridge.pauseRemote ? 'read marker; ' : '') + args.at(-1)!], options)
  })
  const host = remote ? new SshExecutionHost({ id: workspace.hostId, hostname: 'private-fixture', runner: transport }) : new LocalExecutionHost()
  if (injectRead) {
    const run = host.run.bind(host)
    vi.spyOn(host, 'run').mockImplementation((command, args, options) => run(command,
      command === 'sh' && args[2] === 'agentmux-bounded-read' ? [args[0]!, injectRead(args[1]!), ...args.slice(2)] : args, options))
  }
  const files = new WorkspaceFiles(() => host), resources = new FilePreviewResources(files, id => bridge.config.workspaces.find(item => item.id === id))
  disposals.push(() => resources.dispose())
  const { api, handlers, sender, mainFrame } = productionBridge(resources)
  bridge.api = api
  const controller = new AbortController(), loader = createWorkspaceVegaLoader(workspace.id, 'charts/spec.vega', controller.signal)
  disposals.push(() => loader.dispose())
  return { base, path, workspace, files, resources, loader, controller, transport, handlers, sender, mainFrame, api }
}

function productionBridge(resources: FilePreviewResources) {
  const mainFrame = {}, sender = {}, handlers: Record<string, (...args: any[]) => Promise<any>> = {}
  const source = ts.createSourceFile('ipc.ts', readFileSync(join(import.meta.dirname, '../src/main/ipc.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'handleWithEvent' && ts.isStringLiteral(node.arguments[0]!) &&
      ['files:readPreviewResource', 'files:cancelPreviewResource'].includes(node.arguments[0].text)) {
      const channel = node.arguments[0].text; expect(handlers[channel]).toBeUndefined()
      const callback = ts.transpile(`(${node.arguments[1]!.getText(source)})`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
      handlers[channel] = new Function('requireTrustedSender', 'args', 'previewResources', `return ${callback}`)(
        (name: PrivilegedChannel, event: { sender: unknown }) => assertSenderTrusted(senderTrust(name, event.sender, sender)),
        { window: { webContents: { mainFrame } } }, resources)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(Object.keys(handlers).sort()).toEqual(['files:cancelPreviewResource', 'files:readPreviewResource'])
  const preload = ts.createSourceFile('preload.ts', readFileSync(join(import.meta.dirname, '../src/preload/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const objects: string[] = []
  function preloadVisit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(preload) === 'files' && ts.isObjectLiteralExpression(node.initializer)) objects.push(node.initializer.getText(preload))
    ts.forEachChild(node, preloadVisit)
  }
  preloadVisit(preload); expect(objects).toHaveLength(1)
  const compiled = ts.transpile(`(${objects[0]})`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  const api = new Function('ipcRenderer', `return ${compiled}`)({ invoke: async (channel: string, ...args: unknown[]) => {
    expect(handlers[channel]).toBeTypeOf('function')
    return structuredClone(await handlers[channel]!({ sender, senderFrame: mainFrame }, ...args))
  } })
  return { api, handlers, sender, mainFrame }
}

it('real loader→preload→registered Main→native bytes reads data/images, rejects allocation before payload, keeps ordinary Source and root boundaries', async () => {
  const f = await fixture()
  await writeFile(join(f.path, 'points.csv'), 'x,y\n1,2')
  await writeFile(join(f.path, 'points.json'), '[{"x":1}]')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg==', 'base64')
  await writeFile(join(f.path, 'plot.png'), png)
  expect(await f.loader.load('../points.csv')).toBe('x,y\n1,2')
  expect(await f.loader.load('../points.json')).toBe('[{"x":1}]')
  expect(await f.loader.sanitize('../plot.png', { context: 'image' })).toEqual({ href: '../plot.png', bytes: new Uint8Array(png), mimeType: 'image/png' })
  const costs: number[] = [], actualRead = f.files.read.bind(f.files)
  vi.spyOn(f.files, 'read').mockImplementation((owner, path, budget) => actualRead(owner, path, budget && { ...budget, onReadCost: cost => costs.push(cost.payloadBytes) }))
  const large = Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1, 97)
  await writeFile(join(f.path, 'large.csv'), large)
  await expect(f.loader.load('../large.csv')).rejects.toThrow(/byte|budget|limit/i)
  expect(costs).toEqual([0])
  const ordinary = await f.files.read(f.workspace, 'large.csv')
  expect(ordinary.status).toBe('read')
  if (ordinary.status === 'read') expect(ordinary.document.content.length).toBe(large.length)
  await writeFile(join(f.base, 'outside.csv'), 'secret')
  await symlink(join(f.base, 'outside.csv'), join(f.path, 'link.csv'))
  await expect(f.loader.load('../link.csv')).rejects.toThrow(/escapes/)
  expect(await f.files.read(f.workspace, 'link.csv')).toMatchObject({ status: 'read', document: { content: 'secret' } })
  await expect(f.loader.load('../../outside.csv')).rejects.toThrow(/leaves/)
  expect(await readFile(join(f.path, 'points.csv'), 'utf8')).toBe('x,y\n1,2')
})

it('actual Vega component and Worker resource port consume original bytes, expose budget errors for retry and cancel the real reader on hide', async () => {
  const f = await fixture()
  await writeFile(join(f.path, 'points.csv'), 'x,y\n1,2')
  await writeFile(join(f.path, 'large.csv'), Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1, 97))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  previewVisibility()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const workers: Array<{ onmessage: ((event: { data: unknown }) => void) | null; messages: any[]; terminate: ReturnType<typeof vi.fn> }> = []
  // Substitute only the unchanged chart engine. The actual component, Worker
  // protocol consumer, loader, preload, Main callback and bytes owner execute.
  vi.stubGlobal('Worker', class {
    onmessage = null; onerror = null; messages: any[] = []; terminate = vi.fn()
    constructor() { workers.push(this) }
    postMessage(value: unknown) { this.messages.push(value) }
  })
  const container = document.createElement('div'), root = createRoot(container)
  const draft = '{"data":[{"url":"../points.csv"}]}'
  const render = (visible = true) => act(async () => root.render(createElement(VegaFilePreview,
    { content: draft, path: 'charts/spec.vega', workspaceId: f.workspace.id, mode: 'vega', visible })))
  try {
    await render()
    expect(workers).toHaveLength(1)
    const first = workers[0]!
    expect(first.messages[0]).toMatchObject({ action: 'start', content: draft })
    first.onmessage!({ data: { resource: { id: 1, method: 'load', args: ['../points.csv'] } } })
    await expect.poll(() => first.messages.find(message => message.action === 'resource' && message.id === 1)?.value).toBe('x,y\n1,2')
    await act(async () => {
      first.onmessage!({ data: { resource: { id: 2, method: 'load', args: ['../large.csv'] } } })
      await expect.poll(() => first.terminate.mock.calls.length).toBe(1)
    })
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/budget|byte|limit/i)
    expect(container.textContent).not.toContain('Error invoking remote method')
    await act(async () => container.querySelector('button')!.click())
    expect(workers).toHaveLength(2)
    const second = workers[1]!, previousReaders = bridge.native.length
    bridge.pauseNative = true
    second.onmessage!({ data: { resource: { id: 3, method: 'load', args: ['../points.csv'] } } })
    await expect.poll(() => bridge.native.length).toBe(previousReaders + 1)
    const child = bridge.native.at(-1)!
    await render(false)
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 1500 }).toBe(true)
    expect(second.terminate).toHaveBeenCalledOnce()
    expect(container.children).toHaveLength(0)
    expect(await readFile(join(f.path, 'points.csv'), 'utf8')).toBe('x,y\n1,2')
  } finally { await act(async () => root.unmount()) }
})

it.each(['data', 'image'] as const)('abort reaches the exact in-flight native %s reader, closes its process, and keeps unrelated reads usable', async kind => {
  const f = await fixture()
  await writeFile(join(f.path, 'points.csv'), 'x,y\n1,2')
  await writeFile(join(f.path, 'plot.png'), Buffer.from('iVBORw0KGgo=', 'base64'))
  bridge.pauseNative = true
  const pending = kind === 'data' ? f.loader.load('../points.csv') : f.loader.sanitize('../plot.png', { context: 'image' })
  const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }))
  await expect.poll(() => bridge.native.length, { timeout: 1500 }).toBeGreaterThan(0)
  const child = bridge.native.at(-1)!
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull()
  f.controller.abort()
  await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 1500 }).toBe(true)
  const result = await outcome; expect(result.error).toBeInstanceOf(Error)
  await Promise.all(bridge.closed)
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  await expect(f.resources.read({ id: 'unrelated', workspaceId: f.workspace.id, path: 'points.csv', kind: 'data' })).resolves.toEqual({ kind: 'data', content: 'x,y\n1,2' })
  expect((f.resources as any).reads.size).toBe(0)
})

it('preserves small remote CSV through actual SSH command/Host transport with a producer and receiver byte cap', async () => {
  const f = await fixture(true)
  await writeFile(join(f.path, 'points.csv'), 'x,y\n1,2')
  await writeFile(join(f.path, '-points.csv'), 'x,y\n3,4')
  expect(await f.loader.load('../points.csv')).toBe('x,y\n1,2')
  await expect(f.loader.load('../-points.csv')).resolves.toBe('x,y\n3,4')
  const read = f.transport.mock.calls.find(([, args]) => args.at(-1)?.includes('agentmux-bounded-read'))!
  expect(read).toBeDefined(); expect(read[2].signal).toBeInstanceOf(AbortSignal)
  expect(read[2].maxOutputBytes).toBe(4 * 1024 * 1024 + 1)
  await writeFile(join(f.path, 'large.csv'), Buffer.alloc(4 * 1024 * 1024 + 1, 97))
  await expect(f.loader.load('../large.csv')).rejects.toThrow(/budget/)
  expect(await f.transport.mock.results.at(-1)!.value).toMatchObject({ stdout: '', exitCode: 4 })
})

it('remote file growth after fstat is producer-bounded and cannot cross the receiving transfer budget', async () => {
  const f = await fixture(true, script => {
    const anchor = 'if [ "$size" -gt "$limit" ]; then exit 4; fi'
    expect(script.split(anchor)).toHaveLength(2)
    return script.replace(anchor, `${anchor}\nhead -c 8388608 /dev/zero | tr '\\000' x > "$name"`)
  })
  await writeFile(join(f.path, 'points.csv'), 'x,y\n1,2')
  await expect(f.loader.load('../points.csv')).rejects.toThrow(/budget/)
  const response = await f.transport.mock.results.at(-1)!.value
  expect(response.exitCode).toBe(0)
  expect(Buffer.byteLength(response.stdout)).toBe(4 * 1024 * 1024 + 1)
})

it.each(['final-before-open', 'final-after-open', 'final-before-read', 'ancestor-before-cd', 'ancestor-after-pin'] as const)(
  'remote pinned-fd reader resists %s without reopening the checked pathname', async stage => {
    let outside = ''
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    const f = await fixture(true, script => {
      // Inject an actual filesystem change at a production read boundary. The
      // production script, real SSH serializer and real subprocess still run.
      const open = 'exec 3< "$name" || exit $?'
      const beforeRead = 'if [ "$size" -gt "$limit" ]; then exit 4; fi'
      const swapFile = `mv -- "$name" "$name.previous"; ln -s ${quote(join(outside, 'points.csv'))} "$name"`
      const swapParent = `mv -- "$parent" ${quote(join(outside, 'original-parent'))}; ln -s ${quote(outside)} "$parent"`
      const anchor = stage.startsWith('final-') ? stage === 'final-before-read' ? beforeRead : open
        : stage === 'ancestor-before-cd' ? 'cd -P -- "$parent" || exit $?' : '[ ! -L "$name" ] || escape\nif [ -d "$name" ]; then exit 3; fi'
      expect(script.split(anchor)).toHaveLength(2)
      const change = stage.startsWith('final-') ? swapFile : swapParent
      return script.replace(anchor, stage === 'final-before-open' || stage.startsWith('ancestor-')
        ? `${change}\n${anchor}` : `${anchor}\n${change}`)
    })
    outside = join(f.base, 'outside'); await mkdir(outside)
    await writeFile(join(outside, 'points.csv'), 'outside-secret')
    await mkdir(join(f.path, 'data')); await writeFile(join(f.path, 'data/points.csv'), 'x,y\n1,2')
    const read = f.loader.load('../data/points.csv')
    if (stage === 'final-before-read' || stage === 'ancestor-after-pin') expect(await read).toBe('x,y\n1,2')
    else await expect(read).rejects.toThrow(/changed|escapes/)
    expect(await readFile(join(outside, 'points.csv'), 'utf8')).toBe('outside-secret')
  })

it('production privileged read/cancel registrations refuse another sender and a subframe, before owner effects', async () => {
  const f = await fixture(), read = vi.spyOn(f.resources, 'read'), cancel = vi.spyOn(f.resources, 'cancel')
  for (const channel of ['files:readPreviewResource', 'files:cancelPreviewResource']) {
    await expect(f.handlers[channel]!({ sender: {}, senderFrame: f.mainFrame }, 'id')).rejects.toThrow(/Untrusted/)
    await expect(f.handlers[channel]!({ sender: f.sender, senderFrame: {} }, 'id')).rejects.toThrow(/original application frame/)
  }
  expect(read).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
})

it('cancels only the requested reader while a second native resource remains live and can finish', async () => {
  const f = await fixture()
  await writeFile(join(f.path, 'points.csv'), 'x,y\n1,2')
  bridge.pauseNative = true
  const first = f.loader.load('../points.csv').then(value => ({ value }), error => ({ error }))
  await expect.poll(() => bridge.native.length).toBe(1)
  const secondController = new AbortController(), secondLoader = createWorkspaceVegaLoader(f.workspace.id, 'chart.vega', secondController.signal)
  disposals.push(() => secondLoader.dispose())
  bridge.pauseNative = true
  const second = secondLoader.load('points.csv').then(value => ({ value }), error => ({ error }))
  await expect.poll(() => bridge.native.length).toBe(2)
  const [one, two] = bridge.native
  f.controller.abort()
  await expect.poll(() => one!.signalCode !== null || one!.exitCode !== null).toBe(true)
  expect('error' in await first).toBe(true)
  expect(two!.signalCode).toBeNull(); expect(two!.exitCode).toBeNull()
  bridge.releases.get(two!.pid!)!()
  expect(await second).toEqual({ value: 'x,y\n1,2' })
})

it('remote abort reaches the real Host transport process and leaves no live resource reader', async () => {
  const f = await fixture(true)
  await writeFile(join(f.path, 'points.csv'), 'x,y\n1,2')
  bridge.pauseRemote = true
  const outcome = f.loader.load('../points.csv').then(value => ({ value }), error => ({ error }))
  await expect.poll(() => bridge.remote.length).toBe(1)
  const child = bridge.remote[0]!
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull()
  f.controller.abort()
  await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 1500 }).toBe(true)
  expect('error' in await outcome).toBe(true)
  expect((f.resources as any).reads.size).toBe(0)
})

it('Workspace rebinding away and back cancels the original actual reader before any replacement can consume its bytes', async () => {
  const f = await fixture()
  await writeFile(join(f.path, 'points.csv'), 'x,y\n1,2')
  bridge.pauseNative = true
  const outcome = f.loader.load('../points.csv').then(value => ({ value }), error => ({ error }))
  await expect.poll(() => bridge.native.length).toBe(1)
  const child = bridge.native[0]!, before = { config: bridge.config }
  bridge.config = { workspaces: [{ ...f.workspace, path: f.base }] }
  for (const listener of bridge.listeners) listener({ config: bridge.config }, before)
  const changed = { config: bridge.config }; bridge.config = before.config
  for (const listener of bridge.listeners) listener({ config: bridge.config }, changed)
  await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 1500 }).toBe(true)
  expect('error' in await outcome).toBe(true)
  await expect(f.loader.load('../points.csv')).rejects.toThrow(/Workspace changed/)
})
