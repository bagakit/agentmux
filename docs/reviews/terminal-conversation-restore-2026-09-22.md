# Terminal and conversation restore review

## Scope

This review records the current delivery constraints for terminal output gaps, redraw feedback, restoring surfaces, and Codex multi-turn conversation rendering.

## Design decisions

- A lost ordered-byte prefix is represented out of band. The terminal must continue with the newest retained bytes, show a service-window notice, and request one current-screen redraw when the Run is healthy; it must never inject a diagnostic sentence into the PTY screen.
- Redraw is scoped to the visible Region. A successful current-screen repaint clears the stale redraw prompt while preserving the fact that historical bytes were unavailable.
- Restoring and starting-agent surfaces share a branded content frame and readable status hierarchy, but use distinct copy and motion language for replaying retained output versus waiting for a new process.
- Every persisted `user_message` in a Session timeline is rendered as its own Codex conversation row. Snapshot resync is the authority when event delivery has a gap.

## Review result

**Approved for implementation.** The interaction and density SSOTs are updated before implementation. Tests must prove the structured gap signal, redraw convergence, and at least two independent user messages; mutation and production-caller checks are required.
