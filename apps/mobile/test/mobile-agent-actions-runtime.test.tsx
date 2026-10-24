import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MobileAgentActions } from '../src/conversation/MobileAgentActions'
import { recoverMobileAgent } from '../src/conversation/mobile-agent-recovery'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, mount, mounted } from './conversation-fixture'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'

let scope: Awaited<ReturnType<typeof headlessFixture>> | undefined, binaryRoot: string | undefined
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  if (scope) await scope.cleanup(); scope = undefined
  vi.unstubAllEnvs()
  if (binaryRoot) await rm(binaryRoot, { recursive: true, force: true }); binaryRoot = undefined
})
it('the mounted mobile action resumes the same native Agent through the real public Hosted owner after process exit and Host restart', async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  binaryRoot = await mkdtemp(join(tmpdir(), 'mobile-resume-bin-')); await mkdir(join(binaryRoot, 'bin'))
  await symlink(resolve(import.meta.dirname, '../../../packages/core/test/fixtures/fake-codex-cli.mjs'), join(binaryRoot, 'bin/codex'))
  vi.stubEnv('PATH', join(binaryRoot, 'bin') + ':' + process.env.PATH)
  scope = await headlessFixture()
  const client = await scope.client()
  const created = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
    injectAgentMuxGuide: false, createOperationId: 'mobile-private-native-create', env: { AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
  await until(() => client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle), 'private original native target')
  const original = client.agentSession(created.agentSessionId)
  const observation = await client.statusAgent(original.agentSessionId)
  if (!observation.run.pid) throw new Error('Private synthetic process PID required')
  globalThis.process.kill(observation.run.pid, 'SIGTERM')
  await until(() => client.statusAgent(original.agentSessionId), value => value.run.state !== 'running', 'private original process exit')
  const replacement = await scope.restart()
  await until(() => client.runtimeOwnerIdentity(), value => value?.ownerInstanceId === replacement.owner.ownerInstanceId && value.availability === 'connected', 'private original Host reconnected')
  const source = await client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
  expect(source.session.run).toEqual(original.run)
  const copy = vi.fn().mockResolvedValue(true)
  const view = await mount(<MobileAgentActions client={client} agentSessionId={original.agentSessionId} connected copyText={copy} />)
  await click(button(view.element, '恢复原 Agent'))
  await act(async () => { await until(() => getDeviceWorkface().snapshot().record.agentResumes?.at(-1), value => value?.phase === 'confirmed', 'actual mobile continuity receipt') })
  const current = await client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
  const intent = getDeviceWorkface().snapshot().record.agentResumes!.at(-1)!
  expect(current.session.agentSessionId).toBe(original.agentSessionId)
  expect(current.session.nativeHandle).toEqual(original.nativeHandle)
  expect(current.session.run.runId).not.toBe(original.run.runId)
  expect(current.session.continuityOperations?.[intent.input.operationId]).toMatchObject({ kind: 'resumed', previousRun: original.run })
  const originalOperation = structuredClone(intent.input)
  await view.render(<MobileAgentActions client={client} agentSessionId={original.agentSessionId} connected={false} copyText={copy} />)
  await view.render(<MobileAgentActions client={client} agentSessionId={original.agentSessionId} connected copyText={copy} />)
  expect(getDeviceWorkface().snapshot().record.agentResumes!.at(-1)!.input).toEqual(originalOperation)
  const originalEnsure = client.ensureAgentContinuity.bind(client), notice = vi.fn()
  const ensure = vi.spyOn(client, 'ensureAgentContinuity').mockImplementationOnce(async input => {
    await originalEnsure(input)
    throw new Error('Original main-entry recovery receipt lost')
  })
  const mainEntry = { client, agentSessionId: original.agentSessionId, expectedHostId: source.routeHostId, isCurrent: () => true, onNotice: notice }
  await act(async () => { await recoverMobileAgent(mainEntry) })
  const pending = getDeviceWorkface().snapshot().record.agentResumes!.at(-1)!
  expect(pending.phase).toBe('unknown')
  expect(pending.input.expectedRun).toEqual(current.session.run)
  expect(pending.input.trigger).toBe('manual')
  await act(async () => { await recoverMobileAgent(mainEntry) })
  expect(ensure).toHaveBeenCalledTimes(1)
  expect(getDeviceWorkface().snapshot().record.agentResumes!.at(-1)).toEqual({ ...pending, phase: 'confirmed' })
  const same = await client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
  expect(same.session.run).toEqual(current.session.run)
  expect(same.session.nativeHandle).toEqual(original.nativeHandle)
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve(import.meta.dirname, '../../../packages/core/bin/amux'))
  const cli = async (args: string[]) => {
    const receipt = await runCompiledObjectCli(['--endpoint', `unix:${scope!.socketPath}`, ...args], objectCliEnvironment(scope!.root))
    expect(receipt.code, receipt.stderr).toBe(0)
    return JSON.parse(receipt.stdout).result
  }
  expect((await cli(['agent', 'inspect', '--session', original.agentSessionId])).session.run).toEqual(current.session.run)
  expect(await cli(['agent', 'resume', '--session', original.agentSessionId, '--operation-id', 'mobile-main-cli-original'])).toMatchObject({ agentSessionId: original.agentSessionId, runId: current.session.run.runId })
  expect((await cli(['agent', 'inspect', '--session', original.agentSessionId])).session.continuityOperations['mobile-main-cli-original']).toMatchObject({ trigger: 'manual', kind: 'reattachable', previousRun: current.session.run })
  await client.stopAgent(current.session.agentSessionId, current.session.run)
}, 90_000)
