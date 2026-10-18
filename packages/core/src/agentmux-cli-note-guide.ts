import { guideActionsNotebook, guideSharedNoteEditing } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'
/** The short editing path shared by the module skill and detailed Note guide. */
export const AGENTMUX_NOTE_EDITING_PATH = /* @__PURE__ */ guideText(guideSharedNoteEditing)

/** Shared discovery for every managed Agent, including Agents outside Talk with Agent. */
export const AGENTMUX_NOTE_GUIDE = /* @__PURE__ */ guideText(guideActionsNotebook)
