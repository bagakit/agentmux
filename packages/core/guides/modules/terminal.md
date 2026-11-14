---
summary: "Raw Terminal creation, exact observation and semantic recovery"
roles: "Agents preparing an authorized terminal workface"
when: "Open a terminal after inspecting its intended workface"
---

# terminal

<!-- amux:content -->
For an existing raw Terminal, use its original Host, persistent Native Runtime and
Run from the creation/recovery receipt. Read terminal inspect --help, then:

amux terminal ls --host HOST [--limit N]
amux terminal inspect --host HOST --runtime RUNTIME --run RUN
amux terminal output --host HOST --runtime RUNTIME --run RUN [--after-byte N] [--follow]

Inspection is read-only and never recovers or starts a process. Output uses an
independent reader: ordered base64 bytes retain their original start/end byte
cursors, including non-UTF-8 bytes. Initial Gap and later source errors distinguish
missing output from process completion. Keep the last confirmed cursor on
reconnect. Ctrl-C cancels this reader; it does not interrupt or stop the Run or
detach another terminal View. Raw observations require the original
transport-approved person/device; an Agent capability is not raw Terminal access.
Agent Runs, including retired identities, keep their semantic Agent API.
Listing supplies exact targets when an older creation receipt lacks its Native
Runtime. It reads one live Native page, not a frozen fleet or past operation ACK.
Keep the complete nextCursor (runtimeId, ownerInstanceId, afterRunId) with
terminal ls --host HOST --runtime RUNTIME --owner OWNER --after-run RUN.
An owner change expires that cursor; explicitly begin a new listing. An empty
filtered page can still have a nextCursor when it contained only Agent Runs.

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
