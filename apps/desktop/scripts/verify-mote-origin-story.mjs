import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runProbeProcess } from './probe-process.mjs'
import { root, desktopRequire as require } from './fixtures/settings-resource-library/environment.mjs'

const evidence = path.join(root, '.tmp/mote-origin-story', 'run-' + randomUUID())
await fs.mkdir(evidence, { recursive: true })
const runs = []
for (const mode of ['baseline', 'switch', 'consumer', 'restored']) {
  const directory = path.join(evidence, mode), output = []
  await fs.mkdir(directory)
  const green = mode === 'baseline' || mode === 'restored'
  const result = await runProbeProcess(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', path.join(root, 'apps/desktop/scripts/fixtures/mote-origin-story/vitest.config.mts')], {
    cwd: root, env: { ...process.env, AGENTMUX_MOTE_STORY_EVIDENCE: directory, ...(green ? {} : { AGENTMUX_MOTE_STORY_MUTANT: mode }) },
    timeoutMs: 90000, onLine: line => output.push(line),
  })
  await fs.writeFile(path.join(directory, 'test.log'), output.join('\n'))
  assert.equal(result.timedOut, false, 'Timeout is not a behavioral failure')
  if (green) assert.equal(result.exitCode, 0, output.join('\n'))
  else {
    assert.notEqual(result.exitCode, 0)
    assert.match(output.join('\n'), /AssertionError|expected .*to /u, 'Mutation must fail an assertion')
    const loaded = (await fs.readFile(path.join(directory, 'mutation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(loaded.length, 1, 'The changed production source was consumed')
    assert.equal(loaded[0].mutant, mode)
  }
  runs.push({ mode, ...result })
  console.log(JSON.stringify({ mode, passed: green, assertionRed: !green }))
}
await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify({ passed: true, runs }, null, 2))
await fs.writeFile(path.join(root, '.tmp/mote-origin-story/latest.json'), JSON.stringify({ evidence }, null, 2))
console.log('Evidence: ' + evidence)
