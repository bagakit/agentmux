import { describe, expect, it } from 'vitest'
import { renderMergedHookContent } from '../src/hook-config-merge.js'

const OWNED_KEY = { kind: 'json-owned-key', key: 'agentmux-status' } as const
const MANAGED = { kind: 'json-managed-events', marker: 'agentmux-hook.js' } as const

describe('hook config merge — json-owned-key (antigravity shared ~/.gemini)', () => {
  const owned = JSON.stringify({ 'agentmux-status': { PreToolUse: [{ command: 'agentmux-hook.js' }] } })

  it('injects the owned key into an empty/absent file', () => {
    const result = JSON.parse(renderMergedHookContent(null, owned, OWNED_KEY))
    expect(result['agentmux-status']).toEqual({ PreToolUse: [{ command: 'agentmux-hook.js' }] })
    expect(Object.keys(result)).toEqual(['agentmux-status'])
  })

  it('preserves every foreign sibling key the real Gemini CLI owns', () => {
    const current = JSON.stringify({
      'user-hooks': { Stop: [{ command: '/usr/bin/notify' }] },
      settings: { theme: 'dark' }
    })
    const result = JSON.parse(renderMergedHookContent(current, owned, OWNED_KEY))
    expect(result['user-hooks']).toEqual({ Stop: [{ command: '/usr/bin/notify' }] })
    expect(result.settings).toEqual({ theme: 'dark' })
    expect(result['agentmux-status']).toBeDefined()
  })

  it('overwrites only the owned key on reinstall (never accumulates) and is idempotent', () => {
    const first = renderMergedHookContent(null, owned, OWNED_KEY)
    const second = renderMergedHookContent(first, owned, OWNED_KEY)
    expect(second).toBe(first)
    // A stale owned bundle is fully replaced, not merged into.
    const stale = JSON.stringify({ 'agentmux-status': { OldEvent: [{ command: 'agentmux-hook.js --old' }] } })
    const refreshed = JSON.parse(renderMergedHookContent(stale, owned, OWNED_KEY))
    expect(refreshed['agentmux-status']).toEqual({ PreToolUse: [{ command: 'agentmux-hook.js' }] })
  })
})

describe('hook config merge — json-managed-events (codex .codex/hooks.json)', () => {
  const owned = JSON.stringify({
    description: 'AgentMux Codex lifecycle bridge.',
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/abs/agentmux-hook.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: '/abs/agentmux-hook.js' }] }]
    }
  })

  it('keeps foreign event buckets and foreign entries inside shared buckets', () => {
    const current = JSON.stringify({
      hooks: {
        PreCommit: [{ hooks: [{ type: 'command', command: '/repo/lint.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: '/repo/notify.sh' }] }]
      }
    })
    const result = JSON.parse(renderMergedHookContent(current, owned, MANAGED))
    // Foreign-only bucket survives untouched.
    expect(result.hooks.PreCommit).toEqual([{ hooks: [{ type: 'command', command: '/repo/lint.sh' }] }])
    // Shared Stop bucket keeps the foreign entry first, then our entry appended.
    expect(result.hooks.Stop).toHaveLength(2)
    expect(result.hooks.Stop[0].hooks[0].command).toBe('/repo/notify.sh')
    expect(result.hooks.Stop[1].hooks[0].command).toBe('/abs/agentmux-hook.js')
    // Our SessionStart bucket is added.
    expect(result.hooks.SessionStart[0].hooks[0].command).toBe('/abs/agentmux-hook.js')
    // We own the description label.
    expect(result.description).toBe('AgentMux Codex lifecycle bridge.')
  })

  it('sweeps stale AgentMux entries by filename marker rather than duplicating on reinstall', () => {
    // A previous install wrote our command under a different absolute execPath.
    const current = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/old/path/agentmux-hook.js' }] }],
        Stop: [{ hooks: [{ type: 'command', command: '/old/path/agentmux-hook.js' }] }]
      }
    })
    const result = JSON.parse(renderMergedHookContent(current, owned, MANAGED))
    expect(result.hooks.SessionStart).toHaveLength(1)
    expect(result.hooks.SessionStart[0].hooks[0].command).toBe('/abs/agentmux-hook.js')
    expect(result.hooks.Stop).toHaveLength(1)
  })

  it('drops a bucket that becomes foreign-empty after the sweep', () => {
    // The user only ever had our stale entry in a bucket we no longer target.
    const current = JSON.stringify({
      hooks: { LegacyEvent: [{ hooks: [{ type: 'command', command: '/old/agentmux-hook.js' }] }] }
    })
    const result = JSON.parse(renderMergedHookContent(current, owned, MANAGED))
    expect(result.hooks.LegacyEvent).toBeUndefined()
  })

  it('is idempotent across repeated installs', () => {
    const first = renderMergedHookContent('{}\n', owned, MANAGED)
    const second = renderMergedHookContent(first, owned, MANAGED)
    expect(second).toBe(first)
  })
})

describe('hook config merge — safety', () => {
  it('refuses to overwrite a file with real but unparseable content (never silent data loss)', () => {
    expect(() => renderMergedHookContent('{ not json', '{"agentmux-status":{}}', OWNED_KEY))
      .toThrow(/valid JSON/)
  })

  it('refuses a non-object JSON target', () => {
    expect(() => renderMergedHookContent('[1,2,3]', '{"agentmux-status":{}}', OWNED_KEY))
      .toThrow(/JSON object/)
  })

  it('treats a blank file as empty rather than failing', () => {
    const result = JSON.parse(renderMergedHookContent('   \n', '{"agentmux-status":{"x":1}}', OWNED_KEY))
    expect(result['agentmux-status']).toEqual({ x: 1 })
  })

  it('rejects owned content missing its declared key', () => {
    expect(() => renderMergedHookContent(null, '{"other":1}', OWNED_KEY)).toThrow(/owned key/)
  })
})
