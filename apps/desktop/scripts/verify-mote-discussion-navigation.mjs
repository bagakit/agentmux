import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const directory = join(root, '.bagakit/mote-discussion-threads/navigation', randomUUID())
await mkdir(directory, { recursive: true })
const files = [
  'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/store.ts',
  ...['AgentSessionComposer', 'MoteActivityConversation', 'MoteCooperation', 'MoteDetailsPanel', 'MoteSpaceFrame', 'MoteThreadsPanel', 'MoteWorkface', 'PmoTeamsTopicFloatingPanel', 'SessionActivityPresentation', 'StableWorkbenchView', 'WorkspaceWorkbench'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`),
  ...['mote-workface', 'pmo-teams-topic-floating', 'workbench-presentation'].map(name => `apps/desktop/src/renderer/src/lib/${name}.ts`),
  'apps/desktop/src/renderer/src/styles/mote-workface.css',
  'packages/client-ui/src/components/MoteConversationThreads.tsx',
  'packages/client-ui/src/styles/mote-conversation.css',
  'apps/desktop/test/mote-discussion-threads.config.mts', 'apps/desktop/test/mote-discussion-threads.test.tsx', 'apps/desktop/test/mote-threads-source.test.tsx',
  'apps/desktop/scripts/verify-mote-discussion-navigation.mjs',
]
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])) )
const source = await hashes(), runs = []
const priorPath = process.env.AGENTMUX_MOTE_NAV_REUSE
const prior = priorPath ? JSON.parse(await readFile(resolve(root, priorPath), 'utf8')) : null
const variants = ['member-input-becomes-main', 'known-main-generic-fallback', 'member-conversation-hidden', 'same-location-keeps-member-intent', 'publisher-drops-input-intent', 'drop-main-dom-retention', 'drop-main-pagination', 'chrome-needs-live-agent', 'threads-wrong-source-pair']
async function run(name, mutation) {
  const report = join(directory, name + '.json'), trace = join(directory, name + '.loaded.jsonl')
  let output = ''
  const status = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/mote-discussion-threads.config.mts', '--reporter=json', '--outputFile=' + report], {
      cwd: root, env: { ...process.env, ...(mutation ? { AGENTMUX_MOTE_NAV_MUTATION: mutation, AGENTMUX_MOTE_NAV_TRACE: trace } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    child.on('error', reject); child.on('exit', done)
  })
  await writeFile(join(directory, name + '.log'), output)
  const value = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(value.numTotalTests, 11, 'All eleven current consumer cases must be collected')
  assert.equal(value.numPendingTests, 0)
  const loaded = mutation ? (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : []
  const failed = value.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  if (mutation) {
    assert.ok(loaded.length > 0 && loaded.every(item => item.name === mutation && item.original !== item.changed && source[item.file] === item.original), 'The exact current production source mutant must be loaded')
    assert.ok(status !== 0 && failed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'A bearing consumer assertion must turn RED')
  } else assert.ok(status === 0 && value.numPassedTests === 11, 'All baseline/restored consumer cases must pass')
  runs.push({ name, status, total: value.numTotalTests, passed: value.numPassedTests, failed: value.numFailedTests, failedCases: failed.map(test => test.fullName), loaded })
  process.stdout.write(name + ': ' + value.numPassedTests + '/' + value.numTotalTests + (mutation ? ' bearing RED' : ' GREEN') + '\n')
}
await run('baseline')
for (const mutation of variants) {
  const old = prior?.runs.find(item => item.name === mutation)
  const unchangedTests = files.filter(file => file.startsWith('apps/desktop/test/')).every(file => source[file] === prior?.source[file])
  if (old && unchangedTests && old.loaded.length && old.loaded.every(item => source[item.file] === item.original)) {
    const report = JSON.parse(await readFile(join(resolve(root, priorPath), '..', mutation + '.json'), 'utf8'))
    assert.ok(report.numTotalTests === 11 && report.numFailedTests > 0)
    runs.push({ ...old, reusedFrom: resolve(root, priorPath) })
    process.stdout.write(mutation + ': exact unchanged loaded target and consumer evidence reused\n')
  } else await run(mutation, mutation)
}
await run('restored')
assert.deepEqual(await hashes(), source, 'Loaded mutants do not edit product sources; receipt cannot sign concurrent drift')
const receipt = { schema: 'agentmux.mote-discussion-navigation.v1', passed: true, source, runs,
  ...(priorPath ? { proofDelta: { prior: resolve(root, priorPath), reason: 'Only Workface unknown-notice presentation changed; current full baseline/restored and changed-target mutants rerun, unchanged loaded target and consumer bytes retained.' } } : {}),
  boundary: 'Real Desktop App, original store/Workbench/Composer and shared source consumers; finite typed API/Activity native-source ports. No live user Run mutation, native semantic recovery or installation claim.',
  publicCapability: 'Presentation consumes existing exact Mote dialogue/recovery/setup/dispatch/preferences owners. No new navigation RPC or client lifecycle owner.',
  refusal: { operation: 'one newly authored logical Main input', authority: 'ready Core Main role exact Host/Session differs or is explicitly unbound', preserved: ['original Main DOM and editable draft', 'original pending/unknown input operation', 'explicit Threads member input', 'healthy Run capabilities'] } }
await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await writeFile(join(directory, '..', 'latest.json'), JSON.stringify({ receipt: join(directory, 'receipt.json') }, null, 2) + '\n')
process.stdout.write(join(directory, 'receipt.json') + '\n')
