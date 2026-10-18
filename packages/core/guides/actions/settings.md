# settings

<!-- amux:content -->
These commands act with the current Unix user's configuration authority. Agent identity
does not establish human approval. CONTROL_UNAVAILABLE means this host owner could not
be reached; do not read or write an alternative configuration. Settings inspect is partial:
it exposes the supported subset, not the entire client configuration. Saving configuration
does not launch an Agent or certify Agent health. No Runtime is started or connected for help.

Agent availability checks continue behind the restored workspace. A pending or failed
check does not disable an existing healthy Agent or certify that an Agent is available.
Use settings executors refresh for the exact configured Executor and Host to check again.

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

Executor command is one literal executable name or path on the target Host; paths may
contain spaces and must not be shell-quoted. Put launch arguments in the separate args
array, preserving each argument, including empty strings. Do not put a whole shell command
line in command. A missing executable reports the configured lookup failure, not proof that
the software is uninstalled. Changing configuration affects subsequent launches, not healthy Runs.

Executor refresh takes exact Executor and Host IDs and only checks availability. Available
means a regular executable was found; missing means no usable executable; check-failed
retains cause.code/message. It does not launch, stop, resume, save configuration or imply
Agent health. Use settings hosts test --input <file|-> for an unsaved connection draft.
Repair an already-bound SSH route with settings hosts update <id> --input <file|->, carrying complete expected and candidate Host records. This confirms the same Runtime and preserves Sessions and Runs. An unknown reply requires settings hosts ls readback; never replay Run operations.
Use settings hosts inspect --host <id> for one exact route's passive Runtime observation.
It returns the original configuration snapshot (null without a Host configuration owner),
separate semantic owner, Native identity, diagnostics and retained Run/attachment/output
facts. Source failures remain explicit; an unavailable source is not an empty inventory
or proof of a dead Agent. readAt is this service's read completion; resources.observedAt
remains the original producer sample time. Native build/protocol and bundled artifact
are not the serving Core version. Observation never starts Native, resumes a Session,
attaches a reader or grants source trust. Cancel ends only this read; keep original work.
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
or bypass of a person's application-link choice. It does not establish human approval.

Theme resources use settings themes ls / inspect / create / update / delete. The catalog includes
readonly built-ins and issues for unsupported saved records; those records are retained. ls also returns
iconCatalog: groups with labels/descriptions, semantic icons with exact id, label, description, groupId
and defaultGlyph, and the available glyph IDs. This read-only metadata comes from the same client catalog
as Appearance settings. Use an exact semantic ID as a theme icons key and a discovered glyph ID for
{kind: "glyph", glyph: ID}, or embed validated path data. Theme drawings never change control meaning,
permissions or accessible labels. Choose an
available ID using settings set appearance.themeId ID. A theme value is the complete versioned data
without its envelope ID. Create/update also accept the complete exported document when its ID matches the exact target; no ID rename is inferred. Editing a built-in requires a custom. copy. Custom update requires
{changes, expected: completeOriginalValue}; custom delete requires {expected: originalValue},
including the original raw JSON for an unsupported record. Deleting the active custom theme
returns atomically to the default and preserves application brightness and explicit Terminal colors.
settings themes inspect ID --output FILE creates an atomic new UTF-8 JSON theme file, including its exact ID,
both variants and embedded icon assets. Existing files or symlinks are not replaced. inspect also returns
the owner-authored document alongside its usual value metadata; Core does not interpret visual fields.
That exported file can be used directly by create with the same custom ID; an existing ID requires explicit
update with {changes: document, expected: originalValueOrDocument}, or a separate ID authored in the file.

