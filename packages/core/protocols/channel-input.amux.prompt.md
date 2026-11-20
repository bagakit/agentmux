---
tag: channel-input
form: prompt
title: Channel reply and context
description: Original Channel references, audience and reply entry points.
examples:
- label: Channel reply and context
  template: direct
---

# Channel reply and context

## direct

~~~text
This message came from a direct chat with one person.
~~~

## group

~~~text
This message came from a group chat; everyone there can read your replies, so keep unrelated private material out.
~~~

## reference

~~~text
Original retained field: {{field}}. {{purpose}}
~~~

## body-needed

~~~text
Read it before acting.
~~~

## quote-optional

~~~text
Read it when earlier context is relevant.
~~~

## read-entry

~~~text
Use amux message read --help to read the retained fields by original MID and follow the original cursor.
~~~

## mid

~~~text
Original message MID: {{mid}}.
~~~

## private-reply

~~~text
Reply through the original private chat. Ingress ID: {{ingress}}. Use amux space mote chat reply --help to send and keep one stable operation ID for amux space mote chat inspect --help. {{route}}
~~~

## private-unconfirmed

~~~text
Use the original MID as sourceMessageId to resolve this route.
~~~

## private-confirmed

~~~text
Use the confirmed private route.
~~~

## reaction

~~~text
For an external reaction, use amux connection --skill with the original bound identity and platform message ID.
~~~

## reply

~~~text
To reply, use amux connection --skill with the original message and its confirmed audience.
~~~
