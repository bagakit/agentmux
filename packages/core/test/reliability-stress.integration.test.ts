import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')(
  'AgentMux packaged-runtime reliability and resource composition',
  () => {
    it('bounds 16 Runs, slow replay, churn, daemon crash, and cleanup through public Core APIs', async () => {
      const root = await mkdtemp('/private/tmp/agentmux-reliability-')
      roots.push(root)
      const runtimeDirectory = join(root, 'runtime')
      const workspace = join(root, 'workspace')
      await Promise.all([
        mkdir(runtimeDirectory, { recursive: true, mode: 0o700 }),
        mkdir(workspace, { recursive: true })
      ])
      const [sourceCommit, trackedDiff] = await Promise.all([
        execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
        execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot })
      ])
      const result = await execFileAsync(process.execPath, [
        fileURLToPath(new URL('./fixtures/reliability-stress-worker.mjs', import.meta.url))
      ], {
        cwd: repositoryRoot,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
          AGENTMUX_CORE_ENTRY: resolve(repositoryRoot, 'packages/core/dist/index.js'),
          AGENTMUX_DAEMON_PATH: resolve(
            repositoryRoot,
            'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'
          ),
          AGENTMUX_RUN_KERNEL_WORKLOAD: fileURLToPath(
            new URL('./fixtures/run-kernel-workload.mjs', import.meta.url)
          ),
          AGENTMUX_RELIABILITY_WORKSPACE: workspace,
          AGENTMUX_SOURCE_COMMIT: sourceCommit.stdout.trim(),
          AGENTMUX_TRACKED_DIFF_CLEAN: trackedDiff.stdout.split('\n').every(
            (line) => !line || line.startsWith('?? .tmp/')
          ) ? '1' : '0'
        }
      })
      const [finalCommit, finalStatus] = await Promise.all([
        execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
        execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot })
      ])
      expect(finalCommit.stdout).toBe(sourceCommit.stdout)
      expect(finalStatus.stdout).toBe(trackedDiff.stdout)
      const report = JSON.parse(result.stdout.trim())
      process.stdout.write(`T017_CORE_RESOURCE_RECEIPT=${JSON.stringify(report)}\n`)

      expect(report).toMatchObject({
        schema: 'agentmux.t017-reliability.v1',
        platform: 'darwin-arm64',
        identity: {
          agentmux: {
            sourceCommit: sourceCommit.stdout.trim(),
            trackedDiffClean: trackedDiff.stdout.split('\n').every(
              (line) => !line || line.startsWith('?? .tmp/')
            )
          },
          ctxmux: {
            sourceCommit: '073e206407ce28331aa882c2c80e9354cfe2879a',
            artifactPlatform: 'darwin-arm64',
            protocolVersion: 13
          }
        },
        correctness: {
          uniqueRuns: 16,
          attachDetachCycles: 32,
          slowConsumerGap: {
            requestedAfterByte: 0,
            firstAvailableByte: expect.any(Number)
          },
          crashDisposition: 'interrupted',
          crashChildGone: true,
          recoveredReplay: true
        }
      })
      expect(['applied', 'rejected-after-stop']).toContain(report.correctness.stopInputRace.status)
      expect(report.correctness.retainedReplayBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
      expect(report.samples.afterCleanup.daemon.fds).toBeLessThanOrEqual(
        report.samples.baseline.daemon.fds +
          report.budgets.runCount * report.budgets.maxRetainedHistoricalFdsPerRun
      )
      expect(report.deltas.daemonFdsPerAttachment).toBeLessThanOrEqual(1)
      expect(report.deltas.retainedHistoricalFdsPerRun).toBeLessThanOrEqual(2.25)
    }, 125_000)
  }
)
