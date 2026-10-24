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

Metrics watch owns a reader; cancellation detaches that reader and never stops an Agent.
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
Use explicit profile/trace capture help for the exact current Renderer target. V8 samples do
not cover all Main, native, worker or GPU work; a broad unknown share needs another relevant
source, not a guessed owner. Renderer memory/backing counters overlap and are not an RSS bill.

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
For explicit Renderer heap/backing counters, use system metrics memory inspect --help;
that original command defines exact target, unknown coverage and debugger ownership boundaries.
Crash-log reveal is a separate presentation action, not a recovery. Missing diagnostics
remain unavailable/unknown, not proof that a healthy Run died or that a save succeeded.
Retain the original failure, operation and recovery path; do not restart or replace original
work merely because a diagnostic owner failed.

[diagnostic](../shared/diagnostic.md "amux:include")
