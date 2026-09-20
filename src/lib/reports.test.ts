import { describe, expect, it } from 'vitest'
import { anomalyKindLabel, buildReportItems, isAlertAnomaly, REPORTS_STRIP_LIMIT } from './reports'
import { makeAnomaly, makeBusHealthSignal, makeSignal, SIM01 } from '../test/factories'

describe('isAlertAnomaly', () => {
  it('alerts on bus symptoms and hostile fusion kinds, not on space weather or nominal echoes', () => {
    for (const kind of ['bus_link_margin', 'bus_safe_mode', 'rf_anomaly', 'rf_gnss_jamming', 'gnss_spoof', 'cyber_probe_burst', 'orbital_rpo_risk', 'orbital_collection_correlated']) {
      expect(isAlertAnomaly(makeAnomaly('a', { kind })), kind).toBe(true)
    }
    for (const kind of ['space_weather_storm', 'satcom_degradation', 'drone_relay_handoff', 'terrain_masking_risk']) {
      expect(isAlertAnomaly(makeAnomaly('a', { kind })), kind).toBe(false)
    }
  })
})

describe('anomalyKindLabel', () => {
  it('reads bus kinds through the event copy and hostile kinds through the table', () => {
    expect(anomalyKindLabel('bus_link_margin')).toBe('Link margin drop')
    expect(anomalyKindLabel('bus_safe_mode')).toBe('Safe mode entry')
    expect(anomalyKindLabel('bus_unexpected_reset')).toBe('Unexpected reset')
    expect(anomalyKindLabel('rf_anomaly')).toBe('RF interference')
    expect(anomalyKindLabel('some_other_kind')).toBe('Some other kind')
  })
})

describe('buildReportItems', () => {
  it('orders oldest to newest with each alert right after the signal it came from', () => {
    // Store order is newest first.
    const signals = [
      makeSignal('s3', { domain: 'space_weather', payload: { event_type: 'quiet', summary: 'quiet' } }),
      makeBusHealthSignal('s2'),
      makeSignal('s1', { domain: 'rf_ew', payload: { event_type: 'rf_interference', summary: 'rf' } }),
    ]
    const anomalies = [
      makeAnomaly('an-bus', { kind: 'bus_link_margin', source_signal: 's2', source_signal_ids: ['s2'], payload: { satellite_id: SIM01 } }),
      makeAnomaly('an-storm', { kind: 'space_weather_storm', source_signal: 's3', source_signal_ids: ['s3'] }),
      makeAnomaly('an-rf', { kind: 'rf_anomaly', source_signal: 's1', source_signal_ids: ['s1'] }),
    ]
    const items = buildReportItems(signals, anomalies)
    expect(items.map((item) => item.key)).toEqual([
      'signal:s1',
      'anomaly:an-rf',
      'signal:s2',
      'anomaly:an-bus',
      'signal:s3',
    ])
    expect(items.map((item) => item.kind)).toEqual(['report', 'alert', 'report', 'alert', 'report'])
    const bus = items.find((item) => item.key === 'anomaly:an-bus')
    expect(bus).toMatchObject({ label: 'Link margin drop', satellite: 'SIM-01', signalId: 's2', domain: 'bus_health', source: 'internal diagnosis' })
    const rf = items.find((item) => item.key === 'anomaly:an-rf')
    expect(rf).toMatchObject({ label: 'RF interference', domain: 'rf_ew', source: 'fusion' })
    const report = items.find((item) => item.key === 'signal:s2')
    expect(report).toMatchObject({ label: 'Link margin drop', satellite: 'SIM-01', severity: null })
  })

  it('appends an alert whose source signal left the buffer, at the end', () => {
    const items = buildReportItems(
      [makeSignal('s1')],
      [makeAnomaly('orphan', { kind: 'bus_link_margin', source_signal: 'gone', source_signal_ids: ['gone'] })],
    )
    expect(items.map((item) => item.key)).toEqual(['signal:s1', 'anomaly:orphan'])
    expect(items[1].signalId).toBe('gone')
  })

  it('keeps the newest N items', () => {
    const signals = Array.from({ length: 40 }, (_, index) => makeSignal(`s${39 - index}`))
    const items = buildReportItems(signals, [])
    expect(items).toHaveLength(REPORTS_STRIP_LIMIT)
    expect(items[0].key).toBe('signal:s16')
    expect(items.at(-1)?.key).toBe('signal:s39')
    expect(buildReportItems(signals, [], 5).map((item) => item.key)).toEqual(['signal:s35', 'signal:s36', 'signal:s37', 'signal:s38', 'signal:s39'])
  })

  it('is empty with nothing received', () => {
    expect(buildReportItems([], [])).toEqual([])
  })
})
