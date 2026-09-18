import { Brigade } from './pages/Brigade'
import { DemoLauncher } from './pages/DemoLauncher'
import { RunSummary } from './pages/RunSummary'
import { SignalZoom } from './pages/SignalZoom'
import { Spacecraft } from './pages/Spacecraft'
import { resolveRoute } from './lib/routes'
import { initialiseCaptureMode } from './store/captureStore'
import './App.css'

// Capture mode (fixed 1920x1080 layout) is read from `?capture=1` /
// sessionStorage before the first render.
initialiseCaptureMode()

function App() {
  const route = resolveRoute(window.location.pathname, window.location.search)

  switch (route.page) {
    case 'spacecraft':
      return <Spacecraft requestedSatellite={route.sat} />
    case 'signal':
      return <SignalZoom signalId={route.id} />
    case 'demo':
      return <DemoLauncher run={route.run} autostart={route.autostart} />
    case 'run':
      return <RunSummary />
    default:
      return <Brigade />
  }
}

export default App
