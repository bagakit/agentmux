import { describe, expect, it } from 'vitest'
import { renderMergedHookContent } from '../src/hook-config-merge.js'

const OWNED_KEY = { kind: 'json-owned-key', key: 'agentmux-status' } as const
const MANAGED = { kind: 'json-managed-events', marker: 'agentmux-hook.js' } as const
const YAML_MANAGED = { kind: 'yaml-managed-events', marker: 'agentmux-hook.js' } as const
const APPROVALS = { kind: 'json-managed-approvals', marker: 'agentmux-hook.js' } as const

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

describe('hook config merge — yaml-managed-events (hermes ~/.hermes/config.yaml)', () => {
  const owned = JSON.stringify({
    hooks: {
      pre_tool_call: [{ command: '/usr/bin/env … agentmux-hook.js', timeout: 10 }],
      on_session_end: [{ command: '/usr/bin/env … agentmux-hook.js', timeout: 10 }]
    }
  })

  // A realistic slice of the user's config: comments, a secret-bearing key, and their own shell hook.
  const current = [
    '# hermes configuration — do not commit',
    'model: claude-opus-5',
    'api_key: sk-secret-do-not-lose  # personal token',
    'hooks:',
    '  pre_tool_call:',
    '    - command: /home/me/audit.sh  # user audit hook',
    '      timeout: 5',
    ''
  ].join('\n')

  it('adds our command under each event while preserving comments, secrets, and foreign hooks', () => {
    const result = renderMergedHookContent(current, owned, YAML_MANAGED)
    // Comments and the secret survive — the merge edits the parsed doc, never re-emits a plain object.
    // (The serializer normalises the run of spaces before an inline comment to one; the value and the
    // comment text are preserved, which is what matters — no key or credential is ever lost.)
    expect(result).toContain('# hermes configuration — do not commit')
    expect(result).toContain('api_key: sk-secret-do-not-lose')
    expect(result).toContain('# personal token')
    expect(result).toContain('# user audit hook')
    // The foreign hook stays first in its shared bucket; ours is appended after it.
    const preToolBlock = result.slice(result.indexOf('pre_tool_call:'))
    expect(preToolBlock.indexOf('/home/me/audit.sh')).toBeLessThan(preToolBlock.indexOf('agentmux-hook.js'))
    // Our new bucket is added.
    expect(result).toContain('on_session_end:')
  })

  it('sweeps a stale AgentMux entry by marker instead of duplicating on reinstall, and is idempotent', () => {
    // A previous install wrote our command under a different execPath.
    const stale = [
      'model: claude-opus-5',
      'hooks:',
      '  pre_tool_call:',
      '    - command: /old/path/agentmux-hook.js',
      '      timeout: 10',
      ''
    ].join('\n')
    const first = renderMergedHookContent(stale, owned, YAML_MANAGED)
    // Exactly one agentmux entry remains under pre_tool_call (the fresh one), not two.
    expect(first.match(/agentmux-hook\.js/g)?.length).toBe(2) // pre_tool_call + on_session_end, one each
    expect(first).not.toContain('/old/path/agentmux-hook.js')
    // Rendering again over our own output changes nothing — required for the installer's unchanged-hash guard.
    expect(renderMergedHookContent(first, owned, YAML_MANAGED)).toBe(first)
  })

  it('drops a bucket left empty after sweeping our only entry, keeping foreign-only buckets', () => {
    const current = [
      'hooks:',
      '  legacy_event:', // only ever held our stale entry
      '    - command: /old/agentmux-hook.js',
      '  post_tool_call:', // foreign-only bucket, untouched
      '    - command: /home/me/keep.sh',
      ''
    ].join('\n')
    const ownedElsewhere = JSON.stringify({ hooks: { on_session_end: [{ command: 'x/agentmux-hook.js' }] } })
    const result = renderMergedHookContent(current, ownedElsewhere, YAML_MANAGED)
    expect(result).not.toContain('legacy_event')
    expect(result).toContain('post_tool_call:')
    expect(result).toContain('/home/me/keep.sh')
  })

  it('seeds hooks: into a config that has none, and treats a blank/absent file as empty', () => {
    const noHooks = renderMergedHookContent('model: claude-opus-5\n', owned, YAML_MANAGED)
    expect(noHooks).toContain('model: claude-opus-5')
    expect(noHooks).toContain('agentmux-hook.js')
    const fromBlank = renderMergedHookContent('  \n', owned, YAML_MANAGED)
    expect(fromBlank).toContain('pre_tool_call:')
    const fromAbsent = renderMergedHookContent(null, owned, YAML_MANAGED)
    expect(fromAbsent).toContain('pre_tool_call:')
  })

  it('refuses to overwrite unparseable YAML or a non-mapping document (never silent data loss)', () => {
    expect(() => renderMergedHookContent('key: [unterminated', owned, YAML_MANAGED)).toThrow(/valid YAML/)
    expect(() => renderMergedHookContent('- just\n- a\n- list\n', owned, YAML_MANAGED)).toThrow(/YAML mapping/)
  })
})

describe('hook config merge — json-managed-approvals (hermes shell-hooks-allowlist.json)', () => {
  const owned = JSON.stringify({
    approvals: [
      { event: 'pre_tool_call', command: '/usr/bin/env … agentmux-hook.js' },
      { event: 'on_session_end', command: '/usr/bin/env … agentmux-hook.js' }
    ]
  })

  it('appends our approvals while preserving every foreign approval verbatim (timestamps and all)', () => {
    const current = JSON.stringify({
      approvals: [
        { event: 'pre_llm_call', command: '/home/me/audit.sh', approved_at: '2026-01-01T00:00:00Z' }
      ]
    })
    const result = JSON.parse(renderMergedHookContent(current, owned, APPROVALS))
    // Foreign approval kept first, with its timestamp intact.
    expect(result.approvals[0]).toEqual({ event: 'pre_llm_call', command: '/home/me/audit.sh', approved_at: '2026-01-01T00:00:00Z' })
    // Our two approvals appended, carrying only {event, command}.
    expect(result.approvals).toHaveLength(3)
    expect(result.approvals[1]).toEqual({ event: 'pre_tool_call', command: '/usr/bin/env … agentmux-hook.js' })
  })

  it('sweeps stale AgentMux approvals by marker instead of duplicating, and is idempotent', () => {
    const current = JSON.stringify({
      approvals: [{ event: 'pre_tool_call', command: '/old/path/agentmux-hook.js', approved_at: 'stale' }]
    })
    const first = renderMergedHookContent(current, owned, APPROVALS)
    const parsed = JSON.parse(first)
    expect(parsed.approvals).toHaveLength(2) // stale one dropped, our two added
    expect(first).not.toContain('/old/path/agentmux-hook.js')
    expect(renderMergedHookContent(first, owned, APPROVALS)).toBe(first)
  })

  it('treats a blank/absent allowlist as empty rather than failing', () => {
    expect(JSON.parse(renderMergedHookContent(null, owned, APPROVALS)).approvals).toHaveLength(2)
    expect(JSON.parse(renderMergedHookContent('  \n', owned, APPROVALS)).approvals).toHaveLength(2)
  })

  it('refuses to overwrite an unparseable allowlist (never silent data loss)', () => {
    expect(() => renderMergedHookContent('{ not json', owned, APPROVALS)).toThrow(/valid JSON/)
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
