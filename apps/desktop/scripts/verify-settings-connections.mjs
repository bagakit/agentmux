import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { aliases, desktopRequire, installedDependency, root } from './fixtures/settings-connections/environment.mjs'

const fixture = resolve(root, 'apps/desktop/scripts/fixtures/settings-connections')
const packet = resolve(root, ".bagakit/design/settings-connections-fixture")
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const argv = process.argv.slice(2), operation = argv[0]
const section = operation === '--capture' ? argv[1] : 'connections'
assert.ok(['--owning', '--callers', '--capture', '--visual', '--preflight'].includes(operation), 'Explicit finite operation')
if (operation === '--capture') assert.ok(section === 'hosts' || section === 'devices')
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
    resolve(root, 'apps/desktop/test/settings-connections.test.tsx'), resolve(root, 'vitest.setup.ts'), resolve(root, 'pnpm-lock.yaml'),
    resolve(root, 'apps/desktop/package.json'), resolve(root, 'packages/core/package.json'), resolve(root, 'packages/client-ui/package.json'),
    resolve(root, 'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs'), ...['environment.mjs', 'vitest.config.mts', 'entry.tsx', 'data.ts', 'main.cjs', 'index.html'].map(name => resolve(fixture, name))]) await bind(file)
}
async function finalizeInputs() {
  for (const input of inputs.values()) assert.equal(sha(await readFile(resolve(root, input.path))), input.sha256, 'Exact Source readback: ' + input.path)
  receipt.inputs = [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path))
  assert.ok(receipt.inputs.length > 0, 'Nonempty actual Source input set')
  receipt.sourceIdentity = sha(JSON.stringify(receipt.inputs))
  receipt.sourceUnchanged = true
}
async function owning() {
  const variants = ['catalog', 'single', 'drafts']
  const messages = { catalog: 'Connections group owns exactly hosts and devices', single: 'Only the selected Host has an editable connection subtree', drafts: 'Submenu selection preserves the original authored Host draft' }
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
      env: { ...process.env, AGENTMUX_CONNECTIONS_EVIDENCE: directory, AGENTMUX_CONNECTIONS_MUTANT: mode.mutant }, onLine: line => log.push(line) })
    await writeFile(resolve(directory, 'process.log'), log.join('\n') + '\n')
    await writeFile(resolve(directory, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
    const result = JSON.parse(await readFile(output, 'utf8'))
    const loaded = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(loaded.length > 0, 'Actual nonempty production Source consumption')
    for (const input of loaded) { await bind(resolve(root, input.path)); assert.equal(inputs.get(input.path).sha256, input.originalSHA256) }
    assert.equal(execution.timedOut, false, 'Setup timeout cannot be Source mutation RED')
    const applied = loaded.filter(input => input.applied), failures = result.testResults.flatMap(suite => suite.assertionResults ?? []).filter(test => test.status === 'failed')
    if (mode.mutant !== 'baseline') {
      assert.equal(execution.exitCode, 1); assert.equal(applied.length, 1, 'One actual loaded owning Source block changes')
      assert.notEqual(applied[0].originalSHA256, applied[0].consumedSHA256)
      assert.equal(result.numFailedTests, 1); assert.equal(failures.length, 1)
      assert.ok(failures[0].failureMessages.some(message => message.includes('AssertionError') && message.includes(messages[mode.mutant])), 'Specific AssertionRED, never collection/compile/driver failure')
    } else {
      assert.equal(execution.exitCode, 0, JSON.stringify(failures.map(test => test.failureMessages)))
      assert.equal(result.success, true); assert.equal(result.numFailedTests, 0)
      assert.ok(result.numPassedTests >= (mode.label === 'baseline' ? 10 : 1), 'Nonempty complete bounded cases')
      assert.equal(applied.length, 0); assert.ok(loaded.every(input => input.originalSHA256 === input.consumedSHA256))
    }
    receipt.runs.push({ ...mode, execution, passed: mode.mutant === 'baseline', specificAssertionRED: mode.mutant !== 'baseline',
      passedTests: result.numPassedTests, failedTests: result.numFailedTests, mutation: applied,
      failures: failures.map(test => ({ title: test.title, messages: test.failureMessages })) })
  }
  assert.equal(receipt.runs.length, 7); assert.equal(receipt.runs.filter(run => run.specificAssertionRED).length, 3)
  if (operation === '--owning') {
    receipt.renderer = []
    for (const target of ['hosts', 'devices']) {
      const pointer = JSON.parse(await readFile(resolve(packet, `qualification/${target}.current.json`), 'utf8'))
      const file = resolve(root, pointer.captureRef), bytes = await readFile(file)
      assert.equal(sha(bytes), pointer.captureSHA256)
      const capture = JSON.parse(bytes)
      assert.equal(capture.passed, true); assert.equal(capture.render.completed, true); assert.equal(capture.images.length, 6)
      assert.ok(capture.render.interactions.some(item => item.kind === 'native-renderer-click'), 'Nonempty actual trusted Renderer interaction')
      if (target === 'hosts') for (const [kind, field, input] of [
        ['native-renderer-filtered-host-deletion', 'filteredReturn', 'host-01'],
        ['native-renderer-last-editable-host-deletion', 'lastReturn', 'host-02']
      ]) {
        const matches = capture.render.interactions.filter(item => item.kind === kind)
        assert.equal(matches.length, 1, 'Exactly the reviewed same-input native deletion case')
        assert.equal(matches[0].input, input)
        for (const fact of ['connected', 'visible', 'focused', 'pseudoFocus', 'documentHasFocus']) assert.equal(matches[0][field][fact], true, 'Accurate native deletion destination: ' + fact)
      }
      for (const input of capture.inputs) { await bind(resolve(root, input.path)); assert.equal(inputs.get(input.path).sha256, input.sha256) }
      receipt.renderer.push({ target, captureRef: pointer.captureRef, captureSHA256: pointer.captureSHA256, sourceIdentity: capture.sourceIdentity, boundary: capture.boundary })
    }
  }
}
async function callers() {
  const ts = desktopRequire('typescript'), base = 'apps/desktop/src/renderer/src/', c = base + 'components/'
  const files = ['settings/modules/hosts.tsx', 'settings/modules/devices.tsx', 'settings/settings-modules.ts', 'settings/HostSettingsPane.tsx',
    'settings/HostConnectionLibrary.tsx', 'settings/HostLinkedProjects.tsx', 'settings/DeviceManagementSettings.tsx', 'SettingsPanel.tsx', 'settings/SettingsOverviewPane.tsx'].map(path => c + path)
  files.push(base + 'App.tsx', base + 'store.ts')
  const occurrences = []
  for (const path of files) {
    const file = resolve(root, path), source = await readFile(file, 'utf8'); await bind(file)
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      let symbol, kind
      if (ts.isCallExpression(node)) { symbol = node.expression.getText(tree); kind = 'production call' }
      else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) { symbol = node.tagName.getText(tree); kind = 'production JSX' }
      else if (ts.isArrayLiteralExpression(node)) for (const item of node.elements) {
        if (ts.isIdentifier(item)) occurrences.push({ path, symbol: item.getText(tree), kind: 'production composition', line: tree.getLineAndCharacterOfPosition(item.getStart(tree)).line + 1 })
      }
      if (symbol) occurrences.push({ path, symbol, kind, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
      ts.forEachChild(node, visit)
    }; visit(tree)
  }
  const requirements = [['HostSettingsPane', c + 'settings/modules/hosts.tsx'], ['api.config.save', c + 'settings/modules/hosts.tsx'],
    ['devicesSettingsModule', c + 'settings/settings-modules.ts'], ['createSettingsCatalog', c + 'settings/settings-modules.ts'],
    ['DeviceManagementSettings', c + 'settings/modules/devices.tsx'], ['HostConnectionLibrary', c + 'settings/HostSettingsPane.tsx'],
    ['HostLinkedProjects', c + 'settings/HostSettingsPane.tsx'], ['useResourceDrafts', c + 'settings/HostSettingsPane.tsx'],
    ['settingsNavGroups', c + 'SettingsPanel.tsx'], ['visibleSettingsSections', c + 'SettingsPanel.tsx'],
    ['SettingsOverviewPane', c + 'SettingsPanel.tsx'], ['item.savedSummary', c + 'settings/SettingsOverviewPane.tsx'], ['SettingsPanel', base + 'App.tsx'],
    ['api.hosts.check', base + 'store.ts'], ...['ls', 'invite', 'approve', 'reject', 'revoke'].map(method => ['api.deviceManagement.' + method, c + 'settings/DeviceManagementSettings.tsx'])]
  receipt.callers = requirements.map(([symbol, path]) => {
    const matches = occurrences.filter(item => item.symbol === symbol && item.path === path)
    assert.ok(matches.length > 0, 'Nonempty production consumer outside definitions/imports/fixture: ' + symbol + ' in ' + path)
    return { symbol, path, matches }
  })
  const device = await readFile(resolve(root, c + 'settings/modules/devices.tsx'), 'utf8')
  assert.ok(device.includes('active={active}'), 'Actual module passes original active contract')
  assert.equal(occurrences.filter(item => item.path === c + 'settings/modules/devices.tsx' && item.symbol.startsWith('api.')).length, 0, 'Neutral module and saved summary do not read device diagnostics')
  const index = resolve(root, base + 'styles/index.css'), css = resolve(root, base + 'styles/settings-connections.css')
  await bind(index); await bind(css)
  assert.equal((await readFile(index, 'utf8')).split("@import './settings-connections.css';").length, 2, 'Exactly one actual CSS composition import')
  const style = await readFile(css, 'utf8')
  assert.ok(style.includes('.settings-host-branch') && style.includes('.settings-host-page') && style.includes('.settings-host-projects'), 'Owning new CSS has actual nonempty navigation and project rules')
  receipt.styleConsumer = { index: relative(root, index), owner: relative(root, css), consumers: [c + 'settings/HostConnectionLibrary.tsx', c + 'settings/HostLinkedProjects.tsx'] }
}

async function capture() {
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-connections-')), output = resolve(evidence, 'compiled')
  const cssInputs = new Set()
  try {
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases }, esbuild: { jsx: 'automatic' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'actual-settings-connections-source', enforce: 'pre', resolveId: installedDependency,
        async transform(_code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await bind(file) } }],
      css: { postcss: { plugins: [{ postcssPlugin: 'bound-production-cascade', Once(tree) {
        tree.walk(node => { const file = node.source?.input?.file; if (file?.startsWith(root + '/') && !file.includes('/node_modules/')) cssInputs.add(file) })
      } }] } },
      build: { target: 'esnext', outDir: output, emptyOutDir: true } })
    for (const file of cssInputs) await bind(file)
    assert.ok(cssInputs.size > 20, 'Actual full production imported CSS cascade is Source-bound')
    assert.ok(cssInputs.has(resolve(root, 'apps/desktop/src/renderer/src/styles/settings-connections.css')), 'Actual owning Connections CSS participates in full cascade')
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
      temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 120_000, onLine: line => { log.push(line) } })
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
  receipt.seals = []
  for (const section of ['hosts', 'devices']) {
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
  receipt.seals.push({ captureRef: pointer.captureRef, captureSHA256: pointer.captureSHA256, visualPeerRef: pointer.visualPeerRef, visualPeerSHA256: pointer.visualPeerSHA256,
    sourceIdentity: capture.sourceIdentity, images: capture.images, reviewer: peer.reviewer, scope: peer.scope })
  }
}

try {
  await bindBase()
  if (operation === '--owning' || operation === '--preflight') await owning()
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
