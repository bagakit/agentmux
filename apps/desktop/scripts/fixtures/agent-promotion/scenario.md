# Agent Promotion — private production Renderer

Production consumers: AgentRegionHeader → AgentMenuContent → useAgentPromotion → AgentPromotionDialog and SettingsPanel → Promotion settings → ConfigOwner bridge. Real styles and theme runtime. Only RPC/config replies are controlled; the workspace wrapper is a private scene, not a claim about installed App or native provider behavior.

Capture: `node apps/desktop/scripts/fixtures/agent-promotion/capture.mjs`.

Cover normal and narrow settings (allowed/off/saved), actual Agent menu, confirmation, writing intermediate frame, partial recovery with policy off, reduced motion and completed local feedback. Preserve original Session/Run/cwd, Tabs/layouts, input/draft and focus; capture never operates user data.
