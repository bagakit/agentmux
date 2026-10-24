import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const outputRoot = join(root, ".local/state/native-desktop/consumers")
await mkdir(outputRoot, { recursive: true })
const output = await mkdtemp(join(outputRoot, "run-"))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const desktop = 'apps/desktop/', source = desktop + 'src/', tests = desktop + 'test/'
const baseline = ['native-desktop-owner.test.ts', 'native-desktop-consumers.test.ts', 'native-composer-consumers.test.tsx', 'composer-screenshot.test.ts',
  'browser-image.test.ts', 'browser-screenshot-source.test.ts', 'browser-screenshot-workface.test.tsx', 'terminal-multiline-paste.test.tsx',
  'terminal-osc-clipboard.test.ts', 'browser-input-selection-ipc.test.ts'].map(file => tests + file)
const cases = [
  { id: 'original-main-native-owner', file: source + 'main/ipc.ts',
    from: "native: getDesktopNativeUiOwner,", to: "native: () => ({ ...getDesktopNativeUiOwner(), writeClipboardText: async () => {} }),",
    files: [tests + 'native-desktop-consumers.test.ts'], expected: 'shares one lazy exact application owner' },
  { id: 'ui-macos-native-owner', file: source + 'main/native-desktop-owner.ts',
    from: "process.platform === 'darwin'", to: 'false',
    files: [tests + 'native-desktop-owner.test.ts'], expected: 'macOS clipboard handlers consume the same native owner' },
  { id: 'ui-nonmac-existing-owner', file: source + 'main/native-desktop-owner.ts',
    from: "process.platform === 'darwin'", to: 'true',
    files: [tests + 'native-desktop-owner.test.ts'], expected: 'win32 retains its original Electron clipboard' },
  { id: 'cancel-is-not-an-attachment', file: source + 'main/composer-screenshot.ts',
    from: "if (result.state === 'cancelled') return null", to: "if (result.state === 'cancelled') return '/fabricated-cancel.png'",
    files: [tests + 'composer-screenshot.test.ts'], expected: 'treats only the native cancellation receipt as cancellation' },
  { id: 'clipboard-image-actual-write', file: source + 'main/native-desktop-ipc.ts',
    from: 'return ports.native().writeClipboardImage(image)', to: 'return Promise.resolve()',
    files: [tests + 'native-desktop-consumers.test.ts'], expected: 'copies the same processed Browser PNG' },
  { id: 'page-dimensions-through-shared-seam', file: source + 'main/browser-image.ts',
    from: 'return { png: image.toPNG(), width, height }', to: 'return { png: image.toPNG() }',
    files: [tests + 'browser-screenshot-source.test.ts'], expected: 'rejects original page pixel dimensions mismatching' },
  { id: 'original-surface-preencode-bounds', file: source + 'main/browser-image.ts',
    from: 'width > PNG_MAX_DIMENSION', to: 'false',
    files: [tests + 'browser-image.test.ts'], expected: 'refuses an oversized original render surface before PNG encoding' },
  { id: 'original-browser-read-release', file: source + 'main/browser-view-manager.ts',
    from: 'entry.resourceReads -= 1; this.emit(entry)', to: 'this.emit(entry)',
    files: [tests + 'browser-screenshot-source.test.ts'], expected: 'returns the original owner source' },
  { id: 'late-capture-target-binding', file: source + 'renderer/src/lib/use-composer-attachments.ts',
    from: 'return isCurrent() && insertion.current === editor ? value : null', to: 'return value',
    files: [tests + 'native-composer-consumers.test.tsx'], expected: 'keeps a late native selection out' },
  { id: 'terminal-clipboard-error-visible', file: source + 'renderer/src/components/TerminalView.tsx',
    from: 'if (pasteTargetRef.current === target && text) pasteIntoTerminal(target, text)\n    }).catch(reportError)',
    to: 'if (pasteTargetRef.current === target && text) pasteIntoTerminal(target, text)\n    }).catch(() => {})',
    files: [tests + 'terminal-multiline-paste.test.tsx'], expected: 'a native clipboard failure is reported' },
  { id: 'external-original-pixels', file: source + 'main/browser-external-owner.ts',
    from: 'source: screenshotSource(url, title, before, after), image }', to: 'source: screenshotSource(url, title, before, after), image: { ...image, width: 2 } }',
    files: [tests + 'browser-external-target.test.ts'], pattern: 'native image seam', expected: 'retains the original CDP pixels' }
]
const inputs = new Set([...baseline, ...cases.flatMap(item => [item.file, ...item.files]),
  source + 'main/native-desktop-owner.ts', source + 'main/native-desktop-ipc.ts', source + 'main/browser-image.ts',
  source + 'main/ipc-sender-trust.ts', tests + 'composer-local-feedback.test.tsx',
  source + 'main/pasted-image-read.ts', source + 'main/pasted-image-write.ts', source + 'preload/index.ts',
  source + 'renderer/src/components/AgentSessionComposer.tsx', source + 'renderer/src/components/NewTabSurface.tsx',
  source + 'renderer/src/components/BrowserPane.tsx', 'packages/native-desktop/src/image.ts',
  tests + 'native-consumers.config.mts', desktop + 'scripts/verify-native-consumers.mjs'])
const originals = new Map(await Promise.all([...inputs].map(async file => [file, await readFile(join(root, file))])))
const receipt = { schema: 'agentmux.native-desktop-consumers-proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  boundary: 'Original React Composer/Browser/Terminal consumers, actual preload and executed original Main registration, native IO fixture, durable pasted resources, original Browser GUI/CDP and extension bridge source fixtures. No user UI, OS selection, TCC grant, installed signature or physical pixel verification is claimed.',
  sharedTreeMutations: 0, inputs: Object.fromEntries([...originals].map(([file, bytes]) => [file, hash(bytes)])), runs: [] }
async function run(label, files, mutation, pattern) {
  const json = join(output, label + '.tests.json')
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', tests + 'native-consumers.config.mts', ...files,
    '--reporter=default', '--reporter=json', '--outputFile.json=' + json]
  if (pattern) args.push('-t', pattern)
  const env = { ...process.env }
  if (mutation) env.AGENTMUX_NATIVE_CONSUMER_MUTATION = JSON.stringify(mutation)
  else delete env.AGENTMUX_NATIVE_CONSUMER_MUTATION
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  await writeFile(join(output, label + '.log'), log)
  assert.equal(result.error, undefined, label + ': process/setup failure does not certify behavior')
  assert.equal(result.signal, null, label + ': killed process does not certify behavior')
  const report = JSON.parse(await readFile(json, 'utf8'))
  const executed = report.testResults.flatMap(file => file.assertionResults).filter(item => ['passed', 'failed'].includes(item.status))
  assert.ok(executed.length > 0, label + ': empty test execution')
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  for (const file of report.testResults) assert.equal(file.message, '', label + ': collection failure is not a behavioral result')
  if (mutation) {
    const owning = executed.find(item => item.fullName.includes(mutation.expected))
    assert.notEqual(result.status, 0, 'Production mutation survived: ' + mutation.id)
    assert.equal(owning?.status, 'failed', 'Original consumer assertion must fail: ' + mutation.id)
    assert.match(owning.failureMessages.join('\n'), /AssertionError|promise resolved|promise rejected/su)
  } else {
    assert.equal(result.status, 0, label + ': inspect ' + join(output, label + '.log'))
    assert.ok(executed.every(item => item.status === 'passed'))
  }
  receipt.runs.push({ label, exit: result.status, executed: executed.length, pattern: pattern ?? null,
    mutation: mutation ? { id: mutation.id, file: mutation.file, original: receipt.inputs[mutation.file],
      consumed: hash(originals.get(mutation.file).toString().replace(mutation.from, mutation.to)) } : null })
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
}
try {
  // This normal product preparation copies an existing dependency-free identity asset; no build/UI.
  const prep = spawnSync(process.execPath, [desktop + 'scripts/prepare-browser-extension-identity.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(prep.status, 0, prep.stderr)
  for (const item of cases) assert.equal(originals.get(item.file).toString().split(item.from).length, 2, 'Unique original mutation: ' + item.id)
  await run('baseline', baseline)
  await run('external-page-baseline', [tests + 'browser-external-target.test.ts'], undefined, 'native image seam')
  await run('native-unknown-ui', [tests + 'composer-local-feedback.test.tsx'], undefined, 'real Main native owner reports unknown locally')
  for (const item of cases) await run(item.id, item.files, item, item.pattern)
  await run('restored', baseline)
  for (const [file, bytes] of originals) assert.equal(hash(await readFile(join(root, file))), hash(bytes), 'Original source changed during proof: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message }; throw error }
finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
console.log(JSON.stringify({ passed: receipt.passed, mutations: cases.length, receipt: join(output, 'receipt.json') }))
