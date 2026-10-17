/**
 * Businesses in the family: "Ettinger Plumbing", the bakery on Halsted Street.
 *
 * A business is its own entry in the tree, never a person: it has founders,
 * owners, partners, investors and staff (each a person in the tree, with a title
 * and the years), and no parents or partners, so pedigree, descendants and
 * "how are we related" never reach one. Free for every tree, like the rest of
 * the tree; only pets are on the Family plan.
 *
 * A member can link a business to one of their own Network contacts. Contacts
 * are private, so each member sees only their own link.
 */
import type { Context, Hono } from 'hono'
import { BUSINESS_ROLES, businessRole, canEdit, fullName, lifespan, type Business, type BusinessRole, type Media, type Person, type Role, type Store, type Tree, type User } from './db.js'
import type { Network } from './network.js'
import { contactName } from './network.js'
import * as html from './html.js'
import type { Ctx } from './html.js'

export type BusinessDeps = {
  store: Store
  net: Network
  site: string
  ctx: (c: Context, extra?: Partial<Ctx>) => Ctx
  form: (c: Context) => Promise<Record<string, any>>
  /** The tree and the caller's role in it, or a response that ends the request. */
  treeFor: (c: Context, need?: 'view' | 'edit' | 'owner') => { error: Response } | { error?: undefined; tree: Tree; role: Role; user: User }
  pickId: (value: unknown) => string | null
  image: { types: Set<string>; max: number }
}

/** What kind of business: free text, these are suggestions. */
export const BUSINESS_KINDS = ['Plumbing', 'Electrical', 'Construction', 'Farm', 'Ranch', 'Bakery', 'Restaurant', 'Grocery', 'Retail', 'Hardware store', 'Auto repair', 'Trucking', 'Law firm', 'Medical practice', 'Dental practice', 'Accounting', 'Insurance', 'Real estate', 'Manufacturing', 'Printing', 'Software', 'Consulting', 'Salon', 'Tavern', 'Funeral home']

const years = (b: Pick<Business, 'founded' | 'closed'>) => {
  const y = (d: string | null) => d?.match(/\b(\d{3,4})\b/)?.[1]
  const f = y(b.founded)
  const c = y(b.closed)
  return f || c ? `${f ?? '?'}–${c ?? ''}` : ''
}
const span = (r: Pick<BusinessRole, 'start_date' | 'end_date'>) => [r.start_date, r.end_date].some(Boolean) ? `${r.start_date ?? '?'}–${r.end_date ?? ''}` : ''
export const roleLabel = (r: Pick<BusinessRole, 'role' | 'title'>) => r.title || BUSINESS_ROLES[r.role] || r.role

// ---- pages ------------------------------------------------------------------

const esc = html.esc
const csrf = (ctx: Ctx) => html.csrfField(ctx)
const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

export const businessLink = (treeId: string, b: Business) => `<a class="pl biz" href="/t/${treeId}/b/${b.id}">${esc(b.name)}${years(b) ? ` <span class="yrs">${esc(years(b))}</span>` : ''}</a>`
const personLink = (treeId: string, p: Person) => `<a class="pl sex-${p.sex}" href="/t/${treeId}/p/${p.id}">${esc(fullName(p))}${lifespan(p) ? ` <span class="yrs">${esc(lifespan(p))}</span>` : ''}</a>`

const ROLE_OPTIONS = (selected = 'owner') => Object.entries(BUSINESS_ROLES).map(([k, l]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(l.toLowerCase())}</option>`).join('')
const KINDS_LIST = `<datalist id="business-kinds">${BUSINESS_KINDS.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>`

export function businessFields(b: Partial<Business> | null = null): string {
  const v = (k: keyof Business) => esc(b?.[k] ?? '')
  return `<div class="grid2"><label>Name<input name="name" value="${v('name')}" maxlength="200" required placeholder="Ettinger Plumbing"></label><label>What it did<input name="category" value="${v('category')}" maxlength="80" list="business-kinds" placeholder="Plumbing"></label></div>
  <div class="grid3"><label>Founded<input name="founded" value="${v('founded')}" maxlength="200" placeholder="1952"></label><label>Closed<input name="closed" value="${v('closed')}" maxlength="200" placeholder="leave empty if open"></label><label>Where<input name="place" value="${v('place')}" maxlength="200" placeholder="Sacramento, California"></label></div>
  <label>Website<input name="website" value="${v('website')}" maxlength="500" placeholder="ettingerplumbing.com"></label>
  <label>Notes and stories<textarea name="notes" rows="3" maxlength="20000">${v('notes')}</textarea></label>${KINDS_LIST}`
}

const roleFields = (person?: Person) => `<div class="grid3"><label>${person ? `${esc(person.given || 'They')} was` : 'As'}<select name="role">${ROLE_OPTIONS()}</select></label><label>Title <span class="muted small">optional</span><input name="title" maxlength="120" placeholder="Master plumber"></label><label>From<input name="start_date" maxlength="200" placeholder="1952"></label></div>
  <div class="grid2"><label>To<input name="end_date" maxlength="200" placeholder="1990"></label><label>Note<input name="note" maxlength="500"></label></div>`

/** The "Businesses" section of a person's page. */
export function personBusinesses(ctx: Ctx, tree: Tree, role: Role, person: Person, roles: (BusinessRole & { business: Business })[], all: Business[]): string {
  const edit = canEdit(role)
  if (person.kind === 'pet' || (!roles.length && !edit)) return ''
  const list = roles.length
    ? `<ul>${roles.map((r) => `<li><span class="tag">${esc(roleLabel(r))}</span> <a class="pl biz" href="/t/${tree.id}/b/${r.business.id}">${esc(r.business.name)}</a>${span(r) ? ` <span class="muted small">${esc(span(r))}</span>` : ''}${r.note ? ` <span class="muted small">${esc(r.note)}</span>` : ''}${edit ? ` <form method="post" action="/t/${tree.id}/business-roles/${r.id}/delete" class="inline">${csrf(ctx)}<input type="hidden" name="back" value="/t/${tree.id}/p/${person.id}"><button class="x" title="Remove">×</button></form>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">None recorded.</p>'
  const form = edit
    ? `<details class="panel"><summary>Add a business ${esc(person.given || 'they')} founded, owned or worked at</summary>
<form method="post" action="/t/${tree.id}/businesses" class="pform">${csrf(ctx)}<input type="hidden" name="person_id" value="${person.id}">
  ${all.length ? `<label>A business already in the tree<select name="business_id"><option value="">— a new one, below —</option>${all.map((b) => `<option value="${b.id}">${esc(b.name)}${years(b) ? ` (${esc(years(b))})` : ''}</option>`).join('')}</select></label><p class="muted small">Or a new one:</p>` : ''}
  <div class="grid2"><label>Business name<input name="name" maxlength="200" placeholder="Ettinger Plumbing"></label><label>What it did<input name="category" maxlength="80" list="business-kinds" placeholder="Plumbing"></label></div>
  <div class="grid3"><label>Founded<input name="founded" maxlength="200"></label><label>Closed<input name="closed" maxlength="200"></label><label>Where<input name="place" maxlength="200"></label></div>
  ${roleFields(person)}${KINDS_LIST}
  <button>Add business</button>
</form></details>`
    : ''
  return `<section><h2>Businesses</h2>${list}${form}</section>`
}

export function businessesPage(ctx: Ctx, tree: Tree, role: Role, list: { business: Business; people: (BusinessRole & { person: Person })[] }[], query: string): string {
  const rows = list.length
    ? `<ul class="plain">${list.map(({ business: b, people }) => `<li class="union"><div class="line">${businessLink(tree.id, b)}${b.category ? ` <span class="tag">${esc(b.category)}</span>` : ''}${b.place ? ` <span class="muted small">${esc(b.place)}</span>` : ''}</div>${people.length ? `<p class="small">${people.slice(0, 6).map((r) => `${esc(roleLabel(r))}: ${personLink(tree.id, r.person)}`).join(' · ')}${people.length > 6 ? ` <span class="muted">and ${people.length - 6} more</span>` : ''}</p>` : ''}</li>`).join('')}</ul>`
    : `<p class="empty">${query ? 'No business matches that.' : 'No businesses yet. Add the family plumbing company, the farm, the shop: who started it, who ran it, who worked there.'}</p>`
  return html.layout(
    ctx,
    `Businesses · ${tree.name}`,
    `<h1>Family businesses</h1>
<p class="muted">The companies, farms and shops your family started, owned and worked in. They sit beside the tree, never in a bloodline.</p>
<form class="search" method="get" action="/t/${tree.id}/businesses"><input name="q" value="${esc(query)}" placeholder="Name, trade, town, year or person" aria-label="Search businesses"><button>Search</button></form>
${rows}
${canEdit(role) ? `<details class="panel"${list.length ? '' : ' open'}><summary>Add a business</summary><form method="post" action="/t/${tree.id}/businesses" class="pform">${csrf(ctx)}${businessFields()}<button>Add business</button></form></details>` : ''}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], ['', 'Businesses']] },
  )
}

export type BusinessView = {
  business: Business
  people: (BusinessRole & { person: Person })[]
  media: Media[]
  everyone: Person[]
  contact: { id: string; name: string } | null
  contacts: { id: string; name: string }[]
}

export function businessPage(ctx: Ctx, tree: Tree, role: Role, v: BusinessView): string {
  const b = v.business
  const edit = canEdit(role)
  const photo = b.photo_id ? `<img class="portrait biz" src="/t/${tree.id}/media/${b.photo_id}" alt="${esc(b.name)}">` : `<div class="portrait none biz">${esc(b.name.slice(0, 2).toUpperCase() || '?')}</div>`
  const facts = [
    ['What', b.category],
    ['Founded', b.founded],
    ['Closed', b.closed],
    ['Where', b.place],
  ].filter(([, val]) => val)
  const datalist = `<datalist id="people-${tree.id}">${v.everyone.map((o) => `<option value="${esc(`${fullName(o)}${lifespan(o) ? ` (${lifespan(o)})` : ''} #${o.id}`)}"></option>`).join('')}</datalist>`
  return html.layout(
    ctx,
    b.name,
    `<div class="person-head">${photo}<div><h1>${esc(b.name)}</h1><p class="muted">Business${years(b) ? ` · ${esc(years(b))}` : ''}</p>
${facts.map(([k, val]) => `<p><b>${k}</b> ${esc(val)}</p>`).join('')}
${b.website ? `<p><b>Website</b> <a href="${esc(b.website)}" rel="noopener noreferrer nofollow" target="_blank">${esc(host(b.website))}</a></p>` : ''}
${v.contact ? `<p class="small">In your network: <a href="/network/c/${esc(v.contact.id)}">${esc(v.contact.name)}</a></p>` : ''}</div></div>

<section><h2>People</h2>${
      v.people.length
        ? `<ul>${v.people.map((r) => `<li><span class="tag">${esc(roleLabel(r))}</span> ${personLink(tree.id, r.person)}${span(r) ? ` <span class="muted small">${esc(span(r))}</span>` : ''}${r.note ? ` <span class="muted small">${esc(r.note)}</span>` : ''}${edit ? ` <form method="post" action="/t/${tree.id}/business-roles/${r.id}/delete" class="inline">${csrf(ctx)}<input type="hidden" name="back" value="/t/${tree.id}/b/${b.id}"><button class="x" title="Remove">×</button></form>` : ''}</li>`).join('')}</ul>`
        : '<p class="muted">Nobody linked yet.</p>'
    }
${edit ? `${datalist}<details class="panel"><summary>Add a founder, owner, partner, investor or employee</summary>
<form method="post" action="/t/${tree.id}/b/${b.id}/people" class="pform">${csrf(ctx)}
  <p class="muted small">Someone already in the tree:</p>
  <div class="row"><input name="existing" list="people-${tree.id}" placeholder="Start typing a name" autocomplete="off"></div>
  <p class="muted small">Or someone new (added to the tree, outside any family until you link them):</p>
  <div class="grid2"><label>Given names<input name="given" maxlength="200"></label><label>Surname<input name="surname" maxlength="200"></label></div>
  ${roleFields()}
  <button>Add</button>
</form></details>` : ''}</section>

${b.notes ? `<section><h2>Notes and stories</h2><div class="notes">${esc(b.notes).replace(/\n/g, '<br>')}</div></section>` : ''}

<section><h2>Photos</h2>${v.media.length ? `<div class="photos">${v.media.map((m) => `<figure><a href="/t/${tree.id}/media/${m.id}"><img loading="lazy" src="/t/${tree.id}/media/${m.id}" alt="${esc(m.caption ?? m.filename)}"></a><figcaption>${esc(m.caption ?? '')}${edit ? ` <form method="post" action="/t/${tree.id}/media/${m.id}/primary" class="inline">${csrf(ctx)}<button class="link small">${b.photo_id === m.id ? 'main photo' : 'use as main photo'}</button></form><form method="post" action="/t/${tree.id}/media/${m.id}/delete" class="inline" data-confirm="Delete this photo?">${csrf(ctx)}<button class="x">×</button></form>` : ''}</figcaption></figure>`).join('')}</div>` : '<p class="muted">No photos yet: the storefront, the truck, the sign.</p>'}
${edit ? `<form method="post" action="/t/${tree.id}/b/${b.id}/media" enctype="multipart/form-data" class="row">${csrf(ctx)}<input type="file" name="file" accept="image/*" required><input name="caption" placeholder="Caption" maxlength="1000"><button>Upload</button></form>` : ''}</section>

<details class="panel"><summary>Your network</summary>
<p class="muted small">Link this business to one of your own contacts. Only you see the link; your contacts stay private.</p>
<form method="post" action="/t/${tree.id}/b/${b.id}/contact" class="pform">${csrf(ctx)}
  ${v.contacts.length ? `<label>Your contact<select name="contact_id"><option value="">— not linked —</option>${v.contacts.map((c) => `<option value="${esc(c.id)}"${v.contact?.id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label><button>Save link</button>` : ''}
  ${v.contact ? '' : `<button name="create" value="1" class="btn">${v.contacts.length ? 'Or add' : 'Add'} it to my network as a business contact</button>`}
</form></details>

${edit ? `<details class="panel"><summary>Edit ${esc(b.name)}</summary><form method="post" action="/t/${tree.id}/b/${b.id}" class="pform">${csrf(ctx)}${businessFields(b)}<button>Save</button></form>
<form method="post" action="/t/${tree.id}/b/${b.id}/delete" data-confirm="Delete ${esc(b.name)}? The people in it stay in the tree.">${csrf(ctx)}<button class="danger">Delete this business</button></form></details>` : ''}`,
    { crumbs: [['/trees', 'Trees'], [`/t/${tree.id}`, tree.name], [`/t/${tree.id}/businesses`, 'Businesses'], ['', b.name]] },
  )
}

// ---- routes -----------------------------------------------------------------

export function mountBusinesses(app: Hono<any>, api: Hono<any>, d: BusinessDeps) {
  const { store, net, site } = d
  const flash = (path: string, message: string) => `${path}?ok=${encodeURIComponent(message)}`

  /** A person to add: someone in the tree (existing / person_id) or a new one from given + surname. */
  const personFrom = (treeId: string, body: Record<string, any>): Person => {
    const existing = d.pickId(body.person_id ?? body.existing_id ?? body.existing)
    if (existing) {
      const p = store.person(treeId, existing)
      if (!p) throw new Error('that person is not in this tree')
      return p
    }
    if (!String(body.given ?? '').trim() && !String(body.surname ?? '').trim()) throw new Error('pick someone in the tree or give a name')
    return store.addPerson(treeId, { given: body.given, surname: body.surname, sex: body.sex, birth_date: body.birth_date, living: body.living })
  }

  /** {name, ..., person_id?, role?} or {business_id, person_id, role?}: a business, and someone's place in it. */
  const create = (treeId: string, body: Record<string, any>): { business: Business; role: BusinessRole | null } =>
    store.tx(() => {
      const existing = body.business_id ? store.business(treeId, String(body.business_id)) : null
      if (body.business_id && !existing) throw new Error('no such business in this tree')
      const business = existing ?? store.addBusiness(treeId, body)
      const role = body.person_id ? store.addBusinessRole(treeId, business.id, personFrom(treeId, { person_id: body.person_id }).id, body) : null
      for (const p of Array.isArray(body.people) ? body.people : []) store.addBusinessRole(treeId, business.id, personFrom(treeId, p).id, p)
      return { business, role }
    })

  const linkContact = (b: Business, user: User, body: Record<string, any>): string | null => {
    if (body.create === '1' || body.create === true) {
      const c = net.addContact(user.id, { circle: 'business', name: b.name, company: b.name, links: b.website ? [b.website] : [], addresses: b.place ? [{ label: null, lines: b.place }] : [], notes: b.category ? `${b.category}. From the family tree.` : 'From the family tree.' })
      store.setBusinessContact(b.id, user.id, c.id)
      return c.id
    }
    const id = body.contact_id ? String(body.contact_id) : null
    if (id && !net.contact(user.id, id)) throw new Error('no such contact in your network')
    store.setBusinessContact(b.id, user.id, id)
    return id
  }

  const myContact = (b: Business, user: User) => {
    const id = store.businessContact(b.id, user.id)
    const c = id ? net.contact(user.id, id) : null
    return c ? { id: c.id, name: c.company || contactName(c) } : null
  }

  app.get('/t/:tree/businesses', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const q = (c.req.query('q') ?? '').slice(0, 200)
    const list = (q ? store.searchBusinesses(t.tree.id, q, 500) : store.businesses(t.tree.id, 500)).map((business) => ({ business, people: store.businessPeople(t.tree.id, business.id) }))
    return c.html(businessesPage(d.ctx(c), t.tree, t.role, list, q))
  })
  app.post('/t/:tree/businesses', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    const body = await d.form(c)
    const back = body.person_id ? `/t/${t.tree.id}/p/${body.person_id}` : `/t/${t.tree.id}/businesses`
    try {
      const { business } = create(t.tree.id, body)
      return c.redirect(body.person_id ? flash(back, `Added ${business.name}`) : `/t/${t.tree.id}/b/${business.id}`)
    } catch (error) {
      return c.redirect(flash(back, `Not added: ${(error as Error).message}`))
    }
  })
  app.get('/t/:tree/b/:biz', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const b = store.business(t.tree.id, c.req.param('biz')!)
    if (!b) return c.html(html.messagePage(d.ctx(c), 'Not found', 'No business by that id in this tree.'), 404)
    return c.html(
      businessPage(d.ctx(c), t.tree, t.role, {
        business: b,
        people: store.businessPeople(t.tree.id, b.id),
        media: store.businessMedia(t.tree.id, b.id),
        everyone: canEdit(t.role) ? store.people(t.tree.id, 5000).filter((o) => o.kind === 'person') : [],
        contact: myContact(b, t.user),
        contacts: net.contacts(t.user.id, { circle: 'business' }).map((x) => ({ id: x.id, name: x.company || contactName(x) })),
      }),
    )
  })
  app.post('/t/:tree/b/:biz', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    store.updateBusiness(t.tree.id, c.req.param('biz')!, await d.form(c))
    return c.redirect(flash(`/t/${t.tree.id}/b/${c.req.param('biz')}`, 'Saved'))
  })
  app.post('/t/:tree/b/:biz/delete', (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    store.deleteBusiness(t.tree.id, c.req.param('biz')!)
    return c.redirect(flash(`/t/${t.tree.id}/businesses`, 'Business deleted'))
  })
  app.post('/t/:tree/b/:biz/people', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    const back = `/t/${t.tree.id}/b/${c.req.param('biz')}`
    const body = await d.form(c)
    try {
      const p = store.tx(() => {
        const person = personFrom(t.tree.id, body)
        store.addBusinessRole(t.tree.id, c.req.param('biz')!, person.id, body)
        return person
      })
      return c.redirect(flash(back, `Added ${fullName(p)}`))
    } catch (error) {
      return c.redirect(flash(back, `Not added: ${(error as Error).message}`))
    }
  })
  app.post('/t/:tree/business-roles/:role/delete', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    const r = store.businessRoleRow(t.tree.id, c.req.param('role')!)
    store.removeBusinessRole(t.tree.id, c.req.param('role')!)
    const back = String((await d.form(c)).back ?? '')
    // Only back to a page in this tree.
    return c.redirect(back.startsWith(`/t/${t.tree.id}/`) && !back.includes('//') ? back : r ? `/t/${t.tree.id}/b/${r.business_id}` : `/t/${t.tree.id}`)
  })
  app.post('/t/:tree/b/:biz/media', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    const back = `/t/${t.tree.id}/b/${c.req.param('biz')}`
    const body = await d.form(c)
    const file = body.file
    if (!(file instanceof File) || !d.image.types.has(file.type) || file.size > d.image.max) return c.redirect(flash(back, 'Photos must be JPEG, PNG, GIF, WebP or AVIF, under 8 MB.'))
    try {
      store.addBusinessMedia(t.tree.id, c.req.param('biz')!, { filename: file.name, mime: file.type, data: new Uint8Array(await file.arrayBuffer()), caption: body.caption ?? null })
    } catch (error) {
      return c.redirect(flash(back, (error as Error).message))
    }
    return c.redirect(back)
  })
  // Any member: the link is to their own private contact.
  app.post('/t/:tree/b/:biz/contact', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const b = store.business(t.tree.id, c.req.param('biz')!)
    if (!b) return c.notFound()
    const back = `/t/${t.tree.id}/b/${b.id}`
    try {
      const id = linkContact(b, t.user, await d.form(c))
      return c.redirect(flash(back, id ? 'Linked to your network' : 'Unlinked'))
    } catch (error) {
      return c.redirect(flash(back, (error as Error).message))
    }
  })

  // ---- /api/v1 ----

  const bad = (c: Context, error: unknown, status: 400 | 404 = 400) => c.json({ error: error instanceof Error ? error.message : String(error) }, status)
  const json = async (c: Context): Promise<Record<string, any>> => ((await c.req.json().catch(() => ({}))) as Record<string, any>) ?? {}
  const summary = (treeId: string, b: Business) => ({ ...b, url: `${site}/t/${treeId}/b/${b.id}`, people: store.businessPeople(treeId, b.id).map((r) => ({ role_id: r.id, id: r.person.id, name: fullName(r.person), role: r.role, label: roleLabel(r), title: r.title, start_date: r.start_date, end_date: r.end_date })) })
  const detail = (treeId: string, b: Business, user: User) => ({
    ...summary(treeId, b),
    people: store.businessPeople(treeId, b.id).map((r) => ({ role_id: r.id, id: r.person.id, name: fullName(r.person), role: r.role, label: roleLabel(r), title: r.title, start_date: r.start_date, end_date: r.end_date, note: r.note })),
    photos: store.businessMedia(treeId, b.id).map((m) => ({ ...m, url: `${site}/t/${treeId}/media/${m.id}` })),
    contact: myContact(b, user),
  })
  const bizFor = (c: Context, t: { tree: Tree }) => store.business(t.tree.id, c.req.param('biz')!)

  api.get('/trees/:tree/businesses', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const q = c.req.query('q') ?? ''
    const limit = Math.min(1000, Number(c.req.query('limit')) || 100)
    return c.json({ businesses: (q ? store.searchBusinesses(t.tree.id, q, limit) : store.businesses(t.tree.id, limit)).map((b) => summary(t.tree.id, b)) })
  })
  /** {name, category?, founded?, closed?, place?, website?, notes?, people?: [{person_id | given+surname, role, title?, start_date?, end_date?}]}. */
  api.post('/trees/:tree/businesses', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    try {
      const body = await json(c)
      if (body.business_id) return bad(c, 'to add someone to an existing business, POST .../businesses/:id/people')
      return c.json({ business: detail(t.tree.id, create(t.tree.id, body).business, t.user) }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.get('/trees/:tree/businesses/:biz', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const b = bizFor(c, t)
    return b ? c.json({ business: detail(t.tree.id, b, t.user) }) : bad(c, 'no such business', 404)
  })
  api.patch('/trees/:tree/businesses/:biz', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    const b = store.updateBusiness(t.tree.id, c.req.param('biz')!, await json(c))
    return b ? c.json({ business: detail(t.tree.id, b, t.user) }) : bad(c, 'no such business', 404)
  })
  api.delete('/trees/:tree/businesses/:biz', (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    store.deleteBusiness(t.tree.id, c.req.param('biz')!)
    return c.json({ ok: true })
  })
  /** {person_id | given+surname, role, title?, start_date?, end_date?, note?}. */
  api.post('/trees/:tree/businesses/:biz/people', async (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    const b = bizFor(c, t)
    if (!b) return bad(c, 'no such business', 404)
    try {
      const body = await json(c)
      store.tx(() => store.addBusinessRole(t.tree.id, b.id, personFrom(t.tree.id, body).id, body))
      return c.json({ business: detail(t.tree.id, b, t.user) }, 201)
    } catch (error) {
      return bad(c, error)
    }
  })
  api.delete('/trees/:tree/business-roles/:role', (c) => {
    const t = d.treeFor(c, 'edit')
    if (t.error) return t.error
    store.removeBusinessRole(t.tree.id, c.req.param('role')!)
    return c.json({ ok: true })
  })
  /** {contact_id} links one of your own contacts, null unlinks, {create: true} adds it to your network. */
  api.post('/trees/:tree/businesses/:biz/contact', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const b = bizFor(c, t)
    if (!b) return bad(c, 'no such business', 404)
    try {
      linkContact(b, t.user, await json(c))
      return c.json({ business: detail(t.tree.id, b, t.user) })
    } catch (error) {
      return bad(c, error)
    }
  })
  /** People and businesses at once. */
  api.get('/trees/:tree/search', (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const q = c.req.query('q') ?? ''
    const limit = Math.min(500, Number(c.req.query('limit')) || 50)
    return c.json({ people: store.search(t.tree.id, q, limit).map((p) => ({ id: p.id, name: fullName(p), kind: p.kind, birth_date: p.birth_date, death_date: p.death_date, url: `${site}/t/${t.tree.id}/p/${p.id}` })), businesses: store.searchBusinesses(t.tree.id, q, limit).map((b) => summary(t.tree.id, b)) })
  })
}

/** For the person API: their businesses. */
export const personBusinessesOut = (store: Store, treeId: string, personId: string) =>
  store.businessesOf(treeId, personId).map((r) => ({ role_id: r.id, business: { id: r.business.id, name: r.business.name, category: r.business.category }, role: r.role, label: roleLabel(r), title: r.title, start_date: r.start_date, end_date: r.end_date }))

export { businessRole }
