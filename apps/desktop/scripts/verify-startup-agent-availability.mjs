import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { captureStartupProduct } from './fixtures/startup-agent-availability/capture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const base = join(root, '.tmp/startup-agent-availability/qualification')
await mkdir(base, { recursive: true })
const evidence = await mkdtemp(join(base, 'run-'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const store = 'apps/desktop/src/renderer/src/store.ts'
const mainSettings = 'apps/desktop/src/main/settings/modules/general.ts'
const agentTest = 'apps/desktop/test/startup-agent-availability.test.tsx'
const settingsTest = 'apps/desktop/test/startup-settings-control.test.ts'
const tests = [agentTest, settingsTest, 'apps/desktop/test/startup-settings-pane.test.tsx']
const sources = [store, mainSettings, 'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/components/StartupLoadingSurface.tsx',
  'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx',
  'apps/desktop/src/renderer/src/lib/startup-progress.ts', 'apps/desktop/src/renderer/src/styles/full-page-loading.css',
  'apps/desktop/src/shared/client-observation.ts', 'apps/desktop/src/shared/config-edit.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/main/config-store.ts',
  'apps/desktop/src/main/settings-control.ts',
  'apps/desktop/src/renderer/src/components/settings/GeneralSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/general.tsx',
  'packages/core/src/agentmux-cli-resource-guide.ts', ...tests, relative(root, fileURLToPath(import.meta.url))]
const pin = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(join(root, file)))])))
// Consume the same exact qualified inputs when Tracker records the final gate;
// a source, test, fixture or loaded dependency change requires a fresh run.
const qualified = join(base, 'latest-qualified.json')
try {
  const prior = JSON.parse(await readFile(qualified, 'utf8'))
  assert.equal(prior.passed, true)
  assert.deepEqual(await pin(sources), prior.sourceAfter)
  const product = JSON.parse(await readFile(join(root, prior.product.directory, 'capture.json'), 'utf8'))
  assert.equal(product.completed, true)
  assert.equal(product.sourceIdentity, prior.product.sourceIdentity)
  assert.ok(Object.keys(product.inputs).length > 0)
  for (const [file, input] of Object.entries(product.inputs)) assert.equal(digest(await readFile(join(root, file))), input.sha256)
  console.log(JSON.stringify({ passed: true, reusedExactEvidence: prior.evidence, sourceIdentity: product.sourceIdentity }))
  process.exit(0)
} catch { /* Missing or changed evidence runs the qualification below. */ }
const receipt = { schema: 'agentmux.startup-agent-availability-qualification.v1', passed: false,
  evidence: relative(root, evidence),
  sourceBefore: await pin(sources), mutations: [], callers: [], product: null,
  boundary: 'Loaded production Source mutations; real Store/General/ConfigOwner/RPC/compiled CLI; private complete Renderer product proof. No user Runtime or live Agent process is changed.' }
console.log('startup-qualification-evidence=' + relative(root, evidence))

async function run(label, command, args) {
  const output = await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes })
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal, text }))
  })
  await writeFile(join(evidence, label + '.log'), output.text)
  return output
}
async function test(label, files, config) {
  const report = join(evidence, label + '.json')
  const result = await run(label, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...files, '--maxWorkers=1',
    '--config', config ?? './vitest.config.ts', '--root', '.', '--reporter=json', '--outputFile=' + report])
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  const assertions = parsed.testResults.flatMap(file => file.assertionResults).filter(item => !['pending', 'skipped'].includes(item.status))
  assert.ok(assertions.length > 0, 'The accepted production tests must actually execute')
  assert.equal(result.signal, null, 'A killed process is not a semantic mutation result')
  return { code: result.code, total: assertions.length, passed: assertions.filter(item => item.status === 'passed').length,
    assertionRed: assertions.filter(item => item.status === 'failed' && item.failureMessages.some(text => /AssertionError|expected .* to /su.test(text))).map(item => item.fullName) }
}
try {
  const coreBuild = await run('core-build', 'pnpm', ['--filter', '@agentmux/core...', 'build'])
  assert.equal(coreBuild.code, 0, coreBuild.text)
  const typecheck = await run('desktop-typecheck', 'pnpm', ['--filter', '@agentmux/desktop', 'typecheck'])
  assert.equal(typecheck.code, 0, typecheck.text)
  receipt.green = await test('candidate-green', tests)
  assert.equal(receipt.green.code, 0); assert.equal(receipt.green.passed, receipt.green.total)
  const mutations = [
    { name: 'default-wait-removed', file: store,
      from: 'pending: true, waiting: config.startup?.skipAgentAvailabilityCheckWait !== true', to: 'pending: true, waiting: false', tests: [agentTest] },
    { name: 'joined-diagnostic-completes-too-early', file: store,
      from: 'if (targets.length === 0) { await Promise.all(inFlight); return }', to: 'if (targets.length === 0) return', tests: [agentTest] },
    { name: 'continue-reopens-wait', file: store,
      from: 'if (check?.waiting) set({ startupAgentAvailability: { ...check, waiting: false } })',
      to: 'if (check?.waiting) set({ startupAgentAvailability: { ...check, waiting: true } })', tests: [agentTest] },
    { name: 'failure-notice-disconnected', file: 'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx',
      from: 'const inboxes = [agentChecksInbox, environmentInbox,', to: 'const inboxes = [environmentInbox,', tests: [agentTest] },
    { name: 'public-setting-default-inverted', file: mainSettings,
      from: "booleanSetting('startup.skipAgentAvailabilityCheckWait', false,", to: "booleanSetting('startup.skipAgentAvailabilityCheckWait', true,", tests: [settingsTest] }
  ]
  for (const mutation of mutations) {
    const original = await readFile(join(root, mutation.file), 'utf8')
    assert.equal(original.split(mutation.from).length, 2, 'One actual production mutation seam: ' + mutation.name)
    const variant = original.replace(mutation.from, mutation.to)
    const witness = join(evidence, mutation.name + '-loaded.json'), config = join(evidence, mutation.name + '.config.mts')
    await writeFile(config, `import { mergeConfig } from 'vitest/config';
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))};
import { createHash } from 'node:crypto'; import { writeFileSync } from 'node:fs';
export default mergeConfig(base, { plugins: [{ name: 'actual-startup-mutation', enforce: 'pre', transform(source, id) {
  if (id.split('?')[0] !== ${JSON.stringify(join(root, mutation.file))}) return;
  const from = ${JSON.stringify(mutation.from)}, to = ${JSON.stringify(mutation.to)};
  if (source.split(from).length !== 2) throw new Error('Missing or ambiguous production seam');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const original = hash(source); const code = source.replace(from, to);
  writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ file: ${JSON.stringify(mutation.file)}, original, loaded: hash(code) }));
  return { code, map: null };
} }] });\n`)
    const red = await test(mutation.name + '-red', mutation.tests, config)
    const loaded = JSON.parse(await readFile(witness, 'utf8'))
    assert.equal(loaded.original, digest(original)); assert.equal(loaded.loaded, digest(variant))
    assert.notEqual(red.code, 0); assert.ok(red.assertionRed.length > 0, 'Actual assertion RED, not compilation failure')
    receipt.mutations.push({ name: mutation.name, loaded, red })
    console.log('PASS loaded mutation: ' + mutation.name)
  }
  receipt.restored = await test('exact-restored-green', tests)
  assert.equal(receipt.restored.code, 0); assert.equal(receipt.restored.passed, receipt.restored.total)
  // Runtime behavior above carries the proof; these nonempty groups bind its real product consumers.
  for (const [file, names] of [
    ['apps/desktop/src/renderer/src/App.tsx', ['StartupLoadingSurface']],
    [store, ['get().detectExecutors', 'api.executors.detect', 'api.executors.discover']],
    ['apps/desktop/src/main/settings-control.ts', ['setting.entry', 'setting.apply']]
  ]) {
    const source = await readFile(join(root, file), 'utf8'), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const found = new Set()
    const visit = node => {
      if (ts.isCallExpression(node) && names.includes(node.expression.getText(tree))) found.add(node.expression.getText(tree))
      if (ts.isJsxSelfClosingElement(node) && names.includes(node.tagName.getText(tree))) found.add(node.tagName.getText(tree))
      ts.forEachChild(node, visit)
    }
    visit(tree)
    assert.equal(found.size, names.length, 'Nonempty outside-definition consumer group: ' + file)
    receipt.callers.push({ file, names: [...found], sha256: digest(source) })
  }
  const productDirectory = join(evidence, 'product')
  const product = await captureStartupProduct({ root, evidence: productDirectory })
  assert.equal(product.completed, true)
  assert.equal(product.phases.length, 4, 'Default, failed-check restart, durable restart and skip restart all run')
  assert.ok(product.frames.length >= 5, 'Normal/narrow startup and settings, plus original failure service window')
  receipt.product = { directory: relative(root, productDirectory), sourceIdentity: product.sourceIdentity,
    phases: product.phases, frames: product.frames, aestheticReview: 'independent-review-required' }
  receipt.sourceAfter = await pin(sources)
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Accepted input Source must remain unchanged')
  receipt.passed = true
  await writeFile(qualified, JSON.stringify(receipt, null, 2) + '\n')
} catch (error) {
  receipt.failure = { message: error.message, stack: error.stack }
} finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure?.message }))
if (!receipt.passed) process.exitCode = 1
