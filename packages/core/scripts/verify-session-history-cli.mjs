import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = join(root, '.tmp/recovery-robustness-actions/history-cli')
const helper = join(root, 'packages/core/src/session-history-reader.ts')
const owning = ['packages/core/test/agent-session-history-cli.test.ts', 'packages/core/test/session-context-reference.test.ts']
const files = ['packages/core/src/session-history-reader.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux-cli-commands.ts',
  'packages/core/src/index.ts', ...owning, 'packages/core/test/fixtures/session-history-reader.ts',
  'packages/core/scripts/verify-session-history-cli.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(output, { recursive: true })
async function run(args, name) {
  try {
    const result = await exec('pnpm', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    await writeFile(join(output, name + '.log'), result.stdout + result.stderr)
    return { code: 0 }
  } catch (error) {
    await writeFile(join(output, name + '.log'), (error.stdout ?? '') + (error.stderr ?? ''))
    return { code: typeof error.code === 'number' ? error.code : -1 }
  }
}
async function build(name) {
  const result = await run(['--filter', '@agentmux/core', 'build'], name)
  if (result.code !== 0) throw new Error('Actual Core build failed: ' + name)
}
async function tests(name) {
  const report = join(output, name + '.json')
  const result = await run(['exec', 'vitest', 'run', '--config', './vitest.config.ts', '--root', '.', ...owning,
    '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + report], name)
  const raw = JSON.parse(await readFile(report, 'utf8'))
  const assertions = raw.testResults.flatMap(file => file.assertionResults)
  if (!assertions.length) throw new Error('Owning tests were not collected.')
  return { code: result.code, tests: assertions.length, passed: assertions.filter(test => test.status === 'passed').length,
    assertionRed: assertions.filter(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message))).map(test => test.fullName) }
}
const ast = new Map()
for (const file of files.slice(0, 6)) ast.set(file, ts.createSourceFile(file, await readFile(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true))
function calls(file, name, literal) {
  const found = []
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const target = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : ''
      if (target === name && (literal === undefined || node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === literal))) {
        found.push({ file, line: ast.get(file).getLineAndCharacterOfPosition(node.getStart()).line + 1, call: target })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast.get(file)); return found
}
const callers = {
  ownerRead: calls(files[1], 'readAgentSessionHistory'),
  requestValidation: calls(files[1], 'validateSessionHistoryReadInput'),
  consumerValidation: calls(files[3], 'parseAgentSessionHistoryReadPage'),
  cliRegistration: calls(files[4], 'command', 'agent.history'),
  remoteHostRead: calls(files[1], 'forwardRpc', 'agent.history'),
  capturedSdkRead: calls(files[0], 'sessionTimeline'),
  nativeSdkRead: calls(files[0], 'sessionHistoryPage')
}
if (Object.values(callers).some(group => !group.length)) throw new Error('Production AST caller group is empty.')
await writeFile(join(output, 'production-callers.json'), JSON.stringify({ schema: 'agentmux.finite-production-callers.v1', callers }, null, 2) + '\n')
const original = await readFile(helper, 'utf8')
const mutations = [
  { id: 'remove-exact-host', from: 'entry.hostId === input.hostId && ', to: '' },
  { id: 'drop-captured-work', from: 'items = [...snapshot.items].reverse()', to: 'items = []' },
  { id: 'remove-cursor-source-fence', from: ' || cursor.source !== input.source', to: '' },
  { id: 'remove-source-revision-fence', from: 'cursor.revision !== undefined && cursor.revision !== revision', to: 'false' },
  { id: 'remove-serialized-budget', replacements: [
    ['<= budgetBytes - 1024', '<= 128 * 1024 * 1024'],
    ['if (Buffer.byteLength(JSON.stringify(result)) > budgetBytes - 1024)', 'if (false)']
  ] }
]
// Reuse a witnessed producer mutation only while its exact helper bytes and loaded variants
// remain identical. Consumer deltas still run the current compiled CLI/bridge owning cases.
let previous
try { previous = JSON.parse(await readFile(join(output, 'loaded-producer-qualification.json'), 'utf8')) }
catch { try { previous = JSON.parse(await readFile(join(output, 'qualification.json'), 'utf8')) } catch {} }
function variant(mutation) {
  let changed = original
  for (const [from, to] of mutation.replacements ?? [[mutation.from, mutation.to]]) {
    if (!changed.includes(from) || changed.split(from).length !== 2) throw new Error('Mutation seam is missing or ambiguous: ' + mutation.id)
    changed = changed.replace(from, to)
  }
  return changed
}
if (previous?.passed && previous.helperRestoredExactly &&
  previous.sourcePins['packages/core/src/session-history-reader.ts'] === hash(original) &&
  mutations.every(mutation => previous.mutations.some(receipt => receipt.id === mutation.id &&
    receipt.mutatedSourceSha256 === hash(variant(mutation)) && receipt.code !== 0 && receipt.assertionRed.length && receipt.restored.code === 0))) {
  for (const mutation of mutations) {
    const raw = JSON.parse(await readFile(join(output, mutation.id + '-red.json'), 'utf8'))
    if (!raw.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' &&
      test.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message))))) {
      throw new Error('Existing loaded producer evidence has no actual assertion RED: ' + mutation.id)
    }
  }
  await writeFile(join(output, 'loaded-producer-qualification.json'), JSON.stringify(previous, null, 2) + '\n')
  const current = await tests('current-source-green')
  if (current.code !== 0 || current.passed !== current.tests) throw new Error('Current compiled consumer/bridge Source failed.')
  const sourcePins = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
  await writeFile(join(output, 'qualification.json'), JSON.stringify({ ...previous, sourcePins, restored: current,
    producerEvidenceReused: true, producerEvidenceSourcePins: previous.sourcePins,
    limitations: [...previous.limitations, 'Exact unchanged helper producer consumes witnessed loaded mutants; current consumer/bridge delta is independently exercised by the current compiled owning cases. No new disk mutation or build occurs in this consume step.'] }, null, 2) + '\n')
  console.log('History CLI qualified: unchanged loaded producer ' + mutations.length + ' mutations, current ' + current.tests + ' tests, ' + Object.keys(callers).length + ' nonempty AST caller groups.')
  process.exit(0)
}
const results = []
let baseline, restored
try {
  await build('baseline-build')
  baseline = await tests('baseline-green')
  if (baseline.code !== 0 || baseline.passed !== baseline.tests) throw new Error('Exact Source baseline failed.')
  for (const mutation of mutations) {
    const changed = variant(mutation)
    await writeFile(helper, changed)
    await build(mutation.id + '-build')
    const red = await tests(mutation.id + '-red')
    if (red.code === 0 || !red.assertionRed.length) throw new Error('Loaded mutation did not reach an actual assertion RED: ' + mutation.id)
    results.push({ id: mutation.id, mutatedSourceSha256: hash(changed), ...red })
    await writeFile(helper, original)
    await build(mutation.id + '-restore-build')
    const green = await tests(mutation.id + '-restored-green')
    if (green.code !== 0 || green.passed !== green.tests) throw new Error('Restored Source failed: ' + mutation.id)
    results.at(-1).restored = green
    console.log(mutation.id + ': loaded assertion RED -> exact restored GREEN')
  }
} finally {
  await writeFile(helper, original)
  await build('final-restored-build')
  restored = await tests('final-restored-green')
  const sourcePins = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
  await writeFile(join(output, 'qualification.json'), JSON.stringify({ schema: 'agentmux.history-cli-qualification.v1',
    passed: results.length === mutations.length && restored.code === 0 && restored.passed === restored.tests,
    sourcePins, helperRestoredExactly: hash(await readFile(helper)) === hash(original), baseline, mutations: results, restored,
    callerGroups: Object.keys(callers).length,
    limitations: ['Compiled public CLI and real FileStore/Claude JSONL; no Native connection, Agent/model, user data or GUI operations.',
      'Captured and native history are explicit sources. Fragment reconstruction is asserted including Unicode, provenance and older continuation.',
      'Cursor is scoped to an unchanged source and current semantic Host process; restart requires a first-page read.'] }, null, 2) + '\n')
}
if (restored.code !== 0 || restored.passed !== restored.tests || results.length !== mutations.length) throw new Error('History CLI qualification incomplete.')
console.log('History CLI qualified: ' + restored.tests + ' real tests, ' + results.length + ' loaded mutations, ' + Object.keys(callers).length + ' nonempty AST caller groups.')
