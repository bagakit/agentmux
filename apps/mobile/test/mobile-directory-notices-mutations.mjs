export const directoryNoticeMutations = {
  'global-session-warning': { file: 'apps/mobile/src/MobileApp.tsx',
    before: 'const visibleProjectionError = workspaceVisible && showSession ? projectionError : null',
    after: 'const visibleProjectionError = projectionError', target: 'scopes missing selected-session metadata' },
  'lost-session-diagnostic': { file: 'apps/mobile/src/MobileApp.tsx',
    before: 'projectionError && workface.selectedSessionId && <section className="mobile-session-diagnostic">',
    after: 'false && <section className="mobile-session-diagnostic">', target: 'scopes missing selected-session metadata' },
  'no-directory-refresh': { file: 'apps/mobile/src/navigation/MobileDirectoryNotice.tsx', before: 'onClick={retry}', after: 'onClick={() => {}}', target: 'keeps focus issues' },
  'lost-directory-reason': { file: 'apps/mobile/src/navigation/MobileDirectoryNotice.tsx', before: '<p>{issue.message}</p>', after: '<p>资料未确认</p>', target: 'keeps focus issues' }
}
