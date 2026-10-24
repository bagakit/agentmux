import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli.js'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import { nativeMain, oneCli, record, until } from './toolkit-main.fixture.js'

it('a public recovery creates one real Core Run and restores official-script metrics while the old execution stays unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-pr-cli-')), previousCli = process.env.AGENTMUX_TOOLKIT_CLI
  let main: Awaited<ReturnType<typeof nativeMain>> | undefined
  try {
    await mkdir(join(directory, 'compiled'))
    const cli = await compileRendererProfileCli(resolve(import.meta.dirname, '../../..'), join(directory, 'compiled'), {}, process.env.AGENTMUX_PERFORMANCE_LOADED)
    process.env.AGENTMUX_TOOLKIT_CLI = cli
    const admission = { executionId: 'original-unconfirmed-creation', run: null, reason: 'Original storage mutation unconfirmed.', startedAt: 100 }
    main = await nativeMain({ beforeRegister: async root => {
      await new ToolkitReceiptStore(join(root, 'toolkit-receipts.json'), () => ['performance']).save('performance', {
        schema: 'agentmux.performance.receipt.v1', admission })
    } })
    const originalInstance = await main.sdk.daemonInstance()
    expect((await oneCli('toolkit', 'inspect', 'performance')).result.snapshot).toMatchObject({ ...admission, state: 'unknown', sequence: 0 })
    expect(await main.sdk.list()).toHaveLength(0)
    const input = { invocationId: 'explicit-new-observation', expectedExecutionId: admission.executionId }, file = join(directory, 'recovery.json')
    await writeFile(file, JSON.stringify(input))
    const result = (await oneCli('toolkit', 'run', 'performance', '--input', file)).result.snapshot
    expect(result).toMatchObject({ executionId: input.invocationId, state: 'observing', previousUnknownExecutionId: admission.executionId })
    const runId = result.run.runId
    let observed: any
    await until(async () => {
      observed = (await oneCli('toolkit', 'inspect', 'performance')).result.snapshot
      expect(observed.executionId).toBe(input.invocationId)
      expect(observed.sequence).toBeGreaterThan(0)
      expect(observed.observation.scope.mainPid).toBe(process.pid)
      expect(observed.observation.process.data.some((entry: any) => entry.runId === runId && entry.rootPid > 0)).toBe(true)
    }, 15000)
    const original = (await oneCli('toolkit', 'inspect', 'performance', '--execution-id', admission.executionId)).result.snapshot
    expect(original).toMatchObject({ ...admission, state: 'unknown', run: null, observation: null })
    await oneCli('toolkit', 'run', 'performance', '--input', file)
    expect(await main.sdk.list()).toHaveLength(1)
    expect((await main.sdk.observeCreation(input.invocationId)).observation).toMatchObject({ outcome: 'retained', run: { id: runId } })
    expect((await main.sdk.observeCreation(admission.executionId)).observation).toMatchObject({ outcome: 'not_retained' })
    expect(await main.sdk.daemonInstance()).toBe(originalInstance)
    await record('performance-recovery-native', { chain: ['compiled public CLI', 'actual registerIpc', 'ToolkitOwner',
      'RuntimeController.toolkitRunPort', 'Core.createTerminal', 'qualified Native Run', 'official performance.mjs',
      'compiled CLI system.metrics.watch', 'ProcessResourceSampler', 'authenticated result channel', 'Toolkit snapshot'],
      input, original, observed, runId, nativeInstance: originalInstance, createdRuns: 1, originalReplayed: false,
      boundary: 'Private original product consumer; no original App/Run/database or installed-delivery qualification.' })
  } finally {
    if (main) await main.close()
    if (previousCli === undefined) delete process.env.AGENTMUX_TOOLKIT_CLI; else process.env.AGENTMUX_TOOLKIT_CLI = previousCli
    await rm(directory, { recursive: true, force: true })
  }
}, 45000)
