# Renderer bundle and hot update boundary review

- **Status:** approved
- **Observed problem:** the installed App contained the new Topic thumbnail bundle, but `renderer-updates/active.json` still pointed to a prior Renderer release. Startup accepted that release because its shell/ctxmux identity was compatible, so the visible window continued to show `T1 1R`.
- **Decision:** persist the bundled Renderer release id beside the hot update pointer. When the bundled id changes or the marker is absent, invalidate only the old active pointer and load the new bundled page; durable layout, Tab, Region and Session state stay untouched. A hot update remains restorable when it belongs to the same bundled version.
- **Preserved facts:** Runtime/Session ownership, workbench persistence and renderer failure receipt semantics remain unchanged.
- **Verification:** renderer update tests cover same-bundle restart and bundled-id change invalidation; a mutation of the marker comparison must fail; the installed App is restarted and the active pointer is checked against the new bundled release.
