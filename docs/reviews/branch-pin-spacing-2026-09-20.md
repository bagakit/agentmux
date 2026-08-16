# Branch Pin spacing

Status: approved. Authority: user explicitly delegated this bounded fix to a subagent on 2026-09-20.

User request: branch 被 pin 了以后，它的缩进不对；pin 的按钮 padding 太大，应该小一点；没有 hover 时不占这个空间，hover 时才占。

Scope: pinned branch rail alignment and compact discoverable Pin controls; preserve keyboard access, pin scope, navigation and persistence. No session/runtime changes.

Plan: one vertical slice, verified on rendered controls, stylesheet behavior, mutations and browser geometry.

## Evidence

- Root cause: pinned children omitted the existing collapse and icon slots; the depth was right but title geometry was wrong. Pin actions used opacity alone and retained 22px plus gap.
- Reused the Project row shell and slots. Pin state uses the existing leading glyph; the separate 18px action leaves flow while idle and returns on hover/focus. Open and Pin are sibling buttons, eliminating invalid nested buttons.
- 67 targeted and guard tests pass; desktop typecheck passes.
- Six deliberate defects each made the owning test fail: missing collapse slot, missing icon slot, idle action reserves space, oversized action, missing keyboard reveal, missing pinned-state glyph. All restored before the final passing suite.
- Browser check used the actual React SSR outputs and production stylesheet import order: child title offset is 8px default / 6px compact; idle action is absolute with 0 opacity and 18px width; hover/focus changes it to static and gives it a visible focus target. Title width changes from 227.078px idle to 205.078px with action. Screenshot inspected. Click isolation was exercised with actual React handlers in happy-dom.
- Product callers: ProjectRail.tsx renders WorkspaceSidebar; SurfaceToolDock.tsx renders BranchesPanel. Existing row shell/icon/collapse CSS is consumed by WorkspaceSidebar and the Pin CSS by BranchesPanel. No isolated unused helper.
- Verification command uses pnpm's explicit verify-deps-before-run=false for this isolated worktree's shared dependency installation. The first tracker gate exposed pnpm's attempted reinstall, not a product failure; only this command option was repaired.
- No Session or persistence behavior changed. Existing Pin scope, group membership and navigation regression tests remain green.

Learning: depth metadata alone cannot prove tree alignment when parent and child render different leading slots. Browser geometry is the useful counterexample.
