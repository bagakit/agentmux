import { parseAgentMuxMessagePrefix } from '../src/agent-message-render.js'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { agentTakeoverInput, type AgentTakeoverContextSource } from '../src/agent-takeover-context.js'
import {
  composeAgentDerivedAction, parseAgentDerivedActionFields, parseAgentDerivedActionId, parseAgentDerivedActionsConfig,
  resolveAgentDerivedActions, AGENT_BUILT_IN_DERIVED_ACTIONS
} from '../src/agent-derived-actions.js'

const source: AgentTakeoverContextSource = { hostId: 'remote', agentSessionId: 'original', executorId: 'codex', diagnostic: 'Original context unavailable.' }
const native = { nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-1' }, workspacePath: '/fixture/repo', revision: 'r1' }

it('keeps a custom authored instruction byte for byte and attaches only the qualified source reference', () => {
  const instruction = '  Review the changes and list concrete bugs.\n'
  const result = parseAgentMuxMessagePrefix(composeAgentDerivedAction({ instruction }, source))
  expect(result?.body).toBe('\n\n' + instruction)
  expect(result?.declaredContexts?.[0]?.raw).toBe('<amux:ref kind="agent-context" read-via="agent context --help">\nRead Host: local\nOriginal Agent Session: original\n</amux:ref>')
})

it('keeps independent Provider material and observes a bounded page at its original owner', () => {
  const dual = { ...source, nativeSource: native }
  const derived = composeAgentDerivedAction({ instruction: 'Try a different design.' }, dual)
  const takeover = agentTakeoverInput(dual)
  expect(parseAgentMuxMessagePrefix(derived)?.declaredContexts?.[0]?.raw).toBe(takeover.agentMuxNote)
  expect(takeover.agentMuxNote).toContain('agent native history --help')
  expect(takeover.agentMuxNote).toContain(native.revision)
  const remote = agentTakeoverInput(source, null, { nextCursor: 'original-cursor' })
  expect(remote.agentMuxNote).toContain('Original Host: remote. Original source: original.')
  expect(remote.agentMuxNote).toContain('original-cursor')
  expect(remote.agentMuxNote).not.toContain('Read Host: local')
})

it('reads one action order: visible official actions, then the user list in its saved order', () => {
  const actions = [{ id: 'review', label: 'Review', base: 'new-agent' as const, instruction: 'Review.' }, { id: 'retry', label: 'Retry', base: 'fork' as const, instruction: 'Retry.' }]
  expect(resolveAgentDerivedActions(undefined).map(item => item.kind === 'built-in' ? item.id : item.action.id)).toEqual(['take-over', 'fork', 'pass-on-experience'])
  expect(resolveAgentDerivedActions({ actions, hidden: ['fork'] }).map(item => item.kind === 'built-in' ? item.id : item.action.id)).toEqual(['take-over', 'pass-on-experience', 'review', 'retry'])
  expect(resolveAgentDerivedActions({ actions: [] }).every(item => item.kind === 'built-in')).toBe(true)
})

it('validates one user action exactly and keeps official identities read-only', () => {
  expect(parseAgentDerivedActionFields({ label: ' Review ', base: 'new-agent', instruction: 'Review.', executorId: 'codex' })).toEqual({ label: 'Review', base: 'new-agent', instruction: 'Review.', executorId: 'codex' })
  for (const value of [{ label: '', base: 'new-agent', instruction: 'x' }, { label: 'a\nb', base: 'new-agent', instruction: 'x' },
    { label: 'a', base: 'learning', instruction: 'x' }, { label: 'a', base: 'fork', instruction: '   ' },
    { label: 'a', base: 'fork', instruction: 'x', executorId: 'codex' }, { label: 'a', base: 'new-agent', instruction: 'x', prompt: 'y' }]) {
    expect(() => parseAgentDerivedActionFields(value)).toThrow(expect.objectContaining({ code: 'INVALID_DERIVED_ACTION' }))
  }
  for (const id of AGENT_BUILT_IN_DERIVED_ACTIONS.map(action => action.id)) expect(() => parseAgentDerivedActionId(id)).toThrow(expect.objectContaining({ code: 'SETTING_IDENTITY_IMMUTABLE' }))
  expect(() => parseAgentDerivedActionId('Review')).toThrow(expect.objectContaining({ code: 'INVALID_DERIVED_ACTION' }))
  expect(() => parseAgentDerivedActionsConfig({ actions: [{ id: 'a', label: 'A', base: 'fork', instruction: 'x' }, { id: 'a', label: 'B', base: 'fork', instruction: 'y' }] })).toThrow(/appears twice/)
  expect(() => parseAgentDerivedActionsConfig({ hidden: ['review'] })).toThrow(/Only official/)
  expect(() => parseAgentDerivedActionsConfig({ hidden: ['fork', 'fork'] })).toThrow(/Only official/)
  expect(parseAgentDerivedActionsConfig({ actions: [] })).toEqual({ actions: [] })
})

it('is published as a Core subpath export', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, { import: string }> }
  expect(pkg.exports['./agent-derived-actions']?.import).toBe('./dist/agent-derived-actions.js')
})
