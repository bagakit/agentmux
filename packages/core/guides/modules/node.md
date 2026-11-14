---
summary: "This Core's published identity, real resources and bounded shared directories"
roles: "Owner users managing publication; callers reading the same published boundary"
when: "Inspect a Node, read shared resources or explicitly edit this Core's publication"
---

# node

<!-- amux:content -->
A Node describes what one original semantic Core publishes. A Host ID is this client's
configured route; alias is a mutable locator, never authentication or a global registry.
Use node inspect --host ID to obtain the original Runtime, policy revision, published
root references and default landing. An expected Runtime pin follows that original Node
across alias rename. Alias collision or an unavailable route never selects another owner.

Owner management is settings node inspect/configure, through the original authenticated
person's transport. Managed Agents cannot grant themselves publication. Policy is
{alias,shareResources,allowedPaths,deniedPaths,defaultPath}. Alias may be empty; a declared
alias is one lowercase DNS label. Owner paths are literal absolute paths. The default path
is navigation, not an Agent working-directory change or an OS sandbox.

Configure carries expectedRevision and an explicit operationId. Keep that original ID
when a save is unknown; settings node inspect --input with {operationId} observes and
confirms the same saved bytes without replaying configuration. Inspect waits for accepted
saves on that unique Core owner. For an explicitly requested ID, operation:null means no
record was found after those saves settled and the current policy does not name it. It is
not a success receipt. A missing record named by current policy is unavailable, never
reported absent. A person may explicitly start a new save; the old request is not replayed.
Existing Agent, Run and
full-owner SSH capabilities are independent of Node publication and remain available.

Published node.resources applies the sharing policy to every caller. Withheld contains
no sample. settings node resources is a separate authenticated owner read. Measurements
identify Runtime, Core instance, process and producer time. OS CPU values and process CPU
are cumulative counters; interval rates require two compatible samples. OS free RAM is
not Linux available RAM. Core-process RSS is not all Agents or the whole App. Missing
sources remain unavailable; no synthetic network speed or fabricated history is supplied.

node files list/read take --input JSON and the exact returned root reference plus a
literal relative path. Denied descendants and links outside the published root are not
shared. Refresh publication after a stale root or policy. List offset/nextOffset and
revision continue one directory; read offset/nextOffset and revision continue one file.
Limits bound each page or block, never all legitimate cumulative content. File bytes are
base64, not executable HTML. Published payloads do not expose private absolute paths.

node resolve locates Node metadata only. It does not grant Agent input, Capsule interaction,
raw file/git/shell access or arbitrary runtime.invoke. Resolve original objects through
their own owner. A remote Capsule's loopback URL is not a local page on this client.


node locate --alias LABEL [--expected-runtime ID] observes only the current configured,
authenticated Host scope, including configured routes whose clients are not yet prepared.
An unavailable configured route stays an issue rather than disappearing from the scope.
It returns status, matches and issues. Each match preserves the
original publication and hostIds containing all confirmed carriers of that Runtime;
hostId selects confirmed canonical local when present, otherwise configuration order.
Multiple carriers of one Runtime are not multiple Nodes. This does not discover a mesh.

A bare alias is unique only when exactly one Runtime matches and every admitted Host was
observed. Unknown scope gives unconfirmed (CLI exits nonzero), while two known matching
Runtimes remain ambiguous. Missing means no match and no unknown scope. An original
Runtime pin selects that identity across alias rename and may be unique while retaining
unrelated scope issues. Unknown source never selects a first candidate. Locating metadata
does not grant Agent, Capsule or owner access and never creates or resumes a replacement.
