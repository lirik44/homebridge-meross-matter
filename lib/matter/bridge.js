import { planFor } from './plan.js'

// Marks a HomeKit write as this plugin's own, so anyone looking at where a change came from can
// tell a Matter controller from a person in the Home app.
const MATTER_CONTEXT = { source: 'matter' }

/** How often the invented energy readings go out. */
const ENERGY_INTERVAL_MS = 60_000

/**
 * The devices this plugin already shows in HomeKit, published over Matter as well - so the same
 * sockets reach Alexa, SmartThings and Aqara without a second copy of anything.
 *
 * Both ecosystems drive the same HomeKit characteristic, which is what keeps them from disagreeing:
 * a Matter command is a write to it, and everything the device reports - a poll, the app, a finger
 * on the socket itself - arrives as a change on it and goes straight out to the controllers.
 *
 * Homebridge only defines `api.matter` on a bridge that has Matter switched on, so enabling it
 * there is the real opt-in; `disableMatter` in the config exists to say no to it anyway.
 */
export default class MatterBridge {
  constructor(platform) {
    this.platform = platform
    this.api = platform.api
    this.log = platform.log

    // What Homebridge restored from its Matter cache, and what we end up publishing this time.
    this.cached = []
    this.published = new Map()

    // The last value each endpoint was told, so an unchanged one is not sent again.
    this.reported = new Map()

    // The characteristics already being listened to, so a second publish does not double up.
    this.followed = new WeakSet()

    this.energyTimer = null
  }

  /**
   * @param {object} api The Homebridge API.
   * @returns {boolean} Whether this Homebridge can publish over Matter at all.
   */
  static isAvailable(api) {
    return !!(api
      && typeof api.isMatterAvailable === 'function'
      && api.isMatterAvailable()
      && api.isMatterEnabled()
      && api.matter
      && typeof api.matter.registerPlatformAccessories === 'function')
  }

  /**
   * Takes note of an accessory Homebridge restored from its Matter cache. Anything not published
   * again is taken away afterwards - a controller keeps whatever it was once given until it is
   * told otherwise.
   *
   * @param {object} accessory The restored Matter accessory.
   * @returns {void}
   */
  rememberCached(accessory) {
    this.cached.push(accessory)
  }

  /**
   * Publishes every accessory that has something to publish, and starts reporting their changes.
   *
   * @param {string} pluginName The plugin identifier to register under.
   * @param {string} platformName The platform name to register under.
   * @returns {Promise<boolean>} Whether anything was published.
   */
  async publish(pluginName, platformName) {
    if (this.platform.config.disableMatter) {
      await this.unregisterStale(pluginName, platformName)
      return false
    }

    if (!MatterBridge.isAvailable(this.api)) {
      this.log.debug('Matter is not enabled for this bridge, publishing over HomeKit only.')
      return false
    }

    const descriptors = []
    this.platform.devicesInHB.forEach((accessory) => {
      const descriptor = this.descriptorFor(accessory)
      if (descriptor) {
        descriptors.push(descriptor)
      }
    })

    if (descriptors.length === 0) {
      await this.unregisterStale(pluginName, platformName)
      return false
    }

    try {
      await this.api.matter.registerPlatformAccessories(pluginName, platformName, descriptors)
    } catch (err) {
      this.published.clear()
      this.log.warn('Could not publish over Matter: %s.', err?.message || err)
      return false
    }

    await this.unregisterStale(pluginName, platformName)
    this.follow()

    this.log(
      'Published %s device(s) over Matter: %s.',
      descriptors.length,
      descriptors.map(descriptor => descriptor.displayName).join(', '),
    )
    return true
  }

  // What each device becomes over Matter.

  /**
   * @param {object} accessory A Homebridge accessory.
   * @returns {object} Its name and identity, plus one entry per on/off service it shows.
   */
  describe(accessory) {
    const { Characteristic, Service } = this.api.hap
    const kinds = [Service.Outlet.UUID, Service.Switch.UUID]

    const channels = (accessory.services || [])
      .filter(service => kinds.includes(service.UUID) && service.testCharacteristic(Characteristic.On))
      .map(service => ({
        subtype: service.subtype,
        displayName: service.displayName,
        on: service.getCharacteristic(Characteristic.On).value === true,
        ref: service,
      }))

    return {
      displayName: accessory.displayName,
      serialNumber: accessory.context?.serialNumber,
      model: accessory.context?.model,
      channels,
    }
  }

  /**
   * @param {object} accessory A Homebridge accessory.
   * @returns {object|null} What to register it as, or null when it shows nothing Matter has a
   *   place for. Lights, thermostats, garage doors and the sensors are HomeKit-only for now.
   */
  descriptorFor(accessory) {
    // A hidden accessory exists only to keep a master channel out of HomeKit; it has no services.
    if (accessory.context?.hidden) {
      return null
    }

    const plan = planFor(this.describe(accessory))
    if (!plan) {
      return null
    }

    const { deviceTypes } = this.api.matter
    // Changing the suffix hands the controllers a device they have never seen, which is the only
    // way to undo what a controller keeps on its own side about an accessory - Apple Home's
    // choice to split a composed device into separate tiles, for one, which it remembers per
    // accessory and does not always offer a way back from. The old one is unregistered as stale
    // on the same start, so nothing is left behind.
    const suffix = this.platform.config.matterIdSuffix
    const uuid = this.api.matter.uuid.generate(
      `meross-matter-${plan.serialNumber}-${accessory.context?.channel ?? 0}${suffix ? `-${suffix}` : ''}`,
    )

    const common = {
      UUID: uuid,
      displayName: plan.displayName,
      manufacturer: 'Meross',
      model: plan.model,
      serialNumber: plan.serialNumber,
      context: {
        serialNumber: plan.serialNumber,
        channel: accessory.context?.channel ?? 0,
      },
    }

    if (!plan.composed) {
      const [part] = plan.parts
      this.remember(uuid, [{ partId: undefined, service: part.ref, on: part.on }])

      return {
        ...common,
        deviceType: deviceTypes.OnOffOutlet,
        clusters: { onOff: { onOff: part.on }, ...this.energyClusters(uuid, undefined, part.ref) },
        handlers: this.handlersFor(uuid, undefined, part.ref),
      }
    }

    this.remember(uuid, plan.parts.map(part => ({ partId: part.id, service: part.ref, on: part.on })))

    return {
      ...common,
      // The parent carries the name and the identity; the sockets hang off it as child endpoints,
      // which is what makes one expandable tile rather than seven loose ones.
      deviceType: deviceTypes.BridgedNode,
      parts: plan.parts.map(part => ({
        id: part.id,
        displayName: part.displayName,
        deviceType: deviceTypes.OnOffOutlet,
        clusters: { onOff: { onOff: part.on }, ...this.energyClusters(uuid, part.id, part.ref) },
        handlers: this.handlersFor(uuid, part.id, part.ref),
      })),
    }
  }

  /**
   * The energy experiment. The strip measures nothing, so the readings are invented - see
   * lib/energy/simulator.js. They are made here rather than in the HomeKit accessory because
   * HomeKit has nowhere to put them: the Home app ignores Eve's characteristics, and this bridge
   * runs with HAP switched off.
   *
   * @param {string} uuid The accessory.
   * @param {string} [partId] The socket, where the device has more than one.
   * @param {object} service The HomeKit service behind it, which knows whether it is on.
   * @returns {object} The Matter clusters for what it draws - power in milliwatts, voltage in
   *   millivolts, current in milliamps, energy in milliwatt-hours, as the spec has them, with the
   *   timestamps a controller needs to place a reading in time. Homebridge fills in the mandatory
   *   accuracy and power-mode metadata itself.
   */
  energyClusters(uuid, partId, service) {
    const energy = this.platform.energy
    if (!energy) {
      return {}
    }

    const on = service.getCharacteristic(this.api.hap.Characteristic.On).value === true
    const reading = energy.sample(`${uuid}:${partId ?? ''}`, on)

    // The spec constrains a reading's window to end at least a second after it starts, and the
    // first reading of all is taken the moment the socket is published - a window of no width,
    // which the endpoint refuses outright, taking the whole accessory with it.
    const window = (fromMs, toMs) => {
      const startTimestamp = Math.floor(fromMs / 1000)
      return { startTimestamp, endTimestamp: Math.max(Math.floor(toMs / 1000), startTimestamp + 1) }
    }

    return {
      electricalPowerMeasurement: {
        activePower: Math.round(reading.watts * 1000),
        voltage: Math.round(reading.volts * 1000),
        activeCurrent: Math.round(reading.amps * 1000),
      },
      electricalEnergyMeasurement: {
        // What the socket has used altogether, and what it used in the window just gone. A
        // history is built from the second of those, so the window is reported even when nothing
        // was used - a gap and a zero are not the same thing to a controller.
        cumulativeEnergyImported: {
          energy: Math.round(reading.kWh * 1_000_000),
          ...window(reading.startedAt, reading.periodEnd),
        },
        periodicEnergyImported: {
          energy: Math.round(reading.periodKWh * 1_000_000),
          ...window(reading.periodStart, reading.periodEnd),
        },
      },
    }
  }

  /**
   * @param {string} uuid The accessory the commands are for.
   * @param {string} [partId] The socket they are for, where the device has more than one.
   * @param {object} service The HomeKit service behind it.
   * @returns {object} The handlers a controller's commands arrive at.
   */
  handlersFor(uuid, partId, service) {
    return {
      onOff: {
        on: () => this.command(uuid, partId, service, true),
        off: () => this.command(uuid, partId, service, false),
      },
    }
  }

  // Keeping the two ecosystems in step.

  /**
   * Carries a command out through HomeKit, so both ecosystems go through one path to the device.
   *
   * @param {string} uuid The accessory the command is for.
   * @param {string} [partId] The socket it is for.
   * @param {object} service The HomeKit service behind it.
   * @param {boolean} value What is being asked for.
   * @returns {Promise<void>} Resolves once the device has been told, rejects if it refused.
   */
  async command(uuid, partId, service, value) {
    const char = service.getCharacteristic(this.api.hap.Characteristic.On)

    // A command asking for what the socket is already doing is a controller keeping its own copy
    // of the state in step, not a person pressing anything. Obeyed, the two ecosystems take turns
    // telling each other what they were each told a moment ago.
    if (char.value === value) {
      return
    }

    await new Promise((resolve, reject) => {
      char.setValue(value, err => (err ? reject(err) : resolve()), MATTER_CONTEXT)
    })
  }

  /**
   * Listens to every published socket, so a change made anywhere - the Home app, the Meross app,
   * the button on the device, a schedule the device runs by itself - reaches the controllers.
   *
   * @returns {void}
   */
  follow() {
    const { Characteristic } = this.api.hap

    this.published.forEach((parts, uuid) => {
      parts.forEach(({ partId, service }) => {
        const char = service.getCharacteristic(Characteristic.On)
        if (this.followed.has(char)) {
          return
        }

        this.followed.add(char)
        char.on('change', ({ newValue }) => {
          this.report(uuid, partId, newValue === true)
          // A socket that was just switched is drawing something else now, and the total to that
          // moment belongs to the state it was in before.
          this.reportEnergy(uuid, partId, service)
        })
      })
    })

    this.startEnergyReporting()
  }

  /**
   * Energy climbs with the clock rather than with anything the device says, so it goes out on a
   * measured cadence. A minute is what the Matter energy events want - they are not throttled,
   * unlike the power attributes.
   *
   * @returns {void}
   */
  startEnergyReporting() {
    if (this.energyTimer || !this.platform.energy) {
      return
    }

    this.energyTimer = setInterval(() => {
      this.published.forEach((parts, uuid) => {
        let watts = 0
        let mWh = 0

        parts.forEach(({ partId, service }) => {
          const clusters = this.reportEnergy(uuid, partId, service)
          watts += (clusters.electricalPowerMeasurement?.activePower ?? 0) / 1000
          mWh += clusters.electricalEnergyMeasurement?.cumulativeEnergyImported?.energy ?? 0
        })

        // Said out loud rather than at debug: the whole point of the experiment is watching these
        // numbers reach a controller, and a line a minute is what tells us our side is alive.
        this.log(
          'Energy reported over Matter: %s W now, %s kWh so far.',
          Math.round(watts),
          Math.round(mWh / 1000) / 1000,
        )
      })
    }, ENERGY_INTERVAL_MS)
  }

  /**
   * @returns {void} Stops reporting, for a Homebridge that is shutting down.
   */
  stop() {
    if (this.energyTimer) {
      clearInterval(this.energyTimer)
      this.energyTimer = null
    }
  }

  /**
   * @param {string} uuid The accessory that changed.
   * @param {string} [partId] The socket that changed.
   * @param {boolean} on What it changed to.
   * @returns {void}
   */
  report(uuid, partId, on) {
    const cluster = this.api.matter.clusterNames?.OnOff ?? 'onOff'
    this.reportState(uuid, partId, cluster, { onOff: on }, on)
  }

  /**
   * @param {string} uuid The accessory whose socket changed.
   * @param {string} [partId] The socket.
   * @param {object} service The HomeKit service behind it.
   * @returns {object} What was reported, so the caller can add it up.
   */
  reportEnergy(uuid, partId, service) {
    const clusters = this.energyClusters(uuid, partId, service)

    Object.keys(clusters).forEach((cluster) => {
      this.reportState(uuid, partId, cluster, clusters[cluster], JSON.stringify(clusters[cluster]))
    })

    return clusters
  }

  /**
   * Sends one cluster's state to the controllers, unless they already have it.
   *
   * @param {string} uuid The accessory.
   * @param {string} [partId] The socket, where the device has more than one.
   * @param {string} cluster Which cluster the attributes belong to.
   * @param {object} attributes What to report.
   * @param {*} signature What to compare against last time, to say nothing twice.
   * @returns {void}
   */
  reportState(uuid, partId, cluster, attributes, signature) {
    const key = `${uuid}:${partId ?? ''}:${cluster}`
    if (this.reported.get(key) === signature) {
      return
    }
    this.reported.set(key, signature)

    Promise.resolve(this.api.matter.updateAccessoryState(uuid, cluster, attributes, partId))
      .catch(err => this.log.debug('Could not report a change over Matter: %s.', err?.message || err))
  }

  // Helpers.

  /**
   * @param {string} uuid The accessory being published.
   * @param {Array<object>} parts Its sockets, and the HomeKit service behind each.
   * @returns {void}
   */
  remember(uuid, parts) {
    this.published.set(uuid, parts)
    // What was published is what a later change is measured against, so the first poll after a
    // restart does not report a value the controllers were just given.
    const cluster = this.api.matter.clusterNames?.OnOff ?? 'onOff'
    parts.forEach(({ partId, on }) => this.reported.set(`${uuid}:${partId ?? ''}:${cluster}`, on))
  }

  /**
   * Takes away what this plugin used to publish and no longer does - a device removed from the
   * account, a channel hidden in the config, or Matter turned off altogether.
   *
   * @param {string} pluginName The plugin identifier it was registered under.
   * @param {string} platformName The platform name it was registered under.
   * @returns {Promise<void>} Resolves once they are gone.
   */
  async unregisterStale(pluginName, platformName) {
    if (!MatterBridge.isAvailable(this.api)) {
      return
    }

    const stale = this.cached.filter(accessory => accessory && !this.published.has(accessory.UUID))
    if (stale.length === 0) {
      return
    }

    try {
      await this.api.matter.unregisterPlatformAccessories(pluginName, platformName, stale)
      this.log(
        'Removed %s device(s) no longer published over Matter: %s.',
        stale.length,
        stale.map(accessory => accessory.displayName).join(', '),
      )
    } catch (err) {
      this.log.warn('Could not remove the Matter devices no longer published: %s.', err?.message || err)
    }
  }
}
