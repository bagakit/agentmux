# Private real Host Launcher execution

Owning behavior: `docs/design/behavior/spaces-and-layout.md`. Owning presentation:
`docs/design/presentation/spaces-and-layout.md` and `docs/design/agentmux-surface-density.md`.
Actual screenshot review follows `docs/guides/agent-visual-e2e-review.md`.

Two ordinary Electron processes share only their private profile and real Core spatial file.
The original production App, WorkspaceWorkbench, NewTabSurface, Store, RuntimeController,
desktop-host connector and public SSH Hosted SDK perform creation. A real private local shell
is the existing healthy fixture. Launcher selection, prompt entry and launch use the actual DOM.

The configured remote target is the already running FlowLens QA service. This invocation owns
only its new subdirectory, new Agent and new terminal. The original FlowLens SID is read-only.
It never upgrades, restarts or stops the shared remote owner. Actual creation IDs are taken
from the UI launch receipt rather than overridden by the fixture.

Private configuration, the empty Host candidate, optional browser/Git metadata and file observers
are controlled boundaries. Agent/Terminal creation, remote file operations, Provider discovery,
output observation, spatial persistence and process/native/cwd evidence use their actual owners.
Metadata probes and direct Core references do not prove the Launcher UI.

Capture wide/narrow target disclosures, the no-project registration action, the restored original
workbench, the real SSH project file picker, mixed local/remote Region headers, long Host labels,
More context, hit-testable original close controls, Escape return focus and selected Agent Focus. Capture is not visual
acceptance: an independent Agent must open every current PNG and produce a clear conclusion.

Run `node apps/desktop/scripts/capture-host-ui-execution.mjs` after the Source candidate is closed.
Every invocation retains its own `.tmp/host-ui-execution/host-ui-<nonce>/receipt.json`, including
failures. `.tmp/host-ui-execution/proof.json` is a same-byte copy for the formal readonly consumer.
The producer reports `aestheticReview: not-performed`; current actual images require the separate
independent review artifact. A passed native receipt does not claim installed-App delivery.
