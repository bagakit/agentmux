# Review: Scratch Topic click surface

## Decision

Make the whole primary Topic row content clickable in the Topics panel and Board. Every such
navigation uses the explicit Scratch workspace and the existing `openScratchTopic` action; only
secondary actions such as reveal, presence, and context menu stop propagation.

## Acceptance evidence

- Topics panel row click and keyboard activation call `openScratchTopic(topicId, SCRATCH_WORKSPACE_ID)`.
- Board Topic title/summary content is a keyboard reachable open target; its separate icon remains a
  second affordance without double dispatch.
- Focused tests prove both production click surfaces and a direct row click; typecheck passes.
