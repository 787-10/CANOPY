import { describe, expect, it } from 'vitest'
import { targetLabel } from './targetLabel'

describe('targetLabel', () => {
  it('names spacecraft, subsystems and known nodes', () => {
    expect(targetLabel('ctb://megalith.demo/sim-01')).toBe('SIM-01')
    expect(targetLabel('SIM-01')).toBe('SIM-01')
    expect(targetLabel('comms')).toBe('Comms')
    expect(targetLabel('space-ops-c2')).toBe('Space Ops C2 (SIM)')
    expect(targetLabel('SPACE-OPS-C2')).toBe('Space Ops C2 (SIM)')
    expect(targetLabel('brigade-c2')).toBe('Brigade C2') // archived bundles
  })

  it('counts a run of signal or anomaly ids instead of printing them', () => {
    expect(targetLabel('demo-link-margin-b-003')).toBe('1 report')
    expect(targetLabel('demo-link-margin-b-003, demo-link-margin-demo-link-margin-b-004')).toBe('2 reports')
    expect(targetLabel('bus_link_margin-demo-link-margin-c-005')).toBe('1 report')
  })

  it('keeps free text, with URIs replaced by display names', () => {
    expect(targetLabel('SIM-01 S-band uplink (2035.0 MHz) via Site A ground station')).toBe('SIM-01 S-band uplink (2035.0 MHz) via Site A ground station')
    expect(targetLabel('ctb://megalith.demo/sim-01 satellite link (demo-link-margin-b-003 / demo-link-margin-b-004)')).toBe('SIM-01 satellite link (demo-link-margin-b-003 / demo-link-margin-b-004)')
    expect(targetLabel('')).toBe('n/a')
  })
})
