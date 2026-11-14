import { describe, expect, it } from 'vitest'
import { connectionOfferUrl, connectionLinkUrl, hasConnectionOffer, parseConnectionLinkUrl, parseConnectionOfferUrl, type ConnectionOffer } from '../src/connection-offer.js'

const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 3)).toString('base64')
const offer = (serverId: string, endpoint: string, useTls = false): ConnectionOffer => ({ v: 2, serverId, daemonPublicKeyB64: key, relay: { endpoint, useTls } })

describe('the compact phone connection link', () => {
  it('round-trips the full key and exact Host identity, and omits a Relay endpoint equal to the page', () => {
    const value = offer('ff7c2a51-0d4e-4f3b-9a8c-1b2c3d4e5f60', '10.69.47.238:8443')
    const url = connectionOfferUrl('http://10.69.47.238:8443/', value)
    expect(url.length).toBeLessThanOrEqual(125)
    expect(url).not.toContain('offer=')
    expect(hasConnectionOffer(url)).toBe(true)
    expect(parseConnectionOfferUrl(url)).toEqual(value)
    // A 12-character object ID makes it shorter still.
    expect(connectionOfferUrl('http://10.69.47.238:8443/', offer('Ab3dEf6hJk9m', '10.69.47.238:8443')).length).toBeLessThanOrEqual(92)
  })

  it('writes out a Relay on another host, and keeps TLS from the page', () => {
    const remote = offer('Ab3dEf6hJk9m', 'relay.example.org', true)
    const url = connectionOfferUrl('https://app.example.org/mobile/', remote)
    expect(parseConnectionOfferUrl(url)).toEqual(remote)
    // A plain local Relay behind an HTTPS page cannot be expressed, because TLS follows the page.
    expect(() => connectionOfferUrl('https://app.example.org/', offer('Ab3dEf6hJk9m', '10.0.0.5:8443', false))).toThrow(/same TLS/)
  })

  it('reads every field its encoder can write, including a long Host identity and an international Relay name', () => {
    const endpoint = ['a'.repeat(62), 'b'.repeat(62), 'c'.repeat(62), 'd'.repeat(62)].join('.')
    for (const value of [offer('h'.repeat(160), endpoint, true), offer('Ab3dEf6hJk9m', '例子.测试', true)]) {
      const url = connectionOfferUrl('https://app.example.org/', value)
      let parsed: ConnectionOffer | null = null
      expect(() => { parsed = parseConnectionOfferUrl(url) }).not.toThrow()
      expect(parsed).toEqual(value)
    }
  })

  it('recognises the format byte before validating the rest, so damage does not select a saved connection', () => {
    for (const endpoint of ['10.0.0.2:8443', '10.0.0.3:8443']) {
      const url = connectionOfferUrl('http://10.0.0.2:8443/', offer('Ab3dEf6hJk9m', endpoint))
      const page = url.slice(0, url.indexOf('#') + 1), fragment = new URL(url).hash.slice(1)
      for (const damaged of [fragment.slice(0, 2), fragment.slice(0, 20), fragment + '=', fragment.slice(0, 10) + '!' + fragment.slice(11)]) {
        expect(hasConnectionOffer(page + damaged)).toBe(true)
        expect(() => parseConnectionOfferUrl(page + damaged)).toThrow('Invalid connection link.')
      }
    }
    // Every other first byte stays outside this format, even when its first character is A.
    for (const format of Array.from({ length: 256 }, (_, value) => value).filter(value => value !== 2 && value !== 3 && !(value >= 4 && value <= 7))) {
      const fragment = Buffer.from([format, ...new Uint8Array(50)]).toString('base64url')
      expect(hasConnectionOffer('http://10.0.0.2:8443/#' + fragment), String(format)).toBe(false)
    }
  })

  it('leaves other fragments to the page and refuses a damaged or old-format link', () => {
    for (const other of ['http://10.0.0.2:8443/', 'http://10.0.0.2:8443/#amux-update', 'http://10.0.0.2:8443/#section']) {
      expect(hasConnectionOffer(other), other).toBe(false); expect(parseConnectionOfferUrl(other), other).toBeNull()
    }
    const good = connectionOfferUrl('http://10.0.0.2:8443/', offer('Ab3dEf6hJk9m', '10.0.0.2:8443'))
    const fragment = new URL(good).hash.slice(1)
    // Known old input is refused, never treated as an absent link that selects a saved Mac.
    for (const payload of ['', 'damaged', Buffer.from(JSON.stringify(offer('Ab3dEf6hJk9m', '10.0.0.2:8443'))).toString('base64url')]) {
      const legacy = 'http://10.0.0.2:8443/#offer=' + payload
      expect(hasConnectionOffer(legacy)).toBe(true)
      expect(() => parseConnectionOfferUrl(legacy)).toThrow('This connection link format is no longer supported.')
    }
    // Truncated, padded with trailing bytes, or with a wrong format byte.
    expect(() => parseConnectionOfferUrl('http://10.0.0.2:8443/#' + fragment.slice(0, -6))).toThrow()
    expect(() => parseConnectionOfferUrl('http://10.0.0.2:8443/#' + fragment + 'AAAA')).toThrow()
    const bytes = Buffer.from(fragment, 'base64url'); bytes[0] = 0x08
    expect(parseConnectionOfferUrl('http://10.0.0.2:8443/#' + bytes.toString('base64url'))).toBeNull()
    bytes[0] = 0x02; bytes[33] = 3
    expect(() => parseConnectionOfferUrl('http://10.0.0.2:8443/#' + bytes.toString('base64url'))).toThrow()
  })

  it('keeps the same local-network and HTTPS rules for the page and the Relay', () => {
    expect(() => connectionOfferUrl('http://203.0.113.9:8443/', offer('Ab3dEf6hJk9m', '203.0.113.9:8443'))).toThrow(/HTTPS/)
    const url = connectionOfferUrl('http://10.0.0.2:8443/', offer('Ab3dEf6hJk9m', '10.0.0.2:8443'))
    const moved = url.replace('10.0.0.2', '203.0.113.9')
    expect(() => parseConnectionOfferUrl(moved)).toThrow(/local network/)
  })
})

 it('same-origin pin links keep the complete key while full independent Relay offers remain exact', () => {
  const original = offer('original-host', '10.0.0.2:8443'), full = connectionOfferUrl('http://10.0.0.2:8443/', original)
  const short = connectionLinkUrl('http://10.0.0.2:8443/', original)
  expect(new URL(short).hash.slice(1)).toHaveLength(44)
  expect(short.length).toBeLessThan(full.length)
  expect(parseConnectionLinkUrl(short)).toEqual({ kind: 'pin', pin: { daemonPublicKeyB64: original.daemonPublicKeyB64 } })
  expect(() => parseConnectionOfferUrl(short)).toThrow('requires its original Host')
  for (const damaged of [short.slice(0,-1), short + '=', short + 'A']) { expect(hasConnectionOffer(damaged)).toBe(true); expect(() => parseConnectionLinkUrl(damaged)).toThrow() }
  const independent = offer('original-host', 'relay.example.org', true)
  expect(parseConnectionLinkUrl(connectionLinkUrl('https://app.example.org/', independent))).toEqual({ kind: 'offer', offer: independent })
 })
