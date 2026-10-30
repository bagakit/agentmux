import { once } from 'node:events'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { const errors: unknown[] = []; for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }; vi.unstubAllEnvs(); if (errors.length) throw new AggregateError(errors) })

it.each(['gate', 'effect'] as const)('real owner crash after %s preserves the original real PTY identity and never replays an applied input', async phase => {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/input-handoff-crash-worker.mjs'))
  const h = await headlessFixture(); cleanup.push(h.cleanup)
  let client = await h.client()
  const state = h.env.AGENTMUX_STATE_DIRECTORY!, output = join(h.root, 'terminal-input.jsonl')
  const text = 'Original handoff survives owner crash 原文'
  const session = await client.createAgent({ agentSessionId: 'original-handoff-session', createOperationId: 'original-handoff-create', providerId: 'pi', executorId: 'pi',
    workspacePath: h.root, injectAgentMuxGuide: false, commandOverride: process.execPath,
    args: [resolve(import.meta.dirname, 'fixtures/prompt-carrier-terminal.mjs')], env: { AGENTMUX_TEST_INPUT_WITNESS: output } })
  const before = await until(async () => { try { const ready = JSON.parse(await readFile(output + '.ready', 'utf8')); const result = await client.statusAgent(session.agentSessionId); return result.run.pid === ready.pid ? result : null } catch { return null } }, Boolean, 'original isolated PTY ready')
  const key = { kind: 'prompt' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: 'original-gate-input' }
  await writeFile(join(state, phase === 'gate' ? 'hold-after-gate' : 'hold-after-effect'), 'private barrier')
  await client.submitAgentPrompt({ agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: key.submissionId, prompt: text,
    authorHuman: true, execution: 'immediate', admissionIntent: { kind: 'manual-actor' } })
  await until(async () => { try { return JSON.parse(await readFile(join(state, phase + '-witness.json'), 'utf8')) } catch { return null } }, Boolean, 'actual owner passed its exact durable ' + phase + ' boundary')
  const original = (await client.inspectAgentInput({ key }))!
  expect(original).toMatchObject({ status: 'unknown', control: { state: 'dispatch-authorized', handoff: { carrier: { kind: 'pty' } } } })
  if (phase === 'gate') expect(original.admission).toBeNull()
  else expect(original.admission).not.toBeNull()
  const ownerBefore = h.owner, pidBefore = h.ownerProcess.pid
  const exited = once(h.ownerProcess, 'exit'); h.ownerProcess.kill('SIGKILL'); await exited
  await rm(join(state, phase === 'gate' ? 'hold-after-gate' : 'hold-after-effect'))
  if (phase === 'gate') await writeFile(join(state, 'provider-drift'), 'do not reselect')
  await h.restart(); client = await h.client()
  expect(h.ownerProcess.pid).not.toBe(pidBefore); expect(h.owner.runtimeId).toBe(ownerBefore.runtimeId)
  expect(h.owner.ownerInstanceId).not.toBe(ownerBefore.ownerInstanceId)
  expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: before!.run.runId, pid: before!.run.pid, state: 'running' })
  expect((await client.inspectAgentInput({ key }))!.control).toEqual(original.control)
  const result = await runCompiledObjectCli(['--endpoint', 'unix:' + h.socketPath, 'agent', 'input', 'rejoin', '--input', '-'], objectCliEnvironment(h.root), JSON.stringify({ ref: original.ref }))
  expect(result.code, result.stdout + result.stderr).toBe(0)
  if (phase === 'gate') await until(() => client.inspectAgentInput({ key }), value => value?.status === 'terminal-confirmed', 'same original gate first dispatch')
  const inputs = async () => (await readFile(output, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).split('\n').filter(Boolean).map(line => JSON.parse(line).text)
  await until(inputs, list => list.length === 1, 'one original real PTY input')
  await client.rejoinAgentInputWaiting({ ref: original.ref })
  expect(await inputs()).toEqual([text])
  const calls = (await readFile(join(state, 'effect-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toHaveLength(1)
  expect((await client.inspectAgentInput({ key }))!.ref).toEqual(original.ref)
  if (process.env.AGENTMUX_HANDOFF_CRASH_EVIDENCE) await writeFile(process.env.AGENTMUX_HANDOFF_CRASH_EVIDENCE + '-' + phase + '.json', JSON.stringify({ phase, ownerBefore, ownerAfter: h.owner, pidBefore, pidAfter: h.ownerProcess.pid,
    sessionBefore: before, sessionAfter: await client.statusAgent(session.agentSessionId), original, result: await client.inspectAgentInput({ key }), inputs: await inputs(), calls }, null, 2))
  await client.stopAgent(session.agentSessionId, session.run)
}, 60_000)

it.each(['native', 'launch'] as const)('original %s carrier survives a real private Core process crash before claim and applies its retained request once', async mode => {
  const { spawn } = await import('node:child_process')
  const { mkdtemp, mkdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { connectAgentMuxRpc } = await import('../src/public-rpc-client.js')
  const { connectHostedAgentMux } = await import('../src/hosted-client.js')
  const root = await mkdtemp(join(tmpdir(), 'amux-handoff-carrier-'))
  await mkdir(join(root, 'state')); await mkdir(join(root, 'runtime')); await mkdir(join(root, 'home'))
  const env = objectCliEnvironment(root, { HOME: join(root, 'home'), AMUX_HANDOFF_CARRIER: mode, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime') })
  let child: import('node:child_process').ChildProcess | undefined
  const open: Array<{ dispose(): Promise<unknown> }> = []
  const kill = async () => { if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended } }
  cleanup.push(async () => { for (const client of open.reverse()) await client.dispose(); await kill(); await rm(root, { recursive: true, force: true }) })
  const start = async () => {
    child = spawn(process.execPath, [resolve(import.meta.dirname, 'fixtures/input-handoff-carrier-worker.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let errors = ''; child.stderr!.on('data', chunk => { errors += String(chunk) })
    const receipt = await new Promise<{ socketPath: string; owner: { ownerInstanceId: string } }>((yes, no) => {
      let output = ''; const timer = setTimeout(() => no(Error('Private carrier owner readiness: ' + errors)), 20_000)
      child!.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('\n')) { clearTimeout(timer); try { yes(JSON.parse(output.split('\n')[0]!)) } catch (error) { no(error) } } })
      child!.once('exit', code => { clearTimeout(timer); no(Error('Private carrier owner exit ' + code + ': ' + errors)) })
    })
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: receipt.socketPath } }); open.push(rpc)
    const hosted = await connectHostedAgentMux({ rpc }); open.push(hosted)
    return { rpc, hosted, receipt, errors: () => errors }
  }
  const state = env.AGENTMUX_STATE_DIRECTORY!
  await writeFile(join(state, 'hold-after-gate'), 'private gate barrier')
  let f = await start()
  const sender = { kind: 'external' as const, connectionId: 'private-connection', actor: { application: { domain: 'private.protocol', appId: 'private-app' }, idType: 'user-id', userId: 'original-author' },
    externalConversationId: 'private-room', externalMessageId: 'private-message', bindingId: 'private-binding', bindingRevision: 1, grantId: 'private-grant', grantRevision: 1 }
  const sent = await f.hosted.submitAgentMessage({ agentSessionId: 'recipient', execution: 'immediate',
    envelope: { schema: 'agentmux.a2a.v1', messageId: 'carrier-message', operationId: 'carrier-control', createdAt: 1, sender,
      recipient: { kind: 'agent-session', agentSessionId: 'recipient' }, recipientSessionId: 'recipient', recipientRunId: 'original-run',
      senderSessionId: null, senderRunId: null, threadId: 'private-thread', correlationId: 'private-correlation', replyTo: null, workspaceId: null, body: 'Original process carrier 原文' },
    admissionIntent: mode === 'native' ? { kind: 'native-conversation', expectedRun: { runId: 'original-run' }, source: { providerId: 'grok', nativeSessionId: 'original-native' } }
      : { kind: 'manual-actor', expectedRun: { runId: 'original-run' } } })
  if (!sent) throw Error('The original external input was not saved')
  const ref = sent.ref
  let pending: Promise<unknown> | undefined, completed: unknown
  if (mode === 'launch') pending = f.hosted.ensureAgentContinuity({ agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, operationId: 'original-carrier-resume', trigger: 'input', messageInputRef: ref, policy: { recheckMaxAttempts: 0 } }).then(value => { completed = { kind: value.kind, reason: 'reason' in value ? value.reason : undefined, error: value.continuity?.error, code: value.continuity?.errorCode } }, error => { completed = { error: String(error) } })
  await until(async () => { try { return JSON.parse(await readFile(join(state, 'gate-witness.json'), 'utf8')) } catch { if (completed) throw Error('Original launch ended before gate: ' + JSON.stringify(completed)); return null } }, Boolean, 'real private ' + mode + ' owner gate persisted')
  const before = (await f.hosted.inspectAgentInput({ key: ref.key }))!
  expect(before).toMatchObject({ status: 'unknown', admission: null, control: { handoff: { carrier: { kind: mode } } } })
  const beforePid = child!.pid, beforeOwner = f.receipt.owner
  await kill(); await pending
  await rm(join(state, 'hold-after-gate')); f = await start()
  expect(child!.pid).not.toBe(beforePid); expect(f.receipt.owner.ownerInstanceId).not.toBe(beforeOwner.ownerInstanceId)
  expect((await f.hosted.inspectAgentInput({ key: ref.key }))!.control).toEqual(before.control)
  const continued = await runCompiledObjectCli(['--endpoint', 'unix:' + f.receipt.socketPath, 'agent', 'input', 'rejoin', '--input', '-'], env, JSON.stringify({ ref }))
  expect(continued.code, continued.stdout + continued.stderr).toBe(0)
  const after = await until(() => f.hosted.inspectAgentInput({ key: ref.key }), value => value?.status === (mode === 'native' ? 'admitted' : 'launch-carried'), 'same retained ' + mode + ' first claim after crash').catch(async error => { throw Error(String(error) + '\nOriginal input: ' + JSON.stringify(await f.hosted.inspectAgentInput({ key: ref.key })) + '\nPrivate owner: ' + f.errors()) })
  await f.hosted.rejoinAgentInputWaiting({ ref })
  const effects = (await readFile(join(state, 'carrier-effects.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(effects).toHaveLength(1); expect(effects[0].kind).toBe(mode)
  expect(after).toMatchObject({ key: before.key, ref: before.ref, control: before.control })
  const session = await f.hosted.readAgentSession('recipient')
  expect(session?.nativeHandle).toMatchObject({ sessionId: 'original-native' })
  if (process.env.AGENTMUX_HANDOFF_CRASH_EVIDENCE) await writeFile(process.env.AGENTMUX_HANDOFF_CRASH_EVIDENCE + '-' + mode + '.json', JSON.stringify({ mode, beforePid, afterPid: child!.pid, beforeOwner, afterOwner: f.receipt.owner, before, after, effects, session }, null, 2))
}, 60_000)
