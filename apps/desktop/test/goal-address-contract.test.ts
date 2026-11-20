// @vitest-environment happy-dom
import { createElement } from 'react'
import { InlineObjectLink } from '../src/renderer/src/components/InlineObjectLink'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { expect, it, vi } from 'vitest'
import { deriveBoundGoalId, formatGoalAddress, formatGoalTicketLink, parseAmuxObjectLink } from '../../../packages/core/src/sharing'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../../../packages/core/src/control-codec'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import { searchAgentMuxMetadata } from '../../../packages/core/src/search-metadata'

const dom = composerDOM()

it('Goal addresses retain the original Runtime namespace and opaque Goal while rejecting executable additions', async () => {
  const address = formatGoalAddress('original/Goal ?#中文', 'original Runtime', 'original namespace')
  expect(parseAmuxObjectLink(address.goalUrl)).toEqual({ kind: 'goal', runtimeId: address.runtimeId, namespace: address.namespace, goalId: 'original/Goal ?#中文' })
  expect(parseAmuxObjectLink(address.planUrl)).toEqual({ kind: 'goal', runtimeId: address.runtimeId, namespace: address.namespace, goalId: 'original/Goal ?#中文', section: 'plan' })
  for (const uri of ['amux://goal/same', 'amux://goal/same/plan?runtime=one', address.planUrl + '&start=1', address.goalUrl + '#plan', address.goalUrl.replace('runtime=', 'namespace='), address.goalUrl.replace('%2F', '%2f')]) expect(() => parseAmuxObjectLink(uri), uri).toThrow()
  const invocation = await parseAgentMuxCliInvocation(['goal', 'focus', '--goal', 'original/Goal ?#中文', '--runtime', address.runtimeId, '--namespace', address.namespace, '--section', 'plan'])
  expect(invocation.params).toMatchObject({ goalId: 'original/Goal ?#中文', runtimeId: address.runtimeId, namespace: address.namespace, section: 'plan', input: 'preserve' })
  expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'original', operation: 'focus', target: { kind: 'goal', goalId: 'same', runtimeId: 'one' }, inputPolicy: 'preserve' })).toThrow()
  expect(() => rpcControlRequest('goal.create', { goalId: 'custom-goal', title: 'Current task' })).toThrow('original owner allocates Goal IDs')
  for (const key of ['id', 'demandId', 'goalId'])
    expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'original', operation: 'demand.create', title: 'Current task', [key]: 'custom-goal' })).toThrow('original owner allocates Goal IDs')
  const id = deriveBoundGoalId(address.runtimeId, address.namespace, 'original-create')
  const bound = formatGoalAddress(id, address.runtimeId, address.namespace, 'original-create')
  const short = await parseAgentMuxCliInvocation(['goal', 'focus', '--link', bound.planUrl])
  expect(short.params).toMatchObject({ goalId: id, bound: true, section: 'plan', input: 'preserve' })
  expect(rpcControlRequest('goal.focus', short.params)).toMatchObject({ target: { kind: 'goal', goalId: id, bound: true, section: 'plan' } })
})

it('Goal metadata search matches the complete source instead of a namesake Goal ID', () => {
  const target = { kind: 'goal' as const, runtimeId: 'original-runtime', namespace: 'original-namespace', goalId: 'same' }
  const metadata = { sessions: [], projects: [], sources: [], catalog: { spaces: [], zones: [], tabs: [], regions: [], locations: [], bindings: [] },
    objects: [{ target, name: 'Original Goal', identities: [], text: [], locations: [] }, { target: { ...target, namespace: 'other-namespace' }, name: 'Namesake Goal', identities: [], text: [], locations: [] }] }
  const result = searchAgentMuxMetadata(formatGoalAddress('same', target.runtimeId, target.namespace).planUrl, metadata as never)
  expect(result.objects.map(item => item.name)).toEqual(['Original Goal'])
})


it('bad Goal address metadata remains a local read issue while the original Goal stays readable', () => {
  const address = formatGoalAddress('original', 'runtime', 'namespace')
  const goal = { id: 'original', title: 'Original Goal', description: '', status: 'in_progress', priority: 'normal',
    projectId: null, projectName: null, sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null, participations: [], createdAt: 1, updatedAt: 1, source: 'default-topic',
    address: { ...address, planUrl: formatGoalAddress('namesake', 'runtime', 'namespace').planUrl } }
  const outcome = parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'original', operation: 'demand.show', ok: true, result: { demand: goal, goalContinuations: [] } })
  expect(outcome.ok).toBe(true)
  if (outcome.ok && outcome.operation === 'demand.show') {
    expect(outcome.result.demand).toMatchObject({ id: 'original', title: 'Original Goal', addressIssue: expect.stringContaining('unconfirmed') })
    expect(outcome.result.demand).not.toHaveProperty('address')
  }
})

it('a visible Plan heading cannot confirm an original graph whose real nodes are outside the viewport', async () => {
  const { readGoalReadingPresentation } = await import('../src/renderer/src/lib/desktop-presentation')
  const section = document.createElement('section'), heading = document.createElement('h2'), node = document.createElement('article')
  Object.assign(section.dataset, { goalReadingId: 'original', goalReadingRuntime: 'runtime', goalReadingNamespace: 'namespace', goalReadingSection: 'plan' })
  heading.textContent = 'Execution plan'; node.dataset.goalPlanOrigin = 'original'; section.append(heading, node); document.body.append(section)
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(320)
  const rect = (top: number) => ({ x: 0, y: top, top, left: 0, right: 600, bottom: top + 100, width: 600, height: 100, toJSON: () => ({}) })
  vi.spyOn(section, 'getBoundingClientRect').mockReturnValue(rect(0))
  const originalNode = vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect(500))
  try {
    const target = { goalId: 'original', runtimeId: 'runtime', namespace: 'namespace', section: 'plan' as const }
    expect(readGoalReadingPresentation(target)).toBeNull()
    originalNode.mockReturnValue(rect(120))
    expect(readGoalReadingPresentation(target)).toEqual({ goalId: 'original', runtimeId: 'runtime', namespace: 'namespace', section: 'plan' })
  } finally { section.remove(); vi.restoreAllMocks() }
})


it('inline Goal plan links keep their exact source URI and own object kind for copying and opening', async () => {
  const address = formatGoalAddress('original', 'original-runtime', 'original-namespace')
  const open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await dom.render(createElement(InlineObjectLink, { uri: address.planUrl, target: parseAmuxObjectLink(address.planUrl) }))
  expect(dom.container.querySelector('[data-object-link-open="goal"]')?.textContent).toContain('Goal plan')
  await dom.click('[data-object-link-open="goal"]')
  expect(open).toHaveBeenCalledWith(address.planUrl)
  await dom.click('[aria-label="Copy Goal plan link"]')
  expect(copy).toHaveBeenCalledWith(address.planUrl)
  const goalId = deriveBoundGoalId(address.runtimeId, address.namespace, 'create-original')
  const original = formatGoalAddress(goalId, address.runtimeId, address.namespace, 'create-original')
  const nodeId = 'A'.repeat(43)
  const ticketUrl = formatGoalTicketLink(goalId, original, nodeId)
  await dom.render(createElement(InlineObjectLink, { uri: ticketUrl, target: parseAmuxObjectLink(ticketUrl) }))
  expect(ticketUrl).toBe('amux://goal/' + goalId + '#T-' + nodeId)
  expect(() => parseAmuxObjectLink('amux://goal/' + goalId + '#T42')).toThrow()
  await dom.click('[aria-label="Copy Ticket link"]')
  expect(copy).toHaveBeenCalledWith(ticketUrl)
  await dom.click('[data-object-link-open="goal"]')
  expect(open).toHaveBeenCalledWith(ticketUrl)
})
