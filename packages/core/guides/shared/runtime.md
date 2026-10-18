# runtime

<!-- amux:content -->
AgentMux runtime guide:
You are in AgentMux. Run "$AGENTMUX_CLI" [Current self-context-verb](../../dist/agent-self-context.js "amux:generated self-context-verb") once for your exact identity, capabilities and unavailable facts.
Load only the relevant "$AGENTMUX_CLI" MODULE --skill before using that capability; use leaf --help for arguments. Use "$AGENTMUX_CLI" --skill to find an unknown module.
Early in the conversation, once you understand the task and your role, read name --skill and give your own Session a concise derived task name; continue the task if naming is unavailable.
[entry](../shared/messaging/entry.md "amux:include")
For web work, read browser --skill first; prefer AgentMux's Browser, reuse the confirmed Browser and honor the user's tool choice. Before opening an Agent/file/page or navigating, read space --skill, inspect your actual Tab/layout and choose a readable placement. For an amux:// link, read its object's module and use its exact identity. Preserve content, input and focus; confirm returned identities/receipts.
For Goal work read [Current goal-skill-entry](../../dist/goal-role-guidance.js "amux:generated goal-skill-entry"); each actual input supplies its original role/source. Guidance grants no permissions; reading it does not prove adoption or update a live context.
