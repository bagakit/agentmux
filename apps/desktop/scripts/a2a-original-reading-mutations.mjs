export const originalReadingMutations = [
  { name: 'unqualified-wire-fetch', path: 'packages/client-ui/src/components/ConversationMessage.tsx',
    before: 'const a2aReferenceScope = a2aNotificationId ?', after: 'const a2aReferenceScope = executionHostId ?' },
  { name: 'recipient-unchecked', path: 'packages/client-ui/src/components/ConversationA2AReferences.tsx',
    before: 'envelope.recipientSessionId !== scope.agentSessionId ||', after: 'false ||' },
  { name: 'decoded-body-reparsed', path: 'packages/client-ui/src/components/ConversationA2AReferences.tsx',
    before: 'content={envelope.body} contentBoundary="body"', after: 'content={envelope.body} contentBoundary="wire"' },
  { name: 'late-owner-applied', path: 'packages/client-ui/src/components/ConversationA2AReferences.tsx',
    before: 'if (!retained) return', after: 'if (false) return' },
  { name: 'resource-scope-lost', path: 'packages/client-ui/src/components/ConversationResourceText.tsx',
    before: 'a2aReferenceScope={a2aReferenceScope}', after: 'a2aReferenceScope={undefined}' },
  { name: 'sender-identity-hidden', path: 'packages/client-ui/src/components/ConversationA2AReferences.tsx',
    before: 'compact recordedIdentity expandedContent', after: 'compact recordedIdentity detailsOnlyMetadata expandedContent' }
]
