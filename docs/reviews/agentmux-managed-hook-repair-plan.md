# AgentMux managed hook repair plan

Status: approved

Managed Hook commands are generated from the currently running AgentMux executable,
but provider config files can outlive an App installation. When a user moves or
replaces the App, an old absolute command path can make every PreToolUse/PostToolUse
hook report a missing host even though the Agent remains usable.

On startup, AgentMux should re-ensure the managed hook plan for the workspaces and
providers represented by its persisted sessions. The repair is best effort and
non-blocking: user-owned hook entries remain untouched, provider-neutral stdout is
still returned when the relay cannot be reached, and only the stale managed command
is replaced. The App install path remains `~/Applications/AgentMux.app`; no shadow
copy is created under `/Applications`.
