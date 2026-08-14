import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import {
  findWorkspaceByLocation,
  insertOrGetWorkspace,
  workspaceLocationKey
} from '../src/main/workspace-location.js'

// ---------------------------------------------------------------------------
// The single "same physical location" rule. `workspaces:chooseLocalFolder` and `workspaces:add` both
// route their append through `insertOrGetWorkspace`, but those handlers live inside `registerIpc`'s
// closure and no test can import them (the same reason rebind and fan-out were extracted). So this is
// the reachable proof that picking / adding an already-registered folder is a no-op-with-feedback rather
// than an append the schema then rejects with a raw zod dump.
//
// The load-bearing property is NORMALIZATION, not exact-string equality: a raw `===` check would pass an
// exact-duplicate test while still shipping the reported bug (a trailing-slash variant slips through).
// Every dedup assertion here therefore feeds a differently-spelled path.
// ---------------------------------------------------------------------------

function config(workspaces: WorkspaceRecord[] = []): AppConfig {
  return {
    version: 9,
    hosts: [
      { id: 'local', kind: 'local', label: 'This Mac' },
      { id: 'box', kind: 'ssh', label: 'Build box', hostname: 'build.example.test' }
    ],
    executors: {},
    workspaces,
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
  }
}

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return { id: 'w1', name: 'Project', hostId: 'local', path: '/projects/agentmux', kind: 'folder', ...overrides }
}

describe('workspaceLocationKey', () => {
  it('collapses trailing-slash and "."-suffixed spellings of the same local path', () => {
    // If this key stopped normalizing (e.g. returned the raw path), these would differ and every dedup
    // below would let a duplicate through — which is the reported bug.
    expect(workspaceLocationKey('local', '/projects/agentmux/')).toBe(workspaceLocationKey('local', '/projects/agentmux'))
    expect(workspaceLocationKey('local', '/projects/agentmux/.')).toBe(workspaceLocationKey('local', '/projects/agentmux'))
  })

  it('collapses ".." segments on a remote (posix) path', () => {
    expect(workspaceLocationKey('box', '/srv/tools/../agentmux')).toBe(workspaceLocationKey('box', '/srv/agentmux'))
  })

  it('the same path on two different hosts is two different locations', () => {
    expect(workspaceLocationKey('local', '/shared/project')).not.toBe(workspaceLocationKey('box', '/shared/project'))
  })
})

describe('findWorkspaceByLocation', () => {
  it('matches a trailing-slash variant of a registered path', () => {
    const workspaces = [record({ id: 'here', path: '/projects/agentmux' })]
    expect(findWorkspaceByLocation(workspaces, 'local', '/projects/agentmux/')?.id).toBe('here')
  })

  it('does not match the same path on a different host', () => {
    const workspaces = [record({ id: 'here', hostId: 'local', path: '/shared/project' })]
    expect(findWorkspaceByLocation(workspaces, 'box', '/shared/project')).toBeUndefined()
  })
})

describe('insertOrGetWorkspace (the chooseLocalFolder / add append path)', () => {
  it('appends a genuinely new location and reports it inserted', () => {
    const result = insertOrGetWorkspace(config([record({ id: 'other', path: '/other/repo' })]), record({ id: 'fresh', path: '/projects/agentmux' }))
    expect(result.inserted).toBe(true)
    expect(result.workspace.id).toBe('fresh')
    expect(result.config.workspaces.map((item) => item.id)).toEqual(['other', 'fresh'])
  })

  it('returns the existing record for a trailing-slash variant and appends nothing', () => {
    // The reported bug: a raw `===` dedup would miss this variant, append a second record, and the
    // schema's uniqueness refinement would then throw a zod issue array in the user's face.
    const existing = record({ id: 'already-here', path: '/projects/agentmux' })
    const result = insertOrGetWorkspace(config([existing]), record({ id: 'dup', path: '/projects/agentmux/' }))
    expect(result.inserted).toBe(false)
    expect(result.workspace).toBe(existing)
    expect(result.config.workspaces).toHaveLength(1)
  })
})

describe('both closure-locked append handlers route through the shared rule', () => {
  // `workspaces:chooseLocalFolder` and `workspaces:add` live inside `registerIpc`'s closure — no test can
  // import and run them (same reason rebind/fanout were extracted). Two write sites, so each needs its
  // own proof that it appends THROUGH `insertOrGetWorkspace` rather than doing a raw
  // `[...config.workspaces, item]` again: covering only one leaves the other silently broken, which this
  // repo has been bitten by. The behavioral proof above covers the function; these two pin the wiring.
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')

  /** The body of one `handle('<channel>', ...)` registration, up to the next handler. */
  function handlerBody(channel: string): string {
    const at = ipc.indexOf(`handle('${channel}'`)
    expect(at, `self-check: ${channel} handler not found`).toBeGreaterThan(-1)
    const next = ipc.indexOf("  handle('", at + 1)
    return ipc.slice(at, next === -1 ? at + 800 : next)
  }

  it('chooseLocalFolder appends through insertOrGetWorkspace, not a raw spread', () => {
    const body = handlerBody('workspaces:chooseLocalFolder')
    expect(body).toContain('insertOrGetWorkspace(')
    // A raw re-append would silently reintroduce the bug the shared rule exists to remove.
    expect(body).not.toMatch(/workspaces:\s*\[\s*\.\.\.config\.workspaces/)
  })

  it('add appends through insertOrGetWorkspace, not a raw spread', () => {
    const body = handlerBody('workspaces:add')
    expect(body).toContain('insertOrGetWorkspace(')
    expect(body).not.toMatch(/workspaces:\s*\[\s*\.\.\.config\.workspaces/)
  })
})
