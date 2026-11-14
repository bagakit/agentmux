export const mobileAgentLocationOwners = [
  'apps/mobile/src/navigation/MobileSpatialNavigation.tsx',
  'apps/mobile/src/navigation/MobileZoneWorkface.tsx',
  'apps/mobile/src/navigation/MobileAgentLocations.tsx',
  'apps/mobile/src/navigation/mobile-agent-locations.ts',
  'apps/mobile/test/mobile-agent-locations.test.tsx'
]
export const mobileAgentLocationMutations = {
  'ungroup-alias-contexts': { file: mobileAgentLocationOwners[2], target: 'actual App folds aliases',
    before: 'const positionKey = JSON.stringify([place.displayWorkspaceId, place.groupId, place.tabId, place.regionId])', after: 'const positionKey = locationContextKey(place)' },
  'unknown-as-zero': { file: mobileAgentLocationOwners[0], target: 'actual App folds aliases',
    before: "(groups.some(group => group.hostId === null) ? undefined : { hostId, agentSessionId: id, addresses: [], count: 0 })", after: '{ hostId, agentSessionId: id, addresses: [], count: 0 }' },
  'silent-runtime-failure': { file: mobileAgentLocationOwners[2], target: 'rejects late exact reads',
    before: "? '读取期间连接已改变，这次没有打开；请在当前目录重新选择。'", after: "? ''" },
  'count-aliases': { file: mobileAgentLocationOwners[3], target: 'actual App folds aliases',
    before: 'group.count = positions.size', after: 'group.count = group.addresses.length' },
  'inline-list': { file: mobileAgentLocationOwners[2], target: 'actual App folds aliases', edits: [
    { before: '<Dialog.Portal>', after: '<>' }, { before: '</Dialog.Portal>', after: '</>' },
    { before: 'className="mobile-sheet mobile-agent-locations-sheet"', after: 'className="mobile-agent-locations-sheet"' }
  ] },
  'late-selection': { file: mobileAgentLocationOwners[2], target: 'rejects late exact reads',
    edits: [{ before: 'if (operation !== request.current) return', after: 'if (false) return' },
      { before: 'if (operation !== request.current || now.client !== source.client || now.agentSessionId !== source.agentSessionId || now.hostId !== source.hostId || !sameOwner || !now.visible || !now.open)', after: 'if (false)' }] },
  'changed-tuple': { file: mobileAgentLocationOwners[2], target: 'Zone uses the original exact tuple',
    before: 'if (!confirmsAgentLocation(value.catalog, source.hostId, source.agentSessionId, place))', after: 'if (false)' }
}
