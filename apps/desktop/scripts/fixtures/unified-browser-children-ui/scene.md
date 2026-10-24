# Unified Browser children: actual shared workface

Owning behavior: [Browser workface](../../../../../docs/design/behavior/browser-workface.md).
Owning presentation: [Browser workface](../../../../../docs/design/presentation/browser-workface.md).
Review: [Independent visual E2E review](../../../../../docs/guides/agent-visual-e2e-review.md).

Run `node apps/desktop/scripts/verify-unified-browser-children-ui.mjs` from the repository root.
The optional positional output directory keeps this round's original receipts and PNGs.
The default uses a fresh attempt directory. A separate `prepared` directory keeps compiled
Renderer assets across harness retries; reuse requires byte-identical compiled assets and
identical Renderer/shared/Core/Layout/client-ui inputs. Main and the production preload
are rebuilt independently, so a Main harness fix does not rebuild unrelated UI consumers.
The disposable process data directory is separate from compiled evidence. A small private
bootstrap sets all application paths before `whenReady`, then imports Main after readiness.

The fixture mounts the original `App`, Store, `WorkspaceWorkbench`, stable workface hosts,
and `BrowserPane`. It bundles the original production preload through the production
Electron Vite preload configuration. Browser presentation calls carry the original trusted
Renderer/frame, lease and Workbench document. Native pages are owned by the actual
`BrowserViewManager`; the actual `WorkbenchWindows` empty shell receives the same mounted
workface through the original portal/placement path. `NativeOverlayWindows` owns overlay
projection. Core's actual spatial state store persists original topology and Browser metadata.

The unrelated provider/file/settings services use existing preview APIs. A single private
compiler overlay selects that existing API service boundary; all other presentation code
uses production feature flags, including the actual native `BrowserPresentationStage`.
Browser script
execution is real; its private operator label is not a real Provider Session. The fixture
creates no Agent Session or Run and never accesses the installed application, user profile,
user Browser, user Runtime, user clipboard or external network. Its two actual Electron
processes share only a newly created private userData and spatial file. The local HTTP
server stays alive across those generations so the original saved URL remains reachable.

The first process opens an original Browser through the existing Store action, splits its
Tab, and clicks the real page's `window.open` button. It checks the new native page appears
inside the original full `BrowserPane` with Source and the existing Workbench toolbar;
the empty child shell has no second preload or Store. A real Browser script holds a step,
the original operation feedback is visible, and the real Take control button yields the
same page to the human. The normal light and narrow dark windows are captured.

Source navigates to the exact original Tab/Region and focuses its native window without
closing the child. Promoting the original Region through the existing Store action then
pressing Source follows the same Region into its new Tab. Return to workspace retains the
exact child WebContents and moves its workface back. A second real native child is closed
through its native window Close; its page is destroyed and its projection retired. These
are deliberately different operations.

After the existing Renderer flush and acknowledged Core spatial persistence, the first
process exits. The second process mounts the real App against the same private data.
It checks original Tab/Region/layout identities, consumes the original cold child through
the shared BrowserPane, and verifies its saved source relationship. Finally it closes the
source Region and opens Source: the child remains usable and a persistent explanation
states that its original source display is unavailable.

PNG kinds are explicit: `original-renderer-layer` excludes sibling native page pixels;
`actual-composed-native-window` or its Orca equivalent includes the actual OS composition.
Failed composed capture remains a warning, never a fabricated composite. The driver
records `aestheticReview: not-performed`; an independent reviewer must actually open the
complete normal/narrow/recovery/closed-source PNGs and record their judgment separately.
