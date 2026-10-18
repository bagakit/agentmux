import { guideSharedMessagingContract, guideSharedMessagingEntry, guideSharedMessagingReminder } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'

/** Shared system communication contract; edit guides/shared/messaging/*.md. */
export const AGENTMUX_AGENT_MESSAGING_GUIDANCE = /* @__PURE__ */ guideText(guideSharedMessagingContract)
export const AGENTMUX_AGENT_MESSAGING_ENTRY = /* @__PURE__ */ guideText(guideSharedMessagingEntry)
export const AGENTMUX_A2A_REMINDER = /* @__PURE__ */ guideText(guideSharedMessagingReminder)
