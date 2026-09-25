import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(import.meta.url), exec = promisify(execFile), { build } = await import('vite'), ts = require('typescript')
const fixture = join(desktop, 'scripts/fixtures/result-ready-input-continuity')
const privateRoot = await mkdtemp('/tmp/amx-result-ready-input-')
const evidence = join(repository, '.tmp/result-ready-input-continuity', `attempt-${Date.now()}`)
const candidateOnly = process.argv.includes('--candidate-only')
const selectedMutation = process.argv.includes('--mutation') ? process.argv[process.argv.indexOf('--mutation') + 1] : null
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = ['components/SessionPane.tsx', 'components/SessionResultReview.tsx', 'components/TerminalView.tsx',
  'components/AgentComposer.tsx', 'components/AgentSessionComposer.tsx', 'components/AgentRegionHeader.tsx',
  'styles/result-review.css', 'styles/agent.css', 'styles/agent-region-header.css']
const sourceRoot = join(desktop, 'src/renderer/src')
const result = { schema: 'agentmux.result-ready-input-delivery.v1', passed: false, candidateOnly, selectedMutation, completeDelivery: false, userRunTouched: false,
  aestheticReview: 'not-performed', sourceBefore: {}, sourceAfter: {}, mutations: [], callers: [], cleanup: {} }
async function sources() { return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(sourceRoot, file)))]))) }
async function compiled(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }), files = {}
  for (const entry of entries) if (entry.isFile()) {
    const path = join(entry.parentPath, entry.name); files[path.slice(directory.length + 1)] = hash(await readFile(path))
  }
  assert.ok(Object.keys(files).length > 0, 'The actual private renderer outputs are nonempty'); return files
}
function replaceOne(source, from, to) {
  assert.equal(source.split(from).length, 2, 'The private mutation anchors exactly one real production block')
  return source.replace(from, to)
}
const mutations = [
  { label: 'automatic-layout-flow', file: 'components/SessionPane.tsx', expected: /Automatic Result ready preserves the original terminal geometry/,
    change(source) {
      source = replaceOne(source, 'sessionId={session.id} resultReview={resultReview}', 'sessionId={session.id}')
      return replaceOne(source, '      <OpenDestinationPopover\n', '      {session.status.state === \'done\' ? resultReview : null}\n      <OpenDestinationPopover\n')
    } },
  { label: 'automatic-focus-takeover', file: 'components/SessionResultReview.tsx', expected: /never steals terminal focus/,
    change: source => replaceOne(source, '  const acquireNativeSurfaceOverlay = useAppStore',
      '  useEffect(() => { if (ready && !dismissed) trigger.current?.focus() }, [ready, dismissed])\n  const acquireNativeSurfaceOverlay = useAppStore') },
  { label: 'actual-keyboard-write', file: 'components/TerminalView.tsx', expected: /Trusted keyboard input reaches production sessions.write/,
    change: source => replaceOne(source, 'if (!readOnlyRef.current) void api.sessions.write(session.control, data, source).catch(reportError)',
      'void 0 // private block mutation: cut the actual native keyboard write callback') },
  { label: 'stable-result-slot', file: 'components/SessionResultReview.tsx', expected: /Automatic Result ready preserves the original terminal geometry/,
    change: source => replaceOne(source, 'if (!session || session.kind !== \'agent\' || !ready || dismissed) return <span className="session-result-review-slot" aria-hidden="true" />',
      'if (!session || session.kind !== \'agent\' || !ready || dismissed) return null') },
  { label: 'explicit-collapse', file: 'components/SessionResultReview.tsx', probe: 'complete', expected: /Collapse closes the actual native popover and releases its lease/,
    change: source => replaceOne(source,
      'popover.current?.hidePopover(); setExpanded(false); trigger.current?.focus({ preventScroll: true })',
      'setExpanded(false); trigger.current?.focus({ preventScroll: true })') },
  { label: 'next-result-discoverability', file: 'components/SessionResultReview.tsx', probe: 'complete', expected: /A new completed turn exposes its result control/,
    change: source => replaceOne(source, 'if (!ready) { setExpanded(false); setDismissed(false) }', 'if (!ready) { setExpanded(false) }') },
  { label: 'own-region-result-details', file: 'styles/result-review.css', probe: 'complete', expected: /Result details stay inside their owning Region|Result details leave the original Terminal input area visible/,
    change: source => replaceOne(source,
      'width: min(360px, calc(anchor-size(width) - 2 * var(--sp-3)))', 'width: 720px') }
]
assert.ok(!selectedMutation || mutations.some(mutation => mutation.label === selectedMutation), 'The requested private mutation exists')
async function renderer(label, mutation = null, probe = 'complete') {
  const directory = join(evidence, label), outDir = join(privateRoot, label, 'out'), processRoot = join(privateRoot, label)
  await mkdir(directory, { recursive: true }); await mkdir(processRoot, { recursive: true })
  const wrapper = join(processRoot, 'record-xterm.mjs')
  const privateMain = join(processRoot, 'probe-main.cjs'), mainBytes = await readFile(join(fixture, 'main.cjs'))
  await writeFile(privateMain, mainBytes)
  await writeFile(wrapper, `import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))};
export class Terminal extends xterm.Terminal { constructor(...args) { super(...args); const entries = globalThis.resultReadyTerminals ??= [];
  this.probeIdentity = { id: entries.length, terminal: this, disposed: false }; entries.push(this.probeIdentity) }
  dispose() { this.probeIdentity.disposed = true; return super.dispose() } }
`)
  const loadedSourceInputs = {}, importedStyleInputs = {}, mutationRecords = []
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: wrapper }] },
    plugins: [{ name: 'result-input-private-compile', enforce: 'pre',
      async transform(source, id) {
        if ((id.startsWith(join(desktop, 'src') + '/') || id.startsWith(fixture + '/')) && !id.includes('?')) loadedSourceInputs[id.slice(repository.length + 1)] = hash(source)
        if (mutation && id === join(sourceRoot, mutation.file)) {
          const changed = mutation.change(source)
          assert.notEqual(changed, source, 'The actual production behavior block was changed')
          await writeFile(join(directory, 'original-source.txt'), source); await writeFile(join(directory, 'mutated-source.txt'), changed)
          mutationRecords.push({ file: id.slice(repository.length + 1), originalSha256: hash(source), mutatedSha256: hash(changed), productionWritten: false })
          return changed
        }
      },
      async generateBundle() {
        for (const file of this.getWatchFiles()) if (file.startsWith(join(desktop, 'src') + '/') && file.endsWith('.css'))
          importedStyleInputs[file.slice(repository.length + 1)] = hash(await readFile(file))
      }
    }],
    css: { postcss: { plugins: [{ postcssPlugin: 'result-input-private-imported-css',
      async Once(root) {
        if (!mutation?.file.endsWith('.css')) return
        const file = join(sourceRoot, mutation.file), source = await readFile(file, 'utf8'), changed = mutation.change(source)
        const original = [], replacement = []
        root.walkDecls('width', declaration => {
          if (declaration.source?.input.file === file && declaration.parent.selector === '.session-result-review__popover') original.push(declaration)
        })
        // Vite also processes unrelated imported sheets. The build-level record count below
        // proves the intended production file was actually found and transformed once.
        if (!original.length) return
        createRequire(require.resolve('vite'))('postcss').parse(changed, { from: file }).walkDecls('width', declaration => {
          if (declaration.parent.selector === '.session-result-review__popover') replacement.push(declaration)
        })
        assert.equal(original.length, 1, 'The imported production CSS has one actual width declaration')
        assert.equal(replacement.length, 1, 'The private CSS replacement changes that one declaration')
        assert.notEqual(original[0].value, replacement[0].value)
        const originalValue = original[0].value
        original[0].value = replacement[0].value
        await writeFile(join(directory, 'original-source.txt'), source); await writeFile(join(directory, 'mutated-source.txt'), changed)
        mutationRecords.push({ file: file.slice(repository.length + 1), originalSha256: hash(source), mutatedSha256: hash(changed),
          astDeclaration: { selector: '.session-result-review__popover', property: 'width', originalValue, mutatedValue: replacement[0].value }, productionWritten: false })
      }
    }] } }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  assert.ok(Object.keys(loadedSourceInputs).length > 0, 'Actual loaded production sources are nonempty')
  for (const file of files.filter(file => file.endsWith('.tsx'))) assert.ok(loadedSourceInputs['apps/desktop/src/renderer/src/' + file], 'The actual production consumer is compiled: ' + file)
  for (const file of ['styles/result-review.css', 'styles/agent-region-header.css', 'styles/terminal.css', 'styles/composer.css'])
    assert.equal(importedStyleInputs['apps/desktop/src/renderer/src/' + file], hash(await readFile(join(sourceRoot, file))), 'Actual product stylesheet is imported: ' + file)
  if (mutation) assert.equal(mutationRecords.length, 1, 'Exactly one private transform of the intended source')
  const identity = { loadedSourceInputs, importedStyleInputs, compiledFiles: await compiled(outDir),
    terminalWrapperSha256: hash(await readFile(wrapper)), privateMainSha256: hash(mainBytes), mutationRecords }
  await writeFile(join(directory, 'compiled.json'), JSON.stringify(identity, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const lines = [], outcome = await runProbeProcess(require('electron'), [privateMain, join(outDir, 'index.html'), processRoot, directory, probe], {
    temporaryRoot: processRoot, cwd: repository, env, timeoutMs: 90_000, onLine: line => lines.push(line)
  })
  await writeFile(join(directory, 'process.log'), lines.join('\n'))
  const rendered = JSON.parse(await readFile(join(directory, 'render.json'), 'utf8'))
  assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null)
  return { directory, outcome, rendered, identity }
}
async function callers() {
  const checks = [
    { symbol: 'SessionResultReview', definition: 'components/SessionResultReview.tsx', caller: 'components/SessionPane.tsx', attribute: null },
    { symbol: 'AgentSessionComposer', definition: 'components/AgentSessionComposer.tsx', caller: 'components/SessionPane.tsx', attribute: 'resultReview' },
    { symbol: 'AgentComposer', definition: 'components/AgentComposer.tsx', caller: 'components/AgentSessionComposer.tsx', attribute: 'resultReview' },
    { symbol: 'AgentRegionHeader', definition: 'components/AgentRegionHeader.tsx', caller: 'components/SessionPane.tsx', attribute: 'resultReview' }
  ]
  for (const check of checks) {
    assert.notEqual(check.definition, check.caller)
    const file = join(sourceRoot, check.caller), sourceText = await readFile(file, 'utf8'), source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), hits = []
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === check.symbol &&
        (!check.attribute || node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === check.attribute))) hits.push(node.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source); assert.ok(hits.length > 0, 'Non-definition/non-test/non-import production caller: ' + check.symbol)
    result.callers.push({ ...check, hits, sourceSha256: hash(sourceText) })
  }
}
try {
  await mkdir(evidence, { recursive: true }); result.sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
  result.sourceBefore = await sources(); await callers()
  result.candidate = await renderer('candidate')
  assert.equal(result.candidate.outcome.exitCode, 0, result.candidate.rendered.failure?.message)
  assert.equal(result.candidate.rendered.passed, true)
  if (!candidateOnly) for (const mutation of mutations.filter(mutation => !selectedMutation || mutation.label === selectedMutation)) {
    const red = await renderer(mutation.label + '-red', mutation, mutation.probe ?? 'automatic')
    assert.equal(red.outcome.exitCode, 1, 'The private production mutation must turn the actual scene RED')
    assert.equal(red.rendered.passed, false); assert.equal(red.rendered.failure.name, 'AssertionError'); assert.match(red.rendered.failure.message, mutation.expected)
    result.sourceAfter = await sources(); assert.deepEqual(result.sourceAfter, result.sourceBefore, 'No production source is written during mutation')
    const restored = await renderer(mutation.label + '-restored', null, mutation.probe ?? 'automatic')
    assert.equal(restored.outcome.exitCode, 0, restored.rendered.failure?.message); assert.equal(restored.rendered.passed, true)
    result.mutations.push({ label: mutation.label, red, restored, productionWritten: false })
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
    console.log(`mutation=${mutation.label} RED/unchanged-production/GREEN`)
  }
  result.sourceAfter = await sources(); assert.deepEqual(result.sourceAfter, result.sourceBefore)
  result.completeDelivery = !candidateOnly && !selectedMutation && result.mutations.length === mutations.length
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot)
  // With no process group owner left, never pass the -1 discovery sentinel to a group signal.
  // Recheck each unique private path immediately before signalling a surviving owned process.
  for (const pid of remaining) await signalOwnedProbeProcess(pid, privateRoot, 'SIGKILL')
  result.cleanup = { before: remaining, after: await listProbeProcesses(-1, privateRoot) }
  assert.equal(result.cleanup.after.length, 0, 'All and only owned private probe processes are reaped')
  result.privateRoot = privateRoot
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
  await writeFile(join(evidence, 'review.md'), `# Result ready 输入连续\n\n候选私有编译真实 SessionPane / TerminalView / xterm / 产品 CSS；只有 preview API 的 Session、basic-vt checkpoint、ordered output、Git 与 result.txt 文件事实受控。不触碰用户 Run 或 OS 剪贴板。\n\n候选身份、行为、变异与清理：[receipt.json](./receipt.json)。本命令未进行独立看图评审。\n\n${(result.candidate?.rendered.frames ?? []).map(frame => `- ${frame.width}px ${frame.state}: [完整截图](./candidate/${frame.file})`).join('\n')}\n`)
  console.log(JSON.stringify({ passed: result.passed, evidence, receipt: join(evidence, 'receipt.json'), review: join(evidence, 'review.md'), failure: result.failure ?? null }))
  process.exitCode = result.passed ? 0 : 1
}
