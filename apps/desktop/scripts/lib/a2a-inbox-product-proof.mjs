import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { inspect, isDeepStrictEqual, promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { listProbeProcesses, stopProbeProcesses, signalOwnedProbeProcess, runProbeProcess } from '../probe-process.mjs'

const exec = promisify(execFile), require = createRequire(import.meta.url)
export const a2aProofSha = bytes => createHash('sha256').update(bytes).digest('hex')

/** This one negative UI assertion requires successful original reads, never an unopened or failed empty face. */
export function assertA2aReferenceUserReading(reading, recipient, nativeSource, notification) {
  assert.deepEqual(reading.reference, { hostId: 'local', agentSessionId: recipient.agentSessionId })
  assert.equal(reading.mailbox.agentSessionId, recipient.agentSessionId)
  assert.ok(reading.mailbox.queueId)
  assert.equal(reading.mailbox.coverage.kind, 'recorded-inputs')
  assert.ok(reading.mailbox.items.every(entry => entry.kind === 'item' && !entry.item.failure))
  const original = reading.mailbox.items.find(entry => entry.item.kind === 'submission' &&
    isDeepStrictEqual(entry.item.key, notification.key))?.item
  assert.ok(original, 'The actual input inventory must retain this exact original platform input')
  assert.deepEqual(original.record.admission.inputKey, notification.key)
  assert.equal(original.record.admission.intent.prompt, notification.wire)
  assert.equal(original.record.admission.intent.message.a2aNotificationId, notification.key.submissionId)
  assert.equal(original.record.admission.intent.message.systemContext, notification.wire)
  for (const receipt of reading.history) assert.equal(receipt.ok, true, 'Original history IPC read must succeed: ' + JSON.stringify(receipt))
  const history = reading.history.map(receipt => receipt.value)
  assert.deepEqual(history.map(page => page.source), ['captured', 'native'])
  for (const page of history) {
    assert.equal(page.hostId, 'local'); assert.equal(page.agentSessionId, recipient.agentSessionId)
    assert.equal(page.kind, 'user-message'); assert.ok(Array.isArray(page.userMessages))
    assert.ok(['available', 'empty'].includes(page.availability)); assert.equal(page.scan.complete, true)
  }
  assert.deepEqual(history[1].nativeSource, nativeSource)
  assert.equal(reading.view.busy, 'false'); assert.ok(reading.view.busyTransitions.includes('true'))
  assert.equal(reading.view.inputScope, JSON.stringify(['local', recipient.agentSessionId]))
  assert.equal(reading.view.sourceCount, 2)
  assert.ok(reading.view.coverage.some(text => text.includes('Available history checked for this read.')))
  assert.deepEqual(reading.view.errors, [])
}
/** A one-way stop fence closes the spawn/registration race before ending an Inspector owner. */
export const a2aPrivateMainPaths = root => ({ registry: join(root, 'private-main-lifecycle.json'), stop: join(root, 'private-main-stop-request') })
export async function stopPrivateA2aMains(root) {
  const paths = a2aPrivateMainPaths(root)
  await writeFile(paths.stop, 'Stop requested before the original Inspector owner may exit.\n')
  const deadline = Date.now() + 5_000
  let launches
  for (;;) {
    try {
      const record = JSON.parse(await readFile(paths.registry, 'utf8'))
      assert.equal(record.schema, 'agentmux.private-a2a-launches.v1'); launches = record.launches
      assert.ok(Array.isArray(launches))
    } catch (error) { if (error.code !== 'ENOENT') throw error; launches = [] }
    if (!launches.some(launch => ['launching', 'unconfirmed'].includes(launch.phase))) break
    assert.ok(Date.now() < deadline, 'Original private Main launch registration remains unknown; retain its Inspector owner')
    await new Promise(done => setTimeout(done, 25))
  }
  const stopped = []
  for (const launch of launches) {
    assert.ok(['spawned', 'cancelled', 'not-spawned'].includes(launch.phase))
    if (launch.phase !== 'spawned') { assert.equal(launch.pid, null); continue }
    assert.ok(Number.isInteger(launch.pid) && launch.pid > 0)
    await signalOwnedProbeProcess(launch.pid, root, 'SIGKILL')
    while (await signalOwnedProbeProcess(launch.pid, root, 0)) {
      assert.ok(Date.now() < deadline, 'Original private Main exit is unconfirmed; retain its Inspector owner')
      await new Promise(done => setTimeout(done, 25))
    }
    stopped.push({ pid: launch.pid, label: launch.label, exit: 'confirmed-absent-or-zombie' })
  }
  return { stopFence: paths.stop, stopped }
}
const hostServiceSource = 'apps/host/src/macos-service.ts'
function privateHostServiceModule(source, coreRoot) {
  const specifier = "from '@agentmux/core'"
  assert.equal(source.split(specifier).length, 2, 'The existing platform owner has one original Core dependency')
  return stripTypeScriptTypes(source, { mode: 'strip' }).replace(specifier, 'from ' + JSON.stringify(pathToFileURL(join(coreRoot, 'dist/index.js')).href))
}
async function preparePrivateHostService({ root, privateRoot, execution, sourceCommit }) {
  const bytes = await readFile(join(root, hostServiceSource))
  const fixed = (await exec('git', ['show', sourceCommit + ':' + hostServiceSource], { cwd: root, encoding: 'buffer' })).stdout
  assert.equal(a2aProofSha(bytes), a2aProofSha(fixed), 'Use the existing platform owner from the selected product source')
  const modulePath = join(privateRoot, 'private-host-service.mjs'), contents = privateHostServiceModule(bytes.toString(), execution.coreRoot)
  await writeFile(modulePath, contents)
  const owner = await import(pathToFileURL(modulePath).href)
  const runtime = join(privateRoot, 'runtime'), userData = join(privateRoot, 'user-data')
  const service = owner.macosHostService({ executable: execution.executable,
    entrypoint: join(execution.desktopRoot, 'out/main/agentmux-host.js'), storePath: join(userData, 'agent-sessions.json'),
    socketPath: join(runtime, 'control.sock'), mobileBuildDirectory: join(execution.desktopRoot, 'out/mobile'),
    configuration: { path: join(userData, 'agentmux.config.json'), connectorDirectory: join(userData, 'connectors') },
    workspaceMoveHelper: join(execution.desktopRoot, 'resources/bin/agentmux-workspace-move'), environment: {
      AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'),
      AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), AGENTMUX_SPATIAL_STATE_STORE: join(runtime, 'state/spatial-state.json') } })
  assert.equal(await owner.macosHostServiceRegistration(service), null, 'The exact private Host service must be absent before launch')
  return { source: hostServiceSource, coreRoot: execution.coreRoot, sourceSHA256: a2aProofSha(bytes), modulePath, moduleSHA256: a2aProofSha(contents),
    transformation: 'Node stripTypeScriptTypes for the harness owner only; not an original product compiler event', service }
}
export async function stopPrivateA2aHostService(record) {
  assert.equal(a2aProofSha(await readFile(record.modulePath)), record.moduleSHA256)
  const owner = await import(pathToFileURL(record.modulePath).href), service = record.service, privateRoot = dirname(record.modulePath)
  assert.equal(service.storePath, join(privateRoot, 'user-data/agent-sessions.json'))
  assert.equal(service.socketPath, join(privateRoot, 'runtime/control.sock'))
  assert.deepEqual({ label: service.label, target: service.target }, owner.macosHostServiceAddress(service.socketPath))
  assert.equal(service.plistPath, join(privateRoot, 'user-data', service.label + '.plist'))
  assert.ok(record.coreRoot.startsWith(privateRoot + '/'))
  let original = null
  if (await owner.macosHostServiceRegistration(service)) {
    original = await owner.inspectMacosHostService(service)
    await owner.stopMacosHostService(service, original)
  }
  assert.equal(await owner.macosHostServiceRegistration(service), null, 'The private Host service must stay unregistered')
  const { probeSocketLiveness } = await import(pathToFileURL(join(record.coreRoot, 'dist/index.js')).href)
  assert.equal(await probeSocketLiveness(service.socketPath), 'dead', 'The private Host endpoint exit must be confirmed')
  return { label: service.label, target: service.target, storePath: service.storePath, owner: original, status: 'unregistered', endpoint: 'confirmed-dead' }
}
const packages = ['core', 'demand', 'client-ui', 'layout', 'relay', 'identity', 'git', 'diagnostic-evidence', 'connectors']
const assets = ['packages/core/vendor', 'apps/desktop/vendor', 'apps/desktop/native', 'apps/desktop/brand', 'apps/desktop/browser-extension']
const owns = ['apps/desktop/src', 'apps/desktop/electron.vite.config.ts', 'apps/desktop/package.json',
  'apps/desktop/resources', 'apps/desktop/scripts/build-workspace-move-helper.mjs',
  'apps/desktop/scripts/radix-overlay-aliases.ts', 'apps/desktop/scripts/excalidraw-local-fonts.ts', 'apps/desktop/scripts/pdfjs-viewer-assets.ts', 'apps/desktop/scripts/file-diagram-assets.ts',
  'apps/host/src', 'apps/host/package.json', 'test/fixture-values.mjs', 'test/fixture-epoch.cjs',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.shared.json', 'patches',
  'packages/core/scripts/build.mjs', 'packages/core/scripts/clean-build.mjs', 'packages/core/bin', 'packages/core/native', 'packages/client-ui/scripts',
  ...assets, ...packages.flatMap(name => ['src', 'package.json', 'tsconfig.json', 'tsconfig.build.json'].map(path => 'packages/' + name + '/' + path))]
const fixturePaths = ['apps/desktop/scripts/lib/a2a-inbox-product-proof.mjs', 'apps/desktop/scripts/probe-process.mjs',
  'apps/desktop/scripts/fixtures/a2a-inbox-product/runtime.mjs', 'apps/desktop/scripts/fixtures/a2a-inbox-product/native-agent.mjs',
  'apps/desktop/scripts/fixtures/a2a-reference-reading/worker.mjs', hostServiceSource]
const nativeClipboardSources = ['apps/desktop/src/main/native-desktop-owner.ts', 'apps/desktop/src/main/native-desktop-ipc.ts', 'packages/native-desktop/src/client.ts']
const requiredLoaded = ['apps/desktop/src/main/index.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
  'apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
  'apps/desktop/src/renderer/src/components/MailboxReading.tsx', 'packages/client-ui/src/components/ConversationMessage.tsx',
  'packages/client-ui/src/components/ConversationInputText.tsx', 'packages/client-ui/src/components/InputMailboxRecords.tsx',
  'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/renderer/src/App.tsx', 'packages/client-ui/src/theme/runtime.ts',
  'packages/client-ui/src/components/ConversationView.tsx', 'packages/client-ui/src/components/CapturedConversationMessage.tsx',
  'packages/client-ui/src/components/ConversationResourceText.tsx']

/** One complete private product build for the current A2A reference-reading contract. */
export async function runA2aReferenceReadingProductProof({ root, evidence, testInputs = {} }) {
  root = await realpath(root); evidence = resolve(evidence, 'reference-product'); await mkdir(evidence, { recursive: true })
  const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const changes = (await exec('git', ['diff', sourceCommit, '--name-only', '--', ...owns], { cwd: root })).stdout.trim()
  assert.equal(changes, '', 'Commit the integrated product candidate before its private proof; no product overlay is accepted')
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), 'amx-a2-')))
  const product = { schema: 'agentmux.a2a-reference-product-proof.v1', preparation: { kind: 'source-build' }, stage: 'reading', prepared: false, passed: false, sourceRoot: root, sourceCommit,
    privateRoot, receiptPath: join(evidence, 'receipt.json'), sources: {}, testSourceJoin: testInputs, loaded: {}, compilerInputs: {}, compiled: {}, fixtures: {}, frames: [], cleanup: {},
    boundary: 'Actual complete Desktop/Main/preload/Renderer, public CLI, private ctxmux and authenticated synthetic native actor. Original Inbox body and typed independent reference notice. No live model, user Runtime, installed App, vendor idle-race or physical Mobile claim.' }
  const receiptPath = join(evidence, 'receipt.json')
  let failure
  const command = async (label, executable, args, cwd) => {
    try {
      const result = await exec(executable, args, { cwd, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, maxBuffer: 16 * 1024 * 1024 })
      await writeFile(join(evidence, label + '.log'), result.stdout + result.stderr)
    } catch (error) { await writeFile(join(evidence, label + '.log'), (error.stdout ?? '') + (error.stderr ?? '')); throw error }
  }
  try {
    // Copy the small tracked source closure. Large immutable assets remain read-only links;
    // their exact Git blob is checked now and again before accepting the resulting build.
    const entries = (await exec('git', ['ls-tree', '-r', '-z', sourceCommit, '--', ...owns], { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout.toString().split('\0').filter(Boolean)
    product.assets = []
    for (const path of assets) {
      const tree = (await exec('git', ['rev-parse', sourceCommit + ':' + path], { cwd: root })).stdout.trim()
      await mkdir(dirname(join(privateRoot, path)), { recursive: true }); await symlink(join(root, path), join(privateRoot, path))
      product.assets.push({ path, tree, mode: 'read-only-committed-asset-tree' })
    }
    for (const entry of entries) {
      const [header, path] = entry.split('\t'), [mode, type, oid] = header.split(' ')
      if (type !== 'blob') continue
      if (assets.some(prefix => path.startsWith(prefix + '/'))) continue
      const bytes = await readFile(join(root, path))
      assert.equal(createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'), oid, 'Exact committed input: ' + path)
      product.sources[path] = a2aProofSha(bytes)
      await mkdir(dirname(join(privateRoot, path)), { recursive: true }); await writeFile(join(privateRoot, path), bytes, { mode: mode === '100755' ? 0o755 : 0o644 })
    }
    assert.ok(Object.keys(product.sources).length > 100, 'Nonempty actual product closure')
    for (const path of fixturePaths) { const bytes = await readFile(join(root, path)); await mkdir(dirname(join(privateRoot, path)), { recursive: true }); await writeFile(join(privateRoot, path), bytes, { mode: 0o700 }); product.fixtures[path] = a2aProofSha(bytes) }
    // All internal packages stay local. External package and peer resolutions are the
    // installed lockfile inputs, linked read-only rather than downloaded or mutated.
    const yaml = require(require.resolve('yaml', { paths: [join(root, 'packages/core')] }))
    const lock = yaml.parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'))
    const pool = await realpath(join(root, 'node_modules/.pnpm')), poolEntries = await readdir(pool)
    product.dependencies = []
    for (const consumer of ['.', 'apps/desktop', 'apps/host', ...packages.map(name => 'packages/' + name)]) {
      const manifest = JSON.parse(await readFile(join(privateRoot, consumer, 'package.json'), 'utf8')), modules = join(privateRoot, consumer, 'node_modules')
      await mkdir(join(modules, '@agentmux'), { recursive: true })
      for (const name of packages) await symlink(join(privateRoot, 'packages', name), join(modules, '@agentmux', name))
      for (const section of ['dependencies', 'devDependencies']) for (const [name, specification] of Object.entries(manifest[section] ?? {})) {
        if (specification.startsWith('workspace:') || name === '@ctxmux/sdk') continue
        const locked = lock.importers?.[consumer]?.[section]?.[name]?.version; assert.equal(typeof locked, 'string', consumer + ':' + name)
        const version = locked.split('(')[0], prefix = name.replace('/', '+') + '@' + version
        const candidates = poolEntries.filter(entry => entry === prefix || entry.startsWith(prefix + '_'))
        let target
        if (candidates.length === 1) target = join(pool, candidates[0], 'node_modules', name)
        else {
          target = await realpath(join(root, consumer, 'node_modules', name))
          assert.ok(candidates.some(entry => target === join(pool, entry, 'node_modules', name)), 'Exact installed peer resolution: ' + consumer + ':' + name)
        }
        const bytes = await readFile(join(target, 'package.json')); assert.equal(JSON.parse(bytes).version, version)
        await mkdir(dirname(join(modules, name)), { recursive: true }); await symlink(target, join(modules, name))
        product.dependencies.push({ consumer, name, locked, target, sha256: a2aProofSha(bytes) })
      }
      await mkdir(join(modules, '.bin'), { recursive: true })
      for (const [name, bin] of [['typescript', 'tsc'], ['esbuild', 'esbuild']]) {
        const tool = require.resolve(name + '/package.json', { paths: [join(root, 'packages/core')] })
        const descriptor = JSON.parse(await readFile(tool, 'utf8')), executable = typeof descriptor.bin === 'string' ? descriptor.bin : descriptor.bin[bin]
        await symlink(join(dirname(tool), executable), join(modules, '.bin', bin))
      }
    }
    const vendor = join(privateRoot, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch)
    const manifestBytes = await readFile(join(vendor, 'manifest.json')), manifest = JSON.parse(manifestBytes)
    const contract = JSON.parse(await readFile(join(privateRoot, 'packages/core/src/ctxmux-artifact-contract.json'), 'utf8'))
    assert.equal(a2aProofSha(manifestBytes), contract.manifests[process.platform + '-' + process.arch])
    const archive = join(vendor, manifest.sdk.archive.path); assert.equal(a2aProofSha(await readFile(archive)), manifest.sdk.archive.sha256)
    const sdkRoot = join(privateRoot, '.proof-sdk'); await mkdir(sdkRoot); await exec('tar', ['-xzf', archive, '-C', sdkRoot])
    const sdk = join(sdkRoot, 'package'); await symlink(join(privateRoot, 'packages/core/node_modules'), join(sdk, 'node_modules'))
    for (const consumer of ['.', 'apps/desktop', 'apps/host', ...packages.map(name => 'packages/' + name)]) {
      await mkdir(join(privateRoot, consumer, 'node_modules/@ctxmux'), { recursive: true }); await symlink(sdk, join(privateRoot, consumer, 'node_modules/@ctxmux/sdk'))
    }
    product.ctxmux = { manifest: a2aProofSha(manifestBytes), sdkArchive: manifest.sdk.archive.sha256, source: manifest.source }
    for (const [name, config] of [['identity', 'tsconfig.json'], ['git', 'tsconfig.build.json'], ['diagnostic-evidence', 'tsconfig.json'], ['demand', 'tsconfig.build.json'], ['relay', 'tsconfig.json']])
      await command(name + '-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/' + name + '/' + config], privateRoot)
    await command('core-build', process.execPath, [join(privateRoot, 'packages/core/scripts/build.mjs')], privateRoot)
    for (const [name, config] of [['client-ui', 'tsconfig.build.json'], ['connectors', 'tsconfig.json']])
      await command(name + '-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/' + name + '/' + config], privateRoot)
    // Normal Desktop prebuild supplies its filesystem helper. Its output belongs
    // to this private resources directory, never the linked immutable asset trees.
    await command('workspace-helper-build', process.execPath, [join(privateRoot, 'apps/desktop/scripts/build-workspace-move-helper.mjs')], privateRoot)
    const original = await readFile(join(privateRoot, 'apps/desktop/src/main/index.ts'), 'utf8')
    const anchor = 'const window = new BrowserWindow({\n      ...windowConstructorGeometry(persistedGeometry),', placement = '    workbenchWindow = window'
    assert.equal(original.split(anchor).length, 2); assert.equal(original.split(placement).length, 2)
    const clipboardPath = join(evidence, 'clipboard.json')
    const privateInput = original.replace(anchor, anchor + '\n      show: false, focusable: false,').replace(placement,
      `    window.show = () => window.showInactive()\n    window.focus = () => {}\n    window.showInactive()\n${placement}`)
    product.windowOverlay = { owner: 'apps/desktop/src/main/index.ts', raw: a2aProofSha(original), compilerInput: a2aProofSha(privateInput), scope: 'Private nonactivating BrowserWindow presentation only; native clipboard isolation is applied separately to the original initialized owner through Inspector; no input/semantic/IPC logic replaced'  }
    const loadedPath = join(evidence, 'loaded.json'), compilerInputsPath = join(evidence, 'compiler-inputs.json'), configPath = join(privateRoot, 'apps/desktop/a2a-proof.vite.config.mjs')
    await writeFile(configPath, `import actual from './electron.vite.config.ts';import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import{relative}from'node:path';const root=${JSON.stringify(privateRoot)},loaded={},compilerInputs={};const plugin=()=>({name:'a2a-actual-product-input',enforce:'pre',async load(id){if(id.startsWith(root+'/')&&!id.includes('/node_modules/')&&!id.includes('?')){try{loaded[relative(root,id)]=createHash('sha256').update(await readFile(id)).digest('hex');compilerInputs[relative(root,id)]=loaded[relative(root,id)]}catch{}}if(id===root+'/apps/desktop/src/main/index.ts'){compilerInputs[relative(root,id)]=${JSON.stringify(a2aProofSha(privateInput))};return ${JSON.stringify(privateInput)}}},async closeBundle(){await writeFile(${JSON.stringify(loadedPath)},JSON.stringify(loaded,null,2));await writeFile(${JSON.stringify(compilerInputsPath)},JSON.stringify(compilerInputs,null,2))}});export default Object.fromEntries(Object.entries(actual).map(([key,value])=>[key,{...value,plugins:[plugin(),...(value.plugins??[])]}]));`)
    await command('desktop-build', process.execPath, [join(root, 'apps/desktop/node_modules/electron-vite/bin/electron-vite.js'), 'build', '--config', configPath], join(privateRoot, 'apps/desktop'))
    product.loaded = JSON.parse(await readFile(loadedPath, 'utf8')); product.compilerInputs = JSON.parse(await readFile(compilerInputsPath, 'utf8'))
    assert.equal(product.compilerInputs[product.windowOverlay.owner], product.windowOverlay.compilerInput)
    for (const path of requiredLoaded) assert.equal(product.loaded[path], product.sources[path], 'Actual product consumer compiled: ' + path)
    for (const directory of ['apps/desktop/out', 'apps/desktop/resources/bin', ...packages.map(name => 'packages/' + name + '/dist')]) {
      try { for (const entry of await readdir(join(privateRoot, directory), { recursive: true, withFileTypes: true })) if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name); product.compiled[relative(privateRoot, path)] = a2aProofSha(await readFile(path))
      } } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    assert.ok(product.compiled['apps/desktop/resources/bin/agentmux-workspace-move'], 'Actual Desktop filesystem helper is included in the private build')
    for (const [path, digest] of Object.entries(product.sources)) assert.equal(a2aProofSha(await readFile(join(root, path))), digest, 'Source stayed unchanged while building: ' + path)
    assert.equal((await exec('git', ['diff', sourceCommit, '--name-only', '--', ...assets], { cwd: root })).stdout.trim(), '', 'Immutable asset trees stayed committed during the build')
    product.execution = { kind: 'source-build', desktopRoot: join(privateRoot, 'apps/desktop'), coreRoot: join(privateRoot, 'packages/core'),
      mainEntry: join(privateRoot, 'apps/desktop/out/main/index.js'), executable: require('electron'), argv: [join(privateRoot, 'apps/desktop')],
      cli: { executable: join(privateRoot, 'packages/core/bin/amux'), argv: [] } }
    product.hostServiceOwner = await preparePrivateHostService({ root, privateRoot, execution: product.execution, sourceCommit: product.sourceCommit })
    await writeFile(join(privateRoot, 'host-service.json'), JSON.stringify(product.hostServiceOwner))
    await writeFile(join(privateRoot, 'execution.json'), JSON.stringify(product.execution))
    const workerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTMUX_') && !name.startsWith('CTXMUX_') && !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'CODEX_HOME'].includes(name)))
    workerEnvironment.HOME = join(privateRoot, 'home'); await mkdir(workerEnvironment.HOME)
    workerEnvironment.AGENTMUX_A2A_PROOF_BUILD = privateRoot
    workerEnvironment.AGENTMUX_A2A_PROOF_EXECUTION = join(privateRoot, 'execution.json')
    workerEnvironment.AGENTMUX_A2A_PROOF_HOST_SERVICE = join(privateRoot, 'host-service.json')
    workerEnvironment.AGENTMUX_A2A_PROOF_CLIPBOARD = clipboardPath
    const lines = [], workerPath = join(privateRoot, 'apps/desktop/scripts/fixtures/a2a-reference-reading/worker.mjs')
    const outcome = await runProbeProcess(process.execPath, [workerPath, evidence], { cwd: privateRoot, temporaryRoot: privateRoot, env: workerEnvironment, timeoutMs: 360_000, onLine: line => { lines.push(line); if (line.startsWith('a2a_private_main_exit_unconfirmed=')) throw new Error(line) }, beforeStop: async () => { product.cleanup.mainStop = await stopPrivateA2aMains(privateRoot) } })
    await writeFile(join(evidence, 'product.log'), lines.join('\n') + '\n'); assert.equal(outcome.timedOut, false); assert.equal(outcome.exitCode, 0)
    Object.assign(product, JSON.parse(await readFile(join(evidence, 'facts.json'), 'utf8')))
    product.workerOutcome = outcome
    product.prepared = true; product.reviewPath = join(evidence, 'review.json')
  } catch (error) { failure = error; product.error = { message: error.message, stack: error.stack, diagnostic: inspect(error, { depth: 8 }), ...(error.probe ? { probe: error.probe } : {}) } }
  finally {
    try { product.cleanup.mainStop = await stopPrivateA2aMains(privateRoot); if (product.hostServiceOwner) product.cleanup.outerHostService = await stopPrivateA2aHostService(product.hostServiceOwner); await stopProbeProcesses(-1, privateRoot); assert.deepEqual(await listProbeProcesses(-1, privateRoot), []); product.cleanup.outerProcessesReaped = true }
    catch (error) { product.cleanup.outerError = error.message; failure ??= error; product.prepared = false }
    product.cleanup.buildRetained = true
    product.cleanup.privateRoot = privateRoot
    await writeFile(receiptPath, JSON.stringify(product, null, 2) + '\n')
  }
  if (failure) throw Object.assign(failure, { productReceiptPath: receiptPath })
  return { path: receiptPath, sha256: a2aProofSha(await readFile(receiptPath)), prepared: true, sourceCommit }
}

/** Shared build identity and actual-image review; no scenario conclusion is inferred here. */
async function verifyProductBuild(product, { root }) {
  assert.equal(product.schema, 'agentmux.a2a-reference-product-proof.v1'); assert.equal(product.prepared, true)
  assert.ok(product.sourceCommit)
  assert.deepEqual(Object.keys(product.fixtures).sort(), [...fixturePaths].sort())
  const retainedExecution = product.execution
  for (const [path, digest] of Object.entries(product.fixtures)) {
    assert.equal(a2aProofSha(await readFile(join(root, path))), digest, 'Current proof source: ' + path)
    assert.equal(a2aProofSha(await readFile(join(product.privateRoot, path))), digest, 'Actual private executable fixture: ' + path)
  }
  assert.equal(product.preparation.kind, 'source-build')
  assert.ok(Object.keys(product.sources).length > 100)
  for (const [path, digest] of Object.entries(product.sources)) assert.equal(a2aProofSha(await readFile(join(root, path))), digest, 'Current product source: ' + path)
  for (const path of requiredLoaded) assert.equal(product.loaded[path], product.sources[path], 'Loaded original consumer: ' + path)
  assert.equal((await exec('git', ['diff', product.sourceCommit, '--name-only', '--', ...product.assets.map(asset => asset.path)], { cwd: root })).stdout.trim(), '', 'Current immutable asset input trees')
  for (const asset of product.assets) assert.equal((await exec('git', ['rev-parse', product.sourceCommit + ':' + asset.path], { cwd: root })).stdout.trim(), asset.tree)
  assert.ok(Object.keys(product.compiled).length > 100)
  for (const [path, digest] of Object.entries(product.compiled)) assert.equal(a2aProofSha(await readFile(join(product.privateRoot, path))), digest, 'Actual retained compiled product: ' + path)
  for (const path of requiredLoaded) assert.equal(product.compilerInputs[path], path === product.windowOverlay.owner ? product.windowOverlay.compilerInput : product.sources[path], 'Exact compiler input: ' + path)
  for (const dependency of product.dependencies) { const bytes = await readFile(join(dependency.target, 'package.json')); assert.equal(a2aProofSha(bytes), dependency.sha256); assert.equal(JSON.parse(bytes).version, dependency.locked.split('(')[0]) }
  assert.ok(Object.keys(product.testSourceJoin).length > 0)
  for (const [path, digest] of Object.entries(product.testSourceJoin)) assert.equal(product.sources[path], digest, 'Same owning-test and actual product source: ' + path)
  assert.equal(a2aProofSha(await readFile(join(retainedExecution.coreRoot, 'vendor/ctxmux', process.platform + '-' + process.arch, 'manifest.json'))), product.ctxmux.manifest)
  assert.equal(product.hostServiceOwner.sourceSHA256, product.fixtures[hostServiceSource])
  assert.equal(product.hostServiceOwner.moduleSHA256, a2aProofSha(privateHostServiceModule(await readFile(join(root, hostServiceSource), 'utf8'), product.execution.coreRoot)))
  assert.equal(product.hostServiceOwner.coreRoot, product.execution.coreRoot)
  assert.equal(product.cleanup.hostService.endpoint, 'confirmed-dead'); assert.equal(product.cleanup.outerHostService.endpoint, 'confirmed-dead')
  assert.equal(product.cleanup.outerHostService.status, 'unregistered'); assert.equal(product.cleanup.outerHostService.label, product.hostServiceOwner.service.label)
  assert.equal(product.cleanup.hostService.status, 'unregistered'); assert.equal(product.cleanup.hostService.label, product.hostServiceOwner.service.label)
  assert.equal(product.cleanup.mainExitConfirmed, true); assert.equal(product.cleanup.processesReaped, true); assert.equal(product.cleanup.outerProcessesReaped, true); assert.equal(product.workerOutcome.exitConfirmed, true); assert.equal(product.workerOutcome.originalExitCode, 0); assert.equal(product.cleanup.userRunTouched, false)
  assert.equal(product.homeIsolation.privateHome, join(product.privateRoot, 'home'))
  assert.equal(product.homeIsolation.initialSessionStore, 'absent')
  assert.equal(product.semanticOwner.owner.availability, 'connected')
  assert.notEqual(product.semanticOwner.owner.processId, product.semanticOwner.workerPid)
  assert.equal(product.semanticOwner.executor.runtimeId, product.semanticOwner.owner.runtimeId)
  assert.equal(product.semanticOwner.executor.executor.executorId, 'proof')
  assert.ok(product.homeIsolation.launches.length > 0)
  for (const launch of product.homeIsolation.launches) {
    assert.equal(launch.home, product.homeIsolation.privateHome); assert.equal(launch.nativeHome, launch.home)
    assert.equal(launch.userData, join(product.privateRoot, 'user-data'))
    assert.equal(launch.endpoint, join(product.privateRoot, 'runtime/control.sock.desktop'))
    assert.equal(launch.hostReadiness.original.storePath, join(product.privateRoot, 'user-data/agent-sessions.json'))
    assert.equal(launch.hostReadiness.original.owner.runtimeId, product.semanticOwner.owner.runtimeId)
    assert.equal(launch.hostReadiness.original.owner.processId, product.semanticOwner.owner.processId)
    assert.equal(launch.hostReadiness.original.owner.availability, 'connected')
    if (launch.originalHome !== launch.home) assert.ok(!JSON.stringify(launch.catalog).includes(launch.originalHome))
    const overlay = launch.presentationOverlay
    assert.equal(overlay.activationPolicy, 'prohibited')
    assert.equal(overlay.mainSHA256, a2aProofSha(await readFile(retainedExecution.mainEntry)))
    for (const digest of [overlay.homeExpressionSHA256, overlay.windowExpressionSHA256, overlay.nativeClipboard.expressionSHA256]) assert.match(digest, /^[a-f0-9]{64}$/u)
    assert.equal(overlay.window.focusable, false); assert.equal(overlay.window.focusedBefore, false); assert.equal(overlay.window.primary, true)
    assert.equal(overlay.windowAfter.focused, false); assert.deepEqual(overlay.clipboard.reads, [])
    assert.deepEqual(overlay.clipboard.blockedRequests, []); assert.deepEqual(overlay.electronClipboard, { reads: [], writes: [] })
    assert.equal(overlay.nativeClipboard.installation.sameOriginalOwner, true); assert.equal(overlay.nativeClipboard.installation.sameOriginalPrototype, true)
    assert.equal(overlay.nativeClipboard.installation.port, 'NativeDesktop.writeClipboardText'); assert.equal(overlay.nativeClipboard.installation.destination, 'private-recorder')
    assert.deepEqual(overlay.nativeClipboard.installation.requestFence, ['clipboardRead', 'clipboardWrite'])
    assert.ok(overlay.nativeClipboard.pause.hitBreakpoints.includes(overlay.nativeClipboard.breakpoint.id))
    assert.equal(overlay.nativeClipboard.breakpoint.url, pathToFileURL(product.execution.mainEntry).href)
    assert.ok(overlay.nativeClipboard.breakpoint.lineNumber > launch.breakpoint.lineNumber && overlay.nativeClipboard.breakpoint.lineNumber < overlay.windowBreakpoint.lineNumber)
    assert.ok(overlay.windowPause.hitBreakpoints.includes(overlay.windowBreakpoint.id))
    assert.ok(launch.pauses.at(-1).hitBreakpoints.includes(launch.breakpoint.id)); assert.equal(launch.breakpoint.url, pathToFileURL(product.execution.mainEntry).href)
    assert.ok(Number.isInteger(launch.pid) && launch.pid > 0)
  }
  assert.ok(product.frames.length >= 7)
  for (const frame of product.frames) { assert.ok(isAbsolute(frame.path)); assert.equal(a2aProofSha(await readFile(frame.path)), frame.sha256); assert.ok(frame.width >= 400 && frame.height >= 500) }
  const review = JSON.parse(await readFile(product.reviewPath, 'utf8'))
  assert.equal(review.schema, 'agentmux.a2a-product-visual-review.v1'); assert.equal(review.verdict, 'pass'); assert.equal(review.independent, true)
  assert.equal(typeof review.reviewer, 'string'); assert.ok(review.reviewer.length > 0); assert.equal(review.openedAll, true)
  assert.equal(review.productSha256, a2aProofSha(await readFile(product.receiptPath)), 'Independent review names this exact product artifact')
  assert.deepEqual(review.frames.map(frame => [frame.path, frame.sha256]).sort(), product.frames.map(frame => [frame.path, frame.sha256]).sort())
  for (const frame of review.frames) assert.equal(frame.verdict, 'pass')
  return retainedExecution
}

/** This scene signs only original reference reading, never model adoption or recovery. */
export async function verifyA2aReferenceReadingProductProof(product, { root, testInputs }) {
  const retainedExecution = await verifyProductBuild(product, { root })
  assert.deepEqual(product.testSourceJoin, testInputs, 'Actual owning-test production inputs join this exact product snapshot')
  assert.deepEqual(product.homeIsolation.launches.map(launch => launch.label), ['first'])
  const r = product.reading
  assert.ok(r && r.boundary)
  assert.equal(r.sent.ok, true); assert.equal(r.sent.operationId, r.operationId)
  assert.equal(r.sent.result.envelope.messageId, r.messageId); assert.equal(r.original.envelope.operationId, r.operationId)
  assert.deepEqual(r.publicRead.result.message, r.original)
  const envelope = r.original.envelope
  assert.equal(envelope.messageId, r.messageId); assert.equal(envelope.senderSessionId, r.author.agentSessionId)
  assert.equal(envelope.recipientSessionId, r.recipient.agentSessionId)
  assert.equal(envelope.sender.kind, 'agent-session'); assert.equal(envelope.recipient.kind, 'agent-session')
  assert.equal(r.original.deliveryMode, 'reference'); assert.equal(r.original.delivery.state, 'queued')
  assert.equal(r.original.notification.state, 'submitted'); assert.deepEqual(r.key, r.original.notification.key)
  assert.equal(r.key.kind, 'prompt'); assert.equal(r.key.agentSessionId, r.recipient.agentSessionId)
  assert.equal(r.key.expectedRun.runId, r.recipient.run.runId); assert.notEqual(r.key.submissionId, r.messageId)
  assert.equal(r.original.notification.notificationId, r.key.submissionId)
  const admission = r.input.admission
  assert.deepEqual(admission.inputKey, r.key); assert.equal(admission.intent.prompt, r.wire)
  assert.equal(admission.native.plan.operation, 'queue-idle'); assert.equal(admission.native.outcome, 'admitted')
  assert.ok(admission.native.queuedSubmissionId)
  const content = admission.intent.message
  assert.equal(content.systemContext, r.wire); assert.equal(content.a2aNotificationId, r.key.submissionId)
  assert.ok(Buffer.byteLength(r.wire) <= 64 * 1024)
  for (const field of ['userContent', 'authorHuman', 'authorExternal', 'authorAgentSessionId']) assert.equal(content[field], undefined)
  const { parseAgentMuxMessagePrefix } = await import(pathToFileURL(join(retainedExecution.coreRoot, 'dist/agent-message-render.js')).href)
  const parsed = parseAgentMuxMessagePrefix(r.wire)
  assert.equal(parsed?.kind, 'references'); assert.equal(parsed.declaredAgentSessionId, null)
  assert.deepEqual(parsed.references.map(item => [item.declaredAgentSessionId, item.declaredMessageId, item.readVia]),
    [[r.author.agentSessionId, r.messageId, 'message --skill']])
  assert.equal(r.captured.kind, 'system_message'); assert.equal(r.captured.source, 'agentmux')
  assert.equal(r.captured.a2aNotificationId, r.key.submissionId); assert.deepEqual(r.captured.inputRef, r.key)
  assert.equal(r.captured.content, r.wire)
  const noticeUnits = r.conversation.items.filter(entry => entry.kind === 'item' && entry.item.records.some(record => {
    const item = record.original.item, key = record.original.kind === 'native' ? item.conversation?.adoptedInput?.key : item.inputRef
    return key?.kind === 'prompt' && key.submissionId === r.key.submissionId
  }))
  assert.equal(noticeUnits.length, 1); assert.equal(noticeUnits[0].item.event.role, 'notice'); assert.equal(noticeUnits[0].item.event.author.kind, 'system')
  assert.ok(noticeUnits[0].item.records.some(record => record.original.kind === 'native'
    && record.original.item.conversation?.adoptedInput?.purpose === 'a2a-notification'))
  assert.ok(noticeUnits[0].item.records.some(record => record.original.kind === 'captured'
    && record.original.item.a2aNotificationId === r.key.submissionId))
  assert.equal(r.rendered.role, 'system'); assert.equal(r.rendered.eventRole, 'notice')
  assert.equal(r.rendered.eventAuthor.kind, 'system'); assert.equal(r.rendered.notificationId, r.key.submissionId)
  assert.equal(r.rendered.originals, 1); assert.equal(r.rendered.primarySystemCards, 0); assert.equal(r.rendered.detailsInitiallyOpen, false)
  assert.deepEqual(r.rendered.original, { messageId: r.messageId, role: 'agent', relation: 'other-agent', direction: 'incoming',
    senderId: r.author.agentSessionId, body: envelope.body, decodedReferences: 0 })
  assert.deepEqual(r.originalRecords, noticeUnits[0].item.records.map(record => ({ id: record.id, kind: record.original.kind, original: record.original.item })))
  const copies = [[r.copiedConversationBody, envelope.body], [r.copiedWire, r.wire], [r.copiedBody, envelope.body]]
  for (const [index, [copy, text]] of copies.entries()) {
    assert.equal(copy.text, text); assert.equal(copy.port, 'NativeDesktop.writeClipboardText'); assert.equal(copy.destination, 'private-recorder')
    assert.equal(copy.byteLength, Buffer.byteLength(text)); assert.equal(copy.beforeSequence, index); assert.equal(copy.sequence, index + 1)
  }
  assert.deepEqual(product.homeIsolation.launches[0].presentationOverlay.clipboard.writes,
    copies.map(([{ beforeSequence, ...value }]) => value), 'Every Copy reaches the original native text port exactly once')
  assert.equal(r.wireCopyFeedback, true); assert.equal(r.bodyCopyFeedback, true); assert.equal(r.conversationBodyCopyFeedback, true)
  assert.equal(r.inbox.decodedReferenceLists, 0); assert.ok(r.inbox.facts.includes('Notification submitted')); assert.ok(r.outbox.facts.includes('Notification submitted'))
  assert.ok(r.inbox.facts.includes(r.messageId)); assert.ok(r.outbox.facts.includes(r.messageId))
  assert.ok(r.inbox.text.includes('authored-example-message')); assert.ok(r.outbox.text.includes('authored-example-message'))
  for (const text of [r.messageId, r.key.submissionId, envelope.body]) assert.ok(!r.userPage.includes(text))
  const nativeSource = noticeUnits[0].item.records.find(record => record.original.kind === 'native').reference.source
  assertA2aReferenceUserReading(r.userReading, r.recipient, { providerId: nativeSource.providerId, nativeSessionId: nativeSource.nativeSessionId }, { key: r.key, wire: r.wire })
  assert.equal(r.userPage, r.userReading.view.text)
  assert.equal(r.batch.messages.length, 1); assert.equal(r.batch.messages[0].envelope.messageId, r.messageId)
  assert.deepEqual(r.afterBatch, r.batch)
  const expectedSessions = [r.author.agentSessionId, r.recipient.agentSessionId].sort()
  const verifyEffects = pair => {
    assert.deepEqual(Object.keys(pair.before).sort(), expectedSessions)
    for (const rows of Object.values(pair.before)) assert.ok(Array.isArray(rows))
    assert.deepEqual(pair.after, pair.before)
  }
  verifyEffects(r.effects)
  const originalQueue = r.effects.before[r.recipient.agentSessionId].filter(row => row.method === 'thread/queue/add')
  assert.equal(originalQueue.length, 1); assert.equal(originalQueue[0].params.input.map(part => part.text).join(''), r.wire)
  for (const read of product.chain.readEffects) verifyEffects(read)
  assert.ok(product.chain.readEffects.some(read => read.operation === 'message.read'))
  assert.ok(product.chain.readEffects.some(read => read.operation === 'message.inbox.check'))
  assert.deepEqual(r.appearance.restored, r.appearance.original)
  assert.deepEqual(r.appearance.transitions.map(item => item.requested), ['dark', 'light'])
  for (const appearance of ['dark', 'light']) {
    const transition = r.appearance.transitions.find(item => item.requested === appearance)
    assert.equal(transition.committed.appAppearance, appearance); assert.equal(transition.observed.appearance, appearance)
    for (const [size, width] of [['wide', 1440], ['narrow', 500]]) {
      const frame = product.frames.find(item => item.name === `reference-conversation-${appearance}-${size}`)
      assert.ok(frame); assert.equal(frame.width, width); assert.equal(frame.observed.appearance, appearance)
      assert.ok(frame.observed.text.includes('authored-example-message'))
      const g = frame.referenceGeometry
      assert.equal(g.viewport, width); assert.ok(g.width > 150 && g.height > 50 && g.left >= 0 && g.right <= width)
      assert.ok(g.avatar.left >= g.body.right - 1 && g.avatar.right <= g.right + 1)
      assert.ok(g.scrollWidth <= g.clientWidth + 1)
    }
  }
  for (const name of ['reference-user-messages', 'reference-inbox-original', 'reference-outbox']) assert.ok(product.frames.some(frame => frame.name === name))
  return { passed: true, sourceCommit: product.sourceCommit, frames: product.frames.length, messageId: r.messageId, notificationId: r.key.submissionId }
}
