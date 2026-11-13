import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'

const root = resolve(import.meta.dirname, '../../..'), output = resolve(process.argv[2])
const fixture = join(import.meta.dirname, 'fixtures/survey-agent-navigation')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const common = resolve(root, (await import('node:child_process')).execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())
const installed = createRequire(join(dirname(common), 'apps/desktop/package.json'))
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? installed('electron')
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const privateRoot = await fs.realpath(await fs.mkdtemp('/tmp/amx-survey-nav-'))
const hash = value => createHash('sha256').update(value).digest('hex')
async function hashes(directory) {
  const values = {}
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = join(directory, entry.name)
    if (entry.isDirectory()) for (const [key, value] of Object.entries(await hashes(name))) values[entry.name + '/' + key] = value
    else values[entry.name] = hash(await fs.readFile(name))
  }
  return values
}
const proof = { schema: 'agentmux.survey-agent-navigation-native.v1', passed: false, privateRoot, phases: [],
  independentVisualReview: 'pending', physicalComposition: 'unverified', nativeHitTest: 'unverified',
  boundary: 'Two real private Electron generations; actual App/Browser/Survey/Store/Core/Runtime/PTY and original durable Agent. Browser metadata/control is the explicit private fixture boundary, no native webpage or control-isolation claim.' }
await fs.mkdir(output, { recursive: true })
const previous = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'AGENTMUX_SPATIAL_STATE_STORE'].map(name => [name, process.env[name]]))
let client
try {
  const { assertWorkspaceDistBuiltFromCurrentSource } = await import(pathToFileURL(join(root, 'vitest.dist-freshness.ts')).href)
  await assertWorkspaceDistBuiltFromCurrentSource(root)
  const aliases = []
  for (const [name, directory] of [['host', 'apps/host'], ['client-ui', 'packages/client-ui'], ['connectors', 'packages/connectors'], ['native-desktop', 'packages/native-desktop'], ['layout', 'packages/layout']]) {
    const exports = JSON.parse(await fs.readFile(join(root, directory, 'package.json'), 'utf8')).exports
    for (const [key, value] of Object.entries(exports)) {
      const target = typeof value === 'string' ? value : value.browser ?? value.import
      if (!target) continue
      const replacement = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
      aliases.push({ find: new RegExp('^@agentmux/' + name + (key === '.' ? '' : key.slice(1)).replaceAll('*', '(.+)') + '$'), replacement: join(root, directory, replacement.replaceAll('*', '$1')) })
    }
  }
  aliases.sort((a, b) => b.find.source.length - a.find.source.length)
  // Public Core is this worktree's freshly built package, shared with Main.
  const coreExports = JSON.parse(await fs.readFile(join(root, 'packages/core/package.json'), 'utf8')).exports
  const coreAliases = Object.entries(coreExports).map(([key, value]) => ({ find: new RegExp('^@agentmux/core' + (key === '.' ? '' : key.slice(1)) + '$'), replacement: join(root, 'packages/core', value.import) }))
  // Client component exports use TSX; preserve its actual browser source shape.
  const ui = join(root, 'packages/client-ui/src')
  aliases.unshift({ find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: ui + '/components/$1.tsx' },
    { find: /^@agentmux\/client-ui\/theme$/, replacement: ui + '/theme/index.ts' }, { find: /^@agentmux\/client-ui\/icons$/, replacement: ui + '/theme/icons.tsx' })
  proof.electron = { path: electron, sha256: hash(await fs.readFile(electron)) }
  const consumed = new Map()
  const provenance = { name: 'current-navigation-consumers', generateBundle(_options, bundle) {
    for (const module of this.getModuleIds()) if (module.startsWith(root + '/') && !module.includes('/node_modules/') && !module.includes('?')) consumed.set(module, true)
  } }
  const reused = process.env.AGENTMUX_SURVEY_RENDERER_RECEIPT
  if (reused) {
    const before = JSON.parse(await fs.readFile(reused, 'utf8'))
    const inputs = before.rendererInputs
    assert.ok(inputs && Object.keys(inputs).length > 0)
    assert.ok(before.rendererArtifacts && Object.keys(before.rendererArtifacts).length > 0)
    assert.deepEqual(await hashes(join(dirname(reused), 'renderer')), before.rendererArtifacts)
    for (const [path, value] of Object.entries(inputs)) { assert.equal(hash(await fs.readFile(join(root, path))), value); consumed.set(join(root, path), true) }
    await fs.symlink(join(dirname(reused), 'renderer'), join(output, 'renderer'), 'dir')
    proof.rendererReuse = { receipt: reused, sha256: hash(await fs.readFile(reused)) }
  } else await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, plugins: [provenance],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
    resolve: { alias: [...coreAliases, ...aliases, { find: /^@xterm\/xterm$/, replacement: join(root, 'apps/desktop/scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    build: { target: 'esnext', minify: false, cssMinify: false, outDir: join(output, 'renderer'), emptyOutDir: true } })
  proof.rendererInputs = Object.fromEntries(await Promise.all([...consumed.keys()].map(async path => [relative(root, path), hash(await fs.readFile(path))])))
  proof.rendererArtifacts = await hashes(join(output, 'renderer'))
  await fs.writeFile(join(output, 'renderer-inputs.json'), JSON.stringify({ rendererInputs: proof.rendererInputs, rendererArtifacts: proof.rendererArtifacts }, null, 2))
  const mainAliases = [...aliases, ...['yaml', 'luxon'].map(name => ({ find: name, replacement: require.resolve(name) }))]
  await build({ configFile: false, root: fixture, logLevel: 'error', plugins: [provenance], resolve: { alias: mainAliases }, ssr: { noExternal: ['zod'] },
    build: { ssr: join(fixture, 'main.ts'), target: 'node22', outDir: join(output, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', '@agentmux/core', /^@agentmux\/core\//], output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  const { build: bundle } = createRequire(require.resolve('vite'))('esbuild')
  await bundle({ entryPoints: [join(import.meta.dirname, 'fixtures/space-agent-cli/preload.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(output, 'preload.cjs'), logLevel: 'silent' })
  for (const directory of ['home', 'app-data', 'user-data', 'session-data', 'runtime/tmp', 'other', 'topics', 'node_modules/@agentmux', 'node_modules/@noble']) await fs.mkdir(join(privateRoot, directory), { recursive: true })
  await fs.symlink(join(root, 'packages/core'), join(privateRoot, 'node_modules/@agentmux/core'))
  await fs.mkdir(join(output, 'node_modules/@agentmux'), { recursive: true })
  await fs.symlink(join(root, 'packages/core'), join(output, 'node_modules/@agentmux/core'))
  const coreRequire = createRequire(join(root, 'packages/core/package.json'))
  await fs.symlink(dirname(coreRequire.resolve('@noble/hashes/utils.js')), join(privateRoot, 'node_modules/@noble/hashes'))
  await fs.mkdir(join(output, 'node_modules/@noble'), { recursive: true })
  await fs.symlink(dirname(coreRequire.resolve('@noble/hashes/utils.js')), join(output, 'node_modules/@noble/hashes'))
  await fs.copyFile(join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), join(privateRoot, 'fake-codex-cli.mjs'))
  // Preserve Desktop's real module-relative native resource layout inside this
  // invocation; its ScratchTopics adapter supplies this exact helper location.
  await fs.mkdir(join(privateRoot, 'app/main'), { recursive: true })
  await fs.mkdir(join(privateRoot, 'resources/bin'), { recursive: true })
  await fs.copyFile(join(output, 'main/main.mjs'), join(privateRoot, 'app/main/main.mjs'))
  await fs.copyFile(join(root, 'apps/host/resources/bin/agentmux-workspace-move'), join(privateRoot, 'resources/bin/agentmux-workspace-move'))
  proof.nativeHelper = { source: hash(await fs.readFile(join(root, 'apps/host/native/workspace-move.c'))), binary: hash(await fs.readFile(join(privateRoot, 'resources/bin/agentmux-workspace-move'))) }
  proof.mainArtifact = hash(await fs.readFile(join(privateRoot, 'app/main/main.mjs')))
  const entry = join(privateRoot, 'entry.cjs')
  await fs.writeFile(entry, `const {app}=require('electron');const p=${JSON.stringify(privateRoot)};for(const [k,v]of Object.entries({home:'home',appData:'app-data',userData:'user-data',sessionData:'session-data'}))app.setPath(k,p+'/'+v);if(process.platform==='darwin')app.setActivationPolicy('prohibited');import(${JSON.stringify(pathToFileURL(join(privateRoot, 'app/main/main.mjs')).href)}).catch(error=>{require('fs').writeFileSync(${JSON.stringify(output)}+'/'+process.argv[4]+'.json',JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)});`)
  proof.sources = Object.fromEntries(await Promise.all([...consumed.keys(), ...['main.ts', 'renderer.mjs', 'index.html'].map(name => join(fixture, name))].map(async path => [relative(root, path), hash(await fs.readFile(path))])))
  assert.ok(Object.keys(proof.sources).some(path => path.endsWith('BrowserPane.tsx')) && Object.keys(proof.sources).some(path => path.endsWith('/store.ts')))
  const env = { ...privatePackageSmokeEnvironment(process.env, { userData: join(privateRoot, 'user-data'), runtimeRoot: join(privateRoot, 'runtime'), readyFile: join(privateRoot, 'unused-ready') }),
    AGENTMUX_WORKSPACE_MOVE_HELPER: join(root, 'apps/host/resources/bin/agentmux-workspace-move'),
    AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'runtime/state'),
    AGENTMUX_SPATIAL_STATE_STORE: join(privateRoot, 'runtime/state/spatial-state.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson') }
  for (const phase of ['seed', 'restore']) {
    const lines = []
    const process = await runProbeProcess(electron, [entry, privateRoot, output, phase, globalThis.process.execPath, join(output, 'renderer/index.html'), join(output, 'preload.cjs')],
      { cwd: root, env, timeoutMs: 60000, onLine: line => { lines.push(line); console.error(phase + ': ' + line.slice(0, 300)) } })
    await fs.writeFile(join(output, phase + '.log'), lines.join('\n'))
    const phaseRecord = { process }; proof.phases.push(phaseRecord)
    const result = JSON.parse(await fs.readFile(join(output, phase + '.json'), 'utf8'))
    phaseRecord.result = result
    assert.equal(process.exitCode, 0, result.failure?.message); assert.equal(result.passed, true)
  }
  const [first, second] = proof.phases.map(phase => phase.result)
  assert.notEqual(first.pid, second.pid)
  assert.equal(first.calls.filter(call => call.operation === 'launch').length, 1)
  assert.equal(first.calls.filter(call => call.operation === 'submit').length, 1)
  const original = first.persisted.find(session => session.agentSessionId === second.original.session.id)
  const restored = second.persisted.find(session => session.agentSessionId === original.agentSessionId)
  assert.deepEqual(restored.run, original.run); assert.deepEqual(restored.nativeHandle, original.nativeHandle); assert.ok(original.nativeHandle)
  assert.ok(second.runs.some(run => run.runId === original.run.runId && run.state === 'running'))
  for (const [path, before] of Object.entries(proof.sources)) assert.equal(hash(await fs.readFile(join(root, path))), before)
  proof.passed = true
} catch (error) { proof.failure = { message: error.message, stack: error.stack } }
finally {
  const cleanup = { errors: [], remaining: [] }
  try {
    if (proof.phases.some(phase => phase.result?.persisted?.length)) {
      Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'runtime/state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson') })
      const { connectLocalAgentMux, AgentMuxFileAgentSessionStore } = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')).href)
      client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(join(privateRoot, 'agent-sessions.json')) })
      for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId })
      await client.dispose()
    }
  } catch (error) { cleanup.errors.push(String(error)) }
  try { await stopProbeProcesses(-1, privateRoot); cleanup.remaining = await listProbeProcesses(-1, privateRoot) } catch (error) { cleanup.errors.push(String(error)) }
  if (cleanup.errors.length || cleanup.remaining.length) proof.passed = false
  proof.cleanup = cleanup
  for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  await fs.writeFile(join(output, 'receipt.json'), JSON.stringify(proof, null, 2))
}
console.log(JSON.stringify({ output, passed: proof.passed, failure: proof.failure, cleanup: proof.cleanup }, null, 2))
process.exitCode = proof.passed ? 0 : 1
