---
summary: "Host/Executor configuration, resource preferences and maintenance"
roles: "Authorized configuration operators"
when: "Discover or explicitly modify current user configuration"
---

# settings

<!-- amux:content -->
settings executors unregister ID --host HOST --registration-revision REV removes only an
exact registered publication on that executing Host. Read registrationRevision from discover;
configRevision remains the launch/recovery content digest and is not a deletion witness.
Retained original Session/history and admitted launch references refuse removal without
stopping work. The result removedRegistration:true can expose effectiveExecutor with the same
ID and source:configured or source:provider-default. These underlying entries are not removed
by unregister; it removes only the exact registered override. After unknown, discover
current facts; an absent/changed registration does not prove a lost historical ACK and must
not trigger automatic replay. No private args/environment are returned.

For managed Hooks, read runtimeId and configRevision from settings executors discover
--host HOST --executor EXECUTOR --refresh false. Then use settings executors hooks-inspect
--host HOST --runtime RUNTIME --executor EXECUTOR --config-revision REV --workspace PATH.
PATH is an absolute directory on the target Host. The check is read-only. A legacy direct
runner can still be declared alongside the current Hook. Use hooks-update with the same
flags as a transport-approved user to write the managed configuration and inspect it again.
The update result and remaining issues are separate. Old callbacks whose original dependency
is unknown stay in place. A write does not establish loading by an existing Run.
If the update reply is unknown, inspect before deciding whether to retry.

settings hosts tailcat inspect reads the answering App's local incoming configuration and
the original Host listener separately. settings hosts tailcat configure --input FILE|-
accepts {expected,candidate}; null is absent, explicit enabled:false remains saved data.
Only a transport-approved user without a managed Agent caller may save this sensitive
ingress. Agents may read and prepare the exact draft, not claim a user principal in JSON.
The generic Host configure local guard remains; key preparation remains tailcat-key.
No private key is read or exported by these methods. A saved config does not prove listener
adoption, a client connection or Agent/source trust. Listener failure/unknown preserves the
saved configuration and healthy Runs; inspect after unknown reports current facts, not the
lost original save ACK. Do not automatically replay a save.

The original configuration owner holds settings, Host routes, saved Executors and
resource revisions. Inspect the exact current owner and supported fields before changing
them. A saved route/template is not a connected Host, running Agent or human approval.

Read amux settings --help to select the exact configuration domain, then the matching leaf
help for its fields, authority, revision and save receipt. Discovering settings saves nothing.

Creation-source trust and message-source trust are separate approvals that only the
authenticated person can grant, one direction at a time. amux settings --help defines their
reads, exact input fields and authority; amux message --skill explains when a remote reply
needs message-source trust and how the original sender synchronizes it.

## Focus personal project routes

`settings inspect focus.projects` reads this client's personal Project and Collection presentation
preferences; its string value is a complete JSON array, default `[]`.
`settings set focus.projects '<complete JSON array>'` saves through the original
ConfigOwner, not an Agent or spatial mutation. Read the current array before editing
and retain unrelated entries, including references currently unavailable.

Each entry has exactly `{key,pinned,note,color,collapsed}`: `key` is the canonical JSON
string `[hostId,projectId]` from the original project reference, or
`["collection",hostId,[categorySpaceId,...]]` from the complete original Collection
scope. Collection IDs are nonempty, unique and sorted; preserve every confirmed
Category in a multiple-Collection scope. Names, cwd, Session and Region are not
substitute identities, and an unconfirmed Collection bucket has no saveable Category
identity. `pinned` is boolean, `note` is a personal string,
`color` is `default`, `blue`, `green`, `amber`, `rose` or `violet`, and `collapsed` is
`true`, `false` or `null`. Array order defines one shared order for pinned Projects
and Collections; unpinned
entries still retain their note and color. `collapsed:null` uses first-presentation
automatic compaction of known cold work; it does not classify unknown observations
as cold. Explicit search or exact reveal keeps the original target accessible.

For example, one entry is
`{"key":"[\"HOST\",\"PROJECT\"]","pinned":true,"note":"Main work","color":"blue","collapsed":null}`;
replace both identity placeholders with the exact original pair and preserve the
other array entries. Project and Collection appearance both use `pinned`, `note`
and `color`. A Collection entry uses its complete Collection key and defaults to
`collapsed:null`. Preserve the other saved fields when changing a preference.
Project branches/worktrees share that project's preferences;
different Hosts remain separate. A setting save is not a project rename, navigation,
Agent state change or permission grant. After a failed or unknown save keep the
original input and draft, inspect current values, and explicitly resolve any conflict.
Current values do not prove a lost save acknowledgement; never automatically replay
the write or replace a Session/Run to recover a presentation preference.

## Register and edit a Host

Host commands that require an input or original operation accept a standalone
--help or -h without contacting a service. For an ID-only command such as
settings hosts test or upgrade-check, that token can be the literal Host ID;
read its help with amux --help settings hosts test (or upgrade-check). Adding
--input keeps option-looking Host IDs literal.


Use settings hosts create <id> --input <file|-> to save a complete new SSH
record. The command ID and JSON id must match; kind is ssh, with label and hostname.
Optional user, port and transport retain literal SSH configuration. Omit runtimeId:
only the authenticated original connection learns that identity. Registration does
not install Core or mean the connection is ready. No private key is read or copied
by the configuration command.

Read settings hosts ls before editing. settings hosts configure <id> --input <file|->
takes {expected:completeSavedRecord,candidate:completeNewRecord}. It preserves the
Host ID, kind and learned Runtime binding; bound SSH route changes use the original
same-Runtime confirmation. settings hosts update remains the explicit bound-route
repair entry. Local label editing does not change local ingress authorization.

settings hosts test <id> checks the exact saved record; --input tests a complete
draft. settings hosts delete <id> --input <file|-> takes {expected:completeSavedRecord}
and removes only an unused SSH route. Workspace, durable Session and Run references
are retained; local cannot be removed. Unavailable reference observation preserves
the Host and reports the failed step. Never delete configuration files or create a
new identity to bypass references.

A configuration response confirms the original owner's save and publication.
After a partial or missing reply retain the original request, then read hosts ls;
the current value is not the lost operation's receipt. Do not automatically replay
create, edit or delete.

## Host home directory

settings hosts home --host HOST reads that exact configured Host's current homeDirectory.
The path comes from its original Core; a local path, SSH user name or display label is
not a remote home source. This read does not start Native, scan Sessions or register a
project. An unavailable Host remains unavailable; keep its original work and retry the
same read when its connection returns. Do not substitute the caller's home.

Add --session SID to the same home read to also return agentWorkspace with the exact
runtimeId, agentSessionId and workspacePath chosen by the executing Core. The no-argument
result is unchanged. This locator is only a stable per-Session address: it does not prove
that the directory exists, is owned, is trusted, may be created or may start a Session.
Unsupported targets and wrong Session/Runtime replies fail the selected read; never fall
back to the home directory as a substitute locator.

In Desktop, the person opens a device's home workface from its device name in Space,
without a manual project setup step; an existing registered home directory reuses its
original workface. Opening does not start an Agent or change another Session's cwd.
For explicit CLI registration, use the returned path unchanged with the existing
settings workspaces register input {hostId,path,name?,expectedHost?}. Registration only records an
existing directory; it creates no Git worktree and starts no Agent. A directory is not required
to be a Git repository. Registration, navigation and Agent creation have separate receipts.
When expectedHost is supplied, Main requires the committed Host at the registration transaction
to equal that reviewed connection; a same-ID replacement rejects only this registration and
preserves the original input. Without the optional snapshot, registration retains the ordinary
current committed-Host semantics.

## Node management

For full-policy preparation, an authenticated managed Agent on the original user operator
transport may read `settings node inspect --host ID --expected-runtime RT`. This selects
one saved operator carrier and pins the original Runtime, not a Host label or global UID.
Use `--input` with the original operationId when inspecting a prior save. Device, guest,
publication-only and delegated routes cannot borrow that operator scope. The same
authenticated local Agent can use settings node configure with both target flags
and its original complete policy, expectedRevision and operationId. Private owner
resources retain their separate permission. Preserve every original allowed/denied/default path when
preparing a Share change; published roots are not the complete private policy.

Cluster → Node defaults to this device and can explicitly select another saved Core.
Its publishing editor uses that original Node owner, Runtime and policy operation;
switching the management target does not change an Agent's execution or replay a save.
Publication uses the original user operator transport. A local managed Agent must
retain its authenticated caller; an ordinary device gains no owner scope by selecting
a target. Incoming connections remain
the original device's listener settings; another Node never shows this Mac's editor.

## Tailcat transport

Settings → Cluster → Mesh → Connections → selected Host → Connection holds the original Host's transport selection:
SSH (the default), SSH with Tailcat backup, or Tailcat only. A remote Host keeps its existing
id, kind=ssh record, SSH fields and Runtime binding. transport selects the carrier;
tailcat holds {address, keyFile}. Turning Tailcat off leaves the original SSH route intact.
settings hosts ls/test/update and settings resource configuration use the same strict Host
codec. Read each leaf's --help for the exact input and expected-value save contract.

Tailcat needs AgentMux and the official Tailcat CLI on both machines, and AgentMux must
already run on the receiving machine. The person can prepare a key in the App, or with
settings hosts tailcat-key --role server on the receiving machine and --role client on
the sending machine. Read its --help for an optional saved key name. Preparation belongs
to the answering Host, requires its transport-approved user, and refuses managed Agent
callers. It uses the official CLI, creates only a missing key and never replaces an
existing one. The result's created flag distinguishes new from reused; only the client
returns a public key as its connection code. Private keys stay in their original files.
Saved server keys include a PSK and fixed relay. Never publish the listener's private address.
The Desktop part is the person's: ask them to complete it at these locations. On the
receiving machine, Settings → Cluster → Mesh → Connections → This device → Connection takes
the saved server key, the client public key under Allowed clients and the Allow Tailcat
connections switch. Save incoming connections applies that original local Host config; its refreshed status reads
the original listener. Save hosts independently saves the Host collection and never submits the
listener draft. Node publication has its own separate Save publication and Core
policy receipt; neither save claims to commit the other domain. On the sending machine, that remote Host's Connection Tailcat field takes the
listener's private address and the saved client key; then that exact Host is saved and tested.
Missing CLI, invalid saved key or listener failure is visible; a listening receipt does not
prove a client connected. Disabling only stops this listener and retains existing work.
settings hosts inspect --host local reads the same listener state. Configuration changes
still require the original user's settings authority; Agent possession of a key is not
settings authority. Tailcat does not install a remote Core or expand the Linux SSH upgrade.

## Current remote communication

settings hosts agent-resources --host HOST --kind records independently reads
Saved/current and Retired original Core records, even when Native is unavailable.
Use --kind running for the exact current saved-binding intersection with one Native
running inventory. Add --expected-runtime RUNTIME to pin either read to its original
Core. Each response carries kind, owner, measurement and its own source time; running
also identifies the Native inventory instance/time. These reads are not an atomic
cross-owner cut or an instantaneous Running/Saved ratio. Terminal/helper Runs,
retired Runs, deleted-record tombstones and unacknowledged creations are not these
Agent counts; counts do not mean Provider working/waiting status. The original
settings hosts inspect stays Native-only and does not wait for the Store. Missing
old-Core methods, unreadable Store or Native failure affect only the requested
measurement. No read imports/initializes the Store, hydrates history or changes a
Session. A full visible service refresh may use two independent thin Native
inventories, never per-Run status or a background global sampler.

settings hosts inspect --host HOST also reports the observing service's original
Host Runtime RPC carrier, when available. It is not the saved preference or the
remote listener's state. SSH-first with Tailcat backup can currently use SSH or
Tailcat; a candidate route is not current until adopted. A closed channel's last
confirmed transport is retained as history, never relabeled currently connected.
An unopened or unavailable observation remains unknown. The carrier fact does not
prove Agent health or a measured Tailcat direct/relay path.

Desktop shows current communication, confirmation time and saved preference when the
person hovers or focuses the exact device/Host identity. This reads existing transient
state and does not connect, probe, scan Sessions or start a polling loop. The device title's
~ marks its home action, not a guessed path. Home failures stay local to that action
with a compact retry; original workfaces and healthy capabilities remain usable.
A recognized older remote Core owner protocol requires an explicit Core update,
not a fallback to an older contract, Session replacement or automatic operation replay.
Private Tailcat addresses, key paths and raw process errors are never connection labels.

## Review a remote Core update

The Core maintenance section in Desktop Settings → Cluster → Mesh → Connections → selected Host → Connection compares
the current deployment with the candidate bundled in this App. It is not an online
latest-version check. Package versions, source commits,
deployment digests, Core owner API protocol and required Native Runtime protocol
are different facts. Missing current facts remain unknown; protocol numbers and
commit hashes do not stand in for a package version.

Read `settings hosts upgrade-check --help` for the exact input. The check reads
the exact supplied or saved Host and its original maintenance owner without
upgrading it. Applying an update still requires that exact target to be saved. Its current
observation and bundled candidate are separate from any historical operation.
If the current candidate cannot be assembled, `candidate` is `null` and
`candidateUnavailable` explains the local failure; current deployment and any
original operation remain independently observable. Inspect the original
operation by its existing ID rather than treating its candidate as the current one.
`unreadableOperations` lists operation IDs whose maintenance record cannot be read.
Their original Host and outcome are unknown and they are never replayed; they do
not hide the current deployment or block an upgrade of another Host.
Only an eligible result includes the pinned expected facts for an upgrade. reason ready
means the upgrade restarts only the Core service and keeps Sessions and running processes.
reason native-replacement means the serving Native is too old for a same-process handoff:
the upgrade saves a copy of the Native state and restarts Native on the candidate, so the
running Runs listed in nativeReplacement end, while Sessions, history and the Runtime ID
are kept and ended Runs continue through Session recovery. expected pins those Runs; a Run
started after the check refuses the upgrade before anything stops. Tell the person which
Runs end before they confirm. Desktop shows one Core maintenance summary for the
exact Host. An explicit Update Core action applies an eligible Core-only candidate
and its pinned expected facts without another review screen. A Native replacement
still requires a separate review of its ending Runs and explicit confirmation;
cancelling that review does not upgrade. An unavailable observation does not mean
Core is missing or authorize a first install. A changed candidate or target must
be checked and explicitly selected again, not silently substituted after the
original action.

Upgrade and reconnect require the original operator transport. A local managed
Agent may execute user-authorized maintenance on the authenticated user operator
transport while retaining its actual caller. An Agent on a device or delegated
transport gains no operator authority. Command parameters cannot supply an identity. Read-only
checks and original result inspection retain their diagnostic scope.

Read `settings hosts upgrade --help` before an explicitly authorized update. Keep
the original input, expected and operationId. A lost or unknown receipt does not
mean the operation did not happen. Use `settings hosts upgrade-inspect` with that
original operationId to inspect its result; this query does not adopt a new
connection configuration or repeat deployment. Historical operations retain their
original candidate digest; an old receipt without version metadata stays unknown
rather than borrowing this App's current candidate.

A completed deployment and this client's connection adoption are separate results.
For a completed original operation, `settings hosts upgrade-reconnect` explicitly
adopts its verified remote command and checks that exact saved Host, retaining
the original operationId. It does not run the upgrade again. A pending or failed
connection check leaves the completed deployment fact intact and provides the
original retry path. Maintenance never replaces a Session or replays an operation; only the
reviewed native-replacement path ends the running Runs it listed.

A Core running under a user systemd unit is upgraded through that same unit and
its exact MainPID. After the new owner is verified, the release is selected as
current and that original operation's temporary start override is removed.
An upgrade inspection may finish removing only that override and reload the
user manager's unit definitions; it does not start or stop a service, reinstall,
or replay an upgrade.

This path supports an already installed Linux x64 headless Core that meets the
maintenance owner's exact qualification. A saved Linux x64 SSH Host with no Core
can be installed explicitly with `settings hosts install-check` and
`settings hosts install`; neither runs when merely opening settings or testing a
connection, and a Host with a serving Core is only ever upgraded. Nothing here
installs AgentMux on another Mac or authorizes a new target. Tailcat replaces a
carrier; it does not extend that maintenance qualification.

## Local readable protocol reference

Documentation → amux Protocols shows this app version's formats and original wire
examples using the shared message cards. The following list comes from this local CLI's
same Core definitions; it does not describe the connected Runtime or an older installation.
Reading a declaration does not authenticate its author, execute hints or grant permissions.

[Current protocol-catalog](../../dist/amux-protocol-definition.js "amux:generated protocol-catalog")


## Review one original Core maintenance action

A managed Agent can prepare an exact install or upgrade request after saving the
Host and reading its original `install-check` or `upgrade-check`. Use
`settings hosts maintenance-request --input FILE|-` with
`{action:"install"|"upgrade",id,host,expected,operationId}`. `host` is the complete
saved Host record from `settings hosts ls`; `expected` is the exact original
check, including the chosen install keepRunning or the upgrade's reviewed ending
Runs. Submitting only retains the request. It neither installs nor upgrades.
The answering service records the authenticated requester Session, source Host,
known source Runtime and Run; missing Runtime identity remains unknown.

Retain the returned `requestDigest` and original `operationId`. The authenticated operator
reads `settings hosts maintenance-inspect --operation-id ID`, reviews the exact
Host, candidate, action, requester and effects, then calls
`settings hosts maintenance-review --operation-id ID --input FILE|-` with
`{requestDigest,decision:"approve"|"reject"}` from its authenticated transport.
A local managed Agent on the original user operator transport can review its own
request under the user’s authorization. The record retains the actual Agent reviewer,
including its current Run; another Agent cannot review that request. No caller may
supply a user identity or turn a request ID into a reusable grant.
Approval executes that one original action through the existing maintenance
owner; it does not authorize future operations or source trust. A changed Host,
candidate or expected tuple requires a fresh explicit check and request.

The request, reviewer decision, maintenance receipt and connection adoption are
separate facts. Request state `finished` means the owner returned a receipt;
read `result.status` for completed, failed, running or unknown deployment and its
connectionAdoption for saved connection confirmation. Approval is durably
recorded before the remote action. After a lost reply, restart, executing or
unconfirmed result, inspect this same operation. A missing original remote
receipt is unknown, never permission to execute it again. Repeating review of
an already decided request only reads its original result. Rejection changes no
Host, Agent, Run or remote service. Direct install/upgrade commands keep their
original operator transport and exact target requirements.

## First install on a saved Linux SSH Host

Run `settings hosts install-check <id>` only when you intend to review a first
installation. The check reads the platform, glibc, install prefix, socket and the
user service's actual availability. It never installs, starts a service or changes
Host settings. An existing Core belongs to the upgrade path.

For an eligible result, retain the exact `expected` fields, add
`keepRunning: "start-script"` or `"systemd"`, and explicitly authorize
`settings hosts install <id> --input <file|->` with
`{expected, operationId}`. The same transport-approved user/device authority as
upgrade is required. A local managed Agent on that original user operator transport
can perform the user-authorized installation. Systemd is a user service;
AgentMux does not enable linger or overwrite an existing service unit.

Installation copies the pinned Linux Node and the same offline Core candidate
used by upgrades, writes the restart entry, starts the Core and reads its exact
owner. Main then saves this Host's command, socket and Runtime identity and
checks its connection. A completed installation and a confirmed connection are
separate facts; newer Host edits are retained.

After a lost reply, use
`settings hosts install-inspect <id> --operation-id <original-id>`. It reads the
original operation and may confirm the original serving process without
repeating installation or reconnecting. An unknown result never means nothing
happened. `install-check` retains `latestOperation`; unreadable records retain
their original IDs in `unreadableOperations` and do not hide another Host.

`settings goals common-actions inspect` discovers the authored directory (null means default),
effective ordered references, available builtin/Prompt references and unresolved saved references.
Use `configure --input FILE|-` with `{expected,directory,promptEdits?}`. Both directories are full
`{items:[{kind:"builtin"|"prompt",id}],collapsed:boolean}` or null. `[]` is an explicit empty list.
Optional Prompt edits are `{id,expected:<full editable fields>|null,value:<full editable fields>}`
for currently referenced Prompts, saved in the same ConfigOwner transaction. Ordinary authenticated
Agents may edit these preferences; this grants no Host trust or maintenance authority. An unchanged
broken reference stays visible as an issue. After an unknown reply read current values; this read
does not prove the earlier save acknowledgement and never retries a write.

## Channel header display

`settings channels header inspect [--adapter ID]` discovers current first-party
channel presentation IDs and retains any saved unknown adapters. Each row separates
`authored` (true, false or null) from effective `visible`; null uses the visible default.

`settings channels header configure --adapter ID --input FILE|-` accepts only
`{expected:boolean|null,visible:boolean|null}`. For example, after reading authored=null,
`{"expected":null,"visible":false}` hides that adapter in this App’s Agent header.
null resets its authored preference. The original ConfigOwner checks only this adapter;
other adapters and all Connection traffic/authority remain unchanged. Ordinary
authenticated callers can edit this display preference. Inspection after an unknown
reply reports current values, never a past acknowledgement or automatic retry.
