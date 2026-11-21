---
tag: context
form: envelope
title: Browser context
description: A structured Browser observation attached to a message. Read the request in the message body.
  The observation gives the page and capture details. The original input record gives the observed source.
examples:
- label: Declared page observation
  template: wire
  parameters:
    json: '{"kind":"browser","version":1,"capturedAt":0,"browser":{"hostId":"local","browserId":"BID","navigationId":null},"page":{"url":"https://example.org/","title":"Example
      page"}}'
    reference: ''
  after: '


    Original request.'
---

# Browser context

## wire

~~~text
<amux>
<context kind="browser" version="1">
{{json}}
</context>
{{reference}}</amux>
~~~
