import { guideActionsRemoteExecution } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'

/** The same offline operating guide is consumed by Settings and CLI help. */
export const AGENT_EXECUTION_GUIDE = /* @__PURE__ */ guideText(guideActionsRemoteExecution)
