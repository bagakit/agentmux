import type { ConnectionDelivery } from '../../src/connections.js'

/** A generic original effect fact. It contains neither a message body nor platform request data. */
export function deliveryFact(operationId = 'original-delivery'): ConnectionDelivery {
  return { operationId, projectionId: 'original-projection', sourceRevision: 'source-version', bindingId: 'original-binding', bindingRevision: 3,
    reference: { hostId: 'original-host', agentSessionId: 'original-session', source: { kind: 'native', providerId: 'sample', nativeSessionId: 'original-native', recordId: 'record/成员' } },
    target: { connectionId: 'original-connection', application: { domain: 'chat.example', appId: 'original-app' }, externalConversationId: 'room/project-alpha' },
    effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending' }
}
