Status: approved from the user's request to rename the Agents surface to Focus, include the current Terminal Session in history, and redesign the history as a modern left-side product surface.

## Accepted closure

- Agent and Terminal Sessions share one execution focus history. Real Region/Tab focus, explicit Session selection, and cross-surface navigation use the same Store write path.
- PMO Teams remains a separate focus lane and never enters execution history.
- The product surface is named Focus. Its history is a left-side, clickable list with a compact Git-like timeline; the main area keeps status groups and the right observation surface.
- Durable `agentFocus` persistence and cross-surface/restart behavior remain intact.

## Non-goals

- No new Session, Run, Region, or Runtime lifecycle.
- No changes to PMO identity or PMO floating-panel behavior.
- No second history store or compatibility alias for the old selection field.
