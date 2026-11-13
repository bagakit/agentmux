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

For an unspecified Browser request, start from your own exact Tab; inspect this task's
same-Tab neighbor Regions and their typed Browser bindings; do not pick a globally recent or focused page or assume
a new page is wanted. Preserve material ambiguity and the user's exact target/tool choice.

Read only the matching local help:
- amux browser profile --help: original Profile identities, routes and usage.
  Use browser profile copy to create a new identity from the source's saved settings,
  naming its exact ID and its opaque `profile.revision` token read from ls or inspect. Activity observations and edits to another Profile do not invalidate this token. It keeps the original
  Profile and pages; site data, sign-ins, proxy passwords, human approvals and prior
  runtime history do not move. Use the returned new Profile ID to inspect, edit or
  open it. A missing reply leaves creation unknown; do not automatically repeat it.
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
  A person or device can set a proxy sign-in with browser profile proxy-sign-in set
  --profile ID --input FILE|-; the JSON contains only username and password. Never put
  a password in command arguments. Managed Agents cannot set or clear sign-ins. The
  saved/cleared fact and reconnected result are separate; reconnected:false retains
  the confirmed credential write, so do not repeat that write to reconnect a page.
  browser profile network check --profile ID observes the configured HTTPS address
  through that Profile's session. Unknown leaves the Profile and its pages available.
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
- amux browser task --help: source/draft discovery, draft edit/publish, original create receipts,
  version reliability, run, batch and stop.
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
- amux browser open --help: open a new page only when needed.
  For durable generated content, prefer amux capsule open. The optional --capsule ID
  keeps the exact Capsule container and document policy; it cannot use private mode.
For a new page in the same task, usually choose an explicit readable Region in the Agent's
Tab. Read amux space --skill before placement for actual geometry, Focus discoverability,
the user's new-Tab/tool choice and crowded-layout exceptions, and separate navigation/input
focus. An app link may await a
person's system handoff while the original page stays unchanged.

Profile native environment uses `browser profile update --profile ID --expected-revision N --environment JSON`.
The bundle accepts userAgent, acceptLanguages, timeZone, locale, geolocation, userAgentMetadata, screen
and hardwareConcurrency; null clears it. Read the original Profile for each Browser/field native application
and explicit scope. Saving does not reload the page or grant geolocation permission. DevTools owns its native
connection while open; actual detach is unknown and closing DevTools reapplies without replaying page actions.
Subdocuments, Workers and initial scripts remain unknown; Canvas/WebGL/fonts/TLS and complete fingerprint
emulation are unsupported. Screen edits compose with the original execution Viewport.
