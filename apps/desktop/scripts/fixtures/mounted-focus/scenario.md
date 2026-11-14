# Mounted Space in Focus

Run `node apps/desktop/scripts/capture-mounted-focus.mjs --evidence .tmp/mounted-focus/visual` from the repository root after the owning implementation is ready.

This scene mounts the actual App, GlobalFocusSurface, Source readers, card components and Store. Source Space and Session summary DTOs are controlled at the existing `api.spaceMounts` leaf; the local preview also includes ordinary execution Agents. It does not start a Core, real CLI or Run, install the application, change user layout, or prove native session recovery. The separate existing space-mount tests cover real Core socket → Main IPC → Preload → Renderer admission/navigation.

The source contains two Agents (fresh native working and observation unavailable), eleven Browser Regions and one Launcher with a private draft. The first Agent and another resource have meaningful source Tab names; the other Agent has a long title. The scene captures 1440px dark/light, 900px dark, 420px dark/light, then expands resources and selects an exact original Region. It verifies the Agent count, folded resources, state glyphs, absence of irrelevant execution/draft fallback text, absence of horizontal document overflow and exact destination while preserving local Run values and drafts.

The screenshot receipt is capture-only. A separate Agent must actually open the images and review hierarchy, readability, density, state/source clarity, narrow geometry, resource disclosure and navigation. Current behavior and display requirements belong to `docs/design/behavior/focus-context.md` and `docs/design/presentation/focus-context.md`.
