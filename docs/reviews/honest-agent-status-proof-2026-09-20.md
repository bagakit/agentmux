# Honest stopped and failed Agent states

Scope: f-27q8fjs45 / T-003. The approved interaction and density SSOT requires distinct running/working states, neutral normal endings, red only for actual failures, and a recovery path for interrupted sessions. No Runtime authority, lifecycle operation or Avatar structure was added here.

## Layer decision

Core owns the process-to-display projection. `runDisplayState` now accepts the Run observation instead of just its state. Existing `classifyRunExit` interprets signal/code only when an explicit exit reason is absent: user-stopped wins over its resulting signal; crashed is error; unknown exits are neutral; interruptions without failure evidence are disconnected. No absence is turned into a successful completion.

`runExitFacts` forwards interruptionReason along with exit facts, so snapshot and live-event paths consume one projection. It remains an input fact, not an extra status property. A daemon_restart gets an explanation that does not claim the Agent crashed. Core status no longer labels an ended Run with a stale working hook's source and observation time.

Desktop recovery uses authoritative processState to distinguish a missing Run from a live-but-disconnected transport. Resume no longer depends on status.error. Missing terminals restart rather than offering Check again. Normal endings use a neutral stop icon; actual failures use the alert icon. Removed obsolete tmux-specific recovery copy that told users to open a new session.

Shared status CSS owns running blue/hollow, working green/active, exited neutral, disconnected neutral/hollow, and error red/`!`. Avatar composition remains another task's responsibility and consumes the same status dot/ink.

## Verification

Commands ran in `/private/tmp/agentmux-region-topic-20260920`. Desktop's `@agentmux/core` symlink resolves to **this tree's** packages/core; initially the shared node_modules linked another tree, which was corrected locally before verification. Core was rebuilt after each source mutation.

- **327 tests passed in 22 files**, covering Core projection/classifier/public status, desktop snapshots and live events, launch-event replay, recovery panes, status menus/avatars, CSS contracts, Topic and IME. Log: `/tmp/honest-status-final.log`.
- Desktop production typecheck passed (`/tmp/honest-typecheck-final.log`); Core builds passed.
- Seven sequential mutants were killed with assertion failures, each restored: interrupted→error; user-stopped→error; drop interruptionReason forwarding; reuse stale ended-Run hook; require error before showing missing-Run recovery; running→green; remove error `!`. Logs `/tmp/honest-mutant-*.log`.
- Earlier Topic IME follow-up has its own commit and behavior mutant (`/tmp/topic-ime-mutant.log`).
- Product callers: `client.statusAgent` consumes runDisplayState; runtime-controller and session-state consume projectRunProcessStatus/runExitFacts; WorkspaceWorkbench renders SessionPane; QuickSwitcher and other status surfaces render StatusDot.
- A full fast-shaped run completed 625 files before final corrections: 27 failing tests plus one suite failure. All six failures introduced by the changed status contracts were fixed and rerun; temporary preview inventory was removed. Remaining failures include baseline/integration and local dependency/native-helper setup; this is **not** a claim of full-suite green. Log `/tmp/honest-status-fast.log` is preserved for parent comparison.

## Visual evidence

An isolated browser preview used production StatusDot, AgentAvatar and full production CSS. `/tmp/honest-agent-status.png` was visually inspected. Computed styles: running #82b3f2, transparent fill and 1.5px inset ring; working #8de3ae with pulse; exited #808a82; disconnected the same neutral color with hollow ring; error #ef7773 and `!`. The Avatar preview predates the separate appearance-composition task; its outer shape is not claimed as final. Ego space 13 closed, preview files and server removed.

## Required installed restart acceptance

Do not restart or stop an existing runtime merely for this subtask. On the parent's authorized package/install cycle:

1. Preserve the current durable Tab/Region layout and Session identities; after restart the same interrupted daemon_restart sessions remain visible.
2. They use neutral disconnected styling, identify Runtime interruption, and offer Resume. Clicking Resume preserves AgentSession identity and leaves the recovering state on success or failure.
3. A normal completion or user-stopped Run remains neutral; a recorded crash is red. Compare snapshot after reconnect with its original live-event presentation.
4. Running appears blue/hollow in both the menu and Avatar, while working appears green/active.

One pre-existing durability gap was raised to the parent: `stopRequestedRuns` and `endedRuns` are in-memory. A new Client cannot recover a previous Client's user-stop intent from those maps, so an old signal exit can be classified as crashed after a true process restart. The snapshot tests prove re-projection of supplied authoritative facts, not persistence of that intent. Closing this gap requires durable AgentMux intent ownership, not duplicating ctxmux process facts; this status-only change does not claim to have supplied it.
