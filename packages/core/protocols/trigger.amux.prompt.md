---
tag: trigger
form: envelope
title: Automatic trigger
description: Declares a heartbeat, calendar occurrence or automatic continuation. The original schedule and input
  own their execution receipts.
examples:
- label: heartbeat
  template: wire
  parameters:
    kind: heartbeat
    note: Original platform guidance.
  after: '


    Original request.'
- label: calendar
  template: wire
  parameters:
    kind: calendar
    note: Original platform guidance.
  after: '


    Original request.'
- label: automation
  template: wire
  parameters:
    kind: automation
    note: Original platform guidance.
  after: '


    Original request.'
---

# Automatic trigger

## wire

~~~text
<amux>
<trigger kind="{{kind}}"/>
{{note}}
</amux>
~~~

## note

~~~text
<trigger kind="{{kind}}"/>
{{note}}
~~~
