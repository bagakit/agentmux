// @vitest-environment happy-dom
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { initializeDisposal, disposalConfig, disposalTarget, removeOpeningPresentation } from './helpers/reusable-shell-disposal-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { warmCandidates } from './helpers/reusable-shell-candidates'
import { api } from '../src/renderer/src/lib/api'
import { ScratchTopics } from '../src/main/scratch-topics'
import type { SessionSnapshot, TerminalLaunchInput } from '../src/shared/contracts'

const execute = promisify(execFile), original = useAppStore.getState()
let scope: Awaited<ReturnType<typeof headlessFixture>> | undefined
let owner: Awaited<ReturnType<typeof owningBridge>> | undefined
const disposers: (() => void)[] = [], releases: (() => void)[] = []
const pids = new Set<number>(), runIds = new Set<string>()
afterEach(async () => {
  for (const release of releases) release()
  for (const dispose of disposers) dispose()
  try {
    if (scope) { const client = await scope.client(); const live = await client.listRuns()
      await Promise.all(live.filter(run => runIds.has(run.runId) && run.state === 'running').map(run => client.stopTerminal({ runId: run.runId }))) }
  } finally { try { await owner?.dispose() } finally { await scope?.cleanup() } }
  const remaining = [...pids].filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
  expect(remaining).toEqual([])
  const output = process.env.AGENTMUX_REUSABLE_SHELL_DISPOSAL_NATIVE
  if (output) await writeFile(output.replace(/\.json$/u, '-cleanup.json'), JSON.stringify({ privatePids: [...pids], remaining, privateRootRemoved: true, userRunTouched: false }) + '\n')
  vi.restoreAllMocks(); useAppStore.setState(original, true)
})

it('actual initialize dispose preserves original claimed Native Runs and still stops never-claimed prewarming', async () => {
  scope = await headlessFixture()
  const client = await scope.client(), config = disposalConfig(scope.root)
  owner = await owningBridge({ client: client as never, store: new AgentMuxFileAgentSessionStore(join(scope.root, 'sessions.json')), config, scratchTopics: new ScratchTopics() })
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => await owner!.runtime.refresh(control, config))
  const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(control => bridge.api!.sessions.stop(control))
  let delayReply = false, arrived: SessionSnapshot | undefined, release: (() => void) | undefined
  const requests: TerminalLaunchInput[] = [], preserved: { request: { createOperationId: string; workspacePath: string }; runId: string; pid: number }[] = []
  const callbacks: Record<string, unknown>[] = []
  vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async request => {
    requests.push(request)
    const session = await bridge.api!.sessions.launchTerminal(request)
    runIds.add(session.control.run.runId)
    const run = (await client.readRunReplay({ runId: session.control.run.runId })).run
    expect(run.pid).toBeGreaterThan(1); pids.add(run.pid!)
    arrived = session
    if (delayReply) await new Promise<void>(resolve => { release = resolve; releases.push(resolve) })
    return session
  })
  for (const phase of ['pending', 'released-ready', 'unused-ready', 'unused-pending'] as const) {
    const initialized = await initializeDisposal(scope.root, () => bridge.api!.sessions.snapshot())
    disposers.push(initialized.dispose)
    delayReply = phase === 'pending' || phase === 'unused-pending'; arrived = undefined; release = undefined
    useAppStore.getState().prewarmTerminal('private', 'region:opening-region')
    await until(() => arrived, Boolean, 'actual original Native Run allocated before callback')
    const session = arrived!, held = warmCandidates(scope!.root)[0]!, request = requests.at(-1)!
    const before = (await client.readRunReplay({ runId: session.control.run.runId })).run
    const stopBefore = stop.mock.calls.length
    let opening: Promise<void> | undefined
    if (phase === 'pending' || phase === 'released-ready') {
      if (phase === 'released-ready') await held.ready
      opening = useAppStore.getState().promoteWarmTerminal('private-group', disposalTarget)
      if (phase === 'released-ready') { removeOpeningPresentation(); await opening; expect(warmCandidates(scope!.root)[0]?.claimToken).toBeUndefined() }
    } else if (phase === 'unused-ready') await held.ready
    const owned = warmCandidates(scope!.root)[0]
    initialized.dispose(); disposers.pop()
    if (phase === 'pending' || phase === 'released-ready') {
      expect(warmCandidates(scope!.root)[0]).toBe(owned)
      expect(stop.mock.calls.length).toBe(stopBefore)
      expect(warmCandidates(scope!.root)[0]?.creation?.request).toEqual(request)
      const afterCallback = (await client.readRunReplay({ runId: session.control.run.runId })).run
      expect(afterCallback).toMatchObject({ runId: before.runId, pid: before.pid, state: 'running' })
      ;(release as (() => void) | undefined)?.(); await opening
      if (phase === 'released-ready') await useAppStore.getState().promoteWarmTerminal('private-group', { tabId: 'recovery', regionId: 'recovery-region' })
      expect(useAppStore.getState().tabs[phase === 'pending' ? 'opening' : 'recovery']?.regions[phase === 'pending' ? 'opening-region' : 'recovery-region']).toMatchObject({ sessionId: session.id, phase: 'attached' })
      preserved.push({ request: { createOperationId: request.createOperationId!, workspacePath: request.workspacePath }, runId: before.runId, pid: before.pid! })
      callbacks.push({ phase, actualInitializeDisposeExecuted: true, request, before, afterCallback, stopCalls: 0 })
    } else {
      expect(warmCandidates(scope!.root)).toEqual([])
      ;(release as (() => void) | undefined)?.(); await held.ready
      await vi.waitFor(() => expect(stop.mock.calls.slice(stopBefore).map(([control]) => control)).toEqual([session.control]))
      const ended = await until(() => client.readRunReplay({ runId: before.runId }), result => result.run.state !== 'running', 'never-claimed real Native Run stopped')
      await vi.waitFor(() => expect(useAppStore.getState().unclaimedTerminalSessionIds).not.toContain(session.id))
      callbacks.push({ phase, actualInitializeDisposeExecuted: true, request, before, afterCallback: ended.run, stopCalls: 1 })
    }
  }
  expect(requests).toHaveLength(4); expect(new Set(requests.map(request => request.createOperationId)).size).toBe(4)
  const child = await execute(process.execPath, [resolve('apps/desktop/test/fixtures/reusable-shell-openings/disposal-reader.mjs'), scope.socketPath, JSON.stringify(preserved)], { env: scope.env, timeout: 20_000 })
  const reread = JSON.parse(child.stdout.trim())
  expect(reread.pid).not.toBe(process.pid)
  expect(reread.runs.map((run: any) => ({ runId: run.runId, pid: run.pid, state: run.state, interactive: run.interactive }))).toEqual(preserved.map(run => ({ runId: run.runId, pid: run.pid, state: 'running', interactive: true })))
  const output = process.env.AGENTMUX_REUSABLE_SHELL_DISPOSAL_NATIVE
  if (output) await writeFile(output, JSON.stringify({ passed: true, private: true, callbacks, originalRuns: preserved, reread, owner: scope.owner,
    source: Object.fromEntries(await Promise.all(['apps/desktop/src/renderer/src/store.ts','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/preload/index.ts','packages/core/src/client.ts','packages/core/dist/index.js','apps/desktop/test/helpers/reusable-shell-disposal-fixture.ts'].map(async path => [path, createHash('sha256').update(await readFile(resolve(path))).digest('hex')]))),
    boundary: 'Actual Store.initialize returned disposal callback through actual registered Main/preload and private public Unix Core/native original Run. Two claimed original Runs stay interactive under independent reader; two never-claimed Runs stop. No user Runtime, Desktop restart, installation, or cross-Renderer warm.creation durability claim.' }, null, 2) + '\n')
}, 90_000)
