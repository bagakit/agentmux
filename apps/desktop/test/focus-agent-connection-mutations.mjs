const hook = 'apps/desktop/src/renderer/src/lib/use-agent-connector-menu.tsx'
export const connectionMutations = [
  { label: 'no-invented-region', file: hook, test: 'canonical Session identity and no Region',
    before: '...(regionId ? { regionAnchor: { regionId } } : {})', after: 'regionAnchor: { regionId: regionId ?? "" }' },
  { label: 'canonical-session-not-presentation-alias', file: hook, test: 'canonical Session identity and no Region',
    before: 'agentSessionId: session.control.agentSessionId', after: 'agentSessionId: session.id' },
  { label: 'exact-original-subject', file: hook, test: 'changed original subject',
    before: 'agentMenuSession(current.sessions, options.source)', after: 'sessionId ? sessionPresentationById(current.sessions).get(sessionId) : undefined' },
  { label: 'closed-observer-release', file: hook, test: 'closed Focus cards',
    before: 'observing ? useAppStore.subscribe(listener) : () => {}', after: 'useAppStore.subscribe(listener)' },
  { label: 'session-only-details-remain-available', file: 'apps/desktop/src/renderer/src/components/AgentConnections.tsx', test: 'Session-only AgentConnections',
    before: 'const anchor = regionId', after: 'const anchor = regionId; if (!anchor) return' }
]
