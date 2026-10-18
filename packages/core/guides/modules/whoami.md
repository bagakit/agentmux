---
summary: "Authenticated caller, exact Session/Run and current capabilities"
roles: "Every Agent at entry"
when: "Establish current identity and available capabilities"
---

# whoami

<!-- amux:content -->
whoami is an authenticated read of this caller's original Core identity, current Run,
capabilities and available presentation context. Run it once on entry, then preserve its
exact Session, Run and Host references. Environment hints, text headers and display names
do not authenticate an author. Capabilities and permissions come from the current owner,
not this guide or an inferred role.

A missing attached Region means relative self addressing is unavailable; it does not mean
the Session or Run ended. Use exact Session identity and global agent/app/space discovery
instead of choosing another Agent's Region. Partial/unknown facts remain explicit; retain
healthy input and original durable surfaces. To operate a capability, read its module and
current help first. This module read itself performs no whoami RPC, connection or lifecycle
action, and reading guidance does not prove a live model adopted it.
