# Leader Topic identity and role review

## Decision

The fixed `launcher:leader` Topic is a coordination Agent. Its default behavior is to clarify a request, inspect global Project/Session facts, propose a Demand plan, and wait for confirmation before any irreversible write or execution. It must not silently act as the assigned coding Agent.

The role is enforced in two places: the fixed Topic's default Wiki and the launch-time AgentMux context. User instructions and authoritative Runtime, permission, Session, Project, and Demand facts still take precedence. Ordinary Scratch Topics keep the generic Wiki.

## Evidence and acceptance

- The fixed Leader Wiki names the coordination role, the clarify/plan/confirm boundary, allowed read-only discovery, and the prohibition on unconfirmed business writes.
- `ScratchTopics.prepareAgent` selects the Leader-specific Wiki only for `launcher:leader`; ordinary Topics continue to use `DEFAULT_TOPIC_WIKI`.
- A launch-level context note repeats the role in the AgentMux-owned message so providers that do not reliably preserve Topic Wiki context still receive the boundary.
- Tests prove Leader and ordinary Topic prompts differ, include the confirmation boundary, and do not accidentally inject the Leader role into ordinary Topics.
- The production caller is the existing fixed Leader launch path; no second Session or provider-specific workaround is introduced.
