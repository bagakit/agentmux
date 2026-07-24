import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentManagedHookInstaller,
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux,
  createCodexManagedHookPlan,
  type AgentMuxClientEvent
} from '../dist/index.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const runtimeDirectories: string[] = []
const createdCodexSessions: Array<{ command: string; sessionId: string; cwd: string }> = []
const activeAgentSessions: Array<{ store: AgentMuxFileAgentSessionStore; agentSessionId: string }> = []
const originalRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY
const ctxmuxDaemon = fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url))

async function stopOwnedTestDaemon(runtimeDirectory: string): Promise<void> {
  const processes = await execFileAsync('ps', ['-axo', 'pid=,command='], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const pids = processes.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (!match) return []
    const command = match[2]!
    return command.includes(ctxmuxDaemon) &&
      command.includes(`--socket ${join(runtimeDirectory, 'ctxmux.sock')}`) &&
      command.includes(`--state-dir ${join(runtimeDirectory, 'state')}`)
      ? [Number(match[1])]
      : []
  })
  if (pids.length > 1) throw new Error('Multiple CtxMux daemons occupy the isolated real Codex runtime.')
  const pid = pids[0]
  if (pid === undefined) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Isolated real Codex CtxMux daemon ${pid} did not stop.`)
}

afterEach(async () => {
  const cleanupErrors: unknown[] = []
  const cleanupClients: Array<Awaited<ReturnType<typeof connectLocalAgentMux>>> = []
  for (const active of activeAgentSessions.splice(0)) {
    try {
      const client = await connectLocalAgentMux({ store: active.store })
      if (client.agentSessions().some((session) => session.agentSessionId === active.agentSessionId)) {
        await client.stopAgent(active.agentSessionId)
      }
      cleanupClients.push(client)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  for (const session of createdCodexSessions.splice(0)) {
    try {
      await execFileAsync(session.command, ['delete', '--force', session.sessionId], {
        cwd: session.cwd,
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  for (const client of cleanupClients) {
    try {
      await client.dispose()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  for (const runtimeDirectory of runtimeDirectories.splice(0)) {
    try {
      await stopOwnedTestDaemon(runtimeDirectory)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (originalRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
  else process.env.AGENTMUX_RUNTIME_DIRECTORY = originalRuntimeDirectory
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Real Codex E2E session cleanup failed.')
})

async function waitFor<T>(
  description: string,
  predicate: () => T | Promise<T>,
  timeoutMs = 120_000,
  diagnose?: () => unknown
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const result = await predicate()
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
    const [version, auth] = await Promise.all([
      execFileAsync(command, ['--version'], { timeout: 5_000, maxBuffer: 64 * 1024 }),
      execFileAsync(command, ['login', 'status'], { timeout: 10_000, maxBuffer: 64 * 1024 })
    ])
    const authStatus = `${auth.stdout}${auth.stderr}`.trim()
    if (!/^codex-cli 0\./u.test(version.stdout.trim()) || !authStatus.includes('Logged in')) {
      throw new Error(
        `REAL_CODEX_E2E_UNAVAILABLE: executable=${command} version=${version.stdout.trim()} auth=${authStatus}`
      )
    }

    const root = await mkdtemp('/private/tmp/agentmux-real-codex-')
    roots.push(root)
    const runtimeDirectory = join(root, 'runtime')
    runtimeDirectories.push(runtimeDirectory)
    process.env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDirectory
    const invocationId = root.slice(root.lastIndexOf('-') + 1)
    const agentSessionId = `real-codex-${invocationId}`
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { mode: 0o700 })
    await execFileAsync('git', ['init', '--quiet', workspace], { timeout: 5_000, maxBuffer: 64 * 1024 })
    const installer = new AgentManagedHookInstaller(join(root, 'hook-state'))
    const preview = await installer.preview(createCodexManagedHookPlan(workspace))
    const hookReceipt = await installer.install(preview.id)
    const trustOverride = `projects={${JSON.stringify(workspace)}={trust_level="trusted"}}`
    const codexArgs = [
      '--dangerously-bypass-hook-trust',
      '--no-alt-screen',
      '--ask-for-approval', 'never',
      '--sandbox', 'read-only',
      '--config', 'model_reasoning_effort="low"',
      '--config', trustOverride
    ]
    const store = new AgentMuxFileAgentSessionStore(join(root, 'agent-sessions.json'))
    activeAgentSessions.push({ store, agentSessionId })
    let client = await connectLocalAgentMux({ store })
    let output = ''
    const assistantMarkers = new Set<string>()
    const observe = (event: AgentMuxClientEvent): void => {
      if (event.type === 'terminal-output') output += event.data ?? ''
      if (event.type === 'agent-activity' && event.activity.kind === 'assistant') {
        assistantMarkers.add(event.activity.content ?? '')
      }
    }
    client.onEvent(observe)
    const created = await client.createAgent({
      agentSessionId,
      createOperationId: `real-codex-create-${invocationId}`,
      agentId: 'codex',
      workspacePath: workspace,
      commandOverride: command,
      args: codexArgs,
      prompt: 'Reply with exactly AGENTMUX_REAL_CODEX_READY and do not use tools.'
    })
    expect(created.terminalHandshake).toMatchObject({
      run: { runId: created.run.runId },
      inputByteRange: { startByte: 0, endByte: 5 },
      acknowledged: true
    })
    const firstAttachment = await client.reattachAgent(created.agentSessionId, 0)
    output += firstAttachment.attachment.replay.map((event) => event.data).join('')
    expect(output).toContain('\u001b[?u')
    const nativeSessionId = await waitFor('real Codex SessionStart hook', () => {
      const session = client.agentSession(created.agentSessionId)
      return session.nativeHandle?.kind === 'provider' &&
        session.hookReceipt?.eventName === 'SessionStart' &&
        session.hookReceipt.run.runId === created.run.runId
        ? session.nativeHandle.sessionId
        : ''
    })
    createdCodexSessions.push({ command, sessionId: nativeSessionId, cwd: root })
    await waitFor('real Codex initial completed response', () => {
      const session = client.agentSession(created.agentSessionId)
      return output.includes('AGENTMUX_REAL_CODEX_READY') &&
        [...assistantMarkers].some((content) => content.includes('AGENTMUX_REAL_CODEX_READY')) &&
        session.hookReceipt?.eventName === 'Stop' &&
        session.hookReceipt.run.runId === created.run.runId &&
        session.terminalStopReceipt?.id === session.hookReceipt.id &&
        session.terminalStopReceipt.readyThroughByte !== undefined
    }, 120_000, () => {
      const session = client.agentSession(created.agentSessionId)
      return {
        outputTail: output.slice(-8 * 1024),
        assistantMarkers: [...assistantMarkers].slice(-8).map((value) => value.slice(-1024)),
        nativeHandle: session.nativeHandle ?? null,
        hookReceipt: session.hookReceipt ?? null,
        terminalStopReceipt: session.terminalStopReceipt ?? null
      }
    })
    const initialReadyStop = client.agentSession(created.agentSessionId).terminalStopReceipt
    expect(initialReadyStop?.readyThroughByte).toBeGreaterThanOrEqual(
      initialReadyStop?.outputCursorBytes ?? Number.MAX_SAFE_INTEGER
    )
    const firstStatus = await client.statusAgent(created.agentSessionId)
    await client.dispose()

    client = await connectLocalAgentMux({ store })
    output = ''
    client.onEvent(observe)
    const reattached = await client.reattachAgent(created.agentSessionId, 0)
    output += reattached.attachment.replay.map((event) => event.data).join('')
    const reconnectedStatus = await client.statusAgent(created.agentSessionId)
    expect(reconnectedStatus.run.runId).toBe(firstStatus.run.runId)
    expect(reconnectedStatus.run.pid).toBe(firstStatus.run.pid)
    expect(output).toContain('AGENTMUX_REAL_CODEX_READY')
    const firstPreExit = await client.statusAgent(created.agentSessionId)
    expect(firstPreExit.run.acceptedInputBytes).toBe(5)
    await client.submitAgentPrompt({
      agentSessionId: created.agentSessionId,
      operationId: `real-codex-exit-${invocationId}`,
      prompt: '/exit'
    })
    const firstExit = await waitFor('real Codex initial Run terminal receipt', async () => {
      const status = await client.statusAgent(created.agentSessionId)
      return status.run.state === 'exited' &&
        status.run.acceptedInputBytes === 11
        ? status
        : null
    })
    expect(firstExit!.run.exitCode).toBe(0)
    expect(firstExit!.run.exitSignal).toBeUndefined()
    expect(client.agentSession(created.agentSessionId).terminalPromptSubmission).toMatchObject({
      stopReceiptId: initialReadyStop?.id,
      stopOutputCursorBytes: initialReadyStop?.outputCursorBytes,
      readyThroughByte: initialReadyStop?.readyThroughByte,
      payload: { acknowledged: true },
      submit: { acknowledged: true }
    })
    await client.releaseRunAttachment(created.run)
    const firstExitReplay = await client.reattachAgent(
      created.agentSessionId,
      firstPreExit.run.latestOutputBytes
    )
    expect(firstExitReplay.attachment.replay.map((event) => event.data).join('')).toContain('/exit')
    await client.dispose()

    client = await connectLocalAgentMux({ store })
    output = ''
    client.onEvent(observe)
    const resumedPrompt = 'Reply with exactly AGENTMUX_REAL_CODEX_RESUMED and do not use tools.'
    const resumed = await client.resumeAgent({
      agentSessionId: created.agentSessionId,
      operationId: `real-codex-resume-${invocationId}`,
      prompt: resumedPrompt,
      args: codexArgs,
      commandOverride: command
    })
    expect(resumed.agentSessionId).toBe(created.agentSessionId)
    expect(resumed.run.runId).not.toBe(created.run.runId)
    expect(resumed.hookBindingId).not.toBe(created.hookBindingId)
    expect(resumed.terminalHandshake).toMatchObject({
      run: { runId: resumed.run.runId },
      inputByteRange: { startByte: 0, endByte: 5 },
      acknowledged: true
    })
    const resumedAttachment = await client.reattachAgent(resumed.agentSessionId, 0)
    output += resumedAttachment.attachment.replay.map((event) => event.data).join('')
    expect(output).toContain('\u001b[?u')
    expect(client.agentSession(resumed.agentSessionId).nativeHandle).toMatchObject({
      kind: 'provider', providerId: 'codex', sessionId: nativeSessionId
    })
    await waitFor('real Codex resumed completed response', () => {
      const session = client.agentSession(resumed.agentSessionId)
      return output.includes('AGENTMUX_REAL_CODEX_RESUMED') &&
        [...assistantMarkers].some((content) => content.includes('AGENTMUX_REAL_CODEX_RESUMED')) &&
        session.hookReceipt?.eventName === 'Stop' &&
        session.hookReceipt.run.runId === resumed.run.runId &&
        session.hookBindingId === resumed.hookBindingId &&
        session.terminalStopReceipt?.id === session.hookReceipt.id &&
        session.terminalStopReceipt.readyThroughByte !== undefined
    }, 120_000, () => {
      const session = client.agentSession(resumed.agentSessionId)
      return {
        outputTail: output.slice(-8 * 1024),
        assistantMarkers: [...assistantMarkers].slice(-8).map((value) => value.slice(-1024)),
        nativeHandle: session.nativeHandle ?? null,
        hookReceipt: session.hookReceipt ?? null,
        terminalStopReceipt: session.terminalStopReceipt ?? null
      }
    })
    const resumedReadyStop = client.agentSession(resumed.agentSessionId).terminalStopReceipt
    const resumedConnectedStatus = await client.statusAgent(resumed.agentSessionId)
    await client.dispose()

    client = await connectLocalAgentMux({ store })
    output = ''
    client.onEvent(observe)
    const resumedReattachment = await client.reattachAgent(resumed.agentSessionId, 0)
    output += resumedReattachment.attachment.replay.map((event) => event.data).join('')
    const resumedReconnectedStatus = await client.statusAgent(resumed.agentSessionId)
    expect(resumedReconnectedStatus.run.runId).toBe(resumedConnectedStatus.run.runId)
    expect(resumedReconnectedStatus.run.pid).toBe(resumedConnectedStatus.run.pid)
    expect(client.agentSession(resumed.agentSessionId)).toMatchObject({
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeSessionId },
      hookBindingId: resumed.hookBindingId
    })
    expect(output).toContain('AGENTMUX_REAL_CODEX_RESUMED')
    const resumedPromptAcceptedInputBytes = 5
    const resumedPreExit = await client.statusAgent(resumed.agentSessionId)
    expect(resumedPreExit.run.acceptedInputBytes).toBe(resumedPromptAcceptedInputBytes)
    await client.submitAgentPrompt({
      agentSessionId: resumed.agentSessionId,
      operationId: `real-codex-resumed-exit-${invocationId}`,
      prompt: '/exit'
    })
    const resumedExpectedInputBytes = resumedPromptAcceptedInputBytes + Buffer.byteLength('/exit\r')
    const resumedExit = await waitFor('real Codex resumed Run terminal receipt', async () => {
      const status = await client.statusAgent(resumed.agentSessionId)
      return status.run.state === 'exited' &&
        status.run.acceptedInputBytes === resumedExpectedInputBytes
        ? status
        : null
    })
    expect(resumedExit!.run.exitCode).toBe(0)
    expect(resumedExit!.run.exitSignal).toBeUndefined()
    expect(client.agentSession(resumed.agentSessionId).terminalPromptSubmission).toMatchObject({
      stopReceiptId: resumedReadyStop?.id,
      stopOutputCursorBytes: resumedReadyStop?.outputCursorBytes,
      readyThroughByte: resumedReadyStop?.readyThroughByte,
      payload: { acknowledged: true },
      submit: { acknowledged: true }
    })
    await client.releaseRunAttachment(resumed.run)
    const resumedExitReplay = await client.reattachAgent(
      resumed.agentSessionId,
      resumedPreExit.run.latestOutputBytes
    )
    expect(resumedExitReplay.attachment.replay.map((event) => event.data).join('')).toContain('/exit')
    await client.stopAgent(resumed.agentSessionId)
    activeAgentSessions.splice(0)
    expect(client.agentSessions()).toEqual([])
    await client.dispose()
    await installer.uninstall(hookReceipt)
  }, 180_000)
})
