import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmount anything rendered via RTL between tests so renderHook/render in one
// test can't leak DOM or effect state into the next.
afterEach(() => {
  cleanup()
})
