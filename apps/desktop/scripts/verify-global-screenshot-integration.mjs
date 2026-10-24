import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.local/state/global-screenshot/integration')
await mkdir(evidence, { recursive: true })
const output = await mkdtemp(join(evidence, 'run-'))
const sha = value => createHash('sha256').update(value).digest('hex')
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const proofKind = process.argv[2] === '--proof' ? process.argv[3] : null
assert.ok(process.argv.length === 2 || process.argv.length === 4 && ['native', 'editor'].includes(proofKind), 'Usage: verify-global-screenshot-integration.mjs [--proof native|editor]')
async function current(inputs) {
  assert.ok(Object.keys(inputs).length > 0, 'A proof must bind nonempty production inputs')
  for (const [file, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(join(root, file))), hash, 'Changed proof input: ' + file)
}
async function proof(directory, schema) {
  for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).filter(entry => entry.isDirectory())) {
    const file = join(root, directory, entry.name, 'receipt.json')
    try {
      const result = await readJson(file)
      assert.equal(result.schema, schema); assert.equal(result.passed, true)
      await current(result.inputs)
      return { file, sha256: sha(await readFile(file)), result }
    } catch { /* Only a complete proof for these exact inputs is admissible. */ }
  }
  throw new Error('No passing current-candidate proof in ' + directory)
}

const receipt = { schema: 'agentmux.global-screenshot-integration.v1', passed: false,
  boundary: 'Real Main capture, exact original-frame attachment and independent editor owners with controlled Electron/native IO; consumes source-bound AppKit and real independent Renderer proofs plus independent image review. No physical shortcut, WindowServer, TCC or installed-app claim.' }
try {
  if (proofKind) {
    const reviewName = proofKind === 'native' ? 'visual-review-native.md' : 'visual-review-editor.md'
    const review = await readFile(join(root, '.local/state/global-screenshot', reviewName), 'utf8')
    assert.match(review, /approved|批准/i)
    if (proofKind === 'native') {
      const file = join(root, '.local/state/global-screenshot/native-candidate/receipt.json'), native = await readJson(file)
      assert.equal(native.schema, 'agentmux.native-selection-verification.v1')
      await current(native.sourceHashes)
      assert.ok(native.stateChecks.tests > 0 && native.stateChecks.failures.length === 0 && native.appKit.tests > 0)
      assert.ok(native.mutations.length > 0 && native.mutations.every(item => item.state.startsWith('killed-by-')))
      receipt.proof = { file, sha256: sha(await readFile(file)) }
    } else {
      const editor = await proof('.local/system-screenshot-editor', 'agentmux.system-screenshot-editor-proof.v1')
      assert.equal(editor.result.native.passed, true)
      assert.ok(editor.result.native.cases.length > 0 && editor.result.native.screenshots.length > 0)
      assert.ok(editor.result.runs.length > 1 && editor.result.runs[0].assertions > 0 && editor.result.runs.slice(1).every(run => run.code !== 0))
      receipt.proof = { file: editor.file, sha256: editor.sha256 }
    }
    receipt.scope = proofKind
    receipt.review = { file: reviewName, sha256: sha(review) }
    receipt.passed = true
  } else {
    const shortcut = await proof('.local/state/screenshot-experience/shortcut', 'agentmux.screenshot-shortcut-proof.v1')
    const editor = await proof('.local/system-screenshot-editor', 'agentmux.system-screenshot-editor-proof.v1')
    const nativeFile = join(root, '.local/state/global-screenshot/native-candidate/receipt.json'), native = await readJson(nativeFile)
    await current(native.sourceHashes)
    assert.ok(native.stateChecks.tests > 0 && native.stateChecks.failures.length === 0 && native.appKit.tests > 0)
    assert.ok(native.mutations.length > 0 && native.mutations.every(item => item.state.startsWith('killed-by-')))
    assert.ok(shortcut.result.runs.length > 1 && shortcut.result.runs.slice(1).every(run => run.exit !== 0))
    assert.equal(editor.result.native.passed, true)
    assert.ok(editor.result.runs.length > 1 && editor.result.runs.slice(1).every(run => run.code !== 0))
    const reviews = {}
    for (const name of ['visual-review-native.md', 'visual-review-editor.md', 'implementation-review.md']) {
      const file = join(root, '.local/state/global-screenshot', name), text = await readFile(file, 'utf8')
      assert.match(text, /approved|批准/i, 'Missing independent disposition: ' + name)
      reviews[name] = sha(text)
    }
    const test = 'apps/desktop/test/global-screenshot-integration.test.ts', config = 'apps/desktop/test/global-screenshot-integration.config.mts'
    const inputs = Object.fromEntries(await Promise.all([test, config, 'apps/desktop/scripts/verify-global-screenshot-integration.mjs',
      'apps/desktop/src/main/global-screenshot.ts', 'apps/desktop/src/main/screen-capture.ts', 'apps/desktop/src/main/system-screenshot-editor.ts']
      .map(async file => [file, sha(await readFile(join(root, file)))])))
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=json', '--outputFile=' + join(output, 'tests.json')], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
    await writeFile(join(output, 'tests.log'), result.stdout + result.stderr)
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr)
    const tests = await readJson(join(output, 'tests.json'))
    assert.equal(tests.numPassedTests, 4); assert.equal(tests.numFailedTests, 0); assert.equal(tests.numPendingTests, 0)
    await current(inputs)
    receipt.inputs = inputs
    receipt.proofs = { shortcut: { file: shortcut.file, sha256: shortcut.sha256 }, editor: { file: editor.file, sha256: editor.sha256 },
      native: { file: nativeFile, sha256: sha(await readFile(nativeFile)) } }
    receipt.reviews = reviews
    receipt.tests = { passed: tests.numPassedTests, sha256: sha(await readFile(join(output, 'tests.json'))) }
    receipt.passed = true
  }
} finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
process.stdout.write(JSON.stringify({ passed: true, receipt: join(output, 'receipt.json') }) + '\n')
