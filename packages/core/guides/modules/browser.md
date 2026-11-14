---
summary: "Embedded Browser targets, page programs, tasks and original receipts"
roles: "Agents reading or operating web pages"
when: "Open, inspect, automate or recover a Browser operation"
---

# browser

<!-- amux:content -->
The Browser owner holds exact page identities, capabilities and operation receipts.
Reuse the Browser already confirmed for this task. Read its actual target/capabilities before
acting; labels do not establish website state, permission or completion. Keep the original
page, user input and unknown operation identity; do not bypass refusal or human control.
Target `ready` describes an operable resource, not page-load completion. Read the optional
`navigation` observation in targets or `pageInfo()` to distinguish the requested address
from the native document and its original navigation error; see browser targets help.

[Browser target choice](../shared/browser-target-choice.md "amux:include")

`browser open --survey` explicitly registers only the returned Browser/Region in Survey,
including the persistent default environment; it keeps the original destination and does
not select or create a whole research. Registration/save failure retains the healthy page.
Read `space --skill` for the creation → exact registration → `app focus --surface survey`
selection workflow and its SDK calls. `browser create` belongs to standalone Browser hosts;
Desktop uses the spatial `browser open` owner. Read `browser capture --help` and the capture
section of `browser run --help` for the same page's PNG export and precise pixel scope.

Before creating an Agent from an existing Browser, use browser agent-workspace prepare
--browser ID. Read that leaf's help for --expected, which freezes the original
{workspaceId,mode,profileId}. The original Browser and Host owners prepare or reuse its
execution directory and saved Workspace; no Zone, Agent or Run is created by preparation.
Continue only from outcome=ready and registration=confirmed, using the returned Workspace
as the execution resource in agent open --help and space --skill. An unconfirmed result
keeps its directory/registration observations and original page; inspect that same Browser
and resource before another explicit attempt, without silently choosing another directory.

Read only the matching local help:
- amux browser profile --help: original Profile identities, routes and usage.
  Use browser profile copy to create a new identity from the source's saved settings,
  naming its exact ID and its opaque `profile.revision` token read from ls or inspect. Activity observations and edits to another Profile do not invalidate this token. It keeps the original
  Profile and pages; site data, sign-ins, proxy passwords, human approvals and prior
  runtime history do not move. Use the returned new Profile ID to inspect, edit or
  open it. All five new-identity actions (profile create/copy, folder create, view create,
  proxy create) require an explicit --operation-id ID. Keep the exact original input and ID.
  Query a missing reply with browser profile creation inspect --operation-id ID; it returns
  the original createdId independently of current rename/archive/removal. Never infer the
  result from a matching label or time. Inspect is read-only; observed metadata does not
  prove that the original reply or directory durability ACK reached its caller. An explicit
  retry of the exact same actor/request/operation confirms the currently retained original
  metadata and returns its original identity before checking a later source/collection CAS;
  it never creates another one. confirmation:current-metadata-sync describes that current
  file/parent sync, not delivery of the historical reply. confirmation:observation remains
  read-only and unconfirmed. GUI pending requests keep their full input until the explicit
  Confirm creation action and the client checkpoint are both acknowledged. Changed input or
  another actor with that operation is rejected. Do not automatically replay unknown work.
  The root `revision` is the configuration collection stamp used by folder actions;
  `sequence` orders complete snapshots including confirmed activity checkpoints.
  Neither root stamp is the per-Profile configuration token. Activity is read-only: observed
  Browser time counts overlapping pages once, and partial or interrupted history is unknown.
  Tags, folder assignment and pinned state are organization metadata, edited through
  profile update. Discover the stable folder IDs in profile ls; folder create/rename/delete
  stay under browser profile folder. Deleting a folder only unassigns its Profiles;
  no Profile, Browser or website data is deleted. Copy carries tags and the same folder
  assignment into the new identity, but does not pin it. Pinning grants no page input.
  Query this library with profile ls --query '{"status":"unknown","sort":"name"}'
  or --view ID. Queries may filter search, exact folderId (null means unfiled), tag,
  observed status, saved route and lastUsed day/week/month/unknown. Missing observation
  is unknown, never unused. The reply's filter identifies its query and observation time;
  it is not the full catalog. A missing folder refuses that scope rather than expanding it.
  Saved views are named queries in the original Profile catalog: profile view create/update/delete
  use the root configuration revision. They store no selection and alter no website data.
  Apply metadata to an explicit set with profile bulk-update --items JSON --action JSON.
  Items freeze [{profileId,expectedRevision}] from each exact Profile token. The supported
  actions are pin, move to folder, add-tag and remove-tag. Read every updated/failed item;
  partial failure leaves successful items saved. New matches never join the frozen set.
  A missing receipt is unknown: inspect the original IDs before considering another write.
  Profile recycling uses profile delete --profile ID --expected-revision TOKEN and requires
  a verified person or device. Default, open, switching, closing, saved cold, native page,
  worker, request or download use prevents this action; unknown use or source IO keeps
  the Profile and its healthy work. The same metadata transaction retains the entire
  original record and original partition in place. No data is cleared, copied or moved;
  recycling is not an independent backup or immediate disk release.
  Read profile trash ls for exact archive IDs and revisions. A person/device restores
  one with profile trash restore --archive ID --expected-revision TOKEN. It returns the
  original Profile ID with a fresh configuration token, retaining its site data, proxy
  sign-in and human permissions. Missing source or ownership conflicts never substitute
  an empty Profile. If the original folder is gone, explicitly choose --folder ID or
  --clear-folder. Legacy deletion tombstones have no complete recoverable record and
  remain separate unconfirmed cleanup facts. After a lost recycle/restore receipt, read
  these original identities first; do not automatically replay the write.
  Recycled entries have no automatic expiry unless the person/device approves one with
  `profile trash retention --archive ID --expected-revision TOKEN --purge-id ID
  --delete-after TIMESTAMP` (future Unix milliseconds); `--keep` retains it indefinitely.
  `profile trash purge --archive ID --expected-revision TOKEN --purge-id ID` separately
  approves permanent removal of that exact entry. Preserve the original purge ID and read
  `profile trash inspect --purge-id ID` after an unknown reply; inspection never repeats deletion.
  The original Store retains progress before cleanup. An admitted native Session cannot be
  disposed, so its cleanup waits for a later App process. That process must still confirm its
  exclusive original storage root, no native admission and complete cold/native usage facts.
  A verified whole safety copy is confirmed before removing original files. Copy or partial
  cleanup failure retains a recovery source; an uncertain final erase remains unknown.
  Metadata/partition removal and original credential/permission-owner cleanup are distinct receipts.
  A person or device can set a proxy sign-in with browser profile proxy-sign-in set
  --profile ID --input FILE|-; the JSON contains only username and password. Never put
  a password in command arguments. Managed Agents cannot set or clear sign-ins. The
  saved/cleared fact and reconnected result are separate; reconnected:false retains
  the confirmed credential write, so do not repeat that write to reconnect a page.
  browser profile network check --profile ID observes the configured HTTPS address
  through that Profile's session. Unknown leaves the Profile and its pages available.
  browser profile network probe --profile ID [--operation-id ID] records a separate
  TCP/SOCKS5 sign-in/Profile exit diagnostic for the exact current configuration.
  TCP and RFC1929 authentication use a direct socket to that proxy; authentication
  success does not certify Chromium's authenticated SOCKS, UDP or QUIC traffic.
  The exit observation alone uses the original Profile session. Credentials remain
  inside their original encrypted Main owner and never enter reports or history.
  Read network history --profile ID [--operation-id ID | --before ID] after an unknown
  reply. Pages contain at most twenty original records; nextCursor names the oldest
  item in this page. Original unfinished records survive restart and are not replayed.
  A missing result remains unconfirmed. History updates do not invalidate settings
  drafts, change native routes or close healthy pages; the original exit check remains
  available independently of diagnostic history storage.
- amux browser profile cookie-file --help: explicit Cookie JSON file exchange through Main's
  original Profile/Session, trusted person confirmation and file owners. All six leaves accept
  `--input FILE|-`. `prepare-import` takes `profileId`, `operationId`, `source` and `scope`,
  returning a safe review ID/counts; `import` or `discard` names `profileId` and that `reviewId`.
  `export` takes `profileId`, `operationId`, `destination` and explicit `scope`. A location is
  `{kind:"local",path:"/absolute/selected.json"}` or
  `{kind:"workspace",resource:{hostId,workspaceId,workspacePath},path:"selected.json"}`.
  Scope is `{kind:"profile"}` or `{kind:"sites",sites:["example.com"]}` (all Cookie partitions
  for those exact registrable/private-suffix sites, IPs or localhost). Main asks the person
  before any import effect or export Cookie read; request text cannot approve it. Source
  bytes stay fixed after prepare. Existing output files are kept; new local output is private.
  `inspect` takes `profileId` and optional original `operationId`, `offset`/`limit` (1–64) for
  per-index outcomes; pending IDs are discoverable after restart and never automatically
  replayed. `reveal` names an original person-approved export ID and returns only whether its
  selected file location was revealed. Ordinary results contain no Cookie names/values or
  source/destination paths. Read both item counts and export `fileOutcome`; completed means
  the file owner confirmed writing, not that a website authenticated. Invalid/expired/duplicate,
  outside-scope and unsupported Cookie entries are reported individually without clearing
  original data. CHIPS, host-only/domain/path, Secure/HttpOnly/SameSite and session/expiry
  remain distinct. After an unknown reply keep the original ID; do not retry its native effects.
- amux browser profile storage --help: inspect the original Profile's website offline disk cache,
  separately from Renderer memory. Both leaves use `--input FILE|-` JSON. `inspect` takes
  `profileId` and optional original `operationId`; read coverage, unattributed bytes and issues
  alongside site sizes. `clear` takes `profileId`, `expectedRevision`, `operationId` and
  `sites:[{origin,storageKeys}]` copied from that inspection. Select one site or all identified
  sites in one operation; unknown data cannot establish additional keys. Only the original Main
  human confirmation approves deletion. All current Cache API buckets in the frozen keys are
  in scope, including unmeasured buckets; cookies, IndexedDB, localStorage, Service Worker registrations and other
  Profiles remain. Pending IDs survive restart; inspect the original ID after an unknown reply
  and never replay deletion automatically. Native acknowledgements and before/after disk
  measurements are separate; active pages can rebuild caches.
- amux browser profile bookmark --help: managed bookmarks in the original Profile metadata.
  All five leaf commands use `--input FILE|-` JSON; `ls` requires `profileId` and `folderId`
  (`null` for root), optionally `operationId` to check an original receipt. It returns the exact
  folder's entries, ancestor path, library `revision` and all original pending operations for recovery.
  `edit` requires `profileId`, `expectedRevision`, `operationId`, and `change`: `create-folder`
  (`parentId`, `label`), `rename-folder` (`id`, `label`), `move-folder` (`id`, `parentId`),
  `remove-folder` (`id`, must be empty), `save` (`folderId`, `title`, optional existing `id`,
  optional `url` to keep an existing address), or `remove` (`id`). New bookmarks require `url`.
  `import` also names `folderId`, `sourcePath` for Netscape HTML, `.webloc` or `.url`; it appends
  new identities and reports conflicts without overwriting originals. `export` names `folderId`
  and `destinationPath`; it writes a new Netscape HTML file and never overwrites an existing file.
  `open` names `bookmarkId` and `browserId` in that exact Profile. The original Browser owns
  input, Agent eligibility and app-link consent. A completed open receipt confirms the original
  open request, not that the site succeeded. Query the original operation after an unconfirmed
  reply; pending operations survive restart and are never automatically dispatched again.
  Bookmark URLs retain their complete query/fragment for accurate reads, edits, opening and export;
  operation receipts and diagnostics omit URLs and local source/destination paths. The Workspace
  star still writes a standard `.webloc` through the original Workspace file owner.
- amux browser profile extension --help: per-Profile approved extension packages.
  `extension ls --profile ID` reads configured identities and current native load facts without
  creating a native Profile. `prepare --profile ID --expected-revision TOKEN --operation-id ID
  (--source PATH | --package-url URL | --update-manifest URL --addon-id ID |
  --recorded-source --extension ID) [--extension ID]`
  stages a local directory/ZIP/CRX, an explicit HTTPS package, or the exact add-on from a standard
  Chromium XML / WebExtensions JSON update manifest. Online acquisition uses no website cookies.
  The host supports numeric versions with one to four components; manifest identity/version and
  declared JSON hashes are checked against the acquired package. Preparation runs no package code. Preserve its review ID. `apply --profile
  ID --expected-revision TOKEN --review ID` asks the original host human-confirmation owner;
  neither an Agent request nor package text grants approval. Source identity changes are separate
  installs, never silent replacement of an old extension. A changed permission scope stays explicit.
  `check --profile ID --extension ID` reads only the exact retained manifest: update-available
  and current describe its observed versions; unknown reports an unreadable or changed source.
  Manual means choose an explicit source because this installation has no retained manifest.
  Checking downloads no package, starts no native Profile, grants no consent and changes no bytes.
  `prepare --recorded-source --extension ID` uses that installation's private original manifest,
  reads it again and freezes the actual new package for review; the earlier check is no approval.
  Display-only declared update URLs are never used in place of a retained acquisition address.
  After a missing apply reply, `extension ls --profile ID --operation-id REVIEW` reads that original
  durable change receipt and pending dispatch intent, including after a host restart. A null receipt
  does not prove that no native code ran. Pending original operations cannot be dispatched again. Unknown changes
  are never automatically replayed. `remove` uses an exact extension, Profile token and original
  operation ID; native unload and metadata saving are separate confirmations. Site sign-ins and
  Profile data remain. `load --profile ID --extension ID` explicitly retries only the original
  approved package. Native loaded confirms its identity/version, not every Chrome API. Failure
  keeps normal Browser controls and other Profiles available. Public source labels, origins and hashes identify acquired bytes; original local paths and complete
  online addresses stay inside the original trusted Main owner and human confirmation. Package signatures establish
  integrity, not trusted publisher or store provenance; declared update sources remain visible.
- amux browser targets --help: discover available exact targets and their readiness.
  A target's optional objectLink is its stable original resource reference; url remains the
  actual document loading address, including its route. Neither grants input permission.
  Keep a Capsule's amux://capsule/ID reference when copying or saving it, and use the
  original capsule open owner to resolve and display that page; do not send its object URI
  to a generic webpage navigation or system application handoff.
  Submitting a Browser's own Capsule reference in its address field addresses that exact
  Browser. Its owner checks the original Capsule binding, actual current document origin
  and human input eligibility, then keeps the same route and document without reloading.
  Another view of that Capsule does not make this exact request ambiguous. A stale field
  cannot retarget an external document; a different object still uses its original owner,
  and a global Capsule open with several existing views requires an exact destination.
- External clients use the typed `@agentmux/core/browser-sdk` connection for an explicit RPC endpoint.
  The separate `@agentmux/browser-mcp` stdio adapter reuses that connection and original managed
  credentials; its `--help` describes setup. Browser/operation IDs stay explicit, stream Gap
  facts remain visible, and cancelling an observation never substitutes for browser.stop.
- amux browser run --help: page-program API, capability names and original result/receipt reads.
- For visual reading in Desktop, focus the webpage or its Browser toolbar. The person can
  use `Cmd+-` to fit more content (try 75%) or `Cmd+=` to enlarge small text (try 125%).
  Use Ctrl on other platforms. `Cmd+0` or `Ctrl+0` restores the Desktop default of 90%.
  A non-default percentage is shown by the address field or in More on a narrow pane. Future opens
  reuse that site's saved zoom in the same Profile. Agents read at the applied zoom.
  For a wider layout during an Agent task, use
  `amux browser viewport --browser ID --preset desktop` when the original target supports it.
- amux browser viewport --help: change the same embedded page's execution Viewport through its original owner.
  `--preset mobile|tablet|desktop|responsive` shares the App's presets; custom `--width 844 --height 390`
  (mobile layout by default) tests landscape without navigation. `--screen desktop` chooses desktop
  layout behavior. These are layout dimensions, not a complete device identity. Supporting targets
  advertise `setViewport`; page programs use `setViewport('mobile')` or
  `setViewport({width:844,height:390,screenPosition:'mobile'})`, followed by `pageInfo()` for the
  original applied state. Human control and Stop remain authoritative. Keep unknown operation IDs
  and inspect rather than replay. Screenshot sampling is separate: `browser capture --pixel-ratio 2`.
- amux browser task --help: source/draft discovery, draft edit/publish, original create receipts,
  version reliability, run, batch, explicit parallel targets and stop.
  `browser task parallel --browser SOURCE --asset ID --version N --input FILE|-` accepts
  `{operationId, concurrency?, targets:[{id,browserId,profileId,parameters,calls?}]}`.
  Retain that exact operation id before dispatch. It freezes one original source version;
  target pages use their exact Profiles without copying definitions. Shared Profiles serialize
  within parallel work while independent Profiles progress. Fresh values stay in memory.
  `browser task parallel-inspect --browser SOURCE --operation-id ID [--after TARGET] [--limit N]`
  reads original target/run ids and results; use each returned Browser/run with `task inspect`.
  `browser task parallel-list --browser SOURCE [--before OPERATION] [--limit N]` pages retained
  operations. Both reads work without native pages. Reader cancellation only stops reading;
  unknown replies and restart never authorize automatic replay of an original operation.
  `browser task parallel-stop --browser SOURCE --operation-id ID` stops that original
  target set in preparation, while running, or at a human checkpoint. It keeps completed
  steps, original Run/cursor/operation IDs and uncertain effects; it does not undo page work.
  Read an eligible target's `continuationRevision` with parallel-inspect before an explicit
  `parallel-continue --browser SOURCE --operation-id ID --target TARGET --input FILE|-`.
  Input is `{continuationId,expectedRevision,parameters,calls?}`. Retain this new ID before
  dispatch and supply fresh values for unfinished work; the original version and Run stay fixed.
  Public control cannot approve a human checkpoint; that requires the person's trusted Client action.
  Inspect with the original operation and `--continuation-id ID` after an unknown reply.
  A confirmed admission is not completed work; a null observation is not a refusal or permission
  to replay. Only an explicit refusal before admission lets a corrected new intent be submitted.
  `browser task source --browser ID` reads exact recording metadata without its body.
  `browser task draft --browser ID --asset ID` reads a current definition without cumulative history.
  Create with one retained Core-minted intent via `browser task create --browser ID --input FILE|-`;
  `browser task create-inspect --browser ID --input FILE|-` checks that same original binding without writing.
  Unknown replies never authorize a replacement identity or automatic replay.
  For portable definitions use `browser task export --browser ID --asset ID --expected-revision N [--version N]`.
  Retain its `bundle` and Core `browserTaskImportInput(targetBrowserId, bundle)` before
  `browser task import --browser ID --input FILE|-`; `browser task import-inspect` reads the original durable receipt.
  Imports mint a new local asset and step identities and require review. Packages contain
  the complete definition and parameter declarations, never runtime values, sign-ins,
  recording bodies, Runs or human approvals. Source metadata describes package origin only.
  Saved `extract` steps declare `extraction:{within?,fields:[{key,type,source:{selector,read,attribute?}}]}`.
  A field has type string, number or boolean; reads use text, value, checked or attribute.
  A saved schema cannot retain an ephemeral withinRef. Declare outcomes with
  `{kind:"field-equals",stepId,key,expected}` in the original completion criteria.
  False, zero and the empty string are real typed values. Each producer records its check
  while its own document is current. `task inspect` returns `completions` joined to the
  original version, run and step operations, including recorded checks from earlier pages.
  These are historical extraction outcomes, never a claim about today's website state.
  Use its exact operation id with `browser inspect --operation-id ID --step N
  [--offset N --max-bytes N]` to read the original JSON artifact in base64 chunks.
  This read does not run a program, acquire input or re-extract; missing/evicted data leaves
  the original operation and Browser available. Restart reads recorded facts without replay.
  Explicit saved extraction retains only its selected data; private invocation values are
  not saved in definitions, progress, ordinary receipts, automatic observations or logs.
- amux browser open --help: open a new page only when needed.
  A Profile is a reusable website sign-in environment; network and device settings
  are optional additions. With no explicit Profile, ordinary pages use the original
  persistent default environment and retain sign-ins. This is the same default
  environment available in Survey; it is not private mode or a separate Survey partition.
  Default task pages do not automatically enter Survey. Pages explicitly created in
  Survey remain there through that original creation intent, even without a custom Profile.
  With --profile ID, consume that exact Profile identity confirmed by Main. After exact
  page attachment, the connected client registers only this Browser/Region in Survey,
  preserving its original task position and siblings. Read region.profileId for the
  confirmed identity; region.profile has the label only when observed, and profileIssue
  explains an unconfirmed label. A label lookup failure cannot revoke an already created page.
  The separate survey result reports not-requested, registered, partial or unknown,
  with the exact reference, save facts and issues. Registration and disk durability
  do not stand in for page creation. After a partial/unknown result inspect the original
  Browser/Region and space survey-list; retry only its reference write, never open a
  replacement page to repair a Survey preference.
  For durable generated content, prefer amux capsule open. The optional --capsule ID
  keeps the exact Capsule container and document policy; it cannot use private mode.
For a new page in the same task, usually choose an explicit readable Region in the Agent's
Tab. Read amux space --skill before placement for actual geometry, Focus discoverability,
the user's new-Tab/tool choice and crowded-layout exceptions, and separate navigation/input
focus. A link that the system hands to a desktop application may wait for the person's
handoff choice while the original page stays unchanged.

Profile native environment uses `browser profile update --profile ID --expected-revision TOKEN --environment JSON`.
The bundle accepts userAgent, acceptLanguages, timeZone, locale, geolocation, userAgentMetadata, screen
and hardwareConcurrency; null clears it. Read the original Profile for each Browser/field native application
and explicit scope. Saving does not reload the page or grant geolocation permission. DevTools owns its native
connection while open; actual detach is unknown and closing DevTools reapplies without replaying page actions.
Subdocuments, Workers and initial scripts remain unknown; Canvas/WebGL/fonts/TLS and complete fingerprint
emulation are unsupported. Screen edits compose with the original execution Viewport.

Proxy library: `browser profile proxy ls` reads stable non-secret assets and exact proxy revision tokens.
Use `proxy create --operation-id ID --edit JSON`, `proxy update --proxy ID --expected-revision TOKEN --edit JSON`, or
`proxy delete --proxy ID --expected-revision TOKEN`. Edit is {label,server,bypass?:string[],notes?:string};
keep sign-in out of server lines. Each Profile retains its original encrypted credential owner, scoped to
its saved proxy endpoint. Changing the route does not grant a replacement server the old password.
Editing an asset keeps existing Profile routes. Explicit `proxy assign --proxy ID --expected-revision TOKEN
--items JSON` uses frozen [{profileId,expectedRevision}] from exact Profile reads, applies each original
session and saves its versioned binding. It returns ordered partial results; one conflict does not cancel
other items. Manual network edits clear a binding. An asset referenced by active or archived Profiles is
kept. Native networkApplication.scope=session-proxy-config reports native configuration ACK, pending or
unknown; it does not certify authentication, an exit, UDP/QUIC or WebRTC. After a lost reply inspect the
original identities; do not blindly replay a write. An unconfirmed write readback is an observation of
original bytes, not a durability receipt. The original page, input and healthy controls remain available.
