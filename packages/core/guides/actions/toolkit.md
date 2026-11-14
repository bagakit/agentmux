# toolkit

<!-- amux:content -->
Create a saved local JavaScript ESM tool with a complete input such as:
  {"name":"Summary","icon":"terminal","workspacePath":"<WORKSPACE_DIRECTORY>",
   "enabled":true,"statusBar":"icon","script":"console.log('Ready')","args":[]}
Inline definitions require enabled, statusBar ("icon" or "label") and args; actions is optional.
The optional autoStart defaults to true for all custom tools, including local packages.
Enabled tools run once at Host startup, creation or activation; set autoStart:false for manual execution.
Healthy original Runs reconnect; unknown admissions are retained without replay.
Update autoStart through the same changes/expected JSON fields; inspect and ls expose the saved choice.
The optional mode is "script" or "tui"; omitted means a finite JavaScript ESM script.
Update uses {"changes":{...},"expected":{...}}; expected covers changed fields.
Delete input uses {"expected":{...}} with complete saved editable fields.
Revisions are owner-issued, never editable. Performance is read-only.

Install a local extension directory with amux toolkit install ID --path <ABSOLUTE_PACKAGE_DIRECTORY>
and optional --cwd <WORKSPACE_DIRECTORY>; --path must be an absolute Host path.
Omitted cwd defaults to ~/.agentmux on the Host.
Working directories accept absolute paths, ~, ~/..., $HOME and ${HOME} prefixes;
quote shorthand arguments to preserve them for the execution Host. The Host expands and saves
the absolute directory for create/update/install and supplied expected values. Relative paths
have no implicit base; arbitrary variables and command substitutions are not evaluated.
Spaces and the path suffix are literal, including /../ through symbolic links. The saved record
holds the directory reference and enabled/statusBar/args/cwd preferences. It does not import
a source copy. Edit manifest.json, entry or helper files in that directory; the next explicit
inspect/run/action/evaluate captures the current files. Manifest schema is agentmux.toolkit.package.v1,
with name, named icon, relative entry, optional actions {id,label,entry,args?} and
optional display {entry,args?}. Inline tools use display {script,args}; display:null removes it.
ls reports package metadata availability and configRevision; inspect reports the effective
definition revision, content SHA256 and exact source entries. Package and execution cwd
are separate paths. A missing package retains its configuration and original execution facts.
Stop still targets the retained admission; unavailable source cannot admit a new execution.

Creating or activating an enabled finite-result tool runs it when autoStart is selected.
Editing an existing tool's source does not execute it.
Inspect/script/ls and passive watch do not execute either mode.
Run captures the definition/result baseline once in the service and admits one execution.
Full input can pin invocationId, expectedRevision and expectedLatestExecutionId. Stop input
pins executionId (null means no active execution). After an unknown receipt inspect the
original identity; do not retry automatically. Closing watch releases only its reader.
To explicitly continue an admission without a Run ID, use run/action --input with its
original invocationId and complete captured parameters. This reuses its execution and
native creation key: a retained Run is returned rather than started twice. If that Run
is no longer retained, the original script may run now. Ordinary inspect/watch never do this.

For an interactive terminal tool, set mode:"tui". An empty or whitespace-only script opens
the execution Host's default interactive shell; args pass directly to that shell. The Host
prepares the complete launch request before creation. Explicitly continuing an unknown
original request retains that shell and environment even after the Host environment changes. A nonempty script executes
with shell -lc and a fixed script name; args become $1, $2, and so on, without being
concatenated into shell source. TUI accepts no nonempty actions or nonnull display.
Local packages retain their JavaScript contract and do not accept TUI mode.
Creating or activating an enabled TUI with autoStart selected, and Host startup, load it once.
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
Explicit Renderer profile, allocation, trace, scene and heap captures belong to amux system --skill
and each capture's leaf --help.

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
