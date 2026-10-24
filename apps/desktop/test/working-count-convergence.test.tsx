// @vitest-environment happy-dom
import { URL as FileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import type { SessionSnapshot } from '../src/shared/contracts'
import { createFocusProjectionSelector, focusBucketForSession, focusNavigationSummary } from '../src/renderer/src/lib/focus-context'
import { composerSession } from './helpers/composer-dom-fixture'
import { moteConfig, moteSessions, moteTopics, scratchWorkspace, ordinaryTopicId } from './fixtures/mote-workface'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'

// Core owns the state union. Derive the covered cases from its declaration, never a drifting list.
function displayStates(): AgentDisplayState[] {
  const source = ts.createSourceFile('core-types.ts', readFileSync(new FileURL('../../../packages/core/src/types.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'AgentDisplayState')
  expect(declaration).toBeTruthy()
  if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !ts.isUnionTypeNode(declaration.type)) throw new Error('Core state union must be readable')
  const states = declaration.type.types.map(type => { if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) throw new Error('Unexpected Core state declaration'); return type.literal.text as AgentDisplayState })
  expect(states.length).toBeGreaterThan(0)
  return states
}
function agent(id: string, state: AgentDisplayState) {
  return { ...composerSession(id), status: { state, source: 'native-hook' as const, observedAt: Date.now() } }
}
it('Focus navigation and Focus grouping share the same work and attention projection across the Core union', () => {
  const sessions = displayStates().map(state => agent(state, state))
  const groups = sessions.map(session => focusBucketForSession(session, false))
  expect(groups.length).toBe(sessions.length)
  const summarize = (sessions: SessionSnapshot[]) => focusNavigationSummary({sessions, config: null, scratchTopicSnapshots: {}})
  const summary = summarize(sessions)
  expect(summary.working).toBe(groups.filter(bucket => bucket === 'working').length)
  expect(summary.requests + summary.errors).toBe(groups.filter(bucket => bucket === 'attention').length)
  // Process liveness is a separate fact from turn work. Independent expected cases catch shared drift.
  expect(summarize([agent('unknown', 'running'), agent('work', 'working'), agent('start', 'starting'), agent('reply', 'waiting'), agent('failure', 'error')])).toEqual({ working: 2, requests: 1, errors: 1 })
})
it('matches complete Focus grouping without reading conversation bodies across execution scopes', () => {
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const activitySession = (id: string, state: 'active' | 'idle', observedAt = now) => {
      const original = agent(id, 'running'), nativeSessionId = `native-${id}`
      return { ...original, nativeSessionId, nativeHandle: { kind: 'provider' as const, providerId: original.providerId, sessionId: nativeSessionId },
        currentActivity: { state, source: 'native-hook' as const, nativeSessionId,
          nativeTurnId: `turn-${id}`, sourceId: `source-${id}`, sequence: 1,
          run: original.control.run, hookReceiptId: `hook-${id}`, observedAt } }
    }
    const sessions: SessionSnapshot[] = [...moteSessions.map(session => ({ ...session, status: { ...session.status, observedAt: now } })),
      ...displayStates().map(state => agent(state, state)),
      { ...agent('unknown-source', 'working'), status: { state: 'working', source: 'run-process', observedAt: now } },
      activitySession('active-native', 'active'),
      activitySession('idle-native', 'idle'),
      activitySession('stale-native', 'active', now - msUntilSemanticStatusStale({ state: 'working', observedAt: now }, now)),
      { ...agent('retained', 'working'), runUnobserved: true },
      { ...agent('ended', 'working'), processState: 'exited' },
      { ...agent('terminal', 'starting'), kind: 'terminal', providerId: null,
        control: { kind: 'terminal', hostId: 'local', runId: 'original-terminal', run: { runId: 'original-terminal' } } }]
    const scratchTopicSnapshots = { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics: moteTopics, error: null, reading: false } }
    const config = moteConfig
    const originalMotes = sessions.slice(0, moteSessions.length)
    expect(focusNavigationSummary({ sessions: originalMotes, config, scratchTopicSnapshots }, now)).toEqual({ working: 2, requests: 0, errors: 0 })
    // The canonical Mote stays known; only the custom Mote's unavailable directory is unknown.
    expect(focusNavigationSummary({ sessions: originalMotes, config, scratchTopicSnapshots: {} }, now)).toEqual({ working: 2, requests: 1, errors: 0 })
    for (const snapshots of [scratchTopicSnapshots, {}, { ...scratchTopicSnapshots, [scratchWorkspace.id]: { ...scratchTopicSnapshots[scratchWorkspace.id]!, topics: moteTopics.filter(topic => topic.id === ordinaryTopicId) } }]) {
      const input = { sessions, config, scratchTopicSnapshots: snapshots, timelines: {}, agentNames: {} }
      const full = createFocusProjectionSelector()(input).contexts
      const expected = { working: 0, requests: 0, errors: 0 }
      for (const context of full) {
        if (context.bucket === 'working') expected.working++
        else if (context.bucket === 'attention') { if (context.state === 'error') expected.errors++; else expected.requests++ }
      }
      expect(focusNavigationSummary(input, now)).toEqual(expected)
    }
  } finally { clock.mockRestore() }
})
it('the product projection delegates turn work rather than copying a literal status comparison', () => {
  const source = ts.createSourceFile('focus-context.ts', readFileSync(new FileURL('../../../packages/client-ui/src/lib/agent-presentation.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const owner = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'agentPresentationBucket')
  expect(owner).toBeTruthy()
  const calls: string[] = []
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text); node.forEachChild(visit) }
  if (owner) visit(owner)
  expect(calls.length).toBeGreaterThan(0); expect(calls).toContain('turnWorking'); expect(calls).toContain('isNeedsYouState')
})
