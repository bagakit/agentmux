---
summary: "Local device pairing, encrypted identity and revocation"
roles: "Authorized local user; connected devices for their own hello"
when: "Inspect or explicitly administer a paired device"
---

# device

<!-- amux:content -->
The local device owner holds pairing and revocation; encrypted handshake facts identify
one device, not a general user approval. Read device ls before administering an exact device.
Pairing changes connectivity and does not create an Agent or accept a Goal. Retain the complete
returned offer and exact deviceId. Current discovery cannot certify an earlier lost revocation.

Read amux device --help for the pairing, identity and revocation contract; use the exact
action's help before changing it.
