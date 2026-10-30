import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditTrackerTestTargets } from '../scripts/audit-tracker-test-targets.mjs'
import { reviewGitFixture } from './helpers/review-git-fixture.js'
import { closeReviewFixtures, isolatedGitEnvironment } from './helpers/review-guard-isolation.mjs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(() => closeReviewFixtures(cleanup))
async function fixture(tasks: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-tracker-targets-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const features = join(root, 'audit-input/features')
  await mkdir(join(features, 'fixture-feature'), { recursive: true })
  await writeFile(join(features, 'fixture-feature/tasks.json'), JSON.stringify({ tasks }))
  expect(existsSync(join(root, '.bagakit'))).toBe(false)
  return { root, features, async file(path: string) {
    const target = join(root, path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, 'fixture test source\n')
  } }
}
const command = (ref: string, status = 'done') => ({ id: 'T-001', status, verification: [{ kind: 'command', ref }] })

describe('Tracker test-target audit over explicit local input', () => {
  it('isolates every inherited Git setting while retaining ordinary process environment', () => {
    const env = isolatedGitEnvironment({ PATH: '/fixture/bin', GIT_DIR: '/foreign/repository', GIT_OBJECT_DIRECTORY: '/foreign/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/foreign/alternate', GIT_TEMPLATE_DIR: '/foreign/template', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/foreign/hooks' })
    expect(env).toEqual({ PATH: '/fixture/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  })

  it('tries every fixture cleanup before reporting failures', async () => {
    const calls: number[] = [], first = new Error('first failure'), last = new Error('last failure')
    const owned = [async () => { calls.push(1); throw first }, async () => { calls.push(2) }, async () => { calls.push(3); throw last }]
    await expect(closeReviewFixtures(owned)).rejects.toMatchObject({ name: 'AggregateError', errors: [last, first] })
    expect(calls).toEqual([3, 2, 1])
    expect(owned).toEqual([])
  })

  it('detects the missing member of a mixed gate, with nonempty commands and targets', async () => {
    const f = await fixture([command('pnpm exec vitest run test/present.test.ts test/missing.test.ts')])
    await f.file('test/present.test.ts')
    const result = auditTrackerTestTargets(f)
    expect(result.state).toBe('audited')
    expect(result.commands).toBe(1)
    expect(result.named.map(entry => entry.path)).toEqual(['test/present.test.ts', 'test/missing.test.ts'])
    expect(result.missing.map(entry => entry.path)).toEqual(['test/missing.test.ts'])
  })

  it('resolves cd and package filters and accepts a .ts filter for .tsx', async () => {
    const f = await fixture([
      command('pnpm --filter @agentmux/core exec vitest run test/core.test.ts'),
      command('cd apps/desktop && pnpm --filter @agentmux/core exec vitest run test/view.test.ts'),
      command('pnpm exec vitest run test/root.test.ts # comment/absent.test.ts')
    ])
    await f.file('packages/core/test/core.test.ts')
    await f.file('apps/desktop/test/view.test.tsx')
    await f.file('test/root.test.ts')
    const result = auditTrackerTestTargets(f)
    expect(result.commands).toBe(3)
    expect(result.named.map(entry => entry.path)).toEqual(['packages/core/test/core.test.ts', 'apps/desktop/test/view.test.ts', 'test/root.test.ts'])
    expect(result.missing).toEqual([])
    await writeFile(join(f.features, 'fixture-feature/tasks.json'), JSON.stringify({ tasks: [command(`cd ${f.root}/apps/desktop && vitest run test/view.test.ts`)] }))
    expect(auditTrackerTestTargets(f).named.map(entry => entry.path)).toEqual(['apps/desktop/test/view.test.ts'])
  })

  it('excludes guarded/future/cancelled tasks without suppressing active failures', async () => {
    const f = await fixture([
      ...['todo', 'cancelled', 'transferred'].map(status => command('vitest run test/future.test.ts', status)),
      command('test -f test/future.test.ts && vitest run test/future.test.ts'),
      command('test -e test/future.test.ts && vitest run test/future.test.ts'),
      { verification: [{ kind: 'artifact', ref: 'test/future.test.ts' }] },
      command('vitest run test/active.test.ts', 'in_progress')
    ])
    const result = auditTrackerTestTargets(f)
    expect(result.commands).toBe(1)
    expect(result.named.map(entry => entry.path)).toEqual(['test/active.test.ts'])
    expect(result.missing.map(entry => entry.path)).toEqual(['test/active.test.ts'])
  })

  it('does not call an empty command or target scan audited', async () => {
    const empty = await fixture([])
    expect(auditTrackerTestTargets(empty)).toEqual({ state: 'unconfirmed', commands: 0, named: [], missing: [] })
    const unnamed = await fixture([command('vitest run')])
    expect(auditTrackerTestTargets(unnamed)).toEqual({ state: 'unconfirmed', commands: 1, named: [], missing: [] })
  })

  it('runs the explicit audit CLI and distinguishes pass, missing targets and unavailable evidence', async () => {
    const f = await fixture([command('vitest run test/present.test.ts')])
    const processFixture = await reviewGitFixture(); cleanup.push(processFixture.close)
    const script = resolve(import.meta.dirname, '../scripts/audit-tracker-test-targets.mjs')
    const args = ['--root', f.root, '--features', f.features]
    const missing = await processFixture.cli(script, args)
    expect(missing.code).toBe(1)
    expect(JSON.parse(missing.stdout).missing).toHaveLength(1)
    await f.file('test/present.test.ts')
    const passed = await processFixture.cli(script, args)
    expect(passed.code).toBe(0)
    expect(JSON.parse(passed.stdout)).toMatchObject({ state: 'audited', commands: 1, missing: [] })
    expect(JSON.parse(passed.stdout).named).toHaveLength(1)
    const absent = await processFixture.cli(script, ['--root', f.root])
    expect(absent.code).toBe(2)
    expect(JSON.parse(absent.stderr).state).toBe('unconfirmed')
    await writeFile(join(f.features, 'fixture-feature/tasks.json'), JSON.stringify({ tasks: [] }))
    const empty = await processFixture.cli(script, args)
    expect(empty.code).toBe(2)
    expect(JSON.parse(empty.stdout).state).toBe('unconfirmed')
    await writeFile(join(f.features, 'fixture-feature/tasks.json'), '{invalid')
    const malformed = await processFixture.cli(script, args)
    expect(malformed.code).toBe(2)
    expect(JSON.parse(malformed.stderr).state).toBe('unconfirmed')
  }, 30_000)
})
