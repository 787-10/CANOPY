import scenarioManifest from '../../scenarios/manifest.json'
import type { Domain, Signal } from '../types/canopy'

export type ScenarioDefinition = {
  id: string
  name: string
  shortName: string
  family: string
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

const scenarioModules = import.meta.glob('../../scenarios/*.jsonl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const rawByFile = Object.fromEntries(
  Object.entries(scenarioModules).map(([path, raw]) => [
    path.split('/').at(-1)!,
    raw,
  ]),
) as Record<string, string>

const scenarioSeeds: Array<ScenarioSeed & { raw: string }> = (
  scenarioManifest.cases as ManifestCase[]
)
  .filter((scenario) => scenario.visibility.includes('demo'))
  .map((scenario) => {
    const raw = rawByFile[scenario.file]
    if (raw === undefined) {
      throw new Error(
        `Scenario manifest references missing file: ${scenario.file}`,
      )
    }
    return {
      id: scenario.id,
      name: scenario.name,
      shortName: scenario.short_name,
      family: scenario.family,
      file: scenario.file,
      theater: scenario.theater,
      objective: scenario.objective,
      domains: scenario.domains,
      raw,
    }
  })

export const scenarios: ScenarioDefinition[] = scenarioSeeds.map(
  ({ raw, ...scenario }) => ({
    ...scenario,
    signals: parseSignals(raw),
  }),
)

export const defaultScenario = scenarios[0]
