export const mobileAgentLocationOwners = [
  'apps/mobile/src/navigation/MobileSpatialNavigation.tsx',
  'apps/mobile/src/navigation/MobileZoneWorkface.tsx',
  'apps/mobile/src/navigation/MobileAgentLocations.tsx',
  'apps/mobile/src/navigation/mobile-agent-locations.ts',
  'apps/mobile/test/mobile-agent-locations.test.tsx'
]
export const mobileAgentLocationMutations = {
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
