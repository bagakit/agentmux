/** Production mutations for the phone chrome; each must turn exactly its bearing test red through an assertion. */
export const mobileChromeMutations = {
  'goals-create-missing': { file: 'apps/mobile/src/goals/MobileGoalsSurface.tsx',
    before: '<button type="button" className="mobile-icon-button mobile-goals-new" aria-label="新建目标" title="新建目标" aria-expanded={createOpen} onClick={() => setCreateOpen(value => !value)}><SemanticIcon name="action.add-item" size={20} /></button>',
    after: '{null}',
    target: 'opens the original new Goal form from the header' },
  'avatar-notice-bottom': { file: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx',
    edits: [
      { before: '{visible && <MobileAvatarNoticeOutlet header />}', after: '' },
      { before: '</section></MobileNoticeScope>', after: '{visible && <MobileAvatarNoticeOutlet />}</section></MobileNoticeScope>' }
    ],
    testFile: 'mobile-avatar-notice-consumer.test.tsx', target: 'groups same-name Space failures into one notice' },

  'bar-in-conversation': { file: 'apps/mobile/src/MobileApp.tsx',
    before: '{rootPage && <footer className="mobile-navigation-bar"', after: '{workspaceVisible && <footer className="mobile-navigation-bar"',
    target: 'shows the tab bar on the five directories' },
  'team-row-duplicate': { file: 'apps/mobile/src/MobileApp.tsx',
    before: '{moteContext && teamSpaceId ? <MobileMoteContext',
    after: '{moteContext === \'member\' ? <div className="mobile-mote-recipient">{sessionTitle}</div> : null}{moteContext && teamSpaceId ? <MobileMoteContext',
    target: 'names a Mote member once' },
  'conversation-remount': { file: 'apps/mobile/src/MobileApp.tsx',
    before: '{workface.selectedSessionId && <MobileConversationSurface', after: '{workface.selectedSessionId && showSession && <MobileConversationSurface',
    target: 'returns between Focus and the open conversation three times' },
  'drawer-connection-missing': { file: 'apps/mobile/src/MobileApp.tsx',
    before: "<MobileDrawerConnection connection={connection} label={label} appIcon={hostAppearance.appIcon} address={location.host} onOpen={() => setSheet('connection')} />", after: '{null}',
    target: 'leads the drawer with the Mac connection card' },
  'terminal-second-row': { file: 'apps/mobile/src/MobileApp.tsx',
    before: 'const moteContext = workspaceVisible && showSession && teamSpaceId && !workPanel ?', after: 'const moteContext = workspaceVisible && showSession && teamSpaceId ?',
    target: 'keeps the terminal under its one header without the Mote context strip' }
}
