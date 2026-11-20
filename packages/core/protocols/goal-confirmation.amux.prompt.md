---
tag: amux:goal
form: envelope
title: Goal continuation requested
description: Identifies the original Goal confirmation and continuation request. Read the original Goal and input
  receipt to confirm their effects.
examples:
- label: Confirm a Goal and ask its Supervisor to continue
  template: wire
  parameters:
    attributes: goal="amux://goal/GOAL?runtime=RUNTIME&amp;namespace=NAMESPACE" revision="1" operation-id="OP"
    body:
      template: instruction
---

# Goal continuation requested

## wire

~~~text
<amux:goal version="2" action="confirm-and-continue" {{attributes}}>
{{body}}
</amux:goal>
~~~

## instruction

~~~text
The user confirmed this Goal proposal and asked you, its Supervisor, to continue.
Read amux goal --skill. Verify the original confirmation, current proposal revision and your Supervisor role.
Advance the ready Tickets in the original Goal. Follow up on dispatches, collect reports, arrange independent review and advance newly ready work.
Write progress back to the Goal. Continue until results are ready for the user to accept or a concrete blocker needs action. Keep unaffected Tickets moving.
~~~
