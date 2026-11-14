# Machine identity: actual Renderer capture

Owning visual contract: [shared machine identities](../../../../../docs/design/presentation/spaces-and-layout.md#共享机器身份标识). Existing Host/cwd ownership remains in [spaces and layout](../../../../../docs/design/behavior/spaces-and-layout.md).

Run `node apps/desktop/scripts/capture-host-identity.mjs`. It mounts production GlobalFocusSurface, WorkspaceSidebar/ProjectGroupsTree and TopRowLeadingChrome/TopBreadcrumb with the original product stylesheet in a private Electron window. Controlled preview config includes same-label local/SSH, unknown and long machine identities. Full PNGs cover 1280px and 640px contexts; the sidebar retains its original 300px rail. Breadcrumb scenes preserve the original branch and non-local Host identity, explicitly distinguish the unconfigured Host, and keep Runtime actions uncalled.

Reports and original images stay in `.tmp/host-identity/`. Capture success does not sign aesthetic approval: an independent Agent opens the full originals and writes a candidate-bound review. `node apps/desktop/scripts/verify-host-identity.mjs --source-only` verifies the mounted production consumers and nine loaded identity mutations. The retired Board toolbar, Refresh action and its width mutation no longer represent current product evidence.

Boundary: preview API facts; no real SSH, PTY, user App/Run, Main IPC, installed package, lifecycle or whole-App navigation proof. Identity icons do not certify connectivity or health. Private profiles and superseded compiled copies are cleaned after evidence is archived.
