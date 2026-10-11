import type { ConnectionSetupAdapter } from '../../connection-setup-adapter.js'
import { beginFeishuSession, advanceFeishuSession, continueFeishuEnrollment, inspectFeishuApplication, readFeishuApplication, feishuMessagingCapability, enableFeishuMessaging, feishuEventTransportCapability, useFeishuPersistentConnection, addFeishuApplicationPermissions, addFeishuMessageReception } from './setup-session.js'

import { reviewFeishuPermissions } from './setup-permissions.js'
import { reviewFeishuMessageReception } from './setup-message-reception.js'

/** Reference-native Feishu authentication; no Lark or app-management eligibility is inferred. */
export function createFeishuSetup(): ConnectionSetupAdapter {
  return {
    domains: ['open.feishu.cn'],
    begin: beginFeishuSession,
    advance: advanceFeishuSession,
    enrollmentContinuation: { domains: ['open.feishu.cn'], resume: continueFeishuEnrollment },
    applicationConfiguration: { domains: ['open.feishu.cn'], messagingCapability: feishuMessagingCapability, enableMessaging: enableFeishuMessaging, eventTransportCapability: feishuEventTransportCapability, usePersistentConnection: useFeishuPersistentConnection, permissionPlan: async (...input) => reviewFeishuPermissions(...input), addApplicationPermissions: addFeishuApplicationPermissions, messageReceptionPlan: async (...input) => reviewFeishuMessageReception(...input), addMessageReception: addFeishuMessageReception },
    applicationInspection: { domains: ['open.feishu.cn'], inspect: inspectFeishuApplication, read: readFeishuApplication }
  }
}
