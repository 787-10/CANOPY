import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  commanderSignalSummary,
  plainEventName,
  signalKindLabel,
} from '../lib/commanderLanguage'
import type { Signal } from '../types/canopy'

type EventFeedProps = {
  isMapAutoFocusEnabled?: boolean
  isLive?: boolean
  onToggleMapAutoFocus?: () => void
  signals: Signal[]
  collapsed?: boolean
}

type FeedView = 'raw' | 'flow'
type FlowNodeId =
  | 'signal'
  | 'schema'
  | 'fuse'
  | 'confidence'
  | 'draft'
  | 'commander'
  | 'hold'
  | 'watch'
type FlowEdgeId =
  | 'signal-schema'
  | 'schema-fuse'
  | 'schema-hold'
  | 'fuse-confidence'
  | 'confidence-draft'
  | 'confidence-watch'
  | 'draft-commander'

type DecisionFlowFrame = {
  activeEdges: FlowEdgeId[]
  activeNode: FlowNodeId
  completedEdges: FlowEdgeId[]
  completedNodes: FlowNodeId[]
  detail: string
  headline: string
}

const RAW_SIGNAL_LIMIT = 30
const SPARKLINE_BUCKETS = 24
const ONE_MINUTE_MS = 60_000

const priorityForSignal = (signal: Signal) =>
  signal.confidence >= 0.86
    ? 'high'
    : signal.confidence >= 0.74
      ? 'watch'
      : 'low'

const signalEnvelope = (signal: Signal) => ({
  type: 'signal',
  data: signal,
})

const signalJson = (signal: Signal) =>
  JSON.stringify(signalEnvelope(signal), null, 2)

const formatTime = (ts: string, includeSeconds = false) =>
  new Date(ts).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined,
  })

const numericSignalSequence = (signal: Signal) => {
  const streamSequence = signal.payload.observables?.stream_sequence
  if (typeof streamSequence === 'number') {
    return streamSequence
  }

  const numericSuffix = signal.id.match(/(\d+)$/)?.[1]
  if (numericSuffix) {
    return Number(numericSuffix)
  }

  return signal.id
    .split('')
    .reduce((total, character) => total + character.charCodeAt(0), 0)
}

const idleDecisionFlow: DecisionFlowFrame[] = [
  {
    activeEdges: [],
    activeNode: 'signal',
    completedEdges: [],
    completedNodes: [],
    detail: 'Awaiting signal bus',
    headline: 'LLM decision flow standing by',
  },
]

const buildDummyDecisionFlow = (
  signal: Signal | undefined,
  activeDomains: number,
): DecisionFlowFrame[] => {
  if (!signal) {
    return idleDecisionFlow
  }

  const sequence = numericSignalSequence(signal)
  const schemaAccepted = sequence % 9 !== 0
  const actionThreshold = signal.domain === 'sda' ? 0.84 : 0.86
  const actionReady = signal.confidence >= actionThreshold
  const source = commanderSignalSummary(signal).sourceLabel
  const confidence = signal.confidence.toFixed(2)
  const baseDetail = `${signalKindLabel(signal)} / ${source} / confidence ${confidence}`
  const frames: DecisionFlowFrame[] = [
    {
      activeEdges: ['signal-schema'],
      activeNode: 'signal',
      completedEdges: [],
      completedNodes: [],
      detail: baseDetail,
      headline: 'LLM ingesting signal envelope',
    },
    {
      activeEdges: schemaAccepted ? ['schema-fuse'] : ['schema-hold'],
      activeNode: 'schema',
      completedEdges: ['signal-schema'],
      completedNodes: ['signal'],
      detail: schemaAccepted
        ? 'Signal contract accepted; extracting operational fields'
        : 'Schema gate needs enrichment before attribution',
      headline: schemaAccepted ? 'Schema accepted' : 'Schema needs context',
    },
  ]

  if (!schemaAccepted) {
    return [
      ...frames,
      {
        activeEdges: [],
        activeNode: 'hold',
        completedEdges: ['signal-schema', 'schema-hold'],
        completedNodes: ['signal', 'schema'],
        detail: 'Holding event while CANOPY asks for missing context',
        headline: 'LLM routes event to enrichment hold',
      },
    ]
  }

  frames.push(
    {
      activeEdges: ['fuse-confidence'],
      activeNode: 'fuse',
      completedEdges: ['signal-schema', 'schema-fuse'],
      completedNodes: ['signal', 'schema'],
      detail: `${activeDomains} active domains checked for correlation`,
      headline: 'LLM fusing cross-domain context',
    },
    {
      activeEdges: actionReady ? ['confidence-draft'] : ['confidence-watch'],
      activeNode: 'confidence',
      completedEdges: ['signal-schema', 'schema-fuse', 'fuse-confidence'],
      completedNodes: ['signal', 'schema', 'fuse'],
      detail: actionReady
        ? `Confidence clears ${actionThreshold.toFixed(2)} action threshold`
        : `Confidence below ${actionThreshold.toFixed(2)} action threshold`,
      headline: actionReady ? 'Action gate passed' : 'Action gate held',
    },
  )

  if (!actionReady) {
    return [
      ...frames,
      {
        activeEdges: [],
        activeNode: 'watch',
        completedEdges: [
          'signal-schema',
          'schema-fuse',
          'fuse-confidence',
          'confidence-watch',
        ],
        completedNodes: ['signal', 'schema', 'fuse', 'confidence'],
        detail: 'Continuing watch; no commander action generated yet',
        headline: 'LLM routes event to watch queue',
      },
    ]
  }

  return [
    ...frames,
    {
      activeEdges: ['draft-commander'],
      activeNode: 'draft',
      completedEdges: [
        'signal-schema',
        'schema-fuse',
        'fuse-confidence',
        'confidence-draft',
      ],
      completedNodes: ['signal', 'schema', 'fuse', 'confidence'],
      detail: 'Drafting recommendation packet for command review',
      headline: 'LLM drafting commander action',
    },
    {
      activeEdges: [],
      activeNode: 'commander',
      completedEdges: [
        'signal-schema',
        'schema-fuse',
        'fuse-confidence',
        'confidence-draft',
        'draft-commander',
      ],
      completedNodes: ['signal', 'schema', 'fuse', 'confidence', 'draft'],
      detail: 'Commander update is ready in the decision pane',
      headline: 'LLM decision surfaced to commander',
    },
  ]
}

const sparklineBuckets = (arrivalTimes: number[]) => {
  const now = Date.now()
  const bucketWidth = ONE_MINUTE_MS / SPARKLINE_BUCKETS
  const buckets = Array.from({ length: SPARKLINE_BUCKETS }, () => 0)

  arrivalTimes.forEach((arrivalTime) => {
    const age = now - arrivalTime
    if (age < 0 || age > ONE_MINUTE_MS) {
      return
    }

    const bucketIndex = Math.min(
      SPARKLINE_BUCKETS - 1,
      Math.floor(age / bucketWidth),
    )
    buckets[SPARKLINE_BUCKETS - 1 - bucketIndex] += 1
  })

  const peak = Math.max(1, ...buckets)
  return buckets.map((count) => Math.max(10, Math.round((count / peak) * 100)))
}

export function EventFeed({
  isMapAutoFocusEnabled = false,
  isLive = false,
  onToggleMapAutoFocus,
  signals,
  collapsed = false,
}: EventFeedProps) {
  const [activeView, setActiveView] = useState<FeedView>('raw')
  const [flowProgress, setFlowProgress] = useState<{
    signalId: string | undefined
    stepIndex: number
  }>({ signalId: undefined, stepIndex: 0 })
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null)
  const [arrivalTimes, setArrivalTimes] = useState<number[]>([])
  const arrivalTimesByIdRef = useRef<Map<string, number>>(new Map())
  const rawStreamRef = useRef<HTMLDivElement>(null)
  const latestSignal = signals[0]
  const latestSignalId = latestSignal?.id

  useEffect(() => {
    const now = Date.now()
    const signalIds = new Set(signals.map((signal) => signal.id))
    const arrivals = arrivalTimesByIdRef.current

    signals.forEach((signal) => {
      if (!arrivals.has(signal.id)) {
        arrivals.set(signal.id, now)
      }
    })

    arrivals.forEach((arrivalTime, signalId) => {
      if (now - arrivalTime > ONE_MINUTE_MS && !signalIds.has(signalId)) {
        arrivals.delete(signalId)
      }
    })

    setArrivalTimes(
      Array.from(arrivals.values()).filter(
        (arrivalTime) => now - arrivalTime <= ONE_MINUTE_MS,
      ),
    )
  }, [signals])

  useEffect(() => {
    if (activeView === 'raw') {
      rawStreamRef.current?.scrollTo({
        top: 0,
        behavior: 'smooth',
      })
    }
  }, [activeView, latestSignalId])

  const rawSignals = useMemo(
    () => signals.slice(0, RAW_SIGNAL_LIMIT),
    [signals],
  )
  const activeDomains = useMemo(
    () => new Set(signals.map((signal) => signal.domain)).size,
    [signals],
  )
  const eventRateBuckets = useMemo(
    () => sparklineBuckets(arrivalTimes),
    [arrivalTimes],
  )
  const flowFrames = useMemo(
    () => buildDummyDecisionFlow(latestSignal, activeDomains),
    [activeDomains, latestSignal],
  )

  useEffect(() => {
    if (!latestSignalId) {
      return
    }

    const timer = window.setInterval(() => {
      setFlowProgress((current) => {
        const currentStep =
          current.signalId === latestSignalId ? current.stepIndex : 0

        return {
          signalId: latestSignalId,
          stepIndex:
            currentStep >= flowFrames.length - 1
              ? currentStep
              : currentStep + 1,
        }
      })
    }, 1275)

    return () => window.clearInterval(timer)
  }, [flowFrames.length, latestSignalId])

  const feedState = latestSignal ? priorityForSignal(latestSignal) : 'idle'
  const feedStateLabel =
    feedState === 'high'
      ? 'PRIORITY'
      : feedState === 'watch'
        ? 'WATCH'
        : feedState === 'low'
          ? 'MONITOR'
          : 'IDLE'
  const flowFrame =
    flowFrames[
      Math.min(
        flowProgress.signalId === latestSignalId ? flowProgress.stepIndex : 0,
        flowFrames.length - 1,
      )
    ] ??
    idleDecisionFlow[0]
  const flowPriority = latestSignal ? priorityForSignal(latestSignal) : 'low'
  const flowHeadline = flowFrame.headline
  const flowDetail = flowFrame.detail
  const statusTone =
    activeView === 'raw'
      ? isLive
        ? 'live'
        : 'scenario'
      : activeView === 'flow'
        ? 'flow'
        : feedState
  const statusLabel =
    activeView === 'raw'
      ? isLive
        ? 'LIVE BUS'
        : 'FEED'
      : activeView === 'flow'
        ? 'FLOW'
        : feedStateLabel
  const flowShapeClass = (node: FlowNodeId, shapeClass: string) =>
    [
      'event-flow__shape',
      shapeClass,
      flowFrame.completedNodes.includes(node) ? 'is-complete' : '',
      flowFrame.activeNode === node ? 'is-active' : '',
    ]
      .filter(Boolean)
      .join(' ')
  const flowTextClass = (node: FlowNodeId, textClass = 'event-flow__text') =>
    [
      textClass,
      flowFrame.completedNodes.includes(node) ? 'is-complete' : '',
      flowFrame.activeNode === node ? 'is-active' : '',
    ]
      .filter(Boolean)
      .join(' ')
  const flowEdgeClass = (edge: FlowEdgeId, edgeClass: string) =>
    [
      'event-flow__line',
      edgeClass,
      flowFrame.completedEdges.includes(edge) ? 'is-complete' : '',
      flowFrame.activeEdges.includes(edge) ? 'is-active' : '',
    ]
      .filter(Boolean)
      .join(' ')
  const flowEdgeLabelClass = (edge: FlowEdgeId) =>
    [
      'event-flow__edge-label',
      flowFrame.completedEdges.includes(edge) ? 'is-complete' : '',
      flowFrame.activeEdges.includes(edge) ? 'is-active' : '',
    ]
      .filter(Boolean)
      .join(' ')

  return (
    <section
      className={`event-feed${collapsed ? ' event-feed--collapsed' : ''}`}
      aria-label="Incoming signals"
      aria-hidden={collapsed}
    >
      <div className="event-feed__header">
        <div>
          <span>Operational feed</span>
          <h2>Signal Stream</h2>
        </div>
        <div className="event-feed__header-actions">
          <div
            className="event-feed__tabs"
            role="tablist"
            aria-label="Signal stream view"
          >
            <button
              className={
                activeView === 'raw'
                  ? 'event-feed__tab is-active'
                  : 'event-feed__tab'
              }
              onClick={() => setActiveView('raw')}
              role="tab"
              type="button"
              aria-selected={activeView === 'raw'}
            >
              Raw Tail
            </button>
            <button
              className={
                activeView === 'flow'
                  ? 'event-feed__tab is-active'
                  : 'event-feed__tab'
              }
              onClick={() => setActiveView('flow')}
              role="tab"
              type="button"
              aria-selected={activeView === 'flow'}
            >
              Flow
            </button>
          </div>
          {onToggleMapAutoFocus ? (
            <button
              className={
                isMapAutoFocusEnabled
                  ? 'event-feed__focus-toggle is-active'
                  : 'event-feed__focus-toggle'
              }
              onClick={onToggleMapAutoFocus}
              type="button"
              aria-pressed={isMapAutoFocusEnabled}
              title="Follow high-priority map events"
            >
              Map focus
            </button>
          ) : null}
          <div className={`event-feed__status event-feed__status--${statusTone}`}>
            <span>{statusLabel}</span>
            <strong>{signals.length.toString().padStart(2, '0')}</strong>
          </div>
        </div>
      </div>

      {activeView === 'flow' ? (
        <div
          className={`event-feed__flow-view event-feed__flow-view--${flowPriority}`}
          aria-label="CANOPY decision flow"
        >
          <div className="event-feed__flow-summary">
            <span>Sense / Attribute / Decide</span>
            <strong>{flowHeadline}</strong>
            <em>{flowDetail}</em>
          </div>
          <div className="event-feed__flow-canvas">
            <svg
              className="event-feed__flow-svg"
              viewBox="0 0 1180 172"
              role="img"
              aria-label="Signal bus flows left to right through fusion, attribution, confidence gating, and commander update."
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <marker
                  id="event-flow-arrow"
                  markerHeight="8"
                  markerWidth="8"
                  orient="auto"
                  refX="7"
                  refY="4"
                  viewBox="0 0 8 8"
                >
                  <path d="M0,0 L8,4 L0,8 Z" />
                </marker>
              </defs>

              <path
                className={flowEdgeClass('signal-schema', 'event-flow__line--top')}
                d="M150 64 H180"
                markerEnd="url(#event-flow-arrow)"
              />
              <path
                className={flowEdgeClass('schema-fuse', 'event-flow__line--top')}
                d="M290 64 H340"
                markerEnd="url(#event-flow-arrow)"
              />
              <path
                className={flowEdgeClass(
                  'fuse-confidence',
                  'event-flow__line--top',
                )}
                d="M530 64 H570"
                markerEnd="url(#event-flow-arrow)"
              />
              <path
                className={flowEdgeClass(
                  'confidence-draft',
                  'event-flow__line--top',
                )}
                d="M680 64 H730"
                markerEnd="url(#event-flow-arrow)"
              />
              <path
                className={flowEdgeClass(
                  'draft-commander',
                  'event-flow__line--top',
                )}
                d="M920 64 H980"
                markerEnd="url(#event-flow-arrow)"
              />

              <path
                className={flowEdgeClass(
                  'schema-hold',
                  'event-flow__line--branch',
                )}
                d="M235 114 V145 H340"
                markerEnd="url(#event-flow-arrow)"
              />
              <path
                className={flowEdgeClass(
                  'confidence-watch',
                  'event-flow__line--branch',
                )}
                d="M625 114 V145 H730"
                markerEnd="url(#event-flow-arrow)"
              />

              <text className={flowEdgeLabelClass('schema-fuse')} x="314" y="52">
                yes
              </text>
              <text
                className={flowEdgeLabelClass('confidence-draft')}
                x="705"
                y="52"
              >
                yes
              </text>
              <text className={flowEdgeLabelClass('schema-hold')} x="246" y="134">
                no
              </text>
              <text
                className={flowEdgeLabelClass('confidence-watch')}
                x="636"
                y="134"
              >
                no
              </text>

              <ellipse
                className={flowShapeClass('signal', 'event-flow__shape--start')}
                cx="80"
                cy="64"
                rx="70"
                ry="34"
              />
              <text className={flowTextClass('signal')} x="80" y="58">
                <tspan x="80">Signal</tspan>
                <tspan x="80" dy="18">
                  bus
                </tspan>
              </text>

              <polygon
                className={flowShapeClass(
                  'schema',
                  'event-flow__shape--decision',
                )}
                points="235,14 290,64 235,114 180,64"
              />
              <text className={flowTextClass('schema')} x="235" y="58">
                <tspan x="235">Schema</tspan>
                <tspan x="235" dy="18">
                  valid?
                </tspan>
              </text>

              <rect
                className={flowShapeClass('fuse', 'event-flow__shape--step')}
                height="64"
                rx="3"
                width="190"
                x="340"
                y="32"
              />
              <text className={flowTextClass('fuse')} x="435" y="58">
                <tspan x="435">Fuse</tspan>
                <tspan x="435" dy="18">
                  domains
                </tspan>
              </text>

              <polygon
                className={flowShapeClass(
                  'confidence',
                  'event-flow__shape--decision',
                )}
                points="625,14 680,64 625,114 570,64"
              />
              <text className={flowTextClass('confidence')} x="625" y="58">
                <tspan x="625">High</tspan>
                <tspan x="625" dy="18">
                  conf?
                </tspan>
              </text>

              <rect
                className={flowShapeClass(
                  'draft',
                  'event-flow__shape--step event-flow__shape--decide',
                )}
                height="64"
                rx="3"
                width="190"
                x="730"
                y="32"
              />
              <text className={flowTextClass('draft')} x="825" y="58">
                <tspan x="825">Draft</tspan>
                <tspan x="825" dy="18">
                  action
                </tspan>
              </text>

              <ellipse
                className={flowShapeClass('commander', 'event-flow__shape--end')}
                cx="1075"
                cy="64"
                rx="95"
                ry="34"
              />
              <text className={flowTextClass('commander')} x="1075" y="58">
                <tspan x="1075">Commander</tspan>
                <tspan x="1075" dy="18">
                  update
                </tspan>
              </text>

              <rect
                className={flowShapeClass('hold', 'event-flow__shape--hold')}
                height="40"
                rx="3"
                width="190"
                x="340"
                y="124"
              />
              <text
                className={flowTextClass(
                  'hold',
                  'event-flow__text event-flow__text--muted',
                )}
                x="435"
                y="139"
              >
                <tspan x="435">Hold</tspan>
                <tspan x="435" dy="15">
                  for enrich
                </tspan>
              </text>

              <rect
                className={flowShapeClass('watch', 'event-flow__shape--hold')}
                height="40"
                rx="3"
                width="190"
                x="730"
                y="124"
              />
              <text
                className={flowTextClass(
                  'watch',
                  'event-flow__text event-flow__text--muted',
                )}
                x="825"
                y="139"
              >
                <tspan x="825">Watch</tspan>
                <tspan x="825" dy="15">
                  queue
                </tspan>
              </text>
            </svg>
          </div>
        </div>
      ) : (
        <div className="event-feed__raw-view">
          <div className="event-feed__bus-status">
            <span className="event-feed__live-dot" aria-hidden="true" />
            <span>canopy://bus</span>
            <span>signals.* topics</span>
            <span>{arrivalTimes.length} events/min</span>
            <span>{activeDomains} domains active</span>
            <strong>{isLive ? 'engine live' : 'feed'}</strong>
            <div
              className="event-feed__sparkline"
              aria-label="Event rate over the last minute"
            >
              {eventRateBuckets.map((height, index) => (
                <i
                  key={`${height}-${index}`}
                  style={{ '--bar-height': `${height}%` } as CSSProperties}
                />
              ))}
            </div>
          </div>
          <div
            className="event-feed__stream event-feed__stream--raw"
            ref={rawStreamRef}
            role="log"
            aria-label="Raw signal live tail"
            aria-live="polite"
          >
            {rawSignals.length ? (
              rawSignals.map((signal, index) => {
                const priority = priorityForSignal(signal)
                const isNewest = index === 0
                const isSelected = signal.id === selectedSignalId
                const summary = commanderSignalSummary(signal)

                return (
                  <article
                    className={`event-feed__raw-entry event-feed__raw-entry--${priority}`}
                    data-newest={isNewest ? 'true' : undefined}
                    data-domain={signal.domain}
                    key={signal.id}
                  >
                    <button
                      className="event-feed__raw-row"
                      onClick={() =>
                        setSelectedSignalId(isSelected ? null : signal.id)
                      }
                      type="button"
                      aria-expanded={isSelected}
                    >
                      <span className="event-feed__raw-time">
                        {formatTime(signal.ts, true)}
                      </span>
                      <span className="event-feed__raw-domain">
                        {signalKindLabel(signal)}
                      </span>
                      <span className="event-feed__raw-source">
                        {summary.sourceLabel}
                      </span>
                      <span className="event-feed__raw-payload">
                        {summary.oneLine}
                      </span>
                      <span className="event-feed__raw-confidence">
                        {Math.round(signal.confidence * 100)}%
                      </span>
                      <span className="event-feed__raw-event">
                        {plainEventName(signal)}
                      </span>
                    </button>
                    {isSelected ? (
                      <pre className="event-feed__raw-detail">
                        <code>{signalJson(signal)}</code>
                      </pre>
                    ) : null}
                  </article>
                )
              })
            ) : (
              <p className="event-feed__empty">
                Waiting for signal envelopes...
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
