# Agent status, queue and Message Tools review

## Product decisions

- Agents menu should answer “which Agent, from which Provider, doing what now, and what can I do next?” in a compact two-line row.
- `running` means open/available; `working` means open and actively producing output. The visual distinction is semantic, not only color.
- User Agent name, Provider name and configuration name are different fields and must remain different in copy.
- Queue items are user-owned pending work: expand, delete, send now; after an automatic send failure, stop retrying and preserve the item with a visible reason.
- Message Tools has independent iconography and three-state expansion. Skill/component/subcommand references become interactive semantic tokens instead of raw links.

## Technical boundary

- Core/Runtime remains the owner of delivery facts; the renderer owns draft/queue controls and presentation.
- Use existing Radix menu/popover and parser dependencies before adding a new command framework.
- Keep the smallest end-to-end path first: one queue item can be deleted/sent, one token can render/hover/open, one Agent row can distinguish running/working.

## Execution revision 2 — approved continuation

The Core freshness blocker from the first gate is resolved. Queue delivery now has an explicit terminal
`failed` state: automatic runtime events never retry it; only the user-facing Send now action can retry
the same operation id. The verification surface includes the existing queue correlation tests plus the
Composer and semantic-token tests. This revision keeps the same closure and does not introduce a second
delivery owner or command framework.
