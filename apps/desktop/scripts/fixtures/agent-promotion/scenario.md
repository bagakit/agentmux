# Agent Promotion — private production Renderer

Production consumers: AgentRegionHeader → AgentMenuContent and TopicActionsMenu → shared Promotion icon, plus SettingsPanel → Promotion settings. Real styles and theme runtime. Configuration replies are controlled; the workspace wrapper is a private scene, not a claim about the ConfigOwner, installed App or native provider behavior.

Capture: `node apps/desktop/scripts/fixtures/agent-promotion/capture.mjs`.

Cover normal and narrow settings (allowed/off/saved), light settings, and the actual Agent and Topic menus. `--settings-only` retains the four original Settings scenes. Preserve original Session/Run/cwd, Tabs/layouts and input/draft; capture never operates user data.

Built-in Agent Takeover selection, progress, unknown/partial recovery and retirement now use the shared Takeover probe and the `takeover-flow`/`takeover-flow-main` tests. This fixture does not open the removed association Dialog, create an association, or sign that separate capability.

Menu refinement also covers English Agent and Topic actions with the same Promotion glyph, normal/narrow Agent menus, both menus in dark/light themes and the actual Promotion settings leaf. Glyph quality is judged from the complete real Renderer screenshots by the independent reviewer; shape-validation or DOM assertions do not replace that judgment.
