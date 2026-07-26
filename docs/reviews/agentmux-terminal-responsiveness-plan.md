# AgentMux terminal responsiveness plan

Status: approved

This plan records the user's requested fix for two related symptoms: opening several
Agent sessions makes terminal capability checks time out more often, and returning to
a terminal whose TUI produced a large amount of output can make the renderer feel
locked while retained output is replayed.

The boundary is intentionally AgentMux-side. CtxMux remains the authority for PTY
bytes, replay, gaps, attachments, and input cursors. AgentMux must schedule its own
capability probes and xterm work so one slow probe or large replay cannot block
unrelated sessions or renderer controls.

Review basis: explicit user request in the active task and the existing interaction
and surface-density design contracts.
