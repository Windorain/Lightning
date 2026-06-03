/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest'
import { parseMobileFitEnabled } from '@/embed/mobileFitHost'

describe('mobileFitHost', () => {
  it('parseMobileFitEnabled defaults true and respects opt-out', () => {
    const el = document.createElement('div')
    expect(parseMobileFitEnabled(el)).toBe(true)
    el.setAttribute('data-wsr-mobile-fit', '0')
    expect(parseMobileFitEnabled(el)).toBe(false)
  })
})
