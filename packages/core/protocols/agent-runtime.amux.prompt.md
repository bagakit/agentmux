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
Run "$AGENTMUX_CLI" {{self}} once for your identity and capabilities.
{{space}}
When attached, read space --skill to establish your actual Zone/Tab/Region. Execution cwd and human focus do not locate your presentation. Preserve original Sessions, Runs and healthy capabilities when observations are unknown.
Load only the relevant "$AGENTMUX_CLI" MODULE --skill. Use leaf --help for arguments and "$AGENTMUX_CLI" --skill to find a module.
{{naming}}
{{messaging}}
For web work, read browser --skill first, prefer AgentMux's Browser, reuse the confirmed Browser and honor the user's tool choice. A new page for the same task usually belongs in a readable Region in your Tab. Read space --skill for Focus discoverability and exceptions, inspect the original Tab and choose a readable placement. Preserve content, input and focus and confirm returned identities/receipts.
For amux:// links use the exact object and its module. For Goal work read {{goal}} and use the role/source of the actual input.
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
