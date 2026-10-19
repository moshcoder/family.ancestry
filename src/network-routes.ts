/**
 * Routes for the Network add-on: pages under /network and /inbox, JSON under
 * /api/v1/contacts and /api/v1/inbox. Mounted by createApp next to the trees.
 */
import type { Context, Hono } from 'hono'
import { canManage, fullName, inviteRole, type InviteRole, type Role, type Store, type Tree, type User } from './db.js'
import type { Ctx } from './html.js'
import * as html from './html.js'
import * as page from './network-html.js'
import { asCircle, CIRCLES, contactName, parseVcards, toVcard, type Circle, type Contact, type Network } from './network.js'
import { validEmail, type Mail } from './auth.js'
import { readContact, socialUrl } from './contact.js'

export type NetworkDeps = {
  store: Store
  net: Network
  site: string
  ctx: (c: Context, extra?: Partial<Ctx>) => Ctx
  form: (c: Context) => Promise<Record<string, any>>
  mail: (m: Mail) => Promise<void>
  /** Per-sender limits: connection requests and tree invites by email, and messages. */
  limits: { invite: (key: string) => boolean; message: (key: string) => boolean }
  /** Email a tree invite (the same mail the Members page sends). */
  inviteToTree: (from: User, treeId: string, email: string, role: InviteRole, opts?: { personId?: string | null; note?: string | null }) => Promise<{ url: string; mailed: boolean }>
  /** The tree and the caller's role in it, or a response that ends the request. */
  treeFor: (c: Context, need?: 'view' | 'edit' | 'manage' | 'owner') => { error: Response } | { error?: undefined; tree: Tree; role: Role; user: User }
}

const MAX_VCF = 5 * 1024 * 1024
const who = (u: Pick<User, 'name' | 'email'>) => u.name ?? u.email
const truthy = (v: unknown) => v === true || ['1', 'on', 'true', 'yes'].includes(String(v ?? '').toLowerCase())

export function mountNetwork(app: Hono<any>, api: Hono<any>, d: NetworkDeps) {
  const { store, net, site } = d
  const user = (c: Context) => c.get('user') as User | null
  const needUser = (c: Context) => (user(c) ? null : c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`))
  const back = (path: string, message: string) => `${path}?ok=${encodeURIComponent(message)}`

  /** Trees this user owns: where they may invite people. */
  const ownedTrees = (u: User) => store.treesFor(u.id).filter((t) => canManage(t.role))

  async function askToConnect(from: User, contact: Contact, note: string | null): Promise<string> {
    const email = contact.emails[0]?.value
    if (!email) return 'Add an email first.'
    if (email === from.email) return "That's you."
    const existing = store.userByEmail(email)
    if (existing && net.connected(from.id, existing.id)) {
      net.linkContact(from.id, contact.id, { linked_user_id: existing.id })
      return `You're already connected with ${contactName(contact)}.`
    }
    if (existing && net.blocked(existing.id, from.id)) return `Request sent to ${email}.` // never reveal a block
    const pending = net.pendingRequest(from.id, email)
    if (pending) return `You already asked ${email} on ${new Date(pending.created_at).toISOString().slice(0, 10)}; waiting for them to say yes.`
    if (!d.limits.invite(`invite:${from.id}`) || !d.limits.invite(`to:${email}`)) return 'That is a lot of invitations for one day. Try again tomorrow.'
    const token = net.createConnectRequest(from.id, email, contact.circle, contact.id, note)
    const url = `${site}/network/accept/${token}`
    try {
      await d.mail({
        to: email,
        subject: `${who(from)} wants to stay in touch on family.ancestry`,
        text: `${who(from)} added you to their network on family.ancestry and would like to connect.${note ? `\n\n"${note}"` : ''}\n\nSay yes: ${url}\n\nIf you don't know them, ignore this; nothing happens. The link expires in 30 days.`,
        html: `<p><b>${html.esc(who(from))}</b> added you to their network on family.ancestry and would like to connect.</p>${note ? `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#444">${html.esc(note)}</blockquote>` : ''}<p><a href="${html.esc(url)}" style="display:inline-block;padding:10px 18px;background:#3d6b4f;color:#fff;border-radius:6px;text-decoration:none">Connect</a></p><p style="color:#666;font-size:13px">If you don't know them, ignore this; nothing happens. The link expires in 30 days.</p>`,
      })
    } catch (error) {
      console.error(`[network] connect mail failed: ${(error as Error).message}`)
    }
    return `Request sent to ${email}.`
  }

  /** Recommend a contact to someone you could message; the same hourly limit as messages. */
  function recommend(from: User, contact: Contact, toId: string, note: string | null) {
    const to = store.user(toId)
    if (!to || !net.canMessage(from.id, to.id)) throw new Error('You can recommend to people you are connected with or share a tree with.')
    if (!d.limits.message(`msg:${from.id}`)) throw new Error('Slow down a little: too many messages in the last hour.')
    const first = net.unreadBefore(from.id, to.id) < 0
    const rec = net.recommend(from, to.id, contact, note)
    if (first) {
      const url = `${site}/inbox`
      d.mail({
        to: to.email,
        subject: `${who(from)} recommended ${contactName(rec.card)}`,
        text: `${who(from)} recommended ${contactName(rec.card)} to you on family.ancestry.${rec.note ? `\n\n"${rec.note}"` : ''}\n\nSee it and save it: ${url}`,
        html: `<p><b>${html.esc(who(from))}</b> recommended <b>${html.esc(contactName(rec.card))}</b> to you on family.ancestry.</p>${rec.note ? `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#444">${html.esc(rec.note)}</blockquote>` : ''}<p><a href="${html.esc(url)}">See it and save it</a></p>`,
      }).catch((error) => console.error(`[recommend] notify failed: ${(error as Error).message}`))
    }
    return { rec, to }
  }

  /**
   * Someone in a tree into your own network ("add a friend"), linked back to their
   * page. One contact per person: asking again files them under the new circle and
   * adds the email if it is new. With connect, the same one email "Ask to connect" sends.
   */
  async function addFromPerson(u: User, tree: Tree, personId: string, body: Record<string, any>): Promise<{ contact: Contact; result: string } | null> {
    const person = store.person(tree.id, personId)
    if (!person || person.kind === 'pet') return null
    const email = validEmail(body.email)
    const fields: Record<string, unknown> = { circle: asCircle(body.circle ?? 'friends') }
    if (body.relationship) fields.relationship = String(body.relationship)
    let contact = net.contactForPerson(u.id, tree.id, person.id) ?? (email ? net.contactByEmail(u.id, email) : null)
    if (contact) {
      if (email && !contact.emails.some((e) => e.value === email)) fields.emails = [...contact.emails, { label: null, value: email }]
      contact = net.updateContact(u.id, contact.id, fields)!
      if (!contact.person_id) net.linkContact(u.id, contact.id, { tree_id: tree.id, person_id: person.id })
    } else {
      // What the tree knows about reaching them comes along; socials ride as links.
      const card = readContact(person.contact)
      const emails = email && !card.emails.some((e) => e.value === email) ? [{ label: null, value: email }, ...card.emails] : card.emails
      const links = [...card.links, ...card.socials.flatMap((x) => (socialUrl(x) ? [{ label: x.label, value: socialUrl(x)! }] : []))]
      contact = net.addContact(u.id, { ...fields, name: fullName(person), nickname: person.nickname ?? null, birthday: person.birth_date ?? null, emails, phones: card.phones, addresses: card.addresses, links }, { tree_id: tree.id, person_id: person.id })
    }
    const added = `${contactName(contact)} is in your ${contact.circle}.`
    if (!truthy(body.connect)) return { contact, result: added }
    return { contact, result: contact.emails.length ? `${added} ${await askToConnect(u, contact, body.note ? String(body.note) : null)}` : `${added} Add an email to ask them to connect.` }
  }

  const recsFor = (u: User) => net.recommendationsFor(u.id).map((rec) => ({ rec, from: store.user(rec.from_user)! })).filter((r) => r.from)

  async function sendMessage(from: User, to: User, body: string) {
    if (!d.limits.message(`msg:${from.id}`)) throw new Error('Slow down a little: too many messages in the last hour.')
    const message = net.send(from.id, to.id, body)
    // One email per unread run, not per message: the first unread one says "you have a message".
    if (net.unreadBefore(from.id, to.id) === 0) {
      const url = `${site}/inbox/${from.id}`
      d.mail({
        to: to.email,
        subject: `${who(from)} sent you a message`,
        text: `${who(from)} wrote to you on family.ancestry:\n\n${message.body.slice(0, 600)}\n\nReply: ${url}`,
        html: `<p><b>${html.esc(who(from))}</b> wrote to you on family.ancestry:</p><blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#444">${html.esc(message.body.slice(0, 600)).replace(/\n/g, '<br>')}</blockquote><p><a href="${html.esc(url)}">Reply</a></p>`,
      }).catch((error) => console.error(`[inbox] notify failed: ${(error as Error).message}`))
    }
    return message
  }

  function contactView(c: Context, u: User, contact: Contact) {
    const linked = contact.linked_user_id ? store.user(contact.linked_user_id) : null
    const tree = contact.tree_id && store.role(contact.tree_id, u.id) ? store.tree(contact.tree_id) : null
    const person = tree && contact.person_id ? store.person(tree.id, contact.person_id) : null
    return c.html(
      page.contactPage(d.ctx(c), contact, {
        trees: ownedTrees(u),
        person: tree && person ? { tree, person } : null,
        linked,
        canMessage: Boolean(linked && net.canMessage(u.id, linked.id)),
        blocked: Boolean(linked && net.blocked(u.id, linked.id)),
        reachable: net.reachable(u.id),
      }),
    )
  }

  // ---- pages: network ----------------------------------------------------

  app.get('/network', (c) => {
    if (needUser(c)) return needUser(c)!
    const u = user(c)!
    const circle = CIRCLES.includes(c.req.query('circle') as Circle) ? (c.req.query('circle') as Circle) : null
    const q = (c.req.query('q') ?? '').slice(0, 200)
    return c.html(page.networkPage(d.ctx(c), { contacts: net.contacts(u.id, { circle, q }), circle, q, counts: net.circleCounts(u.id) }))
  })
  app.post('/network/contacts', async (c) => {
    if (needUser(c)) return needUser(c)!
    const body = await d.form(c)
    const { contact, merged } = net.addOrMerge(user(c)!.id, body)
    const already = merged ? `${contactName(contact)} was already in your network; updated.` : ''
    if (!truthy(body.connect) || !contact.emails.length) return c.redirect(already ? back(`/network/c/${contact.id}`, already) : `/network/c/${contact.id}`)
    return c.redirect(back(`/network/c/${contact.id}`, `${already ? `${already} ` : ''}` + await askToConnect(user(c)!, contact, body.note_to_them ? String(body.note_to_them) : null)))
  })
  app.post('/t/:tree/p/:person/network', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const r = await addFromPerson(t.user, t.tree, c.req.param('person')!, await d.form(c))
    if (!r) return c.html(html.messagePage(d.ctx(c), 'Not found', 'Nobody by that id in this tree.'), 404)
    return c.redirect(back(`/t/${t.tree.id}/p/${c.req.param('person')}`, r.result))
  })
  app.get('/network/export.vcf', (c) => {
    if (needUser(c)) return needUser(c)!
    return new Response(toVcard(net.contacts(user(c)!.id)), { headers: { 'content-type': 'text/vcard; charset=utf-8', 'content-disposition': 'attachment; filename="network.vcf"' } })
  })
  app.post('/network/import', async (c) => {
    if (needUser(c)) return needUser(c)!
    const body = await d.form(c)
    const file = body.file
    if (!(file instanceof File) || file.size > MAX_VCF) return c.redirect(back('/network', 'Choose a .vcf file under 5 MB.'))
    const r = importVcards(net, user(c)!.id, await file.text(), asCircle(body.circle))
    return c.redirect(back('/network', `Imported ${r.added} ${r.added === 1 ? 'person' : 'people'}${r.skipped ? `, skipped ${r.skipped} already here` : ''}.`))
  })
  app.get('/network/c/:id', (c) => {
    if (needUser(c)) return needUser(c)!
    const contact = net.contact(user(c)!.id, c.req.param('id'))
    if (!contact) return c.html(html.messagePage(d.ctx(c), 'Not found', 'Nobody by that id in your network.'), 404)
    return contactView(c, user(c)!, contact)
  })
  app.post('/network/c/:id', async (c) => {
    if (needUser(c)) return needUser(c)!
    const contact = net.updateContact(user(c)!.id, c.req.param('id'), await d.form(c))
    return contact ? c.redirect(back(`/network/c/${contact.id}`, 'Saved')) : c.notFound()
  })
  app.post('/network/c/:id/delete', (c) => {
    if (needUser(c)) return needUser(c)!
    net.deleteContact(user(c)!.id, c.req.param('id'))
    return c.redirect(back('/network', 'Removed'))
  })
  app.post('/network/c/:id/connect', async (c) => {
    if (needUser(c)) return needUser(c)!
    const contact = net.contact(user(c)!.id, c.req.param('id'))
    if (!contact) return c.notFound()
    const body = await d.form(c)
    return c.redirect(back(`/network/c/${contact.id}`, await askToConnect(user(c)!, contact, body.note ? String(body.note) : null)))
  })
  app.post('/network/c/:id/invite', async (c) => {
    if (needUser(c)) return needUser(c)!
    const u = user(c)!
    const contact = net.contact(u.id, c.req.param('id'))
    const body = await d.form(c)
    const tree = store.tree(String(body.tree_id ?? ''))
    const email = contact?.emails[0]?.value
    if (!contact || !email || !tree || !canManage(store.role(tree.id, u.id))) return c.redirect(back(`/network/c/${c.req.param('id')}`, 'Pick one of your trees.'))
    const r = await d.inviteToTree(u, tree.id, email, inviteRole(store.role(tree.id, u.id), body.role), { personId: contact.tree_id === tree.id ? contact.person_id : null })
    return c.redirect(back(`/network/c/${contact.id}`, r.mailed ? `Invited ${email} to ${tree.name}.` : 'That is a lot of invitations for one day. Try again tomorrow.'))
  })
  app.post('/network/c/:id/recommend', async (c) => {
    if (needUser(c)) return needUser(c)!
    const u = user(c)!
    const contact = net.contact(u.id, c.req.param('id'))
    if (!contact) return c.notFound()
    const body = await d.form(c)
    try {
      const { to } = recommend(u, contact, String(body.to ?? ''), body.note ? String(body.note) : null)
      return c.redirect(back(`/network/c/${contact.id}`, `Recommended ${contactName(contact)} to ${who(to)}.`))
    } catch (error) {
      return c.redirect(back(`/network/c/${contact.id}`, (error as Error).message))
    }
  })
  app.post('/network/r/:id/save', (c) => {
    if (needUser(c)) return needUser(c)!
    const saved = net.saveRecommendation(user(c)!.id, c.req.param('id'))
    return saved ? c.redirect(back(`/network/c/${saved.id}`, 'Saved to your network')) : c.redirect('/inbox')
  })
  app.post('/network/r/:id/dismiss', (c) => {
    if (needUser(c)) return needUser(c)!
    net.dismissRecommendation(user(c)!.id, c.req.param('id'))
    return c.redirect('/inbox')
  })
  app.get('/network/accept/:token', (c) => {
    const req = net.connectRequest(c.req.param('token'))
    const from = req ? store.user(req.from_user) : null
    if (!req || !from) return c.html(html.messagePage(d.ctx(c), 'Link expired', 'This request was already answered or has expired.'), 404)
    return c.html(page.connectInvitePage(d.ctx(c), from, req.note, c.req.param('token')))
  })
  app.post('/network/accept/:token', (c) => {
    if (needUser(c)) return needUser(c)!
    const from = net.acceptConnectRequest(c.req.param('token'), user(c)!)
    if (!from) return c.html(html.messagePage(d.ctx(c), 'Link expired', 'This request was already answered, has expired, or is your own.'), 404)
    return c.redirect(back(`/inbox/${from.id}`, `You and ${who(from)} are connected.`))
  })

  // ---- pages: inbox ------------------------------------------------------

  app.get('/inbox', (c) => {
    if (needUser(c)) return needUser(c)!
    const u = user(c)!
    return c.html(page.inboxPage(d.ctx(c), net.threads(u.id), net.reachable(u.id), recsFor(u)))
  })
  const thread = (c: Context, other: User, error: string | null = null) => {
    const u = user(c)!
    const messages = net.conversation(u.id, other.id)
    return c.html(page.threadPage(d.ctx(c, { error, unread: net.unreadCount(u.id) }), other, messages, { canMessage: net.canMessage(u.id, other.id), blocked: net.blocked(u.id, other.id) }), error ? 400 : 200)
  }
  /** Someone you may talk to, or have talked to. Anyone else is a 404, so ids cannot be probed. */
  const counterpart = (c: Context): User | null => {
    const u = user(c)!
    const other = store.user(c.req.param('user')!)
    if (!other || other.id === u.id) return null
    const known = net.connected(u.id, other.id) || store.sharesTree(u.id, other.id) || net.conversation(u.id, other.id, 1).length > 0
    return known ? other : null
  }
  app.get('/inbox/:user', (c) => {
    if (needUser(c)) return needUser(c)!
    const other = counterpart(c)
    return other ? thread(c, other) : c.html(html.messagePage(d.ctx(c), 'Not found', 'No conversation here.'), 404)
  })
  app.post('/inbox/:user', async (c) => {
    if (needUser(c)) return needUser(c)!
    const other = counterpart(c)
    if (!other) return c.html(html.messagePage(d.ctx(c), 'Not found', 'No conversation here.'), 404)
    try {
      await sendMessage(user(c)!, other, String((await d.form(c)).body ?? ''))
      return c.redirect(`/inbox/${other.id}`)
    } catch (error) {
      return thread(c, other, (error as Error).message)
    }
  })
  app.post('/inbox/:user/block', (c) => {
    if (needUser(c)) return needUser(c)!
    const other = counterpart(c)
    if (other) net.block(user(c)!.id, other.id)
    return c.redirect(other ? `/inbox/${other.id}` : '/inbox')
  })
  app.post('/inbox/:user/unblock', (c) => {
    if (needUser(c)) return needUser(c)!
    const other = counterpart(c)
    if (other) net.unblock(user(c)!.id, other.id)
    return c.redirect(other ? `/inbox/${other.id}` : '/inbox')
  })

  // ---- /api/v1 -----------------------------------------------------------

  const json = async (c: Context): Promise<Record<string, any>> => ((await c.req.json().catch(() => ({}))) as Record<string, any>) ?? {}
  const userOut = (u: User) => ({ id: u.id, name: u.name, email: u.email })

  api.get('/contacts', (c) => {
    const circle = CIRCLES.includes(c.req.query('circle') as Circle) ? (c.req.query('circle') as Circle) : null
    return c.json({ contacts: net.contacts(user(c)!.id, { circle, q: c.req.query('q') ?? '', limit: Math.min(5000, Number(c.req.query('limit')) || 500) }) })
  })
  api.post('/contacts', async (c) => {
    const body = await json(c)
    if (!String(body.name ?? '').trim() && !body.emails && !body.email) return c.json({ error: 'give a name or an email' }, 400)
    if (body.email && !body.emails) body.emails = [String(body.email)]
    const { contact, merged } = net.addOrMerge(user(c)!.id, body)
    if (!body.connect || !contact.emails.length) return c.json({ contact, merged }, merged ? 200 : 201)
    return c.json({ contact, result: await askToConnect(user(c)!, contact, body.note_to_them ? String(body.note_to_them) : null) }, 201)
  })
  /** {circle, email, relationship, connect, note}: someone in the tree, into your network. */
  api.post('/trees/:tree/people/:person/contact', async (c) => {
    const t = d.treeFor(c)
    if (t.error) return t.error
    const r = await addFromPerson(t.user, t.tree, c.req.param('person')!, await json(c))
    return r ? c.json(r, 201) : c.json({ error: 'no such person' }, 404)
  })
  api.get('/contacts/:id', (c) => {
    const contact = net.contact(user(c)!.id, c.req.param('id'))
    return contact ? c.json({ contact }) : c.json({ error: 'no such contact' }, 404)
  })
  api.patch('/contacts/:id', async (c) => {
    const contact = net.updateContact(user(c)!.id, c.req.param('id'), await json(c))
    return contact ? c.json({ contact }) : c.json({ error: 'no such contact' }, 404)
  })
  api.delete('/contacts/:id', (c) => {
    net.deleteContact(user(c)!.id, c.req.param('id'))
    return c.json({ ok: true })
  })
  api.post('/contacts/:id/connect', async (c) => {
    const contact = net.contact(user(c)!.id, c.req.param('id'))
    if (!contact) return c.json({ error: 'no such contact' }, 404)
    const body = await json(c)
    return c.json({ result: await askToConnect(user(c)!, contact, body.note ? String(body.note) : null) })
  })
  api.post('/contacts/:id/recommend', async (c) => {
    const contact = net.contact(user(c)!.id, c.req.param('id'))
    if (!contact) return c.json({ error: 'no such contact' }, 404)
    const body = await json(c)
    try {
      const { rec, to } = recommend(user(c)!, contact, String(body.to ?? ''), body.note ? String(body.note) : null)
      return c.json({ recommendation: rec, to: userOut(to) }, 201)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }
  })
  api.get('/recommendations', (c) => c.json({ recommendations: recsFor(user(c)!).map(({ rec, from }) => ({ ...rec, from: userOut(from) })) }))
  api.post('/recommendations/:id/save', (c) => {
    const contact = net.saveRecommendation(user(c)!.id, c.req.param('id'))
    return contact ? c.json({ contact }) : c.json({ error: 'no such recommendation' }, 404)
  })
  api.post('/recommendations/:id/dismiss', (c) => {
    net.dismissRecommendation(user(c)!.id, c.req.param('id'))
    return c.json({ ok: true })
  })
  api.post('/contacts/import', async (c) => {
    const text = await c.req.text()
    if (text.length > MAX_VCF) return c.json({ error: 'vCard file over 5 MB' }, 400)
    return c.json({ imported: importVcards(net, user(c)!.id, text, asCircle(c.req.query('circle'))) })
  })
  api.get('/contacts.vcf', (c) => c.text(toVcard(net.contacts(user(c)!.id))))

  api.get('/inbox', (c) => {
    const u = user(c)!
    return c.json({ unread: net.unreadCount(u.id), threads: net.threads(u.id).map((t) => ({ with: userOut(t.other), unread: t.unread, last: t.last })), reachable: net.reachable(u.id).map(userOut) })
  })
  api.get('/inbox/:user', (c) => {
    const other = counterpart(c)
    return other ? c.json({ with: userOut(other), can_message: net.canMessage(user(c)!.id, other.id), messages: net.conversation(user(c)!.id, other.id) }) : c.json({ error: 'no conversation with that user' }, 404)
  })
  api.post('/inbox/:user', async (c) => {
    const other = counterpart(c)
    if (!other) return c.json({ error: 'no conversation with that user' }, 404)
    try {
      return c.json({ message: await sendMessage(user(c)!, other, String((await json(c)).body ?? '')) }, 201)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }
  })
}

/** Add every card whose email is not already in the network. */
export function importVcards(net: Network, ownerId: string, text: string, circle: Circle): { added: number; skipped: number } {
  let added = 0
  let skipped = 0
  net.store.tx(() => {
    for (const card of parseVcards(text, circle).slice(0, 5000)) {
      const emails = (card.emails as { value: string }[]).map((e) => validEmail(e.value)).filter(Boolean) as string[]
      if (emails.some((e) => net.contactByEmail(ownerId, e))) {
        skipped++
        continue
      }
      net.addContact(ownerId, card)
      added++
    }
  })
  return { added, skipped }
}
