import { describe, expect, it, vi } from 'vitest'
import { fullscreenAvailable, toggleFullscreen } from './fullscreen'

const fakeDocument = (initial: Element | null) => {
  const doc = {
    fullscreenElement: initial,
    fullscreenEnabled: true,
    documentElement: {
      requestFullscreen: vi.fn(async () => {
        doc.fullscreenElement = doc.documentElement as unknown as Element
      }),
    },
    exitFullscreen: vi.fn(async () => {
      doc.fullscreenElement = null
    }),
  }
  return doc as unknown as Document & { documentElement: { requestFullscreen: ReturnType<typeof vi.fn> }; exitFullscreen: ReturnType<typeof vi.fn> }
}

describe('fullscreen', () => {
  it('is unavailable where the API is missing (jsdom) and available where it exists', () => {
    expect(fullscreenAvailable(document)).toBe(false)
    expect(fullscreenAvailable(fakeDocument(null))).toBe(true)
  })

  it('enters with the navigation UI hidden, then leaves', async () => {
    const doc = fakeDocument(null)
    expect(await toggleFullscreen(doc)).toBe(true)
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' })
    expect(await toggleFullscreen(doc)).toBe(false)
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1)
  })
})
