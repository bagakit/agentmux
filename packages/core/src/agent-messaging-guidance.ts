import { guideSharedMessagingContract } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'
import { getAmuxProtocolTemplate } from './amux-protocol.js'

/** Shared communication contract from the Message CLI guide. */
export const AGENTMUX_AGENT_MESSAGING_GUIDANCE = /* @__PURE__ */ guideText(guideSharedMessagingContract)
export const AGENTMUX_AGENT_MESSAGING_ENTRY = /* @__PURE__ */ getAmuxProtocolTemplate('peer-messaging', 'entry')
export const AGENTMUX_SESSION_NAMING_ENTRY = /* @__PURE__ */ getAmuxProtocolTemplate('agent-runtime', 'naming')
export const AGENTMUX_A2A_REMINDER = /* @__PURE__ */ getAmuxProtocolTemplate('peer-messaging', 'reminder')
export const AGENTMUX_A2A_REFERENCE_REMINDER = /* @__PURE__ */ getAmuxProtocolTemplate('peer-messaging', 'reference')
export const AGENTMUX_CHANNEL_INSTANT_REPLY = /* @__PURE__ */ getAmuxProtocolTemplate('channel-input', 'reply')
