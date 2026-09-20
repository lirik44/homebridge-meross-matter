// An experiment: the mss426 has no meter of its own - its ability list carries no
// Appliance.Control.Electricity - so these numbers are invented, not measured. The point is to see
// what iOS 27 does with energy readings from a bridged outlet: whether the Home app draws them for
// a HomeKit accessory speaking Eve's characteristics, and whether it draws them for the same
// sockets over Matter, where energy is a first-class cluster.
//
// A socket that is on draws a flat 1.13 kW, and its total climbs at 1.13 kWh an hour. Both
// ecosystems are told the same thing in their own units, so the two can be compared side by side.

/** What a socket that is switched on is pretending to draw. */
export const FAKE_POWER_W = 1130

/** Mains voltage, so the current works out to something believable. */
export const FAKE_VOLTAGE_V = 230

export default class EnergySimulator {
  /**
   * @param {object} [options] What to pretend.
   * @param {number} [options.watts] What a socket that is on draws.
   * @param {number} [options.volts] The mains voltage to claim.
   * @param {Function} [options.now] Where the time comes from, so tests can move it.
   */
  constructor({ watts = FAKE_POWER_W, volts = FAKE_VOLTAGE_V, now = () => Date.now() } = {}) {
    this.watts = watts
    this.volts = volts
    this.now = now
    this.sockets = new Map()
  }

  /**
   * Reads a socket, and accrues what it has used since the last reading.
   *
   * The window between two readings is reported as well as the running total: a controller
   * building a history of what was used when needs to know which stretch of time a figure covers,
   * and that is what Matter's periodic energy is for.
   *
   * @param {string} key Which socket.
   * @param {boolean} on Whether it is on now.
   * @returns {{watts: number, kWh: number, volts: number, amps: number, periodKWh: number,
   *   periodStart: number, periodEnd: number, startedAt: number}} What to report.
   */
  sample(key, on) {
    const at = this.now()
    const before = this.sockets.get(key) ?? { on, kWh: 0, at, startedAt: at }

    // Only the time a socket spent switched on counts towards its total.
    const hours = Math.max(0, at - before.at) / 3_600_000
    const periodKWh = before.on ? (this.watts / 1000) * hours : 0
    const kWh = before.kWh + periodKWh

    this.sockets.set(key, { on, kWh, at, startedAt: before.startedAt })

    const watts = on ? this.watts : 0
    return {
      watts,
      kWh,
      volts: this.volts,
      amps: Math.round((watts / this.volts) * 100) / 100,
      periodKWh,
      periodStart: before.at,
      periodEnd: at,
      startedAt: before.startedAt,
    }
  }

  /**
   * Takes back up totals from before a restart. A controller reads a cumulative counter that
   * dropped as a counter that was reset, and throws away what it had accounted for, so the totals
   * have to survive Homebridge restarting.
   *
   * What each socket was doing while nothing was watching is not known, so the gap counts as
   * nothing used rather than as a guess.
   *
   * @param {object} [state] What {@link snapshot} returned, from wherever it was kept.
   * @returns {void}
   */
  restore(state) {
    const at = this.now()

    Object.entries(state ?? {}).forEach(([key, entry]) => {
      if (!entry || typeof entry.kWh !== 'number' || !Number.isFinite(entry.kWh)) {
        return
      }

      this.sockets.set(key, {
        on: false,
        kWh: entry.kWh,
        at,
        startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : at,
      })
    })
  }

  /**
   * @returns {object} The totals, small enough to keep anywhere.
   */
  snapshot() {
    const state = {}
    this.sockets.forEach((entry, key) => {
      state[key] = { kWh: entry.kWh, startedAt: entry.startedAt }
    })
    return state
  }

  /**
   * @param {string} key The socket whose total to put back to zero, as Eve's reset button does.
   * @returns {void}
   */
  reset(key) {
    const at = this.now()
    this.sockets.set(key, { on: this.sockets.get(key)?.on ?? false, kWh: 0, at, startedAt: at })
  }
}
