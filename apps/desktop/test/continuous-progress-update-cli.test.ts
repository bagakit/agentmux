import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { ContinuousProgressLoopManager } from '@agentmux/host/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store'

it('saves the original loop through the actual source CLI and public RPC dispatcher', async () => {
  const cli = process.env.AGENTMUX_TEST_OBJECT_CLI
  if (!cli) throw new Error('Build and select the isolated source CLI using AGENTMUX_TEST_OBJECT_CLI.')
  const dir = await mkdtemp(join(tmpdir(), 'progress-cli-'))
  const target = { hostId: 'local', agentSessionId: 'original-session', providerId: 'generic', workspacePath: join(dir, 'workspace') }
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  const onTick = async () => { throw new Error('Saving must not send') }
  const manager = new ContinuousProgressLoopManager(store, onTick, () => 0, async () => { throw new Error('Saving must not observe') })
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
  } finally { await server.stop(); await manager.stop(); await rm(dir, { recursive: true, force: true }) }
})
