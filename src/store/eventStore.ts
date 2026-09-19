import { create } from "zustand";
import { isStaleRevision } from '../lib/episode'
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  Anomaly,
  Attribution,
  ConnectionStatus,
  Decision,
  KBEntry,
  OsintEmbeddingSnapshot,
  ReasoningTrace,
  Signal,
  UIEvent,
  ViewMode,
} from "../types/canopy";

const RING_BUFFER = 200;
const TRACE_BUFFER = 500;

export type ManeuverDemo = {
  /** Decision that triggered this animation. */
  decisionId: string;
  /** Wall-clock ms when the animation started (Date.now()). */
  startedAt: number;
  /** Total animation duration in ms — Cesium uses this to schedule the
   *  end of the visualization. */
  durationMs: number;
  /** Pre-burn miss distance (km) pulled from the engine's request packet. */
  preMissKm: number;
  /** Post-burn miss distance (km) — what the operator's accept achieves. */
  postMissKm: number;
  /** Δv applied (m/s). Drives the apparent magnitude of the burn vector. */
  dvMs: number;
  /** Friendly satellite name (matches an entry in the n2yo catalog). */
  friendlyLabel?: string;
  /** Hostile satellite name (matches an entry in the n2yo catalog). */
  hostileLabel?: string;
  /** Which Cesium animation runs.
   *  - `evasion`: friendly executes a plane-change burn off a shared orbit
   *    (active_defense_escort, active_defense_counterattack, default)
   *  - `strike`: friendly fires a kinetic kill vehicle on a Bezier arc
   *    that intercepts the hostile (orbital_strike_request, also fits
   *    active_defense_counterattack on offensive scenarios)
   *  - `interdiction`: friendly emits a jamming beam that breaks the
   *    hostile's link (space_link_interdiction_request, sda_tasking) */
  demoType?: 'evasion' | 'strike' | 'interdiction';
};

// Newest-first ring buffer. An item whose id is already present replaces the
// stored one (moved to the front as the newest arrival) instead of being
// added again: the engine republishes attributions, decisions and UI events
// under the same id when the reasoning lane revises a provisional verdict
// (wave 3A).
function pushBounded<T extends { id: string }>(buffer: T[], item: T): T[] {
  const rest = buffer.some((existing) => existing.id === item.id)
    ? buffer.filter((existing) => existing.id !== item.id)
    : buffer;
  const next = [item, ...rest];
  if (next.length > RING_BUFFER) next.length = RING_BUFFER;
  return next;
}

function appendBounded<T>(buffer: T[], item: T, cap: number): T[] {
  const next = [...buffer, item];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

interface EventState {
  // Per-kind ring buffers, newest first.
  signals: Signal[];
  anomalies: Anomaly[];
  attributions: Attribution[];
  decisions: Decision[];
  uiEvents: UIEvent[];

  // Reasoning trace buffer, oldest first (terminal-style: latest at bottom).
  traces: ReasoningTrace[];

  // Latest OSINT semantic-clustering snapshot (replaces wholesale on each
  // arrival — the backend sends the full sliding window every time).
  embeddingSnapshot: OsintEmbeddingSnapshot | null;

  // Lookup tables for cross-event linking.
  signalsById: Record<string, Signal>;
  attributionsById: Record<string, Attribution>;
  decisionsById: Record<string, Decision>;

  /** Client receipt time of every attribution revision, keyed by
   *  attribution id then revision: `performance.now()` when the WebSocket
   *  message was parsed. The verdict panel measures arrival-to-display from
   *  it (F3). Not persisted: it only means something for this page load. */
  attributionArrivals: Record<string, Record<number, number>>;

  // Connection + view state.
  connection: ConnectionStatus;
  view: ViewMode;
  selectedEventId: string | null;
  pendingApproval: UIEvent | null;
  approvedEventIds: Set<string>;
  /** Decision ids the operator accepted in the left-rail action panel. */
  acceptedDecisionIds: Set<string>;
  /** Decision ids the operator denied in the left-rail action panel. */
  deferredDecisionIds: Set<string>;
  /** Live maneuver-demo overlay state. When set, the Cesium globe runs
   *  the accept-action visualization (hostile approach → friendly burn
   *  → miss). Cleared automatically when the animation finishes. */
  maneuverDemo: ManeuverDemo | null;
  takeoverEvent: UIEvent | null;

  // Knowledge base resolved by id (loaded once via GET /kb).
  kb: Record<string, KBEntry>;

  // Mutators.
  ingestSignal: (signal: Signal) => void;
  ingestAnomaly: (anomaly: Anomaly) => void;
  ingestAttribution: (attribution: Attribution) => void;
  ingestDecision: (decision: Decision) => void;
  ingestUIEvent: (event: UIEvent) => void;
  ingestTrace: (trace: ReasoningTrace) => void;
  ingestEmbeddingSnapshot: (snapshot: OsintEmbeddingSnapshot) => void;
  noteAttributionArrival: (id: string, revision: number, at: number) => void;

  setConnection: (status: ConnectionStatus) => void;
  setView: (view: ViewMode) => void;
  selectEvent: (id: string | null) => void;
  dismissApproval: () => void;
  markApproved: (id: string) => void;
  acceptDecision: (id: string) => void;
  deferDecision: (id: string) => void;
  clearDecisionStatus: (id: string) => void;
  startManeuverDemo: (demo: ManeuverDemo) => void;
  endManeuverDemo: () => void;
  openTakeover: (event: UIEvent) => void;
  closeTakeover: () => void;
  setKB: (entries: KBEntry[]) => void;
  reset: () => void;
}

const initialState = (): Omit<
  EventState,
  | "ingestSignal"
  | "ingestAnomaly"
  | "ingestAttribution"
  | "ingestDecision"
  | "ingestUIEvent"
  | "ingestTrace"
  | "ingestEmbeddingSnapshot"
  | "noteAttributionArrival"
  | "setConnection"
  | "setView"
  | "selectEvent"
  | "dismissApproval"
  | "markApproved"
  | "acceptDecision"
  | "deferDecision"
  | "clearDecisionStatus"
  | "startManeuverDemo"
  | "endManeuverDemo"
  | "openTakeover"
  | "closeTakeover"
  | "setKB"
  | "reset"
> => ({
  signals: [],
  anomalies: [],
  attributions: [],
  decisions: [],
  uiEvents: [],
  traces: [],
  embeddingSnapshot: null,
  signalsById: {},
  attributionsById: {},
  decisionsById: {},
  attributionArrivals: {},
  connection: "connecting",
  view: "brigade",
  selectedEventId: null,
  pendingApproval: null,
  approvedEventIds: new Set(),
  acceptedDecisionIds: new Set(),
  deferredDecisionIds: new Set(),
  maneuverDemo: null,
  takeoverEvent: null,
  kb: {},
});

export const useEventStore = create<EventState>()(
  persist(
    (set) => ({
      ...initialState(),

      ingestSignal: (signal) =>
    set((state) => ({
      signals: pushBounded(state.signals, signal),
      signalsById: { ...state.signalsById, [signal.id]: signal },
    })),

  ingestAnomaly: (anomaly) =>
    set((state) => ({
      anomalies: pushBounded(state.anomalies, anomaly),
    })),

  ingestAttribution: (attribution) =>
    set((state) => {
      // A revision lower than the one already held for this id is stale
      // (redelivery or reordering); never let it overwrite the final.
      if (isStaleRevision(attribution, state.attributionsById[attribution.id])) {
        return {}
      }
      return {
      attributions: pushBounded(state.attributions, attribution),
      attributionsById: {
        ...state.attributionsById,
        [attribution.id]: attribution,
      },
      }
    }),

  ingestDecision: (decision) =>
    set((state) => {
      // Decision ids are stable across revisions; a redelivered lower revision
      // must not overwrite the one already held (mirrors ingestAttribution).
      const held = state.decisionsById[decision.id]
      if (held && (decision.revision ?? 0) < (held.revision ?? 0)) {
        return {}
      }
      return {
        decisions: pushBounded(state.decisions, decision),
        decisionsById: { ...state.decisionsById, [decision.id]: decision },
      }
    }),

  ingestTrace: (trace) =>
    set((state) =>
      // The same trace can be delivered twice (a reconnect, or React's
      // development-mode double effect opening two sockets); keep one.
      state.traces.some((existing) => existing.id === trace.id)
        ? {}
        : { traces: appendBounded(state.traces, trace, TRACE_BUFFER) },
    ),

  ingestEmbeddingSnapshot: (snapshot) =>
    set({ embeddingSnapshot: snapshot }),

  noteAttributionArrival: (id, revision, at) =>
    set((state) => {
      const existing = state.attributionArrivals[id] ?? {};
      // First receipt of a revision wins: a replayed message must not
      // shorten the measured arrival-to-display time.
      if (existing[revision] !== undefined) return {};
      return {
        attributionArrivals: {
          ...state.attributionArrivals,
          [id]: { ...existing, [revision]: at },
        },
      };
    }),

  ingestUIEvent: (event) =>
    set((state) => {
      const next = {
        uiEvents: pushBounded(state.uiEvents, event),
      } as Partial<EventState>;
      // Auto-pop the approve banner when a recommendation arrives, unless
      // this exact event has already been dismissed/approved.
      if (
        event.type === "recommendation_created" &&
        event.recommendation &&
        !state.approvedEventIds.has(event.id)
      ) {
        next.pendingApproval = event;
      }
      return next;
    }),

  setConnection: (connection) => set({ connection }),
  setView: (view) => set({ view }),
  selectEvent: (selectedEventId) => set({ selectedEventId }),
  dismissApproval: () => set({ pendingApproval: null }),
  markApproved: (id) =>
    set((state) => {
      const approvedEventIds = new Set(state.approvedEventIds);
      approvedEventIds.add(id);
      return {
        approvedEventIds,
        pendingApproval:
          state.pendingApproval?.id === id ? null : state.pendingApproval,
      };
    }),
  acceptDecision: (id) =>
    set((state) => {
      const acceptedDecisionIds = new Set(state.acceptedDecisionIds);
      acceptedDecisionIds.add(id);
      const deferredDecisionIds = new Set(state.deferredDecisionIds);
      deferredDecisionIds.delete(id);
      return { acceptedDecisionIds, deferredDecisionIds };
    }),
  deferDecision: (id) =>
    set((state) => {
      const deferredDecisionIds = new Set(state.deferredDecisionIds);
      deferredDecisionIds.add(id);
      const acceptedDecisionIds = new Set(state.acceptedDecisionIds);
      acceptedDecisionIds.delete(id);
      return { deferredDecisionIds, acceptedDecisionIds };
    }),
  clearDecisionStatus: (id) =>
    set((state) => {
      const acceptedDecisionIds = new Set(state.acceptedDecisionIds);
      const deferredDecisionIds = new Set(state.deferredDecisionIds);
      acceptedDecisionIds.delete(id);
      deferredDecisionIds.delete(id);
      return { acceptedDecisionIds, deferredDecisionIds };
    }),
  startManeuverDemo: (demo) => set({ maneuverDemo: demo }),
  endManeuverDemo: () => set({ maneuverDemo: null }),
  openTakeover: (event) => set({ takeoverEvent: event }),
  closeTakeover: () => set({ takeoverEvent: null }),
      setKB: (entries) =>
        set({
          kb: Object.fromEntries(entries.map((e) => [e.id, e])),
        }),
      reset: () => set(initialState()),
    }),
    {
      // Survives full-page navigations (the Brigade ↔ Operator header link
      // is a regular <a href>, so the JS state would otherwise reset on
      // every tab switch). Persisting the engine event ring buffers means
      // the reasoning panel and event timeline keep their history when
      // the user moves between pages.
      name: "canopy-event-store",
      version: 2,
      storage: createJSONStorage(() => sessionStorage),
      // Skip live UI/connection state and the Set (Sets don't survive
      // JSON.stringify cleanly). KB is fetched fresh on each mount.
      partialize: (state) => ({
        signals: state.signals,
        anomalies: state.anomalies,
        attributions: state.attributions,
        decisions: state.decisions,
        uiEvents: state.uiEvents,
        traces: state.traces,
        embeddingSnapshot: state.embeddingSnapshot,
        signalsById: state.signalsById,
        attributionsById: state.attributionsById,
        decisionsById: state.decisionsById,
      }),
    },
  ),
);
