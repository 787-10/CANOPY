import armyDroneFdirRaw from '../../scenarios/army_drone_fdir.jsonl?raw'
import armyChainRaw from '../../scenarios/army_multidomain_attack_chain.jsonl?raw'
import armyRelayRaw from '../../scenarios/army_relay_reconfig.jsonl?raw'
import armySpaceRaw from '../../scenarios/army_satellite_collection_risk.jsonl?raw'
import beat1Raw from '../../scenarios/beat1.jsonl?raw'
import beat2Raw from '../../scenarios/beat2.jsonl?raw'
import beat4Raw from '../../scenarios/beat4.jsonl?raw'
import beat47Raw from '../../scenarios/beat47.jsonl?raw'
import iranC5isrRaw from '../../scenarios/iran_counter_c5isr_brigade.jsonl?raw'
import iranHormuzRaw from '../../scenarios/iran_hormuz_convoy_resilience.jsonl?raw'
import iranProxyRaw from '../../scenarios/iran_proxy_uas_base_defense.jsonl?raw'
import scenarioManifest from '../../scenarios/manifest.json'
import type { Domain, Signal } from '../types/canopy'

export type ScenarioDefinition = {
  id: string
  name: string
  shortName: string
  family: 'iran' | 'regional' | 'army'
  file: string
  theater: string
  objective: string
  domains: Domain[]
  signals: Signal[]
}

type ScenarioSeed = Omit<ScenarioDefinition, 'signals'>

type ManifestCase = {
  id: string
  file: string
  name: string
  short_name: string
  family: ScenarioDefinition['family']
  theater: string
  objective: string
  domains: Domain[]
  visibility: string[]
}

const parseSignals = (raw: string) =>
  raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Signal)

const rawByFile: Record<string, string> = {
  'army_drone_fdir.jsonl': armyDroneFdirRaw,
  'army_multidomain_attack_chain.jsonl': armyChainRaw,
  'army_relay_reconfig.jsonl': armyRelayRaw,
  'army_satellite_collection_risk.jsonl': armySpaceRaw,
  'beat1.jsonl': beat1Raw,
  'beat2.jsonl': beat2Raw,
  'beat4.jsonl': beat4Raw,
  'beat47.jsonl': beat47Raw,
  'iran_counter_c5isr_brigade.jsonl': iranC5isrRaw,
  'iran_hormuz_convoy_resilience.jsonl': iranHormuzRaw,
  'iran_proxy_uas_base_defense.jsonl': iranProxyRaw,
}

const scenarioSeeds: Array<ScenarioSeed & { raw: string }> = (
  scenarioManifest.cases as ManifestCase[]
)
  .filter((scenario) => scenario.visibility.includes('demo'))
  .map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    shortName: scenario.short_name,
    family: scenario.family,
    file: scenario.file,
    theater: scenario.theater,
    objective: scenario.objective,
    domains: scenario.domains,
    raw: rawByFile[scenario.file],
  }))

export const scenarios: ScenarioDefinition[] = scenarioSeeds.map(
  ({ raw, ...scenario }) => ({
    ...scenario,
    signals: parseSignals(raw),
  }),
)

export const defaultScenario = scenarios[0]
