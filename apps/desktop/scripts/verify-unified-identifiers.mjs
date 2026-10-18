import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { mintObjectId } from '@agentmux/core/object-id'
import { build } from 'electron-vite'
import { copyBrowserExtension, prepareBrowserExtensionIdentity } from './prepare-browser-extension-identity.mjs'
import { clientIdentityMutations } from './lib/unified-identifier-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, '.tmp/unified-identifiers-clients', mintObjectId())
await mkdir(output, { recursive: true })
const receipt = { schema: 'agentmux.client-identifiers-proof.v1', status: 'running', sourceFiles: [], consumers: [], mutants: [], packaging: null, preload: null }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function sources(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['vendor', 'fixtures', 'node_modules', 'dist'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (/\.(?:[cm]?[jt]sx?|swift)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) files.push(path)
  }
  return files
}
async function runConsumer(name, mutation) {
  const report = join(output, name + '.json'), loaded = join(output, name + '-source.ndjson'), log = join(output, name + '.log')
  const env = { ...process.env, NODE_ENV: 'test', AMUX_CLIENT_ID_LOADED: loaded }
  delete env.AMUX_CLIENT_ID_MUTATION
  if (mutation) env.AMUX_CLIENT_ID_MUTATION = mutation
  const args = ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/unified-identifiers.config.mts', '--reporter=json', '--outputFile=' + report]
  let bytes = ''
  const code = await new Promise((accept, reject) => {
    const child = spawn('pnpm', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { bytes += chunk }); child.stderr.on('data', chunk => { bytes += chunk })
    child.once('error', reject); child.once('exit', code => accept(code))
  })
  await writeFile(log, bytes)
  const result = JSON.parse(await readFile(report, 'utf8'))
  const observations = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(result.numTotalTests > 0 && result.numPendingTests === 0 && result.numTodoTests === 0, 'A nonempty active consumer set is required')
  if (mutation) {
    const target = clientIdentityMutations[mutation].file
    const actual = observations.filter(record => record.path === target && record.mutated && record.sourceSHA256 !== record.loadedSHA256)
    assert.ok(actual.length > 0, 'The mutation must reach its actual production consumer')
    const failures = result.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
    assert.ok(code !== 0 && failures.some(test => test.failureMessages.some(message => message.includes('AssertionError') || message.includes('__VITEST_RESOLVES__'))), 'A loaded mutation must fail a business assertion')
    const evidence = { mutation, tests: result.numTotalTests, failed: result.numFailedTests, source: actual[0] }
    receipt.mutants.push(evidence)
  } else {
    assert.equal(code, 0, bytes.slice(-2500)); assert.equal(result.numFailedTests, 0)
    assert.ok(result.testResults.every(suite => suite.assertionResults.length > 0 && suite.assertionResults.every(test => test.status === 'passed')), 'No empty, skipped or unloaded consumer suites')
    for (const required of ['apps/desktop/src/main/note-file-writer.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/main/workbench-windows.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/browser-extension/service-worker.js', 'packages/client-ui/src/note/note-wiki-input.ts', 'apps/mobile/src/platform/native/workface-file.ts'])
      assert.ok(observations.some(record => record.path === required), 'Required production consumer source: ' + required)
    receipt.consumers.push({ name, tests: result.numTotalTests, sourceSHA256: hash(JSON.stringify(observations)) })
  }
}
try {
  const roots = ['apps/desktop/src', 'packages/client-ui/src', 'apps/mobile/src', 'apps/host/src', 'apps/desktop/browser-extension', 'apps/mobile/ios/App/App']
  for (const scope of roots) for (const path of await sources(join(root, scope))) {
    if (path.endsWith('/identity-runtime.js')) continue
    const content = await readFile(path, 'utf8')
    assert.ok(!/\brandomUUID\s*\(|\bUUID\s*\(/.test(content), 'A client allocator bypass remains: ' + relative(root, path))
    receipt.sourceFiles.push({ path: relative(root, path), sha256: hash(content) })
  }
  for (const name of ['apps/desktop/scripts/update-renderer.mjs', 'apps/desktop/scripts/package-runtime-upgrade.mjs', 'apps/desktop/scripts/package-semantic-host.mjs', 'apps/desktop/scripts/macos-local-signing.mjs']) {
    const content = await readFile(join(root, name), 'utf8')
    assert.ok(!/\brandomUUID\s*\(/.test(content), 'A delivery allocator bypass remains: ' + name)
    receipt.sourceFiles.push({ path: name, sha256: hash(content) })
  }
  assert.ok(receipt.sourceFiles.length > 100, 'The source inventory must not be empty or narrowly filtered')
  await prepareBrowserExtensionIdentity()
  const extension = join(output, 'packaged-extension')
  await copyBrowserExtension(extension)
  await writeFile(join(extension, 'package.json'), '{"type":"module"}\n')
  const runtime = await readFile(join(extension, 'identity-runtime.js'), 'utf8')
  assert.equal(runtime, await readFile(new URL(import.meta.resolve('@agentmux/identity/runtime')), 'utf8'))
  assert.ok(!/\b(?:import\s|require\s*\()/.test(runtime), 'A packed extension cannot resolve workspace imports')
  const packaged = await import(pathToFileURL(join(extension, 'identity-runtime.js')).href)
  assert.match(packaged.mintObjectId(), /^[1-9A-HJ-NP-Za-km-z]{12}$/)
  assert.match(packaged.mintCapabilityToken(), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  // Import the actual copied extension worker with only its Chrome platform seam, not a workspace resolver.
  const signal = { addListener() {} }
  const chrome = { storage: { session: { async get() { return {} }, async set() {} } }, runtime: { onMessage: signal }, tabs: { onRemoved: signal, onUpdated: signal }, debugger: { onDetach: signal, onEvent: signal } }
  const beforeChrome = globalThis.chrome; globalThis.chrome = chrome
  try {
    const worker = await import(pathToFileURL(join(extension, 'service-worker.js')).href)
    await worker.worker.ready
    assert.match(worker.worker.instanceId, /^[1-9A-HJ-NP-Za-km-z]{12}$/)
  } finally { if (beforeChrome === undefined) delete globalThis.chrome; else globalThis.chrome = beforeChrome }
  const swift = await readFile(join(root, 'apps/mobile/ios/App/App/AgentMuxWorkfaceFilePlugin.swift'), 'utf8')
  assert.ok(swift.includes('call.getString("stagingId")') && swift.includes('^[1-9A-HJ-NP-Za-km-z]{12}$') && swift.includes('"agentmux-workface-" + stagingId') && swift.includes('withIntermediateDirectories: false'))
  const guard = swift.match(/let stagingId = call\.getString\("stagingId"\), (stagingId\.utf8\.count == 12),\s*(stagingId\.range\([^\n]+ != nil),/)
  assert.ok(guard, 'The actual native single-segment guard must be present')
  const nativeProbe = join(output, 'native-staging.swift'), nativeExecutable = join(output, 'native-staging')
  await writeFile(nativeProbe, `import Foundation
func permitted(_ stagingId: String) -> Bool {
  guard ${guard[1]}, ${guard[2]} else { return false }
  return true
}
precondition(permitted("111111111111"))
for candidate in ["11111111111", "1111111111111", "111111111111\\n", "../111111111", "11111/111111", "111111111110", "11111111-1111-4111-8111-111111111111"] {
  precondition(!permitted(candidate))
}
`)
  const nativeCommand = async (command, args) => {
    let text = ''
    const code = await new Promise((accept, reject) => {
      const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes })
      child.once('error', reject); child.once('exit', code => accept(code))
    })
    assert.equal(code, 0, text)
  }
  await nativeCommand('xcrun', ['swiftc', '-frontend', '-parse', join(root, 'apps/mobile/ios/App/App/AgentMuxWorkfaceFilePlugin.swift')])
  await nativeCommand('xcrun', ['swiftc', nativeProbe, '-o', nativeExecutable])
  await nativeCommand(nativeExecutable, [])
  receipt.packaging = { runtimeSHA256: hash(runtime), workerSHA256: hash(await readFile(join(extension, 'service-worker.js'))), nativeStagingGate: true, actualNativeSyntaxParse: true, actualFoundationGuardCases: 8, iosRuntime: false }
  // Actual electron-vite production preload build, retaining the sandbox bundle contract.
  const preload = join(output, 'preload')
  const preloadConfig = join(output, 'preload.config.mjs')
  const buildConfig = { preload: { root: join(root, 'apps/desktop'), build: { externalizeDeps: false, outDir: preload, emptyOutDir: true,
    rollupOptions: { input: join(root, 'apps/desktop/src/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } } } }
  await writeFile(preloadConfig, 'export default ' + JSON.stringify(buildConfig) + '\n')
  const buildEnvironment = { ...process.env }
  try { await build({ configFile: preloadConfig, ignoreConfigWarning: true }) }
  finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(buildEnvironment, key)) delete process.env[key]
    Object.assign(process.env, buildEnvironment)
  }
  const bundled = await readFile(join(preload, 'index.cjs'), 'utf8')
  const requirements = [...bundled.matchAll(/require\(["']([^"']+)["']\)/g)].map(match => match[1])
  assert.ok(requirements.length > 0 && requirements.every(name => name === 'electron'), 'Sandbox preload may only require Electron')
  let api
  const ipc = { on() {}, removeListener() {}, sendSync() { return null }, invoke: async () => undefined }
  const electron = { contextBridge: { exposeInMainWorld(_name, value) { api = value } }, ipcRenderer: ipc, webFrame: {}, webUtils: {} }
  const host = { addEventListener() {}, removeEventListener() {} }
  runInNewContext(bundled, { require(name) { assert.equal(name, 'electron'); return electron }, module: { exports: {} }, exports: {}, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, window: host, process: { platform: 'darwin', versions: {} }, console, setTimeout, clearTimeout })
  assert.equal(typeof api?.conversation?.readAgentConversation, 'function')
  const calls = []; ipc.invoke = async (...args) => { calls.push(args); return undefined }
  await api.search.query({ query: 'original query' })
  assert.match(calls[0][1], /^[1-9A-HJ-NP-Za-km-z]{12}$/)
  receipt.preload = { sha256: hash(bundled), externalRequirements: requirements, actualSearchCorrelation: true }
  await runConsumer('baseline')
  for (const mutation of Object.keys(clientIdentityMutations)) await runConsumer('mutation-' + mutation, mutation)
  await runConsumer('restored')
  receipt.status = 'passed'
} catch (error) { receipt.status = 'failed'; receipt.error = String(error?.stack ?? error); throw error }
finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); process.stdout.write(relative(root, join(output, 'receipt.json')) + '\n') }
