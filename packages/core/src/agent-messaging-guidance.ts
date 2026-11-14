import { guideSharedChannelInstantReply, guideSharedMessagingContract, guideSharedMessagingEntry, guideSharedMessagingReferenceReminder, guideSharedMessagingReminder, guideSharedSessionNaming } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'

/** Shared system communication contract; edit guides/shared/messaging/*.md. */
export const AGENTMUX_AGENT_MESSAGING_GUIDANCE = /* @__PURE__ */ guideText(guideSharedMessagingContract)
export const AGENTMUX_AGENT_MESSAGING_ENTRY = /* @__PURE__ */ guideText(guideSharedMessagingEntry)
/** Task-onset self-naming discovery; detailed naming rules stay in name --skill. */
export const AGENTMUX_SESSION_NAMING_ENTRY = /* @__PURE__ */ guideText(guideSharedSessionNaming)
export const AGENTMUX_A2A_REMINDER = /* @__PURE__ */ guideText(guideSharedMessagingReminder)
export const AGENTMUX_A2A_REFERENCE_REMINDER = /* @__PURE__ */ guideText(guideSharedMessagingReferenceReminder)
/** How to reply in a connected chat; edit guides/shared/channel/instant-reply.md. */
export const AGENTMUX_CHANNEL_INSTANT_REPLY = /* @__PURE__ */ guideText(guideSharedChannelInstantReply)
