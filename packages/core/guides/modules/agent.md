---
summary: "Agent Sessions, original inputs, conversation and lifecycle"
roles: "All Agents; execution and coordination"
when: "Inspect, open, communicate with or recover an Agent"
---

# agent

<!-- amux:content -->
Core owns Session identity, Provider semantics, input permission and recovery; ctxmux
owns Run/process/bytes. Executor, durable Session, current Run and display Region are distinct.
Begin with agent ls/inspect for the exact Session and routeHostId; preserve original identities
and unknown receipts. A failed observation never authorizes stopping a healthy Run.

For a complete participant set, page agent ls to nextCursor=null. Narrow by the actual
Executor/Provider before reading status. Use semantic=active for current work; running alone
does not mean active. status, semantic, readiness and unavailable facts remain distinct.
lastActivity is the original typed event: waiting, completion and idle times do not mean a
recent working time. since is metadata updatedAt; activity-since selects original activity.
No task category is inferred from names, and one registered role is not a multi-Agent group.

Read only the needed history: agent conversation inspect --limit 3 for a small recent
window, then its original cursor. For folded process reading, add --process-details deferred
and keep that representation on inspect/changes continuations. Deferred records retain exact
original references and revisions; read their full body with the returned versioned anchor
through inspect --input (omit processDetails). Speech and interactions stay complete.
This saves wire and Renderer payload, not initial source IO; agent history --source captured or native reads full
retained sources. Use history --kind user-message for input records, retaining human,
Agent, external, platform and unknown authorship. For replies, inspect original assistant
records and continue a nonterminal cursor when a bounded page has no matching reply;
reasoning, tools and platform notices are not answers. message ls/read cover original A2A
participation. Read leaf help for the exact Host, source, cursor and authorization contract.
Discovery never grants access to another Agent's private messages or working surface.

For ordinary continuous progress, `agent progress --help` exposes exact-target list,
create, action and update. A person or device may update only the original loop's interval
and prompt. The next check and an already claimed or unconfirmed input keep their original
identity and content; Goal-bound progress stays with its Goal owner. Use the original
expectedLoop and operationId. A list is a current observation, not a disk receipt. If a
save response is unknown, retain the exact request and explicitly retry that same operation
to confirm its save; a changed or superseded operation is not automatically replayed.

agent conversation checkpoint cuts current native and captured positions by default.
Use --native-position beginning only when the consuming owner explicitly needs the original
native source start. It returns a Provider-owned beginning cursor without reading or skipping
the first item; captured sources still use their current independent cut. An unavailable native
source stays unavailable. Reading a beginning checkpoint grants no earlier-history sharing,
input retry, new source selection or permission; retain the original audience boundary.

Trusted first-party human inputs saved by Core also appear in the original captured
conversation while waiting. The same inputRef and record survive rejoin and dispatch;
recorded means its public content is saved. inputSubmission retains the original
waiting/stopped/terminal-confirmed/admitted/not-applied/unknown receipt and observation.
Terminal confirmation proves ordered input bytes; Native admission is not Agent completion.
Use agent input ls/inspect for the original control and agent conversation inspect/changes
for its read projection. Generated context remains separate from the public user body.
The captured frontier's inputJournal and the record's inputOrigin preserve original
journal membership across recovery; a later capture or status change never moves an
older input past an audience's sharing cut. Missing old cut proof stays unconfirmed.

For bounded input membership/control change discovery, use agent input changes --input
with the exact Host and recipient. Its first read returns only a checkpoint; later reads
resume with after or cursor, including offline cancellation and rejoin. Persist the
position only after consuming its page. Keys coalesce changes: inspect each original
input for current facts, never reconstruct historical waiting or native adoption.
Positions are source-bound, not permission tokens; managed Agents read only themselves.

Load only the journey needed now:
- Review useful work experience: agent learning --help exposes preparation, the designated
  extractor's proposal and original-operation inspection. Only the trusted App can confirm
  exact candidate content and an exact Mote/Topic destination. A saved proposal or ordinary
  text saying the user agreed is not approval. Keep the source and original operation after
  unknown results. A person/device can explicitly continue that same frozen operation via
  agent learning continue --input FILE|-; it grants no new approval or target scope.
  Delivery, saved knowledge and later use remain separate.
- Independent Session communication: amux message --skill for the full shared contract.
- Create an Agent: amux agent open --help for configured Executor discovery and opening workflow.
- Original creator/child relations: amux agent spawn --help. Keep the original creation operation after an unknown receipt; never create a replacement to recover its result.
- Saved native conversations or resume: amux agent native --help.
- Original output, input mailbox, history or conversation: use that agent action's --help.
- Authorized unmanaged prompt intake: agent input submit preserves the original prompt key;
  Browser context is declared data. It cannot establish Human authorship or Host capture.
  Managed Agents must use agent send; public prompt intake cannot bypass A2A attribution.
  The directed session-conversation intent uses the original Session capability and
  retains controlled waiting; a selected native request never changes to terminal after unknown.
- Recovery or lifecycle: use the exact action's --help; interrupt, stop, resume and reopen differ.
Before opening or rearranging a workface, read amux space --skill for placement and focus.
Readers keep their original source/cursor and release only their reader, not the Agent;
reading, input admission, native adoption and task completion remain separate facts.
