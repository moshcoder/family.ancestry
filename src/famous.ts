/**
 * Famous families: the public half of family.ancestry, at /famous.
 *
 * Family trees of people everyone has heard of, the pedigrees of famous animals, and the
 * corporate families of well-known companies (parent, subsidiaries, founders, owners), from
 * Wikidata, which is public domain (CC0). Every entry has an English Wikipedia article: if
 * Wikipedia does not cover someone, neither do we. Nothing here touches the private trees.
 *
 * The updater daemon (daemon.ts) keeps it current: it starts from SEEDS, follows family,
 * ownership and founder links outward up to FAMOUS_MAX_DEPTH steps and FAMOUS_MAX entries,
 * and revisits every entry once a day with a conditional GET, so an unchanged entity costs a
 * 304. Only /wiki/Special:EntityData/<Q>.json is read: it is what Wikidata's robots.txt allows.
 *
 * Living people show a birth year, never a full date. Places are not shown at all.
 */
import type { Context, Hono } from 'hono'
import type { Store } from './db.js'
import { esc, layout, type Ctx } from './html.js'

export type Kind = 'human' | 'animal' | 'business'
export const KINDS: Kind[] = ['human', 'animal', 'business']

/** Where every famous page starts: resolved once from English Wikipedia titles to Wikidata ids. */
export const SEEDS: Record<Kind, string[]> = {
  human: [
    'Q91', 'Q23', 'Q11812', 'Q11806', 'Q9696', 'Q8007', 'Q33866', 'Q76', 'Q22686', 'Q207', // US presidents
    'Q9682', 'Q9439', 'Q38370', 'Q43274', 'Q7742', 'Q517', 'Q720', 'Q3044', 'Q1048', 'Q635', // rulers
    'Q40787', 'Q2677', 'Q51056', 'Q8479', 'Q36450', 'Q37979', 'Q309333', 'Q1523', 'Q8409',
    'Q937', 'Q7186', 'Q1035', 'Q254', 'Q1339', 'Q255', 'Q692', 'Q7243', 'Q5593', // science and art
    'Q303', 'Q2831', 'Q1203', 'Q40912', 'Q4616', 'Q8704', 'Q186304', 'Q36153', 'Q36107', 'Q409', 'Q42775',
    'Q8027', 'Q1001', 'Q8023', 'Q1047', 'Q160278', 'Q313721',
  ],
  animal: [
    'Q1151926', 'Q1500356', 'Q114218', 'Q1969034', 'Q2720508', 'Q19864086', 'Q379362', 'Q1203752', 'Q52720027', // racehorses
    'Q53662', 'Q186486', 'Q805807', 'Q171433', 'Q1348219', 'Q28270', 'Q7714263', 'Q201598', 'Q890911', 'Q159697',
  ],
  business: [
    'Q20800404', 'Q380', 'Q312', 'Q2283', 'Q3884', 'Q217583', 'Q483551', 'Q7414', 'Q1113804', 'Q107074885',
    'Q41187', 'Q20716', 'Q53268', 'Q156578', 'Q97439162', 'Q81965', 'Q44294', 'Q331715', 'Q157062', 'Q212405',
    'Q160746', 'Q334800', 'Q3295867', 'Q504998', 'Q931207', 'Q333718', 'Q206921', 'Q128738', 'Q478214', 'Q193701',
    'Q483915', 'Q38076', 'Q668737', 'Q18619470', 'Q19681433', 'Q695087', 'Q37156', 'Q19900', 'Q860580', 'Q1359568',
    'Q55606242', 'Q182477', 'Q76846862', 'Q1056637',
  ],
}

/** The links we follow and keep, by Wikidata property. Each is stored as written on the entity that holds it. */
export const RELS = {
  P22: 'father',
  P25: 'mother',
  P26: 'spouse',
  P40: 'child',
  P3373: 'sibling',
  P127: 'owned_by',
  P1830: 'owner_of',
  P112: 'founded_by',
  P749: 'parent_org',
  P355: 'subsidiary',
} as const
export type Rel = (typeof RELS)[keyof typeof RELS]

/** Classes that make an item a particular animal: individual animal, and the species famous ones are filed under. */
const ANIMAL_CLASSES = new Set(['Q26401003', 'Q726', 'Q144', 'Q146', 'Q7368', 'Q830', 'Q7378', 'Q39201', 'Q19939', 'Q140'])
/** Classes that make an item a company. An industry (P452) or a stock exchange listing (P414) counts too. */
const BUSINESS_CLASSES = new Set([
  'Q4830453', 'Q891723', 'Q6881511', 'Q783794', 'Q219577', 'Q1589009', 'Q161726', 'Q167037', 'Q18388277', 'Q1058914',
  'Q210167', 'Q2085381', 'Q507619', 'Q1331793', 'Q1762059', 'Q740752', 'Q786820', 'Q1137109',
])

export type Entity = {
  qid: string
  kind: Kind
  slug: string
  label: string
  description: string | null
  wiki: string
  sitelinks: number
  image: string | null
  born: string | null
  born_precision: number | null
  died: string | null
  died_precision: number | null
  depth: number
  modified: string | null
  fetched_at: number
}

export type Parsed = {
  qid: string
  kind: Kind | null
  label: string
  description: string | null
  wiki: string | null
  sitelinks: number
  image: string | null
  born: string | null
  bornPrecision: number | null
  died: string | null
  diedPrecision: number | null
  links: { rel: Rel; to: string }[]
}

const claimIds = (claims: any, p: string): string[] =>
  (claims?.[p] ?? [])
    .filter((c: any) => c?.rank !== 'deprecated')
    .map((c: any) => c?.mainsnak?.datavalue?.value?.id)
    .filter((id: unknown): id is string => typeof id === 'string' && /^Q\d+$/.test(id))

/** The best time a property gives: preferred rank first, with its precision (9 year, 10 month, 11 day). */
function claimTime(claims: any, p: string): { time: string; precision: number } | null {
  const all = (claims?.[p] ?? []).filter((c: any) => c?.rank !== 'deprecated' && c?.mainsnak?.datavalue?.value?.time)
  const best = all.find((c: any) => c.rank === 'preferred') ?? all[0]
  if (!best) return null
  const v = best.mainsnak.datavalue.value
  return { time: String(v.time), precision: Number(v.precision ?? 9) }
}

/** Which of our three kinds an item is, if any. */
export function classify(claims: any, hint?: Kind): Kind | null {
  const p31 = claimIds(claims, 'P31')
  if (p31.includes('Q5')) return 'human'
  if (p31.some((c) => ANIMAL_CLASSES.has(c)) || claimIds(claims, 'P10241').length) return 'animal'
  if (p31.some((c) => BUSINESS_CLASSES.has(c)) || claimIds(claims, 'P452').length || (claims?.P414 ?? []).length) return 'business'
  return hint ?? null
}

/** One Special:EntityData document, reduced to what the pages show. `hint` is the kind a seed was listed under. */
export function parseEntity(doc: any, hint?: Kind): Parsed | null {
  const entities = doc?.entities
  if (!entities || typeof entities !== 'object') return null
  const e: any = Object.values(entities)[0]
  if (!e || typeof e.id !== 'string' || !/^Q\d+$/.test(e.id)) return null
  const claims = e.claims ?? {}
  const born = claimTime(claims, 'P569') ?? claimTime(claims, 'P571')
  const died = claimTime(claims, 'P570') ?? claimTime(claims, 'P576')
  const image = (claims.P18 ?? [])[0]?.mainsnak?.datavalue?.value
  const links: Parsed['links'] = []
  for (const [p, rel] of Object.entries(RELS)) for (const to of claimIds(claims, p)) if (to !== e.id && !links.some((l) => l.rel === rel && l.to === to)) links.push({ rel, to })
  return {
    qid: e.id,
    kind: classify(claims, hint),
    label: e.labels?.en?.value ?? e.labels?.['en-gb']?.value ?? e.sitelinks?.enwiki?.title ?? e.id,
    description: e.descriptions?.en?.value ?? null,
    wiki: e.sitelinks?.enwiki?.title ?? null,
    sitelinks: Object.keys(e.sitelinks ?? {}).length,
    image: typeof image === 'string' ? image : null,
    born: born?.time ?? null,
    bornPrecision: born?.precision ?? null,
    died: died?.time ?? null,
    diedPrecision: died?.precision ?? null,
    links,
  }
}

export const slugify = (label: string) =>
  label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'entry'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS famous (
  qid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  wiki TEXT NOT NULL,
  sitelinks INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  born TEXT, born_precision INTEGER,
  died TEXT, died_precision INTEGER,
  depth INTEGER NOT NULL DEFAULT 0,
  modified TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS famous_kind ON famous (kind, sitelinks DESC);
CREATE TABLE IF NOT EXISTS famous_links (
  from_qid TEXT NOT NULL,
  rel TEXT NOT NULL,
  to_qid TEXT NOT NULL,
  PRIMARY KEY (from_qid, rel, to_qid)
);
CREATE INDEX IF NOT EXISTS famous_links_to ON famous_links (to_qid, rel);
-- Everything the daemon has to look at: entries, items still to fetch, and items that turned out
-- not to be ours (no English article, another kind of thing), which are checked again monthly.
CREATE TABLE IF NOT EXISTS famous_queue (
  qid TEXT PRIMARY KEY,
  depth INTEGER NOT NULL,
  hint TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  modified TEXT
);
`

const OUT_SQL = 'SELECT f.* FROM famous_links l JOIN famous f ON f.qid = l.to_qid WHERE l.from_qid = ? AND l.rel IN (SELECT value FROM json_each(?))'
const IN_SQL = 'SELECT f.* FROM famous_links l JOIN famous f ON f.qid = l.from_qid WHERE l.to_qid = ? AND l.rel IN (SELECT value FROM json_each(?))'
// ?1 kind or null, ?2 the search words as a JSON array: every one must appear in the name or description.
const LIST_COUNT_SQL =
  "SELECT count(*) n FROM famous WHERE (?1 IS NULL OR kind = ?1) AND NOT EXISTS (SELECT 1 FROM json_each(?2) w WHERE lower(label) || ' ' || lower(coalesce(description, '')) NOT LIKE '%' || w.value || '%' ESCAPE '\\')"
const LIST_ROWS_SQL =
  "SELECT * FROM famous WHERE (?1 IS NULL OR kind = ?1) AND NOT EXISTS (SELECT 1 FROM json_each(?2) w WHERE lower(label) || ' ' || lower(coalesce(description, '')) NOT LIKE '%' || w.value || '%' ESCAPE '\\') ORDER BY sitelinks DESC, label LIMIT ?3 OFFSET ?4"

export const MAX_DEPTH = Number(process.env.FAMOUS_MAX_DEPTH ?? 3)
export const MAX_ENTRIES = Number(process.env.FAMOUS_MAX ?? 40000)

export class Famous {
  constructor(
    readonly store: Store,
    private now = () => Date.now(),
  ) {
    store.db.exec(SCHEMA)
  }

  get db() {
    return this.store.db
  }

  /** Put the seeds in the queue (once each; later runs leave them alone). */
  seed(): number {
    let added = 0
    const ins = this.db.prepare("INSERT OR IGNORE INTO famous_queue (qid, depth, hint, state) VALUES (?, 0, ?, 'new')")
    for (const kind of KINDS) for (const qid of SEEDS[kind]) added += ins.run(qid, kind).changes
    return added
  }

  /** Every item the daemon tracks, with how far from a seed it is. */
  queued(): { qid: string; depth: number; hint: Kind | null; state: string; modified: string | null }[] {
    return this.db.query<any, []>('SELECT qid, depth, hint, state, modified FROM famous_queue ORDER BY depth, qid').all()
  }

  queuedOne(qid: string) {
    return this.db.query<{ qid: string; depth: number; hint: Kind | null; state: string; modified: string | null }, [string]>('SELECT qid, depth, hint, state, modified FROM famous_queue WHERE qid = ?').get(qid) ?? null
  }

  count(kind?: Kind): number {
    return kind
      ? this.db.query<{ n: number }, [string]>('SELECT count(*) n FROM famous WHERE kind = ?').get(kind)!.n
      : this.db.query<{ n: number }, []>('SELECT count(*) n FROM famous').get()!.n
  }

  get(qid: string): Entity | null {
    return this.db.query<Entity, [string]>('SELECT * FROM famous WHERE qid = ?').get(qid) ?? null
  }

  bySlug(slug: string): Entity | null {
    return this.db.query<Entity, [string]>('SELECT * FROM famous WHERE slug = ?').get(slug) ?? null
  }

  /** Nothing changed upstream since we last looked (a 304). */
  unchanged(qid: string): void {
    this.db.run('UPDATE famous SET fetched_at = ? WHERE qid = ?', [this.now(), qid])
  }

  /** Mark an item as not ours; the daemon checks it again in a month. */
  skip(qid: string, modified: string | null = null): void {
    this.db.run("UPDATE famous_queue SET state = 'skip', modified = ? WHERE qid = ?", [modified, qid])
    this.db.run('DELETE FROM famous WHERE qid = ?', [qid])
    this.db.run('DELETE FROM famous_links WHERE from_qid = ?', [qid])
  }

  /** Wikidata merged this item into another: follow it, and drop the old one. */
  redirected(from: string, to: string): void {
    const q = this.queuedOne(from)
    this.db.run('DELETE FROM famous_queue WHERE qid = ?', [from])
    this.db.run('DELETE FROM famous WHERE qid = ?', [from])
    this.db.run('DELETE FROM famous_links WHERE from_qid = ?', [from])
    this.db.run('UPDATE OR IGNORE famous_links SET to_qid = ? WHERE to_qid = ?', [to, from])
    this.db.run("INSERT OR IGNORE INTO famous_queue (qid, depth, hint, state) VALUES (?, ?, ?, 'new')", [to, q?.depth ?? MAX_DEPTH, q?.hint ?? null])
  }

  /**
   * Store a fetched item if it is ours, and queue its neighbours one step further out.
   * Returns what happened and how many new items were queued.
   */
  save(p: Parsed, depth: number, modified: string | null): { saved: boolean; queued: number } {
    if (!p.kind || !p.wiki) {
      this.skip(p.qid, modified)
      return { saved: false, queued: 0 }
    }
    const tx = this.db.transaction(() => {
      const existing = this.get(p.qid)
      const slug = existing?.slug ?? this.freeSlug(p.label, p.qid)
      this.db.run(
        `INSERT INTO famous (qid, kind, slug, label, description, wiki, sitelinks, image, born, born_precision, died, died_precision, depth, modified, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(qid) DO UPDATE SET kind = excluded.kind, label = excluded.label, description = excluded.description, wiki = excluded.wiki,
           sitelinks = excluded.sitelinks, image = excluded.image, born = excluded.born, born_precision = excluded.born_precision,
           died = excluded.died, died_precision = excluded.died_precision, depth = min(famous.depth, excluded.depth),
           modified = excluded.modified, fetched_at = excluded.fetched_at`,
        [p.qid, p.kind, slug, p.label, p.description, p.wiki, p.sitelinks, p.image, p.born, p.bornPrecision, p.died, p.diedPrecision, depth, modified, this.now()],
      )
      this.db.run('DELETE FROM famous_links WHERE from_qid = ?', [p.qid])
      const link = this.db.prepare('INSERT OR IGNORE INTO famous_links (from_qid, rel, to_qid) VALUES (?, ?, ?)')
      for (const l of p.links) link.run(p.qid, l.rel, l.to)
      this.db.run("UPDATE famous_queue SET state = 'ok', modified = ?, depth = min(depth, ?) WHERE qid = ?", [modified, depth, p.qid])
      let queued = 0
      if (depth < MAX_DEPTH && this.count() < MAX_ENTRIES) {
        const ins = this.db.prepare("INSERT OR IGNORE INTO famous_queue (qid, depth, state) VALUES (?, ?, 'new')")
        for (const l of p.links) queued += ins.run(l.to, depth + 1).changes
      }
      return queued
    })
    return { saved: true, queued: tx() }
  }

  private freeSlug(label: string, qid: string): string {
    const base = slugify(label)
    const taken = (s: string) => Boolean(this.db.query<{ qid: string }, [string]>('SELECT qid FROM famous WHERE slug = ?').get(s))
    return taken(base) ? `${base}-${qid.toLowerCase()}` : base
  }

  /** The entries linked to `qid`, in both directions, grouped the way a page shows them. */
  relatives(e: Entity): Record<string, Entity[]> {
    // Fixed SQL; the relation names go in as one JSON array.
    const out = (rels: Rel[]) => this.db.query<Entity, [string, string]>(OUT_SQL).all(e.qid, JSON.stringify(rels))
    const inn = (rels: Rel[]) => this.db.query<Entity, [string, string]>(IN_SQL).all(e.qid, JSON.stringify(rels))
    const uniq = (...lists: Entity[][]) => {
      const seen = new Map<string, Entity>()
      for (const list of lists) for (const x of list) if (x.qid !== e.qid) seen.set(x.qid, x)
      return [...seen.values()].sort((a, b) => (a.born ?? '').localeCompare(b.born ?? '') || a.label.localeCompare(b.label))
    }
    return {
      parents: uniq(out(['father', 'mother']), inn(['child'])),
      spouses: uniq(out(['spouse']), inn(['spouse'])),
      siblings: uniq(out(['sibling']), inn(['sibling'])),
      children: uniq(out(['child']), inn(['father', 'mother'])),
      owners: uniq(out(['owned_by']), inn(['owner_of'])),
      owns: uniq(out(['owner_of']), inn(['owned_by'])),
      founders: uniq(out(['founded_by'])),
      founded: uniq(inn(['founded_by'])),
      parentOrgs: uniq(out(['parent_org']), inn(['subsidiary'])),
      subsidiaries: uniq(out(['subsidiary']), inn(['parent_org'])),
    }
  }

  list(kind: Kind | null, q: string, limit: number, offset: number): { rows: Entity[]; total: number } {
    // Every word must appear in the name or the description; the words go in as one JSON array.
    const words = JSON.stringify(
      q
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .map((w) => w.replace(/[\\%_]/g, (c) => `\\${c}`)),
    )
    const total = this.db.query<{ n: number }, [string | null, string]>(LIST_COUNT_SQL).get(kind, words)!.n
    const rows = this.db.query<Entity, [string | null, string, number, number]>(LIST_ROWS_SQL).all(kind, words, limit, offset)
    return { rows, total }
  }

  slugs(limit: number, offset: number): { slug: string; fetched_at: number }[] {
    return this.db.query<{ slug: string; fetched_at: number }, [number, number]>('SELECT slug, fetched_at FROM famous ORDER BY qid LIMIT ? OFFSET ?').all(limit, offset)
  }
}

export const ENTITY_URL = (qid: string) => `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`

/** What sync() needs from a fetcher: scraper-daemon's ctx.fetch fits. */
export type JsonFetch = (url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ url: string; status: number; headers: Headers; text: string }>

/**
 * Bring one item up to date: a conditional GET, then save, skip or follow the merge.
 * A 304 (FetchError status 304 from scraper-daemon) means nothing changed.
 */
export async function sync(famous: Famous, qid: string, get: JsonFetch, signal?: AbortSignal): Promise<{ result: 'saved' | 'unchanged' | 'skipped' | 'redirected' | 'gone'; queued: number }> {
  const q = famous.queuedOne(qid)
  if (!q) return { result: 'gone', queued: 0 }
  const headers: Record<string, string> = {}
  if (q.modified && q.state !== 'new') headers['if-modified-since'] = q.modified
  let res
  try {
    res = await get(ENTITY_URL(qid), { headers, signal })
  } catch (error: any) {
    if (error?.status === 304) {
      if (q.state === 'ok') famous.unchanged(qid)
      return { result: 'unchanged', queued: 0 }
    }
    if (error?.status === 404) {
      famous.skip(qid)
      return { result: 'gone', queued: 0 }
    }
    throw error
  }
  const doc = JSON.parse(res.text)
  const id = Object.keys(doc?.entities ?? {})[0]
  if (id && id !== qid) {
    famous.redirected(qid, id)
    return { result: 'redirected', queued: 1 }
  }
  const parsed = parseEntity(doc, q.hint ?? undefined)
  if (!parsed) throw new Error(`no entity in ${ENTITY_URL(qid)}`)
  const modified = res.headers.get('last-modified')
  const r = famous.save(parsed, q.depth, modified)
  return { result: r.saved ? 'saved' : 'skipped', queued: r.queued }
}

// ---- pages ----

const KIND_PATH: Record<Kind, string> = { human: 'people', animal: 'animals', business: 'companies' }
const PATH_KIND: Record<string, Kind> = { people: 'human', animals: 'animal', companies: 'business' }
const KIND_TITLE: Record<Kind, string> = { human: 'Famous family trees', animal: 'Famous animals and their pedigrees', business: 'Corporate family trees' }
const KIND_SHORT: Record<Kind, string> = { human: 'People', animal: 'Animals', business: 'Companies' }
const PAGE = 60

/** A Wikidata time (+1809-02-12T00:00:00Z) as words, to its precision. Living people get the year only. */
export function when(time: string | null, precision: number | null, yearOnly = false): string | null {
  if (!time) return null
  const m = /^([+-])0*(\d+)-(\d\d)-(\d\d)/.exec(time)
  if (!m) return null
  const bc = m[1] === '-'
  const year = `${Number(m[2])}${bc ? ' BC' : ''}`
  const p = precision ?? 9
  if (yearOnly || p <= 9 || bc) return p < 9 ? `${Math.floor(Number(m[2]) / 100) + 1}th century${bc ? ' BC' : ''}` : year
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const month = months[Number(m[3]) - 1]
  if (!month) return year
  return p === 10 ? `${month} ${year}` : `${Number(m[4])} ${month} ${year}`
}

/** Living: a person with no death date born within the last 110 years. */
export const living = (e: Entity, now = new Date()) => {
  if (e.kind !== 'human' || e.died) return false
  const m = /^\+0*(\d+)-/.exec(e.born ?? '')
  return !m || now.getUTCFullYear() - Number(m[1]) < 110
}

export function lifespan(e: Entity): string {
  const yearOnly = living(e)
  const b = when(e.born, e.born_precision, yearOnly)
  const d = when(e.died, e.died_precision)
  if (e.kind === 'business') return [b && `founded ${b}`, d && `dissolved ${d}`].filter(Boolean).join(', ')
  if (b && d) return `${b} – ${d}`
  if (b) return `born ${b}`
  return d ? `died ${d}` : ''
}

const thumb = (file: string, width = 320) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`
const pageUrl = (e: Pick<Entity, 'slug'>) => `/famous/${e.slug}`
const wikiUrl = (e: Entity) => `https://en.wikipedia.org/wiki/${encodeURIComponent(e.wiki.replace(/ /g, '_'))}`

function card(e: Entity): string {
  const span = lifespan(e)
  return `<li class="famous-card"><a href="${esc(pageUrl(e))}">${e.image ? `<img src="${esc(thumb(e.image, 120))}" alt="" width="56" height="56" loading="lazy">` : `<span class="avatar ph" aria-hidden="true">${esc(e.label.slice(0, 1).toUpperCase())}</span>`}<span><b>${esc(e.label)}</b>${span ? `<br><span class="muted small">${esc(span)}</span>` : ''}</span></a></li>`
}

const group = (title: string, list: Entity[]) => (list.length ? `<section class="famous-group"><h2>${esc(title)}</h2><ul class="famous-cards">${list.map(card).join('')}</ul></section>` : '')

function titleFor(e: Entity): string {
  if (e.kind === 'business') return `${e.label} corporate family: parent company, subsidiaries and founders`
  if (e.kind === 'animal') return `${e.label} pedigree and family`
  return `${e.label} family tree: parents, spouse, children`
}

function descriptionFor(e: Entity, r: Record<string, Entity[]>): string {
  const names = (l: Entity[], n = 3) => l.slice(0, n).map((x) => x.label).join(', ')
  const bits: string[] = []
  if (e.kind === 'business') {
    if (r.parentOrgs!.length) bits.push(`part of ${names(r.parentOrgs!, 2)}`)
    if (r.subsidiaries!.length) bits.push(`${r.subsidiaries!.length} subsidiaries including ${names(r.subsidiaries!)}`)
    if (r.founders!.length) bits.push(`founded by ${names(r.founders!)}`)
  } else {
    if (r.parents!.length) bits.push(`${e.kind === 'animal' ? 'out of' : 'child of'} ${names(r.parents!, 2)}`)
    if (r.spouses!.length) bits.push(`married to ${names(r.spouses!, 2)}`)
    if (r.children!.length) bits.push(`${r.children!.length} ${r.children!.length === 1 ? 'child' : 'children'} including ${names(r.children!)}`)
  }
  return `${e.label}${e.description ? `, ${e.description}` : ''}${bits.length ? `: ${bits.join('; ')}.` : '.'}`.slice(0, 300)
}

function jsonLd(e: Entity, r: Record<string, Entity[]>, base: string): string {
  const ref = (x: Entity) => ({ '@type': x.kind === 'business' ? 'Organization' : x.kind === 'human' ? 'Person' : 'Thing', name: x.label, url: `${base}${pageUrl(x)}` })
  const same = [wikiUrl(e), `https://www.wikidata.org/wiki/${e.qid}`]
  const showDates = !living(e)
  const date = (t: string | null, p: number | null) => (t && showDates && (p ?? 9) >= 11 ? t.replace(/^\+/, '').slice(0, 10) : undefined)
  const doc: Record<string, unknown> =
    e.kind === 'human'
      ? {
          '@type': 'Person',
          name: e.label,
          description: e.description ?? undefined,
          birthDate: date(e.born, e.born_precision),
          deathDate: date(e.died, e.died_precision),
          parent: r.parents!.map(ref),
          spouse: r.spouses!.map(ref),
          sibling: r.siblings!.map(ref),
          children: r.children!.map(ref),
        }
      : e.kind === 'business'
        ? {
            '@type': 'Organization',
            name: e.label,
            description: e.description ?? undefined,
            foundingDate: date(e.born, e.born_precision),
            founder: r.founders!.map(ref),
            parentOrganization: r.parentOrgs!.map(ref),
            subOrganization: r.subsidiaries!.map(ref),
          }
        : { '@type': 'Thing', name: e.label, description: e.description ?? undefined }
  Object.assign(doc, { '@context': 'https://schema.org', url: `${base}${pageUrl(e)}`, sameAs: same, ...(e.image ? { image: thumb(e.image, 640) } : {}) })
  return `<script type="application/ld+json">${JSON.stringify(doc).replace(/</g, '\\u003c')}</script>`
}

/** A small tree: parents above, the entry with its partners, children below. Only for people and animals. */
function miniTree(e: Entity, r: Record<string, Entity[]>): string {
  if (e.kind === 'business' || (!r.parents!.length && !r.children!.length)) return ''
  const node = (x: Entity, me = false) => `<a class="ft-node${me ? ' me' : ''}" href="${esc(pageUrl(x))}">${esc(x.label)}<small>${esc(lifespan(x))}</small></a>`
  return `<div class="famous-tree" aria-label="Family tree">
${r.parents!.length ? `<div class="ft-row">${r.parents!.map((x) => node(x)).join('')}</div><div class="ft-line"></div>` : ''}
<div class="ft-row">${node(e, true)}${r.spouses!.slice(0, 3).map((x) => node(x)).join('')}</div>
${r.children!.length ? `<div class="ft-line"></div><div class="ft-row">${r.children!.slice(0, 12).map((x) => node(x)).join('')}</div>` : ''}
</div>`
}

export function entityPage(ctx: Ctx, e: Entity, r: Record<string, Entity[]>, base: string): string {
  const url = `${base}${pageUrl(e)}`
  const description = descriptionFor(e, r)
  const head = `
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${e.kind === 'human' ? 'profile' : 'website'}">
<meta property="og:title" content="${esc(titleFor(e))}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">${e.image ? `\n<meta property="og:image" content="${esc(thumb(e.image, 640))}">` : ''}
${jsonLd(e, r, base)}`
  const isAnimal = e.kind === 'animal'
  const groups =
    e.kind === 'business'
      ? group('Parent company', r.parentOrgs!) +
        group('Subsidiaries', r.subsidiaries!) +
        group('Founded by', r.founders!) +
        group('Owned by', r.owners!.filter((x) => !r.parentOrgs!.some((p) => p.qid === x.qid))) +
        group('Owns', r.owns!.filter((x) => !r.subsidiaries!.some((s) => s.qid === x.qid)))
      : group(isAnimal ? 'Sire and dam' : 'Parents', r.parents!) +
        group(isAnimal ? 'Mates' : 'Spouses and partners', r.spouses!) +
        group('Siblings', r.siblings!) +
        group(isAnimal ? 'Offspring' : 'Children', r.children!) +
        group(isAnimal ? 'Owner' : 'Owned by', r.owners!) +
        group('Owns', r.owns!) +
        group('Founded', r.founded!)
  const span = lifespan(e)
  return layout(
    ctx,
    titleFor(e),
    `<article class="famous">
<header class="famous-head">${e.image ? `<img src="${esc(thumb(e.image))}" alt="${esc(e.label)}" width="160" loading="lazy">` : ''}<div>
<p class="kicker">${esc(KIND_SHORT[e.kind])}</p>
<h1>${esc(e.label)}</h1>
${e.description ? `<p class="lede">${esc(e.description)}</p>` : ''}${span ? `<p class="muted">${esc(span)}</p>` : ''}
</div></header>
${miniTree(e, r)}
${groups || '<p class="empty">No relatives on file yet. They appear as the daily update finds them.</p>'}
<p class="muted small">From <a href="${esc(wikiUrl(e))}" rel="noopener">Wikipedia</a> and <a href="https://www.wikidata.org/wiki/${esc(e.qid)}" rel="noopener">Wikidata</a> (public domain), updated daily.</p>
<aside class="famous-cta"><h2>Your own family is just as interesting.</h2><p>Build a private family tree with the people in it: invite them, add photos and stories, import a GEDCOM. Nobody outside the family sees it.</p><a class="btn" href="/signup">Start your family tree</a></aside>
</article>`,
    { crumbs: [['/famous', 'Famous'], [`/famous/${KIND_PATH[e.kind]}`, KIND_SHORT[e.kind]], ['', e.label]], head, description },
  )
}

export function listPage(ctx: Ctx, kind: Kind | null, q: string, page: number, data: { rows: Entity[]; total: number }, counts: Record<Kind, number>, base: string): string {
  const path = kind ? `/famous/${KIND_PATH[kind]}` : '/famous'
  const title = kind ? KIND_TITLE[kind] : 'Famous families: people, animals and companies'
  const pages = Math.max(1, Math.ceil(data.total / PAGE))
  const link = (p: number) => `${path}?${new URLSearchParams({ ...(q ? { q } : {}), ...(p > 1 ? { page: String(p) } : {}) })}`.replace(/\?$/, '')
  const nav =
    pages > 1
      ? `<nav class="pager">${page > 1 ? `<a href="${esc(link(page - 1))}" rel="prev">← Previous</a>` : ''}<span class="muted">Page ${page} of ${pages}</span>${page < pages ? `<a href="${esc(link(page + 1))}" rel="next">Next →</a>` : ''}</nav>`
      : ''
  const tabs = `<nav class="famous-tabs"><a href="/famous"${kind ? '' : ' aria-current="page"'}>All</a>${KINDS.map((k) => `<a href="/famous/${KIND_PATH[k]}"${k === kind ? ' aria-current="page"' : ''}>${KIND_SHORT[k]} <span class="muted">${counts[k].toLocaleString('en-US')}</span></a>`).join('')}</nav>`
  const head = `\n<link rel="canonical" href="${esc(`${base}${page > 1 && !q ? link(page) : path}`)}">${q ? '\n<meta name="robots" content="noindex">' : ''}`
  return layout(
    ctx,
    title,
    `<h1>${esc(title)}</h1>
<p class="muted">Family trees of people everyone has heard of, the pedigrees of famous animals and who owns which company, from Wikipedia and Wikidata, updated every day.</p>
${tabs}
<form class="search" method="get" action="${esc(path)}" role="search"><input type="search" name="q" value="${esc(q)}" placeholder="${kind === 'business' ? 'A company' : kind === 'animal' ? 'A horse, a dog…' : 'A name'}" aria-label="Search"><button>Search</button></form>
<p class="muted small">${data.total.toLocaleString('en-US')} ${data.total === 1 ? 'entry' : 'entries'}</p>
${data.rows.length ? `<ul class="famous-cards">${data.rows.map(card).join('')}</ul>` : '<p class="empty">Nothing here yet. The daily update is still finding them.</p>'}
${nav}`,
    { crumbs: kind ? [['/famous', 'Famous'], ['', KIND_SHORT[kind]]] : [['', 'Famous']], head, wide: true, description: 'Family trees of famous people, pedigrees of famous animals and corporate family trees of well-known companies. Free, updated daily from Wikipedia and Wikidata.' },
  )
}

const SITEMAP_CHUNK = 10000

export type FamousDeps = { famous: Famous; ctx: (c: Context) => Ctx; site: string; status?: () => Promise<unknown> }

export function mountFamous(app: Hono<any>, api: Hono<any>, d: FamousDeps) {
  const { famous, site } = d
  const counts = () => Object.fromEntries(KINDS.map((k) => [k, famous.count(k)])) as Record<Kind, number>
  const pageNo = (c: Context) => Math.max(1, Math.min(10_000, Number.parseInt(c.req.query('page') ?? '1', 10) || 1))

  const list = (kind: Kind | null) => (c: Context) => {
    const q = String(c.req.query('q') ?? '').slice(0, 100)
    const page = pageNo(c)
    return c.html(listPage(d.ctx(c), kind, q, page, famous.list(kind, q, PAGE, (page - 1) * PAGE), counts(), site))
  }
  app.get('/famous', list(null))
  for (const [path, kind] of Object.entries(PATH_KIND)) app.get(`/famous/${path}`, list(kind))

  app.get('/famous/q/:qid', (c) => {
    const e = famous.get(c.req.param('qid').toUpperCase())
    return e ? c.redirect(pageUrl(e), 301) : c.notFound()
  })
  app.get('/famous/:slug', (c) => {
    const e = famous.bySlug(c.req.param('slug'))
    if (!e) return c.html(layout(d.ctx(c), 'Not found', '<h1>Not found</h1><p>Nobody famous by that name here. <a href="/famous">Search the famous families</a>.</p>'), 404)
    c.header('cache-control', 'public, max-age=3600')
    return c.html(entityPage(d.ctx(c), e, famous.relatives(e), site))
  })

  app.get('/sitemap.xml', (c) => {
    const chunks = Math.ceil(famous.count() / SITEMAP_CHUNK)
    const entries = [`${site}/sitemaps/pages.xml`, ...Array.from({ length: chunks }, (_, i) => `${site}/sitemaps/famous-${i + 1}.xml`)]
    c.header('content-type', 'application/xml; charset=utf-8')
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map((u) => `<sitemap><loc>${esc(u)}</loc></sitemap>`).join('')}</sitemapindex>\n`)
  })
  app.get('/sitemaps/pages.xml', (c) => {
    const paths = ['/', '/about', '/people', '/families', '/famous', ...KINDS.map((k) => `/famous/${KIND_PATH[k]}`)]
    c.header('content-type', 'application/xml; charset=utf-8')
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${esc(`${site}${p}`)}</loc></url>`).join('')}</urlset>\n`)
  })
  app.get('/sitemaps/:file{famous-[0-9]+\\.xml}', (c) => {
    const n = Number(/(\d+)/.exec(c.req.param('file'))![1])
    const rows = famous.slugs(SITEMAP_CHUNK, (n - 1) * SITEMAP_CHUNK)
    if (!rows.length) return c.notFound()
    c.header('content-type', 'application/xml; charset=utf-8')
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map((r) => `<url><loc>${esc(`${site}/famous/${r.slug}`)}</loc><lastmod>${new Date(r.fetched_at).toISOString().slice(0, 10)}</lastmod></url>`).join('')}</urlset>\n`,
    )
  })
  app.get('/robots.txt', (c) => c.text(`User-agent: *\nDisallow: /t/\nDisallow: /settings\nDisallow: /inbox\nDisallow: /auth/\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`))

  api.get('/famous', (c) => {
    const kind = PATH_KIND[String(c.req.query('kind') ?? '')] ?? (KINDS.includes(c.req.query('kind') as Kind) ? (c.req.query('kind') as Kind) : null)
    const q = String(c.req.query('q') ?? '').slice(0, 100)
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50))
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    const r = famous.list(kind, q, limit, offset)
    return c.json({ total: r.total, entries: r.rows.map((e) => ({ qid: e.qid, kind: e.kind, name: e.label, description: e.description, url: `${site}${pageUrl(e)}` })) })
  })
  api.get('/famous/:slug', (c) => {
    const e = famous.bySlug(c.req.param('slug')) ?? famous.get(c.req.param('slug').toUpperCase())
    if (!e) return c.json({ error: 'not found' }, 404)
    const r = famous.relatives(e)
    const brief = (x: Entity) => ({ qid: x.qid, name: x.label, url: `${site}${pageUrl(x)}` })
    return c.json({
      qid: e.qid,
      kind: e.kind,
      name: e.label,
      description: e.description,
      lifespan: lifespan(e),
      wikipedia: wikiUrl(e),
      url: `${site}${pageUrl(e)}`,
      ...Object.fromEntries(Object.entries(r).filter(([, l]) => l.length).map(([k, l]) => [k, l.map(brief)])),
    })
  })
  if (d.status) api.get('/daemon', async (c) => c.json(await d.status!()))
}
