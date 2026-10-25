import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { ContinuousProgressLoopManager } from '@agentmux/host/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store'
import { observeAgent } from '@agentmux/core'

it('saves and immediately resumes the original loop through the actual source CLI and public RPC dispatcher', async () => {
  const cli = process.env.AGENTMUX_TEST_OBJECT_CLI
  if (!cli) throw new Error('Build and select the isolated source CLI using AGENTMUX_TEST_OBJECT_CLI.')
  const dir = await mkdtemp(join(tmpdir(), 'progress-cli-'))
  const target = { hostId: 'local', agentSessionId: 'original-session', providerId: 'generic', workspacePath: join(dir, 'workspace') }
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  let checking = false
  const deliveries: string[] = []
  const manager = new ContinuousProgressLoopManager(store, async (loop, operation) => {
    expect(checking).toBe(true); expect(loop.prompt).toBe('updated'); deliveries.push(operation); return 'sent'
  }, () => 0, async (_loop, tickId) => {
    if (!checking) throw new Error('Saving must not observe')
    const status = { state: 'done' as const, source: 'native-hook' as const, observedAt: 1 }
    return { session: { ...target, run: { runId: 'original-run' }, semanticStatus: status }, inputByte: 0, tickId, now: 0,
      observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, 0) }
  })
  const server = new AgentMuxControlServer({ socketPath: join(dir, 'control.sock'), progress: { call: manager.callProgress.bind(manager) } })
  const invoke = (args: string[], input = '') => new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input)
  })
  try {
    const loop = await manager.create({ ...target, intervalMs: 60_000, prompt: 'original' })
    await server.start()
    const help = await invoke(['agent', 'progress', 'update', '--help'])
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('amux agent progress update --data <FILE|->')
    const request = { target, loopId: loop.loopId, expectedLoop: loop, intervalMs: 120_000, prompt: 'updated', operationId: 'original-update' }
    const response = await invoke(['--endpoint', `unix:${server.path}`, 'agent', 'progress', 'update', '--data', '-'], JSON.stringify(request))
    expect(response.code, response.stderr).toBe(0)
    expect(JSON.parse(response.stdout)).toMatchObject({ ok: true, operation: 'agent.progress.update', result: { diskDurability: 'confirmed', loop: { loopId: loop.loopId, intervalMs: 120_000, prompt: 'updated', nextCheckAt: loop.nextCheckAt } } })
    expect((await store.load())[0]).toMatchObject({ loopId: loop.loopId, intervalMs: 120_000, prompt: 'updated', lastMutation: { action: 'update', operationId: 'original-update' } })
    expect(deliveries).toEqual([])
    const actionHelp = await invoke(['agent', 'progress', 'action', '--help'])
    expect(actionHelp.code, actionHelp.stderr).toBe(0)
    expect(actionHelp.stdout).toContain('Resume restores ordinary progress and immediately checks that Agent')
    const paused = await manager.pause(loop.loopId)
    const resume = { target, loopId: loop.loopId, expectedLoop: paused, action: 'resume', operationId: 'original-resume' }
    checking = true
    const resumed = await invoke(['--endpoint', `unix:${server.path}`, 'agent', 'progress', 'action', '--data', '-'], JSON.stringify(resume))
    expect(resumed.code, resumed.stderr).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, operation: 'agent.progress.action', result: { diskDurability: 'confirmed', loop: { loopId: loop.loopId, status: 'active', lastOutcome: 'sent', lastTickAt: 0 } } })
    expect(deliveries).toHaveLength(1)
    const repeated = await invoke(['--endpoint', `unix:${server.path}`, 'agent', 'progress', 'action', '--data', '-'], JSON.stringify(resume))
    expect(repeated.code, repeated.stderr).toBe(0)
    expect(deliveries).toHaveLength(1)
  } finally { await server.stop(); await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})
