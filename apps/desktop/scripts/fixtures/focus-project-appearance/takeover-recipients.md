# Receiving Agents on the original Focus card

This scene follows [the takeover relationship behavior](../../../../../docs/design/behavior/session-recovery.md#takeover-的流转性质与派生关系) and [the recovery presentation](../../../../../docs/design/presentation/session-recovery.md#接手的中央-agent-选择).

```sh
node apps/desktop/scripts/capture-focus-project-appearance.mjs \
  --evidence .bagakit/feature-tracker/focus-takeover-recipients/visual \
  --takeover-recipients
```

The private Electron App receives three ordinary sources and nine original target Sessions using the existing preview transport. The original Desktop store accepts the controlled Core graph with matching Host, cwd, Runtime, Session and Run for every source and target. Each target carries valid creation provenance and a confirmed or unconfirmed initial prompt. The App uses its actual Focus cards, navigation components, avatars and shared menu. The original Gemini PNG is copied into the private bundle layout to reproduce the normal resource URL.

The capture shows one named recipient, the five-recipient card with three faces and a separate overflow button, and the open menu with all five names. A three-recipient card opens its full list from the summary. An unconfirmed first prompt stays visible as a created Agent. The scenes cover dark and light themes at ordinary and narrow widths. Narrow captures use reduced motion. Opening and closing the menu preserves the original selection, draft and Run references. The receipt records the compiled product sources and the captured window bounds.

The fixture supplies original typed observations at the preview transport and isolates PTY and unused editor painting. Capture and inspection concern the private App and its controlled objects. The behavioral tests cover the actual recipient action separately.
