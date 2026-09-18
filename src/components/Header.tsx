import { useEventStore } from "../store/eventStore";
import type { ViewMode } from "../types/canopy";
import { ConnectionStatus } from "./ConnectionStatus";
import { SeverityRibbon } from "./SeverityRibbon";

const VIEWS: { value: ViewMode; label: string }[] = [
  { value: "brigade", label: "Brigade" },
  { value: "operator", label: "Operator" },
];

export function Header() {
  const view = useEventStore((s) => s.view);
  const setView = useEventStore((s) => s.setView);

  return (
    <header className="app-header">
      <div className="app-header__brand">
        MEGALITH
        <span className="app-header__brand-sub">external awareness: CANOPY · internal diagnosis</span>
      </div>
      <SeverityRibbon />
      <div className="app-header__spacer" />
      <div className="view-toggle" role="tablist" aria-label="View mode">
        {VIEWS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            className={
              view === value
                ? "view-toggle__btn view-toggle__btn--active"
                : "view-toggle__btn"
            }
          >
            {label}
          </button>
        ))}
      </div>
      <ConnectionStatus />
    </header>
  );
}
