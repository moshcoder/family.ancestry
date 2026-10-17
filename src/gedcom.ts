/**
 * GEDCOM 5.5.1 in and out.
 *
 * GEDCOM is the one format every genealogy site exports (Ancestry, FamilySearch,
 * MyHeritage, Gramps, RootsMagic), so it is how a family brings its tree here
 * and how it leaves again. The parser is lenient on purpose: real exports are
 * full of vendor tags (_UID, _APID, _MTTAG), odd line endings and a BOM, and a
 * tag we do not understand is skipped, not an error.
 *
 * What comes across: names, sex, birth, death, every other individual event
 * (BURI, CHR, BAPM, RESI, OCCU, IMMI, ...), notes (with CONT/CONC), families
 * with their marriage and divorce, children with their pedigree (birth, adopted,
 * foster), sources and the citations that point at them.
 *
 * Businesses ("Ettinger Plumbing") are not people, and GEDCOM has no record for
 * them, so they travel as a custom `_BUS` record that other programs skip:
 *
 *   0 @B1@ _BUS
 *   1 NAME Ettinger Plumbing        1 TYPE Plumbing
 *   1 _FOUNDED / 1 _CLOSED          each with 2 DATE
 *   1 PLAC, 1 WWW, 1 NOTE
 *   1 _ROLE @I3@                    2 TYPE founder, 2 TITL, 2 _FROM, 2 _TO, 2 NOTE
 *
 * So the people in it still show somewhere in other programs, each role is also
 * an OCCU on the person ("Founder, Ettinger Plumbing", DATE FROM .. TO ..),
 * marked `2 _BUS @B1@`. Coming back in, a marked OCCU is skipped: the _BUS
 * record is the truth, and the round trip never doubles a role into an event.
 */
import type { Store, Person } from './db.js'
import { BONDS, BUSINESS_ROLES, bondKind, businessRole, fullName } from './db.js'

export type GedLine = { level: number; xref: string | null; tag: string; value: string; children: GedLine[] }

/** Parse GEDCOM text into a tree of records. */
export function parseLines(text: string): GedLine[] {
  const roots: GedLine[] = []
  const stack: GedLine[] = []
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  for (const raw of lines) {
    const line = raw.replace(/^\s+/, '')
    if (!line) continue
    const m = line.match(/^(\d{1,2})\s+(?:(@[^@]+@)\s+)?([A-Za-z0-9_]+)(?:\s(.*))?$/)
    if (!m) continue
    const node: GedLine = { level: Number(m[1]), xref: m[2] ?? null, tag: m[3]!.toUpperCase(), value: m[4] ?? '', children: [] }
    while (stack.length && stack[stack.length - 1]!.level >= node.level) stack.pop()
    if (stack.length) stack[stack.length - 1]!.children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

const child = (node: GedLine, tag: string) => node.children.find((c) => c.tag === tag)
const childValue = (node: GedLine, tag: string) => child(node, tag)?.value.trim() || null

/** A value plus its CONT (new line) and CONC (same line) continuations. */
function fullText(node: GedLine): string {
  let text = node.value
  for (const c of node.children) {
    if (c.tag === 'CONT') text += `\n${c.value}`
    else if (c.tag === 'CONC') text += c.value
  }
  return text
}

/** "John /Smith/ Jr" -> given John, surname Smith. */
export function splitName(value: string): { given: string; surname: string } {
  const m = value.match(/^([^/]*)\/([^/]*)\/?(.*)$/)
  if (!m) return { given: value.trim(), surname: '' }
  const given = `${m[1]!.trim()} ${m[3]!.trim()}`.trim()
  return { given, surname: m[2]!.trim() }
}

const EVENT_LABELS: Record<string, string> = {
  BURI: 'Burial', CREM: 'Cremation', CHR: 'Christening', BAPM: 'Baptism', BARM: 'Bar mitzvah', BASM: 'Bat mitzvah',
  CONF: 'Confirmation', ADOP: 'Adoption', RESI: 'Residence', OCCU: 'Occupation', EDUC: 'Education', GRAD: 'Graduation',
  IMMI: 'Immigration', EMIG: 'Emigration', NATU: 'Naturalization', CENS: 'Census', MILI: 'Military', RETI: 'Retirement',
  RELI: 'Religion', PROB: 'Probate', WILL: 'Will', TITL: 'Title', NATI: 'Nationality', EVEN: 'Event', FACT: 'Fact',
}
const LABEL_TAGS = Object.fromEntries(Object.entries(EVENT_LABELS).map(([tag, label]) => [label.toLowerCase(), tag]))

export type ImportResult = { people: number; families: number; sources: number; events: number; skipped: number; warnings: string[]; businesses?: number }

/** GEDCOM doubles every @ in a value; undo it. */
const unat = (value: string | null) => (value === null ? null : value.replace(/@@/g, '@'))

/** Import a GEDCOM file into a tree. Runs in one transaction: a file either lands whole or not at all. */
export function importGedcom(store: Store, treeId: string, text: string): ImportResult {
  const records = parseLines(text)
  if (!records.some((r) => r.tag === 'HEAD') && !records.some((r) => r.tag === 'INDI')) throw new Error('this does not look like a GEDCOM file (no HEAD or INDI records)')
  const result: ImportResult = { people: 0, families: 0, sources: 0, events: 0, skipped: 0, warnings: [] }
  const people = new Map<string, string>()
  const sources = new Map<string, string>()
  const pendingCitations: { personId: string; sourceRef: string; page: string | null }[] = []

  store.tx(() => {
    for (const rec of records) {
      if (rec.tag !== 'SOUR' || !rec.xref) continue
      const src = store.addSource(treeId, {
        title: childValue(rec, 'TITL') ?? childValue(rec, 'ABBR') ?? 'Untitled source',
        author: childValue(rec, 'AUTH'),
        url: childValue(rec, 'WWW') ?? (child(rec, 'PUBL') && /^https?:/.test(childValue(rec, 'PUBL')!) ? childValue(rec, 'PUBL') : null),
        citation: child(rec, 'TEXT') ? fullText(child(rec, 'TEXT')!) : child(rec, 'PUBL') ? fullText(child(rec, 'PUBL')!) : null,
      })
      sources.set(rec.xref, src.id)
      result.sources++
    }

    for (const rec of records) {
      if (rec.tag !== 'INDI' || !rec.xref) continue
      const nameNode = child(rec, 'NAME')
      const name = nameNode ? splitName(nameNode.value) : { given: '', surname: '' }
      if (nameNode) {
        const givn = childValue(nameNode, 'GIVN')
        const surn = childValue(nameNode, 'SURN')
        if (!name.given && givn) name.given = givn
        if (!name.surname && surn) name.surname = surn
      }
      const birt = child(rec, 'BIRT')
      const deat = child(rec, 'DEAT')
      const notes = rec.children.filter((c) => c.tag === 'NOTE' && !c.value.startsWith('@')).map(fullText).join('\n\n')
      const sex = childValue(rec, 'SEX')
      const p = store.addPerson(treeId, {
        given: name.given,
        surname: name.surname,
        sex: sex ?? 'U',
        birth_date: birt ? childValue(birt, 'DATE') : null,
        birth_place: birt ? childValue(birt, 'PLAC') : null,
        death_date: deat ? childValue(deat, 'DATE') : null,
        death_place: deat ? childValue(deat, 'PLAC') : null,
        // GEDCOM has no "living" flag; the convention is: no death record and born within ~110 years.
        living: !deat && isProbablyLiving(birt ? childValue(birt, 'DATE') : null) ? 1 : 0,
        notes: notes || null,
      })
      people.set(rec.xref, p.id)
      result.people++

      for (const c of rec.children) {
        const label = EVENT_LABELS[c.tag]
        // A role we exported ourselves: the _BUS record brings it back as a role, not an event.
        if (label && !child(c, '_BUS')) {
          const type = c.tag === 'EVEN' || c.tag === 'FACT' ? (childValue(c, 'TYPE') ?? label) : label
          store.addEvent(treeId, p.id, { type, date: childValue(c, 'DATE'), place: childValue(c, 'PLAC'), description: c.value.trim() || (child(c, 'NOTE') ? fullText(child(c, 'NOTE')!) : null) })
          result.events++
        }
        if (c.tag === 'SOUR' && c.value.startsWith('@')) pendingCitations.push({ personId: p.id, sourceRef: c.value.trim(), page: childValue(c, 'PAGE') })
        for (const cc of c.children) if (cc.tag === 'SOUR' && cc.value.startsWith('@')) pendingCitations.push({ personId: p.id, sourceRef: cc.value.trim(), page: childValue(cc, 'PAGE') })
      }
    }

    // Pedigree lives on the child's FAMC line, so read it before walking families.
    const pedigree = new Map<string, string>()
    for (const rec of records) {
      if (rec.tag !== 'INDI' || !rec.xref) continue
      for (const famc of rec.children.filter((c) => c.tag === 'FAMC')) {
        const pedi = childValue(famc, 'PEDI')?.toLowerCase()
        if (pedi && pedi !== 'birth') pedigree.set(`${famc.value.trim()}|${rec.xref}`, pedi)
      }
    }

    for (const rec of records) {
      if (rec.tag !== 'FAM' || !rec.xref) continue
      const husb = childValue(rec, 'HUSB')
      const wife = childValue(rec, 'WIFE')
      const marr = child(rec, 'MARR')
      const div = child(rec, 'DIV')
      const p1 = husb ? (people.get(husb) ?? null) : null
      const p2 = wife ? (people.get(wife) ?? null) : null
      const kids = rec.children.filter((c) => c.tag === 'CHIL').map((c) => c.value.trim())
      if (!p1 && !p2 && !kids.length) {
        result.skipped++
        continue
      }
      const fam = store.createFamily(treeId, p1, p2 === p1 ? null : p2, {
        kind: marr ? 'married' : childValue(rec, 'TYPE')?.toLowerCase() ?? 'partners',
        start_date: marr ? childValue(marr, 'DATE') : null,
        start_place: marr ? childValue(marr, 'PLAC') : null,
        end_date: div ? (childValue(div, 'DATE') ?? 'Divorced') : null,
      })
      result.families++
      for (const kid of kids) {
        const pid = people.get(kid)
        if (!pid) {
          result.warnings.push(`family ${rec.xref} lists unknown child ${kid}`)
          continue
        }
        try {
          store.addChild(treeId, fam.id, pid, pedigree.get(`${rec.xref}|${kid}`) ?? 'birth')
        } catch (error) {
          result.warnings.push(`${rec.xref}: ${(error as Error).message}`)
        }
      }
    }

    for (const c of pendingCitations) {
      const sid = sources.get(c.sourceRef)
      if (sid) store.cite(treeId, sid, c.personId, c.page)
    }

    // ASSO + RELA: "raised by", godparents, guardians. An unknown RELA is kept as chosen family, with its words as the note.
    for (const rec of records) {
      if (rec.tag !== 'INDI' || !rec.xref) continue
      const from = people.get(rec.xref)
      for (const asso of rec.children.filter((c) => c.tag === 'ASSO')) {
        const to = people.get(asso.value.trim())
        const rela = childValue(asso, 'RELA') ?? ''
        if (!from || !to) continue
        const kind = bondKind(rela)
        try {
          store.addBond(treeId, from, to, kind && kind !== 'pet' ? kind : 'chosen_family', kind ? null : rela || null)
        } catch (error) {
          result.warnings.push(`${rec.xref}: ${(error as Error).message}`)
        }
      }
    }

    // _BUS: businesses, and the people who founded, owned or worked in them.
    for (const rec of records) {
      if (rec.tag !== '_BUS') continue
      const dateOf = (tag: string) => {
        const node = child(rec, tag)
        return node ? unat(childValue(node, 'DATE') ?? (node.value.trim() || null)) : null
      }
      const biz = store.addBusiness(treeId, {
        name: unat(childValue(rec, 'NAME')) ?? 'Unnamed business',
        category: unat(childValue(rec, 'TYPE')),
        founded: dateOf('_FOUNDED'),
        closed: dateOf('_CLOSED'),
        place: unat(childValue(rec, 'PLAC')),
        website: unat(childValue(rec, 'WWW')),
        notes: child(rec, 'NOTE') ? unat(fullText(child(rec, 'NOTE')!)) : null,
      })
      result.businesses = (result.businesses ?? 0) + 1
      for (const r of rec.children.filter((c) => c.tag === '_ROLE')) {
        const pid = people.get(r.value.trim())
        if (!pid) {
          result.warnings.push(`business ${rec.xref ?? biz.name} lists unknown person ${r.value.trim()}`)
          continue
        }
        try {
          store.addBusinessRole(treeId, biz.id, pid, {
            role: businessRole(childValue(r, 'TYPE')) ?? 'other',
            title: unat(childValue(r, 'TITL')),
            start_date: unat(childValue(r, '_FROM')),
            end_date: unat(childValue(r, '_TO')),
            note: child(r, 'NOTE') ? unat(fullText(child(r, 'NOTE')!)) : null,
          })
        } catch (error) {
          result.warnings.push(`${rec.xref ?? biz.name}: ${(error as Error).message}`)
        }
      }
    }
  })
  return result
}

export function isProbablyLiving(birthDate: string | null, now = new Date()): boolean {
  const year = birthDate?.match(/\b(\d{4})\b/)?.[1]
  if (!year) return false
  return now.getFullYear() - Number(year) < 110
}

/** GEDCOM lines must stay under 255 characters; long values split into CONC, newlines into CONT. */
function emitText(level: number, tag: string, text: string, out: string[]) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  lines.forEach((line, i) => {
    const chunks = line.match(/[\s\S]{1,200}/g) ?? ['']
    chunks.forEach((chunk, j) => {
      if (i === 0 && j === 0) out.push(`${level} ${tag}${chunk ? ` ${chunk}` : ''}`)
      else out.push(`${level + 1} ${j === 0 ? 'CONT' : 'CONC'}${chunk ? ` ${chunk}` : ''}`)
    })
  })
}

const gedSafe = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/@/g, '@@')

export type ExportOptions = { privacy?: boolean; source?: string }

/**
 * Export a tree as GEDCOM 5.5.1 (UTF-8). With privacy on, living people keep
 * their place in the tree but lose every detail except "Living" and the surname,
 * which is what a family should hand to anyone outside the family.
 */
export function exportGedcom(store: Store, treeId: string, options: ExportOptions = {}): string {
  const tree = store.tree(treeId)
  if (!tree) throw new Error('no such tree')
  // GEDCOM has no pets; they stay in the tree and out of the file.
  const people = store.people(treeId, 1_000_000).filter((p) => p.kind !== 'pet')
  const bonds = store.allBonds(treeId).filter((b) => b.kind !== 'pet')
  const families = store.families(treeId)
  const sources = store.sources(treeId)
  const links = store.childLinks(treeId)
  const events = store.allEvents(treeId)
  const citations = store.citationsAll(treeId)
  const businesses = store.businesses(treeId)
  const roles = store.allBusinessRoles(treeId)
  const bid = new Map(businesses.map((b, i) => [b.id, `@B${i + 1}@`]))
  const pid = new Map(people.map((p, i) => [p.id, `@I${i + 1}@`]))
  const fid = new Map(families.map((f, i) => [f.id, `@F${i + 1}@`]))
  const sid = new Map(sources.map((s, i) => [s.id, `@S${i + 1}@`]))
  const hidden = (p: Person) => options.privacy && p.living
  const out: string[] = []
  const today = new Date()
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

  out.push('0 HEAD', `1 SOUR ${options.source ?? 'FAMILY_ANCESTRY'}`, '2 NAME family.ancestry', '2 VERS 0.1', `1 DATE ${today.getUTCDate()} ${months[today.getUTCMonth()]} ${today.getUTCFullYear()}`)
  out.push('1 GEDC', '2 VERS 5.5.1', '2 FORM LINEAGE-LINKED', '1 CHAR UTF-8', `1 FILE ${gedSafe(tree.name)}.ged`, '1 SUBM @U1@', '0 @U1@ SUBM', `1 NAME ${gedSafe(tree.name)}`)

  for (const p of people) {
    out.push(`0 ${pid.get(p.id)} INDI`)
    if (hidden(p)) {
      out.push(`1 NAME Living /${gedSafe(p.surname)}/`)
      continue
    }
    out.push(`1 NAME ${gedSafe(p.given)} /${gedSafe(p.surname)}/`)
    if (p.given) out.push(`2 GIVN ${gedSafe(p.given)}`)
    if (p.surname) out.push(`2 SURN ${gedSafe(p.surname)}`)
    if (p.sex !== 'U') out.push(`1 SEX ${p.sex === 'X' ? 'U' : p.sex}`)
    if (p.birth_date || p.birth_place) {
      out.push('1 BIRT')
      if (p.birth_date) out.push(`2 DATE ${gedSafe(p.birth_date)}`)
      if (p.birth_place) out.push(`2 PLAC ${gedSafe(p.birth_place)}`)
    }
    if (p.death_date || p.death_place) {
      out.push('1 DEAT')
      if (p.death_date) out.push(`2 DATE ${gedSafe(p.death_date)}`)
      if (p.death_place) out.push(`2 PLAC ${gedSafe(p.death_place)}`)
    }
    for (const e of events.filter((e) => e.person_id === p.id)) {
      const tag = LABEL_TAGS[e.type.toLowerCase()]
      if (tag && tag !== 'EVEN') out.push(`1 ${tag}${e.description && ['OCCU', 'RESI', 'EDUC', 'RELI', 'TITL', 'NATI'].includes(tag) ? ` ${gedSafe(e.description)}` : ''}`)
      else out.push('1 EVEN', `2 TYPE ${gedSafe(e.type)}`)
      if (e.date) out.push(`2 DATE ${gedSafe(e.date)}`)
      if (e.place) out.push(`2 PLAC ${gedSafe(e.place)}`)
      if (e.description && !(tag && ['OCCU', 'RESI', 'EDUC', 'RELI', 'TITL', 'NATI'].includes(tag))) emitText(2, 'NOTE', e.description, out)
    }
    if (p.notes) emitText(1, 'NOTE', p.notes, out)
    for (const c of citations.filter((c) => c.person_id === p.id)) {
      out.push(`1 SOUR ${sid.get(c.source_id)}`)
      if (c.page) out.push(`2 PAGE ${gedSafe(c.page)}`)
    }
    for (const r of roles.filter((r) => r.person_id === p.id)) {
      const b = businesses.find((b) => b.id === r.business_id)
      if (!b) continue
      out.push(`1 OCCU ${gedSafe(`${r.title ?? BUSINESS_ROLES[r.role] ?? r.role}, ${b.name}`)}`)
      const when = [r.start_date ? `FROM ${r.start_date}` : '', r.end_date ? `TO ${r.end_date}` : ''].filter(Boolean).join(' ')
      if (when) out.push(`2 DATE ${gedSafe(when)}`)
      if (b.place) out.push(`2 PLAC ${gedSafe(b.place)}`)
      out.push(`2 _BUS ${bid.get(b.id)}`)
    }
    for (const l of links.filter((l) => l.person_id === p.id)) {
      out.push(`1 FAMC ${fid.get(l.family_id)}`)
      if (l.relation !== 'birth') out.push(`2 PEDI ${l.relation}`)
    }
    for (const f of families.filter((f) => f.partner1_id === p.id || f.partner2_id === p.id)) out.push(`1 FAMS ${fid.get(f.id)}`)
    for (const b of bonds.filter((b) => b.person_id === p.id && pid.has(b.other_id))) out.push(`1 ASSO ${pid.get(b.other_id)}`, `2 RELA ${gedSafe(BONDS[b.kind]?.as ?? b.kind)}`)
  }

  const byId = new Map(people.map((p) => [p.id, p]))
  for (const f of families) {
    out.push(`0 ${fid.get(f.id)} FAM`)
    const partners = [f.partner1_id, f.partner2_id].filter(Boolean).map((id) => byId.get(id!)!).filter(Boolean)
    // HUSB/WIFE are positional in 5.5.1: a known female partner goes in WIFE, otherwise keep partner order.
    let husb: Person | undefined
    let wife: Person | undefined
    if (partners.length === 1) partners[0]!.sex === 'F' ? (wife = partners[0]) : (husb = partners[0])
    else if (partners.length === 2) {
      wife = partners.find((p) => p.sex === 'F') ?? partners[1]
      husb = partners.find((p) => p !== wife)
    }
    if (husb) out.push(`1 HUSB ${pid.get(husb.id)}`)
    if (wife) out.push(`1 WIFE ${pid.get(wife.id)}`)
    if (!partners.some(hidden)) {
      if (f.kind === 'married') {
        out.push('1 MARR')
        if (f.start_date) out.push(`2 DATE ${gedSafe(f.start_date)}`)
        if (f.start_place) out.push(`2 PLAC ${gedSafe(f.start_place)}`)
      }
      // Not a marriage: say what it is (dating, partners), which import reads back from TYPE.
      else if (f.kind && f.kind !== 'partners') out.push(`1 TYPE ${gedSafe(f.kind)}`)
      if (f.end_date) out.push('1 DIV', ...(f.end_date === 'Divorced' ? [] : [`2 DATE ${gedSafe(f.end_date)}`]))
    }
    for (const l of links.filter((l) => l.family_id === f.id)) out.push(`1 CHIL ${pid.get(l.person_id)}`)
  }

  for (const s of sources) {
    out.push(`0 ${sid.get(s.id)} SOUR`, `1 TITL ${gedSafe(s.title)}`)
    if (s.author) out.push(`1 AUTH ${gedSafe(s.author)}`)
    if (s.url) out.push(`1 WWW ${gedSafe(s.url)}`)
    if (s.citation) emitText(1, 'TEXT', s.citation, out)
  }

  // Businesses: a custom record, so other programs skip it and ours brings it back whole.
  const byPerson = new Map(people.map((p) => [p.id, p]))
  for (const b of businesses) {
    out.push(`0 ${bid.get(b.id)} _BUS`, `1 NAME ${gedSafe(b.name)}`)
    if (b.category) out.push(`1 TYPE ${gedSafe(b.category)}`)
    if (b.founded) out.push('1 _FOUNDED', `2 DATE ${gedSafe(b.founded)}`)
    if (b.closed) out.push('1 _CLOSED', `2 DATE ${gedSafe(b.closed)}`)
    if (b.place) out.push(`1 PLAC ${gedSafe(b.place)}`)
    if (b.website) out.push(`1 WWW ${gedSafe(b.website)}`)
    if (b.notes) emitText(1, 'NOTE', b.notes.replace(/@/g, '@@'), out)
    for (const r of roles.filter((r) => r.business_id === b.id)) {
      const p = byPerson.get(r.person_id)
      // A living person hidden by privacy keeps only their name; what they do stays out too.
      if (!p || hidden(p)) continue
      out.push(`1 _ROLE ${pid.get(p.id)}`, `2 TYPE ${r.role}`)
      if (r.title) out.push(`2 TITL ${gedSafe(r.title)}`)
      if (r.start_date) out.push(`2 _FROM ${gedSafe(r.start_date)}`)
      if (r.end_date) out.push(`2 _TO ${gedSafe(r.end_date)}`)
      if (r.note) emitText(2, 'NOTE', r.note.replace(/@/g, '@@'), out)
    }
  }

  out.push('0 TRLR')
  return `${out.join('\r\n')}\r\n`
}

/** A one-line description, used by the CLI and MCP after an import. */
export const describeImport = (r: ImportResult) =>
  `${r.people} people, ${r.families} families, ${r.events} events, ${r.sources} sources${r.businesses ? `, ${r.businesses} businesses` : ''}${r.skipped ? `, ${r.skipped} empty families skipped` : ''}${r.warnings.length ? ` (${r.warnings.length} warnings)` : ''}`

export { fullName }
