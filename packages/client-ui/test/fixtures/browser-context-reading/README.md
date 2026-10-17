# Browser context reading scene

The scene mounts the production shared `ConversationView`, complete-resource reader and `InputMailboxRecords` with fixed Core-shaped records. It uses the actual Desktop tokens and shared theme runtime, including the semantic icon sprite. The host adapter records Copy arguments privately; no user clipboard, Agent, Browser page or model service is operated.

Run `node packages/client-ui/scripts/capture-browser-context-reading.mjs` from the workspace. The command compiles the candidate sources and opens a private Electron profile, exercises ordinary conversation, explicit complete-resource reading and the original mailbox disclosure, then captures normal/narrow dark/light scenes. Context starts collapsed; the probe explicitly opens one observation for full provenance reading. The mailbox fixture represents a saved input still waiting for confirmation, not a delivered message.

Independent review checks the complete frames for body priority, quiet collapsed context, readable page/step and separate selection provenance, narrow wrapping, theme contrast and existing Copy/detail controls. The screenshot and source receipt are evidence for this shared reading slice only. Full Desktop and native Browser integration retain their own product acceptance; capture success and geometry assertions do not approve aesthetics.

Requirements: [scene input behavior](../../../../../docs/design/behavior/conversation-input.md#场景化用户输入), [same-record reading](../../../../../docs/design/presentation/conversation-mode.md#声明与系统来源), and [amux data boundaries](../../../../../docs/specs/amux-protocol.md#场景数据).
