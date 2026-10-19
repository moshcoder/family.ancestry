import { describe, expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'
import { classify, ENTITY_URL, Famous, lifespan, parseEntity, slugify, sync, when, type JsonFetch } from '../src/famous.ts'

const item = (id: string, opts: { label: string; p31?: string[]; wiki?: string | null; born?: string; died?: string; precision?: number; links?: Record<string, string[]>; description?: string }) => ({
  entities: {
    [id]: {
      id,
      labels: { en: { value: opts.label } },
      descriptions: opts.description ? { en: { value: opts.description } } : {},
      sitelinks: opts.wiki === null ? {} : { enwiki: { title: opts.wiki ?? opts.label }, dewiki: { title: opts.label } },
      claims: {
        ...(opts.p31 ? { P31: opts.p31.map((q) => ({ rank: 'normal', mainsnak: { datavalue: { value: { id: q } } } })) } : {}),
        ...(opts.born ? { P569: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: opts.born, precision: opts.precision ?? 11 } } } }] } : {}),
        ...(opts.died ? { P570: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: opts.died, precision: 11 } } } }] } : {}),
        ...Object.fromEntries(Object.entries(opts.links ?? {}).map(([p, ids]) => [p, ids.map((q) => ({ rank: 'normal', mainsnak: { datavalue: { value: { id: q } } } }))])),
      },
    },
  },
})

const LINCOLN = item('Q91', { label: 'Abraham Lincoln', description: 'President of the United States', p31: ['Q5'], born: '+1809-02-12T00:00:00Z', died: '+1865-04-15T00:00:00Z', links: { P22: ['Q2'], P26: ['Q3'], P40: ['Q4'] } })
const THOMAS = item('Q2', { label: 'Thomas Lincoln', p31: ['Q5'], born: '+1778-01-06T00:00:00Z', died: '+1851-01-17T00:00:00Z' })
const MARY = item('Q3', { label: 'Mary Todd Lincoln', p31: ['Q5'], born: '+1818-12-13T00:00:00Z', died: '+1882-07-16T00:00:00Z', links: { P26: ['Q91'] } })
const ROBERT = item('Q4', { label: 'Robert Todd Lincoln', p31: ['Q5'], wiki: null })

/** A fake EntityData endpoint: documents by id, Last-Modified per id, 304 when unchanged, redirects by id. */
function endpoint(docs: Record<string, any>, redirects: Record<string, string> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const modified: Record<string, string> = {}
  const get: JsonFetch = async (url, o = {}) => {
    calls.push({ url, headers: o.headers ?? {} })
    const qid = /\/(Q\d+)\.json$/.exec(url)![1]!
    const target = redirects[qid] ?? qid
    const doc = docs[target]
    if (!doc) throw Object.assign(new Error('404'), { status: 404 })
    const lm = (modified[target] ??= 'Fri, 16 Oct 2026 06:52:34 GMT')
    if (o.headers?.['if-modified-since'] === lm) throw Object.assign(new Error('304'), { status: 304 })
    return { url, status: 200, headers: new Headers({ 'last-modified': lm }), text: JSON.stringify(doc) }
  }
  return { get, calls, touch: (qid: string, at: string) => void (modified[qid] = at) }
}

describe('famous: parsing Wikidata', () => {
  test('classifies people, animals and companies', () => {
    expect(classify({ P31: [{ mainsnak: { datavalue: { value: { id: 'Q5' } } } }] })).toBe('human')
    expect(classify({ P31: [{ mainsnak: { datavalue: { value: { id: 'Q726' } } } }] })).toBe('animal')
    expect(classify({ P10241: [{ mainsnak: { datavalue: { value: { id: 'Q20717272' } } } }] })).toBe('animal')
    expect(classify({ P31: [{ mainsnak: { datavalue: { value: { id: 'Q4830453' } } } }] })).toBe('business')
    expect(classify({ P452: [{ mainsnak: { datavalue: { value: { id: 'Q11661' } } } }] })).toBe('business')
    expect(classify({ P31: [{ mainsnak: { datavalue: { value: { id: 'Q515' } } } }] })).toBeNull()
    expect(classify({}, 'animal')).toBe('animal')
  })

  test('reads label, article, dates and the links we follow', () => {
    const p = parseEntity(LINCOLN)!
    expect(p).toMatchObject({ qid: 'Q91', kind: 'human', label: 'Abraham Lincoln', wiki: 'Abraham Lincoln', sitelinks: 2, born: '+1809-02-12T00:00:00Z', bornPrecision: 11 })
    expect(p.links).toEqual([
      { rel: 'father', to: 'Q2' },
      { rel: 'spouse', to: 'Q3' },
      { rel: 'child', to: 'Q4' },
    ])
  })

  test('dates read to their precision; living people get the year only', () => {
    expect(when('+1809-02-12T00:00:00Z', 11)).toBe('12 February 1809')
    expect(when('+1809-02-00T00:00:00Z', 10)).toBe('February 1809')
    expect(when('+1809-00-00T00:00:00Z', 9)).toBe('1809')
    expect(when('-0100-07-12T00:00:00Z', 11)).toBe('100 BC')
    const famous = new Famous(new Store(':memory:'))
    famous.db.run("INSERT INTO famous_queue (qid, depth) VALUES ('Q9', 0)")
    famous.save(parseEntity(item('Q9', { label: 'Someone Living', p31: ['Q5'], born: '+1990-05-04T00:00:00Z' }))!, 0, null)
    expect(lifespan(famous.get('Q9')!)).toBe('born 1990')
  })

  test('slugs are plain and ascii', () => {
    expect(slugify('Hachikō')).toBe('hachiko')
    expect(slugify('Procter & Gamble')).toBe('procter-and-gamble')
    expect(slugify("Man o' War")).toBe('man-o-war')
  })
})

describe('famous: the daily sync', () => {
  test('saves an entry, queues its relatives one step out, and skips what has no English article', async () => {
    const famous = new Famous(new Store(':memory:'))
    famous.db.run("INSERT INTO famous_queue (qid, depth, hint) VALUES ('Q91', 0, 'human')")
    const api = endpoint({ Q91: LINCOLN, Q2: THOMAS, Q3: MARY, Q4: ROBERT })
    expect(await sync(famous, 'Q91', api.get)).toEqual({ result: 'saved', queued: 3 })
    expect(famous.queued().map((q) => [q.qid, q.depth])).toEqual([['Q91', 0], ['Q2', 1], ['Q3', 1], ['Q4', 1]])
    for (const q of ['Q2', 'Q3']) expect((await sync(famous, q, api.get)).result).toBe('saved')
    expect((await sync(famous, 'Q4', api.get)).result).toBe('skipped')
    expect(famous.count('human')).toBe(3)
    const r = famous.relatives(famous.get('Q91')!)
    expect(r.parents!.map((x) => x.label)).toEqual(['Thomas Lincoln'])
    expect(r.spouses!.map((x) => x.label)).toEqual(['Mary Todd Lincoln'])
    expect(r.children).toEqual([]) // Robert has no English article in this fixture, so he is not shown
    expect(famous.relatives(famous.get('Q2')!).children!.map((x) => x.label)).toEqual(['Abraham Lincoln'])
  })

  test('an unchanged entity is one conditional GET, answered 304', async () => {
    const famous = new Famous(new Store(':memory:'))
    famous.db.run("INSERT INTO famous_queue (qid, depth) VALUES ('Q2', 0)")
    const api = endpoint({ Q2: THOMAS })
    await sync(famous, 'Q2', api.get)
    expect(await sync(famous, 'Q2', api.get)).toEqual({ result: 'unchanged', queued: 0 })
    expect(api.calls[1]!.headers['if-modified-since']).toBe('Fri, 16 Oct 2026 06:52:34 GMT')
    api.touch('Q2', 'Sat, 17 Oct 2026 01:00:00 GMT')
    expect((await sync(famous, 'Q2', api.get)).result).toBe('saved')
  })

  test('a merged item is followed to the one it became', async () => {
    const famous = new Famous(new Store(':memory:'))
    famous.db.run("INSERT INTO famous_queue (qid, depth) VALUES ('Q100', 1)")
    const api = endpoint({ Q2: THOMAS }, { Q100: 'Q2' })
    expect((await sync(famous, 'Q100', api.get)).result).toBe('redirected')
    expect(famous.queued().map((q) => q.qid)).toEqual(['Q2'])
  })

  test('seeding queues every seed once', () => {
    const famous = new Famous(new Store(':memory:'))
    const n = famous.seed()
    expect(n).toBeGreaterThan(100)
    expect(famous.seed()).toBe(0)
    expect(ENTITY_URL('Q91')).toBe('https://www.wikidata.org/wiki/Special:EntityData/Q91.json')
  })
})

describe('famous: pages', () => {
  async function harness() {
    const store = new Store(':memory:')
    const famous = new Famous(store)
    for (const [q, doc] of [['Q91', LINCOLN], ['Q2', THOMAS], ['Q3', MARY]] as const) {
      famous.db.run('INSERT OR IGNORE INTO famous_queue (qid, depth) VALUES (?, 0)', [q])
      famous.save(parseEntity(doc)!, 0, null)
    }
    const auth = new Auth(store, { send: async () => {} } as any, 'https://family.ancestry')
    const app = createApp({ store, auth, site: 'https://family.ancestry', publicSite: 'https://family.ancestry.pit.world', famous })
    return { app, famous }
  }

  test('an entry page: title, family, canonical on the relay, JSON-LD, Wikipedia credit', async () => {
    const { app } = await harness()
    const res = await app.request('/famous/abraham-lincoln')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<title>Abraham Lincoln family tree: parents, spouse, children · family.ancestry</title>')
    expect(html).toContain('<link rel="canonical" href="https://family.ancestry.pit.world/famous/abraham-lincoln">')
    expect(html).toContain('href="/famous/thomas-lincoln"')
    expect(html).toContain('href="/famous/mary-todd-lincoln"')
    expect(html).toContain('"@type":"Person"')
    expect(html).toContain('"birthDate":"1809-02-12"')
    expect(html).toContain('https://en.wikipedia.org/wiki/Abraham_Lincoln')
    expect(html).toContain('Start your family tree')
    expect((await app.request('/famous/q/Q91')).headers.get('location')).toBe('/famous/abraham-lincoln')
    expect((await app.request('/famous/nobody-here')).status).toBe(404)
  })

  test('lists, search, the API, sitemap and robots', async () => {
    const { app } = await harness()
    const list = await (await app.request('/famous/people')).text()
    expect(list).toContain('Abraham Lincoln')
    expect(await (await app.request('/famous?q=todd')).text()).toContain('Mary Todd Lincoln')
    expect(await (await app.request('/famous?q=todd')).text()).not.toContain('>Thomas Lincoln<')
    const api = (await (await app.request('/api/v1/famous/abraham-lincoln')).json()) as any
    expect(api.parents[0].name).toBe('Thomas Lincoln')
    const index = await (await app.request('/sitemap.xml')).text()
    expect(index).toContain('<loc>https://family.ancestry.pit.world/sitemaps/famous-1.xml</loc>')
    expect(await (await app.request('/sitemaps/famous-1.xml')).text()).toContain('<loc>https://family.ancestry.pit.world/famous/abraham-lincoln</loc>')
    expect((await app.request('/sitemaps/famous-2.xml')).status).toBe(404)
    expect(await (await app.request('/robots.txt')).text()).toContain('Sitemap: https://family.ancestry.pit.world/sitemap.xml')
  })
})
