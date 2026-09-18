import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import { summarizeAgentAttention, summarizeProviderActivity } from '../src/renderer/src/lib/agent-attention'
import { sessionBoardColumn, workingAgentCount } from '../src/renderer/src/lib/project-board'
import { createFocusProjectionSelector, focusBucketForSession } from '../src/renderer/src/lib/focus-context'
import { focusNavigationSummary } from '../src/renderer/src/components/FocusNavigationButton'

// Core owns the state union. Derive the covered cases from its declaration, never a drifting list.
function displayStates(): AgentDisplayState[] {
  const source = ts.createSourceFile('core-types.ts', readFileSync(new URL('../../../packages/core/src/types.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'AgentDisplayState')
  expect(declaration).toBeTruthy()
  if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !ts.isUnionTypeNode(declaration.type)) throw new Error('Core state union must be readable')
  const states = declaration.type.types.map(type => { if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) throw new Error('Unexpected Core state declaration'); return type.literal.text as AgentDisplayState })
  expect(states.length).toBeGreaterThan(0)
  return states
}
function agent(id: string, state: AgentDisplayState): SessionSnapshot {
  return { id, kind: 'agent', providerId: 'codex', status: { state, source: 'native-hook', observedAt: 1 }, processState: 'running', workspacePath: '/repo', hostId: 'local', label: id } as SessionSnapshot
}
it('keeps the existing Board, provider and roster rollups consistent for every actual Core state', () => {
  for (const state of displayStates()) {
    const sessions = [agent(state, state)], expected = sessionBoardColumn(sessions[0]!) === 'working' ? 1 : 0
    expect(workingAgentCount(sessions)).toBe(expected)
    expect(summarizeAgentAttention(sessions).working).toBe(expected)
    expect(summarizeProviderActivity(sessions).reduce((total, provider) => total + provider.active, 0)).toBe(expected)
  }
})
it('Focus navigation and Focus grouping share the same work and attention projection across the Core union', () => {
  const sessions = displayStates().map(state => agent(state, state))
  const groups = sessions.map(session => focusBucketForSession(session, false))
  expect(groups.length).toBe(sessions.length)
  const summarize = (sessions: SessionSnapshot[]) => focusNavigationSummary(createFocusProjectionSelector()({sessions,config:null,timelines:{},agentNames:{}}).contexts)
  const summary = summarize(sessions)
  expect(summary.working).toBe(groups.filter(bucket => bucket === 'working').length)
  expect(summary.requests + summary.errors).toBe(groups.filter(bucket => bucket === 'attention').length)
  // Process liveness is a separate fact from turn work. Independent expected cases catch shared drift.
  expect(summarize([agent('unknown', 'running'), agent('work', 'working'), agent('start', 'starting'), agent('reply', 'waiting'), agent('failure', 'error')])).toEqual({ working: 2, requests: 1, errors: 1 })
})
it('the product projection delegates turn work rather than copying a literal status comparison', () => {
  const source = ts.createSourceFile('focus-context.ts', readFileSync(new URL('../src/renderer/src/lib/focus-context.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const owner = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'focusBucketForSession')
  expect(owner).toBeTruthy()
  const calls: string[] = []
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text); node.forEachChild(visit) }
  if (owner) visit(owner)
  expect(calls.length).toBeGreaterThan(0); expect(calls).toContain('turnWorking'); expect(calls).toContain('isNeedsYouState')
})
