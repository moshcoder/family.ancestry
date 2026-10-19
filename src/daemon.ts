/**
 * The updater daemon (@profullstack/scraper-daemon, the package every listing site runs).
 * One queue, all data in this site's SQLite (famous.ts):
 *
 *   wikidata   every famous entry, every item still to look at, and every item that was not
 *              ours: entries daily (a conditional GET, so an unchanged one is a 304), new
 *              items as soon as they are found, the not-ours monthly.
 *
 * Wikidata asks for one request at a time and a User-Agent that says who we are; the
 * fetcher keeps to that, and to robots.txt, which is why only Special:EntityData is read.
 * BullMQ on the site's own Redis (deploy/redis.sh) when REDIS_URL is set; without it the
 * local engine keeps its run records in the same SQLite file.
 */
import { createDaemon, sqliteStore } from '@profullstack/scraper-daemon'
import { ENTITY_URL, sync, type Famous } from './famous.js'
import { VERSION } from './html.js'

export const USER_AGENT = `family.ancestry/${VERSION} (+https://family.ancestry.pit.world/famous; bot@profullstack.com)`

export function buildDaemon(famous: Famous, opts: { redis?: string | null; log?: (...args: unknown[]) => void } = {}) {
  const redis = opts.redis === undefined ? process.env.REDIS_URL || null : opts.redis
  const daemon = createDaemon({
    name: 'family.ancestry',
    redis,
    ...(redis ? {} : { store: sqliteStore(famous.store.db) }),
    concurrency: 1,
    fetch: { userAgent: USER_AGENT, delayMs: Number(process.env.FAMOUS_DELAY_MS ?? 1000), timeoutMs: 30_000, maxBytes: 8_000_000 },
    ...(opts.log ? { log: opts.log } : {}),
    onStall: ({ job, lastError }: { job: string; lastError?: string | null }) => console.error(`[daemon] ${job} stalled${lastError ? `: ${lastError}` : ''}`),
  } as any)

  daemon.queue({
    name: 'wikidata',
    every: process.env.FAMOUS_EVERY ?? '1d',
    itemsEvery: '5m',
    staleAfter: '3d',
    retireAfter: 10,
    items: async () => famous.queued().map((q) => ({ key: q.qid, url: ENTITY_URL(q.qid) })),
    run: async (item, ctx) => {
      const r = await sync(famous, item.key, (url, o) => ctx.fetch.text(url, { accept: 'application/json', ...o }), ctx.signal)
      if (r.queued) daemon.refreshItems('wikidata')
      if (r.result === 'gone' || r.result === 'redirected') return { retire: true, ...r }
      if (r.result === 'skipped') return { nextIn: '30d', ...r }
      return r
    },
  })
  return daemon
}
