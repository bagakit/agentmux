import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.local/state/survey-item-tabs-actions/restart')
const temporary = await mkdtemp(join(tmpdir(), 'amux-survey-items-restart-'))
const receipt = { schema: 'agentmux.survey-items-restart.v1', passed: false, phases: [],
  boundary: 'Two actual test processes consume one persisted Core spatial file and Desktop saved workbench. Original App, Store and components; transport snapshots and paint leaves are fixtures. No live CLI Level B recovery, Native Browser process continuity or user data.' }
await mkdir(evidence, { recursive: true })
const sources = ['GlobalSurveySurface.tsx', 'SurveyZoneItem.tsx', 'SurveyItemOptions.tsx', 'SurveyTabColumn.tsx'].map(file => 'apps/desktop/src/renderer/src/components/' + file)
  .concat(['apps/desktop/src/renderer/src/store.ts', 'packages/core/src/spatial-state.ts', 'apps/desktop/test/survey-surface.test.tsx', 'apps/desktop/scripts/verify-survey-item-tabs-actions-restart.mjs'])
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
receipt.inputs = await hashes()
try {
  for (const phase of ['write', 'read']) {
    const child = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
      'apps/desktop/test/survey-surface.test.tsx', '-t', '\\[survey-item-restart\\]'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SURVEY_ITEM_RESTART_PHASE: phase, SURVEY_ITEM_RESTART_DIR: temporary, SURVEY_ITEM_RESTART_FILE: join(temporary, 'saved.json') }
    })
    await writeFile(join(evidence, phase + '.log'), child.stdout + child.stderr)
    receipt.phases.push({ phase, exit: child.status, log: phase + '.log' })
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.match(child.stdout, /1 passed/)
  }
  const saved = JSON.parse(await readFile(join(temporary, 'saved.json'), 'utf8'))
  receipt.original = { zoneId: saved.zoneId, closedZoneId: saved.closedZoneId, newReference: saved.newReference, run: saved.session.control.run, writerPid: saved.pid }
  receipt.sourceAfter = await hashes()
  assert.deepEqual(receipt.sourceAfter, receipt.inputs)
  receipt.passed = true
} finally {
  await rm(temporary, { recursive: true, force: true })
  receipt.cleanup = { testOwnedDirectoryRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, evidence }))
