import { describe, expect, it } from 'vitest'
import { busHealthRecords } from './busHealth'
import {
  SUBSYSTEMS,
  buildSymptomSeries,
  latestVerdictFor,
  pickSatelliteId,
  recordsForSatellite,
  recoveryState,
  subsystemStates,
} from './spacecraftHealth'
import {
  SIM01,
  makeAttribution,
  makeBusHealthSignal,
  makeDecision,
  makeSignal,
} from '../test/factories'

const nominal = makeBusHealthSignal('bh-0', {
  ts: '2026-09-17T14:20:00Z',
  payload: { event_type: 'nominal', summary: 'nominal' },
  observables: { symptom: 'link_margin_db_nominal', rate_of_change: 0, recommended_recovery: null },
})
const drop1 = makeBusHealthSignal('bh-1', {
  ts: '2026-09-17T14:32:12Z',
  observables: { rate_of_change: -0.42 },
})
const drop2 = makeBusHealthSignal('bh-2', {
  ts: '2026-09-17T14:34:12Z',
  observables: { rate_of_change: -0.5 },
})

describe('subsystemStates', () => {
  it('lists the seven spec subsystems, nominal with no records', () => {
    const states = subsystemStates([], null, null)
    expect(states.map((state) => state.subsystem)).toEqual([...SUBSYSTEMS])
    expect(states.every((state) => state.health === 'nominal')).toBe(true)
  })

  it('marks the symptomatic subsystem faulted under an internal-fault verdict', () => {
    const states = subsystemStates(
      busHealthRecords([nominal, drop1]),
      makeAttribution('a', { verdict: 'internal_fault' }),
      null,
    )
    const comms = states.find((state) => state.subsystem === 'comms')!
    expect(comms.health).toBe('faulted')
    expect(states.filter((state) => state.health !== 'nominal')).toHaveLength(1)
  })

  it('marks it degraded when the verdict is external or not yet made', () => {
    expect(
      subsystemStates(busHealthRecords([drop1]), makeAttribution('a', { verdict: 'hostile_external' }), null).find(
        (state) => state.subsystem === 'comms',
      )!.health,
    ).toBe('degraded')
    expect(
      subsystemStates(busHealthRecords([drop1]), null, null).find((state) => state.subsystem === 'comms')!
        .health,
    ).toBe('degraded')
  })

  it('marks the target of a withheld recovery withheld-recovery, whatever the verdict', () => {
    const states = subsystemStates(
      busHealthRecords([drop1]),
      makeAttribution('a', { verdict: 'hostile_external' }),
      makeDecision('d', {
        withheld_recovery: {
          action_id: 'reset_transponder_chain',
          target_subsystem: 'comms',
          reason_code: 'threat/uplink_jamming_active',
        },
      }),
    )
    const comms = states.find((state) => state.subsystem === 'comms')!
    expect(comms.health).toBe('withheld-recovery')
    expect(comms.reason).toContain('threat/uplink_jamming_active')
  })

  it('returns to nominal when the latest record for the subsystem is nominal', () => {
    const later = makeBusHealthSignal('bh-3', {
      ts: '2026-09-17T14:40:00Z',
      payload: { event_type: 'nominal', summary: 'recovered' },
    })
    const states = subsystemStates(busHealthRecords([drop1, later]), null, null)
    expect(states.find((state) => state.subsystem === 'comms')!.health).toBe('nominal')
  })
})

describe('buildSymptomSeries', () => {
  it('integrates the rate between records when no measurement is present', () => {
    const series = buildSymptomSeries(busHealthRecords([nominal, drop1, drop2]))
    expect(series.method).toBe('rate-integrated')
    expect(series.points).toHaveLength(3)
    // 0 at the first record; nominal rate 0 through 14:32:12; then -0.42 dB/s for 120 s.
    expect(series.points[0].value).toBe(0)
    expect(series.points[1].value).toBe(0)
    expect(series.points[2].value).toBeCloseTo(-0.42 * 120, 5)
    expect(series.unit).toBe('dB')
    expect(series.onsetT).toBe(Date.parse('2026-09-17T14:32:10Z'))
    expect(series.rateLabel).toBe('-0.50 dB/s')
    expect(series.min).toBeLessThan(0)
  })

  it('uses the measurement when every record carries one', () => {
    const measured = [8, 6.5, 4].map((value, index) =>
      makeBusHealthSignal(`m-${index}`, {
        ts: `2026-09-17T14:3${index}:00Z`,
        observables: { link_margin_db: value },
      }),
    )
    const series = buildSymptomSeries(busHealthRecords(measured))
    expect(series.method).toBe('measured')
    expect(series.points.map((point) => point.value)).toEqual([8, 6.5, 4])
    expect(series.unit).toBe('dB')
    expect(series.points.every((point) => point.measured)).toBe(true)
  })

  it('extends a single symptomatic record one minute so the slope is visible, and is empty with no records', () => {
    const series = buildSymptomSeries(busHealthRecords([drop1]))
    expect(series.points).toHaveLength(2)
    expect(series.points[1].value).toBeCloseTo(-0.42 * 60, 5)
    expect(buildSymptomSeries([]).method).toBe('empty')
  })
})

describe('recoveryState', () => {
  const records = busHealthRecords([drop1])

  it('is recommended when only the record carries a recovery', () => {
    const state = recoveryState(records, null)
    expect(state.phase).toBe('recommended')
    expect(state.actionId).toBe('switch_redundant_amplifier')
    expect(state.requiresApproval).toBe(true)
  })

  it('is routed when the decision is a recovery recommendation', () => {
    const state = recoveryState(
      records,
      makeDecision('d', {
        action: 'recovery_recommendation',
        authority: 'local',
        recovery: {
          action_id: 'switch_redundant_amplifier',
          target_subsystem: 'comms',
          requires_approval: true,
          rationale: 'r',
        },
      }),
    )
    expect(state.phase).toBe('routed')
    expect(state.headline).toContain('Routed as a decision')
  })

  it('is withheld with the reason when the decision carries withheld_recovery', () => {
    const state = recoveryState(
      records,
      makeDecision('d', {
        action: 'passive_defense',
        withheld_recovery: {
          action_id: 'reset_transponder_chain',
          target_subsystem: 'comms',
          reason_code: 'verdict/hostile_external',
        },
      }),
    )
    expect(state.phase).toBe('withheld')
    expect(state.reasonCode).toBe('verdict/hostile_external')
    expect(state.actionId).toBe('reset_transponder_chain')
  })

  it('is blocked when the gate republished the decision, and none without a recommendation', () => {
    const blocked = recoveryState(
      records,
      makeDecision('d', {
        action: 'threat_warning',
        rationale: '[gate:threat/uplink_jamming_active] Recovery on comms withheld while jamming is active.',
      }),
    )
    expect(blocked.phase).toBe('blocked')
    expect(blocked.reasonCode).toBe('threat/uplink_jamming_active')
    expect(blocked.rationale).toBe('Recovery on comms withheld while jamming is active.')
    expect(recoveryState(busHealthRecords([nominal]), null).phase).toBe('none')
  })
})

describe('records and verdict selection', () => {
  it('picks the requested id, else the latest bus-health record with an id', () => {
    const other = makeBusHealthSignal('o', {
      ts: '2026-09-17T15:00:00Z',
      payload: { satellite_id: 'ctb://megalith.demo/sim-02' },
    })
    const signals = [other, drop1, makeSignal('orbit-1')]
    expect(pickSatelliteId(signals, SIM01)).toBe(SIM01)
    expect(pickSatelliteId(signals, null)).toBe('ctb://megalith.demo/sim-02')
    expect(pickSatelliteId([makeSignal('x')], null)).toBeNull()
    expect(recordsForSatellite(signals, SIM01).map((record) => record.signalId)).toEqual(['bh-1'])
    expect(recordsForSatellite(signals, null)).toHaveLength(2)
  })

  it('pairs the latest attribution for the spacecraft with its decision', () => {
    const attributions = [
      makeAttribution('a-2', { satellite_id: 'ctb://megalith.demo/sim-02' }),
      makeAttribution('a-1', { satellite_id: SIM01 }),
    ]
    const decisions = [makeDecision('d-1', { attribution_id: 'a-1' })]
    const picked = latestVerdictFor(attributions, decisions, SIM01)
    expect(picked.attribution?.id).toBe('a-1')
    expect(picked.decision?.id).toBe('d-1')
    expect(latestVerdictFor(attributions, decisions, 'ctb://none').attribution).toBeNull()
  })
})
