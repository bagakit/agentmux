import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

const root = await realpath(resolve(import.meta.dirname, '../../..'))
const args = process.argv.slice(2)
assert.ok(!args.length || args.length === 2 && args[0] === '--evidence', 'Use --evidence with one private evidence directory')
const area = resolve(root, args[1] ?? '.tmp/collaboration-reading-proof')
await mkdir(area, { recursive: true })
const directory = await mkdtemp(join(area, 'candidate-'))
const sha = value => createHash('sha256').update(value).digest('hex')
const local = path => {
  assert.ok(typeof path === 'string' && !isAbsolute(path) && !path.split(/[\\/]/u).includes('..'), 'Evidence paths must stay relative to this checkout')
  return join(root, path)
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'AGENT_INFORMATION_MUTATION'))
const candidate = new Map(), artifacts = new Map()
const receipt = { schema: 'agentmux.collaboration-reading-proof.v1', passed: false, sources: {}, runs: [], artifacts: {},
  boundary: 'Actual source hook and mounted Focus/Dialog/Card/Mailbox consumers. Native pointer behavior, paint and durable restart are separate evidence.' }

async function bind(path, expected) {
  const physical = relative(root, await realpath(local(path)))
  assert.ok(!isAbsolute(physical) && !physical.split(/[\\/]/u).includes('..'), 'Source links cannot escape this checkout: ' + path)
  const source = await readFile(local(path)), digest = sha(source)
  if (expected !== undefined) assert.equal(digest, expected, 'Loaded source differs from this checkout: ' + path)
  if (candidate.has(path)) assert.equal(candidate.get(path), digest, 'One candidate must be used by every consumer: ' + path)
  else candidate.set(path, digest)
  return source.toString('utf8')
}
async function artifact(path) { const name = relative(root, path); artifacts.set(name, sha(await readFile(path))); return name }

const readingConfig = 'apps/desktop/test/vitest.collaboration-reading.config.mts'
const productConfig = 'apps/desktop/test/vitest.collaboration-product.config.mts'
for (const path of ['apps/desktop/scripts/verify-collaboration-reading.mjs', readingConfig, productConfig,
  'apps/desktop/test/collaboration-reading.test.tsx', 'apps/desktop/test/collaboration-focus-product.test.tsx',
  'apps/desktop/test/collaboration-product-reading.test.tsx']) await bind(path)
const { collaborationReadingMutations } = await import(new URL('../test/vitest.collaboration-reading.config.mts', import.meta.url))
const { collaborationProductMutations } = await import(new URL('../test/vitest.collaboration-product.config.mts', import.meta.url))
const renderer = 'apps/desktop/src/renderer/src/'
const groups = [
  { name: 'reading', config: readingConfig, tests: ['apps/desktop/test/collaboration-reading.test.tsx'], minimumCases: 16,
    loadedKey: 'AGENTMUX_COLLABORATION_READING_LOADED', mutantKey: 'AGENTMUX_COLLABORATION_READING_MUTANT',
    requiredSources: ['lib/use-collaboration-reading.ts', 'lib/agent-collaboration.ts', 'lib/api.ts'],
    requiredPackages: ['packages/client-ui/src/lib/conversation-message-location.ts'],
    mutations: Object.entries(collaborationReadingMutations).map(([name, value]) => ({ name, path: renderer + 'lib/' + value.file,
      before: value.from, after: value.to, assertion: value.assertion })) },
  { name: 'product', config: productConfig,
    tests: ['apps/desktop/test/collaboration-focus-product.test.tsx', 'apps/desktop/test/collaboration-product-reading.test.tsx'], minimumCases: 14,
    loadedKey: 'AGENTMUX_COLLABORATION_PRODUCT_LOADED', mutantKey: 'AGENTMUX_COLLABORATION_PRODUCT_MUTATION',
    requiredSources: ['components/GlobalFocusSurface.tsx', 'components/FocusToolbar.tsx', 'components/AgentCollaborationDialog.tsx',
      'components/AgentCollaborationGraph.tsx', 'components/FocusContextCardBody.tsx', 'components/FocusContextRow.tsx',
      'components/MailboxA2A.tsx', 'lib/use-collaboration-reading.ts', 'lib/agent-collaboration.ts', 'lib/collaboration-workface.ts'],
    requiredPackages: ['packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/Modal.tsx', 'packages/core/src/agent-message-render.ts'],
    mutations: collaborationProductMutations.map(({ file, ...value }) => ({ ...value, path: renderer + file })) }
]

async function run(group, label, mutation) {
  const name = group.name + '-' + label, reportPath = join(directory, name + '.json'), loadedPath = join(directory, name + '.loaded.jsonl')
  await writeFile(loadedPath, '')
  const env = { ...environment, TMPDIR: '/tmp', [group.loadedKey]: loadedPath }
  if (mutation) {
    const original = await bind(mutation.path)
    assert.equal(original.split(mutation.before).length, 2, 'One exact mutation anchor: ' + mutation.name)
    assert.ok(mutation.assertion, 'A mutation must name its rejecting behavior assertion')
    env[group.mutantKey] = mutation.name
  }
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', group.config,
      '--reporter=json', '--outputFile=' + reportPath], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (exitCode, signal) => yes({ exitCode, signal, output }))
  })
  const logPath = join(directory, name + '.log'); await writeFile(logPath, result.output)
  assert.equal(result.signal, null, 'Interrupted tests cannot certify source')
  const report = await readJson(reportPath), files = report.testResults
  assert.ok(files.length > 0 && files.every(file => file.assertionResults.length > 0 && !file.message), 'Every selected file must execute assertions without a load error')
  assert.deepEqual(files.map(file => relative(root, file.name)).sort(), [...group.tests].sort(), 'Only the owning test files from this checkout may qualify the candidate')
  const cases = files.flatMap(file => file.assertionResults.map(test => ({ ...test, file: relative(root, file.name) })))
  assert.ok(cases.length >= group.minimumCases, 'The complete nonempty owning case set must run')
  assert.equal(report.numTotalTests, cases.length); assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0)
  assert.ok(cases.every(test => ['passed', 'failed'].includes(test.status)), 'Skipped assertions do not qualify a candidate')
  const rows = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(rows.length > 0, 'The actual compiler inputs must be observed')
  const loaded = new Map(), changed = new Set()
  for (const input of rows) {
    assert.ok((input.path.startsWith('apps/desktop/src/') || input.path.startsWith('packages/')) && !input.path.split('/').includes('dist'),
      'Read actual checkout source, never a linked old distribution: ' + input.path)
    const original = await bind(input.path, input.originalSHA256)
    const edited = mutation?.path === input.path
    const expected = edited ? original.replace(mutation.before, mutation.after) : original
    assert.equal(input.effectiveSHA256, sha(expected), 'The exact source mutation must reach the consumer: ' + input.path)
    if (input.originalSHA256 !== input.effectiveSHA256) changed.add(input.path)
    loaded.set(input.path, input.originalSHA256)
  }
  for (const path of group.requiredSources) assert.ok(loaded.has(renderer + path), 'Missing real owning consumer: ' + path)
  for (const path of group.requiredPackages) assert.ok(loaded.has(path), 'Missing shared package source from this checkout: ' + path)
  if (mutation) {
    assert.equal(result.exitCode, 1); assert.equal(report.success, false)
    assert.deepEqual([...changed], [mutation.path], 'Only the exact intended source may be mutated')
    assert.ok(cases.some(test => test.fullName === mutation.assertion && test.status === 'failed' &&
      test.failureMessages.some(message => message.includes('AssertionError'))), 'The named behavior must reject the mutation: ' + mutation.assertion)
  } else {
    assert.equal(result.exitCode, 0); assert.equal(report.success, true); assert.equal(report.numFailedTests, 0)
    assert.equal(report.numPassedTests, cases.length); assert.equal(changed.size, 0)
  }
  return { name, exitCode: result.exitCode, tests: cases.length, cases: cases.map(test => test.file + ':' + test.fullName).sort(),
    failed: cases.filter(test => test.status === 'failed').map(test => test.fullName),
    ...(mutation ? { mutation: mutation.name, source: mutation.path, assertion: mutation.assertion } : {}),
    report: await artifact(reportPath), loaded: await artifact(loadedPath), log: await artifact(logPath) }
}

async function pool(jobs) {
  const queue = [...jobs], results = []
  async function worker() { while (queue.length) { const job = queue.shift(); results.push(await job()) } }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(3, queue.length) }, worker))
  for (const result of settled) if (result.status === 'rejected') throw result.reason
  return results
}

try {
  assert.equal(groups[0].mutations.length, 11); assert.equal(groups[1].mutations.length, 5)
  const baseline = await pool(groups.map(group => async () => run(group, 'baseline')))
  receipt.runs.push(...baseline)
  const mutants = await pool(groups.flatMap(group => group.mutations.map(mutation => async () => {
    const result = await run(group, mutation.name, mutation)
    const original = baseline.find(item => item.name === group.name + '-baseline')
    assert.deepEqual(result.cases, original.cases, 'A mutation must collect the same actual behavior cases')
    console.log(group.name + '/' + mutation.name + ': named behavior rejected the actual source mutation')
    return result
  })))
  receipt.runs.push(...mutants)
  const restored = await pool(groups.map(group => async () => {
    const result = await run(group, 'restored'), original = baseline.find(item => item.name === group.name + '-baseline')
    assert.deepEqual(result.cases, original.cases, 'Restored source must execute the same complete case set')
    return result
  }))
  receipt.runs.push(...restored)
  for (const [path, digest] of candidate) assert.equal(sha(await readFile(local(path))), digest, 'Source changed during qualification: ' + path)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message } }
receipt.sources = Object.fromEntries([...candidate].sort(([a], [b]) => a.localeCompare(b)))
receipt.artifacts = Object.fromEntries([...artifacts].sort(([a], [b]) => a.localeCompare(b)))
const path = join(directory, 'receipt.json'); await writeFile(path, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, readingCases: receipt.runs.find(run => run.name === 'reading-baseline')?.tests,
  productCases: receipt.runs.find(run => run.name === 'product-baseline')?.tests,
  mutations: receipt.runs.filter(run => run.mutation).length, evidence: relative(root, path), ...(receipt.error ? { error: receipt.error.message } : {}) }))
assert.equal(receipt.passed, true, receipt.error?.message)
