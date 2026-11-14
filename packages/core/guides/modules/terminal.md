---
summary: "Raw Terminal creation, observation, control and recovery"
roles: "Authorized workface creation; person/device raw observation and control"
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

For one durable control, use terminal input/interrupt/stop --input FILE|-.
The original terminal inspect result supplies target, runtime.instanceId and the
separate run.acceptedInputBytes input cursor. Input JSON is:

{"target":{"hostId":"HOST","runtimeId":"NATIVE_RUNTIME","run":{"runId":"RUN"}},"operationId":"ORIGINAL_OP","ownerInstanceId":"NATIVE_INSTANCE","expectedByte":0,"dataBase64":"YQ=="}

Use the actual original values. Interrupt and Stop use the same shape without
expectedByte/dataBase64. Input is exact canonical base64 bytes: no shell quoting,
newline or Prompt submit is added. Empty bytes are an explicit no-op without a
Native write or cursor advance. A stale input cursor is refused; it is never
refreshed behind the caller. Interrupt uses native SIGINT, not a Ctrl-C byte.
Stop freezes the original native Stop token and reports its graceful/forced
quiescence receipt; request submission alone is not a stopped Run.

These controls require the original transport-approved person/device without a
managed Agent caller. Active/retired Agent Runs stay on their semantic owner.
Read terminal operation inspect --host HOST --run RUN --operation-id ORIGINAL_OP
for the retained request outcome; optional --runtime NATIVE_RUNTIME checks an
original known pin. This lookup works without an active Native owner and never
inputs, interrupts, stops, starts or recovers anything. Current status/input cursor
can be read separately and do not prove an old ACK. Keep unknown outcomes and the
original operation ID; do not call a mutator to inspect it. Native ACK, disk
confirmation and no-op remain separate; a cold disk read cannot reconstruct the
previous producer's directory-sync ACK. Cancelling a CLI reader does not undo a
submitted native intent or authorize another dispatcher. Live GUI typing retains
its original input channel and does not journal every key.
