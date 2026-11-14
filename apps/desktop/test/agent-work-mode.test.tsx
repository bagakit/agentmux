// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { agentWorkPlacement, workReferenceHostId } from '../src/renderer/src/lib/agent-work-mode'
import { AgentWorkModeBadge } from '../src/renderer/src/components/AgentWorkModeBadge'
import { retainedFocusContext, createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const hosts = [...composerConfig.hosts, { id: 'other', kind: 'ssh' as const, hostname: 'fixture.invalid', label: 'Other Mac' }]
const binding = { bindingId: 'original', resourceRuntimeId: 'physical-project', resourceHostId: 'original-alias', workspacePath: '/project' }
it.each([
  ['local', 'local', 'local'], ['local', 'other', 'remote-project'],
  ['other', 'local', 'remote-agent'], ['other', 'other', 'remote-workspace'], ['other', null, 'unknown']
] as const)('actual identity badge projects Agent %s / project %s as %s', async (agentHostId, resourceHostId, mode) => {
  const source = { hostId: agentHostId, workspacePath: '/agent', toolExecution: binding, workPlacement: { agentHostId, resourceHostId } }
  const before = structuredClone(source)
  await dom.render(<AgentWorkModeBadge source={source} hosts={hosts} />)
  expect(agentWorkPlacement(source, workReferenceHostId(hosts)).mode).toBe(mode)
  if (mode === 'local') expect(dom.container.querySelector('[data-work-mode]')).toBeNull()
  else expect(dom.container.querySelector('[data-work-mode]')?.getAttribute('data-work-mode')).toBe(mode)
  expect(source).toEqual(before)
})
it('ordinary remote Agent needs no fake binding; raw coordinator local cannot claim observer local', () => {
  expect(agentWorkPlacement({ hostId: 'other', workspacePath: '/project' }, 'local').mode).toBe('remote-workspace')
  expect(agentWorkPlacement({ hostId: 'other', workspacePath: '/agent', toolExecution: { ...binding, resourceHostId: 'local' } }, 'local')).toMatchObject({ mode: 'unknown', projectHostId: null })
})
it('retained identity carries original binding and client projection without inventing a current Run', () => {
  const source = { hostId: 'other', agentSessionId: 'old-agent', state: 'retained' as const,
    history: { ...composerSession(), toolExecution: binding }, workPlacement: { agentHostId: 'other', resourceHostId: 'local' } }
  const retained = retainedFocusContext(source as Parameters<typeof retainedFocusContext>[0])
  expect(retained.toolExecution).toBe(binding)
  expect(agentWorkPlacement(retained, 'local').mode).toBe('remote-agent')
  expect(retained.runUnobserved).toBe(true)
  expect(retained.liveAgent).toBe(false)
})

it('Focus cache retains equal placement clones and updates only the changed Agent when route facts change',()=>{
  const session={...composerSession(),toolExecution:binding,workPlacement:{agentHostId:'local',resourceHostId:'other'}}
  const other={...composerSession('unchanged'),toolExecution:binding,workPlacement:{agentHostId:'local',resourceHostId:'other'}}
  const input={sessions:[session,other],config:composerConfig,timelines:{},agentNames:{},scratchTopicSnapshots:{}}
  const select=createFocusProjectionSelector(),before=select(input)
  const same=select({...input,sessions:[{...session,toolExecution:{...binding},workPlacement:{...session.workPlacement}},other]})
  expect(same.contexts).toBe(before.contexts)
  const changed=select({...input,sessions:[{...session,workPlacement:{agentHostId:'local',resourceHostId:null}},other]})
  expect(agentWorkPlacement(changed.contexts.find(row=>row.id===session.id)!, 'local').mode).toBe('unknown')
  expect(changed.contexts.find(row=>row.id===other.id)).toBe(before.contexts.find(row=>row.id===other.id))
})
