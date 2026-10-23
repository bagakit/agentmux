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

When attached, view.region gives your exact Region and Tab, bounds and typed directional
neighbors; whoami does not supply a Zone or all display bindings. Read amux space --skill,
then amux space inspect --region REGION with that returned Region ID to read its original
Zone and display Workspace/Group occurrences. When the task needs the whole Tab or nearby
content, use amux space inspect --tab TAB with the returned Tab ID. A neighbor may name a
Region, an adjacent Tab, or none; inspect its typed identity before using it. Execution cwd,
titles and the person's current focus do not establish your display position or permissions.

A missing attached Region means relative self addressing is unavailable; it does not mean
the Session or Run ended. Use exact Session identity and global agent/app/space discovery
instead of choosing another Agent's Region or the first location candidate. Partial/unknown
facts remain explicit; retain healthy input and original durable surfaces. To operate a capability, read its module and
current help first. This module read itself performs no whoami RPC, connection or lifecycle
action, and reading guidance does not prove a live model adopted it.
