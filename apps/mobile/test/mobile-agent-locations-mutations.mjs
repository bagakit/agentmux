export const mobileAgentLocationOwners = [
  'apps/mobile/src/navigation/MobileSpatialNavigation.tsx',
  'apps/mobile/src/navigation/MobileZoneWorkface.tsx',
  'apps/mobile/src/navigation/MobileAgentLocations.tsx',
  'apps/mobile/src/navigation/mobile-agent-locations.ts',
  'apps/mobile/test/mobile-agent-locations.test.tsx',
  'apps/mobile/src/navigation/MobileAgentRow.tsx',
  'packages/client-ui/src/patterns/agent-work-location.tsx'
]
export const mobileAgentLocationMutations = {
  'ungroup-alias-contexts': { file: mobileAgentLocationOwners[2], target: 'actual App folds aliases',
    before: 'const key = locationPositionKey(place)', after: 'const key = locationContextKey(place)' },
  'unknown-as-zero': { file: mobileAgentLocationOwners[0], target: 'actual App folds aliases',
    before: "(groups.some(group => group.hostId === null) ? undefined : { hostId, agentSessionId: id, addresses: [], summary: { state: 'confirmed' as const, count: 0 } })", after: "{ hostId, agentSessionId: id, addresses: [], summary: { state: 'confirmed' as const, count: 0 } }" },
  'silent-runtime-failure': { file: mobileAgentLocationOwners[2], target: 'rejects late exact reads',
    before: "? '读取期间连接已改变，这次没有打开；请在当前目录重新选择。'", after: "? ''" },
  'count-aliases': { file: mobileAgentLocationOwners[3], target: 'actual App folds aliases',
    before: 'positions: group.addresses.map(locationPositionKey)', after: 'positions: group.addresses.map(locationContextKey)' },
  'inline-list': { file: mobileAgentLocationOwners[2], target: 'actual App folds aliases', edits: [
    { before: '<Dialog.Portal>', after: '<>' }, { before: '</Dialog.Portal>', after: '</>' },
    { before: 'className="mobile-sheet mobile-agent-locations-sheet"', after: 'className="mobile-agent-locations-sheet"' }
  ] },
  'late-selection': { file: mobileAgentLocationOwners[2], target: 'rejects late exact reads',
    edits: [{ before: 'if (!mounted.current || operation !== request.current) return', after: 'if (false) return' },
      { before: 'if (!stillCurrent() || !sameOwner || now.beforeChoose && !now.beforeChoose())', after: 'if (false)' }] },
  'changed-tuple': { file: mobileAgentLocationOwners[3], target: 'Zone uses the original exact tuple',
    before: 'if (!catalog.locations.some(value => locationContextKey(value) === exact)) return false', after: 'if (false) return false' },
  'changed-admission': { file: mobileAgentLocationOwners[3], target: 'Zone uses the original exact tuple',
    before: 'previous.creationOperationId === current.creationOperationId &&', after: 'true &&' },
  'stale-member-catalog': { file: mobileAgentLocationOwners[2], target: 'Zone uses the original exact tuple',
    before: 'mobileMemberSelection(source.client, value.catalog, source.agentSessionId, place, source.hostId)', after: 'mobileMemberSelection(source.client, catalog, source.agentSessionId, place, source.hostId)' },
  'unqualified-member': { file: mobileAgentLocationOwners[2], target: 'Zone uses the original exact tuple',
    before: 'if (member?.issue) { setIssue(member.issue); return }', after: 'if (false) return' },
  'same-label': { file: 'packages/client-ui/src/patterns/agent-work-location.tsx', target: 'actual App folds aliases',
    before: 'if (!peers.length) return choice', after: 'if (true) return choice' }
}
