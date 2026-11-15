import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const title = 'copied Goal plan links and the real CLI reveal the original graph without creating work or stealing the retained draft'
const runs = [
  { id: 'baseline' },
  {
    id: 'trust-namesake',
    path: 'apps/desktop/src/renderer/src/store.ts',
    anchor: 'hasOriginalGoalBinding(goalTarget.goalId, address)',
    replacement: 'true',
    failure: 'a namesake without the original binding cannot receive a short Ticket link',
  },
  {
    id: 'skip-selected-node',
    path: 'apps/desktop/src/renderer/src/components/GoalDetail.tsx',
    anchor: 'if (readingEntry.ticketNodeId) setPlanReveal({ target: { nodeId: readingEntry.ticketNodeId } })',
    replacement: 'void readingEntry.ticketNodeId',
    failure: 'the original Ticket must be visibly selected and revealed',
  },
  { id: 'restored' },
]
const proof = await mkdtemp(join(tmpdir(), 'amux-goal-ticket-links-'))
try {
  for (const { id, path, anchor, replacement, failure } of runs) {
    const loaded = join(proof, id + '.loaded')
    const result = await new Promise((resolve, reject) => {
      const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--configLoader', 'runner', '--no-cache', '--reporter=json',
        '--config', 'apps/desktop/test/vitest.goal-links.config.mts', 'apps/desktop/test/desktop-focus-navigation.test.tsx', '-t', title], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GOAL_LINK_LOADED: loaded,
          GOAL_LINK_MUTATION: path ? JSON.stringify({ id, path, edits: [{ anchor, replacement }] }) : '' },
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
    assert.equal(result.signal, null, result.stderr)
    let report
    try { report = JSON.parse(result.stdout) }
    catch (cause) { throw new Error('No Ticket test receipt for ' + id + '\n' + result.stderr + result.stdout, { cause }) }
    const scenario = report.testResults.flatMap(suite => suite.assertionResults).find(result => result.title === title)
    assert.ok(scenario, report.testResults.map(suite => suite.message).join('\n'))
    const messages = scenario.failureMessages.join('\n')
    if (failure) {
      const sources = (await readFile(loaded, 'utf8')).trim().split('\n').map(row => JSON.parse(row))
      assert.ok(sources.some(source => source.path === path && source.mutant === id && source.loadedSHA256 !== source.originalSHA256))
      assert.equal(result.code, 1, result.stderr + messages)
      assert.equal(scenario.status, 'failed', messages)
      assert.ok(messages.includes(failure), messages)
    } else {
      assert.equal(result.code, 0, result.stderr + messages)
      assert.equal(scenario.status, 'passed', messages)
    }
    console.log(JSON.stringify({ id, result: failure ? 'mutation killed' : 'passed' }))
  }
} finally {
  await rm(proof, { recursive: true, force: true })
}
