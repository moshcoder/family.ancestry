/**
 * Public profiles: one page you can hand anyone, at /profile/anthony.ettinger
 * (family.tree/profile/… redirects here too), and "Find people" at /people.
 *
 * A profile holds only what its owner typed into it: a name, where they live and
 * where they are from, a few lines, links and socials, and an email only if they
 * put one there. It never reads the trees. Birth dates, birthplaces, parents,
 * relatives, street addresses and phone numbers are the answers to security
 * questions, so there is no field for them and nothing here can reach them.
 * Off until the owner turns it on; free, like everything in /people.
 *
 * /people is one search over the three public things: published profiles, listed
 * businesses and listed families, narrowed by facets (kind, country, state, city,
 * category) the way r4ck.dev narrows servers. Every facet is a link with a count.
 */
import type { Context, Hono } from 'hono'
import { clean, fullName, type Person, type Store, type User } from './db.js'
import { csrfField, esc, layout, type Ctx } from './html.js'
import { formatLabeled, parseLinks, parseLabeled, socialUrl, type Labeled } from './contact.js'
import { sniffImage } from './album.js'
import { validEmail } from './auth.js'
import type { Listings } from './listing.js'
import type { Teams } from './team.js'

export type Profile = {
  user_id: string
  slug: string
  published: number
  indexable: number
  name: string
  nickname: string | null
  city: string | null
  region: string | null
  country: string | null
  hometown: string | null
  bio: string | null
  email: string | null
  links: Labeled[]
  socials: Labeled[]
  photo_mime: string | null
  created_at: number
  updated_at: number
}

type Row = Omit<Profile, 'links' | 'socials'> & { links: string | null; socials: string | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS public_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE, published INTEGER NOT NULL DEFAULT 0, indexable INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL, nickname TEXT, city TEXT, region TEXT, country TEXT, hometown TEXT, bio TEXT, email TEXT,
  links TEXT, socials TEXT, photo BLOB, photo_mime TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS public_profiles_published ON public_profiles(published, name);
`

const MAX_PHOTO = 8 * 1024 * 1024
/** First path words of the site, and words that would read as ours. */
const RESERVED = new Set(['admin', 'api', 'edit', 'me', 'new', 'people', 'profile', 'profiles', 'settings', 'search', 'family', 'familyancestry', 'support', 'help', 'about', 'root', 'www'])

/** "Anthony Ettinger", "Los Gatos" → "anthony.ettinger", "los.gatos": lower case, accents dropped, words joined by dots. */
export function slugify(...parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .replace(/\.+$/, '')
}

/** a-z, 0-9, and single dots or dashes between them; 3 to 80 long. */
export function validSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 80 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(slug) && !RESERVED.has(slug)
}

const read = (r: Row | null | undefined): Profile | null => (r ? { ...r, links: r.links ? JSON.parse(r.links) : [], socials: r.socials ? JSON.parse(r.socials) : [] } : null)

/** "Los Gatos, CA, USA" from whichever of the three are given. */
export const placeOf = (p: Pick<Profile, 'city' | 'region' | 'country'>) => [p.city, p.region, p.country].filter(Boolean).join(', ')

export class Profiles {
  constructor(
    readonly store: Store,
    private now = () => Date.now(),
  ) {
    store.db.exec(SCHEMA)
  }

  mine(userId: string): Profile | null {
    return read(this.store.db.query<Row, [string]>('SELECT user_id, slug, published, indexable, name, nickname, city, region, country, hometown, bio, email, links, socials, photo_mime, created_at, updated_at FROM public_profiles WHERE user_id = ?').get(userId))
  }

  /** A published profile, or null: an unpublished one does not exist to anyone but its owner. */
  bySlug(slug: string): Profile | null {
    return read(this.store.db.query<Row, [string]>('SELECT user_id, slug, published, indexable, name, nickname, city, region, country, hometown, bio, email, links, socials, photo_mime, created_at, updated_at FROM public_profiles WHERE slug = ? AND published = 1').get(slug.toLowerCase()))
  }

  taken(slug: string, userId: string | null = null): boolean {
    const row = this.store.db.query<{ user_id: string }, [string]>('SELECT user_id FROM public_profiles WHERE slug = ?').get(slug)
    return Boolean(row && row.user_id !== userId)
  }

  /** anthony.ettinger if it is free; then with the town, then the state, then a number. */
  suggest(userId: string, name: string, place: { city?: string | null; region?: string | null; country?: string | null } = {}): string {
    const base = slugify(name) || 'member'
    const tries = [base, slugify(base, place.city), slugify(base, place.city, place.region), slugify(base, place.city, place.region, place.country)]
    for (const s of tries) if (validSlug(s) && !this.taken(s, userId)) return s
    for (let n = 2; ; n++) if (!this.taken(`${base}.${n}`, userId) && validSlug(`${base}.${n}`)) return `${base}.${n}`
  }

  /**
   * What the form starts with before there is a profile: the account's own name. A person
   * claimed in a tree lends only a nickname, and only when they carry that same name: a
   * claim can be wrong (an account claimed as a relative), and must never put a relative's
   * name on your page. Without an account name, a claimed person's name is used.
   */
  draft(user: User): Profile {
    const claimed = this.store.db
      .query<Person, [string]>("SELECT p.* FROM profiles pr JOIN people p ON p.id = pr.person_id AND p.tree_id = pr.tree_id WHERE pr.user_id = ? AND p.kind = 'person' ORDER BY pr.created_at")
      .all(user.id)
    const own = user.name?.trim() ?? ''
    const person = own ? claimed.find((p) => fullName(p).toLowerCase() === own.toLowerCase()) : claimed[0]
    const name = own || (person ? fullName(person) : '')
    return { user_id: user.id, slug: this.suggest(user.id, name), published: 0, indexable: 0, name, nickname: person?.nickname ?? null, city: null, region: null, country: null, hometown: null, bio: null, email: null, links: [], socials: [], photo_mime: null, created_at: 0, updated_at: 0 }
  }

  /** Save the form or an API body. Fields left out stay as they were. */
  save(user: User, input: Record<string, unknown>): Profile {
    const now = this.mine(user.id) ?? this.draft(user)
    const has = (k: string) => k in input && input[k] !== undefined
    const name = has('name') ? clean(input.name, 120) : now.name
    if (!name) throw new Error('give the name you want shown')
    const next = {
      name,
      nickname: has('nickname') ? clean(input.nickname, 60) : now.nickname,
      city: has('city') ? clean(input.city, 80) : now.city,
      region: has('region') ? clean(input.region, 80) : now.region,
      country: has('country') ? clean(input.country, 80) : now.country,
      hometown: has('hometown') ? clean(input.hometown, 120) : now.hometown,
      bio: has('bio') ? clean(input.bio, 1000) : now.bio,
      links: has('links') ? parseLinks(input.links).slice(0, 10) : now.links,
      socials: has('socials') ? parseLabeled(input.socials, 10, 300) : now.socials,
    }
    let email = now.email
    if (has('email')) {
      const typed = input.email == null ? '' : String(input.email).trim()
      email = typed ? validEmail(typed) : null
      if (typed && !email) throw new Error('that email does not look right')
    }
    let slug = now.slug
    if (has('slug') && String(input.slug ?? '').trim()) {
      slug = slugify(String(input.slug))
      if (!validSlug(slug)) throw new Error('the address can use letters, numbers and dots, 3 to 80 long')
      if (this.taken(slug, user.id)) throw new Error(`${slug} is taken; try ${this.suggest(user.id, slug, next)}`)
    }
    const flag = (k: string, was: number) => (has(k) ? (input[k] === true || input[k] === '1' || input[k] === 'on' || input[k] === 'true' ? 1 : 0) : was)
    const published = flag('published', now.published)
    const indexable = flag('indexable', now.indexable)
    const t = this.now()
    this.store.db
      .query(
        'INSERT INTO public_profiles (user_id, slug, published, indexable, name, nickname, city, region, country, hometown, bio, email, links, socials, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET slug = excluded.slug, published = excluded.published, indexable = excluded.indexable, name = excluded.name, nickname = excluded.nickname, city = excluded.city, region = excluded.region, country = excluded.country, hometown = excluded.hometown, bio = excluded.bio, email = excluded.email, links = excluded.links, socials = excluded.socials, updated_at = excluded.updated_at',
      )
      .run(user.id, slug, published, indexable, next.name, next.nickname, next.city, next.region, next.country, next.hometown, next.bio, email, JSON.stringify(next.links), JSON.stringify(next.socials), t, t)
    return this.mine(user.id)!
  }

  setPhoto(user: User, data: Uint8Array | null) {
    if (!this.mine(user.id)) this.save(user, {})
    if (!data) return void this.store.db.query('UPDATE public_profiles SET photo = NULL, photo_mime = NULL, updated_at = ? WHERE user_id = ?').run(this.now(), user.id)
    if (data.byteLength > MAX_PHOTO) throw new Error('photos can be up to 8 MB')
    const mime = sniffImage(data)
    if (!mime) throw new Error('that file is not a photo (JPEG, PNG, GIF or WebP)')
    this.store.db.query('UPDATE public_profiles SET photo = ?, photo_mime = ?, updated_at = ? WHERE user_id = ?').run(data, mime, this.now(), user.id)
  }

  /** The photo of a published profile, or of your own. */
  photo(slug: string, viewer: string | null): { data: Uint8Array; mime: string } | null {
    const row = this.store.db.query<{ user_id: string; published: number; photo: Uint8Array | null; photo_mime: string | null }, [string]>('SELECT user_id, published, photo, photo_mime FROM public_profiles WHERE slug = ?').get(slug.toLowerCase())
    if (!row?.photo || !row.photo_mime || (!row.published && row.user_id !== viewer)) return null
    return { data: row.photo, mime: row.photo_mime }
  }

  published(): Profile[] {
    return this.store.db.query<Row, []>('SELECT user_id, slug, published, indexable, name, nickname, city, region, country, hometown, bio, email, links, socials, photo_mime, created_at, updated_at FROM public_profiles WHERE published = 1 ORDER BY lower(name)').all().map((r) => read(r)!)
  }

  remove(userId: string) {
    this.store.db.query('DELETE FROM public_profiles WHERE user_id = ?').run(userId)
  }
}

// ---- Find people: one faceted search over everything public -------------------

export const KINDS = { people: 'People', businesses: 'Businesses', families: 'Families' } as const
export type Kind = keyof typeof KINDS
const TAG: Record<Kind, string> = { people: 'Person', businesses: 'Business', families: 'Family' }
export type Filters = { q: string; kind: Kind | null; country: string | null; region: string | null; city: string | null; category: string | null }
export type Hit = { kind: Kind; name: string; url: string; line: string; place: string; photo: string | null }
export type Facet = { key: keyof Filters; title: string; items: { value: string; label: string; count: number; on: boolean }[] }
export const FACET_KEYS = ['kind', 'country', 'region', 'city', 'category'] as const

type Doc = Hit & { text: string; country: string | null; region: string | null; city: string | null; category: string | null }

export function readFilters(get: (k: string) => string | undefined): Filters {
  const v = (k: string, max = 80) => clean(get(k), max)?.toLowerCase() ?? null
  const kind = v('kind')
  return { q: (get('q') ?? '').slice(0, 200).trim(), kind: kind && kind in KINDS ? (kind as Kind) : null, country: v('country'), region: v('region'), city: v('city'), category: v('category') }
}

export function search(profiles: Profiles, listings: Listings, teams: Teams, f: Filters) {
  const low = (s: string | null | undefined) => s?.trim().toLowerCase() || null
  const docs: Doc[] = [
    ...profiles.published().map((p) => ({
      kind: 'people' as const,
      name: p.nickname ? `${p.name} (${p.nickname})` : p.name,
      url: `/profile/${p.slug}`,
      line: p.bio ?? '',
      place: placeOf(p),
      photo: p.photo_mime ? `/profile/${p.slug}/photo` : null,
      text: [p.name, p.nickname, p.slug, p.city, p.region, p.country, p.hometown, p.bio].filter(Boolean).join(' '),
      country: low(p.country),
      region: low(p.region),
      city: low(p.city),
      category: null,
    })),
    ...teams.directory().map((b) => ({ kind: 'businesses' as const, name: b.name, url: `/families/b/${b.id}`, line: b.listing ?? '', place: b.place ?? '', photo: null, text: [b.name, b.category, b.place, b.listing].filter(Boolean).join(' '), country: null, region: null, city: null, category: low(b.category) })),
    ...listings.directory().map((t) => ({ kind: 'families' as const, name: t.name, url: `/families/${t.id}`, line: t.listing ?? '', place: '', photo: null, text: [t.name, t.listing].filter(Boolean).join(' '), country: null, region: null, city: null, category: null })),
  ]
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
  // A place facet matches a profile's own field, or a business or family that names the place.
  const at = (d: Doc, key: 'country' | 'region' | 'city', value: string) => (d.kind === 'people' ? d[key] === value : d.text.toLowerCase().includes(value))
  const passes = (d: Doc, skip: keyof Filters | null = null) =>
    words.every((w) => d.text.toLowerCase().includes(w)) &&
    (skip === 'kind' || !f.kind || d.kind === f.kind) &&
    (skip === 'country' || !f.country || at(d, 'country', f.country)) &&
    (skip === 'region' || !f.region || at(d, 'region', f.region)) &&
    (skip === 'city' || !f.city || at(d, 'city', f.city)) &&
    (skip === 'category' || !f.category || d.category === f.category)
  const hits = docs.filter((d) => passes(d))

  // Each facet counts what the other filters leave, so its own choices stay visible.
  const facet = (key: (typeof FACET_KEYS)[number], title: string, valueOf: (d: Doc) => string | null, labelOf: (d: Doc, v: string) => string): Facet => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const d of docs) {
      if (!passes(d, key)) continue
      const v = valueOf(d)
      if (!v) continue
      const c = counts.get(v) ?? { label: labelOf(d, v), count: 0 }
      c.count++
      counts.set(v, c)
    }
    const items = [...counts].map(([value, c]) => ({ value, label: c.label, count: c.count, on: f[key] === value })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 30)
    return { key, title, items }
  }
  const raw = (d: Doc, k: 'city' | 'region' | 'country') => (d.kind === 'people' ? (d.place.split(', ').find((x) => x.toLowerCase() === d[k]) ?? d[k]!) : '')
  const facets = [
    facet('kind', 'Kind', (d) => d.kind, (_d, v) => KINDS[v as Kind]),
    facet('country', 'Country', (d) => d.country, (d) => raw(d, 'country')),
    facet('region', 'State or region', (d) => d.region, (d) => raw(d, 'region')),
    facet('city', 'City', (d) => d.city, (d) => raw(d, 'city')),
    facet('category', 'Business category', (d) => d.category, (_d, v) => v.replace(/^./, (c) => c.toUpperCase())),
  ].filter((x) => x.items.length)
  return { hits: hits.slice(0, 300).map(({ kind, name, url, line, place, photo }) => ({ kind, name, url, line, place, photo })), total: hits.length, facets }
}

// ---- pages -------------------------------------------------------------------

/** The query string for these filters with one facet set (or cleared, when it is already on). */
function hrefWith(f: Filters, key: keyof Filters, value: string | null): string {
  const p = new URLSearchParams()
  for (const k of ['q', ...FACET_KEYS] as const) {
    const v = k === key ? (f[k] === value ? null : value) : f[k]
    if (v) p.set(k, v)
  }
  const s = p.toString()
  return `/people${s ? `?${s}` : ''}`
}

export function peoplePage(ctx: Ctx, f: Filters, r: ReturnType<typeof search>): string {
  const active = FACET_KEYS.filter((k) => f[k])
  const rail = r.facets.length
    ? `<aside class="facets"><h2>Narrow it down</h2>${r.facets
        .map(
          (g) =>
            `<details class="facet-group" open><summary>${esc(g.title)}</summary><ul>${g.items
              .map((i) => `<li><a class="facet-item${i.on ? ' on' : ''}" href="${esc(hrefWith(f, g.key, i.value))}" rel="nofollow"><span class="facet-check" aria-hidden="true"></span><span class="facet-label">${esc(i.label)}</span><span class="facet-count">${i.count}</span></a></li>`)
              .join('')}</ul></details>`,
        )
        .join('')}</aside>`
    : ''
  const chips = active.length
    ? `<p class="chips">${active.map((k) => `<a class="chip" href="${esc(hrefWith(f, k, f[k]))}">${esc(k === 'kind' ? KINDS[f.kind!] : f[k]!)} ×</a>`).join('')} <a class="small" href="/people${f.q ? `?q=${encodeURIComponent(f.q)}` : ''}">Clear all</a></p>`
    : ''
  const list = r.hits.length
    ? `<ul class="hits">${r.hits
        .map(
          (h) =>
            `<li>${h.photo ? `<img class="avatar" src="${esc(h.photo)}" alt="" width="44" height="44" loading="lazy">` : `<span class="avatar ph" aria-hidden="true">${esc(h.name.slice(0, 1).toUpperCase())}</span>`}<div><a href="${esc(h.url)}"><b>${esc(h.name)}</b></a> <span class="tag">${TAG[h.kind]}</span>${h.place ? `<br><span class="muted small">${esc(h.place)}</span>` : ''}${h.line ? `<br><span class="small">${esc(h.line.length > 200 ? `${h.line.slice(0, 200)}…` : h.line)}</span>` : ''}</div></li>`,
        )
        .join('')}</ul>`
    : `<p class="empty">${f.q || active.length ? 'Nobody public matches that.' : 'Nobody has a public profile yet.'}</p>`
  return layout(
    ctx,
    'Find people',
    `<h1>Find people</h1>
<p class="muted">People who made a public profile, businesses and families who chose to be listed. Free to search; nothing from inside a family tree is here.${ctx.user ? ' <a href="/settings/profile">Your public profile</a>.' : ''}</p>
<form class="search" method="get" action="/people" role="search">${FACET_KEYS.filter((k) => f[k]).map((k) => `<input type="hidden" name="${k}" value="${esc(f[k]!)}">`).join('')}<input type="search" name="q" value="${esc(f.q)}" placeholder="A name, a town, a business" aria-label="Search people"><button>Search</button></form>
${chips}<div class="finder">${rail}<section><p class="muted small">${r.total} ${r.total === 1 ? 'result' : 'results'}</p>${list}</section></div>`,
    { crumbs: [['', 'People']], wide: true },
  )
}

const socialHref = socialUrl

export function profilePage(ctx: Ctx, p: Profile, site: string, mine: boolean, posts = ''): string {
  const url = `${site}/profile/${p.slug}`
  const place = placeOf(p)
  const description = [place && `Lives in ${place}`, p.hometown && `from ${p.hometown}`].filter(Boolean).join(', ') || `${p.name} on family.ancestry`
  const head = `
<link rel="canonical" href="${esc(url)}">${p.indexable ? '' : '\n<meta name="robots" content="noindex">'}
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(p.name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">${p.photo_mime ? `\n<meta property="og:image" content="${esc(`${url}/photo`)}">` : ''}`
  const socials = p.socials.map((s) => ({ s, href: socialHref(s) }))
  return layout(
    ctx,
    p.name,
    `<article class="pubprofile">
${mine && !p.published ? '<p class="flash">Only you can see this: your profile is off. Turn it on in <a href="/settings/profile">your public profile</a>.</p>' : ''}
<header>${p.photo_mime ? `<img class="avatar big" src="/profile/${esc(p.slug)}/photo" alt="${esc(p.name)}" width="120" height="120">` : `<span class="avatar big ph" aria-hidden="true">${esc(p.name.slice(0, 1).toUpperCase())}</span>`}
<div><h1>${esc(p.name)}</h1>${p.nickname ? `<p class="muted">“${esc(p.nickname)}”</p>` : ''}
${place ? `<p>Lives in <a href="/people?${new URLSearchParams(Object.fromEntries([['country', p.country], ['region', p.region], ['city', p.city]].filter(([, v]) => v).map(([k, v]) => [k, v!.toLowerCase()]))).toString()}">${esc(place)}</a></p>` : ''}${p.hometown ? `<p>From ${esc(p.hometown)}</p>` : ''}</div></header>
${p.bio ? `<div class="notes">${esc(p.bio).replace(/\n/g, '<br>')}</div>` : ''}
${p.email || p.links.length || socials.length ? `<ul class="plinks">${p.email ? `<li><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></li>` : ''}${p.links.map((l) => `<li><a href="${esc(l.value)}" rel="me nofollow noopener">${esc(l.label ?? l.value.replace(/^https?:\/\//, ''))}</a></li>`).join('')}${socials.map(({ s, href }) => `<li>${href ? `<a href="${esc(href)}" rel="me nofollow noopener">` : ''}${esc(s.label ? `${s.label}: ${s.value}` : s.value)}${href ? '</a>' : ''}</li>`).join('')}</ul>` : ''}
${posts}
<p class="row"><a class="btn" href="/profile/${esc(p.slug)}/card.vcf">Save contact</a>${mine ? ' <a class="btn" href="/settings/profile">Edit</a>' : ''}</p>
<p class="muted small">${esc(p.name)} chose what this page shows. Family trees on family.ancestry stay private. <a href="/people">Find people</a></p>
</article>`,
    { crumbs: [['/people', 'People'], ['', p.name]], head },
  )
}

export function editPage(ctx: Ctx, p: Profile, site: string, saved: boolean): string {
  const ck = (v: number) => (v ? ' checked' : '')
  return layout(
    ctx,
    'Your public profile',
    `<h1>Your public profile</h1>
<p class="muted">A page you can send anyone, with only what you put here. It never shows your birthday, where you were born, your parents or relatives, your street address or your phone: those are the answers to bank security questions, so there is no place for them. Your trees stay private.</p>
<form method="post" action="/settings/profile" class="panel pform">${csrfField(ctx)}
<label class="check"><input type="checkbox" name="published" value="1"${ck(p.published)}> Show my public profile</label>
<label>Your address <span class="muted small">letters, numbers and dots</span><span class="row"><span class="muted">${esc(site.replace(/^https?:\/\//, ''))}/profile/</span><input name="slug" value="${esc(p.slug)}" maxlength="80" required pattern="[A-Za-z0-9.\\-]{3,80}" autocapitalize="none" spellcheck="false"></span></label>
<div class="grid2"><label>Name<input name="name" value="${esc(p.name)}" maxlength="120" required></label><label>Nickname <span class="muted small">optional</span><input name="nickname" value="${esc(p.nickname ?? '')}" maxlength="60"></label></div>
<h2>Where you live</h2>
<div class="grid3"><label>City<input name="city" value="${esc(p.city ?? '')}" maxlength="80" placeholder="Los Gatos"></label><label>State or region<input name="region" value="${esc(p.region ?? '')}" maxlength="80" placeholder="CA"></label><label>Country<input name="country" value="${esc(p.country ?? '')}" maxlength="80" placeholder="USA"></label></div>
<label>Where you're from <span class="muted small">optional, a town or a region</span><input name="hometown" value="${esc(p.hometown ?? '')}" maxlength="120" placeholder="Chicago"></label>
<label>About you <span class="muted small">a few lines</span><textarea name="bio" rows="3" maxlength="1000">${esc(p.bio ?? '')}</textarea></label>
<div class="grid2"><label>Social <span class="muted small">one per line, "instagram: @tony"</span><textarea name="socials" rows="3" autocomplete="off">${esc(formatLabeled(p.socials))}</textarea></label><label>Links <span class="muted small">one per line, "blog: https://…"</span><textarea name="links" rows="3" autocomplete="off">${esc(formatLabeled(p.links))}</textarea></label></div>
<label>Public email <span class="muted small">optional; anyone can see it</span><input name="email" type="email" value="${esc(p.email ?? '')}" maxlength="200"></label>
<label class="check"><input type="checkbox" name="indexable" value="1"${ck(p.indexable)}> Let search engines list this page</label>
<button>Save</button>${p.created_at ? ` <a href="/profile/${esc(p.slug)}">View</a>` : ''}</form>
<form method="post" action="/settings/profile/photo" enctype="multipart/form-data" class="panel pform">${csrfField(ctx)}<h2>Photo</h2>
${p.photo_mime ? `<p><img class="avatar big" src="/profile/${esc(p.slug)}/photo" alt="" width="120" height="120"></p>` : ''}
<input type="file" name="photo" accept="image/*"> <button>Upload</button>${p.photo_mime ? ` <button name="remove" value="1" class="x">Remove photo</button>` : ''}</form>
${p.published && saved ? `<p class="small">Share it: <a href="/profile/${esc(p.slug)}">${esc(site)}/profile/${esc(p.slug)}</a></p>` : ''}`,
    { crumbs: [['/settings', 'Settings'], ['', 'Public profile']] },
  )
}

/** The panel on /settings. */
export function settingsPanel(p: Profile | null, site: string): string {
  return `<section class="panel"><h2>Public profile</h2>${
    p?.published
      ? `<p>On: <a href="/profile/${esc(p.slug)}">${esc(site)}/profile/${esc(p.slug)}</a></p>`
      : '<p class="muted small">Off. A page you can send anyone, with your name, where you live and where you\'re from, and links you choose. Never your birthday, family or address.</p>'
  }<p><a class="btn" href="/settings/profile">${p ? 'Edit' : 'Make'} my public profile</a> <a href="/socials">My socials</a> <a href="/people">Find people</a></p></section>`
}

/** vCard 3.0 of what the page shows, nothing more. */
export function vcard(p: Profile, site: string): string {
  const e = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`)
  const [given, ...rest] = p.name.split(/\s+/)
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${e(p.name)}`, `N:${e(rest.join(' '))};${e(given ?? '')};;;`]
  if (p.nickname) lines.push(`NICKNAME:${e(p.nickname)}`)
  if (p.email) lines.push(`EMAIL:${e(p.email)}`)
  if (p.city || p.region || p.country) lines.push(`ADR:;;;${e(p.city ?? '')};${e(p.region ?? '')};;${e(p.country ?? '')}`)
  for (const l of p.links) lines.push(`URL:${e(l.value)}`)
  for (const s of p.socials) {
    const href = socialHref(s)
    if (href) lines.push(`URL:${e(href)}`)
  }
  lines.push(`URL:${e(`${site}/profile/${p.slug}`)}`)
  if (p.bio) lines.push(`NOTE:${e(p.bio)}`)
  lines.push('END:VCARD')
  return lines.join('\r\n') + '\r\n'
}

/** What the API and the CLI see. */
export const profileOut = (p: Profile, site: string) => {
  const { user_id: _u, photo_mime, ...rest } = p
  return { ...rest, published: Boolean(p.published), indexable: Boolean(p.indexable), url: `${site}/profile/${p.slug}`, photo: photo_mime ? `${site}/profile/${p.slug}/photo` : null }
}

// ---- routes ------------------------------------------------------------------

export type ProfileDeps = {
  profiles: Profiles
  listings: Listings
  teams: Teams
  site: string
  ctx: (c: Context, extra?: Partial<Ctx>) => Ctx
  form: (c: Context) => Promise<Record<string, any>>
  /** The owner's feed posts this viewer may see (the feed's rules), and a box when it is theirs. */
  posts?: (c: Context, p: Profile) => string
}

export function mountProfiles(app: Hono<any>, api: Hono<any>, d: ProfileDeps) {
  const { profiles, site } = d
  const me = (c: Context): User | null => c.get('user') ?? null
  const signIn = (c: Context) => c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`)
  const notFound = (c: Context) => c.html(layout(d.ctx(c), 'Not found', '<h1>Not found</h1><p>No public profile at that address. <a href="/people">Find people</a></p>'), 404)
  /** Published, or your own (so you can look before you turn it on). */
  const visible = (c: Context): Profile | null => {
    const slug = c.req.param('slug')!.toLowerCase()
    const p = profiles.bySlug(slug)
    if (p) return p
    const mine = me(c) ? profiles.mine(me(c)!.id) : null
    return mine?.slug === slug ? mine : null
  }

  app.get('/people', (c) => {
    const f = readFilters((k) => c.req.query(k))
    return c.html(peoplePage(d.ctx(c), f, search(profiles, d.listings, d.teams, f)))
  })
  app.get('/profile/:slug/photo', (c) => {
    const ph = profiles.photo(c.req.param('slug')!, me(c)?.id ?? null)
    if (!ph) return c.body(null, 404)
    return c.body(ph.data as any, 200, { 'content-type': ph.mime, 'cache-control': 'public, max-age=300' })
  })
  app.get('/profile/:slug/card.vcf', (c) => {
    const p = visible(c)
    if (!p) return notFound(c)
    return c.body(vcard(p, site), 200, { 'content-type': 'text/vcard; charset=utf-8', 'content-disposition': `attachment; filename="${p.slug}.vcf"` })
  })
  app.get('/profile/:slug', (c) => {
    const p = visible(c)
    if (!p) return notFound(c)
    return c.html(profilePage(d.ctx(c), p, site, p.user_id === me(c)?.id, d.posts?.(c, p) ?? ''))
  })
  app.get('/settings/profile', (c) => {
    const u = me(c)
    if (!u) return signIn(c)
    return c.html(editPage(d.ctx(c), profiles.mine(u.id) ?? profiles.draft(u), site, false))
  })
  app.post('/settings/profile', async (c) => {
    const u = me(c)
    if (!u) return signIn(c)
    const body = await d.form(c)
    // Unchecked boxes are not sent at all.
    try {
      const p = profiles.save(u, { ...body, published: body.published ?? '0', indexable: body.indexable ?? '0' })
      return c.html(editPage(d.ctx(c, { flash: p.published ? 'Saved. Your profile is public.' : 'Saved. Your profile is off; only you can see it.' }), p, site, true))
    } catch (error) {
      const draft = { ...(profiles.mine(u.id) ?? profiles.draft(u)), ...Object.fromEntries(['name', 'nickname', 'city', 'region', 'country', 'hometown', 'bio', 'email', 'slug'].map((k) => [k, body[k] ?? null])) } as Profile
      return c.html(editPage(d.ctx(c, { error: (error as Error).message }), draft, site, false), 400)
    }
  })
  app.post('/settings/profile/photo', async (c) => {
    const u = me(c)
    if (!u) return signIn(c)
    const body = await d.form(c)
    const file = body.photo instanceof File && body.photo.size ? body.photo : null
    try {
      if (body.remove === '1') profiles.setPhoto(u, null)
      else if (file) profiles.setPhoto(u, new Uint8Array(await file.arrayBuffer()))
      else throw new Error('choose a photo first')
    } catch (error) {
      return c.redirect(`/settings/profile?error=${encodeURIComponent((error as Error).message)}`)
    }
    return c.redirect('/settings/profile?ok=Photo%20saved')
  })

  // ---- /api/v1 ---------------------------------------------------------------

  api.get('/profile', (c) => {
    const u = me(c)!
    const p = profiles.mine(u.id)
    return c.json({ profile: p ? profileOut(p, site) : null, draft: p ? null : profileOut(profiles.draft(u), site) })
  })
  api.post('/profile', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) ?? {}
    try {
      return c.json({ profile: profileOut(profiles.save(me(c)!, body), site) })
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }
  })
  api.delete('/profile', (c) => {
    profiles.remove(me(c)!.id)
    return c.json({ ok: true })
  })
  api.get('/profiles/:slug', (c) => {
    const p = profiles.bySlug(c.req.param('slug')!)
    return p ? c.json({ profile: profileOut(p, site) }) : c.json({ error: 'no public profile at that address' }, 404)
  })
  api.get('/people', (c) => {
    const f = readFilters((k) => c.req.query(k))
    const r = search(profiles, d.listings, d.teams, f)
    return c.json({ ...r, hits: r.hits.map((h) => ({ ...h, url: `${site}${h.url}`, photo: h.photo ? `${site}${h.photo}` : null })) })
  })
}
