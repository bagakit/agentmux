# diagnostic

<!-- amux:content -->
Read system diagnostics inspect --list for actual injected readers.
reading.lifecycle uses --recent with optional --session-id/--run-id/--since/--until filters
to discover original references; --logid reads one exact record. Keep the original cursor/query and namespace.
Core source metadata is bounded current-instance memory, not durable history or proof that no issue occurred.
Client presentation metadata belongs to client.incident and its actual archive coverage. A received invalidation is not a source write time.
No query starts a Reader, Runtime recovery, sampling, refresh or input.
For client.incident, use --domain client.incident --host-id HOST --recent to discover retained
incident references without a Session ID. Follow an original reference with --logid ID; its optional
authority constrains the exact archive namespace. Recent cursors retain the same Host and filters.
Incident reads expose finite metadata and explicit coverage only; include-raw adds no terminal text.
For mote.context.client, use --input FILE|- containing the complete typed query.
Freeze scope.hostId/directoryPath from the resource Workspace row in app snapshot --include workspaces,
topicId from Mote discovery, and Tab/reference from app inspect or space ls. A Mote's physical
HomeZone or logical topic directory is not its captured resource Workspace path.
The outer hostId selects the client reader route; scope.hostId can be a different resource Host.
prepare reads one exact resource/Topic/Tab action; open-space additionally requires the complete
captured display reference (or actual null). Do not substitute another occurrence.
These are latest-per-scope-action observations, with original action/failure times, not historical
logs or Agent health. Default raw stays withheld before IPC; explicitly requested original text
requires original source authorization and fits the query budget. No retry, focus or Run starts.
