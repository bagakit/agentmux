# Mote welcome and conversation history

Actual Desktop App, floating Mote and Space frame. Native Chromium clicks/text entry; controlled typed Host/Reader/settings ports. No real user Run, model input, package or install proof.

Verify the full branded welcome in dark/light and narrow/short surfaces, accurate existing avatar and animation pause/reduced-motion, first-frame text entry and retained draft, natural/manual period rows and source gaps, original bounded history view, policy selector and duration. No create/input side effects from opening or rereading.

Contracts: docs/design/behavior/motes-and-coordination.md (欢迎输入与主对话流转), docs/design/presentation/motes-and-coordination.md (欢迎与历史对话).

`node apps/desktop/scripts/fixtures/mote-conversation-start/capture.mjs --main-menu-only` exercises the current Main menu at normal and narrow widths, native Escape and outside-click dismissal, and focus return after closing its settings. The exact private Sessions, Runs, workface bindings and unsent drafts stay unchanged. The separate `--reading-only` scene captures the cold reading shell and a held early message. Neither scene restarts the user App or proves real Provider recovery.

`node apps/desktop/scripts/fixtures/mote-conversation-start/capture.mjs --rollover-later-only` captures only the later-member correction: one retained original Query has an open, explicit continuation in the selected member; a native click enters the same pending Main action and keeps the member draft. The request is a controlled private fixture; no user Agent is created or sent input. Real Core admission and Query confirmation belong to `mote-rollover-later-intent.test.tsx`.
