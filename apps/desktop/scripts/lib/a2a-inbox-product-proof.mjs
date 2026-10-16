import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { listProbeProcesses, stopProbeProcesses, runProbeProcess } from '../probe-process.mjs'

const exec = promisify(execFile), require = createRequire(import.meta.url)
export const a2aProofSha = bytes => createHash('sha256').update(bytes).digest('hex')
const packages = ['core', 'demand', 'client-ui', 'layout', 'relay', 'identity', 'git', 'diagnostic-evidence', 'connectors']
const assets = ['packages/core/vendor', 'apps/desktop/vendor', 'apps/desktop/resources', 'apps/desktop/native', 'apps/desktop/brand', 'apps/desktop/browser-extension']
const owns = ['apps/desktop/src', 'apps/desktop/electron.vite.config.ts', 'apps/desktop/package.json',
  'apps/desktop/scripts/radix-overlay-aliases.ts', 'apps/desktop/scripts/excalidraw-local-fonts.ts', 'apps/desktop/scripts/pdfjs-viewer-assets.ts', 'apps/desktop/scripts/file-diagram-assets.ts',
  'apps/host/src', 'apps/host/package.json', 'test/fixture-values.mjs', 'test/fixture-epoch.cjs',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.shared.json', 'patches',
  'packages/core/scripts/build.mjs', 'packages/core/scripts/clean-build.mjs', 'packages/core/bin', 'packages/core/native', 'packages/client-ui/scripts',
  ...assets, ...packages.flatMap(name => ['src', 'package.json', 'tsconfig.json', 'tsconfig.build.json'].map(path => 'packages/' + name + '/' + path))]
const fixturePaths = ['apps/desktop/scripts/lib/a2a-inbox-product-proof.mjs',
  'apps/desktop/scripts/fixtures/a2a-inbox-product/worker.mjs', 'apps/desktop/scripts/fixtures/a2a-inbox-product/native-agent.mjs']
const requiredLoaded = ['apps/desktop/src/main/index.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
  'apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
  'apps/desktop/src/renderer/src/components/MailboxReading.tsx', 'packages/client-ui/src/components/ConversationMessage.tsx',
  'packages/client-ui/src/components/ConversationInputText.tsx', 'packages/client-ui/src/components/InputMailboxRecords.tsx']

/** One private complete product build, shared only by the three A2A acceptance consumers. */
export async function runA2aInboxProductProof({ root, evidence }) {
  root = await realpath(root); evidence = resolve(evidence, 'a2a-product'); await mkdir(evidence, { recursive: true })
  const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const changes = (await exec('git', ['diff', sourceCommit, '--name-only', '--', ...owns], { cwd: root })).stdout.trim()
  assert.equal(changes, '', 'Commit the integrated product candidate before its private proof; no product overlay is accepted')
  const privateRoot = await realpath(await mkdtemp('/tmp/amx-a2-'))
  const product = { schema: 'agentmux.a2a-product-proof.v1', prepared: false, passed: false, sourceRoot: root, sourceCommit,
    privateRoot, receiptPath: join(evidence, 'receipt.json'), sources: {}, loaded: {}, compilerInputs: {}, compiled: {}, fixtures: {}, frames: [], cleanup: {},
    boundary: 'Actual complete Desktop/Main/preload/Renderer, public CLI, private ctxmux and authenticated synthetic native actor. No live model, user Runtime, installed App, new delivery mode or implicit recovery seed.' }
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
    const original = await readFile(join(privateRoot, 'apps/desktop/src/main/index.ts'), 'utf8')
    const anchor = 'const window = new BrowserWindow({\n      ...windowConstructorGeometry(persistedGeometry),', placement = '    workbenchWindow = window'
    assert.equal(original.split(anchor).length, 2); assert.equal(original.split(placement).length, 2)
    const clipboardPath = join(evidence, 'clipboard.json')
    const clipboardPort = `import { clipboard as privateA2aClipboard } from 'electron';
import { writeFileSync as recordPrivateA2aClipboard } from 'node:fs';
privateA2aClipboard.writeText = text => recordPrivateA2aClipboard(${JSON.stringify(clipboardPath)}, JSON.stringify({ text, at: Date.now(), port: 'electron.clipboard.writeText' }));
`
    const privateInput = clipboardPort + original.replace(anchor, anchor + '\n      show: false, focusable: false,').replace(placement,
      `    window.show = () => window.showInactive()\n    window.focus = () => {}\n    window.showInactive()\n${placement}`)
    product.windowOverlay = { owner: 'apps/desktop/src/main/index.ts', raw: a2aProofSha(original), compilerInput: a2aProofSha(privateInput), scope: 'Private nonactivating BrowserWindow presentation and the unique OS clipboard.writeText port; no user clipboard access, no input/semantic/IPC logic replaced'  }
    const loadedPath = join(evidence, 'loaded.json'), compilerInputsPath = join(evidence, 'compiler-inputs.json'), configPath = join(privateRoot, 'apps/desktop/a2a-proof.vite.config.mjs')
    await writeFile(configPath, `import actual from './electron.vite.config.ts';import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import{relative}from'node:path';const root=${JSON.stringify(privateRoot)},loaded={},compilerInputs={};const plugin=()=>({name:'a2a-actual-product-input',enforce:'pre',async load(id){if(id.startsWith(root+'/')&&!id.includes('/node_modules/')&&!id.includes('?')){try{loaded[relative(root,id)]=createHash('sha256').update(await readFile(id)).digest('hex');compilerInputs[relative(root,id)]=loaded[relative(root,id)]}catch{}}if(id===root+'/apps/desktop/src/main/index.ts'){compilerInputs[relative(root,id)]=${JSON.stringify(a2aProofSha(privateInput))};return ${JSON.stringify(privateInput)}}},async closeBundle(){await writeFile(${JSON.stringify(loadedPath)},JSON.stringify(loaded,null,2));await writeFile(${JSON.stringify(compilerInputsPath)},JSON.stringify(compilerInputs,null,2))}});export default Object.fromEntries(Object.entries(actual).map(([key,value])=>[key,{...value,plugins:[plugin(),...(value.plugins??[])]}]));`)
    await command('desktop-build', process.execPath, [join(root, 'apps/desktop/node_modules/electron-vite/bin/electron-vite.js'), 'build', '--config', configPath], join(privateRoot, 'apps/desktop'))
    product.loaded = JSON.parse(await readFile(loadedPath, 'utf8')); product.compilerInputs = JSON.parse(await readFile(compilerInputsPath, 'utf8'))
    assert.equal(product.compilerInputs[product.windowOverlay.owner], product.windowOverlay.compilerInput)
    for (const path of requiredLoaded) assert.equal(product.loaded[path], product.sources[path], 'Actual product consumer compiled: ' + path)
    for (const directory of ['apps/desktop/out', ...packages.map(name => 'packages/' + name + '/dist')]) {
      try { for (const entry of await readdir(join(privateRoot, directory), { recursive: true, withFileTypes: true })) if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name); product.compiled[relative(privateRoot, path)] = a2aProofSha(await readFile(path))
      } } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    for (const [path, digest] of Object.entries(product.sources)) assert.equal(a2aProofSha(await readFile(join(root, path))), digest, 'Source stayed unchanged while building: ' + path)
    assert.equal((await exec('git', ['diff', sourceCommit, '--name-only', '--', ...assets], { cwd: root })).stdout.trim(), '', 'Immutable asset trees stayed committed during the build')
    const workerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTMUX_') && !name.startsWith('CTXMUX_') && !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'CODEX_HOME'].includes(name)))
    workerEnvironment.HOME = join(privateRoot, 'home'); await mkdir(workerEnvironment.HOME)
    workerEnvironment.AGENTMUX_A2A_PROOF_BUILD = privateRoot
    workerEnvironment.AGENTMUX_A2A_PROOF_CLIPBOARD = clipboardPath
    workerEnvironment.AGENTMUX_A2A_PROOF_ELECTRON = require('electron')
    const lines = [], workerPath = join(privateRoot, 'apps/desktop/scripts/fixtures/a2a-inbox-product/worker.mjs')
    const outcome = await runProbeProcess(process.execPath, [workerPath, evidence], { cwd: privateRoot, temporaryRoot: privateRoot, env: workerEnvironment, timeoutMs: 360_000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, 'product.log'), lines.join('\n') + '\n'); assert.equal(outcome.timedOut, false); assert.equal(outcome.exitCode, 0)
    Object.assign(product, JSON.parse(await readFile(join(evidence, 'facts.json'), 'utf8')))
    product.workerOutcome = outcome
    product.prepared = true; product.reviewPath = join(evidence, 'review.json')
  } catch (error) { failure = error; product.error = { message: error.message, stack: error.stack } }
  finally {
    try { await stopProbeProcesses(-1, privateRoot); assert.deepEqual(await listProbeProcesses(-1, privateRoot), []); product.cleanup.outerProcessesReaped = true }
    catch (error) { product.cleanup.outerError = error.message; failure ??= error; product.prepared = false }
    product.cleanup.buildRetained = true
    product.cleanup.privateRoot = privateRoot
    await writeFile(receiptPath, JSON.stringify(product, null, 2) + '\n')
  }
  if (failure) throw Object.assign(failure, { productReceiptPath: receiptPath })
  return { path: receiptPath, sha256: a2aProofSha(await readFile(receiptPath)), prepared: true, sourceCommit }
}

/** Exact artifact consumption for the three approved A2A task contracts. */
export async function verifyA2aInboxProductProof(product, { root, scope }) {
  assert.ok(['mailbox', 'integration', 'restart'].includes(scope)); assert.equal(product.schema, 'agentmux.a2a-product-proof.v1'); assert.equal(product.prepared, true)
  assert.ok(product.sourceCommit && Object.keys(product.sources).length > 100)
  assert.deepEqual(Object.keys(product.fixtures).sort(), [...fixturePaths].sort())
  for (const [path, digest] of Object.entries(product.fixtures)) {
    assert.equal(a2aProofSha(await readFile(join(root, path))), digest, 'Current proof source: ' + path)
    assert.equal(a2aProofSha(await readFile(join(product.privateRoot, path))), digest, 'Actual private executable fixture: ' + path)
  }
  for (const [path, digest] of Object.entries(product.sources)) assert.equal(a2aProofSha(await readFile(join(root, path))), digest, 'Current product source: ' + path)
  for (const path of requiredLoaded) assert.equal(product.loaded[path], product.sources[path], 'Loaded original consumer: ' + path)
  assert.equal((await exec('git', ['diff', product.sourceCommit, '--name-only', '--', ...product.assets.map(asset => asset.path)], { cwd: root })).stdout.trim(), '', 'Current immutable asset input trees')
  for (const asset of product.assets) assert.equal((await exec('git', ['rev-parse', product.sourceCommit + ':' + asset.path], { cwd: root })).stdout.trim(), asset.tree)
  assert.ok(Object.keys(product.compiled).length > 100)
  for (const [path, digest] of Object.entries(product.compiled)) assert.equal(a2aProofSha(await readFile(join(product.privateRoot, path))), digest, 'Actual retained compiled product: ' + path)
  for (const path of requiredLoaded) assert.equal(product.compilerInputs[path], path === product.windowOverlay.owner ? product.windowOverlay.compilerInput : product.sources[path], 'Exact compiler input: ' + path)
  for (const dependency of product.dependencies) { const bytes = await readFile(join(dependency.target, 'package.json')); assert.equal(a2aProofSha(bytes), dependency.sha256); assert.equal(JSON.parse(bytes).version, dependency.locked.split('(')[0]) }
  assert.equal(a2aProofSha(await readFile(join(product.privateRoot, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'manifest.json'))), product.ctxmux.manifest)
  assert.equal(product.cleanup.processesReaped, true); assert.equal(product.cleanup.outerProcessesReaped, true); assert.equal(product.workerOutcome.exitConfirmed, true); assert.equal(product.workerOutcome.originalExitCode, 0); assert.equal(product.cleanup.userRunTouched, false)
  assert.ok(product.frames.length >= 9)
  for (const frame of product.frames) { assert.ok(isAbsolute(frame.path)); assert.equal(a2aProofSha(await readFile(frame.path)), frame.sha256); assert.ok(frame.width >= 400 && frame.height >= 500) }
  const review = JSON.parse(await readFile(product.reviewPath, 'utf8'))
  assert.equal(review.schema, 'agentmux.a2a-product-visual-review.v1'); assert.equal(review.verdict, 'pass'); assert.equal(review.independent, true)
  assert.equal(typeof review.reviewer, 'string'); assert.ok(review.reviewer.length > 0); assert.equal(review.openedAll, true)
  assert.equal(review.productSha256, a2aProofSha(await readFile(product.receiptPath)), 'Independent review names this exact product artifact')
  assert.deepEqual(review.frames.map(frame => [frame.path, frame.sha256]).sort(), product.frames.map(frame => [frame.path, frame.sha256]).sort())
  for (const frame of review.frames) assert.equal(frame.verdict, 'pass')
  assert.ok(product.mailbox?.pages?.every(page => ['inbox', 'outbox', 'user'].includes(page)) && product.mailbox.pages.length === 3)
  assert.equal(product.mailbox.copyExact, true); assert.equal(product.mailbox.clipboardPort.text, product.chain.scenarios.find(item => item.kind === 'normal').body); assert.equal(product.mailbox.clipboardPort.port, 'electron.clipboard.writeText'); assert.equal(product.mailbox.humanReadDidNotAcknowledgeAgent, true)
  const normalMessage = product.chain.scenarios.find(item => item.kind === 'normal')
  assert.equal(product.mailbox.recipientUserPage.agentSessionId, normalMessage.original.envelope.recipientSessionId)
  assert.ok(!product.mailbox.recipientUserPage.text.includes('A2A original review')); assert.ok(!product.mailbox.recipientUserPage.keys.some(key => key.includes(normalMessage.journalMessageId)))
  if (scope === 'integration' || scope === 'restart') {
    assert.deepEqual(product.chain.scenarios.map(item => item.kind).sort(), ['failed', 'normal', 'unknown', 'unsubmitted'])
    for (const item of product.chain.scenarios) { assert.equal(item.cliMessageId, item.journalMessageId); assert.equal(item.body, item.original.envelope.body); assert.ok(item.original.sequence > 0) }
    assert.equal(product.chain.normal.nativeInputCount, 1); assert.equal(product.chain.normal.conversationCount, 1)
    assert.equal(product.chain.normal.authorSessionId, product.chain.normal.senderSessionId)
    const normalId = product.chain.scenarios.find(item => item.kind === 'normal').journalMessageId
    const joined = product.chain.normal.conversation.items.filter(entry => entry.kind === 'item' && entry.item.records.some(record => { const key = record.original.kind === 'native' ? record.original.item.conversation?.adoptedInput?.key : record.original.item.inputRef; return key?.kind === 'message' && key.messageId === normalId }))
    assert.equal(joined.length, 1); assert.equal(joined[0].item.event.author.agentSessionId, product.chain.normal.senderSessionId)
    for (const kind of ['failed', 'unknown']) assert.equal(product.chain.scenarios.find(item => item.kind === kind).claim.admission.native.outcome, kind === 'failed' ? 'not-applied' : 'unknown')
    assert.equal(product.chain.unsubmitted.conversationCount, 0)
    assert.equal(product.chain.human.original.envelope.sender.kind, 'human'); assert.equal(product.chain.human.original.envelope.senderSessionId, null); assert.equal(product.chain.human.original.envelope.body, product.chain.human.body)
    assert.ok(product.chain.human.userPage.text.includes(product.chain.human.body)); assert.ok(!product.chain.human.userPage.text.includes('A2A original review'))
    assert.equal(product.chain.initial.original.envelope.recipientRunId, null); assert.equal(product.chain.initial.original.envelope.body, product.chain.initial.body)
  }
  if (scope === 'restart') {
    const { first, second } = product.restart
    assert.notEqual(first.pid, second.pid); assert.equal(first.signal, 'SIGKILL'); assert.equal(second.seedControlsAbsent, true)
    assert.deepEqual(second.workbench, first.workbench); assert.deepEqual(second.drafts, first.drafts); assert.deepEqual(second.queue, Object.fromEntries(Object.entries(first.queue).map(([id, entries]) => [id, entries.map(({ preparationWait, ...entry }) => ({ ...entry, status: entry.status === 'restoring' ? 'restoring' : 'deferred', awaitingExplicitSend: true }))])))
    assert.deepEqual(second.runBirths, first.runBirths); assert.deepEqual(second.messages, first.messages)
    assert.equal(product.restart.replayCount, 0); assert.equal(product.restart.wrongRunAckRefused, true); assert.equal(product.restart.staleGenerationRefused, true)
    assert.equal(product.restart.reboundOccupantInputCount, 0); assert.equal(product.restart.unknownReplay.nativeInputCount, 1); assert.equal(product.restart.unknownReplay.originalMessageId, product.chain.scenarios.find(item => item.kind === 'unknown').journalMessageId); assert.equal(product.restart.healthyManualInput, true)
  }
  return { passed: true, scope, sourceCommit: product.sourceCommit, frames: product.frames.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.deepEqual(process.argv.slice(2), ['--prepare'], 'The private A2A product helper accepts only --prepare')
  const root = resolve(import.meta.dirname, '../../../..')
  const artifact = await runA2aInboxProductProof({ root, evidence: join(root, '.tmp/mailbox-reading-flow') })
  console.log(JSON.stringify(artifact))
}
