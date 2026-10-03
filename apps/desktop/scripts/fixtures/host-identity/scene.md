# Machine identity: actual Renderer capture

Owning visual contract: [shared machine identities](../../../../../docs/design/presentation/spaces-and-layout.md#共享机器身份标识). Existing Host/cwd ownership remains in [spaces and layout](../../../../../docs/design/behavior/spaces-and-layout.md).

Run `node apps/desktop/scripts/capture-host-identity.mjs`. It mounts production GlobalFocusSurface, WorkspaceSidebar/ProjectGroupsTree, TopRowLeadingChrome/TopBreadcrumb and BoardRowsProvider/WorkspaceBoard with the original product stylesheet in a private Electron window. Controlled preview config includes same-label local/SSH, unknown and long machine identities. Full PNGs cover 1280px and 640px contexts; the sidebar retains its original 300px rail. A native pointer clicks Refresh on the narrow Board and verifies the preview Git reader responds while Runtime actions remain uncalled.

With `AGENTMUX_HOST_IDENTITY_WRAP_MUTANT=1`, the Vite loader substitutes the actual Board toolbar rule with its former grid rule at the original CSS import position. Only the narrow Board scene runs. The actual text-width and full Refresh-hit checks must fail; a compile error does not count. The mutation does not modify product source or shared outputs. Reports and original images stay in `.tmp/host-identity/`. Capture success does not sign aesthetic approval: an independent Agent opens the full originals and writes a candidate-bound review.

Boundary: preview API facts; no real SSH, PTY, user App/Run, Main IPC, installed package, lifecycle or whole-App navigation proof. Identity icons do not certify connectivity or health. Private profiles and superseded compiled copies are cleaned after evidence is archived.
