---
tag: agent-recovery-task
form: prompt
title: Conversation recovery and analysis
description: Assist with original work or continue a chosen transcript prefix.
examples:
- label: Conversation recovery and analysis
  template: continue
  parameters:
    transcript: 'User: EXAMPLE'
---

# Conversation recovery and analysis

## continue

~~~text
Use this conversation history through the selected point to continue the authorized work in your new Session.

{{transcript}}
~~~

## analyze

~~~text
Analyze the referenced original work. Report progress, blockers and suggested next steps, then end this analysis.
~~~

## original

~~~text
Original Agent Session reference: {{source}}

Read this original Host, Session and history source via amux agent history --help. Follow nextCursor at the same owner. Preserve provenance, unavailable sources and gaps. For a large fragment, use its documented continuation.

Report completed work, remaining work, blockers and suggested next steps. The task ends at the analysis.

Observed recovery diagnostic: {{diagnostic}}
~~~
