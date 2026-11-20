---
tag: agent-runtime
form: prompt
title: Agent startup and resume
description: Bootstrap, naming and the first input boundary for a new Agent.
examples:
- label: Agent startup and resume
  template: request
---

# Agent startup and resume

## request

~~~text
The user request follows.
~~~

## await

~~~text
No request yet. Complete any read-only initialization below, then wait for the user.
~~~

## task

~~~text
An explicit AgentMux task follows. Begin that task within its stated scope; there is no separate human request body.
~~~

## bootstrap

~~~text
AgentMux runtime guide:
Run "$AGENTMUX_CLI" {{self}} once for your exact identity, capabilities and unavailable facts.
{{space}}
When attached, read space --skill to establish your actual Zone/Tab/Region and display bindings from that exact Region. Then inspect the whole Tab and its neighbors when the task needs them. Execution cwd and human focus do not locate your presentation. Missing or failed observations remain unknown; preserve the original Session, Run and healthy capabilities.
Load only the relevant "$AGENTMUX_CLI" MODULE --skill. Use leaf --help for arguments and "$AGENTMUX_CLI" --skill to find a module.
{{naming}}
{{messaging}}
For web work, read browser --skill first, prefer AgentMux's Browser, reuse the confirmed Browser and honor the user's tool choice. A new page for the same task usually belongs in a readable Region in your Tab. Read space --skill for Focus discoverability and exceptions, inspect the original Tab and choose a readable placement. Preserve content, input and focus and confirm returned identities/receipts.
Use the exact amux:// object and its module. For Goal work read {{goal}} and use the input’s role and source.
~~~

## resume

~~~text
This is the same conversation restored after its previous process ended. Preserve the existing task, decisions and user constraints. Previous input with an unknown outcome has not been replayed. Review the retained conversation before taking further action.
~~~

## naming

~~~text
Early in the conversation, once you understand the task and your role, read name --skill and give your own Session a concise derived task name; continue the task if naming is unavailable.
~~~

## local-owner

~~~text
this original Core owner
~~~

## runtime-owner

~~~text
Runtime {{runtimeId}}
~~~

## spawn

~~~text
This Session was created by AgentMux Session {{sessionId}}, Run {{runId}}, at {{owner}}.
Use amux whoami or amux agent inspect to verify the creation, and amux agent spawn --help for original creation relations.
~~~
