# 原 Profile 的记忆检查

沿当前 Mote Profile 展开原 MEMORY，读保存正文，回原 Editor 更正，再回同一 Profile 核对；现有 New discussion 入口仍由真实 Launcher 承载。正常/窄窗、长文、读取未知保原正文与重试、缺失文件均实际操作采图。

运行 `node apps/desktop/scripts/fixtures/mote-memory-profile/capture.mjs`。使用当前生产 Profile、Editor、Store、Markdown 和主题，在独立 Electron Renderer 中以明确受控的 Files 回执呈现；不操作用户 App、Run 或文件。capture receipt 绑定实际编译输入和图片，采图不代替审美通过。原 Files CLI/CAS 与新 Session 加载另由 `mote-context-files.test.ts` 证明，不将受控 UI 回复冒称真实保存、模型使用或整个 Desktop 重启。

行为与呈现以 `docs/design/behavior/motes-and-coordination.md` 的检查与更正记忆，以及同主题 presentation 的 Profile 为准。独立 Agent 需亲看当前 receipt 的完整图，给出明确可交付或须修正意见；候选变化需重拍相应场景。
