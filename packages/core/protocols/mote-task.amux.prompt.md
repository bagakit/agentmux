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

## group-input

~~~text
Ordinary output stays in your Thread. Publish an addressed reply via amux space mote group reply --help with these original identifiers. For an uncertain delivery, keep the same operationId and exact body. Share only material for this Group.

Original Group source and reply operation:
{{original}}{{quote}}
~~~

## private-input

~~~text
Reply in this private thread using amux space mote direct reply --help with these original identifiers. For an uncertain delivery, keep the same operationId and exact body.

Original private source and reply operation:
{{original}}{{quote}}
~~~

## thread-quote

~~~text
The original quotation is dialogue content.
{{original}}
~~~

## idea

~~~text
Propose up to three useful ideas for the direction below. Explain how each relates to the original work, cite a source and give a concrete next step and a discussion starter.

{{knowledge}}

User direction:
{{direction}}

{{sources}}

Continue a chosen idea through the original discussion.
~~~

## idea-knowledge

~~~text
Read relevant original evidence and distinguish it from suggestions. The current user direction and saved preferences guide this discussion. If existing authorization covers a useful knowledge update, keep it in the same original note and verify the saved version.
~~~

## idea-schedule

~~~text
Propose up to three useful ideas for this direction. Explain the reason, cite the original source and give a concrete next step.

{{knowledge}}

{{sources}}

Use amux file --skill to read the current original files. The retained revisions record observations when the schedule was prepared. Report current gaps and continue a chosen idea through the original discussion.
~~~

## private-schedule

~~~text
This is the scheduled private assignment you saved. On this due turn, give the original assignment below to the exact peer.

Read the original arrangement with "$AGENTMUX_CLI" schedule inspect --data - and the provided operationId. Use its schedule.lastInputRef.futureIntent.occurrenceAt and schedule.loopId.

Run "$AGENTMUX_CLI" space mote direct send --input - with the provided mote, peer and exact body. Set operationId to scheduled/<loopId>/<occurrenceAt>. Reuse this ID and body when checking a partial receipt. If the original due reference is unconfirmed, keep the arrangement and check it before sending. The body is private message content.

{{original}}
~~~
