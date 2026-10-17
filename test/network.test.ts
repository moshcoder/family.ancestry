import { describe, expect, test } from 'bun:test'
import { Store, type User } from '../src/db.ts'
import { Auth, type Mail } from '../src/auth.ts'
import { createApp, parseEmails } from '../src/server.ts'
import { Network, parseAddresses, parseLabeled, parseVcards, toVcard } from '../src/network.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

/** One app, many browsers: each `as(user)` is a signed-in session with its own cookie. */
function world() {
  const store = new Store(':memory:')
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const net = new Network(store)
  const app = createApp({ store, auth, site: SITE, net })
  const as = (user: User) => {
    const cookie = `fa_session=${auth.createSession(user.id)}; fa_csrf=${CSRF}`
    const get = (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } })
    const post = (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) })
    return { get, post }
  }
  const user = (email: string, name: string | null = null) => {
    const u = store.findOrCreateUser(email)
    if (name) store.setUserName(u.id, name)
    return store.user(u.id)!
  }
  return { store, auth, net, app, mail, as, user }
}

describe('parsing', () => {
  test('labeled lines, addresses and email lists', () => {
    expect(parseLabeled('work: A@B.com\nhttps://x.example/y\n\n+1 555 0100')).toEqual([
      { label: 'work', value: 'A@B.com' },
      { label: null, value: 'https://x.example/y' },
      { label: null, value: '+1 555 0100' },
    ])
    expect(parseAddresses('home: 1 Main St\nSpringfield\n\nPO Box 9')).toEqual([
      { label: 'home', lines: '1 Main St\nSpringfield' },
      { label: null, lines: 'PO Box 9' },
    ])
    expect(parseEmails('a@x.com, B@x.com\nnot-an-email a@x.com')).toEqual(['a@x.com', 'b@x.com'])
  })

  test('vCard survives a round trip, folded lines and all', () => {
    const { store, net, user } = world()
    void store
    const me = user('me@example.com')
    net.addContact(me.id, { name: 'Rose Ettinger', circle: 'family', relationship: 'aunt', emails: 'home: rose@example.com', phones: 'cell: 555 0100', addresses: 'home: 12 Elm St, Apt 3\nChicago', birthday: '14 MAY 1958', notes: 'Makes the best strudel; ask her about the farm.\nSecond line.', company: 'Ettinger Bakery' })
    const vcf = toVcard(net.contacts(me.id))
    const [card] = parseVcards(vcf)
    expect(card).toMatchObject({ name: 'Rose Ettinger', circle: 'family', company: 'Ettinger Bakery', birthday: '14 MAY 1958', notes: 'Makes the best strudel; ask her about the farm.\nSecond line.' })
    expect((card as any).emails).toEqual([{ label: 'home', value: 'rose@example.com' }])
    expect((card as any).addresses[0].lines).toBe('12 Elm St, Apt 3\nChicago')
  })

  test('reads cards from other apps', () => {
    const cards = parseVcards('BEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;Jane;;;\r\nTEL;CELL:555 0199\r\nitem1.EMAIL;type=INTERNET;type=WORK:jane@corp.example\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ name: 'Jane Doe', phones: [{ label: 'cell', value: '555 0199' }], emails: [{ label: 'work', value: 'jane@corp.example' }] })
  })
})

describe('network store', () => {
  test('contacts are private to whoever saved them', () => {
    const { net, user } = world()
    const a = user('a@example.com')
    const b = user('b@example.com')
    const c = net.addContact(a.id, { name: 'Cousin Vinny', circle: 'family' })
    expect(net.contact(b.id, c.id)).toBeNull()
    expect(net.contacts(b.id)).toHaveLength(0)
    expect(net.contacts(a.id, { q: 'vinny' })).toHaveLength(1)
    expect(net.circleCounts(a.id)).toEqual({ family: 1, friends: 0, neighbors: 0, business: 0 })
  })

  test('messages only between people who know each other; a block ends it both ways', () => {
    const { store, net, user } = world()
    const a = user('a@example.com')
    const b = user('b@example.com')
    const stranger = user('spam@example.com')
    expect(net.canMessage(stranger.id, a.id)).toBe(false)
    expect(() => net.send(stranger.id, a.id, 'buy my course')).toThrow()

    const token = net.createConnectRequest(a.id, b.email, 'friends', net.addContact(a.id, { name: 'Bee', emails: [b.email] }).id)
    expect(net.acceptConnectRequest(token, a)).toBeNull() // not your own
    expect(net.acceptConnectRequest(token, b)?.id).toBe(a.id)
    expect(net.acceptConnectRequest(token, b)).toBeNull() // once
    expect(net.contactByEmail(a.id, b.email)?.linked_user_id).toBe(b.id)
    expect(net.contactByEmail(b.id, a.email)?.linked_user_id).toBe(a.id)

    net.send(a.id, b.id, 'hi Bee')
    net.send(a.id, b.id, 'are you coming Sunday?')
    expect(net.unreadCount(b.id)).toBe(2)
    expect(net.threads(b.id)[0]).toMatchObject({ other: { id: a.id }, unread: 2 })
    expect(net.conversation(b.id, a.id).map((m) => m.body)).toEqual(['hi Bee', 'are you coming Sunday?'])
    expect(net.unreadCount(b.id)).toBe(0)

    net.block(b.id, a.id)
    expect(net.canMessage(a.id, b.id)).toBe(false)
    expect(net.canMessage(b.id, a.id)).toBe(false)
    net.unblock(b.id, a.id)

    // Sharing a tree is enough, without a connection.
    const tree = store.createTree(a.id, 'Fam')
    store.setMember(tree.id, stranger.id, 'viewer')
    expect(net.canMessage(stranger.id, a.id)).toBe(true)
    expect(net.reachable(a.id).map((u) => u.id).sort()).toEqual([b.id, stranger.id].sort())
  })
  test('recommend a neighbor: only to people you know, card only, saved once', () => {
    const { store, net, user } = world()
    const a = user('a@example.com', 'Ann')
    const b = user('b@example.com', 'Bob')
    const stranger = user('spam@example.com')
    const mike = net.addContact(a.id, { name: 'Mike Russo', circle: 'neighbors', relationship: 'next door', title: 'Handyman', phones: 'cell: 555 0111', emails: 'mike@example.com', notes: 'owes us a ladder' })
    expect(net.circleCounts(a.id).neighbors).toBe(1)
    expect(() => net.recommend(a, stranger.id, mike)).toThrow()
    expect(net.recommendationsFor(stranger.id)).toHaveLength(0)

    store.setMember(store.createTree(a.id, 'Fam').id, b.id, 'viewer')
    const rec = net.recommend(a, b.id, mike, 'Fixed our fence in a day')
    expect(rec.card).toMatchObject({ name: 'Mike Russo', circle: 'neighbors', title: 'Handyman' })
    expect(JSON.stringify(rec.card)).not.toContain('ladder')
    expect(JSON.stringify(rec.card)).not.toContain('next door')
    expect(net.conversation(b.id, a.id).at(-1)!.body).toBe('Recommending Mike Russo · Handyman\n555 0111 · mike@example.com\nFixed our fence in a day')
    expect(net.recommendationsFor(b.id).map((r) => r.id)).toEqual([rec.id])
    expect(net.recommendation(stranger.id, rec.id)).toBeNull()

    const saved = net.saveRecommendation(b.id, rec.id)!
    expect(saved).toMatchObject({ owner_id: b.id, name: 'Mike Russo', circle: 'neighbors', notes: 'Recommended by Ann: Fixed our fence in a day' })
    expect(net.saveRecommendation(b.id, rec.id)!.id).toBe(saved.id)
    expect(net.contacts(b.id)).toHaveLength(1)
    expect(net.recommendationsFor(b.id)).toHaveLength(0)

    const again = net.recommend(a, b.id, mike)
    net.dismissRecommendation(b.id, again.id)
    expect(net.recommendationsFor(b.id)).toHaveLength(0)
  })
})

describe('join the family', () => {
  test('add a person, invite them, they join as themselves and keep their own profile', async () => {
    const w = world()
    const tony = w.user('tony@example.com', 'Tony')
    const owner = w.as(tony)
    const treeId = (await owner.post('/trees', { name: 'Ettinger family' })).headers.get('location')!.split('/').pop()!

    const added = await owner.post(`/t/${treeId}/people`, { given: 'Lily', surname: 'Ettinger', living: '1' })
    expect(added.headers.get('location')).toMatch(/\?added=1$/)
    const page = await (await owner.get(added.headers.get('location')!)).text()
    expect(page).toContain('Invite them to manage their own profile and join the family')
    const lilyId = added.headers.get('location')!.split('/').pop()!.split('?')[0]!

    const sent = await owner.post(`/t/${treeId}/invites`, { email: 'lily@example.com', person_id: lilyId, back: 'person' })
    expect(sent.headers.get('location')).toContain(`/t/${treeId}/p/${lilyId}?ok=`)
    const mail = w.mail.at(-1)!
    expect(mail.to).toBe('lily@example.com')
    expect(mail.subject).toBe('Tony added you to the Ettinger family family tree')
    expect(mail.text).toContain('as Lily Ettinger')
    // She is in Tony's network already, as family, linked to her person.
    expect(w.net.contactByEmail(tony.id, 'lily@example.com')).toMatchObject({ circle: 'family', tree_id: treeId, person_id: lilyId, name: 'Lily Ettinger' })

    const lily = w.user('lily@example.com')
    const her = w.as(lily)
    const url = mail.text.match(/(http:\/\/family\.test\/invite\/\S+)/)![1]!.replace(SITE, '')
    expect(await (await her.get(url)).text()).toContain('Join the family')
    const joined = await her.post(url)
    expect(joined.headers.get('location')).toContain(`/t/${treeId}/p/${lilyId}?welcome=1&ok=`)
    expect(w.store.role(treeId, lily.id)).toBe('viewer')
    expect(w.store.profilePerson(treeId, lily.id)).toBe(lilyId)

    // Her own profile: yes. Anyone else: no.
    expect((await her.post(`/t/${treeId}/p/${lilyId}`, { given: 'Lily', surname: 'Ettinger', birth_date: '2015', living: '1' })).status).toBe(302)
    expect(w.store.person(treeId, lilyId)!.birth_date).toBe('2015')
    const other = w.store.addPerson(treeId, { given: 'Robert' })
    expect((await her.post(`/t/${treeId}/p/${other.id}`, { given: 'Bob' })).status).toBe(403)
    expect(await (await owner.get(`/t/${treeId}/p/${lilyId}`)).text()).toContain('Managed by lily@example.com')

    // Joining connects them, so they can talk in the inbox.
    expect(w.net.connected(tony.id, lily.id)).toBe(true)
    expect((await her.post(`/inbox/${tony.id}`, { body: 'Thanks Uncle Tony!' })).status).toBe(302)
    expect(w.mail.at(-1)!.subject).toBe('lily@example.com sent you a message')
    expect(await (await owner.get('/inbox')).text()).toContain('Thanks Uncle Tony!')
    expect(await (await owner.get('/trees')).text()).toContain('<span class="badge">1</span>')
  })

  test('invite several people by email at once; strangers cannot open an inbox thread', async () => {
    const w = world()
    const tony = w.user('tony@example.com')
    const owner = w.as(tony)
    const treeId = (await owner.post('/trees', { name: 'Fam' })).headers.get('location')!.split('/').pop()!
    const res = await owner.post(`/t/${treeId}/invites`, { emails: 'a@example.com, b@example.com\nc@example.com', role: 'editor', note: 'Help me with Grandpa' })
    expect(res.status).toBe(200)
    expect(w.mail.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
    expect(w.mail[0]!.text).toContain('"Help me with Grandpa"')
    expect(w.store.pendingInvites(treeId)).toHaveLength(3)
    const html = await (await owner.get(`/t/${treeId}/members`)).text()
    expect(html).toContain('Waiting to join')

    await owner.post(`/t/${treeId}/invites/${w.store.pendingInvites(treeId)[0]!.id}/revoke`)
    expect(w.store.pendingInvites(treeId)).toHaveLength(2)

    const stranger = w.as(w.user('stranger@example.com'))
    expect((await stranger.get(`/inbox/${tony.id}`)).status).toBe(404)
    expect((await stranger.post(`/inbox/${tony.id}`, { body: 'hello friend, great opportunity' })).status).toBe(404)
  })

  test('the network pages and the contacts API', async () => {
    const w = world()
    const me = w.user('me@example.com', 'Me')
    const b = w.as(me)
    const made = await b.post('/network/contacts', { name: 'Dr. Patel', circle: 'business', relationship: 'our dentist', phones: 'office: 555 0142', emails: 'front@patel.example' })
    const id = made.headers.get('location')!.split('/').pop()!
    const page = await (await b.get(`/network/c/${id}`)).text()
    expect(page).toContain('our dentist')
    expect(page).toContain('Ask to connect')
    expect(await (await b.get('/network?circle=business')).text()).toContain('Dr. Patel')
    expect(await (await b.get('/network?circle=family')).text()).not.toContain('Dr. Patel')

    await b.post(`/network/c/${id}/connect`, { note: 'Is this the right email for appointments?' })
    expect(w.mail.at(-1)!.subject).toBe('Me wants to stay in touch on family.ancestry')

    const token = w.auth.createToken(me.id, 'test')
    const api = (path: string, init: RequestInit = {}) => w.app.request(`${SITE}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } })
    const created = (await (await api('/contacts', { method: 'POST', body: JSON.stringify({ name: 'Sam', email: 'sam@example.com', circle: 'friends' }) })).json()) as any
    expect(created.contact.emails).toEqual([{ label: null, value: 'sam@example.com' }])
    const list = (await (await api('/contacts?circle=friends')).json()) as any
    expect(list.contacts.map((c: any) => c.name)).toEqual(['Sam'])
    const imported = (await (await api('/contacts/import?circle=family', { method: 'POST', body: 'BEGIN:VCARD\nFN:Grandma June\nEMAIL:june@example.com\nEND:VCARD\nBEGIN:VCARD\nFN:Sam again\nEMAIL:sam@example.com\nEND:VCARD\n', headers: { 'content-type': 'text/vcard' } })).json()) as any
    expect(imported.imported).toEqual({ added: 1, skipped: 1 })
    expect((await api('/inbox')).status).toBe(200)

    // Recommend a neighbor to someone in my tree: it shows up in their inbox, one click saves it.
    const bob = w.user('bob@example.com', 'Bob')
    w.store.setMember(w.store.createTree(me.id, 'Fam').id, bob.id, 'viewer')
    const nb = (await b.post('/network/contacts', { name: 'Mike Russo', circle: 'neighbors', phones: '555 0111' })).headers.get('location')!.split('/').pop()!
    expect(await (await b.get(`/network/c/${nb}`)).text()).toContain('Recommend Mike Russo')
    expect(await (await b.get('/network?circle=neighbors')).text()).toContain('Mike Russo')
    const sent = await b.post(`/network/c/${nb}/recommend`, { to: bob.id, note: 'Great with fences' })
    expect(decodeURIComponent(sent.headers.get('location')!)).toContain('Recommended Mike Russo to Bob.')
    expect(w.mail.at(-1)!.subject).toBe('Me recommended Mike Russo')
    const bobPage = w.as(bob)
    const inbox = await (await bobPage.get('/inbox')).text()
    expect(inbox).toContain('Recommended to you')
    expect(inbox).toContain('Great with fences')
    const recId = w.net.recommendationsFor(bob.id)[0]!.id
    expect((await w.as(w.user('nosy@example.com')).post(`/network/r/${recId}/save`)).headers.get('location')).toBe('/inbox')
    const savedAt = (await bobPage.post(`/network/r/${recId}/save`)).headers.get('location')!
    expect(await (await bobPage.get(savedAt.split('?')[0]!)).text()).toContain('Recommended by Me: Great with fences')
    const viaApi = (await (await api(`/contacts/${nb}/recommend`, { method: 'POST', body: JSON.stringify({ to: bob.id }) })).json()) as any
    expect(viaApi.to.id).toBe(bob.id)
    expect((await api(`/contacts/${nb}/recommend`, { method: 'POST', body: JSON.stringify({ to: w.user('x@example.com').id }) })).status).toBe(400)
    expect(await (await b.get('/settings')).text()).toContain('included free')
  })

  test('add a friend from their page in the tree, and ask them to connect in the same step', async () => {
    const w = world()
    const me = w.user('me@example.com', 'Me')
    const viewer = w.user('viewer@example.com', 'Viewer')
    const tree = w.store.createTree(me.id, 'Fam')
    w.store.setMember(tree.id, viewer.id, 'viewer')
    const kurt = w.store.addPerson(tree.id, { given: 'Kurt', surname: 'Rademacher', birth_date: '1960', living: '1' })
    const dog = w.store.addPet(tree.id, { given: 'Rex', species: 'Dog' }, [kurt.id])
    const b = w.as(viewer)

    const before = await (await b.get(`/t/${tree.id}/p/${kurt.id}`)).text()
    expect(before).toContain('Add Kurt to my network')
    expect(before).toContain(`/t/${tree.id}/p/${kurt.id}/network`)

    // A viewer may add, too: the contact is theirs, not the tree's.
    const added = await b.post(`/t/${tree.id}/p/${kurt.id}/network`, { circle: 'friends', email: 'Kurt@Example.com', connect: '1', note: 'Hey Kurt' })
    expect(decodeURIComponent(added.headers.get('location')!)).toContain('Kurt Rademacher is in your friends. Request sent to kurt@example.com.')
    expect(w.mail.at(-1)!.to).toBe('kurt@example.com')
    expect(w.mail.at(-1)!.text).toContain('Hey Kurt')
    const contact = w.net.contactForPerson(viewer.id, tree.id, kurt.id)!
    expect(contact).toMatchObject({ name: 'Kurt Rademacher', circle: 'friends', birthday: '1960', emails: [{ label: null, value: 'kurt@example.com' }] })
    expect(w.net.contacts(me.id)).toHaveLength(0)
    expect(await (await b.get(`/t/${tree.id}/p/${kurt.id}`)).text()).toContain('In my network · Friends')
    expect(await (await b.get(`/network/c/${contact.id}`)).text()).toContain('In Fam')

    // Again: same contact, new circle, no second row and no email without connect.
    const mails = w.mail.length
    await b.post(`/t/${tree.id}/p/${kurt.id}/network`, { circle: 'family' })
    expect(w.net.contacts(viewer.id)).toHaveLength(1)
    expect(w.net.contactForPerson(viewer.id, tree.id, kurt.id)!.circle).toBe('family')
    expect(w.mail.length).toBe(mails)

    // Your own page invites a friend instead.
    const meAsKurt = w.user('kurt@example.com', 'Kurt')
    w.store.setMember(tree.id, meAsKurt.id, 'viewer')
    expect(w.store.claimProfile(tree.id, kurt.id, meAsKurt.id)).toBe(true)
    const own = await (await w.as(meAsKurt).get(`/t/${tree.id}/p/${kurt.id}`)).text()
    expect(own).toContain('Invite a friend')
    expect(own).not.toContain('Add Kurt to my network')

    // Pets, strangers to the tree and unknown people get nothing.
    expect((await b.post(`/t/${tree.id}/p/${dog.id}/network`, {})).status).toBe(404)
    expect((await w.as(w.user('nosy@example.com')).post(`/t/${tree.id}/p/${kurt.id}/network`, {})).status).toBe(404)

    // API, and the one-step "add a friend" form on /network.
    const token = w.auth.createToken(me.id, 'test')
    const api = (path: string, body: unknown) => w.app.request(`${SITE}/api/v1${path}`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
    const viaApi = (await (await api(`/trees/${tree.id}/people/${kurt.id}/contact`, { relationship: 'brother-in-law' })).json()) as any
    expect(viaApi.contact).toMatchObject({ name: 'Kurt Rademacher', circle: 'friends', relationship: 'brother-in-law', person_id: kurt.id })
    expect(viaApi.result).toBe('Kurt Rademacher is in your friends.')
    const friend = (await (await api('/contacts', { name: 'Pat', email: 'pat@example.com', connect: true })).json()) as any
    expect(friend.result).toBe('Request sent to pat@example.com.')
    const mine = w.as(me)
    expect(await (await mine.get('/network')).text()).toContain('Email them to connect')
    const form = await mine.post('/network/contacts', { name: 'Lee', emails: 'lee@example.com', circle: 'friends', connect: '1', note_to_them: 'Hi Lee', notes: 'met at camp' })
    expect(decodeURIComponent(form.headers.get('location')!)).toContain('Request sent to lee@example.com.')
    expect(w.mail.at(-1)!.text).toContain('Hi Lee')
    expect(w.net.contactByEmail(me.id, 'lee@example.com')!.notes).toBe('met at camp')
  })
})
