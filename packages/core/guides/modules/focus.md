---
summary: "Read current Focus groups and exact selected members"
roles: "Agents handling a Focus group task or inspecting its current projection"
when: "Read original Project or Collection membership without navigation or Run control"
---

# focus

<!-- amux:content -->
Focus reads the same original Project/Collection projection as the client. It does not
navigate, start or attach an Agent, scan conversation history, or create a snapshot Store.
Use focus ls to discover group scopes and identityStatus, then focus read --input FILE|-
with an explicit scope and selection. The CLI's endpoint selects the original client source;
scope.hostId is the group's resource Host, not a replacement endpoint or a Session alias.

A Project scope is {kind:"project",hostId,projectSpaceId}. A Collection scope is
{kind:"collection",hostId,categorySpaceIds:[...]}, the complete original category set.
An empty categorySpaceIds array denotes the unconfirmed Collection bucket; it does not
invent a Category identity. Copy original typed identities, never infer them from labels,
process cwd, current focus or a bare Session ID.

Read input is {scope,selection,limit?,cursor?}. selection is either {kind:"all"} explicitly,
or {kind:"members",references:[{hostId,contextId},...]}. A GUI task supplies the exact
filtered member references; do not broaden it to all or reapply a later state filter.
References identify presentation contexts, not canonical Agent Sessions. Unknown selected
members remain explicit. members:[] selects nothing and never means all.

One read accepts at most 256 exact references. A larger logical task must be partitioned
into complete exact batches, preserving every reference. limit is 1–100 (default 50).
Follow nextCursor independently for every batch with unchanged scope/selection and limit.
It binds the original source/document generation and membership. Changed source or
membership is reported as changed, not silently replaced by a fresh cohort. Content-only
changes may be read without discarding that membership boundary.

Read status, issues and coverage, not just items. complete:false or unavailable source
coverage is not a confirmed empty result. Excerpts are bounded observations (at most 600
characters), never full history. Changed/unconfirmed members do not grant Agent control.
For additional facts use the returned exact Agent/Run and original spatial owners. Reads
neither authorize task closure, input, takeover, rules/knowledge edits nor replay any action.

[List groups](../../src/agentmux-cli-commands.ts "amux:generated command:focus.ls")

[Read exact members](../../src/agentmux-cli-commands.ts "amux:generated command:focus.read")
