import { fixtureFileUrl as _hygiene_fixtureFileUrl, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import type { AgentMuxSpatialState } from '@agentmux/core/spatial-graph'
import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  installRecoverySeedBeforeLoad,
  recoveryIdentityMatches,
  summarizeRecoverySessionStore,
  summarizeRecoveryStorage
} from '../src/main/recovery-probe.js'

function storage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: {
      activeWorkspaceId: 'workspace-probe',
      agentFocus: {
        execution: { sessionId: 'session-probe', history: [{ sessionId: 'session-probe', focusedAt: 1 }] },
        pmo: { sessionId: null }
      },
      agentComposerDrafts: { 'session-probe': 'draft survives restart' },
      ...overrides
    },
    version: 1
  })
}

function spatial(): AgentMuxSpatialState {
  return { schemaVersion: 1, revision: 4, graph: {
    spaces: [], zones: [], bindings: [],
    tabs: [{ tabId: 'tab-probe', workspaceId: 'workspace-probe', zoneId: null, name: null, regionIds: ['region-probe'] }],
    regions: [{ regionId: 'region-probe', tabId: 'tab-probe', kind: 'agent', agentSessionId: 'session-probe', runId: 'run-probe', execution: null }],
    layouts: {}, tabLayouts: { 'tab-probe': { root: { type: 'leaf', regionId: 'region-probe' }, activeRegionId: 'region-probe' } }, resources: {}
  } }
}

describe('real Electron recovery receipt projections', () => {
  it('summarizes durable Workbench identity, active Region and draft', () => {
    expect(summarizeRecoveryStorage(storage(), spatial())).toEqual({
      storagePresent: true,
      tabIds: ['tab-probe'],
      regionIds: ['region-probe'],
      activeRegionIds: ['region-probe'],
      activeWorkspaceId: 'workspace-probe',
      draftSessionIds: ['session-probe'],
      drafts: { 'session-probe': 'draft survives restart' },
      executionFocusSessionId: 'session-probe',
      executionFocusHistory: ['session-probe'],
      pmoFocusSessionId: null
    })
  })

  it('keeps an empty or malformed snapshot explicit instead of treating it as recovered', () => {
    expect(summarizeRecoveryStorage(null, null)).toMatchObject({ storagePresent: false, tabIds: [], regionIds: [] })
    expect(summarizeRecoveryStorage('{bad json', null)).toMatchObject({ storagePresent: true, tabIds: [], regionIds: [] })
  })

  it('does not let missing or malformed UI storage erase independently known Core facts', () => {
    for (const raw of [null, '{bad json']) {
      expect(summarizeRecoveryStorage(raw, spatial())).toMatchObject({
        tabIds: ['tab-probe'], regionIds: ['region-probe'], activeRegionIds: ['region-probe'],
        drafts: {}, executionFocusSessionId: null
      })
    }
  })

  it('keeps UI drafts and focus while Core spatial observation is absent or unavailable', () => {
    expect(summarizeRecoveryStorage(storage(), null)).toMatchObject({ tabIds: [], regionIds: [], activeRegionIds: [],
      drafts: { 'session-probe': 'draft survives restart' }, executionFocusSessionId: 'session-probe' })
  })

  it('summarizes Core-owned Session identity and Run reference', () => {
    expect(summarizeRecoverySessionStore(JSON.stringify({ sessions: [{
      agentSessionId: 'session-probe',
      providerId: 'codex',
      run: { runId: 'run-probe' },
      nativeHandle: { sessionId: 'native-probe' }
    }] }))).toEqual({
      storePresent: true,
      sessions: [{ agentSessionId: 'session-probe', runId: 'run-probe', providerId: 'codex', nativeSessionId: 'native-probe' }]
    })
  })

  it('keeps an empty Core snapshot observable instead of manufacturing a Session', () => {
    expect(summarizeRecoverySessionStore(JSON.stringify({ sessions: [] }))).toEqual({
      storePresent: true,
      sessions: []
    })
    expect(summarizeRecoverySessionStore(null)).toEqual({ storePresent: false, sessions: [] })
  })

  it('rejects durable identity drift across restart', () => {
    const common = {
      userData: _hygiene_fixturePath("tmp/probe-user-data"),
      runtimeDirectory: _hygiene_fixturePath("tmp/probe-runtime"),
      workbench: summarizeRecoveryStorage(storage(), spatial()),
      sessions: summarizeRecoverySessionStore(JSON.stringify({ sessions: [{ agentSessionId: 'session-probe', run: { runId: 'run-probe' } }] }))
    }
    const before = {
      userData: common.userData,
      runtimeDirectory: common.runtimeDirectory,
      tabIds: common.workbench.tabIds,
      regionIds: common.workbench.regionIds,
      activeRegionIds: common.workbench.activeRegionIds,
      activeWorkspaceId: common.workbench.activeWorkspaceId,
      draftSessionIds: common.workbench.draftSessionIds,
      drafts: common.workbench.drafts,
      executionFocusSessionId: common.workbench.executionFocusSessionId,
      executionFocusHistory: common.workbench.executionFocusHistory,
      pmoFocusSessionId: common.workbench.pmoFocusSessionId,
      sessionIds: common.sessions.sessions.map((session) => session.agentSessionId),
      runIds: common.sessions.sessions.flatMap((session) => session.runId ? [session.runId] : [])
    }
    expect(recoveryIdentityMatches(before, { ...before })).toBe(true)
    expect(recoveryIdentityMatches(before, { ...before, regionIds: [] })).toBe(false)
    expect(recoveryIdentityMatches(before, { ...before, userData: _hygiene_fixturePath("tmp/other-root") })).toBe(false)
  })

  it('keeps the real probe contract on the script path', async () => {
    const source = await readFile(join(import.meta.dirname, '../scripts/probe-attention-review-restart.mjs'), 'utf8')
    expect(source).toContain("runProbeProcess(electronExecutable")
    expect(source).toContain('AGENTMUX_DESKTOP_RECOVERY_REPORT')
    expect(source).toContain('differentPid: first.report.pid !== second.report.pid')
    expect(source).toContain('sameRuntimeDirectory: first.report.runtimeDirectory === second.report.runtimeDirectory')
    expect(source).not.toContain('generation')
  })
})


describe('private recovery seed first document owner', () => {
  it('initializes the target and enables Page before registering the first application script', async () => {
    const calls: string[] = []
    let source = ''
    const debuggerOwner = {
      attach: vi.fn(() => calls.push('attach')),
      isAttached: () => true,
      detach: vi.fn(() => calls.push('detach')),
      sendCommand: vi.fn(async (method: string, params?: { source?: string }) => {
        calls.push(method)
        if (params?.source) source = params.source
        return { identifier: 'actual-owner-script' }
      })
    }
    const release = await installRecoverySeedBeforeLoad({
      loadURL: vi.fn(async (url: string) => { calls.push(url) }),
      debugger: debuggerOwner as unknown as Electron.Debugger
    }, _hygiene_fixturePath("tmp/seed-owner/index.html"), storage())
    expect(calls).toEqual(['about:blank', 'attach', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument'])
    expect(source).toContain('localStorage.setItem')
    expect(source).toContain(_hygiene_fixtureFileUrl("tmp/seed-owner/index.html"))
    expect(source).toContain(JSON.stringify(storage()))
    await release()
    expect(calls).toEqual(['about:blank', 'attach', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'detach'])
    expect(debuggerOwner.sendCommand).toHaveBeenLastCalledWith('Page.removeScriptToEvaluateOnNewDocument', { identifier: 'actual-owner-script' })
  })

  it('detaches its own debugger when registration fails instead of navigating with an unconfirmed seed', async () => {
    const detach = vi.fn()
    const debuggerOwner = { attach: vi.fn(), isAttached: () => true, detach,
      sendCommand: vi.fn(async () => { throw new Error('Registration rejected') }) }
    await expect(installRecoverySeedBeforeLoad({ loadURL: vi.fn(async () => {}),
      debugger: debuggerOwner as unknown as Electron.Debugger }, _hygiene_fixturePath("tmp/seed-owner/index.html"), storage()))
      .rejects.toThrow('Registration rejected')
    expect(detach).toHaveBeenCalledOnce()
  })
})
