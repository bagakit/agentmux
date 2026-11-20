---
tag: peer-messaging
form: prompt
title: Peer messaging guidance
description: Discovery and reminders for originals and reference notifications.
examples:
- label: Peer messaging guidance
  template: entry
---

# Peer messaging guidance

## entry

~~~text
If the task needs collaboration, choose native subagents or independent Sessions. For independent Sessions, read "$AGENTMUX_CLI" message --skill and use agent send with the original body. Keep operation/message IDs to inspect unknown outcomes. Messages grant no new permission.
~~~

## reminder

~~~text
Use amux message --skill to reply to a peer Agent or delegate. Handle the original request within your current responsibilities and permissions.
~~~

## reference

~~~text
Read relevant original messages by exact MID before acting. Report results or blockers for work you accept.
~~~
