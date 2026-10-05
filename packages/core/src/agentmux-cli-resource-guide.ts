export const AGENTMUX_SETTINGS_RESOURCE_GUIDE = `These commands act with the current Unix user's configuration authority. Agent identity
does not establish human approval. CONTROL_UNAVAILABLE means this host owner could not
be reached; do not read or write an alternative configuration. Settings inspect is partial:
it exposes the supported subset, not the entire client configuration. Saving configuration
does not launch an Agent or certify Agent health. No Runtime is started or connected for help.

Use settings inspect notes or settings inspect goals to discover reading and starting-view
preferences, including their legal values and defaults. For example, settings set notes.fontSize 16
adjusts note body text; settings set goals.defaultView board applies to newly opened Goals views.
Views already open keep their current choices. settings set goals.showFinished true includes
finished goals by default. These preferences do not edit note files or change Goal lifecycle.

settings inspect notes also reports the managed notes.directory. To move Note bodies and
their Notebook catalog together, use settings set notes.directory <DIRECTORY> --operation-id ID.
Keep that original ID. After an unknown or failed acknowledgement, inspect notebook inspect
--operation-id ID, then explicitly retry the same directory and ID to finish its original move.
Existing Note identities and original copies remain retained until the move is acknowledged.

Resource input uses --input <file|->. Input is bounded UTF-8 JSON, read from a file or stdin (-). Create takes a field
object; the ID occurs only in the positional argument. Update takes {"changes": {...},
"expected": {...}} with nonempty changes and optional expected fields. Delete optionally
takes {"expected": {...}} using the complete inspected editable value. Arrays and objects
replace that entire field. The service owns legal fields, defaults, identities, references,
CAS and persistence. IDs and input paths are literal data, with no shell expansion.

Creation-source trust is configured explicitly by a transport-approved user. Read
settings hosts trusted-sources --host <id> to obtain that Host authority and its public
key fingerprint. After verifying both source and target, settings hosts trust-source --host <id>
--input <file|-> accepts exactly {"sourceRuntimeId":string,"publicKey":string,
"targetRuntimeId":string,"targetKeyFingerprint":string}. The target identity must still
match the reviewed values when it accepts approval. Managed
Agents and devices cannot approve source trust. Opening a remote Agent never silently
trusts a key or copies the caller capability to the target Host.

Executor refresh takes exact Executor and Host IDs and only checks availability. Available
means a regular executable was found; missing means no usable executable; check-failed
retains cause.code/message. It does not launch, stop, resume, save configuration or imply
Agent health. Use settings hosts test --input <file|-> for an unsaved connection draft.
settings executors ls lists global saved templates. To choose a remote Executor, use
settings executors discover --host <id>; routeHostId and runtimeId identify the executing
Host and descriptors contain its own registered commands and current checks. Unknown
means not checked; check-failed is not missing. A failed Host query does not prove an
empty inventory. Custom wrappers need explicit registration: settings executors register
<id> --host <id> --input <file|-> accepts {"config":{label,providerId,command,args,env,
injectAgentMuxGuide},"expectedRevision"?:string}. The command is a target Host absolute
path or PATH command name. Replacing a registered entry requires its configRevision;
the response never includes args or env. Registration does not install or launch software.

Host upgrade-check is a read-only maintenance probe, including for an incompatible
ordinary handshake. It identifies the original headless Core, exact candidate and whether
healthy Runs can be retained. upgrade requires the complete checked expected value and
an explicit operationId in its JSON input. It only updates a saved exact Host; it never
fetches npm latest or replaces an unqualified Native Runtime. An unknown result requires
upgrade-inspect with the same operationId; neither inspect nor reconnect replays upgrade.
Updates require an exact Linux x64 headless owner with verified leases and an explicit
supported launch environment. Additional launch configuration is refused before stopping
the owner; it is not copied into deployment receipts. Existing Runs remain available.
Exit 0 means the Host diagnostic returned facts, including unsupported/check-failed; it
does not prove the connection is healthy. Workspace register accepts {hostId,path,name?}; paths remain literal. It
registers an existing directory, does not run Git/create a worktree, and returns Workspace
identity rather than Project identity. Discover the actual Project again with app snapshot.
Paths are preserved including trailing spaces; no shell expansion or trimming occurs.
The owner interprets the optional name and reports changed=false for an unchanged registration.

Browser-link forget accepts a literal scheme or --input carrying exactly {"scheme": string}.
Use amux settings browser-links forget --input <file|-> for the JSON carrier.
An empty scheme and option-looking scheme are literal values; use JSON for a stored key
that argv cannot represent, such as NUL. Forget removes the current choice, not a choice
captured by an earlier list. An absent choice is unchanged and the next link asks again.
Forgetting a remembered choice never expands browser access. There is no choice setter
or bypass of a person's application-link choice. It does not establish human approval.`

export const AGENTMUX_TOOLKIT_GUIDE = `Create a saved local JavaScript ESM tool with a complete input such as:
  {"name":"Daily summary","icon":"terminal","workspacePath":"<WORKSPACE_DIRECTORY>",
   "script":"console.log('Ready')"}
Creation defaults: enabled=true, statusBar="icon" (or "label"), args=[], actions=[].
Update uses {"changes":{...},"expected":{...}}; expected covers changed fields.
Delete input uses {"expected":{...}} with complete saved editable fields.
Revisions are owner-issued, never editable. Performance is read-only.

Install a local extension directory with amux toolkit install ID --path <PACKAGE_DIRECTORY>
and optional --cwd <WORKSPACE_DIRECTORY>. Omitted cwd is chosen by the Host. The saved record
holds the directory reference and enabled/statusBar/args/cwd preferences. It does not import
a source copy. Edit manifest.json, entry or helper files in that directory; the next explicit
inspect/run/action captures the current files. Manifest schema is agentmux.toolkit.package.v1,
with name, named icon, relative entry and optional actions {id,label,entry,args?}.
ls reports package metadata availability and configRevision; inspect reports the effective
definition revision, content SHA256 and exact source entries. Package and execution cwd
are separate paths. A missing package retains its configuration and original execution facts.
Stop still targets the retained admission; unavailable source cannot admit a new execution.

Installing, saving, enabling an entry, inspect/script/ls and watch do not execute user scripts.
Run captures the definition/result baseline once in the service and admits one execution.
Full input can pin invocationId, expectedRevision and expectedLatestExecutionId. Stop input
pins executionId (null means no active execution). After an unknown receipt inspect the
original identity; do not retry automatically. Closing watch releases only its reader.

Saved actions have id, label, JavaScript ESM script and args, sharing the tool's fixed cwd.
At most 16 actions share the definition budget. Action input pins invocationId,
expectedRevision, sourceExecutionId and expectedAdmissionExecutionId (null if idle).
Changed package files, targets or newer results reject stale actions. Retained invocation replays its facts;
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
unique-PID sums, RSS is the latest PID sum, and missing roots make full totals unknown.`

export const AGENTMUX_GOAL_CREATE_GUIDE = `Project identity must come from app snapshot, never a Space or Workspace ID.
The original Goal owner records routing risk (low/medium/high/unknown), confirmation
(automatic/user/pending), wikiVersion, the verified caller and its actual recording time.
Defaults risk=unknown and confirmation=pending do not authorize a write. Carry the scoped
authorization actually given; never invent user confirmation or an automatic policy.
These fields do not accept Goal alignment or results, which remain human actions.
Project is optional: omit --project to keep the Goal unassigned. An explicit unknown Project is refused.
Hold an exact optional --goal ID before creating. Read goal inspect --goal with that same ID after
an uncertain save; do not title-match, replay create or generate another ID. Duplicate IDs are refused.
Only an explicit save after the original owner confirms absence may use that same ID again.
goal create/update --content-refs JSON records exact {hostId,workspaceId,zoneId} content provenance, independently of executing Session links. Updates append sources atomically. Use goal update --expected-updated-at MS from goal inspect when adding existing associations; a conflict requires reading the same Goal again. Unknown writes are inspected with the original Goal ID before any explicit retry.
goal discuss --mode open opens the dedicated main Mote Tab without another Prompt; grill and grounding
admit real requests through the original queue. Tab/Session navigation does not mean Prompt acceptance.
goal confirm/accept require a transport-approved human/device and exact proposal/result CAS identities.`
