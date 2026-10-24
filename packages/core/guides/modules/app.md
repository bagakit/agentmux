---
summary: "Global resource discovery, search and application navigation"
roles: "All Agents"
when: "Locate resources or navigate an existing application surface"
---

# app

<!-- amux:content -->
The client owns presentation and resource discovery; Core owns stable spatial and
execution identities. Begin with app snapshot for actual Projects, Workspaces, Spaces and
their Host/path facts, then app inspect for the current presentation. A resource Workspace,
display Workspace and process cwd are not interchangeable. Discover globally rather than
assuming the current Tab contains every resource or Agent.

app window ls observes the original client windows and their opaque document generations.
app window open moves one exact discovered Tab/Region occurrence; it does not clone content,
change the Core graph, start a Run or change execution cwd. Use --background when opening
only a presentation, preserving native input focus; without it, open requests window focus.
app window focus/return require
the exact window and document generation. Returning closes only its shell after the original
workface has returned. Retain the original operation ID: query it with app window ls after
an unknown result, without automatically opening another window. A recorded acknowledgement
and current native presentation are separate facts; absent client support is unavailable,
not an empty window catalog or loss of healthy Agents.

Use app search with the appropriate metadata/content mode, retaining each result's source
identity and availability. Inspect an exact returned object through its module before an
operation. app focus selects a surface; it does not accept a task or certify input eligibility.
Use app focus --surface focus --view map to open the same collaboration map, or --view
list for execution contexts. Omitting --view preserves the existing Focus view; other
surfaces cannot use --view. Space always presents the original workbench.
Use app focus --surface focus --host HOST --session SID for one exact Agent in the list.
Both identities are required; this cannot use map view or transfer input. Original filters
remain, with one explained temporary reveal. Inspect focus.agent for actual card visibility,
not merely surface selection or an accepted navigation.
app inspect reports selection.focusView separately from actual presentation and input.
Retained Tab/Region selection does not certify that content is visible behind the map.
Selection, focus and native input receipts are separate. Preserve current drafts and caret
unless navigation/input change was explicitly requested. Partial or unavailable discovery
does not mean objects are absent; retain the original view and inspect its exact owner.
For Agent/File/Browser opening or layout changes, read their module and the space module first.

app mobile assets inspect --input FILE|- observes the exact original Host's active release,
retained namespaces and bounded page reports. Use operationId to inspect one original activation,
or client:{devicePrincipalId,documentId} from an actual loaded receipt for that exact page.
No matching retained observation means not-retained, not that a page or device does not exist.
app mobile assets activate --input FILE|- requires the current managed Agent's original Host,
Session, Run and execution Workspace. candidatePath is a literal relative directory inside that
Workspace; candidateDigest binds its complete mobile-release.json and actual immutable files.
Supply the inspected expectedActiveRevision and retain the original operationId after any unknown
reply. Inspect that operation; never replay it automatically. A changed active HTTP snapshot does
not reload a phone or prove it loaded the release. Only the compiled page's authenticated loaded
report supplies that fact. The page keeps both its compiled buildId and original content
namespaceDigest. The root HTTP
document redirects into that content-addressed namespace; reusing a build label cannot revive
an older content namespace or prove that an older page loaded the current release.
Active and previous namespaces are retained in this Host instance only; older namespaces
explicitly become not-retained. Publication does not claim disk persistence,
native App updates, Host restart or safe reload of drafts and selected images.
