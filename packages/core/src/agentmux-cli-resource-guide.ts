export const AGENTMUX_SETTINGS_RESOURCE_GUIDE = `These commands act with the current Unix user's configuration authority. Agent identity
does not establish human approval. CONTROL_UNAVAILABLE means this host owner could not
be reached; do not read or write an alternative configuration. Settings inspect is partial:
it exposes the supported subset, not the entire client configuration. Saving configuration
does not launch an Agent or certify Agent health. No Runtime is started or connected for help.

Resource input uses --input <file|->. Input is bounded UTF-8 JSON, read from a file or stdin (-). Create takes a field
object; the ID occurs only in the positional argument. Update takes {"changes": {...},
"expected": {...}} with nonempty changes and optional expected fields. Delete optionally
takes {"expected": {...}} using the complete inspected editable value. Arrays and objects
replace that entire field. The service owns legal fields, defaults, identities, references,
CAS and persistence. IDs and input paths are literal data, with no shell expansion.

Executor refresh takes exact Executor and Host IDs and only checks availability. Available
means a regular executable was found; missing means no usable executable; check-failed
retains cause.code/message. It does not launch, stop, resume, save configuration or imply
Agent health. Use settings hosts test --input <file|-> for an unsaved connection draft.
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
Use agentmux settings browser-links forget --input <file|-> for the JSON carrier.
An empty scheme and option-looking scheme are literal values; use JSON for a stored key
that argv cannot represent, such as NUL. Forget removes the current choice, not a choice
captured by an earlier list. An absent choice is unchanged and the next link asks again.
Forgetting a remembered choice never expands browser access. There is no choice setter
or bypass of a person's application-link choice. It does not establish human approval.`

export const AGENTMUX_TOOLKIT_GUIDE = `Create a saved local JavaScript ESM tool with a complete input such as:
  {"name":"Daily summary","icon":"terminal","workspacePath":"<DIRECTORY>",
   "script":"console.log('Ready')"}
Creation defaults: enabled=true, statusBar="icon" (or "label"), args=[], actions=[].
Update uses {"changes":{...},"expected":{...}}; expected covers changed fields.
Delete input uses {"expected":{...}} with complete saved editable fields.
Revisions are owner-issued, never editable. Performance is read-only.

Install a local extension directory with agentmux toolkit install ID --path <PACKAGE_DIRECTORY>
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
owns an independent lease. Stop ends its exact observation, never Agents or other leases.
Source identity, availability and each source's actual observation time remain visible.`

export const AGENTMUX_GOAL_CREATE_GUIDE = `Project identity must come from app snapshot, never a Space or Workspace ID.
The original Goal owner records routing risk (low/medium/high/unknown), confirmation
(automatic/user/pending), wikiVersion, the verified caller and its actual recording time.
Defaults risk=unknown and confirmation=pending do not authorize a write. Carry the scoped
authorization actually given; never invent user confirmation or an automatic policy.
These fields do not accept Goal alignment or results, which remain human actions.
Inspect the returned original Goal ID; a lost receipt does not authorize a second create.`
