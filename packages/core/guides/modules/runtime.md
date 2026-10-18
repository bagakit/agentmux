---
summary: "Exact semantic Runtime observations"
roles: "Users and transport-approved devices"
when: "Read one original Runtime owner process without starting Native or recovering Sessions"
---

# runtime

<!-- amux:content -->
Keep the same endpoint and original runtimeId/ownerInstanceId from its owner observation.
runtime network inspect requires both identities; a changed owner refuses only that read.
It returns the semantic owner process network namespace, one entry per interface address,
with producer observedAt. These addresses are not connected peers, a hop trace or public egress.
The read neither connects Native nor enumerates, starts or recovers Agent Sessions.
An unavailable observation does not prove that an Agent or Run ended.
