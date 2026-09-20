import { describe, expect, it } from 'vitest'

import { channelOf, planFor, trimName } from './plan.js'

function strip(channels, extra = {}) {
  return {
    displayName: 'Power Strip',
    serialNumber: '2302151827458554060448e1e9bac698',
    model: 'MSS426',
    channels,
    ...extra,
  }
}

describe('trimName', () => {
  it('leaves a name that fits alone', () => {
    expect(trimName('Power Strip')).toBe('Power Strip')
  })

  it('cuts a name to what matter accepts', () => {
    // A bridged accessory with a longer name is not truncated by anyone - it is refused, and
    // never appears in the controller at all.
    expect(trimName('x'.repeat(40))).toHaveLength(32)
  })

  it('does not leave a trailing space behind after cutting', () => {
    expect(trimName(`${'x'.repeat(31)} y`)).toBe('x'.repeat(31))
  })

  it('copes with nothing at all', () => {
    expect(trimName(undefined)).toBe('')
  })
})

describe('channelOf', () => {
  it('reads the channel out of a homekit subtype', () => {
    expect(channelOf('outlet-3')).toBe(3)
  })

  it('treats a subtype without a number as the first channel', () => {
    expect(channelOf('main')).toBe(0)
    expect(channelOf(undefined)).toBe(0)
  })
})

describe('planFor', () => {
  it('publishes a power strip as one device with a socket per channel', () => {
    const plan = planFor(strip([
      { subtype: 'outlet-1', displayName: 'Xbox', on: true },
      { subtype: 'outlet-2', displayName: 'AppleTV', on: true },
      { subtype: 'outlet-3', displayName: 'Purifier', on: false },
    ]))

    expect(plan.composed).toBe(true)
    expect(plan.displayName).toBe('Power Strip')
    expect(plan.parts.map(part => part.id)).toEqual(['outlet-1', 'outlet-2', 'outlet-3'])
    expect(plan.parts.map(part => part.displayName)).toEqual(['Xbox', 'AppleTV', 'Purifier'])
    expect(plan.parts.map(part => part.on)).toEqual([true, true, false])
  })

  it('puts the sockets in channel order whatever order homekit lists them in', () => {
    const plan = planFor(strip([
      { subtype: 'outlet-3', displayName: 'Third' },
      { subtype: 'outlet-1', displayName: 'First' },
      { subtype: 'outlet-2', displayName: 'Second' },
    ]))

    expect(plan.parts.map(part => part.displayName)).toEqual(['First', 'Second', 'Third'])
  })

  it('publishes a single socket as an outlet rather than a composed device', () => {
    const plan = planFor(strip([{ subtype: undefined, displayName: 'Plug', on: true }]))

    expect(plan.composed).toBe(false)
    expect(plan.parts).toHaveLength(1)
    expect(plan.parts[0].id).toBe('outlet-1')
  })

  it('has nothing to publish for an accessory with no on/off services', () => {
    expect(planFor(strip([]))).toBeNull()
    expect(planFor(undefined)).toBeNull()
  })

  it('names an unnamed socket after its place on the strip', () => {
    const plan = planFor(strip([
      { subtype: 'outlet-1', displayName: '' },
      { subtype: 'outlet-2' },
    ]))

    expect(plan.parts.map(part => part.displayName)).toEqual(['Outlet 1', 'Outlet 2'])
  })

  it('keeps the ids apart when two services share a subtype', () => {
    // Endpoint ids have to be unique within a device; two the same and the second endpoint
    // replaces the first.
    const plan = planFor(strip([
      { subtype: 'outlet-1', displayName: 'One' },
      { subtype: 'outlet-1', displayName: 'Two' },
    ]))

    expect(new Set(plan.parts.map(part => part.id)).size).toBe(2)
  })

  it('makes an id out of a subtype matter would not take', () => {
    const plan = planFor(strip([
      { subtype: 'Outlet #1 (left)', displayName: 'Left' },
      { subtype: 'outlet-2', displayName: 'Right' },
    ]))

    expect(plan.parts[0].id).toBe('outlet-1-left')
  })

  it('hands back whatever the caller attached to each channel', () => {
    const service = { name: 'the homekit service' }
    const plan = planFor(strip([{ subtype: 'outlet-1', displayName: 'Xbox', ref: service }]))

    expect(plan.parts[0].ref).toBe(service)
  })

  it('cuts the device name and the socket names to what matter accepts', () => {
    const plan = planFor(strip([{ subtype: 'outlet-1', displayName: 'y'.repeat(80) }], {
      displayName: 'x'.repeat(40),
    }))

    expect(plan.displayName).toHaveLength(32)
    expect(plan.parts[0].displayName).toHaveLength(64)
  })
})
