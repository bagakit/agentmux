/** Production mutations for the phone chrome; each must turn exactly its bearing test red through an assertion. */
export const mobileChromeMutations = {
  'bar-in-conversation': { file: 'apps/mobile/src/MobileApp.tsx',
    before: '{rootPage && <footer className="mobile-navigation-bar"', after: '{workspaceVisible && <footer className="mobile-navigation-bar"',
    target: 'shows the tab bar on the five directories' },
  'team-row-duplicate': { file: 'apps/mobile/src/MobileApp.tsx',
    before: '{moteContext && teamSpaceId ? <MobileMoteContext',
    after: '{moteContext === \'member\' ? <div className="mobile-mote-recipient">{sessionTitle}</div> : null}{moteContext && teamSpaceId ? <MobileMoteContext',
    target: 'names a Mote member once' },
  'conversation-remount': { file: 'apps/mobile/src/MobileApp.tsx',
    before: '{workface.selectedSessionId && <MobileConversationSurface', after: '{workface.selectedSessionId && showSession && <MobileConversationSurface',
    target: 'returns between Focus and the open conversation three times' }
}
