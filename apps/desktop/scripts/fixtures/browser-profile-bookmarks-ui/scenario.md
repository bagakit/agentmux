# Profile bookmarks Renderer capture

Run `node apps/desktop/scripts/capture-browser-profile-bookmarks.mjs` from the repository root.
The private Electron app uses its own home, appData, userData and sessionData. It never opens or
modifies the user's App, Profiles, Sessions or Browsers.

The page renders the production SettingsPanel → BrowserProfilesSettingsPane → ProfileEditor →
BrowserProfileBookmarks. The existing Profile preview owner supplies the surrounding settings;
this fixture supplies explicit bookmark DTOs and callback counters. Native CDP input opens the
section, sends one bookmark open request, edits through the real form, loses one save reply,
queries its original ID, and receives one explicit pre-dispatch refusal with its input retained.
Text insertion uses trusted Input.insertText after selecting the existing field contents.

Capture eight complete native frames: edit at 1250/560 in dark/light; unknown at 560 dark/light;
known refusal at 560 dark/light. Inspect folder/title/address wrapping, Browser selection, main
actions, original operation IDs, original-target details and the editable refused input. Source
hashes are recorded before and after capture, including the CSS leaf imported by the component.

The DTO fixture proves production Renderer consumers and real native event callbacks. It does
not prove owner persistence, public RPC authorization, native Browser navigation or process
restart. Those use the separate `browser-profile-bookmarks` native fixture and owner tests.
The receipt deliberately says captureOnly and aestheticReview not-performed. An independent
Agent must actually open the images and report whether they are deliverable.

Presentation contract: `docs/design/presentation/settings-and-observation.md`, Browser Profiles.
Behavior contract: `docs/design/behavior/browser-workface.md`, Profile management.
