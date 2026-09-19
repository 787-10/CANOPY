import { describe, expect, it } from 'vitest'
import type { Signal } from '../types/canopy'
import { signalEffectState } from './signalEffects'

const make = (domain: Signal['domain'], eventType: string, confidence: number): Signal =>
  ({
    id: `sig-${eventType}`,
    ts: '2026-09-17T14:30:00Z',
    domain,
    source: 'test',
    realism: 'mock_operational',
    confidence,
    location: { label: 'x' },
    payload: { event_type: eventType, summary: 'test' },
    provenance: { source_id: 'test' },
  }) as unknown as Signal

describe('signalEffectState event-type tiers', () => {
  it('treats watch-tier bus and weather events as watch at low confidence', () => {
    expect(signalEffectState(make('bus_health', 'link_margin_drop', 0.5))).toBe('watch')
    expect(signalEffectState(make('bus_health', 'attitude_disturbance', 0.5))).toBe('watch')
    expect(signalEffectState(make('space_weather', 'geomagnetic_storm', 0.5))).toBe('watch')
  })

  it('treats an unexpected reset as danger at low confidence', () => {
    expect(signalEffectState(make('bus_health', 'unexpected_reset', 0.5))).toBe('danger')
  })

  it('leaves unknown event types on the legacy confidence thresholds', () => {
    expect(signalEffectState(make('osint', 'some_unknown_event', 0.5))).toBe('nominal')
    expect(signalEffectState(make('osint', 'some_unknown_event', 0.95))).toBe('danger')
  })
})
