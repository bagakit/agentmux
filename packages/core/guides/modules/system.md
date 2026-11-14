---
summary: "Endpoint, diagnostics, storage, crash evidence and metrics"
roles: "Agents diagnosing original owners"
when: "Inspect reachability, resource facts or retained failure evidence"
---

# system

<!-- amux:content -->
System readers expose original owner observations, not a replacement Runtime ledger.
system endpoint discovers the selected service without connecting; its inspect form reads
the published owner. A responded endpoint certifies that response, not all Hosts or Agents.
system doctor/storage/crash-log/metrics keep source identity, observation time and partial
coverage. Use current help to discover exact reader contracts and authorization.

`system relay inspect` reads the original Core's optional embedded gateway.
Disabled, starting, listening and unavailable describe this component only.
Listening does not confirm an edge connection, device permission or successful
RPC. A gateway failure does not make the original Unix endpoint or Agent
unavailable. This read never starts or reconnects a gateway.

Read system diagnostics inspect --list to discover the actual client.notifications reader.
Use system diagnostics inspect --domain client.notifications --host-id local for the
registered client's current issues and retained activity, even when its panel is closed.
--section current|activity, --category system|connections|agents|operations, --unread and
--limit narrow that same projection. --notification-id reads one returned original ID;
--include-raw explicitly includes retained notification text. Default output is safe metadata.
Reading never marks notifications read, clears history, focuses the workface or retries work.
Notification IDs are client observation references, not logIds or permission to act on Agents.
Keep each page's original filters and cursor; expired means the document or snapshot changed,
so begin a new list. Unavailable or partial coverage does not mean the inbox is empty.
Activity keeps a bounded window of the newest events; activityNotRetained counts older ones
that were not kept, so "complete" covers the kept window only. Those events were not read.
The client route Host and each original notification subject Host are separate identities;
this is one registered client document, not an archive of all windows or Hosts.

The existing client.incident reader also retains finite mobile-web observations in its original
Main archive. Use system diagnostics inspect --input FILE|- with a client.incident recent target
and producer:{kind:"mobile-web",devicePrincipalId,documentId,buildId?,namespaceDigest?} copied from the original
phone receipt; omit the producer selector for bounded archive discovery. Read an exact returned
logId with its original archive authority. Build identity is the page's compilation, not the
current HTTP manifest. Device identity is stamped by the authenticated forwarding chain and
does not grant device administration. Partial space.ls observations record only presence of the
original issue field, counts and bounded opaque Space references; inspect those original Spaces
with their existing CLI for complete reasons. Connection observations retain their original typed
boundary/state. Diagnostic admission remains unconfirmed until its original archive read says
otherwise. Missing Main/archive or exhausted diagnostic budgets leave existing phone and Agent
operations available; retry only the retained original diagnostic occurrence when appropriate.

system metrics app-memory inspect reads retained application-process working-set peaks
without opening the resource panel or starting sampling. rssKib is Electron workingSetSize
in KiB, not an independent RSS/footprint or reclaimable-memory reading. The Main owner samples
every 30 seconds and retains at most eight Main lifetimes, sixteen process details per peak
and omitted counts. Original PID/creation identities, sample times, sampling failures and
persistence acknowledgements stay separate. Sampling gaps and unsaved tail values remain
unknown; Agent CLI and ctxmux are outside this archive. It cannot establish a leak or
allocation stack. Reads after restart cannot reconstruct the prior write acknowledgement.

Metrics watch owns a reader; cancellation detaches that reader and never stops an Agent.
system metrics get returns the first bounded frame and releases its own reader; a pending
Renderer has not failed. Watch frames may update different sources: use the app source
observation time and process intervalMs to identify actual CPU intervals.
Input diagnostics preserve an optional Renderer parent {observerId,source,sequence}; it is an
untrusted correlation label, never identity, an operation ID or an input receipt. Compare
Host/Session/Run and execution owner too; Main sender/window facts are captured independently.
Stages and oldestPendingMs use each process's own monotonic clock, so nested wall times are not
additive. Duplicate parents are ambiguous, and omitted coverage cannot prove uniqueness or the
oldest pending age. active/recent stay bounded; bad optional metadata is discarded without
changing original input bytes, FIFO order, results or errors.
diagnostics.host describes the local machine: CPU uses whole-machine capacity and a
matching counter interval, separately from App/Run one-logical-core percentages. Physical
free memory is not memory pressure or reclaimable capacity. Supported macOS sources add
swap, kernel pressure and per-interface byte rates; each source keeps its own time/reason.
Interfaces are separate links, not an additive App/Agent traffic bill; VPN/physical/loopback
may carry the same bytes. First/reset/replaced interfaces have no rate until a new interval.
Native counters are shared at low frequency only while metrics have consumers. Unsupported
or failed sources stay unavailable without erasing independent successful observations.
For a performance technical profile, first separate process identity and interval CPU/RSS
from Renderer sample weights, browser timeline events and object retention. Keep the loaded
build, original PID/creation identity and each actual interval; sequential captures are not
simultaneous evidence. Deduplicate source samples and do not add inclusive parent/child times.
Each explicit Renderer capture (system metrics profile, allocations, trace, scene and heap capture)
defines its exact five-field Renderer target, any duration, size limits, sensitive content and
--output rules in its leaf --help, as do scene and heap inspect for their original capture IDs;
read that help before capturing or exporting. These time and size limits bound observation and
transport, not native peak memory. V8 samples do
not cover all Main, native, worker or GPU work; a broad unknown share needs another relevant
source, not a guessed owner. Renderer memory/backing counters overlap and are not an RSS bill.
Explicit timeline capture requests native triggering stacks for existing events. Only stacks
actually present establish call locations; missing stacks remain unknown. Retained category
filters belong to the original capture, not the reader's current policy. A trace's
requestedCategories is only the requested filter; participating PIDs and categories are the
original traceEvents pid/cat values, and missing events or categories do not prove absent work.
Main startedAt/startMonotonicMs mark receipt of the start ACK and native events may begin earlier,
so trace timestamps and Main/Renderer wall or monotonic clocks are never equated or summed as CPU.
Node-level invalidation tracking is not enabled by default. Names and URLs stay in the explicit
raw material. system diagnostics inspect --domain performance.scene --host-id local --capture-id ID
returns only a safe scene phase summary and reference; frames, traces and profiles stay in
system metrics scene inspect, even with --include-raw. A pending heap publication keeps the prior
file plus one candidate and refuses further native heap captures.

system metrics trace capture --memory-allocators selects one explicit allocator trace instead
of the default timeline. It requests exactly one deterministic:false, levelOfDetail:light
native dump, with fixed memory-infra categories and no periodic triggers. It does not request forced GC.
memoryDump records the request and valid ACK separately from the original native events.
ACK dumpGuid and trace-point id/ts/name/PID are independent identities, even when tokens match.
Keep original event occurrences, attributes, units and ownership edges; do not join points by
order, sum parent/child or shared nodes, or turn them into an RSS/reclaim bill. Missing providers
remain unknown. The original gzip material/export can contain private URLs and paths; no upload,
automatic retry, full object heap or background capture is performed.

system metrics profile analyze --input FILE analyses one already-exported local cpuprofile
without resolving or connecting to an endpoint, opening an App, sampling or uploading.
It preserves the original byte hash and generated positions, reports original duration,
weighted samples, last-sample tail/overrun and script/idle/GC/unattributed self weights.
Those shares are not process CPU or a dropped-sample rate. Bare profiles do not verify a
capture PID/build or original source map; join the original capture receipt separately.
Top rows, caller paths and labels are bounded and report omissions; the original is unchanged.
Keep names and URLs private. For deeper original-material analysis, explicitly load the
profile in DevTools or a local speedscope viewer, and the timeline in DevTools/Perfetto.
Do not upload material or fetch arbitrary source maps to explain a local capture.

For a bounded explicit Web Animation instance read in one exact Renderer document, use
system metrics animations inspect --help. It does not attach a debugger or alter animations;
labels and play state are observations, not CPU ownership or Agent control facts.
For an explicit Renderer platform cache read or cleanup, use system metrics cache inspect
or system metrics cache reclaim with the exact five-field target from system metrics get.
inspect is read-only; reclaim is a side effect in that Renderer process. The window is its
routing anchor, not a single-document scope. Native eviction and memory-pressure notification
preserve user documents and state, but may pause briefly and require caches to refill.
No Session/Run or conversation view is deleted, and website storage is untouched.
Counter sizeBytes includes encoded, decoded and overhead bytes; decodedBytes maps Electron's
native liveSize (decoded_size), not live/unused memory. Neither predicts RSS savings.
Missing before/after counters do not undo a completed native call. Unknown receipts are never
automatically retried; a later inspect reads current counters without reconstructing the old ACK.

For bounded related dedicated-worker counters, read system metrics memory workers inspect --help.
Use the original five-field Renderer target from metrics get/watch. This explicit diagnostic may
include private native Worker URLs, paths and titles; keep its bounded receipt private. It observes
root/nested dedicated-worker relations with a200ms settle after the initial auto-attach attempt
within the original observation deadline, at most16 relations and64 read/discovery commands
with2 concurrent child reads. These are reader budgets, not limits on Workers or Agent capacity.
A completed query only confirms this bounded window and cleanup; zero observed is not absence.
Known child/discovery failure or omitted work is partial, source loss/cancellation/unconfirmed
release is unknown. Isolate IDs preserve root and related aliases without an aggregate byte total;
relatedness does not prove a child's OS PID. Metadata explicitly distinguishes absent, empty,
truncated and omitted fields. No global target scan, evaluation, objects, pause, Worker termination,
GC, snapshot, profiling or memory-infra is performed. Default memory inspect and Scene remain
main-isolate v1. Existing DevTools/debuggers stay owned; only this exact read is refused.

For explicit Renderer heap/backing counters, use system metrics memory inspect --help;
that original command defines exact target, unknown coverage and debugger ownership boundaries.
Crash-log reveal is a separate presentation action, not a recovery. Missing diagnostics
remain unavailable/unknown, not proof that a healthy Run died or that a save succeeded.
Retain the original failure, operation and recovery path; do not restart or replace original
work merely because a diagnostic owner failed.

[diagnostic](../shared/diagnostic.md "amux:include")
