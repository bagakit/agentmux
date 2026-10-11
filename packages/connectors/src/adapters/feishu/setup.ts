import type { ConnectionSetupAdapter } from '../../connection-setup-adapter.js'
import { beginFeishuSession, advanceFeishuSession, continueFeishuEnrollment, inspectFeishuApplication, readFeishuApplication, feishuMessagingCapability, enableFeishuMessaging } from './setup-session.js'

/** Reference-native Feishu authentication; no Lark or app-management eligibility is inferred. */
export function createFeishuSetup(): ConnectionSetupAdapter {
  return {
    domains: ['open.feishu.cn'],
    begin: beginFeishuSession,
    advance: advanceFeishuSession,
    enrollmentContinuation: { domains: ['open.feishu.cn'], resume: continueFeishuEnrollment },
    applicationConfiguration: { domains: ['open.feishu.cn'], messagingCapability: feishuMessagingCapability, enableMessaging: enableFeishuMessaging },
    applicationInspection: { domains: ['open.feishu.cn'], inspect: inspectFeishuApplication, read: readFeishuApplication }
  }
}
