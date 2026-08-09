# Verification Evidence

## Automated Checks
- Command: `pnpm install --lockfile-only` followed by `pnpm install`
- Result: dependency graph and lockfile resolved successfully with pnpm 11.5.1.
- Command: `pnpm check`
- Result: passed on 2026-08-09; both workspace typechecks passed, 6 test files / 17 tests passed, and core plus Electron main/preload/renderer production builds completed.
- Command: `pnpm --filter @agentmux/desktop exec electron out/main/index.js`
- Result: final production bundle remained running with no main-process, preload, renderer, or CSP error output during the startup observation window.
- Command: real integration tests inside `pnpm check`
- Result: real tmux launch/capture/input/exit/cleanup passed; real temporary Git repository worktree creation, branch verification, and registration passed.

## Manual Checks
- Step: inspect terminal-first workbench at 1480 x 940 and 980 x 660.
- Outcome: workspace/sidebar hierarchy, file explorer, terminal, rich composer, editor split, session tabs, and settings remain usable without page overflow. Evidence: `.codex-output/agentmux-initial.png`, `.codex-output/agentmux-minimum.png`.
- Step: switch the same session between Terminal and Activity, open `packages/core/src/runtime.ts`, and wait for Monaco to initialize.
- Outcome: activity renders prompt/tool/assistant evidence with provenance and an explicit no-private-COT notice; Monaco loads locally under strict CSP. Evidence: `.codex-output/agentmux-activity.png`, `.codex-output/agentmux-editor-local-monaco.png`.
- Step: submit one prompt under React StrictMode.
- Outcome: exactly one activity was added (`before=3`, `after=4`); there was no duplicate subscription and no console error.
- Step: inspect the workspace board and create-worktree confirmation form on local and SSH host selections.
- Outcome: cards group into Active / Needs attention / Complete / Idle and show path, branch, host, session state, and provenance. The form requires an explicit checkbox before Git mutation. Evidence: `.codex-output/agentmux-board.png`, `.codex-output/agentmux-worktree-dialog.png`, `.codex-output/agentmux-worktree-minimum.png`.
- Step: run the renderer SSH worktree flow with Studio Box, `/srv/render-lab`, `/srv/worktrees/lighting`, and `feat/lighting`.
- Outcome: the created workspace was registered, selected, and opened on the agent-launch surface; reopening Board showed the new idle remote card; console remained at zero errors.
- Step: register an existing SSH workspace path through Settings and save.
- Outcome: `existing-remote` appeared in the sidebar immediately and remained host-scoped. Evidence: `.codex-output/agentmux-settings-ssh-workspace.png`.

## Residual Risks
- Native hook transport and normalization are implemented, but AgentMux deliberately does not mutate user-global Codex, Claude, Hermes, or Pi hook configuration. The operator must explicitly wire provider hooks to the documented environment contract.
- No live SSH credentials were available for a public-host integration run. SSH remote argv quoting, dynamic reverse forwarding, teardown, worktree command transport, and UI selection are covered deterministically; a deployment must still satisfy its server's authentication and remote-forwarding policy.
- Hook forwarding is scoped to the live AgentMux runtime. tmux sessions survive desktop shutdown and can be rediscovered with terminal/liveness evidence, while their prior hook endpoint is not presented as active semantic evidence after shutdown.
- The desktop demonstrator is not packaged, code-signed, auto-updated, or published.
