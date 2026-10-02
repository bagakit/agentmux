import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { aliases, desktopRequire, installedDependency, root } from './fixtures/settings-resource-library/environment.mjs'

const fixture = resolve(root, 'apps/desktop/scripts/fixtures/settings-resource-library')
const packet = resolve(root, ".bagakit/design/settings-resource-library-fixture")
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const argv = process.argv.slice(2), operation = argv[0]
const section = operation === '--agents' ? 'agents' : operation === '--hosts' ? 'hosts' : argv[1]
assert.ok(['--agents', '--hosts', '--callers', '--capture', '--visual'].includes(operation), 'Select an explicit finite verification command')
assert.ok(section === 'agents' || section === 'hosts', 'Select one resource task')
const evidence = resolve(packet, ("" + (operation.slice(2)) + "-" + (section) + "-" + (globalThis.crypto.randomUUID()) + ""))
await mkdir(evidence, { recursive: true })
const inputs = new Map(), compiled = []
const receipt = { passed: false, section, operation, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), runs: [],
  boundary: 'Finite actual Source/UI/Preview evidence; no full Desktop/Native/SSH/Runtime/user App/Run or installation claim.' }
async function bind(file) {
  if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
  const path = relative(root, file), bytes = await readFile(file), digest = sha(bytes)
  if (inputs.has(path)) assert.equal(inputs.get(path).sha256, digest, 'Proof input changed: ' + path)
  else {
    inputs.set(path, { path, bytes: bytes.length, sha256: digest })
    const target = resolve(evidence, 'source', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
  }
}
async function bindBase() {
  for (const file of [fileURLToPath(import.meta.url), resolve(root, 'apps/desktop/scripts/probe-process.mjs'),
    resolve(root, 'apps/desktop/test/settings-resource-library.test.tsx'), resolve(root, 'vitest.setup.ts'), resolve(root, 'pnpm-lock.yaml'),
    resolve(root, 'apps/desktop/package.json'), resolve(root, 'packages/core/package.json'), resolve(root, 'packages/client-ui/package.json'),
    ...['environment.mjs', 'vitest.config.mts', 'entry.tsx', 'main.cjs', 'index.html'].map(name => resolve(fixture, name))]) await bind(file)
}
async function finalizeInputs() {
  for (const input of inputs.values()) assert.equal(sha(await readFile(resolve(root, input.path))), input.sha256, 'Exact Source readback: ' + input.path)
  receipt.inputs = [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path))
  assert.ok(receipt.inputs.length > 0, 'Nonempty actual Source input set')
  receipt.sourceIdentity = sha(JSON.stringify(receipt.inputs))
  receipt.sourceUnchanged = true
}
async function owning() {
  const variants = section === 'agents' ? ['single', 'drafts', 'navigation'] : ['single', 'disclosure', 'captured']
  const messages = section === 'agents' ? {
    single: 'Only the selected Executor owns a field subtree', drafts: 'Changing selection preserves the original authored Executor draft',
    navigation: 'New same-ID navigation request clears resource filtering'
  } : { single: 'Local detail has no SSH field subtree', disclosure: 'Switching away and back preserves this Host advanced disclosure', captured: 'Test captures the complete authored Host configuration' }
  const vitest = desktopRequire.resolve('vitest/vitest.mjs'), config = resolve(fixture, 'vitest.config.mts')
  const modes = [{ label: 'baseline', mutant: 'baseline' }, ...variants.flatMap(kind => [
    { label: kind + '-mutant', mutant: kind, test: kind + ':' }, { label: kind + '-restored', mutant: 'baseline', test: kind + ':' }
  ])]
  for (const mode of modes) {
    const directory = resolve(evidence, mode.label); await mkdir(directory)
    const output = resolve(directory, 'results.json'), log = []
    const args = [vitest, 'run', '--config', config, '--reporter=json', '--outputFile', output]
    if (mode.test) args.push('--testNamePattern', mode.test)
    const execution = await runProbeProcess(process.execPath, args, { temporaryRoot: directory, cwd: root, timeoutMs: 30_000,
      env: { ...process.env, AGENTMUX_RESOURCE_LIBRARY_EVIDENCE: directory, AGENTMUX_RESOURCE_LIBRARY_SECTION: section, AGENTMUX_RESOURCE_LIBRARY_MUTANT: mode.mutant }, onLine: line => log.push(line) })
    await writeFile(resolve(directory, 'process.log'), log.join('\n') + '\n')
    await writeFile(resolve(directory, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
    const result = JSON.parse(await readFile(output, 'utf8'))
    const loaded = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(loaded.length > 0, 'Nonempty actual product Source consumption')
    for (const input of loaded) { await bind(resolve(root, input.path)); assert.equal(inputs.get(input.path).sha256, input.originalSHA256) }
    assert.equal(execution.timedOut, false, 'Setup timeout is not a mutation RED')
    const applied = loaded.filter(input => input.applied), failures = result.testResults.flatMap(suite => suite.assertionResults ?? []).filter(test => test.status === 'failed')
    if (mode.mutant !== 'baseline') {
      assert.equal(execution.exitCode, 1, 'Loaded product mutation must fail its concrete case')
      assert.equal(applied.length, 1, 'Exactly one owning product Source block was consumed after mutation')
      assert.notEqual(applied[0].originalSHA256, applied[0].consumedSHA256, 'Actual loaded product bytes changed')
      assert.equal(result.numFailedTests, 1, 'Exactly the intended meaningful assertion failed')
      assert.equal(failures.length, 1)
      assert.ok(failures[0].failureMessages.some(message => message.includes('AssertionError') && message.includes(messages[mode.mutant])), 'Specific AssertionRED, never collection/compile/setup failure')
    } else {
      assert.equal(execution.exitCode, 0, JSON.stringify(failures.map(test => test.failureMessages)))
      assert.equal(result.success, true); assert.equal(result.numFailedTests, 0)
      assert.ok(result.numPassedTests >= (mode.label === 'baseline' ? 5 : 1), 'Actual bounded test set executed, not empty/skip green')
      assert.equal(applied.length, 0)
      assert.ok(loaded.every(input => input.originalSHA256 === input.consumedSHA256), 'Exact original Source restored')
    }
    receipt.runs.push({ ...mode, execution, passed: mode.mutant === 'baseline', specificAssertionRED: mode.mutant !== 'baseline', passedTests: result.numPassedTests,
      failedTests: result.numFailedTests, mutation: applied, failures: failures.map(test => ({ title: test.title, messages: test.failureMessages })) })
  }
  assert.equal(receipt.runs.length, 7); assert.equal(receipt.runs.filter(run => run.specificAssertionRED).length, 3)
}

async function callers() {
  const ts = desktopRequire('typescript'), component = section === 'agents' ? 'AgentSettingsPane' : 'HostSettingsPane'
  const base = 'apps/desktop/src/renderer/src/', owner = base + `components/settings/${component}.tsx`, module = base + `components/settings/modules/${section}.tsx`
  const files = [module, owner, base + 'components/SettingsPanel.tsx', base + 'components/AppShell.tsx', base + 'App.tsx', base + 'store.ts']
  const occurrences = []
  for (const path of files) {
    const file = resolve(root, path)
    let source
    try { source = await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    await bind(file)
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      let symbol, kind
      if (ts.isCallExpression(node)) { symbol = node.expression.getText(tree); kind = 'product call' }
      else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) { symbol = node.tagName.getText(tree); kind = 'product JSX' }
      else if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'navigationRequest') { symbol = 'navigationRequest'; kind = 'product prop transmission' }
      if (symbol) occurrences.push({ path, symbol, kind, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
      ts.forEachChild(node, visit)
    }; visit(tree)
  }
  const requirements = [[component, module], ['SettingsResourceLibrary', owner], ['api.config.save', module], ['SettingsPanel', base + 'App.tsx']]
  if (section === 'agents') requirements.push(['navigationRequest', module], ['navigationRequest', base + 'components/SettingsPanel.tsx'], ['detectExecutors', owner])
  else requirements.push(['checkHost', owner], ['api.hosts.check', base + 'store.ts'], ['DeviceManagementSettings', owner])
  receipt.callers = requirements.map(([symbol, path]) => {
    const matches = occurrences.filter(item => item.symbol === symbol && item.path === path)
    assert.ok(matches.length > 0, 'Nonempty production consumer outside definition/import/test/fixture: ' + symbol + ' in ' + path)
    return { symbol, path, matches }
  })
  const index = resolve(root, base + 'styles/index.css'), css = resolve(root, base + 'styles/settings-resource-library.css')
  await bind(index); await bind(css)
  const entry = await readFile(index, 'utf8'), style = await readFile(css, 'utf8'), pane = await readFile(resolve(root, owner), 'utf8')
  assert.equal(entry.split("@import './settings-resource-library.css';").length, 2, 'One real production index CSS import')
  assert.ok(style.includes('.settings-resource-workbench') && style.includes('.settings-resource-editor') && style.includes('@container settings-resource'), 'Nonempty owning production layout rules')
  assert.ok(pane.includes('settings-resource-workbench') && pane.includes('settings-resource-editor'), 'Owning Pane actually consumes the imported CSS classes')
  receipt.styleConsumer = { index: relative(root, index), owner: relative(root, css), consumers: [owner, base + 'components/settings/SettingsResourceLibrary.tsx'] }
  await bind(resolve(root, receipt.styleConsumer.consumers[1]))
}

async function capture() {
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-resource-library-')), output = resolve(evidence, 'compiled')
  const cssInputs = new Set()
  try {
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases }, esbuild: { jsx: 'automatic' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'actual-settings-resource-source', enforce: 'pre', resolveId: installedDependency,
        async transform(_code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await bind(file) } }],
      css: { postcss: { plugins: [{ postcssPlugin: 'bound-production-cascade', Once(tree) {
        tree.walk(node => { const file = node.source?.input?.file; if (file?.startsWith(root + '/') && !file.includes('/node_modules/')) cssInputs.add(file) })
      } }] } },
      build: { target: 'esnext', outDir: output, emptyOutDir: true } })
    for (const file of cssInputs) await bind(file)
    assert.ok(cssInputs.size > 20, 'Actual full production imported CSS cascade is Source-bound')
    assert.ok(cssInputs.has(resolve(root, 'apps/desktop/src/renderer/src/styles/settings-resource-library.css')), 'Actual owning CSS participates in the consumed production cascade')
    async function walk(directory) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const file = resolve(directory, item.name)
        if (item.isDirectory()) await walk(file)
        else { const bytes = await readFile(file); compiled.push({ path: relative(output, file), bytes: bytes.length, sha256: sha(bytes) }) }
      }
    }
    await walk(output); assert.ok(compiled.length > 0); assert.ok(compiled.some(file => file.path.endsWith('.css')))
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const log = []
    receipt.execution = await runProbeProcess(desktopRequire('electron'), [resolve(fixture, 'main.cjs'), resolve(output, 'index.html'), privateRoot, evidence, section], {
      temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90_000, onLine: line => { log.push(line) } })
    await writeFile(resolve(evidence, 'process.log'), log.join('\n') + '\n')
    receipt.render = JSON.parse(await readFile(resolve(evidence, 'render.json'), 'utf8'))
    assert.equal(receipt.execution.timedOut, false); assert.equal(receipt.execution.exitCode, 0, receipt.render.failure?.message)
    assert.equal(receipt.render.completed, true); assert.equal(receipt.render.frames.length, 6)
    receipt.images = []
    for (const frame of receipt.render.frames) {
      const bytes = await readFile(resolve(evidence, frame.image)); assert.equal(bytes.readUInt32BE(16), frame.pngPixels.width); assert.equal(bytes.readUInt32BE(20), frame.pngPixels.height)
      receipt.images.push({ path: frame.image, bytes: bytes.length, sha256: sha(bytes), width: frame.width, theme: frame.theme, pngPixels: frame.pngPixels })
    }
    receipt.cssInputs = [...cssInputs].map(file => relative(root, file)).sort(); receipt.compiled = compiled
    receipt.aestheticReview = 'pending independent actual PNG review'
  } finally {
    receipt.remaining = await listProbeProcesses(-1, privateRoot); assert.deepEqual(receipt.remaining, [], 'Only owned private processes must be reaped')
    await rm(privateRoot, { recursive: true, force: true }); receipt.temporaryRootRemoved = true
    await writeFile(resolve(evidence, 'cleanup.json'), JSON.stringify({ remaining: receipt.remaining, temporaryRootRemoved: true }) + '\n')
  }
}

async function visual() {
  const currentFile = resolve(packet, `qualification/${section}.current.json`), pointer = JSON.parse(await readFile(currentFile, 'utf8'))
  assert.ok(pointer.captureRef && pointer.visualPeerRef, 'Explicit fixed capture and independent peer seal')
  const captureFile = resolve(root, pointer.captureRef), peerFile = resolve(root, pointer.visualPeerRef)
  const captureBytes = await readFile(captureFile), peerBytes = await readFile(peerFile)
  assert.equal(sha(captureBytes), pointer.captureSHA256, 'Sealed complete capture receipt')
  assert.equal(sha(peerBytes), pointer.visualPeerSHA256, 'Sealed independent actual image review')
  const capture = JSON.parse(captureBytes), peer = JSON.parse(peerBytes)
  assert.equal(capture.passed, true); assert.equal(capture.section, section); assert.equal(capture.images.length, 6)
  assert.equal(peer.passed, true); assert.equal(peer.sourceIdentity, capture.sourceIdentity); assert.equal(peer.images.length, 6)
  assert.ok(peer.reviewer && peer.scope && peer.scope.includes('static'), 'Named finite static image reviewer with explicit boundary')
  assert.deepEqual(peer.images.map(image => image.sha256).sort(), capture.images.map(image => image.sha256).sort(), 'Each actual reviewed original PNG is exact')
  for (const image of capture.images) assert.equal(sha(await readFile(resolve(dirname(captureFile), image.path))), image.sha256, 'Original complete PNG unchanged')
  for (const input of capture.inputs) { await bind(resolve(root, input.path)); assert.equal(inputs.get(input.path).sha256, input.sha256, 'Current proof Source exactly matches independent reviewed input') }
  for (const item of capture.compiled) assert.equal(sha(await readFile(resolve(dirname(captureFile), 'compiled', item.path))), item.sha256, 'Actual compiled capture artifact is preserved')
  assert.deepEqual(capture.images.map(image => `${image.width}-${image.theme}`).sort(), ['320-light', '320-dark', '640-light', '640-dark', '1480-light', '1480-dark'].sort())
  receipt.seal = { captureRef: pointer.captureRef, captureSHA256: pointer.captureSHA256, visualPeerRef: pointer.visualPeerRef, visualPeerSHA256: pointer.visualPeerSHA256,
    sourceIdentity: capture.sourceIdentity, images: capture.images, reviewer: peer.reviewer, scope: peer.scope }
}

try {
  await bindBase()
  if (operation === '--agents' || operation === '--hosts') await owning()
  else if (operation === '--callers') await callers()
  else if (operation === '--capture') await capture()
  else await visual()
  await finalizeInputs(); receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  throw error
} finally {
  if (!receipt.inputs) receipt.inputs = [...inputs.values()]
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), section, operation, sourceIdentity: receipt.sourceIdentity,
    inputs: receipt.inputs.length, frames: receipt.images?.length, runs: receipt.runs.length, failure: receipt.failure?.message }))
}
