/**
 * `ancestry`: family.ancestry from the terminal.
 */
import { PERSON_BONDS } from './db.js'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { AncestryClient, ApiError, readConfig, writeConfig, configPath, type BusinessDetail, type FeedPost, type BusinessSummary, type PersonDetail, type PhotoSummary, type TreeSummary } from './client.js'
import { VERSION } from './html.js'
import { fillCounts, fromMyna, MYNA_HISTORY, type OutPost } from './social-import.js'

const HELP = `ancestry ${VERSION}: private family trees, from the terminal

  ancestry login [--url URL]        sign in through the browser (or --token fa_...)
  ancestry logout | whoami
  ancestry trees                    list your trees
  ancestry new <name> [--from PICK,PICK...] [--no-share]
                                    start a tree; --from copies people you already have (see pickable)
  ancestry pickable                 people in your other trees and your network, with their PICK values
  ancestry bring <PICK...> [--tree T] [--no-share]
                                    copy them into a tree: families overlap. Links among them come along;
                                    anyone with an account becomes a viewer unless --no-share
  ancestry use <tree>               set the default tree (id or name)
  ancestry people [search]          list or search people
  ancestry show <person>            everything about one person
  ancestry add --given G --surname S [--nickname N] [--sex F|M] [--born DATE] [--birthplace P]
               [--died DATE] [--deathplace P] [--living]
               [--email E] [--phone P] [--address "1 Main St, Town CA"] [--link URL] [--social "instagram: @tony"]
               (on edit, contact flags add to what is there; "cell: 408 555 0100" labels a value)
               [--parent-of ID | --child-of ID | --partner-of ID | --sibling-of ID | --grandparent-of ID |
                --great-grandparent-of ID | --grandchild-of ID | --aunt-uncle-of ID | --niece-nephew-of ID | --cousin-of ID]
               [--relation birth|adopted|step|foster] [--sibling full|half|adopted|foster|step]
               [--kind married|engaged|partners|dating|divorced]   (for --partner-of; dating = boyfriend/girlfriend)
               [--via PARENT] [--raised]   (--raised: they raised that person)
  ancestry bond <person> <kind> <other>   kind: friend, best_friend, neighbor, roommate, coworker,
                                    business_partner, employer, client, doctor, classmate, teacher,
                                    mentor, raised_by, guardian, godparent, caregiver, chosen_family
                                    a bond that is not descent: "bond Sam raised_by Rose"
  ancestry status <person> <partner> <married|engaged|partners|dating|separated|divorced|widowed>
                                    their relationship status: "status David Karen married"
  ancestry pet <owner> <name> [--species Dog] [--born DATE]   (Family plan)
  ancestry plan [buy [--email you@x]]     the one-time Family plan for this tree (coin or PayPal)
  ancestry claim [person]           say which person you are (or add yourself)
  ancestry businesses [search]      family businesses (search matches names, trades, towns, people)
  ancestry business <name|id>       one business and its people
  ancestry business add <name> [--category Plumbing] [--founded D] [--closed D] [--place P]
               [--website W] [--note TEXT] [--founder P | --owner P | --partner P | --investor P | --employee P]
  ancestry business role <business> <person> <founder|owner|partner|investor|officer|manager|employee|apprentice|other>
               [--title T] [--from D] [--to D]         (role rm <role-id> removes one)
  ancestry business edit <business> --field value ...   (same flags as add)
  ancestry business rm <business>
  ancestry business link <business> <contact>     link it to one of your Network contacts (--create adds it)
  ancestry photos [--album A]       the family photos, newest first (or one album's)
  ancestry albums                   the family's photo albums   (albums add <title> starts one)
  ancestry upload <photo...> [--album A] [--caption C] [--of PERSON]
                                    add photos to the family album; --album names an album
                                    (made if new); any verified member can
  ancestry feed [--user NAME]       your family feed (you + who you subscribe to), or one person's posts
  ancestry post <text> [--family TREE]   post to everyone who knows you, or to one family
  ancestry subscribe <name|all> [--tree T]   subscribe to someone you know (all: everyone, or a family)
  ancestry unsubscribe <name>       stop seeing someone's posts
  ancestry comment <post> <text> | ancestry like <post>
  ancestry local [search] [--category Plumber]   businesses people you know recommend
  ancestry local add <name> --category C [--town T] [--phone P] [--website W] [--note TEXT]
                                    recommend a business to everyone who knows you
  ancestry edit <person> --field value ...     (same flags as add)
  ancestry event <person> <what> [--date D] [--place P] [--note TEXT] [--with PERSON] [--child PERSON]
               what: birth | death (their own dates) | marriage | remarriage | divorce | separation |
               widowed | started dating | engagement (--with the partner) | child born | adopted a child |
               became a step-parent (--child, or --child-given/--child-surname for someone new) |
               job change | retirement | graduation | military | moved | … or any other name
  ancestry pedigree <person> [-g 4] ancestors as a chart
  ancestry descendants <person> [-g 3]
  ancestry relate <person> <person> how two people are related
  ancestry import <file.ged> [--name N]   into a new tree (or --tree to merge into one)
  ancestry export [-o file.ged] [--privacy]
  ancestry invite <email...> [--file list.txt] [--role editor|viewer] [--as <person>] [--note TEXT]
                                    email invites; --file (or -) reads a pasted list;
                                    --as invites them to be that person
  ancestry members                  who is in the tree, and pending invites
  ancestry team <business> [invite <email> --as employee|manager|officer|partner|owner [--title T] [--note TEXT]]
               [rm <user-id>] [listing on|off [--note TEXT]] [invite|decline <request-id>]
                                    a business's team: they join the business, never the tree
  ancestry work                     businesses whose team you are on
  ancestry listing [on|off] [--note TEXT]   list the tree at /families: its name and your note, never the tree
  ancestry requests [invite|decline <id>]   people asking a listed tree for an invite
  ancestry families [search]        listed families you could ask to join
  ancestry ask <family-id> --name N --email E [--as family|friends|neighbors|business] [--note TEXT]
  ancestry profile [on|off] [--slug anthony.ettinger] [--name N] [--nickname N] [--city C] [--region R]
               [--country C] [--from TOWN] [--bio TEXT] [--email E] [--link URL] [--social "github: me"]
                                    your public profile at /profile/<slug>: only what you type, never the tree
  ancestry find [search] [--kind people|businesses|families] [--country C] [--region R] [--city C] [--category C]
                                    Find people: public profiles, listed businesses and families, with facets
  ancestry social [account] [--limit N]   your posts on other networks, with likes, reposts and replies
  ancestry social import [file] [--days 30] [--no-counts] [--skip account,...]
                                    send what myna posted (~/.config/myna/history.json, or a JSON list of
                                    {url, network, account, text, posted_at}); reads counts for the last --days
  ancestry social hide|show <account>   keep an account off your public profile, or put it back
  ancestry social rm <account> | --url URL

  ancestry contacts [search] [--circle family|friends|neighbors|business]
  ancestry contact add --name N [--email E] [--phone P] [--circle C] [--relationship R]
               [--company C] [--title T] [--birthday D] [--address TEXT] [--link URL] [--note TEXT]
               [--connect [--say TEXT]]   also email them to connect
  ancestry contact add --person <person> [--circle friends] [--email E] [--connect [--say TEXT]]
                                    someone in your tree, into your network (add a friend)
  ancestry contact <name|id>        everything about one contact   (contact rm <id> removes)
  ancestry contacts import <file.vcf> [--circle C] | export [-o file.vcf]
  ancestry connect <contact> [--note TEXT]   ask them to connect (one email)
  ancestry inbox                    your conversations
  ancestry message <contact> <text...>       write to someone you are connected with
  ancestry recommend <contact> --to <who> [--note TEXT]   pass a contact on to someone you know
  ancestry recommendations [save <id>]       what people recommended to you
  ancestry thread <contact>         read a conversation

  ancestry open [person]            open the tree (or a person) in the browser
  ancestry tui                      browse in a terminal app
  ancestry mcp                      MCP server on stdio (claude mcp add ancestry -- ancestry mcp)
  ancestry serve [--port 8792]      run your own family.ancestry server

  Flags: --tree <id|name> picks a tree, --json prints JSON.
  Env: ANCESTRY_URL (default https://family.ancestry), ANCESTRY_TOKEN.
  Config: ${configPath()}
`

type Args = { _: string[]; flags: Record<string, string | true> }

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  const short: Record<string, string> = { g: 'generations', o: 'output', h: 'help', v: 'version' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    const m = a.match(/^--?([A-Za-z][\w-]*)(?:=(.*))?$/)
    if (m) {
      const key = short[m[1]!] ?? m[1]!
      if (m[2] !== undefined) out.flags[key] = m[2]
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-') && !['living', 'json', 'privacy', 'help', 'version', 'full', 'raised', 'create', 'no-share'].includes(key)) out.flags[key] = argv[++i]!
      else out.flags[key] = true
    } else out._.push(a)
  }
  return out
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined)

/** Flags to person fields. */
export function personFields(flags: Record<string, string | true>): Record<string, unknown> {
  const map: Record<string, string> = { given: 'given', first: 'given', surname: 'surname', last: 'surname', nickname: 'nickname', nick: 'nickname', sex: 'sex', born: 'birth_date', birthplace: 'birth_place', died: 'death_date', deathplace: 'death_place', notes: 'notes', note: 'notes' }
  const out: Record<string, unknown> = {}
  for (const [flag, field] of Object.entries(map)) if (typeof flags[flag] === 'string') out[field] = flags[flag]
  if (flags.living === true) out.living = true
  if (flags['not-living'] === true) out.living = false
  Object.assign(out, personCardFlags(flags))
  return out
}

/** --email/--phone/--address/--link/--social on a person: one value each, "label: value" allowed. */
export function personCardFlags(flags: Record<string, string | true>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof flags.email === 'string') out.emails = [flags.email]
  if (typeof flags.phone === 'string') out.phones = [flags.phone]
  if (typeof flags.address === 'string') out.addresses = flags.address.replace(/,\s*/g, '\n')
  if (typeof flags.link === 'string') out.links = [flags.link]
  if (typeof flags.social === 'string') out.socials = [flags.social]
  return out
}

/** Flags to contact fields. --email/--phone/--address/--link take one value; the web form takes many. */
export function contactFields(flags: Record<string, string | true>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['name', 'nickname', 'circle', 'relationship', 'company', 'title', 'birthday', 'anniversary'] as const) if (typeof flags[key] === 'string') out[key] = flags[key]
  if (typeof flags.note === 'string' || typeof flags.notes === 'string') out.notes = str(flags.note) ?? str(flags.notes)
  if (typeof flags.email === 'string') out.emails = [flags.email]
  if (typeof flags.phone === 'string') out.phones = [flags.phone]
  if (typeof flags.address === 'string') out.addresses = [{ label: null, lines: flags.address.replace(/,\s*/g, '\n') }]
  if (typeof flags.link === 'string') out.links = [flags.link]
  return out
}

type Contact = Awaited<ReturnType<AncestryClient['contacts']>>[number]
const formatContactLine = (c: Contact) => `${c.id}  ${c.name || c.emails[0]?.value}  ${[c.circle, c.relationship, c.company].filter(Boolean).join(' · ')}${c.linked_user_id ? '  (connected)' : ''}`

export function formatContact(c: Contact): string {
  const lines = [`${c.name || c.emails[0]?.value}${c.nickname ? ` "${c.nickname}"` : ''}  [${c.id}]`, `  ${[c.circle, c.relationship, [c.title, c.company].filter(Boolean).join(' at ')].filter(Boolean).join(' · ')}`]
  for (const e of c.emails) lines.push(`  ${(e.label ?? 'email').padEnd(10)} ${e.value}`)
  for (const p of c.phones) lines.push(`  ${(p.label ?? 'phone').padEnd(10)} ${p.value}`)
  for (const a of c.addresses) lines.push(`  ${(a.label ?? 'address').padEnd(10)} ${a.lines.replace(/\n/g, ', ')}`)
  for (const l of c.links) lines.push(`  ${(l.label ?? 'link').padEnd(10)} ${l.value}`)
  if (c.birthday) lines.push(`  ${'birthday'.padEnd(10)} ${c.birthday}`)
  if (c.anniversary) lines.push(`  ${'anniversary'.padEnd(10)} ${c.anniversary}`)
  if (c.linked_user_id) lines.push(`  connected; message with: ancestry message ${c.id} ...`)
  if (c.notes) lines.push('', ...c.notes.split('\n').map((l) => `  ${l}`))
  return lines.join('\n')
}

async function pickContact(client: AncestryClient, ref: string | undefined): Promise<Contact> {
  if (!ref) throw new Error('which contact? give a name, email or id')
  if (/^[A-Za-z0-9_-]{12}$/.test(ref)) {
    const hit = await client.contact(ref).catch(() => null)
    if (hit) return hit
  }
  const found = await client.contacts(ref)
  if (found.length === 1) return found[0]!
  if (!found.length) throw new Error(`nobody in your network matches "${ref}"`)
  throw new Error(`"${ref}" matches ${found.length} contacts:\n${found.slice(0, 10).map((c) => `  ${formatContactLine(c)}`).join('\n')}`)
}

/** A user id to talk to: from a connected contact, or someone already in your inbox. */
async function pickCorrespondent(client: AncestryClient, ref: string | undefined): Promise<string> {
  if (!ref) throw new Error('who? give a contact name or id')
  const box = await client.inbox()
  const people = [...box.threads.map((t) => t.with), ...box.reachable]
  const direct = people.find((u) => u.id === ref || u.email === ref.toLowerCase() || (u.name ?? '').toLowerCase() === ref.toLowerCase())
  if (direct) return direct.id
  const c = await pickContact(client, ref)
  if (!c.linked_user_id) throw new Error(`you are not connected with ${c.name} yet: ancestry connect "${c.name}"`)
  return c.linked_user_id
}

export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

async function pickTree(client: AncestryClient, flag: string | true | undefined): Promise<TreeSummary> {
  const trees = await client.trees()
  const want = str(flag) ?? readConfig().tree
  if (want) {
    const t = trees.find((t) => t.id === want) ?? trees.find((t) => t.name.toLowerCase() === want.toLowerCase())
    if (!t) throw new Error(`no tree "${want}". Your trees: ${trees.map((t) => t.name).join(', ') || 'none'}`)
    return t
  }
  if (trees.length === 1) return trees[0]!
  if (!trees.length) throw new Error('you have no trees yet: ancestry new "My family" or ancestry import file.ged')
  throw new Error(`you have ${trees.length} trees; pick one with --tree <name> or ancestry use <name>`)
}

/** A person id, or a name to search for (must match exactly one person). */
async function pickPerson(client: AncestryClient, tree: string, ref: string | undefined): Promise<string> {
  if (!ref) throw new Error('which person? give an id or a name')
  if (/^[A-Za-z0-9_-]{12}$/.test(ref)) {
    const hit = await client.person(tree, ref).catch((error) => (error instanceof ApiError && error.status === 404 ? null : Promise.reject(error)))
    if (hit) return hit.id
  }
  const found = await client.people(tree, ref, 10)
  if (found.length === 1) return found[0]!.id
  if (!found.length) throw new Error(`nobody matches "${ref}"`)
  throw new Error(`"${ref}" matches ${found.length} people:\n${found.map((p) => `  ${p.id}  ${p.name} ${years(p)}`).join('\n')}`)
}

/** A business id, or a name to search for (must match exactly one). */
async function pickBusiness(client: AncestryClient, tree: string, ref: string | undefined): Promise<string> {
  if (!ref) throw new Error('which business? give an id or a name')
  if (/^[A-Za-z0-9_-]{12}$/.test(ref)) {
    const hit = await client.business(tree, ref).catch((error) => (error instanceof ApiError && error.status === 404 ? null : Promise.reject(error)))
    if (hit) return hit.id
  }
  const found = await client.businesses(tree, ref, 10)
  const exact = found.filter((b) => b.name.toLowerCase() === ref.toLowerCase())
  if (found.length === 1 || exact.length === 1) return (exact[0] ?? found[0])!.id
  if (!found.length) throw new Error(`no business matches "${ref}"`)
  throw new Error(`"${ref}" matches ${found.length} businesses:\n${found.map((b) => `  ${b.id}  ${b.name}`).join('\n')}`)
}

/** Flags to business fields. */
export function businessFields(flags: Record<string, string | true>): Record<string, unknown> {
  const map: Record<string, string> = { name: 'name', category: 'category', kind: 'category', founded: 'founded', closed: 'closed', place: 'place', town: 'place', website: 'website', note: 'notes', notes: 'notes' }
  const out: Record<string, unknown> = {}
  for (const [flag, field] of Object.entries(map)) if (typeof flags[flag] === 'string') out[field] = flags[flag]
  return out
}

const bizYears = (b: { founded: string | null; closed: string | null }) => {
  const y = (d: string | null) => d?.match(/\b(\d{4})\b/)?.[1]
  return b.founded || b.closed ? `(${y(b.founded) ?? '?'}–${y(b.closed) ?? ''})` : ''
}

export const formatBusinessLine = (b: BusinessSummary) => `${b.id}  ${b.name} ${bizYears(b)}${b.category ? `  ${b.category}` : ''}${b.place ? `, ${b.place}` : ''}`

export function formatBusiness(b: BusinessSummary | BusinessDetail): string {
  const lines = [`${b.name} ${bizYears(b)}`, `  id ${b.id}  ${b.url}`]
  if (b.category) lines.push(`  what    ${b.category}`)
  if (b.founded) lines.push(`  founded ${b.founded}`)
  if (b.closed) lines.push(`  closed  ${b.closed}`)
  if (b.place) lines.push(`  where   ${b.place}`)
  if (b.website) lines.push(`  web     ${b.website}`)
  if ('contact' in b && b.contact) lines.push(`  in your network: ${b.contact.name} [${b.contact.id}]`)
  for (const r of b.people) lines.push(`  ${r.label.toLowerCase()} ${r.name} [${r.id}]${r.start_date || r.end_date ? ` ${r.start_date ?? '?'}–${r.end_date ?? ''}` : ''}  (role ${r.role_id})`)
  if (b.notes) lines.push('', ...b.notes.split('\n').map((l) => `  ${l}`))
  return lines.join('\n')
}

const years = (p: { birth_date: string | null; death_date: string | null }) => {
  const y = (d: string | null) => d?.match(/\b(\d{4})\b/)?.[1]
  const b = y(p.birth_date)
  const d = y(p.death_date)
  return b || d ? `(${b ?? '?'}–${d ?? ''})` : ''
}

/** Someone you know, by id or by (part of) their name. */
async function feedPerson(client: AncestryClient, who: string): Promise<{ id: string; name: string }> {
  const people = await client.feedPeople()
  const q = who.trim().toLowerCase()
  if (!q) throw new Error('name someone: ancestry feed --user "Aunt Rose"')
  const hit = people.find((p) => p.id === who) ?? people.find((p) => p.name.toLowerCase() === q) ?? people.filter((p) => p.name.toLowerCase().includes(q))
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0]!
    throw new Error(hit.length ? `which one? ${hit.map((p) => `${p.name} (${p.id})`).join(', ')}` : `nobody you know matches "${who}"`)
  }
  return hit
}

export function formatPost(p: FeedPost): string {
  const lines = [`${p.author.name}  ${new Date(p.created_at).toISOString().slice(0, 16).replace('T', ' ')}  ${p.family ? `to ${p.family}` : 'to everyone'}  [${p.id}]`]
  if (p.body) lines.push(...p.body.split('\n').map((l) => `  ${l}`))
  if (p.photo_url) lines.push('  (photo)')
  if (p.likes) lines.push(`  ♥ ${p.likes}${p.liked ? ' (you)' : ''}`)
  for (const c of p.comments) lines.push(`    ${c.author.name}: ${c.body}`)
  return lines.join('\n')
}

const WIDER = new Set(['Grandparents', 'Grandchildren', 'Aunts and uncles', 'Nieces and nephews', 'Cousins'])

export function formatPerson(p: PersonDetail): string {
  const lines = [`${p.name}${p.nickname ? ` "${p.nickname}"` : ''} ${years(p)}`, `  id ${p.id}  ${p.url}`]
  if (p.birth_date || p.birth_place) lines.push(`  born   ${[p.birth_date, p.birth_place].filter(Boolean).join(', ')}`)
  if (p.death_date || p.death_place) lines.push(`  died   ${[p.death_date, p.death_place].filter(Boolean).join(', ')}`)
  else if (p.living) lines.push('  living')
  const card = p.contact
  for (const x of card?.phones ?? []) lines.push(`  ${x.label ?? 'phone'}  ${x.value}`)
  for (const x of card?.emails ?? []) lines.push(`  ${x.label ?? 'email'}  ${x.value}`)
  for (const x of card?.addresses ?? []) lines.push(`  ${x.label ?? 'address'}  ${x.lines.replace(/\n/g, ', ')}`)
  for (const x of card?.socials ?? []) lines.push(`  ${x.label ?? 'social'}  ${x.value}`)
  for (const x of card?.links ?? []) lines.push(`  ${x.label ?? 'link'}  ${x.value}`)
  for (const f of p.parents) lines.push(`  parents ${f.parents.map((x) => `${x.name} [${x.id}]`).join(' & ') || 'unknown'}${f.relation !== 'birth' ? ` (${f.relation})` : ''}`)
  if (p.siblings?.length) lines.push(`  siblings ${p.siblings.map((x) => `${x.name}${x.kind !== 'full' ? ` (${x.kind})` : ''}`).join(', ')}`)
  for (const b of p.bonds ?? []) lines.push(`  ${b.label.toLowerCase()} ${b.other.name} [${b.other.id}]${b.note ? `, ${b.note}` : ''}`)
  // The wider family the lines above leave out (store.circle).
  for (const g of p.circle?.groups ?? []) if (WIDER.has(g.label)) lines.push(`  ${g.label.toLowerCase()} ${g.people.map((x) => `${x.name}${x.tag ? ` (${x.tag})` : ''} [${x.id}]`).join(', ')}`)
  if (p.pets?.length) lines.push(`  pets ${p.pets.map((x) => `${x.name}${x.species ? ` (${x.species})` : ''}`).join(', ')}`)
  for (const b of p.businesses ?? []) lines.push(`  ${b.label.toLowerCase()} ${b.business.name} [${b.business.id}]${b.start_date || b.end_date ? ` ${b.start_date ?? '?'}–${b.end_date ?? ''}` : ''}`)
  for (const u of p.unions) {
    lines.push(`  ${u.kind} ${u.partner ? `${u.partner.name} [${u.partner.id}]` : 'unknown partner'}${u.start_date ? ` ${u.start_date}` : ''}${u.end_date ? `, ended ${u.end_date}` : ''}`)
    for (const c of u.children) lines.push(`    child ${c.name} [${c.id}]`)
  }
  for (const e of p.events) lines.push(`  ${e.type.toLowerCase()} ${[e.date, e.place, e.description].filter(Boolean).join(', ')}`)
  for (const s of p.sources) lines.push(`  source ${s.title}${s.page ? `, ${s.page}` : ''}${s.url ? ` <${s.url}>` : ''}`)
  if (p.notes) lines.push('', ...p.notes.split('\n').map((l) => `  ${l}`))
  return lines.join('\n')
}

/** A sideways pedigree: root on the left, each generation indented, father above mother. */
export function formatPedigree(ancestors: { n: number; name: string; birth_date: string | null; death_date: string | null }[], generations: number): string {
  const byN = new Map(ancestors.map((a) => [a.n, a]))
  const lines: string[] = []
  const walk = (n: number, depth: number, prefix: string, last: boolean) => {
    const a = byN.get(n)
    if (!a || depth >= generations) return
    lines.push(`${prefix}${depth ? (last ? '└─ ' : '├─ ') : ''}${a.name} ${years(a)}  #${n}`)
    const next = prefix + (depth ? (last ? '   ' : '│  ') : '')
    const kids = [2 * n, 2 * n + 1].filter((k) => byN.has(k))
    kids.forEach((k, i) => walk(k, depth + 1, next, i === kids.length - 1))
  }
  walk(1, 0, '', true)
  return lines.join('\n')
}

export function formatDescendants(d: any, prefix = '', isLast = true, root = true): string {
  const lines: string[] = [`${prefix}${root ? '' : isLast ? '└─ ' : '├─ '}${[d.person.given, d.person.surname].filter(Boolean).join(' ') || 'Unnamed'} ${years(d.person)}`]
  const childPrefix = prefix + (root ? '' : isLast ? '   ' : '│  ')
  d.unions.forEach((u: any, ui: number) => {
    const lastUnion = ui === d.unions.length - 1
    lines.push(`${childPrefix}${lastUnion ? '└─' : '├─'} & ${u.partner ? [u.partner.given, u.partner.surname].filter(Boolean).join(' ') : 'unknown'}`)
    const p2 = childPrefix + (lastUnion ? '   ' : '│  ')
    u.children.forEach((c: any, ci: number) => lines.push(formatDescendants(c, p2, ci === u.children.length - 1, false)))
  })
  return lines.join('\n')
}

/** Browser sign-in: authorization code + PKCE (S256), delivered to a loopback listener. */
async function login(client: AncestryClient, flags: Record<string, string | true>) {
  if (typeof flags.token === 'string') {
    client.token = flags.token
    const me = await client.me()
    writeConfig({ ...readConfig(), url: client.base, token: flags.token, email: me.user.email })
    return console.log(`Signed in as ${me.user.email}.`)
  }
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(12).toString('base64url')
  let resolve!: (code: string) => void
  let reject!: (error: Error) => void
  const got = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)))
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/callback') return new Response('not found', { status: 404 })
      if (url.searchParams.get('state') !== state) {
        reject(new Error('state mismatch: start ancestry login again'))
        return new Response('State mismatch. Run ancestry login again.', { status: 400 })
      }
      resolve(url.searchParams.get('code') ?? '')
      return new Response('<!doctype html><meta charset=utf-8><title>Signed in</title><body style="font:16px system-ui;padding:40px">Signed in. You can close this tab and go back to the terminal.</body>', { headers: { 'content-type': 'text/html' } })
    },
  })
  const redirect = `http://127.0.0.1:${server.port}/callback`
  const host = (await import('node:os')).hostname()
  const url = `${client.base}/cli/authorize?${new URLSearchParams({ response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirect, state, label: `ancestry CLI on ${host}` })}`
  console.log(`Opening your browser to sign in. If it does not open, visit:\n\n  ${url}\n`)
  console.log(`(Can't open ${new URL(client.base).hostname} in a browser? Make a token in Settings and run: ancestry login --token fa_...)`)
  openUrl(url)
  const timer = setTimeout(() => reject(new Error('timed out waiting for the browser (5 minutes)')), 5 * 60_000)
  try {
    const code = await got
    const res = await client.request<{ access_token: string }>('/api/v1/cli/token', { method: 'POST', json: { code, code_verifier: verifier, redirect_uri: redirect } })
    client.token = res.access_token
    const me = await client.me()
    writeConfig({ ...readConfig(), url: client.base, token: res.access_token, email: me.user.email })
    console.log(`Signed in as ${me.user.email}. Token saved to ${configPath()}.`)
  } finally {
    clearTimeout(timer)
    server.stop(true)
  }
}

export const formatPhotoLine = (p: PhotoSummary) => `${p.id}  ${new Date(p.created_at).toISOString().slice(0, 10)}  ${p.caption ?? p.filename}${p.uploader ? `  (${p.uploader})` : ''}`

/** An album by id or title. Throws when there is none, unless `must` is false (then ''). */
async function pickAlbum(client: AncestryClient, tree: string, ref: string, must = true): Promise<string> {
  const { albums } = await client.albums(tree)
  const hit = albums.find((a) => a.id === ref) ?? albums.find((a) => a.title.toLowerCase() === ref.toLowerCase()) ?? albums.find((a) => a.title.toLowerCase().includes(ref.toLowerCase()))
  if (!hit && must) throw new Error(`no album called "${ref}" (ancestry albums lists them)`)
  return hit?.id ?? ''
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const [cmd, ...rest] = args._
  const f = args.flags
  const asJson = f.json === true
  const print = (value: unknown, text: () => string) => console.log(asJson ? JSON.stringify(value, null, 2) : text())
  if (f.version) return console.log(VERSION), 0
  if (!cmd || cmd === 'help' || f.help) {
    console.log(HELP)
    return 0
  }
  if (cmd === 'serve') {
    if (typeof f.port === 'string') process.env.PORT = f.port
    await import('./server.js').then((m) => m.serve())
    return new Promise(() => {}) as Promise<number>
  }
  if (cmd === 'mcp') {
    await (await import('./mcp.js')).runMcp()
    return new Promise(() => {}) as Promise<number>
  }
  const client = new AncestryClient({ url: str(f.url) })
  if (cmd === 'tui') {
    await (await import('./tui.js')).runTui(client)
    return 0
  }
  try {
    switch (cmd) {
      case 'login':
        await login(client, f)
        return 0
      case 'logout': {
        const { token: _t, email: _e, ...keep } = readConfig()
        writeConfig(keep)
        console.log('Signed out on this machine. Revoke the token in Settings to cut it off everywhere.')
        return 0
      }
      case 'whoami': {
        const me = await client.me()
        print(me, () => `${me.user.email}${me.user.name ? ` (${me.user.name})` : ''} on ${client.base}, ${me.trees.length} tree${me.trees.length === 1 ? '' : 's'}`)
        return 0
      }
      case 'trees': {
        const trees = await client.trees()
        const current = readConfig().tree
        print(trees, () => (trees.length ? trees.map((t) => `${t.id === current ? '*' : ' '} ${t.id}  ${t.name}  (${t.people} people, ${t.role})`).join('\n') : 'No trees yet: ancestry new "My family"'))
        return 0
      }
      case 'new': {
        const from = (str(f.from) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const tree = await client.createTree(rest.join(' ') || 'Family tree', str(f.description), from, f['no-share'] !== true)
        writeConfig({ ...readConfig(), tree: tree.id })
        print(tree, () => `Started ${tree.name} (${tree.id}); it is now your default tree.${tree.added ? ` Copied in ${tree.added} ${tree.added === 1 ? 'person' : 'people'}${tree.shared ? `; ${tree.shared} can now see it` : ''}${tree.emailed.length ? ` (emailed ${tree.emailed.join(', ')})` : ''}.` : ''}`)
        return 0
      }
      case 'pickable': {
        const current = readConfig().tree
        const r = await client.pickable(str(f.tree) ?? current)
        print(r, () => [...r.trees.map((t) => `${t.name}\n${t.people.map((p) => `  ${p.pick}  ${p.name}${p.birth_date || p.death_date ? ` (${p.birth_date ?? ''}-${p.death_date ?? ''})` : ''}`).join('\n')}`), r.contacts.length ? `Your network\n${r.contacts.map((k) => `  ${k.pick}  ${k.name}  ${k.circle}${k.has_account ? ', has an account' : ''}`).join('\n')}` : ''].filter(Boolean).join('\n') || 'Nobody to pick yet.')
        return 0
      }
      case 'bring': {
        const tree = await pickTree(client, f.tree)
        if (!rest.length) throw new Error('name at least one PICK value: ancestry pickable lists them')
        const r = await client.bringPeople(tree.id, rest, f['no-share'] !== true)
        print(r, () => `Copied ${r.added} ${r.added === 1 ? 'person' : 'people'} into ${tree.name}${r.shared ? `; ${r.shared} can now see it` : ''}${r.emailed?.length ? ` (emailed ${r.emailed.join(', ')})` : ''}.`)
        return 0
      }
      case 'use': {
        const tree = await pickTree(client, rest.join(' ') || undefined)
        writeConfig({ ...readConfig(), tree: tree.id })
        console.log(`Default tree: ${tree.name} (${tree.id})`)
        return 0
      }
      case 'search': {
        const tree = await pickTree(client, f.tree)
        const r = await client.search(tree.id, rest.join(' '), Number(f.limit) || 100)
        print(r, () => [...r.people.map((p) => `${p.id}  ${p.name} ${years(p)}`), ...r.businesses.map((b) => `${formatBusinessLine(b)}  [business]`)].join('\n') || 'Nothing found.')
        return 0
      }
      case 'businesses': {
        const tree = await pickTree(client, f.tree)
        const list = await client.businesses(tree.id, rest.join(' '), Number(f.limit) || 200)
        print(list, () => (list.length ? list.map(formatBusinessLine).join('\n') : 'No businesses found.'))
        return 0
      }
      case 'photos': {
        const tree = await pickTree(client, f.tree)
        const album = typeof f.album === 'string' ? await pickAlbum(client, tree.id, f.album) : ''
        const list = await client.photos(tree.id, album, Number(f.limit) || 200)
        print(list, () => (list.length ? list.map(formatPhotoLine).join('\n') : 'No photos yet.'))
        return 0
      }
      case 'albums': {
        const tree = await pickTree(client, f.tree)
        if (rest[0] === 'add') {
          const title = rest.slice(1).join(' ')
          if (!title) throw new Error('ancestry albums add <title> [--description TEXT]')
          const a = await client.addAlbum(tree.id, title, str(f.description))
          print(a, () => `${a.id}  ${a.title}\n${a.url}`)
          return 0
        }
        const { albums } = await client.albums(tree.id)
        print(albums, () => (albums.length ? albums.map((a) => `${a.id}  ${a.title}  (${a.photos ?? 0} photo${a.photos === 1 ? '' : 's'})`).join('\n') : 'No albums yet.'))
        return 0
      }
      case 'upload': {
        const tree = await pickTree(client, f.tree)
        if (!rest.length) throw new Error('ancestry upload <photo...> [--album A] [--caption C] [--of PERSON]')
        const fields: { caption?: string; album_id?: string; album_title?: string; person_id?: string } = { caption: str(f.caption) }
        if (typeof f.album === 'string') {
          const id = await pickAlbum(client, tree.id, f.album, false)
          if (id) fields.album_id = id
          else fields.album_title = f.album
        }
        if (typeof f.of === 'string') fields.person_id = await pickPerson(client, tree.id, f.of)
        const out: string[] = []
        for (const file of rest) {
          const r = await client.uploadPhoto(tree.id, basename(file), new Uint8Array(readFileSync(file)), fields)
          if (r.album) (fields.album_id = r.album.id), delete fields.album_title
          for (const p of r.saved) out.push(`added ${file}  ${p.page}`)
          for (const why of r.refused) out.push(`not added: ${why}`)
        }
        console.log(out.join('\n'))
        return 0
      }
      case 'business': {
        const tree = await pickTree(client, f.tree)
        const [sub, ...more] = rest
        if (sub === 'add') {
          const name = more.join(' ') || str(f.name)
          if (!name) throw new Error('ancestry business add <name> [--category C] [--founded D] [--founder PERSON]')
          const people = []
          for (const role of ['founder', 'owner', 'partner', 'investor', 'officer', 'manager', 'employee']) if (typeof f[role] === 'string') people.push({ person_id: await pickPerson(client, tree.id, f[role] as string), role, title: str(f.title), start_date: str(f.from), end_date: str(f.to) })
          const b = await client.addBusiness(tree.id, { ...businessFields(f), name, people })
          print(b, () => `Added ${b.name} (${b.id}).\n\n${formatBusiness(b)}`)
          return 0
        }
        if (sub === 'role') {
          if (more[0] === 'rm') {
            if (!more[1]) throw new Error('ancestry business role rm <role-id>')
            await client.removeBusinessRole(tree.id, more[1])
            return console.log('Removed.'), 0
          }
          const [biz, who, role] = more
          if (!biz || !who || !role) throw new Error('ancestry business role <business> <person> <founder|owner|partner|investor|officer|manager|employee|apprentice|other>')
          const b = await client.addBusinessRole(tree.id, await pickBusiness(client, tree.id, biz), { person_id: await pickPerson(client, tree.id, who), role, title: str(f.title), start_date: str(f.from), end_date: str(f.to), note: str(f.note) })
          print(b, () => formatBusiness(b))
          return 0
        }
        if (sub === 'edit') {
          const b = await client.updateBusiness(tree.id, await pickBusiness(client, tree.id, more.join(' ')), businessFields(f))
          print(b, () => formatBusiness(b))
          return 0
        }
        if (sub === 'rm') {
          const id = await pickBusiness(client, tree.id, more.join(' '))
          await client.deleteBusiness(tree.id, id)
          return console.log(`Deleted ${id}. The people in it stay in the tree.`), 0
        }
        if (sub === 'link') {
          const [biz, ...contact] = more
          if (!biz || (!contact.length && f.create !== true)) throw new Error('ancestry business link <business> <contact>  (or --create)')
          const id = await pickBusiness(client, tree.id, biz)
          const b = await client.linkBusinessContact(tree.id, id, f.create === true ? { create: true } : { contact_id: (await pickContact(client, contact.join(' '))).id })
          print(b, () => (b.contact ? `${b.name} is linked to ${b.contact.name} in your network.` : 'Unlinked.'))
          return 0
        }
        const b = await client.business(tree.id, await pickBusiness(client, tree.id, rest.join(' ')))
        print(b, () => formatBusiness(b))
        return 0
      }
      case 'people': {
        const tree = await pickTree(client, f.tree)
        const people = await client.people(tree.id, rest.join(' '), Number(f.limit) || 200)
        print(people, () => (people.length ? people.map((p) => `${p.id}  ${p.name} ${years(p)}${p.birth_place ? `  ${p.birth_place}` : ''}`).join('\n') : 'Nobody found.'))
        return 0
      }
      case 'show':
      case 'person': {
        const tree = await pickTree(client, f.tree)
        const p = await client.person(tree.id, await pickPerson(client, tree.id, rest.join(' ')))
        print(p, () => formatPerson(p))
        return 0
      }
      case 'add': {
        const tree = await pickTree(client, f.tree)
        const fields = personFields(f)
        const rel = (['parent-of', 'child-of', 'partner-of', 'sibling-of', 'grandparent-of', 'great-grandparent-of', 'grandchild-of', 'aunt-uncle-of', 'niece-nephew-of', 'cousin-of'] as const).find((k) => typeof f[k] === 'string')
        if (rel) {
          // "add --parent-of X" adds a parent TO X; "--child-of X" adds a child to X.
          Object.assign(fields, {
            relative_of: await pickPerson(client, tree.id, str(f[rel])),
            as: rel.replace('-of', '').replace(/-/g, '_'),
            relation: str(f.relation) ?? 'birth',
            kind: str(f.kind),
            sibling: str(f.sibling),
            via: typeof f.via === 'string' ? await pickPerson(client, tree.id, f.via) : undefined,
            raised: f.raised === true ? '1' : undefined,
          })
        }
        const p = await client.addPerson(tree.id, fields)
        print(p, () => `Added ${p.name} (${p.id})${rel ? ` as ${rel.replace('-of', '')} of ${str(f[rel])}` : ''}.`)
        return 0
      }
      case 'edit': {
        const tree = await pickTree(client, f.tree)
        const id = await pickPerson(client, tree.id, rest[0])
        const fields = personFields(f)
        // On edit a contact flag adds to what is there; the web form is where lists are rewritten.
        if (Object.keys(personCardFlags(f)).length) {
          const card = (await client.person(tree.id, id)).contact
          if (card) {
            if (fields.emails) fields.emails = [...card.emails, ...(fields.emails as string[])]
            if (fields.phones) fields.phones = [...card.phones, ...(fields.phones as string[])]
            if (fields.links) fields.links = [...card.links, ...(fields.links as string[])]
            if (fields.socials) fields.socials = [...card.socials, ...(fields.socials as string[])]
            if (fields.addresses) fields.addresses = [...card.addresses, { label: null, lines: fields.addresses as string }]
          }
        }
        const p = await client.updatePerson(tree.id, id, fields)
        print(p, () => formatPerson(p))
        return 0
      }
      case 'event': {
        const tree = await pickTree(client, f.tree)
        const id = await pickPerson(client, tree.id, rest[0])
        const r = await client.addEvent(tree.id, id, {
          type: rest.slice(1).join(' ') || 'Event',
          date: str(f.date),
          place: str(f.place),
          description: str(f.note) ?? str(f.description),
          with_person: typeof f.with === 'string' ? await pickPerson(client, tree.id, f.with) : undefined,
          child: typeof f.child === 'string' ? await pickPerson(client, tree.id, f.child) : undefined,
          child_given: str(f['child-given']),
          child_surname: str(f['child-surname']),
        })
        console.log(r.message ?? 'Event added.')
        return 0
      }
      case 'pedigree':
      case 'ancestors': {
        const tree = await pickTree(client, f.tree)
        const g = Math.min(8, Math.max(2, Number(f.generations) || 4))
        const ancestors = await client.pedigree(tree.id, await pickPerson(client, tree.id, rest.join(' ') || tree.home_person_id || undefined), g)
        print(ancestors, () => formatPedigree(ancestors, g))
        return 0
      }
      case 'descendants': {
        const tree = await pickTree(client, f.tree)
        const d = await client.descendants(tree.id, await pickPerson(client, tree.id, rest.join(' ') || tree.home_person_id || undefined), Math.min(10, Math.max(1, Number(f.generations) || 3)))
        print(d, () => formatDescendants(d))
        return 0
      }
      case 'relate': {
        const tree = await pickTree(client, f.tree)
        const [a, b] = [await pickPerson(client, tree.id, rest[0]), await pickPerson(client, tree.id, rest[1])]
        const r = await client.relate(tree.id, a, b)
        print(r, () => (r.path ? `${r.path[r.path.length - 1]!.name} is ${r.path[0]!.name}'s ${r.relationship}.\n  ${r.path.map((s) => (s.step === 'self' ? s.name : `${s.step} ${s.name}`)).join(' → ')}` : r.relationship))
        return 0
      }
      case 'import': {
        const file = rest[0]
        if (!file) throw new Error('ancestry import <file.ged>')
        const text = readFileSync(file, 'utf8')
        const tree = f.tree ? await pickTree(client, f.tree) : await client.createTree(str(f.name) ?? file.replace(/^.*[\\/]/, '').replace(/\.(ged|gedcom)$/i, ''))
        const r = await client.importGedcom(tree.id, text)
        if (!f.tree) writeConfig({ ...readConfig(), tree: tree.id })
        print({ tree, imported: r }, () => `Imported into ${tree.name} (${tree.id}): ${r.people} people, ${r.families} families, ${r.events} events, ${r.sources} sources.${r.warnings.length ? `\n${r.warnings.map((w) => `  warning: ${w}`).join('\n')}` : ''}`)
        return 0
      }
      case 'export': {
        const tree = await pickTree(client, f.tree)
        const ged = await client.exportGedcom(tree.id, f.privacy === true)
        if (typeof f.output === 'string') {
          writeFileSync(f.output, ged)
          console.error(`Wrote ${f.output} (${ged.split('\n').filter((l) => / INDI\r?$/.test(l)).length} people).`)
        } else process.stdout.write(ged)
        return 0
      }
      case 'invite': {
        const tree = await pickTree(client, f.tree)
        const person = typeof f.as === 'string' ? await pickPerson(client, tree.id, f.as) : undefined
        // A pasted list: a file, or stdin with --file -. The server pulls the addresses (and names) out of it.
        const pasted = typeof f.file === 'string' ? (f.file === '-' ? await Bun.stdin.text() : readFileSync(f.file, 'utf8')) : ''
        const emails = [...rest, ...(pasted ? [pasted] : [])]
        const invites = await client.invite(tree.id, emails, { role: f.role === 'admin' || f.role === 'editor' ? f.role : 'viewer', person_id: person, note: str(f.note) })
        print(invites, () => invites.map((i) => `${i.email ?? 'link'}${i.name ? ` (${i.name})` : ''}: ${i.mailed ? 'emailed' : 'not emailed'}${i.person_id ? `, as ${i.person_id}` : ''}  ${i.url}`).join('\n'))
        return 0
      }
      case 'bond': {
        const tree = await pickTree(client, f.tree)
        const [who, kind, ...other] = rest
        if (!who || !kind || !other.length) throw new Error(`ancestry bond <person> <${PERSON_BONDS.join('|')}> <other>`)
        const r = await client.addBond(tree.id, await pickPerson(client, tree.id, who), { kind, other_id: await pickPerson(client, tree.id, other.join(' ')), note: str(f.note) })
        print(r, () => formatPerson(r.person))
        return 0
      }
      case 'status': {
        const tree = await pickTree(client, f.tree)
        const [who, partner, status] = rest
        if (!who || !partner || !status) throw new Error('ancestry status <person> <partner> <married|engaged|partners|dating|separated|divorced|widowed>')
        const [a, b] = [await pickPerson(client, tree.id, who), await pickPerson(client, tree.id, partner)]
        const union = (await client.person(tree.id, a)).unions.find((u) => u.partner?.id === b)
        if (!union) throw new Error('no partnership between those two; add one with: ancestry add --partner-of')
        const fam = await client.setStatus(tree.id, union.family_id, status)
        print(fam, () => `Now ${fam.end_kind ?? fam.kind}.`)
        return 0
      }
      case 'pet': {
        const tree = await pickTree(client, f.tree)
        const [owner, ...name] = rest
        if (!owner || !name.length) throw new Error('ancestry pet <owner> <name> [--species Dog]')
        const pet = await client.addPet(tree.id, { owner_id: await pickPerson(client, tree.id, owner), given: name.join(' '), species: str(f.species), birth_date: str(f.born), death_date: str(f.died), notes: str(f.note) })
        print(pet, () => `Added ${pet.name} (${pet.id}), ${pet.species ?? 'pet'}.`)
        return 0
      }
      case 'plan': {
        const tree = await pickTree(client, f.tree)
        if (rest[0] === 'buy') {
          const r = await client.planCheckout(tree.id, str(f.email))
          print(r, () => ('active' in r && r.active ? `${tree.name} is already on the Family plan.` : `Pay here (any coin or PayPal): ${(r as any).url}`))
          return 0
        }
        const plan = await client.plan(tree.id)
        print(plan, () => (plan.active ? `${tree.name} is on the Family plan: pets, and invite everyone you want.` : `${tree.name} is on the free plan. The Family plan is ${plan.price} once: ancestry plan buy\n  or ${plan.url}`))
        return 0
      }
      case 'feed': {
        const whom = str(f.user) ? await feedPerson(client, str(f.user)!) : null
        const posts = whom ? await client.feedOf(whom.id) : await client.feed()
        print(posts, () => (posts.length ? posts.map(formatPost).join('\n\n') : 'Nothing in your feed yet: ancestry subscribe all'))
        return 0
      }
      case 'post': {
        const text = rest.join(' ').trim()
        if (!text) throw new Error('say something: ancestry post "We made it to the lake"')
        const family = f.family ? (await pickTree(client, f.family)).id : undefined
        const p = await client.post(text, family)
        print(p, () => `Posted ${p.id} to ${p.family ?? 'everyone who knows you'}.`)
        return 0
      }
      case 'subscribe': {
        if (rest[0] === 'all') {
          const n = await client.subscribeAll(f.tree ? (await pickTree(client, f.tree)).id : undefined)
          print({ subscribed: n }, () => `Subscribed to ${n} ${n === 1 ? 'person' : 'people'}.`)
          return 0
        }
        const whom = await feedPerson(client, rest.join(' '))
        await client.subscribe(whom.id)
        console.log(`Subscribed to ${whom.name}.`)
        return 0
      }
      case 'unsubscribe': {
        const whom = await feedPerson(client, rest.join(' '))
        await client.unsubscribe(whom.id)
        console.log(`Unsubscribed from ${whom.name}.`)
        return 0
      }
      case 'comment': {
        if (!rest[0] || !rest[1]) throw new Error('ancestry comment <post-id> <text>')
        const c = await client.comment(rest[0], rest.slice(1).join(' '))
        print(c, () => 'Commented.')
        return 0
      }
      case 'like': {
        if (!rest[0]) throw new Error('ancestry like <post-id>')
        const liked = await client.like(rest[0])
        console.log(liked ? 'Liked.' : 'Unliked.')
        return 0
      }
      case 'local': {
        if (rest[0] === 'add') {
          const r = await client.recommendBusiness({ name: rest.slice(1).join(' '), category: str(f.category), town: str(f.town), phone: str(f.phone), website: str(f.website), note: str(f.note) })
          print(r, () => `Recommended ${r.name} (${r.category}) to everyone who knows you.`)
          return 0
        }
        const results = await client.local(rest.join(' '), str(f.category))
        print(results, () => (results.length ? results.map((r) => `${r.name}  (${r.category}${r.town ? `, ${r.town}` : ''})${r.phone ? `  ${r.phone}` : ''}${r.website ? `  ${r.website}` : ''}\n  recommended by ${r.by.map((b) => `${b.mine ? 'you' : (b.name ?? 'someone')}${b.mine ? '' : ` (${b.circle})`}${b.note ? `: ${b.note}` : ''}`).join('; ')}`).join('\n') : 'Nobody you know has recommended one yet.'))
        return 0
      }
      case 'claim': {
        const tree = await pickTree(client, f.tree)
        const body = rest.length ? { person_id: await pickPerson(client, tree.id, rest.join(' ')) } : personFields(f)
        const p = await client.claim(tree.id, body)
        print(p, () => `You are ${p.name} (${p.id}) in ${tree.name}. Keep it up to date: ancestry edit ${p.id} ...`)
        return 0
      }
      case 'team': {
        const tree = await pickTree(client, f.tree)
        const [ref, sub, arg] = rest.length > 1 && ['invite', 'rm', 'listing', 'decline'].includes(rest[1]!) ? [rest[0], rest[1], rest[2]] : [rest.join(' '), undefined, undefined]
        const biz = await pickBusiness(client, tree.id, ref)
        if (sub === 'invite' && arg && arg.includes('@')) {
          console.log(await client.inviteToTeam(tree.id, biz, { email: arg, role: str(f.as), title: str(f.title), note: str(f.note) }))
          return 0
        }
        if ((sub === 'invite' || sub === 'decline') && arg) {
          console.log(await client.answerTeamRequest(tree.id, biz, arg, sub))
          return 0
        }
        if (sub === 'rm' && arg) {
          await client.removeFromTeam(tree.id, biz, arg)
          console.log('Removed from the team.')
          return 0
        }
        if (sub === 'listing') {
          const l = await client.setBusinessListing(tree.id, biz, { listed: arg === 'on' ? true : arg === 'off' ? false : undefined, listing: str(f.note) })
          print(l, () => (l.listed ? `Listed: ${l.url}` : 'Not listed.'))
          return 0
        }
        const t = await client.team(tree.id, biz)
        print(t, () =>
          [
            ...(t.members.length ? t.members.map((m) => `${m.user_id}  ${m.name ?? m.email ?? ''}  ${[m.title, m.role].filter(Boolean).join(' · ')}`) : ['Nobody on the team yet.']),
            ...(t.invites ?? []).map((i) => `invited ${i.email} (${i.role})`),
            ...(t.requests ?? []).map((r) => `asking  ${r.id}  ${r.name} <${r.email}> as ${r.role}${r.note ? `  "${r.note}"` : ''}`),
          ].join('\n'),
        )
        return 0
      }
      case 'work': {
        const places = await client.work()
        print(places, () => (places.length ? places.map((b) => `${b.id}  ${b.name}  ${[b.title, b.role].filter(Boolean).join(' · ')}  ${b.url}`).join('\n') : 'No business has added you to its team yet.'))
        return 0
      }
      case 'listing': {
        const tree = await pickTree(client, f.tree)
        const on = rest[0] === 'on' ? true : rest[0] === 'off' ? false : undefined
        const l = on === undefined && f.note === undefined ? await client.listing(tree.id) : await client.setListing(tree.id, { listed: on, listing: str(f.note) })
        print(l, () => (l.listed ? `Listed: ${l.url}${l.listing ? `\n  ${l.listing}` : ''}` : 'Not listed. ancestry listing on --note "The Smiths of Ohio" lists it.'))
        return 0
      }
      case 'requests': {
        const tree = await pickTree(client, f.tree)
        if (rest[0] === 'invite' || rest[0] === 'decline') {
          if (!rest[1]) throw new Error(`ancestry requests ${rest[0]} <id>`)
          const r = await client.answerJoinRequest(tree.id, rest[1], rest[0])
          print(r, () => r.result ?? 'Declined. They are not told.')
          return 0
        }
        const reqs = await client.joinRequests(tree.id)
        print(reqs, () => (reqs.length ? reqs.map((r) => `${r.id}  ${r.name} <${r.email}>  ${r.circle}${r.note ? `  "${r.note}"` : ''}`).join('\n') : 'Nobody is asking to join.'))
        return 0
      }
      case 'profile': {
        const body: Record<string, unknown> = {}
        if (rest[0] === 'on' || rest[0] === 'off') body.published = rest[0] === 'on'
        for (const [flag, key] of [['slug', 'slug'], ['name', 'name'], ['nickname', 'nickname'], ['city', 'city'], ['region', 'region'], ['country', 'country'], ['from', 'hometown'], ['bio', 'bio'], ['email', 'email'], ['link', 'links'], ['social', 'socials']] as const) if (typeof f[flag] === 'string') body[key] = f[flag]
        const r = Object.keys(body).length ? { profile: await client.saveProfile(body), draft: null } : await client.profile()
        const p = r.profile ?? r.draft!
        print(p, () => `${r.profile ? (p.published ? 'On' : 'Off (only you can see it)') : 'Not made yet'}: ${p.url}\n  ${[p.name, p.nickname && `"${p.nickname}"`].filter(Boolean).join(' ')}${[p.city, p.region, p.country].some(Boolean) ? `\n  Lives in ${[p.city, p.region, p.country].filter(Boolean).join(', ')}` : ''}${p.hometown ? `\n  From ${p.hometown}` : ''}${r.profile ? '' : '\n  ancestry profile on --city "Los Gatos" --region CA --country USA makes it.'}`)
        return 0
      }
      case 'find': {
        const r = await client.findPeople({ q: rest.join(' '), kind: str(f.kind), country: str(f.country), region: str(f.region), city: str(f.city), category: str(f.category) })
        print(r, () => (r.hits.length ? r.hits.map((h) => `${h.kind.padEnd(10)} ${h.name}${h.place ? `  ${h.place}` : ''}  ${h.url}`).join('\n') + `\n${r.facets.map((g) => `  ${g.title}: ${g.items.map((i) => `${i.label} (${i.count})`).join(', ')}`).join('\n')}` : 'Nobody public matches that.'))
        return 0
      }
      case 'social': {
        const [sub, ...args] = rest
        if (sub === 'import') {
          const file = args[0] ?? MYNA_HISTORY
          const parsed = JSON.parse(readFileSync(file, 'utf8'))
          // A myna history file, or a plain list in the API's own shape.
          const posts: OutPost[] = Array.isArray(parsed) && parsed[0] && 'account' in parsed[0] ? parsed : fromMyna(parsed, { skip: typeof f.skip === 'string' ? f.skip.split(',') : [] })
          const days = Number(typeof f.days === 'string' ? f.days : 30)
          const counted = f['no-counts'] ? 0 : await fillCounts(posts, { since: Date.now() - days * 86_400_000, pauseMs: 200 })
          let saved = 0
          let skipped = 0
          for (let i = 0; i < posts.length; i += 500) {
            const r = await client.saveSocialPosts(posts.slice(i, i + 500).map(({ postId: _id, ...p }) => p))
            saved += r.saved
            skipped += r.skipped
          }
          const accounts = new Set(posts.map((p) => p.account))
          print({ saved, skipped, counted, accounts: [...accounts] }, () => `Saved ${saved} posts from ${accounts.size} accounts${skipped ? ` (${skipped} skipped)` : ''}; read likes, reposts and replies for ${counted}.\n  ${[...accounts].join('\n  ')}`)
          return 0
        }
        if (sub === 'hide' || sub === 'show') {
          if (!args[0]) throw new Error(`usage: ancestry social ${sub} <account>`)
          await client.hideSocialAccount(args[0], sub === 'hide')
          console.log(sub === 'hide' ? `${args[0]} no longer shows on your public profile.` : `${args[0]} shows on your public profile.`)
          return 0
        }
        if (sub === 'rm') {
          const r = await client.removeSocial({ url: str(f.url), account: str(f.account) ?? args[0] })
          console.log(`Removed ${r.removed} posts.`)
          return 0
        }
        const r = await client.social(str(f.account) ?? sub ?? null, Number(typeof f.limit === 'string' ? f.limit : 20))
        const n = (x: number | null) => (x === null ? '-' : String(x))
        print(r, () =>
          r.accounts.length
            ? `${r.accounts.map((a) => `${a.account.padEnd(46)} ${String(a.posts).padStart(4)} posts  ${n(a.likes).padStart(4)} likes  ${n(a.reposts).padStart(3)} reposts  ${n(a.replies).padStart(3)} replies${a.hidden ? '  (hidden)' : ''}`).join('\n')}\n\n${r.posts.map((p) => `${p.posted_at.slice(0, 10)}  ${p.account}  ♥${n(p.likes)} ↻${n(p.reposts)} ↩${n(p.replies)}\n  ${p.text.replace(/\s+/g, ' ').slice(0, 100)}\n  ${p.url}`).join('\n')}`
            : 'No socials yet. ancestry social import reads what myna posted.',
        )
        return 0
      }
      case 'families': {
        const fams = await client.families(rest.join(' '))
        print(fams, () => (fams.length ? fams.map((t) => `${t.id}  ${t.name}${t.listing ? `  ${t.listing}` : ''}`).join('\n') : 'No listed family matches.'))
        return 0
      }
      case 'ask': {
        if (!rest[0] || typeof f.name !== 'string' || typeof f.email !== 'string') throw new Error('ancestry ask <family-id> --name N --email E [--as friends] [--note TEXT]')
        console.log(await client.askToJoin(rest[0], { name: f.name, email: f.email, circle: str(f.as), note: str(f.note) }))
        return 0
      }
      case 'members': {
        const tree = await pickTree(client, f.tree)
        const [members, pending] = await Promise.all([client.members(tree.id), client.invites(tree.id).catch(() => [])])
        print({ members, pending }, () => [...members.map((m) => `${m.role.padEnd(7)} ${m.name ?? m.email}${m.name ? ` <${m.email}>` : ''}${m.person_id ? `  as ${m.person_id}` : ''}`), ...pending.map((i) => `invited ${i.email ?? 'link'} (${i.role})${i.mail ? `  ${i.mail.tone === 'bad' ? '!! ' : ''}${i.mail.text}` : ''}`)].join('\n'))
        return 0
      }
      case 'contacts': {
        if (rest[0] === 'import') {
          if (!rest[1]) throw new Error('ancestry contacts import <file.vcf>')
          const r = await client.importContacts(readFileSync(rest[1], 'utf8'), str(f.circle) ?? 'friends')
          print(r, () => `Imported ${r.added}, skipped ${r.skipped} already in your network.`)
          return 0
        }
        if (rest[0] === 'export') {
          const vcf = await client.exportContacts()
          if (typeof f.output === 'string') writeFileSync(f.output, vcf), console.error(`Wrote ${f.output}.`)
          else process.stdout.write(vcf)
          return 0
        }
        const contacts = await client.contacts(rest.join(' '), str(f.circle))
        print(contacts, () => (contacts.length ? contacts.map(formatContactLine).join('\n') : 'Nobody in your network yet: ancestry contact add --name "Aunt Rose" --email rose@example.com --circle family'))
        return 0
      }
      case 'contact': {
        if (rest[0] === 'add' && typeof f.person === 'string') {
          const tree = await pickTree(client, f.tree)
          const r = await client.addPersonToNetwork(tree.id, await pickPerson(client, tree.id, f.person), { circle: str(f.circle), email: str(f.email), relationship: str(f.relationship), connect: f.connect === true, note: str(f.say) })
          print(r, () => `${r.result} (${r.contact.id})`)
          return 0
        }
        if (rest[0] === 'add') {
          const c = await client.addContact({ ...contactFields(f), connect: f.connect === true, note_to_them: str(f.say) })
          print(c, () => `Added ${c.name || c.emails[0]?.value} (${c.id}).${c.result ? ` ${c.result}` : ''}`)
          return 0
        }
        if (rest[0] === 'rm' || rest[0] === 'remove') {
          const c = await pickContact(client, rest.slice(1).join(' '))
          await client.deleteContact(c.id)
          console.log(`Removed ${c.name}.`)
          return 0
        }
        if (rest[0] === 'edit') {
          const c = await client.updateContact((await pickContact(client, rest[1])).id, contactFields(f))
          print(c, () => formatContact(c))
          return 0
        }
        const c = await pickContact(client, rest.join(' '))
        print(c, () => formatContact(c))
        return 0
      }
      case 'connect': {
        const c = await pickContact(client, rest.join(' '))
        console.log(await client.connectContact(c.id, str(f.note)))
        return 0
      }
      case 'recommend': {
        const c = await pickContact(client, rest.join(' '))
        if (typeof f.to !== 'string') throw new Error('ancestry recommend <contact> --to <who>')
        const r = await client.recommendContact(c.id, await pickCorrespondent(client, f.to), str(f.note))
        print(r, () => `Recommended ${c.name} to ${r.to.name ?? r.to.email}.`)
        return 0
      }
      case 'recommendations': {
        if (rest[0] === 'save') {
          if (!rest[1]) throw new Error('ancestry recommendations save <id>')
          const saved = await client.saveRecommendation(rest[1])
          print(saved, () => `Saved: ${formatContactLine(saved)}`)
          return 0
        }
        const recs = await client.recommendations()
        print(recs, () => (recs.length ? recs.map((r) => `${r.id}  ${r.card.name}  ${[r.card.circle, r.card.title, r.card.company].filter(Boolean).join(' · ')}\n      from ${r.from.name ?? r.from.email}${r.note ? `: ${r.note}` : ''}`).join('\n') : 'Nothing recommended to you yet.'))
        return 0
      }
      case 'inbox': {
        const box = await client.inbox()
        print(box, () => (box.threads.length ? box.threads.map((t) => `${t.unread ? `(${t.unread}) ` : '    '}${t.with.name ?? t.with.email}  [${t.with.id}]\n      ${t.last.body.split('\n')[0]!.slice(0, 100)}`).join('\n') : 'No messages yet.'))
        return 0
      }
      case 'message':
      case 'thread': {
        const who = await pickCorrespondent(client, rest[0])
        if (cmd === 'message') {
          const body = rest.slice(1).join(' ') || str(f.body)
          if (!body) throw new Error('ancestry message <contact> <text...>')
          const m = await client.sendMessage(who, body)
          print(m, () => 'Sent.')
          return 0
        }
        const t = await client.conversation(who)
        print(t, () => t.messages.map((m) => `${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')}  ${m.sender_id === t.with.id ? (t.with.name ?? t.with.email) : 'you'}: ${m.body}`).join('\n') || 'No messages yet.')
        return 0
      }
      case 'open': {
        const tree = await pickTree(client, f.tree)
        const url = rest.length ? `${client.base}/t/${tree.id}/p/${await pickPerson(client, tree.id, rest.join(' '))}` : `${client.base}/t/${tree.id}`
        console.log(url)
        openUrl(url)
        return 0
      }
      default:
        console.error(`ancestry: unknown command "${cmd}"\n`)
        console.log(HELP)
        return 2
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) console.error('ancestry: not signed in. Run: ancestry login')
    else console.error(`ancestry: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
