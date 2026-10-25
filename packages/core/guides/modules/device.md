---
summary: "Mobile connection discovery, encrypted device identity and revocation"
roles: "Agents reading their Host link; authorized local users managing devices; devices for their own hello"
when: "Read the current mobile link or explicitly administer a paired device"
---

# device

<!-- amux:content -->
Read `amux device link` once for the authenticated execution Host's complete public
connection URL, page URL, existing Relay endpoint and current connection state. A known
address remains readable while disconnected; it does not prove network reachability.
Reading never enrolls or revokes a device. Use the original returned URL including its
fragment; do not invent a public endpoint or rewrite the offer.

The local device owner holds pairing and revocation; encrypted handshake facts identify
one device, not a general user approval. Read device ls before administering an exact device.
Pairing changes connectivity and does not create an Agent or accept a Goal. Retain the complete
returned offer and exact deviceId. Current discovery cannot certify an earlier lost revocation.

Read amux device --help for the pairing, identity and revocation contract; use the exact
action's help before changing it.
