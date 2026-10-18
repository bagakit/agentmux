import { guideActionsGoalCreate, guideActionsSettings, guideActionsToolkit } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'
export const AGENTMUX_SETTINGS_RESOURCE_GUIDE = /* @__PURE__ */ guideText(guideActionsSettings)

export const AGENTMUX_TOOLKIT_GUIDE = /* @__PURE__ */ guideText(guideActionsToolkit)

export const AGENTMUX_GOAL_CREATE_GUIDE = /* @__PURE__ */ guideText(guideActionsGoalCreate)
