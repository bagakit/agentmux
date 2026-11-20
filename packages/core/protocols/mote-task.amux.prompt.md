---
tag: mote-task
form: prompt
title: Mote task and supervision
description: Prompts for ordinary Mote input, arranged heartbeat and original observation.
examples:
- label: Mote task and supervision
  template: ordinary
---

# Mote task and supervision

## ordinary

~~~text
Use amux mote --skill for this workface and its current role. Answer the original request. When you are the confirmed Main, coordinate the work entrusted to you and report verified progress.
~~~

## supervision

~~~text
Check the original reports. Record a verified result or a specific blocker; stay quiet without a useful change. Read amux mote --skill for the supervision procedure.
~~~

## heartbeat

~~~text
Review outstanding commitments, take one useful authorized action, and verify the result.
~~~

## heartbeat-source

~~~text
Original Mote Space: {{space}}
Original Zone: {{zone}}
Original resource: Host {{host}}, Workspace {{workspace}}, directory {{directory}}
Read the original work and reports via amux space mote dialogue supervision read --help.
~~~

## observation

~~~text
This is an observation of original member input, not a new human request or permission. Use amux agent input observation --help to review the result before coordinating. Keep the original input and its outcome separate.
~~~

## group-thread

~~~text
This is your dedicated work thread for built-in Group {{groupId}}. Its dialogue and audience are distinct from your other Groups and Main. Only explicit Group reply publications enter the shared conversation.
~~~

## group-invitation

~~~text
You joined this AgentMux Group. No reply is needed. For Group commands, use amux space mote group --help.

{{announcement}}
~~~

## private-thread

~~~text
This is your private Mote thread {{groupId}}. Use the reply command supplied with the original addressed input.
~~~
