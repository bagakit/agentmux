import { expect, it } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseSpaceCloseReceipt, parseSpaceClosePlan, spaceCloseDecisions, spaceCloseDigest } from '@agentmux/core/space-close'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { captureWorkbenchClose, workbenchCloseBrowsersAlreadyApplied } from '../src/renderer/src/lib/workbench-close-owner'

function browser(regionId = 'original-region', browserId = 'original-browser') {
  return { id: browserId, navigationId: 'original-navigation', kind: 'browser' as const, regionId, browserId, workspaceId: 'W',
    url: 'about:blank', title: '', mode: 'normal' as const, viewport: 'responsive' as const, agent: null,
    loading: false, canGoBack: false, canGoForward: false, error: null, profileId: 'original-profile', driving: false, appLinkPrompt: null }
}
function original(mixed?: 'file' | 'agent') {
  let tab = createWorkbenchTab('original-tab', browser())
  if (mixed) tab = addWorkbenchRegion(tab, 'original-region', 'right', mixed === 'file'
    ? { kind: 'file', regionId: 'file-region', workspaceId: 'W', path: 'kept.txt' }
    : { kind: 'agent', regionId: 'agent-region', workspaceId: 'W', phase: 'attached', sessionId: 'unconfirmed-agent' })
  const state: Parameters<typeof captureWorkbenchClose>[0] = { config: null, tabs: { [tab.id]: tab },
    layouts: { W: createWorkspaceLayout('original-group', [tab.id]) }, sessions: [], documents: {}, dirtyDocuments: {},
    documentGenerations: {}, documentObservationGenerations: {}, savingDocuments: {}, closingWorkbenchViews: {} }
  const request = { operationId: 'original-operation', target: { kind: 'tab-occurrence' as const, displayWorkspaceId: 'W', groupId: 'original-group', tabId: tab.id }, keepAgentSessions: false }
  const projection = captureWorkbenchClose(state, request)
  const plan = parseSpaceClosePlan({ authority: { ownerId: 'original-owner', endpoint: 'original-endpoint', documentGeneration: 'original-document' },
    target: request.target, keepAgentSessions: false, projection,
    children: projection.resources.map(resource => ({ key: resource.key, operationId: 'original-browser-child', terminal: null, issue: null })) })
  const actor = { kind: 'user' as const, id: 'original-person' }
  const record = parseSpaceCloseReceipt({ operationId: request.operationId, request, plan, planDigest: spaceCloseDigest(plan),
    preparedBy: actor, approvedBy: actor, decisions: spaceCloseDecisions(plan), phase: 'applying', outcome: 'unknown',
    resources: plan.children.map(child => ({ key: child.key, operationId: child.operationId, outcome: 'acknowledged', receipt: { kind: 'browser-closed', browserId: 'original-browser' } })),
    clientProjection: { applied: false, removedRegions: [], retainedRegions: projection.surfaces.map(surface => surface.owner.regionId), save: null },
    spatialContribution: { save: null }, preparedAt: 1, updatedAt: 1, diskDurability: 'confirmed' })
  const after = { ...state, tabs: {}, closingWorkbenchViews: { [tab.id]: { operationId: request.operationId, tabId: tab.id, reservedSessionIds: [] } } }
  return { state, after, record }
}

it('[survey-close-receipt] confirms an already retired exact Browser only from its admitted ACK and live lease', () => {
  const f = original()
  expect(workbenchCloseBrowsersAlreadyApplied(f.after, f.record)).toBe(true)
  expect(workbenchCloseBrowsersAlreadyApplied({ ...f.after, closingWorkbenchViews: {} }, f.record)).toBe(false)
  const unknown = structuredClone(f.record); unknown.resources[0]!.outcome = 'unknown'; unknown.resources[0]!.receipt = null
  expect(workbenchCloseBrowsersAlreadyApplied(f.after, unknown)).toBe(false)
  const wrong = structuredClone(f.record); wrong.resources[0]!.receipt = { kind: 'browser-closed', browserId: 'another-browser' }
  expect(workbenchCloseBrowsersAlreadyApplied(f.after, wrong)).toBe(false)
})
it.each(['file', 'agent'] as const)('[survey-close-receipt] does not certify absent mixed %s content from a Browser ACK', kind => {
  const f = original(kind)
  expect(workbenchCloseBrowsersAlreadyApplied(f.after, f.record)).toBe(false)
})
it('[survey-close-receipt] keeps an original Region replacement and an original Browser moved to another Tab unconfirmed', () => {
  const f = original()
  const replacement = createWorkbenchTab('another-tab', browser('original-region', 'replacement-browser'))
  expect(workbenchCloseBrowsersAlreadyApplied({ ...f.after, tabs: { [replacement.id]: replacement } }, f.record)).toBe(false)
  const moved = createWorkbenchTab('moved-tab', browser('moved-region', 'original-browser'))
  expect(workbenchCloseBrowsersAlreadyApplied({ ...f.after, tabs: { [moved.id]: moved } }, f.record)).toBe(false)
})
