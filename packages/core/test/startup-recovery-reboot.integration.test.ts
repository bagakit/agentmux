import { afterEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { frontendRecoveryFixture } from './helpers/frontend-recovery-fixture.js'
import { until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Private reboot cleanup failed')
})
it.runIf(process.platform === 'darwin')('restores the original native Session and workface across two actual Runtime/Core restarts without replaying its prompt', async () => {
  const f = await frontendRecoveryFixture(cleanup, 'code', false)
  let sdk = f.sdk
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.scope.socketPath } }); cleanup.push(() => rpc.dispose())
  const workface = (await rpc.call('space.commit', { expectedRevision: 0, graph: {
    spaces: [], bindings: [], zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', kind: 'directory', hostId: 'local', directoryPath: f.scope.root, branch: null }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: f.original.agentSessionId,
      runId: null, execution: { hostId: 'local', cwd: f.scope.root } }],
    layouts: { 'original-workspace': createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })).state
  const original = await sdk.statusAgent(f.original.agentSessionId)
  // A Core owner restart must leave its healthy native process and input usable.
  await sdk.dispose(); await f.scope.restart(); sdk = await f.scope.client()
  const healthy = await sdk.reattachAgent(f.original.agentSessionId, 0, 'raw')
  expect(healthy.session.run).toEqual(original.session.run)
  expect((await sdk.statusAgent(f.original.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid: original.run.pid, state: 'running' })
  await sdk.writeAgent({ agentSessionId: f.original.agentSessionId, expectedRun: original.session.run, data: 'HEALTHY_RAW_INPUT', source: 'user' })
  let previous = await sdk.statusAgent(f.original.agentSessionId)
  const receipts: unknown[] = []
  for (let boot = 1; boot <= 2; boot++) {
    const previousRoot = previous.session.continuity?.intentOperationId ?? previous.session.continuity?.operationId
    const oldBudget = previousRoot ? previous.session.continuityOperations?.[previousRoot]?.supervision?.attemptCount : undefined
    const ownerId = f.scope.owner.ownerInstanceId, daemonPid = f.scope.nativeProcessId
    await sdk.dispose(); await f.scope.stopOwner(); await f.scope.restartNativeDaemon(); await f.scope.restart(); sdk = await f.scope.client()
    expect(f.scope.owner.ownerInstanceId).not.toBe(ownerId); expect(f.scope.nativeProcessId).not.toBe(daemonPid)
    const ended = await sdk.statusAgent(f.original.agentSessionId)
    expect(ended.run).toMatchObject({ runId: previous.run.runId, state: 'interrupted' })
    const operationId = 'startup-boot-' + boot
    const result = await sdk.ensureAgentContinuity({ agentSessionId: f.original.agentSessionId, expectedRun: previous.session.run,
      operationId, trigger: 'startup', commandOverride: f.command, policy: { retryMaxAttempts: 0 } })
    expect(result.kind, JSON.stringify(result)).toBe('resumed')
    const after = await until(() => sdk.statusAgent(f.original.agentSessionId), value => value.session.terminalFrontend?.state === 'attached', 'new original native frontend')
    expect(after.session.agentSessionId).toBe(f.original.agentSessionId)
    expect(after.session.nativeHandle).toEqual(original.session.nativeHandle)
    expect(after.run.runId).not.toBe(previous.run.runId)
    expect(after.session.continuityOperations?.[operationId]).toMatchObject({ kind: 'resumed', previousRun: previous.session.run, newRun: after.session.run })
    if (previousRoot) expect(after.session.continuityOperations?.[previousRoot]?.supervision?.attemptCount).toBe(oldBudget)
    const currentRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.scope.socketPath } }); cleanup.push(() => currentRpc.dispose())
    expect((await currentRpc.call('space.state', {})).state).toEqual(workface)
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${f.scope.socketPath}`, 'agent', 'inspect', '--session', f.original.agentSessionId], f.scope.env)
    expect(cli.code, cli.stdout + cli.stderr).toBe(0); expect(cli.stdout).toContain(after.run.runId)
    receipts.push({ boot, ownerChanged: true, daemonChanged: true, originalSession: after.session.agentSessionId,
      nativeId: after.session.nativeHandle?.sessionId, previousRun: previous.run.runId, newRun: after.run.runId, workfaceRetained: true, cliCode: cli.code })
    // The new Run must acquire its own real native activity; an old predecessor
    // turn is historical evidence and cannot renew this Run's recovery age.
    if (boot < 2) {
      await f.activity()
      previous = await until(() => sdk.statusAgent(f.original.agentSessionId), value => value.session.semanticStatus?.state === 'working' &&
        value.session.semanticStatus.nativeTurnId === 'new-original-turn', 'fresh activity on the resumed original Run')
    } else previous = after
  }
  const inputs = (await readFile(f.native, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(inputs.filter(call => call.params.input.some((part: any) => part.text?.includes('ORIGINAL_PROMPT_DO_NOT_REPLAY')))).toHaveLength(1)
  console.log(JSON.stringify({ schema: 'agentmux.startup-two-reboots.v1', receipts, originalPromptCount: 1, healthyOwnerReattachment: true }))
})
