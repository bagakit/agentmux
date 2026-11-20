---
tag: amux://
form: link
title: Object link
description: An exact object, Mote-scoped work reference or Runtime-qualified published Node resource. A valid link
  does not prove existence or grant access.
examples:
- label: Exact object identity
  template: wire
  parameters:
    target: agent/SID
---

# Object link

## wire

~~~text
amux://{{target}}
~~~
