import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidenceRoot = join(root, '.local/state/screenshot-experience/shortcut')
await mkdir(evidenceRoot, { recursive: true })
const output = await mkdtemp(join(evidenceRoot, 'run-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = 'apps/desktop/src/', tests = 'apps/desktop/test/'
const config = tests + 'screenshot-shortcut.config.mts'
const baseline = ['screenshot-shortcut.test.ts', 'screenshot-shortcut-wiring.test.ts', 'screenshot-shortcut-composer.test.tsx',
  'screenshot-shortcut-global.test.ts', 'screen-capture.test.ts', 'native-desktop-consumers.test.ts', 'native-composer-consumers.test.tsx',
  'screenshot-shortcut-discovery.test.tsx', 'shortcut-registry.test.ts', 'shortcut-cheat-sheet.test.ts', 'settings-keyboard-shortcuts.test.tsx'].map(file => tests + file)
const mutations = [
  { id: 'actual-main-registration', file: source + 'main/screenshot-shortcut.ts',
    from: 'owned = shortcuts.register(accelerator, request)', to: 'owned = false',
    test: 'screenshot-shortcut.test.ts', expected: 'uses the shared declaration for one macOS registration' },
  { id: 'actual-global-dispatch', file: source + 'main/ipc.ts',
    from: 'void globalScreenshot.run().catch(reportScreenshotIssue)', to: 'void Promise.resolve()',
    test: 'screenshot-shortcut-wiring.test.ts', expected: 'actual Main callback captures and copies with no Composer' },
  { id: 'attachment-is-optional', file: source + 'main/global-screenshot.ts',
    from: 'this.ports.capture(attachment !== null)', to: 'this.ports.capture(true)',
    test: 'screenshot-shortcut-global.test.ts', expected: 'captures with no Renderer or workbench' },
  { id: 'single-pending-selection', file: source + 'main/global-screenshot.ts',
    from: 'if (this.pending) return this.pending', to: 'if (false) return this.pending',
    test: 'screenshot-shortcut-global.test.ts', expected: 'repeated pending hotkeys do not open another selection' },
  { id: 'clipboard-is-real-delivery', file: source + 'main/screen-capture.ts',
    from: 'native.writeClipboardImage(final)', to: 'Promise.resolve()',
    test: 'screen-capture.test.ts', expected: 'copies the same final pixels and saves a durable draft image' },
  { id: 'explicit-edit-intent', file: source + 'main/screen-capture.ts',
    from: "if (result.completionAction === 'edit')", to: 'if (false)',
    test: 'screen-capture.test.ts', expected: 'edit intent defers all delivery' },
  { id: 'actual-agent-focus-claim', file: source + 'renderer/src/components/AgentSessionComposer.tsx',
    from: 'attachments.claimScreenshotTarget(event)', to: 'void 0',
    test: 'screenshot-shortcut-composer.test.tsx', expected: 'real false focused message input pins its bookmark' },
  { id: 'actual-launcher-focus-claim', file: source + 'renderer/src/components/NewTabSurface.tsx',
    from: '<div className="launcher-composer composer" onFocusCapture={attachments.claimScreenshotTarget}>', to: '<div className="launcher-composer composer">',
    test: 'screenshot-shortcut-composer.test.tsx', expected: 'real true focused message input pins its bookmark' },
  { id: 'current-input-focus', file: source + 'renderer/src/lib/use-composer-attachments.ts',
    from: '!focus.element.contains(focus.element.ownerDocument.activeElement)', to: 'false',
    test: 'screenshot-shortcut-composer.test.tsx', expected: 'without current input focus the real false Composer' },
  { id: 'original-document-generation', file: source + 'renderer/src/lib/use-composer-attachments.ts',
    from: 'documentKey !== undefined && shortcut.current.key !== documentKey', to: 'false',
    test: 'screenshot-shortcut-composer.test.tsx', expected: 'same editor in a new document generation never receives the old screenshot' },
  { id: 'maintained-editor-bookmark', file: 'packages/client-ui/src/lib/composer-insertion.ts',
    from: 'bookmark = bookmark.map(transaction.mapping)', to: 'void transaction.mapping',
    test: 'screenshot-shortcut-composer.test.tsx', expected: 'real false focused message input pins its bookmark' }
]
const inputs = new Set([...baseline, config, 'apps/desktop/scripts/verify-screenshot-shortcut.mjs', ...mutations.map(item => item.file),
  source + 'shared/screenshot-shortcut.ts', source + 'shared/contracts.ts', source + 'main/ipc-sender-trust.ts',
  source + 'main/screen-capture.ts', source + 'main/native-desktop-ipc.ts', source + 'main/pasted-image-write.ts', source + 'main/pasted-image-read.ts',
  source + 'renderer/src/main.tsx', source + 'renderer/src/lib/screenshot-attachment.ts', source + 'shared/screenshot-attachment.ts', source + 'renderer/src/lib/api.ts', source + 'renderer/src/lib/workbench-windows.tsx', source + 'renderer/src/lib/shortcut-registry.ts',
  source + 'renderer/src/lib/shortcut-cheat-sheet.ts', source + 'renderer/src/components/AgentComposerTools.tsx',
  source + 'renderer/src/components/settings/KeyboardShortcutsPane.tsx', tests + 'helpers/composer-dom-fixture.tsx', tests + 'helpers/client-ui-render.tsx',
  'packages/client-ui/package.json', 'packages/client-ui/src/components/InlineComposer.tsx', 'apps/desktop/scripts/radix-overlay-aliases.ts'])
const originals = new Map(await Promise.all([...inputs].map(async file => [file, await readFile(join(root, file))])))
const receipt = { schema: 'agentmux.screenshot-shortcut-proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  boundary: 'Actual production Main registration and disposal statements, original trusted IPC handler, preload, exact Main frame and startup receiver; real Agent and Launcher React rich editors, typed native result fixture and durable PNG resources. Electron globalShortcut is an injected port: no physical system key, other-app foreground, AppKit picker, TCC, native application build, packaging or installation is proved.',
  sharedTreeMutations: 0, inputs: Object.fromEntries([...originals].map(([file, bytes]) => [file, hash(bytes)])), runs: [] }

function inspectResult(label, status, log, report, files, mutation) {
  assert.ok(Number.isInteger(status) && status >= 0, label + ': missing process exit is not a behavior result')
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  const executed = assertions.filter(item => ['passed', 'failed'].includes(item.status))
  assert.ok(executed.length > 0, label + ': empty/all-skipped execution')
  for (const file of report.testResults) assert.equal(file.message, '', label + ': collection error is not a behavior result')
  if (mutation) {
    const owning = executed.find(item => item.fullName.includes(mutation.expected))
    assert.notEqual(status, 0, 'Production mutation survived: ' + mutation.id)
    assert.equal(owning?.status, 'failed', 'The named original consumer must fail: ' + mutation.id)
    assert.match(owning.failureMessages.join('\n'), /AssertionError|promise resolved|promise rejected/su)
  } else {
    assert.equal(status, 0, label + ': inspect ' + join(output, label + '.log'))
    assert.ok(assertions.every(item => item.status === 'passed'), label + ': skipped assertions do not certify the baseline')
    for (const file of files) {
      const original = report.testResults.find(result => resolve(result.name) === join(root, file))
      assert.ok(original?.assertionResults.length > 0, 'Missing original test consumer: ' + file)
    }
  }
  return executed.length
}
function inspectLoaded(bytes, mutation) {
  const loaded = bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  if (mutation) {
    const expected = hash(originals.get(mutation.file).toString().replace(mutation.from, mutation.to))
    const edits = loaded.filter(item => item.file === mutation.file && item.mutation === mutation.id)
    assert.ok(edits.length > 0, 'Mutation was not consumed by the actual product: ' + mutation.id)
    assert.ok(edits.every(item => item.sourceSha256 === receipt.inputs[mutation.file] && item.loadedSha256 === expected), 'Wrong loaded production mutation: ' + mutation.id)
  } else {
    for (const file of ['packages/client-ui/src/components/InlineComposer.tsx', 'packages/client-ui/src/lib/composer-insertion.ts']) {
      const rows = loaded.filter(item => item.file === file)
      assert.ok(rows.length > 0, 'The real maintained editor source was not consumed: ' + file)
      assert.ok(rows.every(item => item.mutation === null && item.sourceSha256 === receipt.inputs[file] && item.loadedSha256 === receipt.inputs[file]))
    }
  }
}

// Reuse only a complete same-input proof with its exact original raw artifacts.
// Changed source, harness, tests, missing logs, empty suites and infrastructure failures never qualify.
for (const directory of await readdir(evidenceRoot, { withFileTypes: true })) {
  if (!directory.isDirectory() || !directory.name.startsWith('run-') || join(evidenceRoot, directory.name) === output) continue
  const previousRoot = join(evidenceRoot, directory.name), previousPath = join(previousRoot, 'receipt.json')
  try {
    const previous = JSON.parse(await readFile(previousPath, 'utf8'))
    assert.equal(previous.schema, receipt.schema); assert.equal(previous.passed, true); assert.equal(previous.sharedTreeMutations, 0)
    assert.deepEqual(previous.inputs, receipt.inputs)
    assert.deepEqual(previous.runs.map(run => run.label), ['baseline', ...mutations.map(item => item.id)])
    for (const run of previous.runs) {
      const log = await readFile(join(previousRoot, run.label + '.log'))
      const json = await readFile(join(previousRoot, run.label + '.tests.json'))
      const loaded = await readFile(join(previousRoot, run.label + '.loaded.ndjson'))
      assert.equal(hash(log), run.logSha256); assert.equal(hash(json), run.reportSha256)
      assert.equal(hash(loaded), run.loadedSha256)
      const mutation = mutations.find(item => item.id === run.label)
      inspectLoaded(loaded, mutation)
      assert.equal(inspectResult(run.label, run.exit, log.toString(), JSON.parse(json), mutation ? [tests + mutation.test] : baseline, mutation), run.executed)
    }
    for (const [file, original] of originals) assert.equal(hash(await readFile(join(root, file))), hash(original), 'Input changed while reusing proof: ' + file)
    await rmdir(output)
    process.stdout.write(JSON.stringify({ passed: true, reused: true, candidate: receipt.candidate, receipt: previousPath }) + '\n')
    process.exit(0)
  } catch { /* An unavailable or changed prior observation never replaces this execution. */ }
}

async function run(label, files, mutation) {
  const reportPath = join(output, label + '.tests.json')
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, ...files,
    '--reporter=default', '--reporter=json', '--outputFile.json=' + reportPath]
  const env = { ...process.env }
  env.AGENTMUX_SCREENSHOT_SHORTCUT_LOADED = join(output, label + '.loaded.ndjson')
  if (mutation) env.AGENTMUX_SCREENSHOT_SHORTCUT_MUTATION = JSON.stringify(mutation)
  else delete env.AGENTMUX_SCREENSHOT_SHORTCUT_MUTATION
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  await writeFile(join(output, label + '.log'), log)
  assert.equal(result.error, undefined, label + ': process/setup failure does not prove behavior')
  assert.equal(result.signal, null, label + ': signal does not prove a killed production branch')
  const json = await readFile(reportPath)
  const loaded = await readFile(env.AGENTMUX_SCREENSHOT_SHORTCUT_LOADED)
  inspectLoaded(loaded, mutation)
  const executed = inspectResult(label, result.status, log, JSON.parse(json), files, mutation)
  receipt.runs.push({ label, exit: result.status, executed, logSha256: hash(log), reportSha256: hash(json), loadedSha256: hash(loaded),
    mutation: mutation ? { id: mutation.id, file: mutation.file, original: receipt.inputs[mutation.file],
      consumed: hash(originals.get(mutation.file).toString().replace(mutation.from, mutation.to)) } : null })
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
}

try {
  assert.ok(baseline.length > 0 && mutations.length > 0)
  for (const item of mutations) assert.equal(originals.get(item.file).toString().split(item.from).length, 2, 'Unique original branch: ' + item.id)
  await run('baseline', baseline)
  for (const mutation of mutations) await run(mutation.id, [tests + mutation.test], mutation)
  for (const [file, original] of originals) assert.equal(hash(await readFile(join(root, file))), hash(original), 'Input changed during proof: ' + file)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }
  throw error
} finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
process.stdout.write(JSON.stringify({ passed: receipt.passed, mutations: mutations.length, receipt: join(output, 'receipt.json') }) + '\n')
