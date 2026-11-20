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
Review outstanding commitments. If there is a useful next step, take one useful authorized action and verify it. Otherwise use the quiet outcome.
~~~

## heartbeat-source

~~~text
Original Mote Space: {{space}}
Original Zone: {{zone}}
Original resource: Host {{host}}, Workspace {{workspace}}, directory {{directory}}
Use amux space mote dialogue supervision read --help for the original work and reports. For this heartbeat’s result, follow the reporting section of amux mote --skill.
~~~

## observation

~~~text
Use amux agent input observation --help with the member Session ID and observation ID shown here. The input phase may still be waiting for a result. Coordinate from the verified record.
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
This is your private Mote thread {{groupId}}. Follow the reply guidance attached to the original addressed input.
~~~

## group-input

~~~text
Ordinary output stays in your Thread. Publish an addressed reply via amux space mote group reply --help with the original groupId, inputOperationId and operationId and your reply as body. Keep the same operationId and body after an uncertain delivery. Share only material for this Group.

Original Group source and reply operation:
{{original}}{{quote}}
~~~

## private-input

~~~text
Reply in this private thread using amux space mote direct reply --help with the original threadId, inputOperationId and operationId and your reply as body. Keep the same operationId and body after an uncertain delivery.
If the source lists images, use amux space mote direct image read --help with the original threadId, messageId and the image's operationId as imageOperationId. Keep the image in this private conversation.

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
~~~

## private-report

~~~text
A Mote reported back on your private assignment. Use amux space mote direct inspect --help, then read the report with your own Mote target, the given threadId and replyMessageId as messageId. If the report needs follow-up, use amux space mote direct send --help to continue in the same private conversation.

{{original}}
~~~
