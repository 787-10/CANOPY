type SparklineProps = {
  /** Values oldest first, each 0..1 (physics consistency). */
  values: number[]
  /** Accessible description of the series. */
  label: string
  width?: number
  height?: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** A tiny inline SVG line over a fixed 0..1 range: no axes, the last point
 *  marked. One value draws a dot; none draws nothing. */
export function Sparkline({ values, label, width = 120, height = 28 }: SparklineProps) {
  if (!values.length) return null
  const pad = 3
  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const step = values.length > 1 ? innerW / (values.length - 1) : 0
  const points = values.map((value, index) => ({
    x: pad + (values.length > 1 ? index * step : innerW / 2),
    y: pad + (1 - clamp01(value)) * innerH,
  }))
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ')
  const last = points[points.length - 1]
  return (
    <svg
      className="mini-spark"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      data-testid="sparkline"
      data-points={values.length}
    >
      <line className="mini-spark__base" x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} />
      {values.length > 1 ? <path className="mini-spark__line" d={path} /> : null}
      <circle className="mini-spark__end" cx={last.x} cy={last.y} r={2.4} />
    </svg>
  )
}
