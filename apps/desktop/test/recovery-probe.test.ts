import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
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
      restoredWorkbench: {
        tabs: {
          'tab-probe': {
            layout: { root: { type: 'leaf', regionId: 'region-probe' }, activeRegionId: 'region-probe' },
            regions: { 'region-probe': { regionId: 'region-probe', kind: 'agent', sessionId: 'session-probe' } }
          }
        }
      },
      ...overrides
    },
    version: 1
  })
}

describe('real Electron recovery receipt projections', () => {
  it('summarizes durable Workbench identity, active Region and draft', () => {
    expect(summarizeRecoveryStorage(storage())).toEqual({
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
    expect(summarizeRecoveryStorage(null)).toMatchObject({ storagePresent: false, tabIds: [], regionIds: [] })
    expect(summarizeRecoveryStorage('{bad json')).toMatchObject({ storagePresent: true, tabIds: [], regionIds: [] })
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
      userData: '/tmp/probe-user-data',
      runtimeDirectory: '/tmp/probe-runtime',
      workbench: summarizeRecoveryStorage(storage()),
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
    expect(recoveryIdentityMatches(before, { ...before, userData: '/tmp/other-root' })).toBe(false)
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
