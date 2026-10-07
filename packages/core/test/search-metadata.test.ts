import { describe, expect, it } from 'vitest'
import { searchAgentMuxMetadata, type AgentMuxSearchMetadata } from '../src/search-metadata.js'
import { formatAmuxObjectLink } from '../src/sharing.js'

const facts = (): AgentMuxSearchMetadata => ({
  sessions: [
    { agentSessionId: 'CaseAgent', hostId: 'host-a', kind: 'agent', workspaceId: 'resource-workspace', identities: ['RetainedRun', 'NativeConversation'], text: ['A readable task', 'feature/blue'] },
    { agentSessionId: 'CaseAgent', hostId: 'host-b', kind: 'agent', identities: ['OtherNative'], text: ['Other host'] },
    { agentSessionId: 'PlainTerminal', hostId: 'host-a', kind: 'terminal', identities: ['TerminalRun'], text: ['Shell output'] }
  ], sources: [], projects: [{ hostId: 'host-a', projectId: 'real-project', name: 'Original project', sessionIds: ['CaseAgent'] }],
  catalog: {
    spaces: [{ spaceId: 'FolderSpace', kind: 'folder', name: 'Folder', hostId: 'host-a', directoryPath: 'workspace-root', projectId: 'real-project' }],
    zones: [
      { zoneId: 'OriginalZone', workspaceId: 'resource-workspace', kind: 'directory', hostId: 'host-a', directoryPath: 'workspace-root', branch: 'feature/blue' },
      { zoneId: 'AdjacentZone', workspaceId: 'resource-workspace', kind: 'directory', hostId: 'host-a', directoryPath: 'workspace-root', branch: null }
    ], bindings: [{ zoneId: 'OriginalZone', spaceId: 'FolderSpace' }],
    tabs: [{ tabId: 'OriginalTab', zoneId: 'OriginalZone', workspaceId: 'resource-workspace', name: 'Work', regionIds: ['OriginalRegion'] }],
    regions: [{ regionId: 'OriginalRegion', tabId: 'OriginalTab', kind: 'agent', agentSessionId: 'CaseAgent', runId: 'CurrentRun', execution: { hostId: 'host-a', cwd: 'workspace-root' } }],
    locations: ['GroupOne', 'GroupTwo'].map(groupId => ({ spaceId: 'FolderSpace', zoneId: 'OriginalZone', workspaceId: 'resource-workspace', displayWorkspaceId: 'display-workspace', groupId, tabId: 'OriginalTab', regionId: 'OriginalRegion' }))
  }
})

describe('Core original-object metadata search', () => {
  it('separates literal identity matching, text and typed Agent links from Terminal identity', () => {
    const input = facts(), before = structuredClone(input)
    for (const query of ['RetainedRun', 'NativeConversation', 'READABLE TASK', 'feature/blue', 'real-project']) {
      expect(searchAgentMuxMetadata(query, input).sessions).toEqual([{ hostId: 'host-a', agentSessionId: 'CaseAgent', kind: 'agent' }])
    }
    expect(searchAgentMuxMetadata('nativeconversation', input).sessions).toEqual([])
    expect(searchAgentMuxMetadata('PlainTerminal', input).sessions).toEqual([{ hostId: 'host-a', agentSessionId: 'PlainTerminal', kind: 'terminal' }])
    expect(searchAgentMuxMetadata(formatAmuxObjectLink({ kind: 'agent', agentSessionId: 'PlainTerminal' }), input).sessions).toEqual([])
    expect(searchAgentMuxMetadata('amux://agent/', input).issue).toBeTruthy()
    expect(input).toEqual(before)
  })

  it('keeps exact Host and original Zone membership and every display occurrence', () => {
    const input = facts()
    expect(searchAgentMuxMetadata(formatAmuxObjectLink({ kind: 'region', regionId: 'OriginalRegion' }), input).sessions).toEqual([{ hostId: 'host-a', agentSessionId: 'CaseAgent', kind: 'agent' }])
    expect(searchAgentMuxMetadata(formatAmuxObjectLink({ kind: 'zone', zoneId: 'AdjacentZone' }), input).sessions).toEqual([])
    const result = searchAgentMuxMetadata(formatAmuxObjectLink({ kind: 'tab', tabId: 'OriginalTab' }), input)
    expect(result.locations.map(location => location.reference.groupId)).toEqual(['GroupOne', 'GroupTwo'])
    expect(searchAgentMuxMetadata('GroupTwo', input).locations.map(location => location.reference.groupId)).toEqual(['GroupTwo'])
    expect(searchAgentMuxMetadata('workspace-root', input).unplaced).toContainEqual({ kind: 'zone', id: 'AdjacentZone', name: 'workspace-root' })
    expect(searchAgentMuxMetadata('OtherNative', input).sessions).toEqual([{ hostId: 'host-b', agentSessionId: 'CaseAgent', kind: 'agent' }])
  })

  it('does not collapse link types when original object IDs happen to be equal', () => {
    const input = facts()
    input.catalog.spaces.push({ spaceId: 'CaseAgent', kind: 'container', name: 'Same scalar identity', hostId: 'host-a', directoryPath: 'container-root', projectId: null })
    const result = searchAgentMuxMetadata(formatAmuxObjectLink({ kind: 'space', spaceId: 'CaseAgent' }), input)
    expect(result.sessions).toEqual([])
    expect(result.unplaced).toEqual([{ kind: 'space', id: 'CaseAgent', name: 'Same scalar identity' }])
    Object.defineProperty(input, 'catalog', { get() { throw Error('Empty query must not traverse unrelated spatial facts') } })
    expect(searchAgentMuxMetadata('', input).sessions).toHaveLength(3)
  })

  it('keeps unknown execution positions searchable without assigning their identities to a lone Session candidate', () => {
    const input = facts()
    input.sessions = input.sessions.filter(session => session.hostId === 'host-a')
    input.catalog.regions[0]!.execution = null
    const query = formatAmuxObjectLink({ kind: 'region', regionId: 'OriginalRegion' })
    const result = searchAgentMuxMetadata(query, input)
    expect(result.locations.map(location => location.reference.groupId)).toEqual(['GroupOne', 'GroupTwo'])
    expect(result.sessions).toEqual([])
    expect(searchAgentMuxMetadata('CaseAgent', input).sessions).toEqual([{ hostId: 'host-a', agentSessionId: 'CaseAgent', kind: 'agent' }])
    input.catalog.regions[0]!.execution = { hostId: 'host-b', cwd: 'original-resource' }
    expect(searchAgentMuxMetadata(query, input).sessions).toEqual([])
    input.catalog.regions[0]!.execution = { hostId: 'host-a', cwd: 'original-resource' }
    expect(searchAgentMuxMetadata(query, input).sessions).toEqual([{ hostId: 'host-a', agentSessionId: 'CaseAgent', kind: 'agent' }])
  })
})
