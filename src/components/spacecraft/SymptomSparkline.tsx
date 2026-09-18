import type { SymptomSeries } from '../../lib/spacecraftHealth'

const W = 640
const H = 180
const PAD = { top: 18, right: 24, bottom: 28, left: 52 }

const formatClock = (t: number) => new Date(t).toISOString().slice(11, 19) + 'Z'

const formatValue = (value: number) => {
  const magnitude = Math.abs(value)
  if (magnitude >= 100) return value.toFixed(0)
  if (magnitude >= 1) return value.toFixed(1)
  return value.toFixed(2)
}

type SymptomSparklineProps = {
  series: SymptomSeries
  /** Symptom name for the caption, e.g. `link margin db drop`. */
  symptomLabel: string
}

/** The symptom measurement over time: the observable when the records carry
 *  one, else the rate-integrated change. Onset marker and the latest rate. */
export function SymptomSparkline({ series, symptomLabel }: SymptomSparklineProps) {
  if (series.method === 'empty' || series.points.length === 0) {
    return (
      <div className="sparkline sparkline--empty" data-testid="symptom-sparkline" data-method="empty">
        No bus-health records for this spacecraft yet.
      </div>
    )
  }

  const t0 = series.points[0].t
  const t1 = Math.max(series.points[series.points.length - 1].t, series.onsetT ?? t0)
  const span = Math.max(t1 - t0, 1)
  const range = series.max - series.min
  const yMin = range === 0 ? series.min - 1 : series.min - range * 0.15
  const yMax = range === 0 ? series.max + 1 : series.max + range * 0.15
  const x = (t: number) => PAD.left + ((t - t0) / span) * (W - PAD.left - PAD.right)
  const y = (value: number) =>
    PAD.top + (1 - (value - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom)

  const path = series.points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`)
    .join(' ')
  const baseline = y(yMin)
  const area = `${path} L${x(series.points[series.points.length - 1].t).toFixed(1)},${baseline} L${x(t0).toFixed(1)},${baseline} Z`
  const last = series.points[series.points.length - 1]
  const onsetX = series.onsetT !== null ? x(Math.min(Math.max(series.onsetT, t0), t1)) : null
  const unit = series.unit ? ` ${series.unit}` : ''

  return (
    <figure
      className="sparkline"
      data-testid="symptom-sparkline"
      data-method={series.method}
      data-points={series.points.length}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${symptomLabel} over time`}>
        <line x1={PAD.left} x2={W - PAD.right} y1={baseline} y2={baseline} className="sparkline__axis" />
        <text x={PAD.left - 6} y={y(series.max) + 4} textAnchor="end" className="sparkline__tick">
          {formatValue(series.max)}
          {unit}
        </text>
        <text x={PAD.left - 6} y={y(series.min) + 4} textAnchor="end" className="sparkline__tick">
          {formatValue(series.min)}
          {unit}
        </text>
        <path d={area} className="sparkline__area" />
        <path d={path} className="sparkline__line" />
        {series.points.map((point) => (
          <circle
            key={`${point.t}-${point.record.signalId}`}
            cx={x(point.t)}
            cy={y(point.value)}
            r={point.record.isNominal ? 2.2 : 3.2}
            className={`sparkline__point${point.record.isNominal ? '' : ' sparkline__point--symptom'}`}
          >
            <title>
              {formatClock(point.t)} · {point.record.eventLabel} · {formatValue(point.value)}
              {unit}
              {point.record.rateLabel ? ` · ${point.record.rateLabel}` : ''}
            </title>
          </circle>
        ))}
        <circle cx={x(last.t)} cy={y(last.value)} r={5} className="sparkline__end" />
        {onsetX !== null ? (
          <g className="sparkline__onset" data-testid="sparkline-onset">
            <line x1={onsetX} x2={onsetX} y1={PAD.top - 6} y2={baseline} />
            <text x={onsetX + 5} y={PAD.top + 4}>onset {formatClock(series.onsetT!)}</text>
          </g>
        ) : null}
        <text x={PAD.left} y={H - 8} className="sparkline__tick">
          {formatClock(t0)}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" className="sparkline__tick">
          {formatClock(t1)}
        </text>
      </svg>
      <figcaption className="sparkline__caption">
        <span>{symptomLabel}</span>
        <span data-testid="sparkline-rate">
          {series.rateLabel ? `rate ${series.rateLabel}` : 'rate not stated'}
        </span>
        <span className="sparkline__method">
          {series.method === 'measured' ? 'measured value' : 'rate-integrated change'}
        </span>
      </figcaption>
    </figure>
  )
}
