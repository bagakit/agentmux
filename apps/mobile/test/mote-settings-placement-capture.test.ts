import { afterEach, expect, it } from 'vitest'
import { createServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { relative, resolve, basename, join } from 'node:path'
import { createMotePreferencesPlacementFixture } from '../../../packages/core/test/helpers/mote-preferences-placement'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'
import { runProbeProcess, stopProbeProcesses } from '../../desktop/scripts/probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), fixture = resolve(root, 'apps/mobile/scripts/fixtures/mobile-product-redesign')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild') as typeof import('esbuild')
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
async function body(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) }

it.runIf(process.env.MOBILE_SETTINGS_CAPTURE === '1').each(['original', 'remove-composing-enter-guard', 'do-not-retain-invalid-heartbeat'])(
  'captures actual Mobile settings through the private Host (%s)', async variant => {
  const directory = resolve(root, '.local/mote-settings-robustness/mobile-capture-' + randomUUID()), compiled = join(directory, 'compiled')
  await mkdir(compiled, { recursive: true })
  const host = await createMotePreferencesPlacementFixture(); closes.push(host.close)
  const originalCatalog = host.discovery.catalog
  let mode: 'pending' | 'failed' | 'ready' = 'pending', release!: () => void, loseNextReceipt = false
  const pending = new Promise<void>(accept => { release = accept })
  host.discovery.catalog = async () => {
    if (mode === 'pending') await pending
    if (mode === 'failed') throw Error('展示候选暂时不可用，原配置与 Agent 保留。')
    return originalCatalog()
  }
  closes.push(async () => { mode = 'ready'; release() })
  const calls: Array<{ method: string; params: unknown; result?: unknown; failure?: string }> = []
  const source = new Map<string, string>(), logs: string[] = []
  const receipt: Record<string, any> = { variant, passed: false, images: {}, source: {}, processes: [],
    boundary: 'Actual MobileMoteProfile/QuickEditor and original Modal, Sheet, CSS and DeviceWorkface in private Electron Chromium; original public Core RPC socket and Host Files CAS remain alive across both browser OS processes. The private source changes once outside Mobile. Discovery latency/failure and one lost HTTP response are controlled. This is not the user App, a physical phone, live model/native Agent recovery, an installation or proof that the original Main recovered.' }
  const sourceRead = async () => {
    const result = await host.rpc.call('space.mote.preferences.read', { kind: 'quick', target: host.target, includeChoices: false })
    if (result.kind !== 'quick' || result.status !== 'ready' || !result.defaults) throw Error('The original private Mote source must remain readable')
    return result
  }
  const fact = async () => {
    const current = await sourceRead()
    return { spaceId: host.target.spaceId, content: { ...host.target.expectedResource, zoneId: host.target.zoneId },
      quickMode: { status: 'saved', defaults: current.defaults, version: current.source?.result.status === 'read' ? current.source.result.document.revision : 'unwritten' }, conversation: null }
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://127.0.0.1')
      response.setHeader('Cache-Control', 'no-store')
      if (url.pathname === '/bootstrap') {
        const runtime = host.hosted.runtimeOwnerIdentity()
        expect(runtime.availability).toBe('connected'); expect(runtime.runtimeId).toBeTruthy()
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ target: host.target, runtime, hostId: runtime.runtimeId, fact: await fact() })); return
      }
      if (url.pathname === '/scenario') {
        const change = await body(request)
        if (change.catalog !== undefined) {
          if (!['pending', 'failed', 'ready'].includes(change.catalog)) throw Error('Invalid private discovery state')
          mode = change.catalog
          if (mode !== 'pending') release()
        }
        if (change.loseNextReceipt === true) loseNextReceipt = true
        if (change.changeOriginalSource === true) {
          await writeFile(host.motePath, await readFile(host.motePath, 'utf8') + '\nExternal source note kept by the original Host.\n')
        }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ mode, loseNextReceipt })); return
      }
      if (url.pathname === '/rpc') {
        const { method, params } = await body(request), controller = new AbortController()
        response.once('close', () => { if (!response.writableEnded) controller.abort() })
        const call = { method, params } as typeof calls[number]; calls.push(call)
        let result: unknown
        if (method === 'space.ls') {
          expect(params.target.spaceId).toBe(host.target.spaceId)
          result = { catalog: { motePresentation: [await fact()] } }
        } else if (method === 'space.mote.preferences.read' || method === 'space.mote.preferences.save') {
          expect(params.target).toEqual(host.target)
          result = await host.rpc.call(method, params, method.endsWith('.read') ? { signal: controller.signal } : {})
          call.result = result
          if (method === 'space.mote.preferences.save' && loseNextReceipt) {
            loseNextReceipt = false; call.failure = 'HTTP response lost after the original Host receipt'
            response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '原 Host 已处理，但这次保存回执未送达；请保留原请求核对。' })); return
          }
        } else if (method === 'space.state') result = await host.rpc.call('space.state', {}, { signal: controller.signal })
        else if (method === 'space.mote.dialogue.read') throw Error('This private fixture does not provide dialogue reading; the original Agent remains separate.')
        else throw Error('The private bridge does not permit this operation: ' + method)
        call.result = result
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result })); return
      }
      const file = url.pathname.slice(1) || 'index.html'
      if (basename(file) !== file) { response.writeHead(404).end(); return }
      const bytes = await readFile(join(compiled, file))
      response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }).end(bytes)
    } catch (error) {
      if (!response.destroyed) response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
    }
  })
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
  closes.push(async () => { release(); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Original private HTTP address required')
  const url = `http://127.0.0.1:${address.port}/index.html`
  receipt.origin = new URL(url).origin
  try {
    receipt.captureSource = Object.fromEntries(await Promise.all([
      'mote-settings-entry.tsx', 'mote-settings.cjs', 'product-main.cjs'
    ].map(async file => [relative(root, join(fixture, file)), sha(await readFile(join(fixture, file)))])))
    const built = await build({ absWorkingDir: root, entryPoints: [join(fixture, 'mote-settings-entry.tsx')], outdir: compiled, bundle: true,
      format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true,
      plugins: [{ name: 'original-mobile-settings-sources', setup(plugin) {
        plugin.onResolve({ filter: /^@agentmux\// }, args => {
          if (args.path === '@agentmux/identity/runtime-source') return { path: require.resolve(args.path) }
          const file = workspaceSourceExport(root, args.path); return file ? { path: file } : undefined
        })
        plugin.onLoad({ filter: /\.(?:ts|tsx|css)$/ }, async args => {
          const file = relative(root, args.path)
          if (!file.startsWith('apps/mobile/') && !file.startsWith('packages/client-ui/') && !file.startsWith('packages/core/')) return
          const bytes = await readFile(args.path); source.set(file, sha(bytes))
          let contents = bytes.toString()
          const replacement = variant === 'remove-composing-enter-guard' && file === 'apps/mobile/src/navigation/MobileMoteQuickEditor.tsx'
            ? ["if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)) event.preventDefault()", '']
            : variant === 'do-not-retain-invalid-heartbeat' && file === 'apps/mobile/src/navigation/useMoteQuickDraft.ts'
              ? ['void retain({ ...current.current, invalidHeartbeatInput: value })', 'display({ ...current.current, invalidHeartbeatInput: value })']
              : null
          if (replacement) {
            expect(contents.split(replacement[0]!)).toHaveLength(2)
            contents = contents.replace(replacement[0]!, replacement[1]!)
            receipt.loadedMutation = { file, original: sha(bytes), changed: sha(contents) }
            expect(receipt.loadedMutation.changed).not.toBe(receipt.loadedMutation.original)
          }
          return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.css') ? 'css' : 'ts', resolveDir: resolve(args.path, '..') }
        })
      } }], loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
    for (const file of Object.keys(built.metafile!.inputs)) if (!file.startsWith('(disabled):') && !file.startsWith('<define:')) {
      const bytes = await readFile(resolve(root, file)); receipt.source[file] = sha(bytes)
    }
    await writeFile(join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="mote-settings-entry.css"></head><body><div id="root"></div><script type="module" src="mote-settings-entry.js"></script></body></html>')
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    for (const phase of variant === 'original' ? ['initial', 'restore'] : ['initial']) {
      const processReceipt = await runProbeProcess(require('electron'), [join(fixture, 'product-main.cjs'), url, directory, 'mote-settings-placement', phase],
        { cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
      receipt.processes.push(processReceipt)
      await stopProbeProcesses(processReceipt.originalPid, directory)
      const result = JSON.parse(await readFile(join(directory, phase === 'restore' ? 'renderer-result-restored.json' : 'renderer-result.json'), 'utf8'))
      receipt[phase] = result
      expect(processReceipt.exitConfirmed).toBe(true)
      if (variant !== 'original') {
        expect(receipt.loadedMutation).toBeDefined()
        expect(processReceipt.exitCode).toBe(1)
        expect(result.passed).toBe(false)
        expect(result.error?.message).toContain(variant === 'remove-composing-enter-guard'
          ? 'The actual Quick settings form owns the composing Enter guard'
          : 'Closing the original Quick editor keeps the invalid heartbeat text')
        expect(calls.some(call => call.method === 'space.mote.preferences.save')).toBe(false)
        receipt.passed = true
        return
      }
      expect(processReceipt.exitCode, result.error?.message).toBe(0)
      expect(result.passed, result.error?.message).toBe(true)
      for (const image of result.images) receipt.images[relative(root, join(directory, image))] = sha(await readFile(join(directory, image)))
    }
    expect(receipt.initial.environment.pid).not.toBe(receipt.restore.environment.pid)
    const before = receipt.initial.operations.find((value: any) => value.action === 'original-device-settings-retained')
    const after = receipt.restore.operations.find((value: any) => value.action === 'original-device-settings-restored')
    expect(before).toBeDefined(); expect(after).toBeDefined()
    for (const key of ['record', 'recordId', 'host']) expect(after[key]).toEqual(before[key])
    const saves = calls.filter(call => call.method === 'space.mote.preferences.save')
    expect(saves).toHaveLength(3)
    for (const save of saves) {
      expect(save.params).not.toHaveProperty('destination')
      expect(save.params).not.toHaveProperty('values.invalidHeartbeatInput')
    }
    expect(saves[1]!.result).toMatchObject({ status: 'refused-before-write', source: null })
    expect(saves[2]!.failure).toBe('HTTP response lost after the original Host receipt')
    expect(await readFile(host.motePath, 'utf8')).toContain('External source note kept by the original Host.')
    const final = await sourceRead()
    expect(final.defaults!.presence?.intervalMs).toBe(1020000)
    expect(final.defaults!.conversation).toEqual(host.defaults.conversation)
    expect(final.defaults!.conversationRevision).toBe(host.defaults.conversationRevision)
    expect(final.maintenance?.schedule).toEqual(host.paused)
    expect(host.transitions).toEqual([]); expect(host.writes).toEqual([]); expect(host.inner.kernel.stop).not.toHaveBeenCalled()
    receipt.sourceDrift = []
    for (const [file, digest] of source) if (sha(await readFile(resolve(root, file))) !== digest) receipt.sourceDrift.push(file)
    expect(receipt.sourceDrift).toEqual([])
    receipt.originalHost = { target: host.target, final, saves, inputWrites: host.writes, transitions: host.transitions }
    receipt.passed = true
  } catch (error) {
    receipt.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
    throw error
  } finally {
    receipt.calls = calls
    receipt.compiled = Object.fromEntries(await Promise.all((await readdir(compiled)).map(async file => [file, sha(await readFile(join(compiled, file)))])))
    await writeFile(join(directory, 'renderer.log'), logs.join('\n'))
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    const latest = variant === 'original' ? 'mobile-capture-latest.json' : `mobile-capture-${variant}-latest.json`
    await writeFile(resolve(root, '.local/mote-settings-robustness', latest), JSON.stringify({ path: relative(root, directory), passed: receipt.passed }) + '\n')
    await rm(compiled, { recursive: true, force: true })
    if (receipt.processes.length && receipt.processes.every((value: any) => value.exitConfirmed)) {
      await rm(join(directory, 'userData'), { recursive: true, force: true })
      receipt.profileCleanup = { removed: true, reason: 'All private original OS processes confirmed exit; original PNG and receipts retained' }
      await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    }
  }
})
