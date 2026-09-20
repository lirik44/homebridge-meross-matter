import { beforeEach, describe, expect, it, vi } from 'vitest'

import EnergySimulator from '../energy/simulator.js'
import MatterBridge from './bridge.js'

const OUTLET = 'OUTLET-SERVICE'
const SWITCH = 'SWITCH-SERVICE'

// A HomeKit characteristic, as far as this plugin uses one: something that holds a value, sends
// writes on to the device, and tells whoever is listening when the value changed.
class FakeCharacteristic {
  constructor(value, apply) {
    this.value = value
    this.apply = apply
    this.listeners = []
  }

  on(event, listener) {
    if (event === 'change') {
      this.listeners.push(listener)
    }
    return this
  }

  setValue(value, callback, context) {
    Promise.resolve()
      .then(() => this.apply?.(value))
      .then(() => {
        this.change(value, context)
        callback?.(null)
      })
      .catch(err => callback?.(err))
    return this
  }

  // What a poll does when it finds the device somewhere else than it was left.
  change(value, context) {
    const oldValue = this.value
    this.value = value
    this.listeners.forEach(listener => listener({ oldValue, newValue: value, context }))
    return this
  }
}

function fakeService(uuid, subtype, displayName, value, apply) {
  const characteristic = new FakeCharacteristic(value, apply)

  return {
    UUID: uuid,
    subtype,
    displayName,
    characteristic,
    testCharacteristic: char => char === 'On',
    getCharacteristic: () => characteristic,
  }
}

function fakeAccessory(uuid, displayName, services, context = {}) {
  return {
    UUID: uuid,
    displayName,
    services,
    context: { serialNumber: 'sn-1', model: 'MSS426', channel: 0, ...context },
  }
}

function fakePlatform(accessories, config = {}) {
  const log = Object.assign(vi.fn(), { debug: vi.fn(), warn: vi.fn() })

  const matter = {
    uuid: { generate: seed => `uuid:${seed}` },
    deviceTypes: { OnOffOutlet: 'OnOffOutlet', BridgedNode: 'BridgedNode' },
    clusterNames: { OnOff: 'onOff' },
    registerPlatformAccessories: vi.fn().mockResolvedValue(undefined),
    unregisterPlatformAccessories: vi.fn().mockResolvedValue(undefined),
    updateAccessoryState: vi.fn().mockResolvedValue(undefined),
  }

  const api = {
    hap: {
      Characteristic: { On: 'On' },
      Service: { Outlet: { UUID: OUTLET }, Switch: { UUID: SWITCH } },
    },
    isMatterAvailable: () => true,
    isMatterEnabled: () => true,
    matter,
  }

  return {
    api,
    log,
    config,
    devicesInHB: new Map(accessories.map(accessory => [accessory.UUID, accessory])),
  }
}

// One power strip, the way this plugin shows it in HomeKit: a service per socket, the master
// channel left out.
function powerStrip(sent = []) {
  const apply = channel => value => sent.push({ channel, value })
  return fakeAccessory('hb-1', 'Power Strip', [
    { UUID: 'INFO' },
    fakeService(OUTLET, 'outlet-1', 'Xbox', true, apply(1)),
    fakeService(OUTLET, 'outlet-2', 'AppleTV', false, apply(2)),
    fakeService(OUTLET, 'outlet-3', 'Purifier', true, apply(3)),
  ])
}

describe('publishing', () => {
  let sent
  let platform
  let bridge

  beforeEach(async () => {
    sent = []
    platform = fakePlatform([powerStrip(sent)])
    bridge = new MatterBridge(platform)
    await bridge.publish('plugin', 'platform')
  })

  it('publishes a power strip as one device with a socket per channel', () => {
    const [[plugin, platformName, [descriptor]]] = platform.api.matter.registerPlatformAccessories.mock.calls

    expect(plugin).toBe('plugin')
    expect(platformName).toBe('platform')
    expect(descriptor.displayName).toBe('Power Strip')
    expect(descriptor.deviceType).toBe('BridgedNode')
    expect(descriptor.manufacturer).toBe('Meross')
    expect(descriptor.serialNumber).toBe('sn-1')
    expect(descriptor.parts.map(part => part.id)).toEqual(['outlet-1', 'outlet-2', 'outlet-3'])
    expect(descriptor.parts.map(part => part.displayName)).toEqual(['Xbox', 'AppleTV', 'Purifier'])
    expect(descriptor.parts.map(part => part.deviceType)).toEqual(['OnOffOutlet', 'OnOffOutlet', 'OnOffOutlet'])
  })

  it('publishes each socket at the state homekit already has for it', () => {
    const [[,, [descriptor]]] = platform.api.matter.registerPlatformAccessories.mock.calls

    expect(descriptor.parts.map(part => part.clusters.onOff.onOff)).toEqual([true, false, true])
  })

  it('sends a command from a controller to the device through homekit', async () => {
    const [[,, [descriptor]]] = platform.api.matter.registerPlatformAccessories.mock.calls

    await descriptor.parts[1].handlers.onOff.on()

    expect(sent).toEqual([{ channel: 2, value: true }])
  })

  it('ignores a command asking for what the socket is already doing', async () => {
    // A controller keeping its own copy of the state in step, not a person pressing anything.
    const [[,, [descriptor]]] = platform.api.matter.registerPlatformAccessories.mock.calls

    await descriptor.parts[0].handlers.onOff.on()

    expect(sent).toEqual([])
  })

  it('tells the controller when the device refuses a command', async () => {
    const failing = fakeAccessory('hb-2', 'Stubborn', [
      fakeService(OUTLET, 'outlet-1', 'Socket', false, () => {
        throw new Error('device offline')
      }),
    ])
    const own = fakePlatform([failing])
    const bridgeOfOwn = new MatterBridge(own)
    await bridgeOfOwn.publish('plugin', 'platform')
    const [[,, [descriptor]]] = own.api.matter.registerPlatformAccessories.mock.calls

    await expect(descriptor.handlers.onOff.on()).rejects.toThrow('device offline')
  })

  it('reports a change made anywhere else to the controllers', () => {
    const accessory = platform.devicesInHB.get('hb-1')
    accessory.services[2].characteristic.change(true)

    expect(platform.api.matter.updateAccessoryState).toHaveBeenCalledWith(
      'uuid:meross-matter-sn-1-0',
      'onOff',
      { onOff: true },
      'outlet-2',
    )
  })

  it('does not report a value the controllers already have', () => {
    const accessory = platform.devicesInHB.get('hb-1')

    // The state each socket was published at, arriving again from the first poll.
    accessory.services[1].characteristic.change(true)
    expect(platform.api.matter.updateAccessoryState).not.toHaveBeenCalled()

    accessory.services[1].characteristic.change(false)
    accessory.services[1].characteristic.change(false)
    expect(platform.api.matter.updateAccessoryState).toHaveBeenCalledTimes(1)
  })

  it('reports what a controller itself turned on, once the device has done it', async () => {
    const [[,, [descriptor]]] = platform.api.matter.registerPlatformAccessories.mock.calls

    await descriptor.parts[1].handlers.onOff.on()

    expect(platform.api.matter.updateAccessoryState).toHaveBeenCalledWith(
      'uuid:meross-matter-sn-1-0',
      'onOff',
      { onOff: true },
      'outlet-2',
    )
  })
})

describe('what is published at all', () => {
  it('publishes a single socket as an outlet, not as a composed device', async () => {
    const platform = fakePlatform([fakeAccessory('hb-1', 'Plug', [
      fakeService(OUTLET, undefined, 'Plug', false),
    ])])
    await new MatterBridge(platform).publish('plugin', 'platform')
    const [[,, [descriptor]]] = platform.api.matter.registerPlatformAccessories.mock.calls

    expect(descriptor.deviceType).toBe('OnOffOutlet')
    expect(descriptor.parts).toBeUndefined()
    expect(descriptor.clusters).toEqual({ onOff: { onOff: false } })
  })

  it('publishes a switch as an outlet too', async () => {
    const platform = fakePlatform([fakeAccessory('hb-1', 'Wall switch', [
      fakeService(SWITCH, undefined, 'Wall switch', true),
    ])])
    await new MatterBridge(platform).publish('plugin', 'platform')
    const [[,, [descriptor]]] = platform.api.matter.registerPlatformAccessories.mock.calls

    expect(descriptor.deviceType).toBe('OnOffOutlet')
  })

  it('leaves out a device with nothing matter has a place for', async () => {
    const platform = fakePlatform([fakeAccessory('hb-1', 'Thermostat', [
      { UUID: 'THERMOSTAT', testCharacteristic: () => false },
    ])])
    const published = await new MatterBridge(platform).publish('plugin', 'platform')

    expect(published).toBe(false)
    expect(platform.api.matter.registerPlatformAccessories).not.toHaveBeenCalled()
  })

  it('leaves out the hidden accessory that stands in for a master channel', async () => {
    const platform = fakePlatform([fakeAccessory('hb-1', 'Master', [
      fakeService(OUTLET, undefined, 'Master', true),
    ], { hidden: true })])
    const published = await new MatterBridge(platform).publish('plugin', 'platform')

    expect(published).toBe(false)
  })

  it('publishes nothing when matter is switched off in the config', async () => {
    const platform = fakePlatform([powerStrip()], { disableMatter: true })
    const published = await new MatterBridge(platform).publish('plugin', 'platform')

    expect(published).toBe(false)
    expect(platform.api.matter.registerPlatformAccessories).not.toHaveBeenCalled()
  })

  it('publishes nothing when the bridge has no matter', async () => {
    const platform = fakePlatform([powerStrip()])
    platform.api.isMatterEnabled = () => false
    const published = await new MatterBridge(platform).publish('plugin', 'platform')

    expect(published).toBe(false)
    expect(platform.api.matter.registerPlatformAccessories).not.toHaveBeenCalled()
  })

  it('carries on over homekit when matter refuses the device', async () => {
    const platform = fakePlatform([powerStrip()])
    platform.api.matter.registerPlatformAccessories.mockRejectedValue(new Error('name too long'))
    const published = await new MatterBridge(platform).publish('plugin', 'platform')

    expect(published).toBe(false)
    expect(platform.log.warn).toHaveBeenCalled()
  })
})

describe('taking devices away', () => {
  it('removes what it published before and no longer does', async () => {
    const platform = fakePlatform([powerStrip()])
    const bridge = new MatterBridge(platform)
    const gone = { UUID: 'uuid:meross-matter-sn-gone-0', displayName: 'Old plug' }

    bridge.rememberCached({ UUID: 'uuid:meross-matter-sn-1-0', displayName: 'Power Strip' })
    bridge.rememberCached(gone)
    await bridge.publish('plugin', 'platform')

    expect(platform.api.matter.unregisterPlatformAccessories).toHaveBeenCalledWith('plugin', 'platform', [gone])
  })

  it('removes everything when matter is switched off in the config', async () => {
    const platform = fakePlatform([powerStrip()], { disableMatter: true })
    const bridge = new MatterBridge(platform)
    const strip = { UUID: 'uuid:meross-matter-sn-1-0', displayName: 'Power Strip' }

    bridge.rememberCached(strip)
    await bridge.publish('plugin', 'platform')

    expect(platform.api.matter.unregisterPlatformAccessories).toHaveBeenCalledWith('plugin', 'platform', [strip])
  })
})

describe('the energy experiment', () => {
  const UUID = 'uuid:meross-matter-sn-1-0'

  function metered() {
    const clock = { at: new Date('2026-09-21T00:00:00Z').getTime() }
    const platform = fakePlatform([powerStrip()])
    platform.energy = new EnergySimulator({ now: () => clock.at })
    return { platform, clock }
  }

  function readings(platform) {
    const [[,, [descriptor]]] = platform.api.matter.registerPlatformAccessories.mock.calls
    return descriptor.parts
  }

  it('publishes what each socket is pretending to draw, in matter units', async () => {
    const { platform } = metered()
    await new MatterBridge(platform).publish('plugin', 'platform')
    const parts = readings(platform)

    // Milliwatts, millivolts and milliamps, as the spec has them.
    expect(parts[0].clusters.electricalPowerMeasurement).toEqual({
      activePower: 1_130_000,
      voltage: 230_000,
      activeCurrent: 4910,
    })
    // A socket that is off draws nothing, and says so rather than staying silent.
    expect(parts[1].clusters.electricalPowerMeasurement.activePower).toBe(0)
  })

  it('publishes both the running total and the window it covers', async () => {
    const { platform } = metered()
    await new MatterBridge(platform).publish('plugin', 'platform')
    const energy = readings(platform)[0].clusters.electricalEnergyMeasurement

    expect(energy.cumulativeEnergyImported.energy).toBe(0)
    expect(energy.periodicEnergyImported.energy).toBe(0)
    // Unix seconds: matter.js converts to the Matter epoch itself.
    expect(energy.cumulativeEnergyImported.endTimestamp).toBe(Math.floor(Date.parse('2026-09-21T00:00:00Z') / 1000))
  })

  it('reports a total that has climbed, and the hour it climbed in', async () => {
    const { platform, clock } = metered()
    const bridge = new MatterBridge(platform)
    await bridge.publish('plugin', 'platform')

    clock.at += 3_600_000
    bridge.reportEnergy(UUID, 'outlet-1', platform.devicesInHB.get('hb-1').services[1])

    const [cluster, attributes] = platform.api.matter.updateAccessoryState.mock.calls
      .filter(([,name]) => name === 'electricalEnergyMeasurement')
      .map(([, name, value]) => [name, value])
      .at(-1)

    expect(cluster).toBe('electricalEnergyMeasurement')
    expect(attributes.cumulativeEnergyImported.energy).toBe(1_130_000)
    expect(attributes.periodicEnergyImported.energy).toBe(1_130_000)
    expect(attributes.periodicEnergyImported.endTimestamp - attributes.periodicEnergyImported.startTimestamp).toBe(3600)
  })

  it('counts nothing for the time a socket spent off', async () => {
    const { platform, clock } = metered()
    const bridge = new MatterBridge(platform)
    await bridge.publish('plugin', 'platform')

    clock.at += 3_600_000
    bridge.reportEnergy(UUID, 'outlet-2', platform.devicesInHB.get('hb-1').services[2])

    const attributes = platform.api.matter.updateAccessoryState.mock.calls
      .filter(([,name]) => name === 'electricalEnergyMeasurement')
      .map(([,, value]) => value)
      .at(-1)

    expect(attributes.cumulativeEnergyImported.energy).toBe(0)
  })

  it('reports the power straight away when a socket is switched', async () => {
    const { platform } = metered()
    await new MatterBridge(platform).publish('plugin', 'platform')

    platform.devicesInHB.get('hb-1').services[2].characteristic.change(true)

    expect(platform.api.matter.updateAccessoryState).toHaveBeenCalledWith(
      UUID,
      'electricalPowerMeasurement',
      { activePower: 1_130_000, voltage: 230_000, activeCurrent: 4910 },
      'outlet-2',
    )
  })

  it('keeps reporting on its own while nothing is touched, and stops when told', async () => {
    vi.useFakeTimers()
    try {
      const platform = fakePlatform([powerStrip()])
      platform.energy = new EnergySimulator()
      const bridge = new MatterBridge(platform)
      await bridge.publish('plugin', 'platform')
      platform.api.matter.updateAccessoryState.mockClear()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(platform.api.matter.updateAccessoryState).toHaveBeenCalled()

      bridge.stop()
      platform.api.matter.updateAccessoryState.mockClear()
      await vi.advanceTimersByTimeAsync(180_000)
      expect(platform.api.matter.updateAccessoryState).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes no energy at all when the experiment is not set up', async () => {
    const platform = fakePlatform([powerStrip()])
    await new MatterBridge(platform).publish('plugin', 'platform')
    const parts = readings(platform)

    expect(parts[0].clusters.electricalPowerMeasurement).toBeUndefined()
    expect(parts[0].clusters.electricalEnergyMeasurement).toBeUndefined()
  })
})
