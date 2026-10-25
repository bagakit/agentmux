---
summary: "Bound platform identities, native API calls and external conversation connections"
roles: "Agents using their bound platform identity and authorized connection operators"
when: "Act through a bound platform identity, call its native API, or inspect an external conversation connection"
---

# connection

<!-- amux:content -->
The connection owner holds configured adapters, bindings, grants, ingress and delivery
receipts. Managed Agents authenticate with their original Session capability, never as a user.

## Use your bound platform identity

For an authorized action in a connected group, use this Session’s bound identity unless the
user explicitly selected another identity. A standalone platform CLI uses its own configured
account; choosing its bot mode does not connect it to an AgentMux binding. Do not silently
substitute another Agent’s bot, a tool’s default application or a user account.

For a reaction to an original connected message, retain its exact application, conversation
and platform message identity; a Core MID is a journal reading identity, not a platform message
ID. The connector manages only waiting and input-delivered markers. After starting work, decide
whether and how to express progress or a result through this bound identity; no automatic
completion reaction is required. Do not remove unrelated reactions or treat any reaction as an
input, permission, reading or completion receipt.

For a native business API call, discover an explicit bot identity with
connection api identities --session ID on its exact hosting endpoint. A managed Agent can list
only its authenticated original Session. Human-created and Agent-created bot bindings use the
same identity mechanism; enrollment ownership is not required. Multiple identities require an
explicit choice of bindingId/bindingRevision and connectionId/connectionRevision. Pausing group
synchronization does not revoke bot use, but detach, replaced/disabled configuration or inactive
private-chat policy cannot admit a new call. The Host rechecks the original binding and policy.
This identity grants the bot's effective native platform scope, potentially beyond this group;
it does not expand Core administration or external input/answer/permission grants.

Use connection api request --input FILE|- with
{operationId,identity:{bindingId,bindingRevision,connectionId,connectionRevision},
 request:{method,path,query?,body?,files?}}. Read the identity's documentationUrl and implemented
requestFormats/responseFormats. The adapter fixes the API origin and authentication; path is
relative, query values are string/number/boolean, and body is JSON. Multipart files are
{field,name,contentType,base64}: exact caller-transmitted bytes in canonical base64, not a Host
file path, caller URL or a credential reference. URLs, headers and arbitrary SDK options are
not accepted. Credential issuance/export/authentication endpoints are excluded by the native
adapter, not enabled by generic business composition. Limits are 256 KiB JSON body, eight files
with 4 MiB combined bytes, JSON depth 32 and 1 MiB JSON response; native limits may be smaller.

Keep the complete original input and operationId. The Host records the immutable intent digest
and sanitized receipt, not request body/file data or credentials. Original native SDK token
acquisition and safe rate-limit waiting remain inside that admitted call; an uncertain effect
is never automatically replayed. connection api inspect --operation-id ID reads the same
actor-owned operation without dispatch, even after detach or credential removal. A missing
receipt is not evidence of non-application. Do not generate another ID after an unknown result.
A responded operation reports native HTTP status and JSON/empty/unavailable body separately;
HTTP200 does not establish business success. Sanitization is explicit in response.redacted.
Unsupported/too-large/unreadable bodies stay unavailable rather than fabricated empty success.
No credentials enter Agent argv/env or native API results.

A third-party CLI can represent this identity only through an explicit integration with the
same bound-identity owner. Arbitrary CLI credential inheritance is not provided. Use the native
request entry for supported operations; report an exact format or permission gap when needed,
while keeping other authorized work available. Never copy Host credentials into a CLI profile.

## Inspect the original connection

Use connection owner inspect on the exact hosting endpoint to distinguish registered ownership:
local means this endpoint has a Connection port, forwarded means it has only a forwarding entry,
and unavailable means neither is registered. Local does not mean the user's machine. This read
opens no connector database and confirms no credentials, lease, platform connection or delivery.
Choose the connector hosting Host separately from an Agent's execution Host. Keep the original
Runtime and operation for an in-flight request; an already-provided Runtime fence is checked before
connection dispatch or forwarding. Owner inspection grants no configuration or member authority.
Cross-Host ingress retains authoritySource {hostingRuntimeId,executionRuntimeId} on its original
author and group-record reference. The Binding's executionRuntimeId is confirmed by its target
owner, not accepted from a caller. The executing Host needs an existing authenticated route back
to the exact hosting Runtime to read the original claim and current grant. A one-way execution
connection is insufficient. Reads confirm the destination instance and registered local port;
Host aliases never authenticate that source. Retain original references during an unavailable
authority read or revoked grant; ordinary local input remains available. Continue from the original
journal source, without substituting a current same-name Host. An old remote binding without a
confirmed Runtime requires an explicit original relink, not an inferred target or automatic move.
For a human-selected exact Session, use connection diagnose --host ID --session ID [--binding ID].
This bounded local read is available with the original managed caller. It exposes global service,
the exact Connection's adapterService policy (adapterId, enabled and revision),
transport, binding scope/grant counts and newest application/group intake with original Core
outcome/waiting reasons, including receiver aliases. Outgoing diagnosis reads the newest five
original delivery operations, retaining independent unknown effects and source gaps.
Diagnosis distinguishes bindingRevision from publicationRevision after trigger-only configuration
changes; original intake authors and receipts retain their own configuration revision. For explicit
delivery pages use connection delivery ls --order oldest|newest (default oldest); --after continues
the same requested order, while --after-content independently pages unresolved content. Managed callers
can list and inspect body-free receipts on their exact original Host/Session binding and audience,
including historical revisions, without being the bot creator. To explicitly retry your own original
delivery, use connection delivery retry with the same operationId. The Host rechecks that original
binding and audience, current publication authority and Runtime, and the original delivery's retry
eligibility; bot enrollment ownership is not required. An unknown resource upload can retry only
while its message was not attempted; an unknown message effect cannot replay. Receipt reads alone
grant no write or administration authority. A newer confirmed operation does not prove complete
synchronization. Diagnosis returns no bodies, member identities,
credentials or private setup data. Partial sections stay explicit; an empty page is not an
absence proof. Follow original cursors for older observations; diagnosis never retries or
rejoins input, reads the platform, or changes existing administration and grant permissions.

## Set up and manage an identity

Start with connection enrollment ls to discover adapterId/domain and your own original operations.
Use connection enrollment begin --input FILE|- with exact operationId, connectionId, adapterId,
domain, label and preset {name,avatar:{pngDataUrl}}. Only a person can scan/authorize the platform
challenge; keep active QR data on its original confirmation surface and out of ordinary logs.
Copy an offered action into connection enrollment advance --input FILE|- as
{operationId,ownRevision,decision:{actionId,kind}}. Confirm the exact account before choosing create.
Continue or inspect the same operation after an unknown response; never replace its IDs to retry.
An Agent can inspect/continue only its own private enrollment and management operations.
Once configured, its Connection appears in connection ls and can be used for setup/profile/room
operations. setup begin accepts the exact source enrollment to reuse its login; the separate
management account confirmation and finite offered actions still apply. For card interaction,
read-callback-settings first, select --application-configuration use-persistent-callback and
confirm its exact offered action to switch application-wide callback delivery. Read callback
settings again before a separate --application-configuration add-card-actions confirmation.
These two finite effects have separate receipts; event delivery does not configure callbacks. A binding/room creation
must name that same Agent Session, never another Agent. Global service/configuration, external
actor grants and existing human/device bot operations require their original trusted operator.
For Mote identity use space mote connection create/sync/advance/inspect/ls through the same owner.
Create/sync --input carries source {target,preparedFrom} and one desired {name,description,avatar?}
public profile. Create requires the actual PNG avatar; sync omits avatar to leave it unchanged.
The client prepares saved Mote copy and its real static image before submitting. preparedFrom
contains the topicRevision and nullable avatarRevision actually read during preparation, or null
when an explicit profile has no such observation. It is declared preparation provenance, never
Host-current appearance verification, input authority or the default file's CAS baseline.
The exact target stays within the authenticated Host and Workspace. The original owner validates
the target, actor, connection revision and actual PNG, then freezes the profile and child operations.
Retain that complete input: changing the profile, source or target on the same operationId conflicts.
Neither action edits the saved Mote copy. Historical source-only operations retain their original
source preconditions and frozen children for inspect/advance; old source-only bodies are not new
create/sync inputs. Keep an unconfirmed old request and inspect its original operation, without
filling it with new profile data or resending it. Application creation, profile write and Mote
default save retain separate receipts; missing original File acknowledgement remains unknown.
For private Mote chat use space mote chat configure/inspect/history/audience/allocate/diagnose --input FILE|-.
A person or device controls chat policy and per-person total allowances. A chat Agent may read only
its own retained lane with space mote chat history; copy the original target from its first context.
Authenticated callers can use diagnose with that complete exact target to read saved policy,
read-only readiness and the newest five direct-intake stages for the selected application.
targetKey and intake keys are equality fingerprints, not selectors or permission to read history.
The result omits private paths, content, people, quotas, Agent/Session references and raw errors.
An empty window means no observed intake in this window; unavailable is not absence. Readiness,
terminal confirmation and admission are separate observations, not proof of a reply or completion.
Diagnosis never starts an Agent, changes policy, fetches platform messages or retries an input.
The saved Mote Executor starts lazily on authorized direct messages. Inactivity creates a new Agent
without removing prior conversations. Quota counts unique admitted native messages, including the
last allowed message; replies do not consume quota. An unknown mutation keeps its entire input and
operationId; inspect that original operation before explicitly continuing the same intent.
connection delete --input FILE|- removes one exact local identity by connectionId and revision.
It preserves the remote application, conversations and receipts. Inspect the original deletion with
connection delete inspect --operation-id ID; a missing receipt never proves an in-flight delete failed.

For original request evidence use connection enrollment/setup inspect --operation-id ID --request-trace.
This separate local selection returns bounded ordered journal steps and next; copy that cursor with
--trace-cursor on the same original operation. It does not load QR/account/secret material or retry.
network:null means HTTP details were not recorded. Enrollment claimed/settled describe its journal,
not live dispatch or request success. Do not combine trace selection with private inspection/configuration views.

connection ls/inspect/test may include capabilities for the original registered adapter’s
room discovery, creation and joining links. Missing capabilities mean unknown support.
These implementation facts do not confirm credentials, native permissions or room visibility.
An unsupported new operation does not revoke saved bindings, grants or healthy local input.

Begin with connection ls/inspect; configuration, a successful test, an enabled
binding, ingress and actual outgoing delivery are distinct facts. Keep the exact connection,
binding and source identities rather than matching human labels or assuming transport trust.
connection service get reads the global Connector policy on the current endpoint; --adapter ID
reads one adapter's independent policy and revision. Service configure accepts optional adapterId
beside operationId, expectedRevision and service:{enabled:boolean}; omission keeps the global scope.
New automatic traffic must satisfy global, exact adapter and application enabled policy plus the
original binding and grant. Pausing one adapter preserves the others and already accepted Core input.
Retain the exact operationId, scope, expectedRevision and service input after an unknown configure reply;
service inspect reads that receipt, while get reports current policy and cannot acknowledge it.
Management, original receipts and healthy local Agent input remain available while service is off.
For an exact saved bot, connection setup begin requests one original management QR challenge unless
source is {kind: enrollment, operationId, expectedRevision}. That explicit local handoff reuses only
the original actor's confirmed saved creation login, with zero HTTP. Its request.kind is
enrollment-handoff: confirmed acknowledges local storage, never QR-init or management authority.
The sourced account still requires its own explicit confirm-account and explicit application reads.
After secure handoff, later source availability does not govern this Setup; retain the same input
for local ACK recovery. Discovery advertises enrollment-continuation only for its implemented domain.
Setup inspect is a local read of that actor-owned active challenge; setup ls returns safe summaries
and local implementation support bound to the current bot revision. Support is not login,
application authority, grants, publication or connection readiness; a paused bot retains management discovery.
Keep the original input after an unknown init; repeat begin only for original lookup or secure
handoff recovery, never a second native request. Scan material belongs on its exact confirmation
surface, not ordinary logs. Setup advance uses the exact actionId and expectedRevision from
continuation.actions or applicationInspection.actions with decision.value continue, confirm or
renew. One action performs at most
one HTTP request or its original local secure handoff; repeating the same input never replays it.
Renew explicitly abandons authentication within this intent, retaining old requests and snapshots;
it never creates an application. Scan, phone confirmation and exact account/enterprise confirmation
are separate stages. A confirmed management session does not establish app permission, tenant
membership, configuration, publication or chat readiness. App eligibility, configuration and
publication continuations remain separate. With --application-inspection, setup inspect can
locally page original safe application observations and select an exact old --inspection-step;
it never sends HTTP or repairs an ACK. Copy an offered inspect-application,
read-application-details, read-event-settings, read-callback-settings, read-bot-settings,
read-permission-catalog, read-application-permissions, read-event-catalog or
recover-application-inspection action and use decision continue. Current data subjects
retain independent receipts, not a complete configuration snapshot or readiness. Publication observations
include read-publication-pending, read-publication-versions, read-publication-visibility,
read-publication-sharing and read-publication-features. With --application-inspection --version-id ID,
copy the offered read-publication-version action and its exact versionId into advance input.
The request route and original binding select that version; list position and labels do not.
Version review status is separate from the online version pointer and actual message intake. New observation requires current
confirmed stored auth; original actor local recovery needs only the frozen original child/input,
even after renewal, revision or restart. Old private results stay withheld and an unrecoverable
old result never blocks a separate eligible new observation. Reported basic-info read permission
is not actual app data, owning tenant or write authority. Inspect locally reads the explicitly selected finite effect and its exact original source. Configuration selection always names its effect: use
--application-configuration enable-messaging or --application-configuration use-persistent-connection.
The latter reads only the exact event-settings source and offers one explicit application-wide
switch to persistent connection. Warn that existing event consumers are affected. Already persistent
needs no write; unknown native modes stay unknown. Its accepted write is not readback or publication.
Unknown results are isolated by app/effect/source subject and cannot block independent bot-enable. Copy an offered enable-messaging or use-persistent-connection action with explicit confirm;
An existing bot profile uses the finite goal {kind: profile-update, desired: {name?, description?,
 avatar?: {pngDataUrl}}, publication: {notes}} on the same connection.setup.begin API. Original
PNG bytes stay private; public history contains only avatarSha256. Empty description explicitly
clears the primary locale while preserving other localized descriptions. The original Console
session, upload, full profile write, fresh readback and publication keep separate receipts. Observe
profileUpdate stages and copy only its offered actions. Ordinary continue-profile-update fills
missing current publication sources; refresh-publication-checks reads the five publication subjects
and returns without writing, even if checks become ready. A separate offered action alone can
publish. Plain inspect exposes the original candidate/review at publication-create; explicit
configuration selectors keep their selected result. Local ACK recovery remains independent. A
profile operation never creates another application. The existing published include/exclude
ranges are retained. Other pending changes require explicit review through the returned
publicationDraft and the original create-application-version action. Inspect remains local;
unknown native writes are not replayed, and original historical Profile receipts stay queryable.
connection profile get --connection ID --revision N reads current profile and a qualified typed creator
when the exact application exposes one. A creator has idType and userId; null means no qualified creator
was returned, while an absent field in an original saved observation means it was not recorded.
Use that exact member with room.create.members only after reviewing the invitation. It grants no Agent access.
For necessary permissions select --application-configuration add-application-permissions with
--permission-purpose agent-conversation (messages, create/bind groups, participant names and avatars,
and this application’s creator lookup). New-bot setup, binding an existing bot and completing a saved
bot’s missing permissions share this purpose; native endpoint access does not imply profile-field access.
Consume offered read-permission-catalog and
read-application-permissions separately. Each original read owns its receipt and recovery; an incomplete
review cannot authorize additions. Confirm only the exact offered add-application-permissions action;
the Host binds its purpose and native missing IDs without a second caller scope list. Zero missing
means no request. Acceptance, existing applied configuration, effective grant and publication are
separate. Unknown permission additions remain original across purpose changes and do not block
independent messaging or delivery settings. Permission addition never writes data ranges, subscriptions or publication.
For group message reception use --application-configuration add-message-reception. The original
read-event-settings and read-event-catalog children qualify only the required App message event.
Confirm its offered add-message-reception action: this adds the event while carrying the last checked
application-wide persistent delivery mode; it does not secretly call the mode switch. Both event
writers invalidate older settings; a newer catalog alone cannot refresh them. After an unknown mode
switch, only fresh persistent settings and the compatible original immutable desired allow a distinct
explicit addition. The original switch remains unknown, unretried and unACKed. Already subscribed
means zero write; unknown additions cannot replay through aliases or renewal. Current subscription,
request acceptance, effective permissions, publication and actual intake remain separate facts.
recover-configuration-effect uses continue and only repairs its original encrypted ACK. An unknown
effect cannot be replayed through renewal, a new setup or a known application alias; unresolved
identifies the original actor-owned request when available. A new current read never signs that
old ACK. Local recovery does not change menus, modes, events, scopes, ranges or publication.
For publication select --application-configuration create-application-version or submit-application-version.
Inspect accepts --publication-draft FILE|- for the exact typed draft; inspection alone sends no request.
Creation uses {kind: create-version, version, notes, visibility: current|creator-only, optional
 desktopEntry/mobileEntry/reason}. Confirm the offered action with the same publicationDraft in advance.
Review all application changes, complete included/excluded audiences, entries and external sharing;
this affects the whole application and does not lock concurrent platform changes. Creation returns
its exact versionId without publishing. Submission uses {kind: submit-version, versionId, fullRelease}:
read and explicitly select that exact version, never a list position or version label. It has a
separate offered action and original result. Unknown creation cannot replay and does not block an
independently selected existing version. Unknown submission remains original for that exact version,
including a received response whose business outcome is unconfirmed. Preserve original local ACK
recovery before current platform eligibility. Request acceptance, version review, online identity
and actual message intake remain separate; this does not qualify live rights or the combined journey.

Configure or bind only within the user's authorized target. Inspect current values before
changing them; use the current help's exact input and operation identities. A grant is an
explicit authority decision, not an effect of reading this guide or an adapter message.
Read connection ingress and delivery records for their original source and acknowledgement.

Use connection metadata watch as the original authenticated person/device to observe this exact Host’s change hints. It returns no snapshot, body or credential and performs no native lookup. Managed Agents cannot subscribe to all connections. On opening or reconnection, reread only the relevant exact profiles; a lost watch retains saved observations, and cancelling it releases only this reader.

Use connection metadata get --input FILE|- for one exact cached actor or group, and
connection metadata ls --connection ID --kind actor|conversation for a bounded local page.
Both are local reads, including when the original Connection is disabled. Actor subjects are
{kind:actor,actor:{application:{domain,appId},idType,userId}}; group subjects are
{kind:conversation,externalConversationId}. They are display observations, never author or grant
proof. Read state, freshness and latest reason independently; unavailable may retain a confirmed
stale name/avatar. No cache result authorizes input, answers, permissions or sharing.
Use connection metadata refresh --input FILE|- for an explicit native lookup with connectionId,
expectedConnectionRevision and subject. Clear uses those same fields plus expectedCacheRevision
from get/list (null means no stored value). It clears only that metadata entry; messages, grants,
Session identity and resources retained for unknown native effects survive. No raw storage keys,
credentials or message bodies are exposed. Native query failure does not stop authenticated intake
or healthy Agents; retry the exact refresh when observation is available again.
Pause/relink affects the exact binding; it does not complete external work or stop Agents.
After an unknown delivery, inspect the original delivery identity. Retry only as the explicit
supported delivery operation with its frozen facts; never generate a second logical message
because a response was lost. Unavailable adapters retain configured bindings and known receipts.
Enrollment begin creates an original application intent; advance may perform a platform request.
Enrollment ls/inspect are local reads for restart recovery. Unknown one-time credential delivery
is inspect-only, never a reason to begin or poll again.

Credential administration belongs to the original authenticated person/device, never a managed
Agent. Use connection credential store --operation-id ORIGINAL_OPERATION --secret-stdin for
verbatim UTF-8 stdin through the selected Host's original Unix, SSH-to-Unix or end-to-end relay
transport. The CLI obtains and fences that exact current Runtime owner. Secret values never
belong in arguments, environment variables, input files, activity, device audit or diagnosis.
This dedicated transient store input is the only credential-bearing business DTO; ordinary
configuration and all results contain opaque references alone. New Host values use explicitly
marked plaintext in the original private SQLite owner (0700 directory, 0600 database), without
an OS key service. Unsupported original ciphertext stays untouched and is not decoded or
converted. Use connection credential inspect --operation-id ORIGINAL_OPERATION after an unknown
response; a null receipt is only the current observation. Explicit same-input continuation
retains the original reference, while changed input conflicts. Neither command grants external
actors, replays input or changes an Agent's capabilities.

New ordinary group bind/relink requests require publication scope future-shared-conversation,
using an exact Binding and future source cut. This shares
ordinary public human/Agent messages, progress, questions/answers and their supported resources.
It also shares original independent AgentMux Session messages after their exact typed
notification or direct message input key, recipient and original message association are verified. Notification/reference
wrappers are not speech. It excludes tool input/output, reasoning, generated context and
Provider-internal subagent collaboration, even when a source marks those parts public. Sharing a conversation is not authority to drive
the Agent: member input grants and the Binding trigger scope govern execution separately.
An original future-native-user-facing Binding or operation remains readable as public Agent
replies only. Opening it does not expand its audience. The original authenticated person/device
can explicitly confirm complete conversation sharing with a full-scope relink; earlier history
is not backfilled. Original receipts, member decisions and unknown effects retain their identities.
Recorded narrow bind/relink inputs are inspectable, not new dispatch requests. Original lifecycle
pause/resume and Mote private-chat publication origins keep their own existing contracts.

Application member defaults are managed with connection application access get, configure
and inspect. Get takes connectionId and an optional exact actor; configure takes operationId,
connectionId, expectedConnectionRevision, grantId, expectedRevision (null for a new rule),
actor, state and capabilities. Inspect takes the original operationId. Use --input FILE|-
for these structured inputs. Only the authenticated person or device can administer access.
The rule belongs to this hosting owner and exact adapter/application, including its current
and future bound groups; it is not shared with other bots or Hosts and does not change DM quotas.

Current connection binding inspect returns access separately from the original room grants.
Each member has a local decision and a typed room/application effective source. An explicit
group decision wins in full: missing capabilities are not filled from the application rule,
and revoked group access denies all three. An original decision remains effective across an
owner-confirmed unchanged publication relationship; a different relationship requires review.
Neither case silently becomes application inheritance.
Use connection binding member inherit with operationId, bindingId, expectedBindingRevision,
actor and expectedGrant {grantId,revision} to explicitly remove that local override. This
retains the original revisions and operation receipts. A historical inspection is not a
current access reading. Unknown writes remain the same original operation for inspection.

Input, answer and permission are independent. Permission access permits the affected groups
to receive the original request and limited tool context; it is not private disclosure to
only the allowed person. Every input or interaction rechecks its exact current effective
source before execution. A new group restriction invalidates an unexecuted application claim,
without stopping an already accepted Agent input or replaying an old refusal or unknown effect.

Use connection binding pause, resume or detach with operationId, bindingId and expectedRevision.
Pause keeps the relationship and member decisions. Resume retains the exact application, group,
Session and sharing rules, captures a fresh source cut and never backfills the paused interval.
A relink carries member decisions when the application, group, execution Host/Runtime,
Agent Session and input target remain unchanged, including explicitly saved changes to
message triggers or publication scope. Original capabilities and revocations persist;
old Binding/grant references remain tied to their original revisions. When only input triggers
change on the same active ordinary full-sharing relationship, the owner returns
publicationBoundary {revision} pointing directly to its original Binding row. This field is not
caller input. Publication keeps its original source cut, pending operations and unknown effects;
delivery inspection continues to use that original revision. Current member capabilities still
govern input and actions. A changed audience, execution target/source or paused interval takes
a new cut. Private Mote origins keep their separate creation contract.
Group ingress inspection retains publicationRevision on its original group target when the
intake owner qualified that boundary, including before claim. bindingRevision and input.author
keep their original configuration. This observation joins accepted context positions across
trigger edits; it never grants input or changes a frozen quote. An original intake without
this field keeps its own configuration position; no prior root is inferred. Only the exact
complete native-admitted input advances the position, including a late historical receipt
after permissions change. Byte confirmation, unknown effects and gapped quotes do not advance.
Detach ends current routing, retains original revisions and receipts, and never stops the Agent
or deletes the platform group. Its original operation stays inspectable after the live list changes.
Applied lifecycle operations reference independent notice deliveryOperationIds. Inspect or list those
original deliveries to distinguish the saved relationship from the group card's platform result.
The explicit notice may be sent while automatic synchronization is off and states that limitation;
it does not enable ordinary synchronization. A failed card never rolls back detach. Unknown effects
remain inspect-only; only confirmed non-application supports retry with the same delivery identity.
