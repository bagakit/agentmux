import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { assertExitedAdmission, ObservedPromptStore, prepareRealCodexScope, privateCodexConfigArgs, type RealCodexScope } from './helpers/real-codex-fixture.js'
import { AgentProviderRegistry, AgentManagedHookInstaller, AgentMuxClient, type AgentMuxClientEvent } from '../dist/index.js'

const execFileAsync = promisify(execFile)
const scopes: RealCodexScope[] = []
const ctxmuxDaemon = fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url))

afterEach(async () => {
  const failures = await Promise.allSettled(scopes.splice(0).map(scope => scope.cleanup()))
  const errors = failures.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Real Codex private cleanup failed; scope preserved.')
}, 30_000)

async function waitFor<T>(
  scope: RealCodexScope,
  description: string,
  predicate: () => T | Promise<T>,
  timeoutMs = 120_000,
  diagnose?: () => unknown
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    scope.assertOpen()
    const result = await scope.perform(async () => await predicate())
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const detail = diagnose ? ` diagnostic=${JSON.stringify(diagnose())}` : ''
  throw new Error(`Timed out waiting for ${description}.${detail}`)
}

describe.runIf(process.env.AGENTMUX_REAL_CODEX_E2E === '1')('installed real Codex lifecycle', () => {
  it('uses real hooks/auth, reconnects one Run, resumes to a new exact Run, and retires naturally', async () => {
    const requestedCommand = process.env.AGENTMUX_REAL_CODEX_COMMAND ?? 'codex'
    const command = (await execFileAsync('which', [requestedCommand], {
      timeout: 5_000,
      maxBuffer: 64 * 1024
    })).stdout.trim()
    // Missing isolated seed fails before any Native/Agent launch; no user HOME/Keychain fallback.
    const scope = await prepareRealCodexScope(owner => scopes.push(owner))
    const root = scope.root
    const preflight = await scope.perform(async () => await Promise.allSettled([
      execFileAsync(command, [...privateCodexConfigArgs, '--version'], { timeout: 5_000, maxBuffer: 64 * 1024 }),
      execFileAsync(command, [...privateCodexConfigArgs, 'login', 'status'], { timeout: 10_000, maxBuffer: 64 * 1024 }),
      execFileAsync(command, [...privateCodexConfigArgs, 'mcp', 'list', '--json'], { timeout: 10_000, maxBuffer: 64 * 1024 }),
      execFileAsync(command, [...privateCodexConfigArgs, 'features', 'list'], { timeout: 10_000, maxBuffer: 64 * 1024 })
    ]))
    if (preflight.some(result => result.status === 'rejected')) throw new Error('Private Codex version/auth/MCP/features preflight failed; no Native or Agent launched.')
    const [version, auth, mcp, features] = preflight.map(result => {
      if (result.status !== 'fulfilled') throw new Error('Private Codex preflight is incomplete.')
      return result.value
    }) as [{ stdout: string; stderr: string }, { stdout: string; stderr: string }, { stdout: string; stderr: string }, { stdout: string; stderr: string }]
    // Do not include authentication/configuration output in failures.
    expect(/^codex-cli 0\./u.test(version.stdout.trim())).toBe(true)
    expect(`${auth.stdout}${auth.stderr}`.includes('Logged in')).toBe(true)
    let noMcpServers = false
    try {
      const configured: unknown = JSON.parse(mcp.stdout)
      noMcpServers = Array.isArray(configured) && configured.length === 0
    } catch { /* Invalid output is an honest preflight failure, without printing its values. */ }
    expect(noMcpServers).toBe(true)
    const featureRows = features.stdout.trim().split('\n').map(line => line.trim().split(/\s+/u))
    expect(featureRows.length).toBeGreaterThan(0)
    for (const [name, enabled] of [['hooks', 'true'], ['plugins', 'false'], ['plugin_hooks', 'false'], ['memories', 'false'], ['chronicle', 'false']]) {
      expect(featureRows.filter(row => row[0] === name).map(row => row.at(-1))).toEqual([enabled])
    }
    const invocationId = root.slice(root.lastIndexOf('-') + 1)
    const agentSessionId = `real-codex-${invocationId}`
    const workspace = join(root, 'workspace')
    await scope.perform(async () => await execFileAsync('git', ['init', '--quiet', workspace], { timeout: 5_000, maxBuffer: 64 * 1024 }))
    const installer = new AgentManagedHookInstaller(join(root, 'hook-state'))
    const provider = new AgentProviderRegistry().get('codex')
    const preview = await scope.perform(async () => await installer.preview(provider.planManagedHooks!({ workspacePath: workspace })!))
    const hookReceipt = await scope.perform(async () => await installer.install(preview.id))
    const trustOverride = `projects={${JSON.stringify(workspace)}={trust_level="trusted"}}`
    const codexArgs = [
      ...privateCodexConfigArgs,
      '--dangerously-bypass-hook-trust',
      '--no-alt-screen',
      '--ask-for-approval', 'never',
      '--sandbox', 'read-only',
      '--config', 'model_reasoning_effort="low"',
      '--config', trustOverride
    ]
    const store = new ObservedPromptStore(join(root, 'agent-sessions.json'))
    await scope.startNative(ctxmuxDaemon)
    let client = await scope.connect(new AgentMuxClient({ store }))
    let output = ''
    const assistantMarkers = new Set<string>()
    const observe = (event: AgentMuxClientEvent): void => {
      if (event.type === 'terminal-output') output += event.data ?? ''
      if (
        event.type === 'agent-timeline' &&
        event.mutation.type === 'append' &&
        event.mutation.item.kind === 'assistant_message'
      ) {
        assistantMarkers.add(event.mutation.item.content ?? '')
      }
    }
    client.onEvent(observe)
    const created = await scope.perform(async () => await client.createAgent({
      agentSessionId,
      createOperationId: `real-codex-create-${invocationId}`,
      providerId: 'codex',
      executorId: 'codex',
      workspacePath: workspace,
      injectAgentMuxGuide: false,
      commandOverride: command,
      args: codexArgs,
      prompt: 'Reply with exactly AGENTMUX_REAL_CODEX_READY and do not use tools.'
    }))
    expect(created.terminalHandshake).toMatchObject({
      run: { runId: created.run.runId },
      inputByteRange: { startByte: 0, endByte: 5 },
      acknowledged: true
    })
    const firstAttachment = await scope.perform(async () => await client.reattachAgent(created.agentSessionId, 0))
    output += firstAttachment.attachment.replay.map((event) => event.data).join('')
    expect(output).toContain('\u001b[?u')
    const nativeSessionId = await waitFor(scope, 'real Codex SessionStart hook', () => {
      const session = client.agentSession(created.agentSessionId)
      return session.nativeHandle?.kind === 'provider' &&
        session.hookReceipt?.eventName === 'SessionStart' &&
        session.hookReceipt.run.runId === created.run.runId
        ? session.nativeHandle.sessionId
        : ''
    })
    await waitFor(scope, 'real Codex initial completed response', () => {
      const session = client.agentSession(created.agentSessionId)
      return output.includes('AGENTMUX_REAL_CODEX_READY') &&
        [...assistantMarkers].some((content) => content.includes('AGENTMUX_REAL_CODEX_READY')) &&
        session.hookReceipt?.eventName === 'Stop' &&
        session.hookReceipt.run.runId === created.run.runId &&
        session.terminalPromptReadiness?.source === 'native-stop' &&
        session.terminalPromptReadiness.id === session.hookReceipt.id &&
        session.terminalPromptReadiness.readyThroughByte !== undefined
    }, 120_000, () => {
      const session = client.agentSession(created.agentSessionId)
      return {
        outputTail: output.slice(-8 * 1024),
        assistantMarkers: [...assistantMarkers].slice(-8).map((value) => value.slice(-1024)),
        nativeHandle: session.nativeHandle ?? null,
        hookReceipt: session.hookReceipt ?? null,
        terminalPromptReadiness: session.terminalPromptReadiness ?? null
      }
    })
    const initialReadiness = client.agentSession(created.agentSessionId).terminalPromptReadiness
    expect(initialReadiness?.readyThroughByte).toBeGreaterThanOrEqual(
      initialReadiness?.outputCursorBytes ?? Number.MAX_SAFE_INTEGER
    )
    const firstStatus = await scope.perform(async () => await client.statusAgent(created.agentSessionId))
    await scope.dispose(client)

    client = await scope.connect(new AgentMuxClient({ store }))
    output = ''
    client.onEvent(observe)
    const reattached = await scope.perform(async () => await client.reattachAgent(created.agentSessionId, 0))
    output += reattached.attachment.replay.map((event) => event.data).join('')
    const reconnectedStatus = await scope.perform(async () => await client.statusAgent(created.agentSessionId))
    expect(reconnectedStatus.run.runId).toBe(firstStatus.run.runId)
    expect(reconnectedStatus.run.pid).toBe(firstStatus.run.pid)
    expect(output).toContain('AGENTMUX_REAL_CODEX_READY')
    const firstPreExit = await scope.perform(async () => await client.statusAgent(created.agentSessionId))
    expect(firstPreExit.run.acceptedInputBytes).toBe(5)
    await scope.perform(async () => await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(created.agentSessionId)),
      agentSessionId: created.agentSessionId,
      operationId: `real-codex-exit-${invocationId}`,
      prompt: '/exit'
    }))
    const firstExit = await waitFor(scope, 'real Codex initial Run terminal receipt', async () => {
      const status = await scope.perform(async () => await client.statusAgent(created.agentSessionId))
      return status.run.state === 'exited' &&
        status.run.acceptedInputBytes === 11
        ? status
        : null
    })
    expect(firstExit!.run.exitCode).toBe(0)
    expect(firstExit!.run.exitSignal).toBeUndefined()
    const firstSubmission = await assertExitedAdmission(scope, store, created.agentSessionId, created.run,
      `real-codex-exit-${invocationId}`, provider.planPromptInput('/exit'), 5)
    expect(firstSubmission).toMatchObject({
      readinessEvidence: { source: 'native-stop', id: initialReadiness?.id, outputCursorBytes: initialReadiness?.outputCursorBytes, readyThroughByte: initialReadiness?.readyThroughByte },
      payload: { acknowledged: true },
      submit: { acknowledged: true }
    })
    await scope.perform(async () => await client.releaseRunAttachment(created.run))
    const firstExitReplay = await scope.perform(async () => await client.reattachAgent(
      created.agentSessionId,
      firstPreExit.run.latestOutputBytes
    ))
    expect(firstExitReplay.attachment.replay.map((event) => event.data).join('')).toContain('/exit')
    await scope.dispose(client)

    client = await scope.connect(new AgentMuxClient({ store }))
    output = ''
    client.onEvent(observe)
    const resumedPrompt = 'Reply with exactly AGENTMUX_REAL_CODEX_RESUMED and do not use tools.'
    const resumed = await scope.perform(async () => await client.resumeAgent({
      agentSessionId: created.agentSessionId,
      operationId: `real-codex-resume-${invocationId}`,
      prompt: resumedPrompt,
      args: codexArgs,
      commandOverride: command
    }))
    expect(resumed.agentSessionId).toBe(created.agentSessionId)
    expect(resumed.run.runId).not.toBe(created.run.runId)
    expect(resumed.terminalHandshake).toMatchObject({
      run: { runId: resumed.run.runId },
      inputByteRange: { startByte: 0, endByte: 5 },
      acknowledged: true
    })
    const resumedAttachment = await scope.perform(async () => await client.reattachAgent(resumed.agentSessionId, 0))
    output += resumedAttachment.attachment.replay.map((event) => event.data).join('')
    expect(output).toContain('\u001b[?u')
    expect(client.agentSession(resumed.agentSessionId).nativeHandle).toMatchObject({
      kind: 'provider', providerId: 'codex', sessionId: nativeSessionId
    })
    await waitFor(scope, 'real Codex resumed completed response', () => {
      const session = client.agentSession(resumed.agentSessionId)
      return output.includes('AGENTMUX_REAL_CODEX_RESUMED') &&
        [...assistantMarkers].some((content) => content.includes('AGENTMUX_REAL_CODEX_RESUMED')) &&
        session.hookReceipt?.eventName === 'Stop' &&
        session.hookReceipt.run.runId === resumed.run.runId &&
        session.terminalPromptReadiness?.source === 'native-stop' &&
        session.terminalPromptReadiness.id === session.hookReceipt.id &&
        session.terminalPromptReadiness.readyThroughByte !== undefined
    }, 120_000, () => {
      const session = client.agentSession(resumed.agentSessionId)
      return {
        outputTail: output.slice(-8 * 1024),
        assistantMarkers: [...assistantMarkers].slice(-8).map((value) => value.slice(-1024)),
        nativeHandle: session.nativeHandle ?? null,
        hookReceipt: session.hookReceipt ?? null,
        terminalPromptReadiness: session.terminalPromptReadiness ?? null
      }
    })
    const resumedReadiness = client.agentSession(resumed.agentSessionId).terminalPromptReadiness
    const resumedConnectedStatus = await scope.perform(async () => await client.statusAgent(resumed.agentSessionId))
    await scope.dispose(client)

    client = await scope.connect(new AgentMuxClient({ store }))
    output = ''
    client.onEvent(observe)
    const resumedReattachment = await scope.perform(async () => await client.reattachAgent(resumed.agentSessionId, 0))
    output += resumedReattachment.attachment.replay.map((event) => event.data).join('')
    const resumedReconnectedStatus = await scope.perform(async () => await client.statusAgent(resumed.agentSessionId))
    expect(resumedReconnectedStatus.run.runId).toBe(resumedConnectedStatus.run.runId)
    expect(resumedReconnectedStatus.run.pid).toBe(resumedConnectedStatus.run.pid)
    expect(client.agentSession(resumed.agentSessionId)).toMatchObject({
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeSessionId }
    })
    expect(output).toContain('AGENTMUX_REAL_CODEX_RESUMED')
    const resumedPromptAcceptedInputBytes = 5
    const resumedPreExit = await scope.perform(async () => await client.statusAgent(resumed.agentSessionId))
    expect(resumedPreExit.run.acceptedInputBytes).toBe(resumedPromptAcceptedInputBytes)
    await scope.perform(async () => await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(resumed.agentSessionId)),
      agentSessionId: resumed.agentSessionId,
      operationId: `real-codex-resumed-exit-${invocationId}`,
      prompt: '/exit'
    }))
    const resumedExpectedInputBytes = resumedPromptAcceptedInputBytes + Buffer.byteLength('/exit\r')
    const resumedExit = await waitFor(scope, 'real Codex resumed Run terminal receipt', async () => {
      const status = await scope.perform(async () => await client.statusAgent(resumed.agentSessionId))
      return status.run.state === 'exited' &&
        status.run.acceptedInputBytes === resumedExpectedInputBytes
        ? status
        : null
    })
    expect(resumedExit!.run.exitCode).toBe(0)
    expect(resumedExit!.run.exitSignal).toBeUndefined()
    const resumedSubmission = await assertExitedAdmission(scope, store, resumed.agentSessionId, resumed.run,
      `real-codex-resumed-exit-${invocationId}`, provider.planPromptInput('/exit'), 5)
    expect(resumedSubmission).toMatchObject({
      readinessEvidence: { source: 'native-stop', id: resumedReadiness?.id, outputCursorBytes: resumedReadiness?.outputCursorBytes, readyThroughByte: resumedReadiness?.readyThroughByte },
      payload: { acknowledged: true },
      submit: { acknowledged: true }
    })
    await scope.perform(async () => await client.releaseRunAttachment(resumed.run))
    const resumedExitReplay = await scope.perform(async () => await client.reattachAgent(
      resumed.agentSessionId,
      resumedPreExit.run.latestOutputBytes
    ))
    expect(resumedExitReplay.attachment.replay.map((event) => event.data).join('')).toContain('/exit')
    await scope.perform(async () => await client.stopAgent(resumed.agentSessionId, resumed.run))
    expect(client.agentSessions()).toEqual([])
    await scope.dispose(client)
    await scope.perform(async () => await installer.uninstall(hookReceipt))
  }, 180_000)
})
