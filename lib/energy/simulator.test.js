import { describe, expect, it } from 'vitest'

import EnergySimulator, { FAKE_POWER_W } from './simulator.js'

function atMinute(minutes) {
  return new Date('2026-09-20T00:00:00Z').getTime() + minutes * 60_000
}

function simulator() {
  const clock = { minutes: 0 }
  const sim = new EnergySimulator({ now: () => atMinute(clock.minutes) })
  return { sim, clock }
}

describe('energySimulator', () => {
  it('reports the made-up load while a socket is on, and nothing while it is off', () => {
    const { sim } = simulator()

    expect(sim.sample('outlet-1', true).watts).toBe(FAKE_POWER_W)
    expect(sim.sample('outlet-2', false).watts).toBe(0)
  })

  it('accrues the total from how long the socket has been on', () => {
    const { sim, clock } = simulator()

    sim.sample('outlet-1', true)
    clock.minutes = 60
    expect(sim.sample('outlet-1', true).kWh).toBeCloseTo(1.13, 5)

    clock.minutes = 90
    expect(sim.sample('outlet-1', true).kWh).toBeCloseTo(1.695, 5)
  })

  it('does not count the time a socket spent switched off', () => {
    const { sim, clock } = simulator()

    sim.sample('outlet-1', false)
    clock.minutes = 60
    sim.sample('outlet-1', true)
    clock.minutes = 120

    expect(sim.sample('outlet-1', true).kWh).toBeCloseTo(1.13, 5)
  })

  it('keeps the total once a socket goes off', () => {
    const { sim, clock } = simulator()

    sim.sample('outlet-1', true)
    clock.minutes = 60
    sim.sample('outlet-1', false)
    clock.minutes = 300

    const reading = sim.sample('outlet-1', false)
    expect(reading.watts).toBe(0)
    expect(reading.kWh).toBeCloseTo(1.13, 5)
  })

  it('keeps the sockets apart', () => {
    const { sim, clock } = simulator()

    sim.sample('outlet-1', true)
    sim.sample('outlet-2', false)
    clock.minutes = 60

    expect(sim.sample('outlet-1', true).kWh).toBeCloseTo(1.13, 5)
    expect(sim.sample('outlet-2', false).kWh).toBe(0)
  })

  it('works out a believable current for the voltage it claims', () => {
    const { sim } = simulator()
    const reading = sim.sample('outlet-1', true)

    expect(reading.volts).toBe(230)
    expect(reading.amps).toBeCloseTo(4.91, 2)
  })

  it('puts a total back to zero when eve asks', () => {
    const { sim, clock } = simulator()

    sim.sample('outlet-1', true)
    clock.minutes = 60
    sim.sample('outlet-1', true)
    sim.reset('outlet-1')
    clock.minutes = 90

    expect(sim.sample('outlet-1', true).kWh).toBeCloseTo(0.565, 5)
  })
})
