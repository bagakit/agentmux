# Remote execution Settings capture

Run from the repository root:

```sh
node apps/desktop/scripts/capture-remote-execution-settings.mjs --prepare
node apps/desktop/scripts/capture-remote-execution-settings.mjs --run <printed-directory>
```

`--run <directory> --first` captures only the initial wide dark page. Its
`first-receipt.json` is not the ten-frame completion receipt.

The fixture compiles production SettingsPanel, Remote execution and Mote
Settings, Store, WorkspaceWorkbench, Launcher and CSS. Two typed preview Agent
Sessions have opposite Agent/resource Host roles, exact retained bindings and
original workface layouts. Both Hosts intentionally have the same label.
Session facts and external API replies are controlled; this does not exercise
Main, SSH, model access, native Agent execution or the user's installed App.

The ten full-viewport frames cover wide light/dark, empty bindings, selected
original work, long Agent/Host labels and paths, a Working Agent with unknown
tool observation, a short window, the prepared original Launcher, and current
Mote Settings in light/dark for independent comparison. Native Electron click
and key events exercise selection, opening the exact original workface and
Prepare. Focus is emulated inside the private Renderer; this is not a physical
user-input or OS-focus claim.

Preparation records raw source, CSS and PNG hashes separately from generated
asset-module and compiled-output hashes. Owning presentation inputs must stay
unchanged. Concurrent unrelated inputs retain both consumed/current identities
and are explicitly not qualified as current product code. Every screenshot is
hashed; private process and profile cleanup is recorded.

`captureOnly: true` and `independentVisualReview: not-performed` remain in the
receipt. An independent reviewer must open all complete images, use the owning
Remote execution behavior/presentation SSOT, compare the actual Mote frames,
and record concrete findings against this exact candidate. Capture success is
not aesthetic approval or remote execution qualification.
