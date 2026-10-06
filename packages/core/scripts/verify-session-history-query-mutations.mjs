import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

// Invoke from the repository root in an isolated, clean source worktree.
// Each candidate changes production Source, runs the actual owner/Hosted suite
// in a fresh Vite process, pins the actual loaded mutated module, and restores it.
const output = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node packages/core/scripts/verify-session-history-query-mutations.mjs OUTPUT_DIRECTORY')
await mkdir(output, { recursive: true })
const query = 'packages/core/src/session-history-query.ts', codec = 'packages/core/src/session-history-read-codec.ts'
const mutations = [
  { id: 'query-scope', file: query, from: "input.source, input.query ?? ''", to: "input.source, ''", failure: 'binds continuations' },
  { id: 'native-binding', file: query, from: "source === 'native' ? [history?.providerId, history?.executorId, history?.workspacePath,\n    handle?.kind, handle?.sessionId, handle?.kind === 'provider' ? handle.transcriptPath : undefined] : null", to: 'null', failure: 'binds continuations' },
  { id: 'native-origin', file: 'packages/core/src/session-user-messages.ts', from: "const author: AgentSessionUserMessageAuthor = { kind: 'unknown' }", to: "const author: AgentSessionUserMessageAuthor = { kind: 'human' }", failure: 'keeps native origin unknown' },
  { id: 'equal-body-dedup', file: query, from: 'result.userMessages!.push(message)', to: 'if (!result.userMessages!.some(old => old.content === message.content)) result.userMessages!.push(message)', failure: 'delegates the typed query' },
  { id: 'zero-match-continuation', file: query, from: 'if (!result.scan!.complete) result.nextCursor = cursor()', to: 'if (!result.scan!.complete && result.userMessages!.length) result.nextCursor = cursor()', failure: 'presentation ceiling' },
  { id: 'captured-reload', file: query, from: "view.captured ?? [...page!.items].reverse()", to: "view.captured ? [...(await owner.sessionTimeline(input.agentSessionId)).items].reverse() : [...page!.items].reverse()", failure: 'append-safe' },
  { id: 'resource-omitted', file: query, from: "if (part.kind !== 'text' && !(part.kind === 'resource' && part.resourceType === 'text' && part.content?.kind === 'text')) continue", to: "if (part.kind !== 'text') continue", failure: 'past preview boundaries' },
  { id: 'reading-range-ignored', file: query, from: 'if (original.span && (original.span.start !== 0 || original.span.end !== original.length))', to: 'if (false)', failure: 'semantic text domain' },
  { id: 'question-answers-ignored', file: query, from: String.raw`const answerText = message.questionAnswers?.length ? message.questionAnswers.map(answer => answer.answer).join('\n\n') : undefined`, to: 'const answerText: string | undefined = undefined', failure: 'semantic text domain' },
  { id: 'hosted-runtime-gate', file: 'packages/core/src/hosted-runtime-service.ts', from: "'sessionTimeline', 'readAgentSessionHistory', 'sessionHistorySources'", to: "'sessionTimeline', 'sessionHistorySources'", failure: 'delegates the typed query' },
  { id: 'hosted-read-cancellation', file: 'packages/core/src/hosted-client.ts', from: "method === 'sessionHistoryPage' || method === 'sessionHistoryResource' || method === 'readAgentSessionHistory'", to: "method === 'sessionHistoryPage' || method === 'sessionHistoryResource'", failure: 'cancels an in-flight exact resource' },
  { id: 'foreign-message-result', file: codec, from: "message.agentSessionId !== input.agentSessionId || typeof message.content", to: "typeof message.content", failure: 'rejects forged typed results' },
  { id: 'record-scan-unbounded', file: query, from: 'result.scan!.examined >= scanLimit || ', to: '', all: true, failure: 'presentation ceiling' }
]
const originals = new Map()
for (const item of mutations) if (!originals.has(item.file)) originals.set(item.file, await readFile(item.file, 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
async function run(name) {
  const report = join(output, name + '.json'), loads = join(output, name + '.loads.ndjson'), log = join(output, name + '.log')
  const args = ['exec', 'vitest', 'run', '--config', 'packages/core/test/fixtures/session-history-query/vitest.source.config.mts', '--reporter=json', '--outputFile=' + report]
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn('pnpm', args, { env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_HISTORY_SOURCE_LOADS: loads }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''; child.stdout.on('data', value => { text += value }); child.stderr.on('data', value => { text += value })
    child.on('error', reject); child.on('close', code => resolveRun({ code, text }))
  })
  await writeFile(log, result.text)
  const data = JSON.parse(await readFile(report, 'utf8'))
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  return { code: result.code, total: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests,
    pending: data.numPendingTests, runtimeErrors: data.numRuntimeErrorTestSuites ?? 0,
    failures: assertions.filter(test => test.status === 'failed').map(test => ({ name: test.fullName, messages: test.failureMessages })),
    loads: (await readFile(loads, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
function green(result) { return result.code === 0 && result.total === 14 && result.passed === 14 && !result.failed && !result.pending && !result.runtimeErrors }
const receipt = { schema: 'agentmux.history-query-source-mutants.v1', source: Object.fromEntries([...originals].map(([file, value]) => [file, sha(value)])), baseline: null, mutants: [], restored: null }
let problem
try {
  receipt.baseline = await run('baseline')
  if (!green(receipt.baseline)) throw new Error('Source baseline is not a nonempty, all-green 14-test suite')
  for (const item of mutations) {
    const original = originals.get(item.file)
    const occurrences = original.split(item.from).length - 1
    if (occurrences !== (item.all ? 2 : 1)) throw new Error(item.id + ': mutation anchor changed: ' + occurrences)
    const candidate = item.all ? original.replaceAll(item.from, item.to) : original.replace(item.from, item.to)
    try {
      await writeFile(item.file, candidate)
      const result = await run(item.id)
      const bound = result.loads.some(load => load.path === resolve(item.file) && load.sha256 === sha(candidate))
      const red = result.failures.find(test => test.name.includes(item.failure) && test.messages.some(message => /AssertionError/u.test(message)))
      const accepted = result.code !== 0 && result.total === 14 && bound && Boolean(red) && result.runtimeErrors === 0
      receipt.mutants.push({ id: item.id, file: item.file, sourceSha256: sha(candidate), actualSourceLoaded: bound, businessAssertionRed: red?.name ?? null, accepted, result })
      await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
      process.stdout.write(item.id + ': ' + (accepted ? 'strict Source assertion RED' : 'INVALID/SURVIVED') + '\n')
    } finally { await writeFile(item.file, original) }
  }
} catch (error) { problem = error }
finally {
  for (const [file, original] of originals) await writeFile(file, original)
  receipt.restored = await run('restored')
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
if (problem) throw problem
if (receipt.mutants.length !== mutations.length || receipt.mutants.some(item => !item.accepted) || !green(receipt.restored)) throw new Error('Mutation proof incomplete: inspect receipt and raw reports')
process.stdout.write('All ' + mutations.length + ' source mutants caused bound business assertion RED; restored suite 14/14 GREEN.\n')
