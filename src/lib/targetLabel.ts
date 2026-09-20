// The decide stage's `target` is free text from the model: a spacecraft
// name or URI, a subsystem, an authority node, or a run of signal ids. The
// operator sees a name where there is one and a count where there is not.
import { spacecraftDisplayName, subsystemLabel } from './commanderLanguage'

const SUBSYSTEMS = new Set(['comms', 'power', 'thermal', 'adcs', 'cdh', 'c&dh', 'payload', 'propulsion'])
const ID_TOKEN = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*-\d{3,}$/i
const KNOWN: Record<string, string> = { 'brigade-c2': 'Brigade C2' }

/** `ctb://megalith.demo/sim-01` -> `SIM-01`; `comms` -> `Comms`;
 *  `demo-link-margin-b-003, demo-link-margin-b-004` -> `2 reports`;
 *  `brigade-c2` -> `Brigade C2`; anything else as written, URIs replaced
 *  by their display names. */
export function targetLabel(target: string | null | undefined): string {
  const raw = (target ?? '').trim()
  if (!raw) return 'n/a'
  if (/^ctb:\/\/\S+$/.test(raw)) return spacecraftDisplayName(raw)
  if (SUBSYSTEMS.has(raw.toLowerCase())) return subsystemLabel(raw)
  if (KNOWN[raw.toLowerCase()]) return KNOWN[raw.toLowerCase()]
  const tokens = raw.split(/[,\s/]+/).filter(Boolean)
  if (tokens.length && tokens.every((token) => ID_TOKEN.test(token))) {
    return `${tokens.length} report${tokens.length === 1 ? '' : 's'}`
  }
  return raw.replaceAll(/ctb:\/\/\S+/g, (uri) => spacecraftDisplayName(uri))
}
