---
summary: "Explicit authenticated Core routes and original receiver delegation"
roles: "Transport-approved people and devices configuring or consuming exact routes"
when: "Adopt a configured multi-hop route without importing Hosts or changing an existing execution"
---

# route

<!-- amux:content -->
A route is one explicit chain of configured Core edges. Each edge ID belongs to the
preceding Core's namespace; each target retains its semantic Runtime and signing key.
It is not a mesh, a global user account, a Node alias or an SSH ProxyJump trace.

<!-- amux:generated command:route.identity -->
<!-- amux:generated command:route.inspect -->
<!-- amux:generated command:route.edges -->
<!-- amux:generated command:route.edge.inspect -->
<!-- amux:generated command:route.configure -->

`route edges` reads only this owner's saved outgoing edge IDs, labels, kind and
already known Runtime pins. It does not connect to every Host or expose endpoints,
credentials or private configuration. Its `identity` is this owner; its typed `actor`
is the actual source-qualified user/device, including a verified incoming actor.
It is a fact for an explicit receiver-grant request, not permission or a global user
identity. `route edge inspect --edge EDGE` explicitly observes that one saved peer's
signing identity and time. A saved Runtime-pin mismatch rejects only this inspection;
it never replaces a pin, route or healthy Agent.

To read a later owner's edges, explicitly use `route.call` through an already saved
and authorized prefix, with `call:{method:'route.edges',params:{}}` or
`call:{method:'route.edge.inspect',params:{edgeId:'EXACT_EDGE'}}`. Every receiving Core
must independently grant the original actor that exact finite read. A missing grant
keeps the draft and original work; ask that receiver's actual owner to configure it.
Discovery never saves a prefix, imports remote Hosts, recursively walks the network
or authorizes execution. `route.inspect` and `route.configure` remain restricted to
their actual original user/device and cannot be carried as delegated policy access.

Read the actual participating owners before approving a chain. The source saves a
route definition; every receiving Core separately approves its immediate delegator,
original source-qualified user/device, final destination and exact finite methods.
A saved Host connection grants no transit. Equal operating-system UIDs on different
Runtimes do not make their users the same original actor. A managed Agent cannot
promote its capability by wrapping it in a user transport.

Configuration is a CAS save with expectedRevision and the original operationId.
Preserve both edits on conflict. Inspect reads the current saved revision and original
operation; only the save's own diskDurability acknowledgement confirms that write.
An unknown save is not permission to repeat it or substitute another route.

<!-- amux:generated command:route.call -->
<!-- amux:generated command:route.watch -->

Use the exact adoptedRoute returned from that original configuration. requestId is a
transport correlation, not a business operation ID. Keep the original CID, SID, binding
and input IDs in the original method's parameters. In particular, routed agent.open
requires its original explicit operationId. The ordinary agent open CLI accepts
--agent-host HOST --agent-runtime RUNTIME --agent-route FILE|- for the same frozen
Agent target; that file contains the exact adopted source/hops, not credentials. An unknown reply never authorizes another
creation, Start or input. Inspect that same original owner and explicitly continue
through its existing operation contract.

The gateway accepts only its finite public methods and finite runtime.invoke inner
methods. It does not carry administrative access, credentials, arbitrary endpoints or
human approvals. SDK clients may use routedAgentMuxRpc over the same existing public
call/subscription port. Receiving dispatch uses the original business owner; it does
not create another Runtime, permission service or execution journal.

When A enters B to create an Agent on D through C, B remains the project/admission
owner and D remains the Agent/Native owner. B signs each exact child as B, preserving
A's verified original parent and source-qualified actor. The original binding journal
retains that bounded authorization, both endpoint identities and adopted execution
chains. New qualified intents are explicitly tagged in that same journal, so an
older Core cannot mistake them for direct execution. Ordinary intents and existing
rows are not rewritten. Upgrade to an owner that understands the retained kind;
do not unwrap it or reconstruct another request. A transport nonce, reconnect, changed configuration or new observer cannot
replace it. Before admission, only the original target/CID's necessary preparation
metadata is read; this does not grant an entire Host inventory or history.

A later Space viewer reads through that viewer's own current authorization and exact
Space members. It does not borrow the creator's retained input authorization. The
SDK's route-created Hosted consumer is disposed by its original reader owner;
borrowed Host clients and other consumers are preserved.

Receipts identify the observed chain, original actor, request and adopted logical hop
count, with producer time and completeness. These access-route observations are
separate from a binding's frozen execution routes. A changed key, missing receiver
grant or unavailable reader reports that exact operation as unavailable without
choosing a direct path, replacing a Session, replaying input or stopping healthy Runs.
Cancelling a watch or revoking a route releases only the related observation lease.

Forwarding preserves order and never automatically retries a dispatched action.
Raw terminal write/paste has no caller-owned business operation ID: an unknown
ACK remains unknown and must not be replayed. A route requestId cannot deduplicate
that input or prove that its bytes were adopted. Composer prompts retain their
original submission ID and use the execution owner's existing input inspection;
the signed parameter digest prevents changing that request, not repeating an
identical envelope. The route adds no replay journal or exactly-once raw input claim.

An explicit `space.member.call` or `space.member.watch` uses the current viewer's
exact Space/Region, original execution Runtime, SID and expected Run. The original
Space owner verifies its actual membership and admission before signing that one
inner call or stream; an input digest cannot be replaced under the same parent.
The receiving owner still requires its independent finite method grant. Reader
namespaces retain the original actor and bounded member identity across actions;
another member, Run or narrower observation cannot release that reader. This is
not the creator's retained input authorization. Native permission approvals stay
at the original execution device's trusted human entry; intermediate transport
users do not become human approvers. Keep the pending request and ordinary
Terminal/prompt capabilities while that human response path is unavailable.
