# Agent Promotion — private production Renderer

Production consumers: AgentRegionHeader → AgentMenuContent → useAgentPromotion → AgentPromotionDialog and TopicActionsMenu → shared Promotion icon, plus SettingsPanel → Promotion settings → ConfigOwner bridge. Real styles and theme runtime. Only RPC/config replies are controlled; the workspace wrapper is a private scene, not a claim about installed App or native provider behavior.

Capture: `node apps/desktop/scripts/fixtures/agent-promotion/capture.mjs`.

Cover normal and narrow settings (allowed/off/saved), actual Agent menu, confirmation, writing intermediate frame, partial recovery with policy off, reduced motion and completed local feedback. Preserve original Session/Run/cwd, Tabs/layouts, input/draft and focus; capture never operates user data.

Menu refinement also covers English Agent and Topic actions with the same Promotion glyph, normal/narrow Agent menus, both menus in dark/light themes and the actual Promotion settings leaf. Glyph quality is judged from the complete real Renderer screenshots by the independent reviewer; shape-validation or DOM assertions do not replace that judgment.
