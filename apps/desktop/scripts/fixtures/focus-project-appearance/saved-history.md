# Saved history in the exact Focus project

This scene follows [Focus project behavior](../../../../../docs/design/behavior/focus-context.md#项目归属任务状态与恢复) and [the Focus presentation](../../../../../docs/design/presentation/focus-context.md#项目扫描与泳道).

Run from the repository root:

```sh
node apps/desktop/scripts/capture-focus-project-appearance.mjs \
  --evidence .bagakit/feature-tracker/focus-project-history-takeover-feedback/visual-history \
  --saved-in-project
```

The private Electron window opens the real App on Focus List. The arranged project has current work, original visits of several ages, and a saved visit for a now current card. An independent Host has the same project title and workspace ID. An older project has only saved work and is available through **Past projects**.

The scene uses the real History disclosure and native clicks at wide sizes. At narrow sizes it focuses the same button and presses Space to open it, then closes it and checks focus. Full dark and light frames cover collapsed and expanded states at both widths. The narrow paired frames use reduced motion. The scene also scrolls to the last card and checks its full name in the existing tooltip, reaches the same-named project's separate Host row and opens the older project's entry.

The recorded DOM observations distinguish the exact Host and project, check that the original current card stays mounted, and verify that disclosure preserves the arranged tabs, layouts, runs, queued input and unsent drafts. The fixture supplies controlled history and uses the existing isolated PTY painting and preview API. Capture provides visual evidence for independent review. It does not operate a live workspace, prove Runtime recovery or install the App.
