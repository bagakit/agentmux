---
summary: "Original Host connection links, encrypted device identity and revocation"
roles: "Agents reading their Host link; authorized local users managing devices; devices for their own hello"
when: "Read a local mobile or outbound gateway connection link, or administer an exact device"
---

# device

<!-- amux:content -->
Read `amux device link` once for the authenticated execution Host's complete public
connection URL, page URL, existing Relay endpoint and current connection state. A known
address remains readable while disconnected; it does not prove network reachability.
Reading never enrolls or revokes a device. Use the original returned URL including its
fragment; do not invent a public endpoint or rewrite the offer. Same-origin links carry
the full Mac public-key pin; the mobile page obtains the public connection description
from that original Host and verifies the pin and encrypted hello identity. This read
does not enroll a device or replace saved device keys.

For an original Host configured for outbound gateway access, use `amux device link
--via gateway`. This returns that Host's explicit RPC connection link and the
current outbound carrier state. Use the complete URL with `amux --endpoint URL`.
The link does not promise a hosted Mobile page, a saved Host/Launcher entry, or
permission to another resource. The default `device link` and `--via local`
continue to describe the original local mobile listener; `--address` selects only
one of its actual local addresses.

The accessing CLI can prepare/read its original encrypted client identity with
`agentmux-runtime relay-key`. It prints the public key only, using the same
default identity file as public RPC. Configure that public key in the original
Host's outbound admission file before access. Relay publisher admission and the
Host's device authorization remain separate; revoke an exact admitted device
through its original owner. Preserve unreadable original key files rather than
replacing their identity.

The local device owner holds pairing and revocation; encrypted handshake facts identify
one device, not a general user approval. Read device ls before administering an exact device.
Pairing changes connectivity and does not create an Agent or accept a Goal. Retain the complete
returned offer and exact deviceId. Current discovery cannot certify an earlier lost revocation.

Durable headless Core uses the same original device authority, daemon key and
revocation records as Host. It exposes `device ls`, encrypted `device hello` and
local-user `device revoke`; it does not host a mobile page, so `device link`
reports that page unavailable. Use `mesh inspect` for the original endpoint offer
and the chosen gateway's `mesh link` for its explicitly advertised client ingress.
Network member keys and the separately allowed RPC client keys grant different
permissions. Device admission never grants local-user administration.

Read amux device --help for the pairing, identity and revocation contract; use the exact
action's help before changing it.
