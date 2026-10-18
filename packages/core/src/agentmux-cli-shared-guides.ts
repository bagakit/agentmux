import { guideActionsAgentNative, guideActionsAgentOpen, guideActionsDevice, guideActionsGit, guideSharedDiagnostic, guideSharedGoalActivity, guideSharedSpatial } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'
/** Domain guidance shared by local module skill and exact command help. */
export const NATIVE_RESUME_GUIDE = /* @__PURE__ */ guideText(guideActionsAgentNative)
export const GIT_GUIDE = /* @__PURE__ */ guideText(guideActionsGit)

export const DIAGNOSTIC_GUIDE = /* @__PURE__ */ guideText(guideSharedDiagnostic)

export const SPATIAL_GUIDE = /* @__PURE__ */ guideText(guideSharedSpatial)

export const DEVICE_GUIDE = /* @__PURE__ */ guideText(guideActionsDevice)

export const AGENT_OPEN_WORKFLOW = /* @__PURE__ */ guideText(guideActionsAgentOpen)

export const GOAL_ACTIVITY_GUIDE = /* @__PURE__ */ guideText(guideSharedGoalActivity)
