# Derived actions visual scene

Real `SettingsPanel` → Derived actions and `SessionTakeoverSurface` compiled with preview configuration.

- Contract: [Agent 派生动作](../../../../../docs/design/behavior/agent-capabilities-and-messaging.md#agent-派生动作), [Derived actions 库与编辑工作面](../../../../../docs/design/presentation/settings-and-observation.md#derived-actions-库与编辑工作面), [接手的中央 Agent 选择](../../../../../docs/design/presentation/session-recovery.md#接手的中央-agent-选择).
- Preview data: two custom actions (one new-agent with a default Agent, one fork) and Pass on experience hidden.
- Frames: official and custom rows in dark and light, a hidden official action, a narrow custom editor, and the custom takeover surface in dark wide and light narrow.
- Boundary: capture only. Saves stay in the document; durable saves, the resource owner and `agent open --derive` are proved by their owning tests. No user data, Core, PTY or Run is touched.

Run from the repository root: `node apps/desktop/scripts/capture-derived-actions-settings.mjs`. The command prints the private evidence directory; open each PNG for review.
