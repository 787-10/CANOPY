// The browser's fullscreen on the whole document, for the header's control
// (components/FullscreenButton.tsx). Kept apart from the component so the
// file exports only a component, as fast refresh wants.

/** Whether the page can go fullscreen here (the API exists and the document allows it). */
export function fullscreenAvailable(doc: Document = document): boolean {
  return typeof doc.documentElement?.requestFullscreen === 'function' && doc.fullscreenEnabled !== false
}

/** Toggle fullscreen on the document. Resolves to the new state. */
export async function toggleFullscreen(doc: Document = document): Promise<boolean> {
  if (doc.fullscreenElement) {
    await doc.exitFullscreen()
    return false
  }
  await doc.documentElement.requestFullscreen({ navigationUI: 'hide' })
  return true
}
