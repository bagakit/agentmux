import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { agentTakeoverPrompt, type AgentTakeoverContextSource } from '../src/agent-takeover-context.js'
import {
  agentDerivedActionPrompt, parseAgentDerivedActionFields, parseAgentDerivedActionId, parseAgentDerivedActionsConfig,
  resolveAgentDerivedActions, AGENT_BUILT_IN_DERIVED_ACTIONS
} from '../src/agent-derived-actions.js'

const source: AgentTakeoverContextSource = { hostId: 'remote', agentSessionId: 'original', cwd: '/repo', executorId: 'codex', label: 'Mote dialogue', diagnostic: 'running · waiting for review' }
const native = { nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-1' }, workspacePath: '/repo', revision: 'r1' }

it('keeps the complete original source context and safety for a custom new-agent action', () => {
  const prompt = agentDerivedActionPrompt({ label: 'Review this work', instruction: '  Review the changes and list concrete bugs.\n' }, source, 'Build the Threads view')
  expect(prompt.startsWith('Start new work from the original Agent’s work')).toBe(true)
  expect(prompt).toContain('Your task (Review this work):\nReview the changes and list concrete bugs.')
  expect(prompt).toContain(`agent context --host 'local' --session 'original'`)
  expect(prompt).toContain('"hostId":"remote"')
  expect(prompt).toContain('Original initial task (complete retained text):\nBuild the Threads view')
  expect(prompt).toContain('Current source diagnostic (complete, observed; not proof of completion):\nrunning · waiting for review')
  expect(prompt).toContain('Do not stop, delete, overwrite or send to the original Session.')
  expect(prompt).toContain('This is a separate derived task, not a resume of the original Session.')
  expect(prompt).not.toContain('Take over the unfinished work')
  expect(prompt).not.toContain('This is a handover')
})

it('shares the takeover context block, so a dual native source reads both independent sources', () => {
  const dual = { ...source, nativeSource: native }
  const derived = agentDerivedActionPrompt({ label: 'Try another approach', instruction: 'Try a different design.' }, dual)
  const takeover = agentTakeoverPrompt(dual)
  for (const shared of ['agent native history --input -', 'These are independent original sources', `agent context --host 'local' --session 'original'`]) {
    expect(derived).toContain(shared); expect(takeover).toContain(shared)
  }
  expect(agentDerivedActionPrompt({ label: 'x', instruction: 'y' }, source, undefined, null)).not.toContain('agent context --host')
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
