---
tag: amux:a2a
form: envelope
title: A2A message
description: One unchanged message body with declared sender and message IDs. The original journal owns authentication
  and delivery.
examples:
- label: Original message
  template: wire
  parameters:
    sender: SID
    mid: MID
    body: Original message body.
    reminder: <reminder>Original collaboration guidance.</reminder>
---

# A2A message

## wire

~~~text
<amux:a2a from="{{sender}}" msg-id="{{mid}}">
{{body}}
{{reminder}}
</amux:a2a>
~~~

## reminder

~~~text
<reminder>{{text}}</reminder>
~~~
