/**
 * Life events: everything that happens to someone, from one "Add an event" form.
 *
 * Most of a life is not a row in the events table. A birth and a death are the
 * person's own dates; a marriage, a divorce, a remarriage are a partnership
 * (families); a child born, adopted, fostered or taken on as a step-child is a
 * child link. So the form asks "what happened" and each answer goes where it
 * belongs, which is what keeps the pedigree, the relationship words and GEDCOM
 * right. Only the rest (a new job, a move, a graduation, military service)
 * becomes a plain event.
 *
 * The timeline reads it all back: birth, partnerships starting and ending
 * (a second marriage says "Remarriage"), children's births, the plain events,
 * death, in date order.
 */
import { fullName, yearOf, type Event, type Family, type Person, type Store } from './db.js'
import * as html from './html.js'
import type { Ctx } from './html.js'

/** What the answer to "what happened" does. */
type Effect = 'birth' | 'death' | 'union' | 'union-end' | 'child' | 'step-child' | 'event'
export type LifeEvent = { label: string; group: string; effect: Effect; kind?: string; relation?: string; end?: string; partner?: boolean; pets?: boolean }

/** Every kind of event, in the order the form shows them. The label is what the timeline (and GEDCOM) calls it. */
export const LIFE_EVENTS: Record<string, LifeEvent> = {
  birth: { label: 'Birth', group: 'Life', effect: 'birth', pets: true },
  death: { label: 'Death', group: 'Life', effect: 'death', pets: true },
  burial: { label: 'Burial', group: 'Life', effect: 'event', pets: true },
  cremation: { label: 'Cremation', group: 'Life', effect: 'event', pets: true },

  dating: { label: 'Started dating', group: 'Partners', effect: 'union', kind: 'dating', partner: true },
  engagement: { label: 'Engagement', group: 'Partners', effect: 'event', partner: true },
  marriage: { label: 'Marriage', group: 'Partners', effect: 'union', kind: 'married', partner: true },
  remarriage: { label: 'Remarriage', group: 'Partners', effect: 'union', kind: 'married', partner: true },
  partners: { label: 'Moved in together', group: 'Partners', effect: 'union', kind: 'partners', partner: true },
  separation: { label: 'Separation', group: 'Partners', effect: 'union-end', end: 'separated', partner: true },
  divorce: { label: 'Divorce', group: 'Partners', effect: 'union-end', end: 'divorced', partner: true },
  widowed: { label: 'Widowed', group: 'Partners', effect: 'union-end', end: 'widowed', partner: true },

  child: { label: 'Child born', group: 'Children', effect: 'child', relation: 'birth' },
  adopted_child: { label: 'Adopted a child', group: 'Children', effect: 'child', relation: 'adopted' },
  foster_child: { label: 'Took in a foster child', group: 'Children', effect: 'child', relation: 'foster' },
  step_child: { label: 'Became a step-parent', group: 'Children', effect: 'step-child', partner: true },
  adoption: { label: 'Adoption', group: 'Children', effect: 'event', pets: true },

  occupation: { label: 'Occupation', group: 'Work and school', effect: 'event' },
  job_change: { label: 'Job change', group: 'Work and school', effect: 'event' },
  promotion: { label: 'Promotion', group: 'Work and school', effect: 'event' },
  business: { label: 'Started a business', group: 'Work and school', effect: 'event' },
  retirement: { label: 'Retirement', group: 'Work and school', effect: 'event' },
  education: { label: 'Education', group: 'Work and school', effect: 'event' },
  graduation: { label: 'Graduation', group: 'Work and school', effect: 'event' },
  military: { label: 'Military', group: 'Work and school', effect: 'event' },

  residence: { label: 'Moved', group: 'Home', effect: 'event', pets: true },
  immigration: { label: 'Immigration', group: 'Home', effect: 'event' },
  emigration: { label: 'Emigration', group: 'Home', effect: 'event' },
  naturalization: { label: 'Naturalization', group: 'Home', effect: 'event' },
  census: { label: 'Census', group: 'Home', effect: 'event' },

  baptism: { label: 'Baptism', group: 'Faith', effect: 'event' },
  christening: { label: 'Christening', group: 'Faith', effect: 'event' },
  first_communion: { label: 'First communion', group: 'Faith', effect: 'event' },
  confirmation: { label: 'Confirmation', group: 'Faith', effect: 'event' },
  bar_mitzvah: { label: 'Bar mitzvah', group: 'Faith', effect: 'event' },
  bat_mitzvah: { label: 'Bat mitzvah', group: 'Faith', effect: 'event' },
  religion: { label: 'Religion', group: 'Faith', effect: 'event' },

  medical: { label: 'Medical', group: 'Other', effect: 'event', pets: true },
  award: { label: 'Award', group: 'Other', effect: 'event', pets: true },
  other: { label: 'Other', group: 'Other', effect: 'event', pets: true },
}

/** The LIFE_EVENTS key for a key or a label ("death", "Divorce", "job_change", "Job change"), or null. */
export const lifeKey = (value: unknown): string | null => {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return null
  if (LIFE_EVENTS[v]) return v
  return Object.entries(LIFE_EVENTS).find(([, d]) => d.label.toLowerCase() === v)?.[0] ?? null
}

/** Partnerships and children change the tree itself, so they are for editors, like adding a relative. */
export const changesTree = (key: string) => ['union', 'union-end', 'child', 'step-child'].includes(LIFE_EVENTS[key]?.effect ?? '')

const ENDED = (end: string | null | undefined) => ({ divorced: 'Divorced', separated: 'Separated', widowed: 'Widowed' })[end ?? 'divorced'] ?? 'Divorced'
const ENDING_LABEL: Record<string, string> = { divorced: 'Divorce', separated: 'Separation', widowed: 'Widowed' }

export type AddRelative = (store: Store, treeId: string, personId: string, body: Record<string, any>) => Person

/**
 * Someone in the tree from what was typed: "Rose Ettinger (1931–) #abc123" from the list, a bare id,
 * or a name that matches exactly one person. Null when nothing was typed.
 */
const findPerson = (store: Store, treeId: string, value: unknown): Person | null => {
  const text = String(value ?? '').trim()
  if (!text) return null
  const id = text.match(/#([A-Za-z0-9_-]{6,})\s*$/)?.[1] ?? text
  const byId = store.person(treeId, id)
  if (byId) return byId
  const name = text.replace(/\s*\(.*$/, '').toLowerCase()
  const hits = store.search(treeId, name, 20).filter((p) => fullName(p).toLowerCase() === name)
  if (hits.length === 1) return hits[0]!
  throw new Error(hits.length ? `more than one ${text} in the tree: pick from the list` : `nobody called ${text} in the tree: pick from the list, or give a new name`)
}
const filled = (value: unknown) => String(value ?? '').trim()

/**
 * Record what happened to `personId`. `body` is the form (or API JSON):
 *   what           a LIFE_EVENTS key (or type: any label, for a plain event)
 *   date, place, description
 *   with           f:<family id> (one of their partnerships), or with_person (someone in the tree),
 *                  or with_given + with_surname (someone new)
 *   child          someone in the tree, or child_given + child_surname (+ child_sex), for the Children events
 *   custom         the name of an "Other" event
 * Returns where to look and what to say.
 */
export function recordLifeEvent(store: Store, treeId: string, personId: string, body: Record<string, any>, addRelative: AddRelative): { message: string; event?: Event; family?: Family; person?: Person } {
  const person = store.person(treeId, personId)
  if (!person) throw new Error('no such person')
  const key = filled(body.what) || (body.type ? 'other' : '')
  const def = LIFE_EVENTS[key]
  if (!def) throw new Error('pick what happened')
  if (person.kind === 'pet' && !def.pets) throw new Error(`a pet does not have a ${def.label.toLowerCase()}`)
  const date = filled(body.date) || null
  const place = filled(body.place) || null
  const details = filled(body.description) || null
  const name = fullName(person)

  return store.tx(() => {
    if (def.effect === 'birth' || def.effect === 'death') {
      const which = def.effect
      const fields: Record<string, unknown> = {}
      if (date) fields[`${which}_date`] = date
      if (place) fields[`${which}_place`] = place
      if (which === 'death') fields.living = 0
      if (!date && !place && which === 'birth') throw new Error('give a date or a place')
      if (details) fields.notes = [person.notes, `${def.label}: ${details}`].filter(Boolean).join('\n\n')
      store.updatePerson(treeId, person.id, fields)
      return { message: `${def.label} saved` }
    }

    if (def.effect === 'event') {
      const label = key === 'other' ? filled(body.custom) || filled(body.type) || 'Event' : def.label
      const partner = def.partner ? partnerOf(store, treeId, person, body, false) : null
      const description = [partner ? `with ${fullName(partner.person)}` : '', details].filter(Boolean).join('. ') || null
      const event = store.addEvent(treeId, person.id, { type: label, date, place, description })
      return { message: `${label} added`, event }
    }

    if (def.effect === 'union') {
      const partner = partnerOf(store, treeId, person, body, true)!
      // Their partnership that is still going, or a new one: marrying the same person again after a divorce is a new marriage.
      const current = partner.family && !partner.family.end_date && !partner.family.end_kind ? partner.family : store.spouseFamilies(treeId, person.id).find((u) => u.partner?.id === partner.person.id && !u.family.end_date && !u.family.end_kind)?.family
      let family: Family
      if (current) {
        store.updateFamily(treeId, current.id, { kind: def.kind, ...(date ? { start_date: date } : {}), ...(place ? { start_place: place } : {}) })
        family = store.family(treeId, current.id)!
      } else family = store.createFamily(treeId, person.id, partner.person.id, { kind: def.kind, start_date: date, start_place: place })
      if (details) store.addEvent(treeId, person.id, { type: def.label, date, place, description: `with ${fullName(partner.person)}. ${details}` })
      return { message: `${def.label}: ${name} and ${fullName(partner.person)}`, family }
    }

    if (def.effect === 'union-end') {
      const partner = partnerOf(store, treeId, person, body, true)!
      const family = partner.family ?? store.spouseFamilies(treeId, person.id).filter((u) => u.partner?.id === partner.person.id).sort((a, b) => Number(Boolean(a.family.end_date)) - Number(Boolean(b.family.end_date)))[0]?.family ?? store.createFamily(treeId, person.id, partner.person.id, { kind: 'married' })
      store.updateFamily(treeId, family.id, { end_date: date ?? ENDED(def.end), end_kind: def.end, end_place: place })
      // Widowed on a date: that is when their partner died, if nobody has written it down yet.
      if (def.end === 'widowed' && !partner.person.death_date) store.updatePerson(treeId, partner.person.id, { living: 0, ...(date ? { death_date: date } : {}) })
      if (details) store.addEvent(treeId, person.id, { type: def.label, date, place, description: `with ${fullName(partner.person)}. ${details}` })
      return { message: `${def.label}: ${name} and ${fullName(partner.person)}`, family: store.family(treeId, family.id)! }
    }

    if (def.effect === 'child') {
      if (person.kind === 'pet') throw new Error('pets have owners, not children')
      const partner = filled(body.with) || filled(body.with_person) || filled(body.with_given) || filled(body.with_surname) ? partnerOf(store, treeId, person, body, true) : null
      let familyId = partner?.family?.id ?? null
      if (partner && !familyId) familyId = (store.spouseFamilies(treeId, person.id).find((u) => u.partner?.id === partner.person.id && !u.family.end_date)?.family ?? store.createFamily(treeId, person.id, partner.person.id, { kind: 'partners' })).id
      const kid = addRelative(store, treeId, person.id, { as: 'child', relation: def.relation, family_id: familyId, ...childFields(store, treeId, body) })
      if (def.relation === 'birth') {
        // The child's birth is the event: their date and place, unless they are already known.
        store.updatePerson(treeId, kid.id, { ...(date && !kid.birth_date ? { birth_date: date } : {}), ...(place && !kid.birth_place ? { birth_place: place } : {}) })
        if (details) store.addEvent(treeId, person.id, { type: 'Child born', date, place, description: `${fullName(kid)}. ${details}` })
      } else {
        const what = def.relation === 'adopted' ? 'Adoption' : 'Foster care'
        store.addEvent(treeId, person.id, { type: def.label, date, place, description: [fullName(kid), details].filter(Boolean).join('. ') })
        store.addEvent(treeId, kid.id, { type: what, date, place, description: `${def.relation === 'adopted' ? 'Adopted by' : 'Taken in by'} ${name}${partner ? ` and ${fullName(partner.person)}` : ''}` })
      }
      return { message: `${def.label}: ${fullName(store.person(treeId, kid.id)!)}`, person: store.person(treeId, kid.id)! }
    }

    // A step-child is their partner's child: put the child with the partner (if not already), and keep the partnership.
    const partner = partnerOf(store, treeId, person, body, true)!
    const hasUnion = store.spouseFamilies(treeId, person.id).some((u) => u.partner?.id === partner.person.id)
    if (!hasUnion) store.createFamily(treeId, person.id, partner.person.id, { kind: 'married' })
    const existing = findPerson(store, treeId, body.child)
    const theirs = new Set(store.spouseFamilies(treeId, partner.person.id).flatMap((u) => u.children.map((c) => c.id)))
    const kid = existing && theirs.has(existing.id) ? existing : addRelative(store, treeId, partner.person.id, { as: 'child', relation: 'birth', ...childFields(store, treeId, body), family_id: store.spouseFamilies(treeId, partner.person.id).find((u) => !u.partner)?.family.id })
    store.addEvent(treeId, person.id, { type: def.label, date, place, description: [`${fullName(kid)}, ${fullName(partner.person)}'s child`, details].filter(Boolean).join('. ') })
    return { message: `${name} is now ${fullName(kid)}'s step-parent`, person: kid }
  })
}

/** The child's fields for addRelative: someone in the tree, or a new person. */
function childFields(store: Store, treeId: string, body: Record<string, any>): Record<string, unknown> {
  const existing = findPerson(store, treeId, body.child)
  if (existing) return { existing_id: existing.id }
  if (!filled(body.child_given) && !filled(body.child_surname)) throw new Error('say who the child is: someone in the tree, or a name')
  return { given: body.child_given, surname: body.child_surname, sex: body.child_sex, living: body.child_living ?? 1 }
}

/** The partner the event is with: one of their partnerships (f:<id>), someone in the tree, or someone new. */
function partnerOf(store: Store, treeId: string, person: Person, body: Record<string, any>, required: boolean): { person: Person; family: Family | null } | null {
  const w = filled(body.with)
  if (w.startsWith('f:')) {
    const u = store.spouseFamilies(treeId, person.id).find((x) => x.family.id === w.slice(2))
    if (!u?.partner) throw new Error('that partnership has no partner recorded; pick someone below')
    return { person: u.partner, family: u.family }
  }
  const other = findPerson(store, treeId, body.with_person || w)
  if (other) {
    if (other.id === person.id) throw new Error('pick someone else')
    if (other.kind === 'pet') throw new Error('pets have owners, not partners')
    return { person: other, family: null }
  }
  if (filled(body.with_given) || filled(body.with_surname)) return { person: store.addPerson(treeId, { given: body.with_given, surname: body.with_surname, sex: body.with_sex }), family: null }
  if (required) throw new Error('say who with: one of their partners, someone in the tree, or a name')
  return null
}

// ---- the form -----------------------------------------------------------------

const esc = html.esc

/** The "Add an event" panel on a person's page. `full` = may change the tree (partners, children). */
export function lifeEventForm(ctx: Ctx, treeId: string, person: Person, unions: { family: Family; partner: Person | null }[], full: boolean): string {
  const pet = person.kind === 'pet'
  const usable = Object.entries(LIFE_EVENTS).filter(([k, d]) => (pet ? d.pets : true) && (full || !changesTree(k)))
  const groups = [...new Set(usable.map(([, d]) => d.group))]
  const options = groups.map((g) => `<optgroup label="${esc(g)}">${usable.filter(([, d]) => d.group === g).map(([k, d]) => `<option value="${k}" data-effect="${d.effect}"${d.partner ? ' data-partner="1"' : ''}>${esc(d.label)}</option>`).join('')}</optgroup>`).join('')
  const partners = unions.filter((u) => u.partner)
  const withSelect = partners.length
    ? `<label>With<select name="with"><option value="">— someone below —</option>${partners.map((u) => `<option value="f:${u.family.id}">${esc(fullName(u.partner!))}${u.family.end_date || u.family.end_kind ? ` (${esc(ENDED(u.family.end_kind).toLowerCase())})` : ''}</option>`).join('')}</select></label>`
    : ''
  const who = (prefix: string, title: string, list: string) => `<div class="grid3"><label>${title}<input name="${prefix === 'with' ? 'with_person' : 'child'}" list="${list}" placeholder="someone in the tree"></label><label>or a new person: first name<input name="${prefix}_given" maxlength="120"></label><label>last name<input name="${prefix}_surname" maxlength="120"></label></div>`
  return `<details class="panel" id="add-event"><summary>Add an event</summary><form method="post" action="/t/${treeId}/p/${person.id}/events" class="pform" data-life-event>${html.csrfField(ctx)}
<div class="grid3"><label>What happened<select name="what" required><option value="">— pick one —</option>${options}</select></label><label>When<input name="date" maxlength="200" placeholder="12 Jun 1985, ABT 1950, 1990"></label><label>Where<input name="place" maxlength="200" placeholder="Sacramento, California"></label></div>
<label data-show="other">Name it <span class="muted small">for Other</span><input name="custom" maxlength="60" placeholder="Bought the farm, Won the lottery…"></label>
${full && !pet ? `<fieldset data-show="partner"><legend>With whom <span class="muted small">partners, divorce, engagement, step-children</span></legend>${withSelect}${who('with', 'Someone in the tree', `people-${treeId}`)}</fieldset>
<fieldset data-show="child"><legend>Which child <span class="muted small">children</span></legend>${who('child', 'Someone in the tree', `people-${treeId}`)}<p class="muted small" data-show="child-only">For a child with a partner, pick the partner under "With whom" too.</p></fieldset>` : !pet ? '<p class="muted small">Marriages, divorces and children change the tree, so an editor adds those.</p>' : ''}
<label>Details<textarea name="description" rows="2" maxlength="5000" placeholder="New job at Aerojet; cause of death; the church; anything worth keeping"></textarea></label>
<button>Add event</button></form></details>`
}

// ---- the timeline ---------------------------------------------------------------

export type TimelineEntry = { type: string; date: string | null; place: string | null; description: string | null; id: string }

const isEndWord = (d: string | null) => !d || ['divorced', 'separated', 'widowed'].includes(d.toLowerCase())

/** Everything that happened to them, in date order: birth first, death last, undated where they were added. */
export function timeline(p: Person, unions: { family: Family; partner: Person | null; children: Person[] }[], events: Event[]): TimelineEntry[] {
  const out: (TimelineEntry & { rank: number; seq: number })[] = []
  let seq = 0
  const push = (e: TimelineEntry, rank = 1) => out.push({ ...e, rank, seq: seq++ })
  if (p.birth_date || p.birth_place) push({ type: 'Birth', date: p.birth_date, place: p.birth_place, description: null, id: '' }, 0)
  const marriages = unions.filter((u) => u.family.kind === 'married').sort((a, b) => (yearOf(a.family.start_date) ?? 9999) - (yearOf(b.family.start_date) ?? 9999))
  for (const u of unions) {
    const f = u.family
    const withWhom = u.partner ? `with ${fullName(u.partner)}` : null
    if (f.start_date || f.start_place) {
      const type = f.kind === 'married' ? (marriages.indexOf(u) > 0 ? 'Remarriage' : 'Marriage') : f.kind === 'dating' ? 'Started dating' : 'Partnership'
      push({ type, date: f.start_date, place: f.start_place, description: withWhom, id: '' })
    }
    if (f.end_date || f.end_kind) push({ type: ENDING_LABEL[f.end_kind ?? 'divorced'] ?? 'Divorce', date: isEndWord(f.end_date) ? null : f.end_date, place: f.end_place ?? null, description: withWhom, id: '' })
    for (const c of u.children)
      if (c.birth_date) push({ type: `Birth of ${c.sex === 'M' ? 'son' : c.sex === 'F' ? 'daughter' : 'child'}`, date: c.birth_date, place: c.birth_place, description: fullName(c), id: '' })
  }
  for (const e of events) push(e)
  if (p.death_date || p.death_place) push({ type: 'Death', date: p.death_date, place: p.death_place, description: null, id: '' }, 2)
  // Birth, then everything dated by year, then the undated in the order they came, then death.
  const year = (e: TimelineEntry) => yearOf(e.date) ?? Number.MAX_SAFE_INTEGER
  return out
    .sort((a, b) => a.rank - b.rank || year(a) - year(b) || a.seq - b.seq)
    .map(({ rank, seq, ...e }) => e)
}

