import { afterEach, expect, it, vi } from 'vitest'
import { createGoalQualifiedPublicFixture } from './helpers/goal-qualified-public-fixture'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('the real compiled CLI reads Run-less requests/rejections and explicitly advances the same public Goal OP using the generated Goal guide', async () => {
  const f = await createGoalQualifiedPublicFixture(cleanup), operationId = 'cli-domain-request'
  const env = objectCliEnvironment(f.sourceRoot)
  const cli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + f.goalServer.path, 'goal', ...args], env)
  const start = ['start', '--goal', f.goal.id, '--agent-ref', JSON.stringify(f.reference), '--operation-id', operationId]
  const failed = await cli([...start, '--access', JSON.stringify({ source: { hostId: 'D-current' } })])
  expect(failed.code).not.toBe(0); expect(JSON.parse(failed.stderr).error.code, failed.stderr).toBe('RUNTIME_OWNER_MISMATCH')
  const check = await cli(['inspect', '--goal', f.goal.id, '--dispatch-operation', operationId])
  expect(check.code, check.stderr).toBe(0)
  const saved = JSON.parse(check.stdout).result.goal.dispatches.find((value: { operationId: string }) => value.operationId === operationId)
  expect(saved).toMatchObject({ stage: 'requested', target: f.reference, prompt: f.goal.description })
  expect(saved).not.toHaveProperty('runId'); expect(f.send).not.toHaveBeenCalled()
  const refused = await cli(['start', '--goal', f.goal.id, '--agent-ref', JSON.stringify(f.reference), '--operation-id', 'cli-version-refused', '--expected-updated-at', '0', '--access', JSON.stringify(f.access)])
  expect(refused.code).not.toBe(0)
  const rejection = await cli(['inspect', '--goal', f.goal.id, '--dispatch-operation', 'cli-version-refused'])
  expect(rejection.code, rejection.stderr).toBe(0)
  expect(JSON.parse(rejection.stdout).result.goal.dispatches.find((value: { operationId: string }) => value.operationId === 'cli-version-refused')).toMatchObject({ stage: 'rejected', rejection: { kind: 'goal-start-version-conflict' } })
  expect(f.send).not.toHaveBeenCalled()
  const resumed = await cli([...start, '--access', JSON.stringify(f.access), '--resume-original'])
  if (resumed.code !== 0) expect(JSON.parse(resumed.stderr).error.code).toBe('CONTROL_UNAVAILABLE')
  await expect.poll(() => f.send.mock.calls.length).toBe(1)
  expect(await f.goals.demands.inspectDispatch(f.goal.id, operationId)).toMatchObject({ operationId, target: saved.target, prompt: saved.prompt, runId: f.session.run.runId })
  const skill = await runCompiledObjectCli(['goal', '--skill'], env)
  expect(skill.code, skill.stderr).toBe(0)
  expect(skill.stdout).toContain('A new qualified Start first saves its immutable business request')
  expect(skill.stdout).toContain('Method discovery or a client parser does not prove')
  expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
