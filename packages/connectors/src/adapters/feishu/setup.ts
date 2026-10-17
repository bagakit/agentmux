import type { ConnectionSetupAdapter } from '../../connection-setup-adapter.js'
import { beginFeishuSession, advanceFeishuSession, continueFeishuEnrollment, inspectFeishuApplication, readFeishuApplication, feishuMessagingCapability, enableFeishuMessaging, feishuEventTransportCapability, useFeishuPersistentConnection, addFeishuApplicationPermissions, addFeishuMessageReception, createFeishuVersion, submitFeishuVersion, feishuCallbackTransportCapability, useFeishuPersistentCallback, feishuCardActionsCapability, addFeishuCardActions } from './setup-session.js'

import { reviewFeishuPublication } from './setup-publication.js'
import { reviewFeishuPermissions } from './setup-permissions.js'
import { reviewFeishuMessageReception } from './setup-message-reception.js'

/** Reference-native Feishu authentication; no Lark or app-management eligibility is inferred. */
export function createFeishuSetup(): ConnectionSetupAdapter {
  return {
    domains: ['open.feishu.cn'],
    begin: beginFeishuSession,
    advance: advanceFeishuSession,
    enrollmentContinuation: { domains: ['open.feishu.cn'], resume: continueFeishuEnrollment },
    applicationConfiguration: { initialPublicationDraft: async input => ({ kind: 'create-version', version: input.version, notes: input.notes, visibility: 'creator-only', desktopEntry: 'bot', mobileEntry: 'bot' }), callbackTransportCapability: feishuCallbackTransportCapability, usePersistentCallback: useFeishuPersistentCallback, cardActionsCapability: feishuCardActionsCapability, addCardActions: addFeishuCardActions, domains: ['open.feishu.cn'], publicationPlan: async (...input) => reviewFeishuPublication(...input), createVersion: createFeishuVersion, submitVersion: submitFeishuVersion, messagingCapability: feishuMessagingCapability, enableMessaging: enableFeishuMessaging, eventTransportCapability: feishuEventTransportCapability, usePersistentConnection: useFeishuPersistentConnection, permissionPlan: async (...input) => reviewFeishuPermissions(...input), addApplicationPermissions: addFeishuApplicationPermissions, messageReceptionPlan: async (...input) => reviewFeishuMessageReception(...input), addMessageReception: addFeishuMessageReception },
    applicationInspection: { domains: ['open.feishu.cn'], inspect: inspectFeishuApplication, read: readFeishuApplication }
  }
}
