import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const proof = await mkdtemp(join(tmpdir(), 'amux-reading-outline-'))
const test = 'the mounted workspace tracks explicit reading and manual scroll'
const detail = 'apps/desktop/src/renderer/src/components/GoalDetail.tsx'
const workspace = 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'

async function run(mutation) {
  const phase = mutation || 'original'
  const loaded = join(proof, phase + '.jsonl')
  const results = join(proof, phase + '.json')
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/test/vitest.goal-detail-reading.config.mts', '--reporter=json', '--outputFile', results]
  if (mutation) args.push('-t', test)
  const run = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GOAL_DETAIL_READING_LOADED: loaded, GOAL_DETAIL_READING_MUTATION: mutation }
  })
  if (run.error) throw run.error
  const report = JSON.parse(await readFile(results, 'utf8'))
  const assertions = report.testResults.flatMap(suite => suite.assertionResults)
  const failures = assertions.flatMap(result => result.failureMessages)
  assert.equal(run.status, mutation ? 1 : 0, [run.stderr, run.stdout, ...failures].join('\n'))
  const originalTest = assertions.find(result => result.title.startsWith(test))
  assert.ok(originalTest, 'the real GlobalBoardSurface interaction ran')

  const sources = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const file of [workspace, detail]) {
    const source = sources.find(row => row.file === file)
    assert.ok(source, file + ' loaded')
    const expected = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
    assert.equal(source.originalSHA256, expected, file + ' matches the production source')
    if (file === detail && mutation) {
      assert.equal(source.mutation, mutation)
      assert.notEqual(source.loadedSHA256, expected)
    } else {
      assert.equal(source.loadedSHA256, expected)
    }
  }

  if (mutation) {
    assert.equal(report.numFailedTests, 1)
    assert.equal(originalTest.status, 'failed')
    assert.match(originalTest.failureMessages.join('\n'), mutation === 'orphaned-discussion'
      ? /Goal discussion belongs beside the overview heading/
      : /choosing Goal brief focuses the original brief/)
    console.log(phase + ': the mounted Goal workspace rejected the mutation.')
  } else {
    assert.equal(originalTest.status, 'passed')
    assert.equal(report.numPassedTests, assertions.length)
    console.log(phase + ': ' + report.numPassedTests + ' mounted workspace tests passed.')
  }
}

try {
  await run('')
  await run('wrong-destination')
  await run('orphaned-discussion')
} finally {
  await rm(proof, { recursive: true, force: true })
}
