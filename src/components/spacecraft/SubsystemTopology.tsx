import { subsystemLabel } from '../../lib/commanderLanguage'
import {
  HEALTH_LABEL,
  type Subsystem,
  type SubsystemHealth,
  type SubsystemState,
} from '../../lib/spacecraftHealth'

// Fixed layout: C&DH is the hub the others hang off; power feeds thermal and
// comms feeds payload, the two couplings a bus-health symptom most often
// crosses. Coordinates are in a 640x300 viewBox.
const POSITION: Record<Subsystem, [number, number]> = {
  cdh: [320, 150],
  power: [120, 80],
  thermal: [120, 220],
  comms: [520, 80],
  payload: [520, 220],
  adcs: [320, 40],
  propulsion: [320, 262],
}

const EDGES: Array<[Subsystem, Subsystem]> = [
  ['cdh', 'power'],
  ['cdh', 'thermal'],
  ['cdh', 'comms'],
  ['cdh', 'payload'],
  ['cdh', 'adcs'],
  ['cdh', 'propulsion'],
  ['power', 'thermal'],
  ['comms', 'payload'],
]

type SubsystemTopologyProps = {
  states: SubsystemState[]
  /** Spacecraft name for the accessible label. */
  name: string
}

/** Seven-node subsystem topology with health state from bus-health records. */
export function SubsystemTopology({ states, name }: SubsystemTopologyProps) {
  const byId = new Map(states.map((state) => [state.subsystem, state]))
  return (
    <figure className="topology" data-testid="subsystem-topology">
      <svg
        viewBox="0 0 640 300"
        width="100%"
        role="img"
        aria-label={`${name} subsystem topology`}
        className="topology__svg"
      >
        {EDGES.map(([from, to]) => {
          const a = POSITION[from]
          const b = POSITION[to]
          const stressed =
            byId.get(from)?.health !== 'nominal' || byId.get(to)?.health !== 'nominal'
          return (
            <line
              key={`${from}-${to}`}
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              className={`topology__edge${stressed ? ' topology__edge--stressed' : ''}`}
            />
          )
        })}
        {states.map((state) => {
          const [x, y] = POSITION[state.subsystem]
          const active = state.health !== 'nominal'
          return (
            <g
              key={state.subsystem}
              className={`topology__node topology__node--${state.health}`}
              data-subsystem={state.subsystem}
              data-health={state.health}
              data-testid={`topology-${state.subsystem}`}
            >
              <title>
                {subsystemLabel(state.subsystem)}: {HEALTH_LABEL[state.health]} ({state.reason})
              </title>
              {state.health === 'withheld-recovery' ? (
                <circle cx={x} cy={y} r={20} className="topology__halo" />
              ) : null}
              <circle cx={x} cy={y} r={active ? 13 : 10} className="topology__ring" />
              {active ? <circle cx={x} cy={y} r={4.5} className="topology__core" /> : null}
              <text x={x} y={y - (active ? 20 : 17)} textAnchor="middle" className="topology__label">
                {subsystemLabel(state.subsystem)}
              </text>
              <text x={x} y={y + (active ? 30 : 26)} textAnchor="middle" className="topology__state">
                {HEALTH_LABEL[state.health].toLowerCase()}
              </text>
            </g>
          )
        })}
      </svg>
      <figcaption className="topology__legend">
        {(Object.keys(HEALTH_LABEL) as SubsystemHealth[]).map((health) => (
          <span key={health} className={`topology__legend-item topology__legend-item--${health}`}>
            <i aria-hidden="true" /> {HEALTH_LABEL[health]}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
