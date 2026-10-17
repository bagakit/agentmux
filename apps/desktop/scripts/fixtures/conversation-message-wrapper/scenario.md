# A2A common reading qualification

Owning behavior: [Conversation declarations and original reading](../../../../../docs/design/behavior/conversation-mode.md#完整前导声明上下文的同记录阅读), [A2A envelope](../../../../../docs/design/behavior/a2a-collaboration.md#a2a-身份信封与持久化全局消息队列). Presentation: [common conversation](../../../../../docs/design/presentation/conversation-mode.md).

Run `node apps/desktop/scripts/verify-conversation-message-wrapper.mjs --prepare` from this candidate. It runs nonempty owning tests, five in-memory source mutations, related declaration/long-text/Copy regressions, restored tests and shared UI types, then builds original Desktop/Mobile/shared components and CSS for an isolated Electron reading scene. It writes a versioned receipt and full PNGs under `.tmp/a2a-conversation-wrapper/run-*`.

Actual source modules and the Node-loaded Core build modules are hash-bound to the receipt. The public frame comes from the actual built-in Claude history reader, public Core and private FileStore; native authors remain unknown. Transport observations and exact deferred resource bytes are controlled. No Agent Run/model, physical phone, installed App, user workspace or recovery behavior is claimed.

Scenes: Desktop 1000px and 332px in dark and light themes, reminder keyboard expansion, actual Mobile 390px, Mobile reminder expansion, complete resource, and a status update preserving the original Range/disclosure/draft. Copy compares original full wire; reading performs no input control.

An independent Agent opens every full PNG and assesses body precedence, restrained guidance, source clarity, narrow layout, resource reading and controls. Keep its judgment and image hashes in that run's `review.json`. `captureOnly` is never visual acceptance. After review, the ordinary `node apps/desktop/scripts/verify-conversation-message-wrapper.mjs` command verifies current sources and proof and consumes the exact independent review. A changed implementation requires a new run and new visual review.
