---
tag: amux:channel
form: envelope
title: Channel message
description: One unchanged external message with its application, actor and conversation.
  The message-id comes from the external platform. Use the original intake record for the AgentMux MID and authenticated binding.
examples:
- label: Original channel message
  template: wire
  parameters:
    attributes: domain="chat.example" app-id="APP" id-type="user-id" user-id="USER" conversation-id="ROOM" message-id="MESSAGE"
    body: Original channel body.
---

# Channel message

## wire

~~~text
<amux:channel {{attributes}}>
{{body}}
</amux:channel>
~~~

## header

~~~text
<amux:channel {{attributes}}>
~~~
