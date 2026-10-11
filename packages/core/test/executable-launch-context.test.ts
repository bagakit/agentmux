import { chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalEnvironment } from '../src/client.js'
import { classifyExecutable } from '../src/executable-probe.js'
import { cleanupExecutableNativeFixtures, executableNativeFixture, until } from './helpers/executable-native-fixture.js'

const faults = vi.hoisted(() => new Map<string, 'stat' | 'access'>())
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  const check = (path: unknown, operation: 'stat' | 'access') => {
    if (faults.get(String(path)) === operation) throw Object.assign(new Error('Original executable observation failed'), { code: 'EIO' })
  }
  return { ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => { check(args[0], 'stat'); return await actual.stat(...args) },
    access: async (...args: Parameters<typeof actual.access>) => { check(args[0], 'access'); return await actual.access(...args) }
  }
})
afterEach(async () => { faults.clear(); await cleanupExecutableNativeFixtures(); vi.restoreAllMocks() })

describe('the executable owner uses the actual invocation context', () => {
  it.each(['configured-path', 'workspace-relative'] as const)('%s reaches real Native create, direct resume and continuity', async shape => {
    const f = await executableNativeFixture(shape), caller = await f.hosted(), originalPath = process.env.PATH, originalCwd = process.cwd()
    expect(await caller.probeExecutorAvailability('claude', f.command, { workspacePath: f.root, env: terminalEnvironment(f.env) })).toMatchObject({ availability: 'available' })
    const created = await caller.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'original task' })
    const first = await f.receipt(created)
    expect(first).toMatchObject({ cwd: f.root, marker: shape, sid: created.agentSessionId })
    expect(first.args).toContain('original task')
    await until(() => f.client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle))
    await f.exit(created)
    const pendingResume = caller.resumeAgent({ agentSessionId: created.agentSessionId, operationId: 'context-direct-resume',
      prompt: 'resume task', commandOverride: f.command, env: f.env })
    await expect(pendingResume).resolves.toMatchObject({ agentSessionId: created.agentSessionId })
    const resumed = await pendingResume
    const second = await f.receipt(resumed)
    expect(second).toMatchObject({ cwd: f.root, marker: shape, sid: created.agentSessionId })
    expect(second.pid).not.toBe(first.pid); expect(second.args).toContain('--resume'); expect(second.args).toContain(first.nativeId); expect(second.args).toContain('resume task')
    await f.exit(resumed)
    const continuity = await caller.ensureAgentContinuity({ agentSessionId: created.agentSessionId, expectedRun: resumed.run,
      operationId: 'context-continuity', commandOverride: f.command, env: f.env, trigger: 'manual' })
    expect(continuity.kind).toBe('resumed')
    const third = await f.receipt(f.client.agentSession(created.agentSessionId))
    expect(third).toMatchObject({ cwd: f.root, marker: shape, sid: created.agentSessionId })
    expect(third.pid).not.toBe(second.pid); expect(third.args).toContain(first.nativeId)
    expect(process.env.PATH).toBe(originalPath); expect(process.cwd()).toBe(originalCwd)
  }, 45_000)
  it('checks the Provider plan command and environment instead of the pre-plan request', async () => {
    const f = await executableNativeFixture('configured-path'), provider = f.client.providers.get('claude')
    const launch = provider.buildLaunch.bind(provider), resume = provider.buildResumeLaunch.bind(provider)
    provider.buildLaunch = input => ({ ...launch(input), command: f.command, env: f.env })
    provider.buildResumeLaunch = input => ({ ...resume(input), command: f.command, env: f.env })
    const created = await f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: 'pre-plan-command', env: { PATH: '' }, injectAgentMuxGuide: false, prompt: 'actual plan task' })
    expect((await f.receipt(created)).marker).toBe('configured-path')
    await until(() => f.client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle))
    await f.exit(created)
    const resumed = await f.client.resumeAgent({ agentSessionId: created.agentSessionId, operationId: 'provider-plan-resume',
      prompt: 'actual resume plan', commandOverride: 'pre-plan-command', env: { PATH: '' } })
    expect((await f.receipt(resumed)).args).toContain('actual resume plan')
    await f.exit(resumed)
    const continuity = await f.client.ensureAgentContinuity({ agentSessionId: created.agentSessionId, expectedRun: resumed.run,
      operationId: 'provider-plan-continuity', commandOverride: 'pre-plan-command', env: { PATH: '' }, trigger: 'manual' })
    expect(continuity.kind).toBe('resumed')
    expect((await f.receipt(f.client.agentSession(created.agentSessionId))).marker).toBe('configured-path')
  }, 30_000)
  it('keeps missing, uncertain workspace, directories and unavailable observations distinct', async () => {
    const f = await executableNativeFixture('configured-path')
    await expect(f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: './absent', env: f.env, injectAgentMuxGuide: false })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
    expect(f.client.agentSessions()).toEqual([])
    expect(await f.client.probeExecutorAvailability('claude', './bin/context-runner', { env: f.env })).toMatchObject({
      availability: 'check-failed', cause: { code: 'EXECUTABLE_WORKSPACE_REQUIRED' } })
    expect(await classifyExecutable(dirname(f.executable), { workspacePath: f.root, env: f.env })).toMatchObject({
      availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FILE' } })
    await chmod(f.executable, 0o644)
    expect(await classifyExecutable(f.executable, { workspacePath: f.root, env: f.env })).toMatchObject({
      availability: 'check-failed', cause: { code: 'EACCES' } })
  }, 30_000)
  it.each(['stat', 'access'] as const)('%s observation failure preserves real Native create and original resume', async operation => {
    const f = await executableNativeFixture('configured-path'), caller = await f.hosted()
    const start = vi.spyOn(Reflect.get(f.client, 'kernel'), 'start')
    faults.set(f.executable, operation)
    expect(await caller.probeAgent('claude', f.command, { workspacePath: f.root, env: f.env })).toMatchObject({
      installed: false, executableObservation: { executable: f.command, availability: 'check-failed', cause: { code: 'EIO' } } })
    const created = await caller.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'original observed task' })
    const first = await f.receipt(created)
    expect(first.sid).toBe(created.agentSessionId)
    await until(() => f.client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle))
    await f.exit(created)
    const resumed = await caller.resumeAgent({ agentSessionId: created.agentSessionId, operationId: 'unconfirmed-direct',
      commandOverride: f.command, env: f.env, prompt: 'same native task' })
    expect((await f.receipt(resumed)).args).toContain(first.nativeId)
    await f.exit(resumed)
    const result = await caller.ensureAgentContinuity({ agentSessionId: created.agentSessionId, expectedRun: resumed.run,
      operationId: 'unconfirmed-continuity', commandOverride: f.command, env: f.env, trigger: operation === 'stat' ? 'manual' : 'input',
      ...(operation === 'access' ? { input: { submissionId: 'original-fresh-input', prompt: 'fresh user task' } } : {}) })
    expect(result.kind).toBe('resumed')
    const current = f.client.agentSession(created.agentSessionId)
    expect((await f.receipt(current)).args).toContain(first.nativeId)
    expect(start).toHaveBeenCalledTimes(3)
    expect(await caller.probeAgent('claude', f.command, { workspacePath: f.root, env: f.env })).toMatchObject({ installed: false })
    faults.clear()
    expect(await caller.probeExecutorAvailability('claude', f.command, { workspacePath: f.root, env: f.env })).toMatchObject({ availability: 'available' })
    expect((await caller.statusAgent(created.agentSessionId)).run.state).toBe('running')
  }, 45_000)
  it('does not reinterpret a Provider refusal or unsupported native resume as a failed filesystem check', async () => {
    const f = await executableNativeFixture('configured-path'), provider = f.client.providers.get('claude')
    const created = await f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'retained original' })
    await f.receipt(created)
    await until(() => f.client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle))
    await f.exit(created)
    const start = vi.spyOn(Reflect.get(f.client, 'kernel'), 'start'), original = provider.probeCapabilities.bind(provider)
    faults.set(f.executable, 'stat')
    provider.probeCapabilities = async (probe, commandOverride) => ({ providerId: provider.id, executable: commandOverride!,
      installed: await probe.hasExecutable(commandOverride!), capabilities: { ...provider.catalog.capabilities } })
    await expect(f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'unsupported create' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', detail: 'provider-unavailable' })
    await expect(f.client.resumeAgent({ agentSessionId: created.agentSessionId, operationId: 'provider-refused',
      commandOverride: f.command, env: f.env, prompt: 'unsupported resume' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
    expect(await f.client.ensureAgentContinuity({ agentSessionId: created.agentSessionId, expectedRun: created.run,
      operationId: 'provider-refused-continuity', commandOverride: f.command, env: f.env, trigger: 'manual' })).toMatchObject({ kind: 'unavailable', reason: 'provider-unavailable' })
    faults.set(join(f.root, 'bin', 'another-command'), 'stat')
    provider.probeCapabilities = async probe => ({ providerId: provider.id, executable: f.command, installed: false,
      executableObservation: await probe.observeExecutable!('another-command'), capabilities: { ...provider.catalog.capabilities } })
    await expect(f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'wrong executable observation' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
    provider.probeCapabilities = async (probe, commandOverride) => {
      const capability = await original(probe, commandOverride)
      return { ...capability, capabilities: { ...capability.capabilities, providerResume: false } }
    }
    expect(await f.client.ensureAgentContinuity({ agentSessionId: created.agentSessionId, expectedRun: created.run,
      operationId: 'native-resume-unsupported', commandOverride: f.command, env: f.env, trigger: 'manual' })).toMatchObject({ kind: 'unavailable', reason: 'provider-unavailable' })
    provider.probeCapabilities = async () => { throw new Error('Provider capability contract unavailable') }
    expect(await f.client.ensureAgentContinuity({ agentSessionId: created.agentSessionId, expectedRun: created.run,
      operationId: 'provider-probe-unconfirmed', commandOverride: f.command, env: f.env, trigger: 'manual' })).toMatchObject({ kind: 'pending', reason: 'provider-unverified' })
    expect(start).not.toHaveBeenCalled()
  }, 30_000)
  it('does not elevate a same-command observation invented outside this probe', async () => {
    const f = await executableNativeFixture('configured-path'), provider = f.client.providers.get('claude')
    const start = vi.spyOn(Reflect.get(f.client, 'kernel'), 'start')
    provider.probeCapabilities = async () => ({ providerId: provider.id, executable: f.command, installed: false,
      executableObservation: { executable: f.command, availability: 'check-failed', cause: { code: 'EIO', message: 'Invented filesystem observation' } },
      capabilities: { ...provider.catalog.capabilities } })
    expect(await f.client.probeAgent('claude', f.command, { workspacePath: f.root, env: f.env })).toMatchObject({ installed: false })
    expect((await f.client.probeAgent('claude', f.command, { workspacePath: f.root, env: f.env })).executableObservation).toBeUndefined()
    await expect(f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'unsupported original task' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', detail: 'provider-unavailable' })
    provider.probeCapabilities = async probe => {
      const observation = await probe.observeExecutable!(f.command)
      expect(observation.availability).toBe('available')
      Object.assign(observation, { availability: 'check-failed', cause: { code: 'EIO', message: 'Changed callback result' } })
      return { providerId: provider.id, executable: f.command, installed: false, executableObservation: observation,
        capabilities: { ...provider.catalog.capabilities } }
    }
    expect((await f.client.probeAgent('claude', f.command, { workspacePath: f.root, env: f.env })).executableObservation).toBeUndefined()
    await expect(f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'independently unsupported task' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', detail: 'provider-unavailable' })
    expect(start).not.toHaveBeenCalled()
  }, 30_000)
  it('keeps Provider diagnostic wording independent of real Native execution', async () => {
    const f = await executableNativeFixture('configured-path'), provider = f.client.providers.get('claude')
    const original = provider.probeCapabilities.bind(provider)
    faults.set(f.executable, 'stat')
    provider.probeCapabilities = async (probe, commandOverride) => {
      const capability = await original(probe, commandOverride), observation = capability.executableObservation
      if (observation?.availability !== 'check-failed') throw new Error('Expected original failed filesystem observation')
      return { ...capability, executableObservation: { ...observation,
        cause: { ...observation.cause, message: 'Provider diagnostic wording was reformatted' } } }
    }
    const caller = await f.hosted()
    expect(await caller.probeAgent('claude', f.command, { workspacePath: f.root, env: f.env })).toMatchObject({ installed: false,
      executableObservation: { executable: f.command, availability: 'check-failed', cause: { code: 'EIO', message: 'Original executable observation failed' } } })
    const created = await caller.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'original wording-independent task' })
    expect((await f.receipt(created)).sid).toBe(created.agentSessionId)
    expect((await caller.statusAgent(created.agentSessionId)).run.state).toBe('running')
  }, 30_000)
})
