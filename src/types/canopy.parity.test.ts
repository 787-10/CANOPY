// @vitest-environment node
/// <reference types="node" />
//
// tsconfig.test.json pins an explicit `types` list without "node", so the
// reference directive above pulls in @types/node for this file only.
//
// The Domain and Action vocabularies live in canopy/services/schemas/events.py
// and are mirrored by hand in types/canopy.ts. This test reads the Python file
// from disk and checks the mirrored runtime arrays member-for-member, in
// order, so the two can't drift silently.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACTIONS, DOMAINS } from './canopy'

const EVENTS_PY = fileURLToPath(
  new URL('../../canopy/services/schemas/events.py', import.meta.url),
)

/** String members of `<name> = Literal[...]` in the Python module, in order. */
const literalMembers = (source: string, name: string): string[] => {
  const block = new RegExp(`^${name} = Literal\\[([\\s\\S]*?)\\]`, 'm').exec(
    source,
  )
  if (!block) {
    throw new Error(`no Literal named ${name} in ${EVENTS_PY}`)
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

describe('types/canopy vocabulary parity with events.py', () => {
  const source = readFileSync(EVENTS_PY, 'utf8')

  it('DOMAINS matches the Python Domain literal exactly and in order', () => {
    expect([...DOMAINS]).toEqual(literalMembers(source, 'Domain'))
  })

  it('ACTIONS matches the Python Action literal exactly and in order', () => {
    expect([...ACTIONS]).toEqual(literalMembers(source, 'Action'))
  })

  it('has no duplicate members', () => {
    expect(new Set(DOMAINS).size).toBe(DOMAINS.length)
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length)
  })
})
