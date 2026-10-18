# toolkit

<!-- amux:content -->
Create a saved local JavaScript ESM tool with a complete input such as:
  {"name":"Summary","icon":"terminal","workspacePath":"<WORKSPACE_DIRECTORY>",
   "enabled":true,"statusBar":"icon","script":"console.log('Ready')","args":[]}
Inline definitions require enabled, statusBar ("icon" or "label") and args; actions is optional.
The optional mode is "script" or "tui"; omitted means a finite JavaScript ESM script.
Update uses {"changes":{...},"expected":{...}}; expected covers changed fields.
Delete input uses {"expected":{...}} with complete saved editable fields.
Revisions are owner-issued, never editable. Performance is read-only.

Install a local extension directory with amux toolkit install ID --path <PACKAGE_DIRECTORY>
and optional --cwd <WORKSPACE_DIRECTORY>. Omitted cwd is chosen by the Host. The saved record
holds the directory reference and enabled/statusBar/args/cwd preferences. It does not import
a source copy. Edit manifest.json, entry or helper files in that directory; the next explicit
inspect/run/action/evaluate captures the current files. Manifest schema is agentmux.toolkit.package.v1,
with name, named icon, relative entry, optional actions {id,label,entry,args?} and
optional display {entry,args?}. Inline tools use display {script,args}; display:null removes it.
ls reports package metadata availability and configRevision; inspect reports the effective
definition revision, content SHA256 and exact source entries. Package and execution cwd
are separate paths. A missing package retains its configuration and original execution facts.
Stop still targets the retained admission; unavailable source cannot admit a new execution.

Installing, saving or enabling finite-result tools does not execute their scripts.
Inspect/script/ls and passive watch do not execute either mode.
Run captures the definition/result baseline once in the service and admits one execution.
Full input can pin invocationId, expectedRevision and expectedLatestExecutionId. Stop input
pins executionId (null means no active execution). After an unknown receipt inspect the
original identity; do not retry automatically. Closing watch releases only its reader.
To explicitly continue an admission without a Run ID, use run/action --input with its
original invocationId and complete captured parameters. This reuses its execution and
native creation key: a retained Run is returned rather than started twice. If that Run
is no longer retained, the original script may run now. Ordinary inspect/watch never do this.

For an interactive terminal tool, set mode:"tui" and put a shell command in script.
The Host executes it with shell -lc and a fixed script name; args become $1, $2, and so on,
without being concatenated into shell source. TUI accepts no nonempty actions or nonnull display.
Local packages retain their JavaScript contract and do not accept TUI mode.
Creating an enabled TUI, enabling a disabled TUI, and Host startup load the tool once.
A running exact Run is reconnected; a confirmed ended Run starts a new execution on the next
load cycle. An exit never causes a restart loop within the current cycle. Source edits only
affect the next execution. Opening or closing its terminal view neither starts nor stops it.
Disabling prevents future loads and admissions while preserving an already running TUI;
stop remains available for that exact execution. Host shutdown releases observation only.
An unknown creation or Run observation retains the original identity and never auto-replays.
Inspect/watch expose the same captured execution and Host/Run binding as the UI; ls reports
mode on inline descriptors. TUI text stays empty and there is no machine result document:
use the existing terminal capabilities with its exact Run for bytes, input and observation.
After an authoritative exit, the terminal and latest execution remain readable until a later
admission safely releases the ended Run. A replacement Run is a new execution, not recovery.


Display is a separately declared repeatable evaluation program, not a sandbox or enforced
read-only script. toolkit evaluate ID explicitly evaluates it; optional --input pins
invocationId, expectedRevision and expectedLatestExecutionId in the display lane.
Inspect returns display {state,reason,admission,latestConfirmed,sequence} only for a declared
program or retained display facts. Optional lastSucceeded retains the last successful display
result when a later evaluation failed. Its latest confirmed result remains while a new evaluation
is pending or unknown. An unconfirmed action does not block or become confirmed by display.
Display declaration is discoverable as display:true in ls descriptors.
toolkit watch ID --evaluate opts into evaluation once for this reader cycle, joining an
already active display evaluation; tools without display keep their existing passive behavior.
Ordinary inspect and watch never evaluate. Closing the reader releases only that reader;
it neither stops the Run nor clears action or display facts. Official script evaluation,
including --evaluate readers, keeps the same explicit trusted local-user authorization as run.

Saved actions have id, label, JavaScript ESM script and args, sharing the tool's fixed cwd.
At most 16 actions share the definition budget. Action input pins invocationId,
expectedRevision, sourceExecutionId and expectedAdmissionExecutionId (null if idle).
New actions against changed package files, targets or newer results are refused. Confirmed invocations return their facts;
output cannot define actions. Scripts use the local user's files/environment/network;
this capability does not provide a sandbox, secret storage, scheduling or remote execution.

Performance consumes public metrics. Run holds one manual observation until stop; watch
owns an independent lease. Stop ends its exact observation and its readers, never Agents.
Source identity, availability and each source's actual observation time remain visible.
For one new Performance observation, toolkit watch performance --capture-failure enables
finite failure-byte capture. Existing observations are retained unchanged; inspect the actual
diagnostics.captureEnabled rather than assuming a joined reader enabled capture. inspect/watch
return diagnostics.lastFailure with its own original executionId and confirmed Run or null;
cleanup may already have cleared the current snapshot's Run. Ordinary readers neither capture
nor return raw bytes/stacks or arbitrary diagnostic error/issue messages. The original
execution reason keeps its existing behavior; safe diagnostic messages are null. --failure-evidence on inspect/watch explicitly reads retained
evidence independently of capture; original observed error text also counts as retained evidence; failureEvidence is none, retained (withheld), or included.
Failure stages distinguish Toolkit LF/JSON/typed payload from the packaged metrics CLI/RPC.
Fragments use base64 with source byte range and omittedBytes; they are not complete original
frames when clipped. At most 4KiB at each end and an 8KiB stack are kept. A latest explicit
capture uses one private bounded file, one active write and one replaceable pending write
(each <=96KiB); droppedWrites counts superseded writes in this owner lifetime. pending/confirmed/unconfirmed describe this writer's
ACK, observed-on-disk only proves this read. Diagnostic and cleanup issues never replace the
primary failure; they retain actual operation, code and known write phase or null. This reads Toolkit-owned evidence, not arbitrary Run bytes or Runtime authority.
system metrics profile capture explicitly collects one exact Renderer main-target V8 profile
for 1000-5000ms. Supply original window-id, web-contents-id, generation, pid and creation-time.
The same RPC returns the original bounded profile (8 MiB maximum), actual interval and separate
stop/detach facts. --output FILE saves a new local cpuprofile without replacing files or symlinks.
Function names, URLs and local paths may be present: no automatic watch/Toolkit capture, upload
or error-log export. Busy DevTools/debuggers preserve their original owner and refuse only this
profile. A lost reply is unknown and is never automatically recaptured; no retained handles,
restart history, worker/native/compositor CPU coverage or optimization claim.
system metrics allocations capture uses the same exact five-field target and 1000-5000ms interval.
Fixed HeapProfiler sampling requests 32768-byte intervals, depth128 and excludes collected-by-major/minor-GC objects.
Original heapprofile stacks and sample sizes describe sampled window allocations still alive at stop, not
all traffic, old objects, retaining paths, native/worker memory or a leak. No GC, snapshot or object-body reads.
system metrics scene capture requests CPU, allocations and timeline serially for 2 seconds each, with
before/after original resources/memory and actual loaded versions. A 20-second observation budget and
8MiB/profile, 3MiB/resource point read and 32MiB/scene limits do not bound native peak memory. One App owner rejects concurrent scenes;
only one local latest scene is retained. Partial/failed/unknown stage receipts and successful originals survive.
Before-replace save failure preserves old bytes; after-replace/fsync failure is unknown, never rolled back or
recaptured. system metrics scene inspect --capture-id ID only reads that exact latest original; replaced IDs
are explicit mismatch. Available reads are observed bytes, not reconstructed past fsync acknowledgements.
--output creates only a new local file, never replaces a file/symlink, and failed output never repeats sampling.
system diagnostics inspect --domain performance.scene --host-id local --capture-id ID provides safe phase
summary/reference only; large frames/trace/profile material stays in scene inspect, even with include-raw.
No fake logId/authority, automatic capture/upload, App lifecycle, navigation, focus or input is introduced.
system metrics trace capture uses the same exact five-field target and 1000-5000ms interval
for a Chromium target-related timeline. Original ReportEvents objects and order are preserved;
the 8 MiB limit bounds RPC result transport, not native buffers, event production or peak memory.
Start/end acknowledgement, tracingComplete flush, dataLoss/buffer-full, source verification and
detach are separate facts. Target-related Main/GPU context may appear; neither all-App/Host nor
complete native stacks are promised. No screenshots, heap dumps or extra CPU sampling are enabled.
requestedCategories is only the requested filter; actual participating PID/category facts are the
original traceEvents pid/cat values. Missing events or categories do not prove absent work or coverage.
Main startedAt/startMonotonicMs mark receipt of the start ACK. Native events may begin earlier;
trace timestamps and Main/Renderer wall or monotonic clocks must not be equated or summed as CPU.
--output creates a new local trace JSON atomically and never overwrites files/symlinks. URLs and
local paths may be sensitive; no automatic watch/Toolkit capture, upload, log export, retained
handle or recapture on lost replies/local write errors. An incomplete receipt remains incomplete.
system metrics heap capture is a separate heavy, explicit native V8 snapshot. Supply the
exact five-field Renderer target and a new --capture-id UUID. It may pause the Renderer,
trigger engine GC and use substantial native memory/disk; cancellation only ends observation,
not native collection. No automatic retry, upload, heap RPC body or arbitrary server destination.
The result references the original private Host file (Host, path, bytes and hash), not a local
--output. Export the previous file before replacing the single latest snapshot. system metrics
heap inspect --capture-id UUID reads that original operation without recapturing; available
is current file integrity, not a past durability ACK. Load an exported .heapsnapshot in DevTools
Memory and use Retainers. This is V8 object evidence, not all workers/native/GPU/RSS or a leak
verdict. Two-file Comparison requires independently established isolate/object-ID continuity.
While its original attempt remains retained/pending, the same capture-id never starts
native collection again. Every new capture intent requires a fresh UUID. Inspect a retired
ID first: replaced IDs report mismatch, or absent when no snapshot is retained. This bounded
retention is not permanent historical idempotency. Only a completed original with a known
before-replace publication failure can explicitly repeat capture to retry its small receipt
write. After-replace unknown must inspect the actual same-ID manifest/file first;
readability does not turn the original missing durability ACK into confirmed. A pending
publication preserves the prior file plus one candidate and refuses further native captures.
system metrics get returns the first bounded frame and releases its own reader; a
pending Renderer has not failed. Watch frames may update different sources: use the
app source observation time and process intervalMs to identify actual CPU intervals.
Input diagnostics preserve an optional Renderer parent {observerId,source,sequence}; it is
an untrusted correlation label, never identity, an operation ID or an input receipt. Compare
Host/Session/Run and execution owner too. Main sender/window facts are captured independently.
Stages and oldestPendingMs use each process's own monotonic clock; nested wall times are
not additive. Duplicate parents are ambiguous; omitted coverage cannot prove uniqueness
or the oldest pending age. active/recent remain bounded, and bad optional metadata is discarded
without changing original input bytes, FIFO, results or errors.

Data-only script results may use schema agentmux.toolkit.result.v1 with summary, items
[{label,value}], links [{label,url}] and notice. Optional agentCards contains fields,
items [{reference,metrics:[{label,value}]}] and omittedItems. Fields are unique choices
from avatar,name,status,provider,workspace,host,sessionId,runId. Reference is exactly
{kind:"session",hostId,sessionId} or {kind:"run",hostId,runId}; the client resolves
identity from its original owner. Output cannot define avatars, HTML, actions or capabilities.
Documents allow 128 cards, 16 metrics per card and 32768 UTF-8 bytes; text values retain
the 4096-code-unit limit. Missing/ambiguous identity keeps metrics and the exact reference.
Performance inspect/watch returns the same public document as its existing CLI script.
runTotals inherits process source availability/time; CPU is the 10s peak of same-batch
unique-PID sums, RSS is the latest PID sum, and missing roots make full totals unknown.
