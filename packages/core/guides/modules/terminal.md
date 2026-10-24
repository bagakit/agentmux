---
summary: "Terminal creation at an exact inspected destination"
roles: "Agents preparing an authorized terminal workface"
when: "Open a terminal after inspecting its intended workface"
---

# terminal

<!-- amux:content -->
The client owns terminal presentation; ctxmux owns the actual process/PTY lifecycle
and bytes. terminal open targets an exact destination; it is a write that can start
work, not a read-only capability check. Discover the intended Tab/Region or new-Tab location
with space inspect and preserve existing content, drafts and healthy Runs. A displayed terminal
is not an Agent Session or evidence that a command completed.

Read terminal open --help for its current exact target and operation contract. Keep the
original operation and returned terminal/Run facts. After an unknown opening response,
inspect the same destination and original owner instead of opening another terminal or injecting
probe commands. Navigation and input eligibility remain separate from creation. For a new
split/Tab, read amux space --skill first and choose from the actual visible geometry.

For an existing raw Terminal, read terminal recover --help. Recovery uses the exact
execution Host, persistent Native Runtime, original Run and cwd. It reenters one
durable Core intent, including after the client or Core process restarts. Unknown
Start is observed, never replayed; an explicit continue first fences the original
creation before a successor. Keep its canonical operation receipt. Closing a view
does not stop that recovered Run. This raw Runtime action requires the original
transport-approved user or device; Agent Sessions use semantic recovery.
