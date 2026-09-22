import { describe, expect, it } from 'vitest'
import { FLEET, FLEET_PRIMARY, fleetClock, fleetMember, fleetStatus } from './fleet'
import { makeAnomaly, makeBusHealthSignal, SIM01 } from '../test/factories'

describe('the fleet', () => {
  it('names the three synthetic bodies with their roles, SIM-01 the primary', () => {
    expect(FLEET.map((member) => [member.name, member.role])).toEqual([
      ['SIM-01', 'primary'],
      ['SIM-02', 'sibling'],
      ['OBJ-1', 'object'],
    ])
    expect(FLEET_PRIMARY.satelliteId).toBe('ctb://megalith.demo/sim-01')
    expect(FLEET.find((member) => member.name === 'OBJ-1')?.flightOnly).toBe(true)
    expect(fleetMember('SIM-02')?.satelliteId).toBe('ctb://megalith.demo/sim-02')
    expect(fleetMember('ctb://megalith.demo/obj-01')?.name).toBe('OBJ-1')
    expect(fleetMember('nope')).toBeNull()
  })

  it('reports quiet with nothing received, then counts reports and marks a bus symptom', () => {
    const quiet = fleetStatus([], [])
    expect(quiet.map((status) => status.state)).toEqual(['quiet', 'quiet', 'quiet'])
    expect(quiet[0]!.latest).toBeNull()
    const signals = [
      makeBusHealthSignal('bh-2', { ts: '2026-09-20T15:08:42Z' }),
      makeBusHealthSignal('bh-1', { ts: '2026-09-20T15:03:14Z', payload: { event_type: 'nominal', summary: 'nominal' } }),
    ]
    const withReports = fleetStatus(signals, [])
    expect(withReports[0]!.state).toBe('reporting')
    expect(withReports[0]!.reportCount).toBe(2)
    expect(withReports[0]!.latest?.ts).toBe('2026-09-20T15:08:42Z')
    expect(withReports[1]!.state).toBe('quiet')
    const anomaly = makeAnomaly('a1', { kind: 'bus_link_margin', payload: { satellite_id: SIM01, subsystem: 'comms' } })
    expect(fleetStatus(signals, [anomaly])[0]!.state).toBe('symptomatic')
  })

  it('prints a clock from a stamp', () => {
    expect(fleetClock('2026-09-20T15:03:14Z')).toBe('15:03:14Z')
    expect(fleetClock('nope')).toBe('nope')
  })

  it('gives the SIM pair the fleet bus and the closely-spaced object its own body', () => {
    expect(FLEET.map((member) => [member.name, member.body])).toEqual([
      ['SIM-01', 'gpm'],
      ['SIM-02', 'gpm'],
      ['OBJ-1', 'trmm'],
    ])
    expect(fleetMember('ctb://megalith.demo/obj-01')?.body).toBe('trmm')
  })
})
