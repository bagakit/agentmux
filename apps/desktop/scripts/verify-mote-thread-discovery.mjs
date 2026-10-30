import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../../..')
const directory = join(root, '.bagakit/mote-discussion-threads/thread-discovery', randomUUID())
await mkdir(directory, { recursive: true })
const files = ['packages/client-ui/src/components/MoteConversationThreads.tsx', 'packages/client-ui/src/styles/mote-conversation.css',
  'apps/mobile/src/conversation/MobileMoteConversation.tsx', 'apps/mobile/src/navigation/MobileMoteThreads.tsx', 'apps/mobile/src/navigation/mote-threads.css',
  'apps/desktop/src/renderer/src/components/MoteActivityConversation.tsx', 'apps/desktop/src/renderer/src/components/MoteThreadsPanel.tsx',
  'apps/desktop/test/mote-thread-discovery.test.tsx', 'apps/desktop/test/mote-thread-discovery.config.mts', 'apps/desktop/scripts/verify-mote-thread-discovery.mjs']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
const before = await hashes(), runs = []
const variants = ['search-disconnected', 'report-filter-disconnected', 'inline-wrong-host', 'inline-disconnected', 'dispatch-count-is-worker-count', 'search-ignores-foreground']
async function run(name, mutation) {
  const report = join(directory, name + '.json'), trace = join(directory, name + '.loaded.jsonl')
  let output = ''
  const status = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/mote-thread-discovery.config.mts', '--reporter=json', '--outputFile=' + report], {
      cwd: root, env: { ...process.env, ...(mutation ? { AGENTMUX_THREAD_DISCOVERY_MUTATION: mutation, AGENTMUX_THREAD_DISCOVERY_TRACE: trace } : {}) }, stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    child.on('error', reject); child.on('exit', done)
  })
  await writeFile(join(directory, name + '.log'), output)
  const value = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(value.numTotalTests, 7, 'All seven current consumer cases must be collected')
  assert.equal(value.numPendingTests, 0)
  const loaded = mutation ? (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : []
  if (mutation) {
    assert.ok(loaded.length > 0 && loaded.every(item => item.original !== item.changed), 'The exact production source mutation must be loaded')
    const failed = value.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
    assert.ok(status !== 0 && failed.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'A bearing consumer assertion must turn RED')
  } else assert.ok(status === 0 && value.numPassedTests === 7, 'All baseline/restored consumer cases must pass')
  runs.push({ name, status, total: value.numTotalTests, passed: value.numPassedTests, failed: value.numFailedTests, loaded })
  process.stdout.write(name + ': ' + value.numPassedTests + '/' + value.numTotalTests + (mutation ? ' (bearing RED)' : ' GREEN') + '\n')
}
await run('baseline')
for (const variant of variants) await run(variant, variant)
await run('restored')
assert.deepEqual(await hashes(), before, 'Loaded mutations never edit or silently restore production files')
const receipt = { schema: 'agentmux.mote-thread-discovery.v1', source: before, runs, passed: true,
  consumers: ['real Desktop App Threads', 'actual Desktop Mote dialogue consumer', 'actual Mobile Threads and Discussion adapters'],
  boundary: 'Controlled domain read ports; real production consumers. No live user input, Agent creation, Runtime recovery or physical-device signoff.' }
await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(join(directory, 'receipt.json') + '\n')
