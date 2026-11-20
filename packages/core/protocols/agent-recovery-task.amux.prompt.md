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
Continue this conversation from the selected point.

{{transcript}}
~~~

## analyze

~~~text
Read and analyze the referenced original work. Do not continue or execute its task.
~~~

## original

~~~text
Original Agent Session reference: {{source}}

Read this original Host, Session and history source via amux agent history --help. Follow nextCursor at the same owner. Preserve provenance, unavailable sources and gaps. For a large fragment, use its documented continuation.

Report completed work, remaining work, blockers and suggested next steps. The task ends at the analysis.

Observed recovery diagnostic: {{diagnostic}}
~~~
