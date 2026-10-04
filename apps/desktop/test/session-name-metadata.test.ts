import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import type { AgentSessionNameMetadata, SessionSnapshot } from '../src/shared/contracts'
import { sessionNameMetadataFor, sessionNameMetadataRecord, sessionNamesForReferences } from '../src/renderer/src/lib/session-name-metadata'
import { workbenchAgentFactsFor, workbenchTabDisplayName } from '../src/renderer/src/lib/workbench-tab-presentation'
import { createWorkbenchTab, agentDisplayName } from '../src/renderer/src/lib/workbench-tabs'
import { regionSurfaceLabel } from '../src/renderer/src/lib/region-display-name'

const metadata: AgentSessionNameMetadata = {agentSessionId:'original',hostId:'local',providerId:'codex',executorId:'coder',workspacePath:_hygiene_fixturePath("repo"),label:'Coder · Project',state:'retired'}
const surface = {kind:'agent' as const,regionId:'region',workspaceId:'display',sessionId:'original',phase:'attached' as const}
const tab = createWorkbenchTab('original-tab', surface)

it('retains readable Tab and Region names without a live Session or changing retirement', () => {
  const names = {original:metadata}
  expect(workbenchTabDisplayName(tab, [], {}, {}, names)).toBe('Coder · Project')
  expect(regionSurfaceLabel(surface, [], names)).toBe('Coder · Project')
  expect(metadata.state).toBe('retired')
  expect(Object.keys(metadata)).not.toContain('run')
  expect(Object.keys(metadata)).not.toContain('capabilities')
})
it('keeps manual and prompt naming priority, and prefers later canonical facts', () => {
  expect(workbenchTabDisplayName(tab, [], {original:'My work'}, {}, {original:metadata})).toBe('My work')
  expect(workbenchTabDisplayName({...tab,name:'Tab title'}, [], {}, {}, {original:metadata})).toBe('Tab title')
  const live = {id:'original',kind:'agent',providerId:'codex',label:'Current · Workspace'} as SessionSnapshot
  expect(workbenchTabDisplayName(tab, [live], {}, {}, {original:metadata})).toBe('Current · Workspace')
  const timeline = {agentSessionId:'original',revision:1,items:[{kind:'user_message',content:'Fix startup'}]} as never
  expect(agentDisplayName(workbenchAgentFactsFor([], {}, {original:timeline}, {original:metadata})('original')!)).toBe('Fix startup')
  expect(workbenchTabDisplayName(tab, [], {original:'Saved manual name'}, {})).toBe('Saved manual name')
})
it('keeps unknown Provider metadata readable and absent metadata explicit', () => {
  const unknown = {...metadata,providerId:'custom-provider',label:'Custom · Project'}
  expect(workbenchTabDisplayName(tab, [], {}, {}, {original:unknown})).toBe('Custom · Project')
  expect(workbenchTabDisplayName(tab, [], {}, {})).toBe('Agent · name unconfirmed')
  expect(regionSurfaceLabel(surface, [])).toBe('Agent · name unconfirmed')
  const terminal = {...surface,kind:'terminal' as const,sessionId:'run-uuid'}
  expect(workbenchTabDisplayName(createWorkbenchTab('terminal-tab',terminal), [], {}, {})).toBe('Terminal')
})
it('matches exact execution Hosts; absent and conflicting Hosts never borrow a name', () => {
  const foreign = {...metadata,hostId:'remote',label:'Other Host'}
  const names = sessionNameMetadataRecord([metadata,foreign])
  expect(sessionNameMetadataFor(names,'original',['local'])).toBe(metadata)
  expect(sessionNameMetadataFor(names,'original',['remote'])).toBe(foreign)
  expect(sessionNameMetadataFor(names,'original',[])).toBeUndefined()
  expect(sessionNameMetadataFor(names,'original',['local','remote'])).toBeUndefined()
})
it('preserves unchanged name references when unrelated Session metadata changes', () => {
  const names = sessionNameMetadataRecord([metadata])
  expect(sessionNameMetadataRecord([{...metadata}],names)).toBe(names)
  const next = sessionNameMetadataRecord([{...metadata},{...metadata,agentSessionId:'neighbor',label:'Neighbor'}],names)
  expect(sessionNameMetadataFor(next,'original',['local'])).toBe(sessionNameMetadataFor(names,'original',['local']))
})

it('refuses a shared Tab name when repeated Session IDs have different or unknown execution Hosts', () => {
  const names = sessionNameMetadataRecord([metadata,{...metadata,hostId:'remote',label:'Remote name'}])
  expect(sessionNamesForReferences(names,[{agentSessionId:'original',hosts:['local']},{agentSessionId:'original',hosts:['remote']}])).toEqual({})
  expect(sessionNamesForReferences(names,[{agentSessionId:'original',hosts:['local']},{agentSessionId:'original',hosts:[]}])).toEqual({})
  expect(sessionNamesForReferences(names,[{agentSessionId:'original',hosts:['local']},{agentSessionId:'original',hosts:['local']}])).toEqual({original:metadata})
})
