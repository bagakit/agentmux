import { afterEach, expect, it } from 'vitest'
import { executorEnvironmentFixture } from './helpers/executor-environment-fixture.js'
import { until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Environment refresh cleanup failed: ' + errors.map(String).join('; '))
})
it('cold inventory waits for original shell exports while metadata and the actual CLI stay readable', async () => {
  const f = await executorEnvironmentFixture(cleanups, true)
  const metadata = await f.cli(false)
  expect(metadata.executors).toMatchObject([{ executorId: 'codex', command: f.command, availability: 'unknown' }])
  let settled = false
  const observing = f.client.listHostExecutors({ refresh: true, executorId: 'codex' }).then(value => { settled = true; return value })
  await until(f.arms, value => value.length === 2, 'both original preparation arms')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(settled, 'Executable inventory must await original environment preparation').toBe(false)
  await f.release()
  expect((await observing).executors).toMatchObject([{ executorId: 'codex', command: f.command, source: 'configured', availability: 'available' }])
  expect((await f.cli(true)).executors).toMatchObject([{ executorId: 'codex', command: f.command, availability: 'available' }])
  expect(f.client.runtimeOwnerIdentity()!.ownerInstanceId).toBe(f.originalOwner.ownerInstanceId)
})
it('explicit probes and CLI rediscover installation in the same Host without delaying prepared launches or healthy input', async () => {
  const f = await executorEnvironmentFixture(cleanups)
  expect(await f.client.probeExecutorAvailability('codex', f.command)).toMatchObject({ availability: 'missing' })
  const initialArms = (await f.arms()).length
  const run = await f.client.createTerminal({ workspacePath: f.root, command: f.baseCommand, args: [] })
  cleanups.push(async () => { await f.client.stopTerminal({ runId: run.runId }); await f.client.removeTerminal({ runId: run.runId }) })
  expect((await f.arms()).length).toBe(initialArms)
  await until(() => f.client.readRunReplay(run), value => value.replay.map(chunk => chunk.data).join('').includes('READY:initial'), 'original healthy output')
  await f.install(); await f.hold()
  const requests = Promise.all([f.client.probeExecutorAvailability('codex', f.command),
    f.client.probeAgent('codex', f.command), f.client.listHostExecutors({ refresh: true, executorId: 'codex' })])
  await until(f.arms, value => value.length === initialArms + 2, 'one shared refresh')
  const attached = await f.client.attachTerminal(run.runId, 0, 'raw')
  await f.client.writeTerminal(run, { ownerInstanceId: f.client.runtimeIdentity().instanceId, operationId: 'original-live-input',
    expectedByte: attached.run.acceptedInputBytes!, data: 'still-healthy\n' })
  await until(() => f.client.readRunReplay(run), value => value.replay.map(chunk => chunk.data).join('').includes('INPUT:still-healthy'), 'input during independent refresh')
  const extra = await f.client.createTerminal({ workspacePath: f.root, command: f.baseCommand, args: [] })
  cleanups.push(async () => { await f.client.stopTerminal({ runId: extra.runId }); await f.client.removeTerminal({ runId: extra.runId }) })
  await f.release()
  const [probe, capability, inventory] = await requests
  expect(probe).toMatchObject({ executable: f.command, availability: 'available' })
  expect(capability.installed).toBe(true)
  expect(inventory.executors).toMatchObject([{ executorId: 'codex', command: f.command, availability: 'available' }])
  expect((await f.arms()).length).toBe(initialArms + 2)
  expect((await f.cli(true)).executors).toMatchObject([{ executorId: 'codex', command: f.command, availability: 'available' }])
  expect((await f.client.readRunReplay(run)).run).toMatchObject({ runId: run.runId, pid: run.pid, state: 'running' })
  expect(f.client.runtimeOwnerIdentity()!.ownerInstanceId).toBe(f.originalOwner.ownerInstanceId)
})
