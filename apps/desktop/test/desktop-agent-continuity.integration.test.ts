import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

vi.mock('../src/renderer/src/components/TerminalView.js', () => ({
  TerminalView: () => createElement('div', { 'data-test-view': 'terminal' })
}))

import {
  connectLocalAgentMux,
  AgentMuxFileAgentSessionStore
} from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { AppConfig, RuntimeEvent, SessionControl } from '../src/shared/contracts.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { SessionPane } from '../src/renderer/src/components/SessionPane.js'

const execFileAsync = promisify(execFile)
const fakeCodexFixture = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/fake-codex-cli.mjs', import.meta.url)
)
const ctxmuxDaemon = fileURLToPath(
  new URL('../../../packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)
)

const roots: string[] = []
const runtimeDirectories: string[] = []
const originalRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY
let activeRuntime: RuntimeController | undefined
let activeSessionControl: SessionControl | undefined
let activePid: number | undefined

function createFakeWebContents(id: number) {
  const listeners = new Map<string, Set<Function>>()
  const sentEvents: Array<{ channel: string; args: any[] }> = []
  let destroyed = false

  return {
    id,
    isDestroyed: () => destroyed,
    send: (channel: string, ...args: any[]) => {
      sentEvents.push({ channel, args })
    },
    on: (event: string, fn: Function) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    },
    off: (event: string, fn: Function) => {
      listeners.get(event)?.delete(fn)
    },
    emit: (event: string, ...args: any[]) => {
      if (event === 'destroyed' || event === 'render-process-gone') destroyed = true
      for (const fn of [...(listeners.get(event) ?? [])]) {
        fn(...args)
      }
    },
    sentEvents
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function waitFor<T>(
  description: string,
  predicate: () => T | Promise<T>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function stopOwnedTestDaemon(runtimeDirectory: string): Promise<void> {
  const processes = await execFileAsync('ps', ['-axo', 'pid=,command='], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const socketPath = join(runtimeDirectory, 'ctxmux.sock')
  const stateDir = join(runtimeDirectory, 'state')
  const pids = processes.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (!match) return []
    const command = match[2]!
    return command.includes(ctxmuxDaemon) &&
      command.includes(`--socket ${socketPath}`) &&
      command.includes(`--state-dir ${stateDir}`)
      ? [Number(match[1])]
      : []
  })
  if (pids.length > 1) throw new Error('Multiple CtxMux daemons occupy the isolated test runtime.')
  const pid = pids[0]
  if (pid === undefined) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
  const deadline = Date.now() + 5_000
  let stopped = false
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      stopped = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (!stopped) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
    await waitFor(`daemon ${pid} kill`, () => !isProcessAlive(pid), 3_000)
  }
}

afterEach(async () => {
  const cleanupErrors: unknown[] = []
  if (activeSessionControl && activeRuntime) {
    try {
      await activeRuntime.stopSession(activeSessionControl)
    } catch (error) {
      cleanupErrors.push(error)
    }
    activeSessionControl = undefined
  }
  if (activePid !== undefined) {
    try {
      await waitFor(`child process ${activePid} exit`, () => !isProcessAlive(activePid!), 5_000)
    } catch (error) {
      try {
        process.kill(activePid, 'SIGKILL')
        await waitFor(`child process ${activePid} kill`, () => !isProcessAlive(activePid!), 3_000)
      } catch (killError) {
        cleanupErrors.push(new AggregateError([error, killError], `Failed to kill child process ${activePid}`))
      }
    }
    activePid = undefined
  }
  if (activeRuntime) {
    try {
      await activeRuntime.dispose()
    } catch (error) {
      cleanupErrors.push(error)
    }
    activeRuntime = undefined
  }
  if (originalRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
  else process.env.AGENTMUX_RUNTIME_DIRECTORY = originalRuntimeDirectory

  for (const runtimeDirectory of runtimeDirectories.splice(0)) {
    try {
      await stopOwnedTestDaemon(runtimeDirectory)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Desktop agent continuity test cleanup failed.')
  }
})

describe('Desktop and Renderer Agent exact run continuity integration', () => {
  it('preserves exact Run attachment, replay, live I/O, and suppresses recovery overlay across Renderer reload and Desktop restart without provider handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-desktop-continuity-'))
    roots.push(root)
    const runtimeDirectory = join(root, 'runtime')
    runtimeDirectories.push(runtimeDirectory)
    process.env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDirectory
    const sessionStorePath = join(root, 'agent-sessions.json')
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true, mode: 0o700 })

    const config: AppConfig = {
      version: 7,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      executors: {
        codex: {
          label: 'Fake Codex',
          providerId: 'codex',
          command: process.execPath,
          args: [fakeCodexFixture],
          env: {
            AGENTMUX_FAKE_READY_MODE: 'no-stop',
            AGENTMUX_FAKE_PROMPT_RENDER_MODE: 'normal',
            AGENTMUX_FAKE_OMIT_HANDLE: '1'
          },
          injectAgentMuxGuide: false
        }
      },
      workspaces: [{ id: 'workspace', name: 'Test Workspace', hostId: 'local', path: workspace, kind: 'folder' }],
      appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
    }

    const store1 = new AgentMuxFileAgentSessionStore(sessionStorePath)
    const runtime1 = new RuntimeController(store1)
    runtime1.commit(await runtime1.prepare(config))
    activeRuntime = runtime1

    const webContents1 = createFakeWebContents(1)
    const detachClient1 = runtime1.attach(webContents1 as any)

    // Launch long-running agent with valid prompt option and no native handle published
    const launched = await runtime1.launchAgent({
      hostId: 'local',
      workspacePath: workspace,
      executorId: 'codex',
      prompt: 'initial-task'
    }, config)

    const initialSessionId = launched.session.id
    const initialRunId = launched.session.control.run.runId
    activeSessionControl = launched.session.control

    expect(initialSessionId).toBeTruthy()
    expect(initialRunId).toBeTruthy()

    // Establish attachment 1 from webContents 1
    const initialAttachment = await runtime1.attachSession(webContents1.id, launched.session.control, 0, config)
    expect(initialAttachment.session.id).toBe(initialSessionId)
    expect(initialAttachment.session.control.run.runId).toBe(initialRunId)
    expect(initialAttachment.session.processState).toBe('running')

    const directClient1 = await connectLocalAgentMux({ store: store1 })
    // Directly verify the session has NO native handle on Core AgentSession
    expect(directClient1.agentSession(initialSessionId).nativeHandle).toBeUndefined()
    const initialDaemonInstanceId = directClient1.runtimeIdentity().instanceId
    expect(initialDaemonInstanceId).toBeTruthy()

    const runs1 = await directClient1.listRuns()
    expect(runs1).toHaveLength(1)
    expect(runs1[0].runId).toBe(initialRunId)
    const initialPid = runs1[0].pid
    expect(initialPid).toBeTypeOf('number')
    activePid = initialPid
    await directClient1.dispose()

    // Wait for initial prompt ready output from fake codex
    await waitFor('initial prompt ready frame', async () => {
      const snap = await runtime1.snapshot(config)
      const s = snap.sessions.find((item) => item.id === initialSessionId)
      return s?.latestOutputBytes && s.latestOutputBytes > 0
    })

    // ---------------------------------------------------------------------------------------------
    // 1. Verify Ordinary Renderer Reload:
    // WebContents navigates/reloads (isDestroyed is false).
    // Before reload, exactly 1 owner and 1 lease are held.
    // did-start-navigation triggers release of old generation attachment lease (0 owners, 0 leases).
    // Reloaded page on the SAME webContents connects, takes snapshot, renders View without recovery overlay,
    // and establishes an exact reattachment (1 owner, 1 lease) to the running live agent without native handle.
    // ---------------------------------------------------------------------------------------------
    expect(runtime1.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 1,
      sessionAttachmentLeases: 1
    })

    webContents1.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(webContents1.isDestroyed()).toBe(false)

    await waitFor('session attachment lease and owner release on navigation', () => {
      const counts = runtime1.resourceOwnerCounts()
      return counts.sessionAttachmentOwners === 0 && counts.sessionAttachmentLeases === 0
    })

    const reloadSnapshot = await runtime1.snapshot(config)
    expect(reloadSnapshot.recoveryCandidates).toEqual([])
    const reloadSession = reloadSnapshot.sessions.find((s) => s.id === initialSessionId)
    expect(reloadSession).toBeDefined()
    expect(reloadSession?.processState).toBe('running')
    expect(reloadSession?.status.state).toBe('running')
    expect(reloadSession?.control.run.runId).toBe(initialRunId)

    const directClientReload = await connectLocalAgentMux({ store: store1 })
    expect(directClientReload.agentSession(initialSessionId).nativeHandle).toBeUndefined()
    expect(directClientReload.runtimeIdentity().instanceId).toBe(initialDaemonInstanceId)
    const runsReload = await directClientReload.listRuns()
    expect(runsReload).toHaveLength(1)
    expect(runsReload[0].runId).toBe(initialRunId)
    expect(runsReload[0].pid).toBe(initialPid)
    await directClientReload.dispose()

    // Render SessionPane with the restored session in the renderer store
    useAppStore.setState({
      sessions: reloadSnapshot.sessions,
      timelines: reloadSnapshot.timelines,
      config,
      viewModes: { [initialSessionId]: 'terminal' }
    })
    const markupAfterReload = renderToStaticMarkup(createElement(SessionPane, {
      sessionId: initialSessionId,
      surfaceKind: 'agent',
      interactiveResize: false,
      linkOrigin: { type: 'standalone' }
    }))
    expect(markupAfterReload).not.toContain('terminal-recovery')
    expect(markupAfterReload).not.toContain('Agent resume unavailable')
    expect(markupAfterReload).not.toContain('verified Provider handle')

    // Attach to the running session from the reloaded view on webContents1
    const reloadedAttachment = await runtime1.attachSession(webContents1.id, reloadSession!.control, 0, config)
    expect(reloadedAttachment.session.id).toBe(initialSessionId)
    expect(reloadedAttachment.session.control.run.runId).toBe(initialRunId)
    expect(reloadedAttachment.session.processState).toBe('running')
    expect(runtime1.resourceOwnerCounts()).toEqual({
      sessionAttachmentOwners: 1,
      sessionAttachmentLeases: 1
    })

    const reloadedReplayText = reloadedAttachment.replay
      .map((frame) => ('data' in frame ? frame.data : ''))
      .join('')
    expect(reloadedReplayText).toContain('codex-ready:')
    expect(reloadedReplayText).toContain('codex-composer-ready-frame')

    // Send input from reloaded view and verify accumulated live streaming output reaches webContents 1
    webContents1.sentEvents.length = 0
    const reloadInput = 'step-after-reload'
    await runtime1.write(reloadSession!.control, reloadInput)

    const expectedReloadComposerMarker = `codex-composer-rendered:${Buffer.byteLength(reloadInput)}`
    await waitFor('composer rendered on reloaded WebContents', () => {
      const accumulatedOutput = webContents1.sentEvents
        .filter((msg) => {
          if (msg.channel !== 'agentmux:session-event') return false
          const event = msg.args[0] as RuntimeEvent
          return (
            event.type === 'core' &&
            event.event.type === 'terminal-output' &&
            event.event.run.runId === initialRunId
          )
        })
        .map((msg) => (msg.args[0] as RuntimeEvent & { type: 'core'; event: { type: 'terminal-output'; data: string } }).event.data)
        .join('')
      return accumulatedOutput.includes(expectedReloadComposerMarker)
    })

    // Submit the composer turn and wait for accepted submission
    await runtime1.write(reloadSession!.control, '\r')
    const expectedReloadSubmitMarker = `codex-submit:${reloadInput}:accepted`
    await waitFor('submission accepted on reloaded WebContents', () => {
      const accumulatedOutput = webContents1.sentEvents
        .filter((msg) => {
          if (msg.channel !== 'agentmux:session-event') return false
          const event = msg.args[0] as RuntimeEvent
          return (
            event.type === 'core' &&
            event.event.type === 'terminal-output' &&
            event.event.run.runId === initialRunId
          )
        })
        .map((msg) => (msg.args[0] as RuntimeEvent & { type: 'core'; event: { type: 'terminal-output'; data: string } }).event.data)
        .join('')
      return accumulatedOutput.includes(expectedReloadSubmitMarker)
    })

    // ---------------------------------------------------------------------------------------------
    // 2. Verify Desktop Restart:
    // Dispose runtime1, leaving ctxmux daemon and running PTY child intact.
    // Create new RuntimeController2 with the same session store and connect to the daemon.
    // Snapshot reflects running session, daemonInstanceId/runId/PID match,
    // exact reattachment succeeds with full replay, live I/O works, and clean exit occurs.
    // ---------------------------------------------------------------------------------------------
    await runtime1.detachSession(webContents1.id, reloadedAttachment.attachmentId)
    detachClient1()
    await runtime1.dispose()
    activeRuntime = undefined

    const store2 = new AgentMuxFileAgentSessionStore(sessionStorePath)
    const runtime2 = new RuntimeController(store2)
    runtime2.commit(await runtime2.prepare(config))
    activeRuntime = runtime2

    const webContents2 = createFakeWebContents(2)
    const detachClient2 = runtime2.attach(webContents2 as any)

    const restartSnapshot = await runtime2.snapshot(config)
    expect(restartSnapshot.recoveryCandidates).toEqual([])
    const restartSession = restartSnapshot.sessions.find((s) => s.id === initialSessionId)
    expect(restartSession).toBeDefined()
    expect(restartSession?.processState).toBe('running')
    expect(restartSession?.status.state).toBe('running')
    expect(restartSession?.control.run.runId).toBe(initialRunId)
    activeSessionControl = restartSession!.control

    const directClientRestart = await connectLocalAgentMux({ store: store2 })
    expect(directClientRestart.agentSession(initialSessionId).nativeHandle).toBeUndefined()
    expect(directClientRestart.runtimeIdentity().instanceId).toBe(initialDaemonInstanceId)
    const runsRestart = await directClientRestart.listRuns()
    expect(runsRestart).toHaveLength(1)
    expect(runsRestart[0].runId).toBe(initialRunId)
    expect(runsRestart[0].pid).toBe(initialPid)
    await directClientRestart.dispose()

    // Render SessionPane after Desktop restart
    useAppStore.setState({
      sessions: restartSnapshot.sessions,
      timelines: restartSnapshot.timelines,
      config,
      viewModes: { [initialSessionId]: 'terminal' }
    })
    const markupAfterRestart = renderToStaticMarkup(createElement(SessionPane, {
      sessionId: initialSessionId,
      surfaceKind: 'agent',
      interactiveResize: false,
      linkOrigin: { type: 'standalone' }
    }))
    expect(markupAfterRestart).not.toContain('terminal-recovery')
    expect(markupAfterRestart).not.toContain('Agent resume unavailable')
    expect(markupAfterRestart).not.toContain('verified Provider handle')

    // Attach to the session in the new Desktop process
    const restartedAttachment = await runtime2.attachSession(webContents2.id, restartSession!.control, 0, config)
    expect(restartedAttachment.session.id).toBe(initialSessionId)
    expect(restartedAttachment.session.control.run.runId).toBe(initialRunId)
    expect(restartedAttachment.session.processState).toBe('running')

    const restartedReplayText = restartedAttachment.replay
      .map((frame) => ('data' in frame ? frame.data : ''))
      .join('')
    expect(restartedReplayText).toContain('codex-ready:')
    expect(restartedReplayText).toContain('codex-composer-ready-frame')

    // Send input from restarted Desktop and verify accumulated live streaming output reaches webContents 2
    webContents2.sentEvents.length = 0
    const restartInput = 'step-after-restart-distinct-unique'
    await runtime2.write(restartSession!.control, restartInput)

    const expectedRestartComposerMarker = `codex-composer-rendered:${Buffer.byteLength(restartInput)}`
    await waitFor('composer rendered on restarted WebContents', () => {
      const accumulatedOutput = webContents2.sentEvents
        .filter((msg) => {
          if (msg.channel !== 'agentmux:session-event') return false
          const event = msg.args[0] as RuntimeEvent
          return (
            event.type === 'core' &&
            event.event.type === 'terminal-output' &&
            event.event.run.runId === initialRunId
          )
        })
        .map((msg) => (msg.args[0] as RuntimeEvent & { type: 'core'; event: { type: 'terminal-output'; data: string } }).event.data)
        .join('')
      return accumulatedOutput.includes(expectedRestartComposerMarker)
    })

    // Submit the composer turn on restarted view and wait for accepted submission
    await runtime2.write(restartSession!.control, '\r')
    const expectedRestartSubmitMarker = `codex-submit:${restartInput}:accepted`
    await waitFor('submission accepted on restarted WebContents', () => {
      const accumulatedOutput = webContents2.sentEvents
        .filter((msg) => {
          if (msg.channel !== 'agentmux:session-event') return false
          const event = msg.args[0] as RuntimeEvent
          return (
            event.type === 'core' &&
            event.event.type === 'terminal-output' &&
            event.event.run.runId === initialRunId
          )
        })
        .map((msg) => (msg.args[0] as RuntimeEvent & { type: 'core'; event: { type: 'terminal-output'; data: string } }).event.data)
        .join('')
      return accumulatedOutput.includes(expectedRestartSubmitMarker)
    })

    // Cleanly stop session via Core exact control
    await runtime2.stopSession(restartSession!.control)
    activeSessionControl = undefined

    // Wait for child process PID to exit
    await waitFor('child process PID exit', () => !isProcessAlive(initialPid), 5_000)
    activePid = undefined

    await runtime2.detachSession(webContents2.id, restartedAttachment.attachmentId)
    detachClient2()
    await runtime2.dispose()
    activeRuntime = undefined
  }, 30_000)
})
