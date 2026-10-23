import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

const nativeId = '00000000-0000-4000-8000-000000000005'
const fixtureRoot = resolve(import.meta.dirname, 'fixtures/agent-session-recovery')
const loader = pathToFileURL(join(fixtureRoot, 'register.mjs')).href
const previous = { owner: process.env.AGENTMUX_TEST_OWNER_ENTRY, node: process.env.NODE_OPTIONS }
const cleanups: Array<() => Promise<unknown>> = []
const evidence: Array<(testFailed: boolean) => Promise<void>> = []
// Outside the temporary Runtime: both successful and failed candidates survive cleanup.
const sourceRoot = resolve(import.meta.dirname, '../../..')
const evidenceRoot = resolve(process.env.AGENTMUX_TEST_RECOVERY_EVIDENCE_DIRECTORY ?? join(sourceRoot, '.local/state/agent-session-recovery'))
const runStamp = new Date().toISOString().replace(/[:.]/gu, '-') + '-' + process.pid
const harnessPaths = ['agent-session-recovery.integration.test.ts', 'agent-session-recovery.integration.config.mts',
  'fixtures/agent-session-recovery/register.mjs', 'fixtures/agent-session-recovery/source-loader.mjs',
  'fixtures/agent-session-recovery/owner.mjs', 'fixtures/agent-session-recovery/native.mjs',
  'fixtures/agent-session-recovery/compiled-owner.mjs']
let harnessBefore: Array<{ path: string; sha256: string }>
async function harnessHashes() {
  return await Promise.all(harnessPaths.map(async path => ({ path: 'packages/core/test/' + path,
    sha256: createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex') })))
}
beforeAll(async () => {
  harnessBefore = await harnessHashes()
  process.env.AGENTMUX_TEST_OWNER_ENTRY = join(fixtureRoot, 'owner.mjs')
  // The native version command must have its real empty stderr; loader warnings
  // are test infrastructure, not Provider protocol diagnostics.
  process.env.NODE_OPTIONS = [previous.node, '--no-warnings', '--import=' + loader].filter(Boolean).join(' ')
})
afterAll(() => {
  if (previous.owner === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous.owner
  if (previous.node === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous.node
})
afterEach(async context => {
  const errors: unknown[] = []
  for (const save of evidence.splice(0)) try { await save(Boolean(context.task.result?.errors?.length)) } catch (error) { errors.push(error) }
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private recovery integration cleanup failed')
})
async function rows(path: string): Promise<any[]> {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
async function cli(scope: Awaited<ReturnType<typeof headlessFixture>>, args: string[]) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((yes, no) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../src/agentmux.ts'), '--endpoint', `unix:${scope.socketPath}`, ...args],
      { env: scope.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('Private actual CLI exceeded its reply deadline.')) }, 15_000)
    child.stdout.on('data', bytes => { stdout += String(bytes) }); child.stderr.on('data', bytes => { stderr += String(bytes) })
    child.once('error', error => { clearTimeout(timer); no(error) })
    child.once('close', code => { clearTimeout(timer); yes({ code, stdout, stderr }) })
  })
}
async function fixture(mode: 'preflight' | 'late-create', caseId: 'preflight-owner-restart' | 'late-create-unknown-input' | 'ready-frontend-reconnect') {
  const scope = await headlessFixture(); cleanups.push(scope.cleanup)
  // Register before create: an acknowledged Start followed by a failed creation
  // reply still owns a live private Run. No user Runtime or PID is enumerated.
  cleanups.push(async () => {
    const reader = await scope.client()
    for (const run of await reader.listRuns()) if (run.state === 'running') await reader.stopTerminal({ runId: run.runId })
  })
  const sdk = await scope.client()
  const flag = join(scope.root, mode === 'preflight' ? 'account-failure' : 'native-gate')
  await writeFile(flag, mode)
  const create = { providerId: 'codex', executorId: 'codex', agentSessionId: 'original-' + mode, createOperationId: 'original-create-' + mode,
    workspacePath: scope.root, commandOverride: join(fixtureRoot, 'native.mjs'),
    args: ['--sandbox', 'read-only', '--ask-for-approval', 'never'],
    env: { AGENTMUX_TEST_RECOVERY_PROTOCOL_ROOT: scope.root }, prompt: 'ORIGINAL_INITIAL_INPUT_' + mode, injectAgentMuxGuide: false }
  let proof: unknown = null
  const cliReceipts: unknown[] = []
  const ownerReceipts = [scope.owner]
  evidence.push(async testFailed => {
    const observationErrors: string[] = []
    const read = async <T>(label: string, operation: () => Promise<T>): Promise<T | null> => {
      try { return await operation() } catch (error) { observationErrors.push(label + ': ' + String(error)); return null }
    }
    const sourceLoads = await rows(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'recovery-loaded-source.ndjson'))
    const sources = new Map<string, Set<string>>()
    for (const row of sourceLoads) {
      const hashes = sources.get(row.path) ?? new Set<string>(); hashes.add(row.sha256); sources.set(row.path, hashes)
    }
    const unstable = [...sources].filter(([, hashes]) => hashes.size !== 1).map(([path]) => path)
    const loadedSources = [...sources].map(([path, hashes]) => ({ path, sha256: [...hashes][0] })).sort((a, b) => a.path.localeCompare(b.path))
    const loadedPaths = new Set(loadedSources.map(source => source.path))
    const missingRecoveryOwners = [
      'packages/core/src/agent-session-recovery/service.ts',
      'packages/core/src/agent-session-recovery/continuity-attempt.ts',
      'packages/core/src/agent-session-recovery/lifecycle.ts',
      'packages/core/src/agent-session-recovery/reconciliation.ts'
    ].filter(path => !loadedPaths.has(path))
    const changed = []
    for (const source of loadedSources) {
      const bytes = await read(source.path, () => readFile(join(sourceRoot, source.path)))
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) changed.push(source.path)
    }
    const harnessAfter = await harnessHashes()
    const harnessChanged = JSON.stringify(harnessBefore) !== JSON.stringify(harnessAfter)
    const reader = await read('connect evidence reader', () => scope.client())
    const session = reader ? await read('read original Session', () => reader.readAgentSession(create.agentSessionId)) : null
    const initialInputKey = session?.creation?.initialInputKey
    const nativeCalls = await rows(join(scope.root, 'native-rpc.ndjson'))
    const nativeInputs = await rows(join(scope.root, 'native-input.ndjson'))
    const frontends = await rows(join(scope.root, 'frontends.ndjson'))
    const publicRuns = reader ? await read('public Runs', () => reader.listRuns()) : null
    const originalInput = initialInputKey && reader ? await read('original input receipt', () => reader.inspectAgentPromptSubmission(initialInputKey)) : null
    const receipt = { schema: 'agentmux.agent-session-recovery.integration.v1', case: caseId, runStamp,
      passed: Boolean(proof) && !testFailed && !unstable.length && !changed.length && !harnessChanged && !observationErrors.length && loadedSources.length > 0 && !missingRecoveryOwners.length,
      sourceRoot, loadedSources, missingRecoveryOwners, sourceLoads, unstable, changed, harnessChanged, observationErrors, harnessSources: harnessBefore,
      proof, privateRuntime: { originalStore: scope.env.AGENTMUX_AGENT_SESSION_STORE, owners: ownerReceipts,
        nativeProcessId: scope.nativeProcessId, runs: publicRuns }, session, originalInput,
      counts: { nativeCreates: nativeCalls.filter(row => row.method === 'thread/start').length,
        nativeResumes: nativeCalls.filter(row => row.method === 'thread/resume').length, nativeInputs: nativeInputs.length, frontends: frontends.length },
      actualCli: cliReceipts, nativeCalls, nativeInputs, frontends, terminalInputs: await rows(join(scope.root, 'terminal-input.ndjson')) }
    await mkdir(evidenceRoot, { recursive: true })
    await writeFile(join(evidenceRoot, 'integration-' + runStamp + '-' + caseId + '.json'), JSON.stringify(receipt, null, 2) + '\n')
    expect(observationErrors, 'Evidence must retain public authority and original receipt.').toEqual([])
    expect(unstable, 'A loaded source changed between private processes.').toEqual([])
    expect(changed, 'The qualified loaded source differs from the candidate after the run.').toEqual([])
    expect(harnessChanged, 'The test harness changed during qualification.').toBe(false)
    expect(loadedSources.length, 'The real source owner must publish a nonempty source manifest.').toBeGreaterThan(0)
    expect(missingRecoveryOwners, 'Each private chain must load every split recovery owner.').toEqual([])
  })
  const original = await sdk.createAgent(create)
  const storePath = await realpath(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const initialized = await until(async () => {
    const value = await sdk.statusAgent(original.agentSessionId)
    if (value.run.state !== 'running' || !(await store.readMetadata(original.agentSessionId))?.nativeActor?.initializationControl) throw new Error(JSON.stringify({ stage: 'original managed actor', value,
      frontends: await rows(join(scope.root, 'frontends.ndjson')), native: await rows(join(scope.root, 'native-rpc.ndjson')) }))
    return value
  }, value => mode === 'preflight'
    ? value.session.terminalFrontend?.initialization?.phase === 'failed'
    : value.session.terminalFrontend?.initialization?.native.state === 'unknown', 'original structured initialization ' + mode)
  const stored = (await store.readMetadata(original.agentSessionId))!
  expect(stored.initialInput?.delivery).toBe('post-launch')
  expect(stored.creation?.initialInputKey).toEqual(stored.initialInput?.key)
  expect(stored.initialInput?.prompt).toContain(create.prompt)
  expect(await sdk.inspectAgentPromptSubmission(stored.initialInput!.key!)).toBeNull()
  expect(await rows(join(scope.root, 'native-input.ndjson'))).toHaveLength(0)
  expect(await rows(join(scope.root, 'frontends.ndjson'))).toHaveLength(0)
  const backend = JSON.parse(await readFile(join(scope.root, 'backend.json'), 'utf8'))
  return { scope, sdk, flag, create, original, initialized, stored, store, storePath, backend, cliReceipts, ownerReceipts,
    complete: (receipt: unknown) => { proof = receipt } }
}

it.runIf(process.platform === 'darwin')('keeps the same durable creation, backend and initial input across a real Core owner restart, then resumes through actual CLI exactly once', async () => {
  const f = await fixture('preflight', 'preflight-owner-restart'), beforeOwner = f.scope.owner
  expect(f.initialized.session.terminalFrontend?.initialization).toMatchObject({ phase: 'failed', native: { state: 'not-created' },
    failure: { step: 'preflight', code: -32041 } })
  expect((await rows(join(f.scope.root, 'native-rpc.ndjson'))).filter(row => row.method === 'thread/start')).toHaveLength(0)
  await f.sdk.dispose(); await f.scope.restart(); f.ownerReceipts.push(f.scope.owner); const reader = await f.scope.client()
  expect(f.scope.owner.runtimeId).toBe(beforeOwner.runtimeId)
  expect(f.scope.owner.ownerInstanceId).not.toBe(beforeOwner.ownerInstanceId)
  expect(f.scope.owner.ctxmux).toEqual(beforeOwner.ctxmux)
  const retained = await reader.statusAgent(f.original.agentSessionId)
  expect(retained.run).toMatchObject({ runId: f.original.run.runId, pid: f.initialized.run.pid, state: 'running' })
  expect((await f.store.readMetadata(f.original.agentSessionId))!.initialInput).toEqual(f.stored.initialInput)
  expect(await realpath(f.scope.env.AGENTMUX_AGENT_SESSION_STORE!)).toBe(f.storePath)
  expect(JSON.parse(await readFile(join(f.scope.root, 'backend.json'), 'utf8')).pid).toBe(f.backend.pid)
  await rm(f.flag)
  const args = ['agent', 'resume', '--session', f.original.agentSessionId, '--operation-id', 'original-recovery']
  const first = await cli(f.scope, args); f.cliReceipts.push({ args, ...first })
  expect(first.code, first.stdout + first.stderr).toBe(0)
  const after = await until(() => reader.statusAgent(f.original.agentSessionId), value => value.session.creation?.initialPrompt === 'confirmed' &&
    value.session.terminalFrontend?.state === 'attached', 'same original initialized object and initial input admitted').catch(async cause => {
      const saved = await f.store.readMetadata(f.original.agentSessionId)
      throw new Error(JSON.stringify({ stage: 'original initial input after recovery', cli: first, status: await reader.statusAgent(f.original.agentSessionId),
        initialInput: saved?.initialInput, submission: await reader.inspectAgentPromptSubmission(f.stored.initialInput!.key!),
        calls: await rows(join(f.scope.root, 'native-rpc.ndjson')), frontends: await rows(join(f.scope.root, 'frontends.ndjson')) }), { cause })
    })
  expect(after.run).toMatchObject({ runId: f.original.run.runId, pid: f.initialized.run.pid, state: 'running' })
  expect(after.session.nativeHandle).toMatchObject({ providerId: 'codex', sessionId: nativeId })
  const input = await reader.inspectAgentPromptSubmission(f.stored.initialInput!.key!)
  expect(input?.admission).toMatchObject({ inputKey: f.stored.initialInput!.key, transport: 'native', native: { outcome: 'admitted' }, acknowledged: true })
  const repeat = await cli(f.scope, args); f.cliReceipts.push({ args, ...repeat }); expect(repeat.code, repeat.stdout + repeat.stderr).toBe(0)
  const inspect = await cli(f.scope, ['agent', 'inspect', '--session', f.original.agentSessionId])
  f.cliReceipts.push({ args: ['agent', 'inspect', '--session', f.original.agentSessionId], ...inspect })
  expect(inspect.code, inspect.stdout + inspect.stderr).toBe(0)
  expect(JSON.parse(inspect.stdout).result.session).toMatchObject({ agentSessionId: f.original.agentSessionId, run: f.original.run,
    creation: { initialInputKey: f.stored.initialInput!.key, initialPrompt: 'confirmed' } })
  const calls = await rows(join(f.scope.root, 'native-rpc.ndjson'))
  expect(calls.filter(row => row.method === 'thread/start')).toHaveLength(1)
  expect(calls.filter(row => row.method === 'thread/resume')).toHaveLength(0)
  const inputs = await rows(join(f.scope.root, 'native-input.ndjson'))
  expect(inputs).toHaveLength(1); expect(inputs[0].params.input[0].text).toContain(f.create.prompt)
  const fronts = await rows(join(f.scope.root, 'frontends.ndjson'))
  expect(fronts).toHaveLength(1); expect(fronts[0].args).toContain(nativeId)
  expect(JSON.stringify(fronts)).not.toContain(f.create.prompt)
  expect(JSON.parse(await readFile(join(f.scope.root, 'backend.json'), 'utf8')).pid).toBe(f.backend.pid)
  f.complete({ schema: 'agentmux.agent-session-recovery.integration.v1', case: 'preflight-owner-restart',
    agentSessionId: f.original.agentSessionId, run: f.original.run, managedPid: after.run.pid, backendPid: f.backend.pid,
    originalStore: f.storePath, oldOwner: beforeOwner.ownerInstanceId, newOwner: f.scope.owner.ownerInstanceId,
    nativeCreates: 1, initialInputClaims: 1, initialInputKey: f.stored.initialInput!.key, actualCliInspectAndResume: true })
})

it.runIf(process.platform === 'darwin')('joins a pending native create across owner restart, takes its late response, and never replays its unknown original input', async () => {
  const f = await fixture('late-create', 'late-create-unknown-input'), key = f.stored.initialInput!.key!
  await until(() => rows(join(f.scope.root, 'native-rpc.ndjson')), calls => calls.some(row => row.method === 'thread/start'), 'original native create actually dispatched')
  const request = { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'observe-original-create', trigger: 'manual' as const }
  const pending = await f.sdk.ensureAgentContinuity(request)
  expect(pending.kind).toBe('pending')
  await f.sdk.dispose(); await f.scope.restart(); f.ownerReceipts.push(f.scope.owner); const reader = await f.scope.client()
  const stillPending = await reader.ensureAgentContinuity(request)
  expect(stillPending.kind).toBe('pending')
  expect((await rows(join(f.scope.root, 'native-rpc.ndjson'))).filter(row => row.method === 'thread/start')).toHaveLength(1)
  expect(await reader.inspectAgentPromptSubmission(key)).toBeNull()
  expect(await rows(join(f.scope.root, 'native-input.ndjson'))).toHaveLength(0)
  await writeFile(join(f.scope.root, 'input-unknown'), 'lose the original native input reply')
  await rm(f.flag)
  await until(() => reader.statusAgent(f.original.agentSessionId), value => value.session.terminalFrontend?.initialization?.phase === 'ready', 'late exact native response accepted')
  await reader.ensureAgentContinuity(request)
  const unknown = await until(() => reader.inspectAgentPromptSubmission(key), value => value?.admission?.transport === 'native' &&
    value.admission.native.outcome === 'unknown', 'late response original initial claim remains unknown')
  const after = await reader.statusAgent(f.original.agentSessionId)
  expect(after.run).toMatchObject({ runId: f.original.run.runId, pid: f.initialized.run.pid, state: 'running' })
  expect(after.session.creation?.initialInputKey).toEqual(key)
  expect(after.session.creation?.initialPrompt).not.toBe('confirmed')
  expect(after.session.nativeHandle?.sessionId).toBe(nativeId)
  expect((await rows(join(f.scope.root, 'native-rpc.ndjson'))).filter(row => row.method === 'thread/start')).toHaveLength(1)
  expect(await rows(join(f.scope.root, 'native-input.ndjson'))).toHaveLength(1)
  expect(await rows(join(f.scope.root, 'frontends.ndjson'))).toHaveLength(1)
  expect(JSON.parse(await readFile(join(f.scope.root, 'backend.json'), 'utf8')).pid).toBe(f.backend.pid)
  await reader.dispose(); await f.scope.restart(); f.ownerReceipts.push(f.scope.owner); const restarted = await f.scope.client()
  await restarted.ensureAgentContinuity(request)
  expect((await restarted.statusAgent(f.original.agentSessionId)).run).toMatchObject({ runId: f.original.run.runId, pid: f.initialized.run.pid })
  expect((await restarted.inspectAgentPromptSubmission(key))?.admission).toEqual(unknown!.admission)
  expect(await rows(join(f.scope.root, 'native-input.ndjson'))).toHaveLength(1)
  expect((await rows(join(f.scope.root, 'native-rpc.ndjson'))).filter(row => row.method === 'thread/start')).toHaveLength(1)
  expect(await rows(join(f.scope.root, 'frontends.ndjson'))).toHaveLength(1)
  f.complete({ schema: 'agentmux.agent-session-recovery.integration.v1', case: 'late-create-unknown-input',
    agentSessionId: f.original.agentSessionId, run: f.original.run, managedPid: after.run.pid, backendPid: f.backend.pid,
    originalStore: f.storePath, nativeCreates: 1, initialInputClaims: 1, initialInputKey: key, nativeInputOutcome: 'unknown',
    ownerRestarts: 2, repeatedOriginalOperation: request.operationId })
})


it.runIf(process.platform === 'darwin')('reconnects only the failed original frontend after native readiness and an owner restart without a native create or input replay', async () => {
  const f = await fixture('preflight', 'ready-frontend-reconnect')
  await rm(f.flag)
  const initialArgs = ['agent', 'resume', '--session', f.original.agentSessionId, '--operation-id', 'finish-original-initialization']
  const initialized = await cli(f.scope, initialArgs); f.cliReceipts.push({ args: initialArgs, ...initialized })
  expect(initialized.code, initialized.stdout + initialized.stderr).toBe(0)
  const attached = await until(() => f.sdk.statusAgent(f.original.agentSessionId), value => value.session.creation?.initialPrompt === 'confirmed' &&
    value.session.terminalFrontend?.state === 'attached', 'original native ready before the child frontend fails')
  const firstFrontendId = attached.session.terminalFrontend!.frontendId, key = f.stored.initialInput!.key!
  const admitted = await f.sdk.inspectAgentPromptSubmission(key)
  expect(admitted?.admission).toMatchObject({ inputKey: key, transport: 'native', native: { outcome: 'admitted' }, acknowledged: true })
  expect((await rows(join(f.scope.root, 'frontends.ndjson')))).toHaveLength(1)
  const failureFlag = join(f.scope.root, 'detach-frontend')
  await writeFile(failureFlag, 'the original test-owned child exits with code 1')
  const failed = await until(() => f.sdk.statusAgent(f.original.agentSessionId), value => value.session.terminalFrontend?.state === 'detached' &&
    value.session.terminalFrontend.exitCode === 1, 'exact original frontend nonzero exit')
  expect(failed.run).toMatchObject({ runId: f.original.run.runId, pid: f.initialized.run.pid, state: 'running' })
  expect(failed.session.terminalFrontend).toMatchObject({ frontendId: firstFrontendId, backendState: 'running',
    initialization: { phase: 'ready', native: { state: 'confirmed', sessionId: nativeId } } })
  await f.sdk.dispose(); await f.scope.restart(); f.ownerReceipts.push(f.scope.owner); const reader = await f.scope.client()
  const retained = await until(() => reader.statusAgent(f.original.agentSessionId), value => value.session.terminalFrontend?.frontendId === firstFrontendId &&
    value.session.terminalFrontend.state === 'detached', 'new owner retains the original failed frontend and native object')
  expect(retained.run).toMatchObject({ runId: f.original.run.runId, pid: f.initialized.run.pid, state: 'running' })
  expect(retained.session.nativeHandle?.sessionId).toBe(nativeId)
  expect(retained.session.creation?.initialInputKey).toEqual(key)
  await rm(failureFlag)
  const recoveryArgs = ['agent', 'resume', '--session', f.original.agentSessionId, '--operation-id', 'restore-only-original-frontend']
  const resumed = await cli(f.scope, recoveryArgs); f.cliReceipts.push({ args: recoveryArgs, ...resumed })
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0)
  const reconnected = await until(() => reader.statusAgent(f.original.agentSessionId), value => value.session.terminalFrontend?.state === 'attached' &&
    value.session.terminalFrontend.frontendId !== firstFrontendId, 'new exact child frontend on the original live backend')
  expect(reconnected.run).toMatchObject({ runId: f.original.run.runId, pid: f.initialized.run.pid, state: 'running' })
  expect(reconnected.session.nativeHandle?.sessionId).toBe(nativeId)
  expect(reconnected.session.creation).toMatchObject({ initialInputKey: key, initialPrompt: 'confirmed' })
  expect((await reader.inspectAgentPromptSubmission(key))?.admission).toEqual(admitted!.admission)
  const repeat = await cli(f.scope, recoveryArgs); f.cliReceipts.push({ args: recoveryArgs, ...repeat })
  expect(repeat.code, repeat.stdout + repeat.stderr).toBe(0)
  const calls = await rows(join(f.scope.root, 'native-rpc.ndjson')), fronts = await rows(join(f.scope.root, 'frontends.ndjson'))
  expect(calls.filter(row => row.method === 'thread/start')).toHaveLength(1)
  expect(calls.filter(row => row.method === 'thread/resume')).toHaveLength(0)
  expect(await rows(join(f.scope.root, 'native-input.ndjson'))).toHaveLength(1)
  expect(fronts).toHaveLength(2)
  for (const front of fronts) expect(front.args).toContain(nativeId)
  expect(JSON.stringify(fronts)).not.toContain(f.create.prompt)
  expect(JSON.parse(await readFile(join(f.scope.root, 'backend.json'), 'utf8')).pid).toBe(f.backend.pid)
  f.complete({ schema: 'agentmux.agent-session-recovery.integration.v1', case: 'ready-frontend-reconnect',
    agentSessionId: f.original.agentSessionId, run: f.original.run, managedPid: reconnected.run.pid, backendPid: f.backend.pid,
    originalStore: f.storePath, initialInputKey: key, firstFrontendId, newFrontendId: reconnected.session.terminalFrontend!.frontendId,
    frontendExitCode: 1, nativeCreates: 1, nativeResumes: 0, initialInputClaims: 1, frontends: 2, ownerRestarts: 1 })
})
