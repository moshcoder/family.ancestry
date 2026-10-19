import { expect, test } from 'bun:test'
import { layout } from '../src/html.js'
import { pitFooter, setPitFooter, startPitFooterRefresh } from '../src/pit-footer.js'

test('pit.world footer: nothing until read, then the last thing in <body>', async () => {
  expect(setPitFooter('<p>not the footer</p>')).toBe(false)
  expect(pitFooter()).toBe('')
  const frag = '<style>.pit-foot{}</style><nav class="pit-foot" data-pit-footer>x</nav>'
  const stop = startPitFooterRefresh('family.ancestry', (async (url: string) => {
    expect(url).toBe('https://pit.world/snippets/footer.html?site=family.ancestry')
    return new Response(frag)
  }) as unknown as typeof fetch)
  await new Promise((r) => setTimeout(r, 10))
  stop()
  const page = layout({ user: null }, 'family.ancestry', '<p>hi</p>')
  expect(page.match(/data-pit-footer/g)?.length).toBe(1)
  expect(page).toMatch(/<\/footer>[\s\S]*data-pit-footer[\s\S]*<\/nav>\s*<\/body>/)
  // The Profullstack ring footer is server-rendered (the verifier never runs script), before the global footer, with no ad in it.
  const ring = page.indexOf('https://rssamplifier.com/ring/profullstack/next?from=https%3A%2F%2Ffamily.ancestry.pit.world%2F')
  expect(ring).toBeGreaterThan(-1)
  expect(ring).toBeLessThan(page.indexOf('data-pit-footer'))
  expect(page.slice(page.indexOf('</main>'))).not.toContain('crawlproof.com/api/ads')
  // A failed refresh keeps the last good copy.
  const stop2 = startPitFooterRefresh('family.ancestry', (async () => { throw new Error('down') }) as unknown as typeof fetch)
  await new Promise((r) => setTimeout(r, 10))
  stop2()
  expect(pitFooter()).toContain('data-pit-footer')
})
