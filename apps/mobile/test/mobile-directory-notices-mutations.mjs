export const directoryNoticeMutations = {
  'global-session-warning': { file: 'apps/mobile/src/MobileApp.tsx',
    before: 'const serviceNotices = [...new Set([notice, hostAppearance.issue,',
    after: 'const serviceNotices = [...new Set([conversationStatusLabel, notice, hostAppearance.issue,', target: 'scopes missing selected-session metadata' },
  'lost-session-diagnostic': { file: 'apps/mobile/src/conversation/MobileConversationStatus.tsx',
    before: 'return <section className="mobile-session-diagnostic"',
    after: 'return <section hidden className="mobile-session-diagnostic"', target: 'scopes missing selected-session metadata' },
  'no-directory-refresh': { file: 'apps/mobile/src/navigation/MobileDirectoryNotice.tsx', before: 'onClick={retry}', after: 'onClick={() => {}}', target: 'keeps focus issues' },
  'lost-directory-reason': { file: 'apps/mobile/src/navigation/MobileDirectoryNotice.tsx', before: '<p>{issue.message}</p>', after: '<p>资料未确认</p>', target: 'keeps focus issues' }
}
