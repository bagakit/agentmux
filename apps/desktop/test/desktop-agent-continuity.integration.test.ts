import { spawn, execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  AgentMuxFileAgentSessionStore,
  type AgentMuxClientEvent
} from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { AppConfig, SessionSnapshot, WorkbenchTab } from '../src/shared/contracts.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { SessionPane } from '../src/renderer/src/components/SessionPane.js'

const execFileAsync = promisify(execFile)
const fakeCodexFixture = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/fake-codex-cli.mjs', import.meta.url)
)

const roots: string[] = []
const runtimeDirectories: string[] = []
const originalRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY

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

afterEach(async () => {
  if (originalRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
  else process.env.AGENTMUX_RUNTIME_DIRECTORY = originalRuntimeDirectory
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('Desktop and Renderer Agent exact run continuity integration', () => {
  it('preserves exact Run attachment, replay, live I/O, and suppresses recovery overlay across Renderer reload and Desktop restart', async () => {
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
          env: { AGENTMUX_FAKE_READY_MODE: 'before' },
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

    const launched = await runtime1.launchAgent({
      hostId: 'local',
      workspacePath: workspace,
      executorId: 'codex',
      initialPrompt: 'initial-task'
    }, config)

    const initialSessionId = launched.session.id
    const initialRunId = launched.session.control.run.runId

    expect(initialSessionId).toBeTruthy()
    expect(initialRunId).toBeTruthy()

    const initialAttachment = await runtime1.attachSession(1, launched.session.control, 0, config)
    expect(initialAttachment.session.id).toBe(initialSessionId)
    expect(initialAttachment.session.control.run.runId).toBe(initialRunId)
    expect(initialAttachment.session.processState).toBe('running')

    const directClient1 = await connectLocalAgentMux({ store: store1 })
    const runs1 = await directClient1.listRuns()
    expect(runs1).toHaveLength(1)
    expect(runs1[0].runId).toBe(initialRunId)
    const initialPid = runs1[0].pid
    expect(initialPid).toBeTypeOf('number')
    await directClient1.dispose()

    // Verify initial output / handshake
    await waitFor('initial prompt ready frame', async () => {
      const snap = await runtime1.snapshot(config)
      const s = snap.sessions.find((item) => item.id === initialSessionId)
      return s?.latestOutputBytes && s.latestOutputBytes > 0
    })

    // ---------------------------------------------------------------------------------------------
    // 1. Verify Renderer Reload:
    // Snapshot reflects running session without any recovery candidate.
    // Restoring Workbench View directly mounts TerminalView and exact-attaches to the running Run.
    // ---------------------------------------------------------------------------------------------
    const reloadSnapshot = await runtime1.snapshot(config)
    expect(reloadSnapshot.recoveryCandidates).toEqual([])
    const reloadSession = reloadSnapshot.sessions.find((s) => s.id === initialSessionId)
    expect(reloadSession).toBeDefined()
    expect(reloadSession?.processState).toBe('running')
    expect(reloadSession?.status.state).toBe('running')
    expect(reloadSession?.control.run.runId).toBe(initialRunId)

    const directClientReload = await connectLocalAgentMux({ store: store1 })
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

    // Attach to the running session from the reloaded view
    const reloadedAttachment = await runtime1.attachSession(2, reloadSession!.control, 0, config)
    expect(reloadedAttachment.session.id).toBe(initialSessionId)
    expect(reloadedAttachment.session.control.run.runId).toBe(initialRunId)
    expect(reloadedAttachment.session.processState).toBe('running')

    // Send input from reloaded view and verify response
    await runtime1.write(reloadSession!.control, 'continue\r')
    await waitFor('Fake codex accepts continued prompt after reload', async () => {
      const snap = await runtime1.snapshot(config)
      const s = snap.sessions.find((item) => item.id === initialSessionId)
      return s && s.latestOutputBytes > (reloadSession?.latestOutputBytes ?? 0)
    })

    // ---------------------------------------------------------------------------------------------
    // 2. Verify Desktop Restart:
    // Dispose runtime1, leaving ctxmux daemon and running PTY child intact.
    // Create new RuntimeController2 with the same session store and connect to the daemon.
    // Snapshot reflects running session, exact reattachment succeeds with same runId and PID.
    // ---------------------------------------------------------------------------------------------
    await runtime1.dispose()

    const store2 = new AgentMuxFileAgentSessionStore(sessionStorePath)
    const runtime2 = new RuntimeController(store2)
    runtime2.commit(await runtime2.prepare(config))

    const restartSnapshot = await runtime2.snapshot(config)
    expect(restartSnapshot.recoveryCandidates).toEqual([])
    const restartSession = restartSnapshot.sessions.find((s) => s.id === initialSessionId)
    expect(restartSession).toBeDefined()
    expect(restartSession?.processState).toBe('running')
    expect(restartSession?.status.state).toBe('running')
    expect(restartSession?.control.run.runId).toBe(initialRunId)

    const directClientRestart = await connectLocalAgentMux({ store: store2 })
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

    // Attach to the running session from the restarted Desktop instance
    const restartedAttachment = await runtime2.attachSession(3, restartSession!.control, 0, config)
    expect(restartedAttachment.session.id).toBe(initialSessionId)
    expect(restartedAttachment.session.control.run.runId).toBe(initialRunId)
    expect(restartedAttachment.session.processState).toBe('running')

    // Verify full replay is preserved across restart
    const fullReplayText = restartedAttachment.replay.map((c) => c.data).join('')
    expect(fullReplayText).toContain('codex-ready:')
    expect(fullReplayText).toContain('codex-composer-ready-frame')

    // Send input from restarted Desktop instance and verify response
    await runtime2.write(restartSession!.control, 'exit')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await runtime2.write(restartSession!.control, '\r')
    await waitFor('Fake codex process exits on exit command', async () => {
      const snap = await runtime2.snapshot(config)
      const s = snap.sessions.find((item) => item.id === initialSessionId)
      return s?.processState === 'exited'
    })

    await runtime2.dispose()
  }, 30_000)
})
