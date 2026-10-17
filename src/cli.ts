/**
 * `ancestry`: family.ancestry from the terminal.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { AncestryClient, ApiError, readConfig, writeConfig, configPath, type PersonDetail, type TreeSummary } from './client.js'
import { VERSION } from './html.js'

const HELP = `ancestry ${VERSION}: private family trees, from the terminal

  ancestry login [--url URL]        sign in through the browser (or --token fa_...)
  ancestry logout | whoami
  ancestry trees                    list your trees
  ancestry new <name>               start a tree
  ancestry use <tree>               set the default tree (id or name)
  ancestry people [search]          list or search people
  ancestry show <person>            everything about one person
  ancestry add --given G --surname S [--sex F|M] [--born DATE] [--birthplace P]
               [--died DATE] [--deathplace P] [--living]
               [--parent-of ID | --child-of ID | --partner-of ID]
  ancestry edit <person> --field value ...     (same flags as add)
  ancestry event <person> <type> [--date D] [--place P] [--note TEXT]
  ancestry pedigree <person> [-g 4] ancestors as a chart
  ancestry descendants <person> [-g 3]
  ancestry relate <person> <person> how two people are related
  ancestry import <file.ged> [--name N]   into a new tree (or --tree to merge into one)
  ancestry export [-o file.ged] [--privacy]
  ancestry invite <email...> [--role editor|viewer] [--as <person>] [--note TEXT]
                                    email invites; --as invites them to be that person
  ancestry members                  who is in the tree, and pending invites

  ancestry contacts [search] [--circle family|friends|neighbors|business]
  ancestry contact add --name N [--email E] [--phone P] [--circle C] [--relationship R]
               [--company C] [--title T] [--birthday D] [--address TEXT] [--link URL] [--note TEXT]
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
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-') && !['living', 'json', 'privacy', 'help', 'version', 'full'].includes(key)) out.flags[key] = argv[++i]!
      else out.flags[key] = true
    } else out._.push(a)
  }
  return out
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined)

/** Flags to person fields. */
export function personFields(flags: Record<string, string | true>): Record<string, unknown> {
  const map: Record<string, string> = { given: 'given', first: 'given', surname: 'surname', last: 'surname', sex: 'sex', born: 'birth_date', birthplace: 'birth_place', died: 'death_date', deathplace: 'death_place', notes: 'notes', note: 'notes' }
  const out: Record<string, unknown> = {}
  for (const [flag, field] of Object.entries(map)) if (typeof flags[flag] === 'string') out[field] = flags[flag]
  if (flags.living === true) out.living = true
  if (flags['not-living'] === true) out.living = false
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

const years = (p: { birth_date: string | null; death_date: string | null }) => {
  const y = (d: string | null) => d?.match(/\b(\d{4})\b/)?.[1]
  const b = y(p.birth_date)
  const d = y(p.death_date)
  return b || d ? `(${b ?? '?'}–${d ?? ''})` : ''
}

export function formatPerson(p: PersonDetail): string {
  const lines = [`${p.name} ${years(p)}`, `  id ${p.id}  ${p.url}`]
  if (p.birth_date || p.birth_place) lines.push(`  born   ${[p.birth_date, p.birth_place].filter(Boolean).join(', ')}`)
  if (p.death_date || p.death_place) lines.push(`  died   ${[p.death_date, p.death_place].filter(Boolean).join(', ')}`)
  else if (p.living) lines.push('  living')
  for (const f of p.parents) lines.push(`  parents ${f.parents.map((x) => `${x.name} [${x.id}]`).join(' & ') || 'unknown'}${f.relation !== 'birth' ? ` (${f.relation})` : ''}`)
  const sibs = p.parents.flatMap((f) => f.siblings)
  if (sibs.length) lines.push(`  siblings ${sibs.map((x) => x.name).join(', ')}`)
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
        const tree = await client.createTree(rest.join(' ') || 'Family tree', str(f.description))
        writeConfig({ ...readConfig(), tree: tree.id })
        print(tree, () => `Started ${tree.name} (${tree.id}); it is now your default tree.`)
        return 0
      }
      case 'use': {
        const tree = await pickTree(client, rest.join(' ') || undefined)
        writeConfig({ ...readConfig(), tree: tree.id })
        console.log(`Default tree: ${tree.name} (${tree.id})`)
        return 0
      }
      case 'people':
      case 'search': {
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
        const rel = (['parent-of', 'child-of', 'partner-of'] as const).find((k) => typeof f[k] === 'string')
        if (rel) {
          // "add --parent-of X" adds a parent TO X; "--child-of X" adds a child to X.
          Object.assign(fields, { relative_of: await pickPerson(client, tree.id, str(f[rel])), as: { 'parent-of': 'parent', 'child-of': 'child', 'partner-of': 'partner' }[rel], relation: str(f.relation) ?? 'birth', kind: str(f.kind) })
        }
        const p = await client.addPerson(tree.id, fields)
        print(p, () => `Added ${p.name} (${p.id})${rel ? ` as ${rel.replace('-of', '')} of ${str(f[rel])}` : ''}.`)
        return 0
      }
      case 'edit': {
        const tree = await pickTree(client, f.tree)
        const p = await client.updatePerson(tree.id, await pickPerson(client, tree.id, rest[0]), personFields(f))
        print(p, () => formatPerson(p))
        return 0
      }
      case 'event': {
        const tree = await pickTree(client, f.tree)
        const id = await pickPerson(client, tree.id, rest[0])
        await client.addEvent(tree.id, id, { type: rest.slice(1).join(' ') || 'Event', date: str(f.date), place: str(f.place), description: str(f.note) ?? str(f.description) })
        console.log('Event added.')
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
        const invites = await client.invite(tree.id, rest, { role: f.role === 'editor' ? 'editor' : 'viewer', person_id: person, note: str(f.note) })
        print(invites, () => invites.map((i) => `${i.email ?? 'link'}: ${i.mailed ? 'emailed' : 'not emailed'}  ${i.url}`).join('\n'))
        return 0
      }
      case 'members': {
        const tree = await pickTree(client, f.tree)
        const [members, pending] = await Promise.all([client.members(tree.id), client.invites(tree.id).catch(() => [])])
        print({ members, pending }, () => [...members.map((m) => `${m.role.padEnd(7)} ${m.name ?? m.email}${m.name ? ` <${m.email}>` : ''}${m.person_id ? `  as ${m.person_id}` : ''}`), ...pending.map((i) => `invited ${i.email ?? 'link'} (${i.role})`)].join('\n'))
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
        if (rest[0] === 'add') {
          const c = await client.addContact(contactFields(f))
          print(c, () => `Added ${c.name || c.emails[0]?.value} (${c.id}).`)
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
