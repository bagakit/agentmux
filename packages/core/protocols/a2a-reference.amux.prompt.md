---
tag: amux:a2a
form: envelope
title: A2A Inbox references
description: References to originals, individually or in an amux container. Reading this card does not fetch or acknowledge
  them.
examples:
- label: Single reference
  template: wire
  parameters:
    sender: SID
    mid: MID
- label: Merged references
  template: batch
  parameters:
    items: '<a2a from="SID" msg-id="MID" read-via="message --skill" />

      <a2a from="SID-2" msg-id="MID-2" read-via="message --skill" />'
---

# A2A Inbox references

## wire

~~~text
<amux:a2a from="{{sender}}" msg-id="{{mid}}" read-via="message --skill" />
~~~

## row

~~~text
<a2a from="{{sender}}" msg-id="{{mid}}" read-via="message --skill" />
~~~

## batch

~~~text
<amux>
{{items}}
</amux>
~~~
