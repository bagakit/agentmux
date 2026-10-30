import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWorkspaceLayout } from '../../layout/src/index.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { offlineEndpoint } from './helpers/codex-offline-endpoint.js'
import { privateCodexConfigArgs } from './helpers/private-codex-config.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { nativeProcessTcpListeners } from '../src/agent-native-process.js'
import { connectCodexNativeActor } from '../src/providers/codex-native-rpc.js'
import { initialNativeComposerBinding } from '../../../apps/desktop/src/renderer/src/lib/initial-native-composer-binding.js'

const core = await import(/* @vite-ignore */ process.env.AGENTMUX_NATIVE_STARTUP_CORE_ENTRY!)
const native = process.env.AGENTMUX_TEST_CODEX_EXECUTABLE!, exec = promisify(execFile)
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private startup cleanup failed')
})

it.runIf(process.platform === 'darwin').each(['creation', 'manual', 'empty'] as const)(
  'fresh Native/TUI startup and later %s frontend failure retain the original public workface across Core restart', async mode => {
    const scope = await headlessFixture(); cleanups.push(scope.cleanup)
    const workspace = join(scope.root, 'workspace'), home = join(scope.root, 'codex-home')
    await mkdir(workspace); await mkdir(home)
    const inputs: string[] = [], offline = await offlineEndpoint(home, inputs, workspace)
    cleanups.push(async () => { for (const socket of offline.sockets) socket.destroy(); await new Promise<void>(yes => offline.endpoint.close(() => yes())) })
    const events = join(scope.root, 'native-processes.ndjson'), fault = join(scope.root, 'frontend-fault')
    const wrapper = join(scope.root, 'native-wrapper.mjs')
    // Only inject failure into our own exact frontend generation. The backend,
    // native protocol, TUI, bytes and actual user-message handling stay real.
    await writeFile(wrapper, `#!/usr/bin/env node
import {spawn} from 'node:child_process';import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2),frontend=args[0]==='--remote';
// The qualification runner already verified the exact wrapped official artifact.
if(args.length===1&&args[0]==='--version'){process.stdout.write('codex-cli 0.163.0'+String.fromCharCode(10));process.exit(0)}
const child=spawn(${JSON.stringify(native)},args,{env:process.env,stdio:'inherit'});
if(frontend)appendFileSync(${JSON.stringify(events)},JSON.stringify({pid:process.pid,child:child.pid})+'\\n');
let injected=false;const timer=frontend?setInterval(()=>{if(!injected&&existsSync(${JSON.stringify(fault)})&&readFileSync(${JSON.stringify(fault)},'utf8')===String(process.pid)){injected=true;child.kill('SIGTERM')}},20):undefined;
process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));
child.once('error',()=>{if(timer)clearInterval(timer);process.exitCode=1});
child.once('exit',(code,signal)=>{if(timer)clearInterval(timer);process.exitCode=injected?23:code??(signal?1:0)});
`, { mode: 0o700 })
    const sdk = await scope.client(), seen: any[] = []
    sdk.onEvent((event: any) => { if (event.type === 'agent-session') seen.push(event.session.terminalFrontend) })
    const prompt = 'PRIVATE_QUEUE_FRESH_START_' + mode
    const original = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'fresh-start-' + mode,
      createOperationId: 'fresh-create-' + mode, workspacePath: workspace, commandOverride: wrapper,
      args: [...privateCodexConfigArgs, '--config', 'check_for_update_on_startup=false', '--no-alt-screen', '--dangerously-bypass-hook-trust', '--model', 'private-queue', '--sandbox', 'read-only', '--ask-for-approval', 'never'],
      env: { CODEX_HOME: home, npm_config_prefix: join(scope.root, 'npm') }, prompt: mode === 'empty' ? '' : prompt, injectAgentMuxGuide: false })
    cleanups.push(async () => { const reader = await scope.client(); const status = await reader.statusAgent(original.agentSessionId)
      if (status.run.state === 'running') await reader.stopAgent(original.agentSessionId, status.session.run) })
    const store = new core.AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
    let emptyUnknownHistory = false
    if (mode === 'empty') {
      let pending = await until(() => sdk.statusAgent(original.agentSessionId), value =>
        value.session.terminalFrontend?.initialization?.phase === 'ready' && value.session.nativeHandle?.kind === 'provider',
      'empty original native identity is observable before any first input').catch(() => sdk.statusAgent(original.agentSessionId))
      expect(pending.session.nativeHandle, 'Empty creation must publish its exact Provider-confirmed native identity').toBeDefined()
      expect(pending.session.terminalFrontend?.state).toBe('starting')
      await sdk.sessionHistoryPage(original.agentSessionId, { refreshNativeSource: true, commandOverride: wrapper, env: { CODEX_HOME: home } }).catch(() => {})
      const historyState = (await store.readMetadata(original.agentSessionId)).nativeSourceObservation
      expect(historyState).toMatchObject({ state: 'unknown', run: original.run })
      emptyUnknownHistory = true
      pending = await sdk.statusAgent(original.agentSessionId)
      const binding = initialNativeComposerBinding({ providerId: pending.session.providerId,
        capabilities: pending.capabilities, nativeHandle: pending.session.nativeHandle, terminalFrontend: pending.session.terminalFrontend,
        control: { kind: 'agent', hostId: 'local', agentSessionId: original.agentSessionId, run: original.run } })
      expect(binding, 'The production new-composer target capture retains the exact live native object').toBeDefined()
      await sdk.submitAgentPrompt({ agentSessionId: original.agentSessionId, expectedRun: original.run,
        operationId: 'later-first-' + mode, prompt, authorHuman: true, execution: 'immediate', admissionIntent: binding!.admissionIntent })
    }
    const first = await until(() => sdk.statusAgent(original.agentSessionId), value =>
      value.session.terminalFrontend?.state === 'attached',
    'first exact native join and actual frontend process').catch(async error => {
      const current = await sdk.statusAgent(original.agentSessionId)
      const metadata = await store.readMetadata(original.agentSessionId)
      const replay = await sdk.readRunReplay(original.run)
      throw new Error(error.message + JSON.stringify({current, metadata, inputs, replay},null,2))
    })
    expect(seen.some(value => value?.state === 'detached' && value.exitCode !== 0)).toBe(false)
    expect(first.session.initialInput).toBeUndefined() // Private input stays with its original inspection owner.
    const saved = await store.readMetadata(original.agentSessionId), key = mode === 'empty'
      ? { kind: 'prompt', agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: 'later-first-' + mode }
      : saved.initialInput.key
    const listeners = await nativeProcessTcpListeners(first.run.pid!, new AbortController().signal)
    expect(listeners).toHaveLength(1)
    const connection = await connectCodexNativeActor(listeners[0]!.endpoint, saved.nativeActor.token,
      new AbortController().signal, 'agentmux_frontend_reconnect')
    cleanups.push(async () => connection.dispose())
    await until(() => sdk.inspectAgentPromptSubmission(key), value => value?.admission?.native?.outcome === 'admitted', 'original first input admitted')
    await until(async () => (await sdk.readRunReplay(original.run)).replay.map(value => value.data).join(''), value => value.includes('PRIVATE_QUEUE_COMPLETE'), 'real TUI completed bootstrap')
    const nativeBefore = await connection.request('thread/read', { threadId: saved.nativeHandle.sessionId, includeTurns: true })
    expect(nativeBefore.thread.turns).toHaveLength(1)
    const roots = (session: any) => Object.values(session.continuityOperations ?? {}).filter((value: any) => value.supervision && !value.intentOperationId) as any[]
    const root = roots((await sdk.statusAgent(original.agentSessionId)).session).find(value => value.supervision.phase === 'observing')
    expect(root, 'Creation has one durable original frontend supervision intent').toBeDefined()
    const graph = { spaces: [], zones: [], bindings: [],
      tabs: [{ tabId: 'original-tab', workspaceId: 'original-workspace', zoneId: null, name: null, regionIds: ['original-region'] }],
      regions: [{ tabId: 'original-tab', regionId: 'original-region', kind: 'agent', agentSessionId: original.agentSessionId,
        runId: original.run.runId, execution: { hostId: 'local', cwd: workspace } }],
      layouts: { original: createWorkspaceLayout('original-group', ['original-tab']) },
      tabLayouts: { 'original-tab': { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } },
      resources: { 'region:original-region': { phase: 'attached', draft: 'Original unsent draft' } } }
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    const spatial = await rpc.call('space.commit', { expectedRevision: 0, graph }); await rpc.dispose()
    const spawns = async () => (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(await spawns()).toHaveLength(1)
    const owner = scope.owner
    await sdk.dispose(); await scope.restart(); const reader = await scope.client()
    expect(scope.owner.ownerInstanceId).not.toBe(owner.ownerInstanceId); expect(scope.owner.ctxmux).toEqual(owner.ctxmux)
    const rpcAfter = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    try { expect((await rpcAfter.call('space.state', {})).state).toEqual(spatial.state) } finally { await rpcAfter.dispose() }
    const beforeFault = await reader.statusAgent(original.agentSessionId)
    expect(roots(beforeFault.session).find(value => value.operationId === root.operationId).supervision.attemptCount).toBe(root.supervision.attemptCount)
    await writeFile(fault, String((await spawns())[0].pid))
    if (mode === 'manual') {
      await until(() => reader.statusAgent(original.agentSessionId), value => value.session.terminalFrontend?.state === 'detached', 'exact private frontend nonzero exit')
      const request = { agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: 'manual-join-original', trigger: 'manual' }
      await Promise.all([reader.ensureAgentContinuity(request), reader.ensureAgentContinuity(request)])
    }
    const after = await until(() => reader.statusAgent(original.agentSessionId), value =>
      value.session.terminalFrontend?.state === 'attached' && value.session.terminalFrontend.frontendId !== first.session.terminalFrontend!.frontendId &&
      value.session.terminalHandshake?.frontendId === value.session.terminalFrontend.frontendId && value.session.terminalHandshake.acknowledged,
    'same original native frontend rejoined without a second recovery request')
    expect(after.run).toMatchObject({ runId: first.run.runId, pid: first.run.pid, state: 'running' })
    expect(after.session.nativeHandle).toMatchObject(first.session.nativeHandle!)
    expect(await spawns()).toHaveLength(2)
    const liveRoots = roots(after.session).filter(value => !['settled', 'cancelled', 'paused'].includes(value.supervision.phase))
    expect(liveRoots).toHaveLength(1)
    expect(liveRoots[0].supervision.attemptCount).toBe(root.supervision.attemptCount + 1)
    const claim = await reader.inspectAgentPromptSubmission(key)
    expect(claim.admission.native.outcome).toBe('admitted')
    const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + scope.socketPath, 'agent', 'inspect', '--session', original.agentSessionId], scope.env)
    expect(cli.code, cli.stderr).toBe(0); expect(cli.stdout).toContain(original.run.runId)
    // Keep exact private output for a failed interactive-input diagnostic.
    const child = (after.session.continuityOperations as any)[liveRoots[0].supervision.activeAttemptOperationId]
    const newFrontendBytes = child.frontendReconnect.outputAfterByte
    // This is a black-box operator reading the new TUI, never a production
    // authority check or transport selector. Only the actual native receipt
    // below proves input was accepted.
    await until(async () => (await reader.readRunReplay(original.run, newFrontendBytes, 'raw')).replay.map((value: any) => value.data).join(''),
      value => value.includes('PRIVATE_QUEUE_COMPLETE'), 'new TUI visibly renders the original first answer')
    const outputBoundary = (await reader.readRunReplay(original.run)).replay.map((value: any) => value.data).join('')
    const followup = 'PRIVATE_QUEUE_REAL_TUI_FOLLOWUP_' + mode
    await reader.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: '\x1b[200~' + followup + '\x1b[201~' })
    await reader.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: '\r' })
    await until(() => inputs, values => values.some(value => value.includes(followup)), 'actual rejoined TUI accepted next input').catch(async error => {
      throw new Error(error.message + JSON.stringify({ status: await reader.statusAgent(original.agentSessionId), beforeInput: outputBoundary,
        afterInput: (await reader.readRunReplay(original.run)).replay.map((value: any) => value.data).join(''),
        native: await connection.request('thread/read', { threadId: saved.nativeHandle.sessionId, includeTurns: true }), inputs }, null, 2))
    })
    const nativeAfter = await until(() => connection.request('thread/read', { threadId: saved.nativeHandle.sessionId, includeTurns: true }),
      value => value.thread.turns.length === 2 && value.thread.turns[1].status === 'completed', 'exact two Native user turns')
    expect(nativeAfter.thread.sessionId).toBe(nativeBefore.thread.sessionId)
    const nativeUserInputs = nativeAfter.thread.turns.flatMap((turn: any) => turn.items.filter((item: any) => item.type === 'userMessage'))
      .map((item: any) => item.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''))
    expect(nativeUserInputs).toHaveLength(2)
    expect(nativeUserInputs.filter((text: string) => text.includes(prompt))).toHaveLength(1)
    expect(nativeUserInputs.filter((text: string) => text === followup)).toHaveLength(1)
    if (process.env.AGENTMUX_FRONTEND_STARTUP_CONSUMER) await appendFile(process.env.AGENTMUX_FRONTEND_STARTUP_CONSUMER,
      JSON.stringify({ mode, emptyUnknownHistory, firstLaunchNoExit: true, originalRun: original.run, nativeHandle: first.session.nativeHandle,
        samePid: after.run.pid === first.run.pid, sameSpatialStateAcrossOwner: true, frontendCount: 2,
        activeSupervisionCount: liveRoots.length, originalInputKey: key, nativeUserInputCount: nativeUserInputs.length,
        actualRejoinedTuiInput: true, userRuntimeTouched: false }) + '\n')
  })
