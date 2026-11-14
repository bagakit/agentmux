---
summary: Configure and inspect this Core’s authenticated Mesh network and select an original publisher’s ingress.
roles: Original user operators configure their Core; authenticated device readers retain their own endpoint permissions.
when: A machine connects outbound, a gateway propagates topology, or a complete original offer needs a confirmed network entry.
---
<!-- amux:content -->
A Mesh connects network peers and carries encrypted endpoint bytes. Its peer key and
physical path are separate from a Core Runtime, Node publication, device permission
and the signed `adoptedRoute` business delegation chain. A network hop does not
become a business signer, local user or managed Agent.

[inspect settings](../protocol.md "amux:generated command:settings.mesh.inspect")
[configure settings](../protocol.md "amux:generated command:settings.mesh.configure")
[inspect network](../protocol.md "amux:generated command:mesh.inspect")
[select ingress](../protocol.md "amux:generated command:mesh.link")
[share a peer code](../protocol.md "amux:generated command:mesh.code")
[read a peer code](../protocol.md "amux:generated command:mesh.code.read")

Settings belong to this original Core’s state directory. Read its full current
configuration and revision, then save `{expectedRevision,operationId,configuration}`
through the original local user operator transport. An already verified local
managed caller keeps that scope; a device, guest or delegated transport does not
gain owner management. Network membership grants none of those permissions.
The reply’s `diskDurability` describes only that original save. Keep its operation ID
after an unknown reply and use `settings mesh inspect --operation-id ID`; inspection
may confirm the same already saved bytes, without replaying an old configuration.

To manage one saved remote Core, keep the CLI connected to your original entry
Core and add `--host HOST --expected-runtime RUNTIME` when reading or managing Mesh on that Host.
JSON-RPC accepts the same optional `target:{hostId,expectedRuntimeId}`; CLI JSON
can contain it instead of those two flags, never both. The entry authenticates
its real local caller and freezes that saved operator route. The receiving Core
independently authorizes the operator carrier and its exact Runtime/instance;
your Agent capability is never presented as a Session on that other Core.
Device, guest or delegated access cannot borrow this management route.
An obtained original save ACK stays with its owner/revision/operation even if the
observing route later changes; lost transport results remain unknown. Inspect the
same original operation without replay. Leading `--source-host` instead selects
another endpoint and retains your caller; it is not this operator route.

Read `mesh inspect` for `desiredRevision`, `activeRevision` and `apply`. Settings
are adopted live. A failed new listener keeps the prior active listener and network
paths. Other Core services and original Sessions remain usable. The existing explicit
gateway file remains its original source until an explicit managed configuration
adopts a saved revision; reading settings does not import or rewrite that file.

`role` is `disabled`, outbound `participant`, or accepting `gateway`. Configuration
uses explicit network/member public-key pins and peer dial endpoints. Its authored
`advertisedIngress` is client-facing and is separate from bind and peer addresses.
No public ingress is guessed from `0.0.0.0`, an OS interface or a connected peer.
A minimal outbound participant can be constructed without reading source:

1. Run `amux settings mesh inspect`; keep its `owner`, `revision`, `identity` and
   the complete default `configuration`. If identity is unavailable, restore its
   original files first; do not invent another peer key.
2. Copy the configuration and set `role` to `participant`, `networkId` to your
   explicit shared domain, and `members` to
   `[{"peerId":"COPY_IDENTITY_PEER_ID","publicKey":"COPY_IDENTITY_PUBLIC_KEY"}]`.
   Keep `peers:[]`, `publishers:[]`, `advertisedIngress:[]` and
   `endpointAccess:{"allowedClientKeys":[]}` for the minimal local participant.
3. Save `{expectedRevision: ORIGINAL_REVISION, operationId: ORIGINAL_SAVE_ID,
   configuration: COMPLETE_CONFIGURATION}` in a file and run
   `amux settings mesh configure --input FILE`. Inspect live adoption separately.

For Desktop pairing, open Mesh and choose **Join this device to a network**.
Paste the gateway’s saved connection code to see its network, public peer identity
and advertised dial addresses. Add it and save. Copy this device’s saved code back
to the gateway operator, who adds that peer and saves on the gateway. A gateway
can dial its own upstream while keeping its dedicated listener and published addresses.
The CLI reads the same public code with `amux mesh code`; `amux mesh code read CODE`
previews it offline. Reading and sharing a code leaves both configurations untouched.

For an actual paired neighbor, explicitly include its pinned `{peerId,publicKey}`
in `members` and add `{peerId, endpoints:[{endpoint:"gateway.example",useTls:true}]}`
to `peers`. A peer accepting only your outbound connection may list you with
`endpoints:[]`; both still explicitly admit the other's public identity.
To accept ingress, choose `role:"gateway"`, `listen:{host:"127.0.0.1",port:8443}`
and the independently authored client `advertisedIngress:[{endpoint:"gateway.example",useTls:true}]`.
The externally terminated TLS ingress need not equal the private bind endpoint.
An explicit external publisher admission is `{serverId,tokenHash}` in `publishers`;
the token hash uses the Relay package's `hashPublisherToken` and never the token itself.
Automatic Core endpoint publication needs no such manual entry. `endpointAccess.allowedClientKeys`
contains independent RPC client's canonical public keys, never network member keys.

A first explicit managed save takes over the complete existing startup configuration
and publisher admission set. A static source's default saved Mesh role does not mean
its actual listener is absent. Inspect `source` and the active listener before saving;
the original explicit configuration file is retained, not silently merged or rewritten.

TLS configuration names original absolute `keyPath` and `certPath` files; private
network keys never appear in public results. The original network identity and
monotonic boot epoch survive Core restart. Corrupt keys are retained as unavailable.

A durable headless Core or Host participant automatically publishes its original
endpoint through the same network owner. Configure `endpointAccess.allowedClientKeys` explicitly; member keys
are network keys, not device client keys. The endpoint checks that exact client pin
before its original DeviceAuthority authorization. Removing a pin releases only its
related device readers, preserving the original Agent and Run. This needs no separate explicit
outbound configuration file. `mesh.inspect.endpoint` reports the real original
complete offer or its unavailable/not-provided state. Its private loopback ingress
is an original endpoint descriptor for `mesh.link`, not an externally reachable URL.
The original device authority and daemon key stay beside the original File Store,
using the same identity and revocation records in headless and Host deployments.
An unavailable or still initializing endpoint does not block network forwarding,
Unix Core access or healthy Native Runs. Restore its original files, then make an
explicit Mesh settings save to retry that endpoint; never replace its identity.
An explicit endpoint source remains authoritative. A memory Store or standalone
control server without an endpoint source truthfully reports `not-provided`.

Network inspection is passive. Its producer identifies the original Core and the
independent network peer. Coverage counts only configured origin advertisements;
it is not remote Native, Agent health, business completion or complete fleet discovery.
Authenticated advertisements and candidate paths can become stale. Circuit opening
independently checks its actual next neighbor and original terminal publisher.

For `mesh link`, supply `{offer: ORIGINAL_CONNECTION_OFFER}` to the chosen gateway.
To choose one of its published addresses, add `ingress:{endpoint,useTls}`.
Omitting that field selects its first advertised ingress. An address outside the
gateway's active configuration is refused. The returned complete offer/url keeps the original `serverId` and `daemonPublicKeyB64` and selects this
Core’s confirmed route through its explicit advertised ingress. Use that returned
URL unchanged. On the accessing Mac choose **Mesh → Use another device**,
open that URL and copy the access key from its device workspace. On the original
target Core, add that key to endpoint access and save. Reconnect from the same
device workspace. Directly authorized device SDK clients and `amux --endpoint URL ...`
consume the same offer. The original endpoint still verifies its E2EE key and device permission;
the network gateway never invokes business RPC as a substitute caller.

Unknown paths or missing ingress refuse only this read and retain the original offer.
An interrupted request keeps its original operation/input identity. Network reconnect,
new path choice or a new observer never replays payload. Existing circuits keep their
adopted network path while healthy; topology improvements affect future circuits.
The separately adopted signed business route, logical hop count and receiver grants
remain unchanged.
