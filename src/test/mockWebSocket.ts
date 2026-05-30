// Controllable WebSocket double for the unit suites. jsdom ships no WebSocket,
// so tests install this via `vi.stubGlobal('WebSocket', MockWebSocket)` and
// drive open/close/error/message events explicitly.
//
// close() deliberately does NOT auto-fire a 'close' event: a real close
// handshake emits 'close' asynchronously, and the hooks call close() during
// cleanup. Tests assert on the `closed` flag, or call emitClose() themselves
// when they want to exercise the close handler.
export class MockWebSocket {
  static instances: MockWebSocket[] = []
  static get last(): MockWebSocket | undefined {
    return MockWebSocket.instances.at(-1)
  }

  url: string
  closed = false
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    ;(this.listeners[type] ??= []).push(cb)
  }

  removeEventListener() {}

  close() {
    this.closed = true
  }

  emitOpen() {
    this.fire('open', {})
  }

  emitClose() {
    this.fire('close', {})
  }

  emitError() {
    this.fire('error', {})
  }

  emitMessage(data: unknown) {
    this.fire('message', {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    })
  }

  private fire(type: string, ev: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev)
  }
}
