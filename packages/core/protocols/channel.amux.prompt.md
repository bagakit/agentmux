---
tag: amux:channel
form: envelope
title: Channel message
description: One unchanged external message with declared application, actor, conversation and original message IDs.
  Display profiles are observations; the original intake owns authentication and grants.
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
