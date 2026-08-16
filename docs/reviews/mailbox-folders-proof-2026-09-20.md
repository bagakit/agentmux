# Message mailbox folders

Authority: user confirmed Inbox for messages from other Agents, Outbox for user messages, System for notices; prioritize unread each opening, otherwise Outbox when present; reading must not imply delivery. This implements f-27q8fjs45/T-004.

Core records optional host-supplied authorAgentSessionId in its existing durable prompt timeline only after successful submission. Attribution is display metadata, never a credential; control caller authorization remains at the existing boundary. Desktop control send preserves the caller through preload/IPC/Runtime/Core. No second delivery ledger is introduced.

Mailbox projects completed input facts into Agent Inbox or user sent history. Pending Outbox rows use the existing queue, reconcile by operation id, and never reappear next to their own durable sent receipt. System notices retain their source-owned cause and recovery text. The existing persisted read receipts now share one hook between notice and message consumers with separate scopes. Reading one folder does not mark another read; new arrivals do not change an open folder. Sender labels use existing Session names where available.

Validation: 119 tests pass across Core durable mailbox/timeline and desktop mailbox/control/runtime/global notice suites. Eight implementation mutations all fail: lost Core author, lost persisted author, lost Runtime forwarding, lost control caller, wrong Inbox classification, retained sent pending row, wrong opening priority, and omitted read writes. Core mutants rebuilt dist before the test; an initial run blocked by stale dist was not counted as killed.

Actual browser: real AgentSessionComposer, Store and CSS in a disposable page; Inbox opens before unread System, System read clears remaining dot, closing/reopening chooses nonempty Outbox. 420px viewport has no horizontal overflow; panel lies x17–395. Real Store initialize/hydration and page reload preserve both read scopes. Draft remains intact. Screenshots /tmp/mailbox-three-folders.png and /tmp/mailbox-three-folders-narrow.png were inspected. Temporary page removed.

Caller check: Core submitAgentPrompt writes the metadata; session-timeline normalizer preserves it; desktop control request supplies it; SessionMailbox consumes it through AgentSessionComposer timelines. useReadReceipts has production consumers in both SessionMailbox and useServiceNotices. Native installation/restart is the final joined release check, not claimed by the browser proof.
