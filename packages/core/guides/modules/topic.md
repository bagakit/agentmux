---
summary: "Topic categories, real knowledge sources and scoped migration"
roles: "Agents organizing or reading Topic materials"
when: "Discover or edit an original Topic/knowledge resource"
---

# topic

<!-- amux:content -->
The Topic owner holds categories, Topic identity and resource associations; knowledge
stays in real filesystem sources. Begin with topic category ls, topic ls/inspect and exact
knowledge ls/search/read. Preserve returned Host, resource path, Topic and document identity.
For ordinary Topic appearance, `topic ls/inspect` retain the original optional `workspaceId`
and `contentIdentity` alongside `contentKind`; these come from the original workspace and
spatial owner. Use them for the exact `space object avatar` target. Missing identity stays
unknown: neither `zoneId` decoding nor `directoryPath` hashing establishes it.
A Mote display location is not its knowledge directory. Missing/unavailable sources stay
explicit; do not replace a user's SOUL/Wiki or invent a parallel registry.

## Read an original search observation

`topic knowledge search` returns `observation.record.searchId` together with the original
query, scope, outcome and measured costs. Use `topic knowledge history --search ID` to read
that retained observation without repeating the search or reading document bodies. Optional
`--topic ID`, `--query TEXT` and `--limit N` filter the original records; query text matches
exactly. Read the leaf help for the current accepted fields and limits.

History reports `hasMore`, retention and unavailable independently. An absent record can
mean it was not saved or has been pruned; it never proves that the search did not run.
History failures preserve original search results, files and workfaces. Inspect or repair
the original history owner before another explicit query; do not automatically rerun a
search to fabricate its missing original observation.

## Use the existing structure

- topic.md: short current purpose, confirmed context, key decisions, open questions and links to
  useful knowledge. Keep this entry current instead of growing it into a full work log.
- refs/: original source material and evidence, with enough provenance to find the originals.
- outcome/: reusable findings and deliverables, linked from the short Topic context when useful.
- .agents/: concise collaborator identity and handoff context, not report archives or live status.
- Wiki: selected startup instructions and context. Saving ordinary knowledge does not turn it into
  a Wiki rule or automatically inject it into every discussion.

Keep existing files and organization; these roles do not require a new taxonomy or moving old
material. When a Project or Task already owns code, bulk data or execution logs, link its relevant
evidence instead of copying it into Topic summaries or collaborator plaques. Existing structured
knowledge entries remain on topic knowledge ls/search/read/write; documents stay with Files.
For a Mote's identity and short MEMORY.md index, use amux mote --skill and its exact original home.

## Maintain useful knowledge

Read relevant saved context and results before repeating work or asking for decisions already made.
At a confirmed decision, important correction, reusable result or open commitment, assess what a
future collaborator needs. Before reporting a meaningful step complete, update the relevant original
knowledge and the short topic.md context or links when needed. No extra note is needed when nothing
useful changed; do not copy every turn or make maintenance a setup questionnaire.

Keep source, date, scope and evidence links, and distinguish facts, confirmed choices, inferences,
proposals, open commitments and completed work. Correct the relevant existing note or entry rather
than accumulating conflicting dated reports; mark superseded conclusions clearly and refresh links
so the old conclusion is not still presented as current. Preserve original evidence and unrelated
user material. Knowledge is context, not current authorization or live Project/Goal/Session/Run state.

Use amux file --skill for original documents and the current topic knowledge command help for
structured entries. Read the latest exact resource, save with its revision/CAS and read back before
claiming the knowledge is maintained. Report a needed update that was not saved or confirmed;
inspect the same original after an unknown result instead of blindly writing again. Keep credentials
out of ordinary knowledge. Do not start another Agent, schedule or extra model round for maintenance.
Saved files, delivery to a new Session and actual model use remain separate facts; existing Sessions
retain their earlier context and are not hot-updated or restarted by a file edit.

Create/move/write only within the authorized exact resource. Inspect current revision and
the current help before a change; retain operation and source references through the result.
Migration preview is a read; migration apply is a separate scoped write using its original
preview and expected facts. A preview or navigation never certifies a completed migration.
After an unknown write, read the same original Topic/knowledge/migration owner before an
explicit retry. Preserve original files and working surfaces until actual saved results
are confirmed, and report gaps rather than guessing that absent observations mean deletion.

## Promote an original Topic into a Mote Club

Use `amux topic inspect --topic ID` to retain its exact content and Zone. After the
user authorizes promotion, call `amux topic promote apply --topic ID --operation-id OPERATION`.
Promotion retains the original Agents, conversations, files, category entry and knowledge.
It adds a persistent Mote Club identity; it does not send messages or start Agents.

Read `amux topic promote inspect --topic ID` to discover its original operation.
After a partial or unknown result, inspect with the original `--operation-id`;
explicitly apply that same operation to continue. Do not generate another operation
or create a replacement Mote. A complete receipt confirms personality, directory
and spatial registration together. Knowledge commands keep using the original Topic ID.

New Topic promotions also honor the original `promotion.enabled` setting. Disabled
admission refuses only the new promotion; existing Agents, Motes and original
partial-operation inspection/explicit continuation remain available. Promotion
configuration is in Settings → Promotion. For starting from an ordinary Agent,
read `agent open --help` and use the shared Takeover workflow at an explicitly chosen
Club. Prefer an existing Club; creating a new Club is a separate first step before
choosing its new Agent. The original Agent and project/Topic remain. `agent promote`
only reads or explicitly continues previously accepted records and creates no new
Agent promotion.
