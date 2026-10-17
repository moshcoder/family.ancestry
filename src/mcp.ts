/**
 * `ancestry mcp`: family.ancestry as an MCP server on stdio, so an AI assistant
 * can look things up in the family tree and help fill it in.
 *
 *   ancestry login                         once, to get a token
 *   claude mcp add ancestry -- ancestry mcp
 *
 * The assistant acts as you: it sees the trees you see and can change only the
 * ones you can edit.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PERSON_BONDS } from './db.js'
import { AncestryClient } from './client.js'
import { formatBusiness, formatDescendants, formatPedigree, formatPerson } from './cli.js'
import { VERSION } from './html.js'

const text = (value: string) => ({ content: [{ type: 'text', text: value }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))

export function createMcpServer(client = new AncestryClient()): McpServer {
  // Typed loosely: the SDK's generic tool() signature recurses past TypeScript's
  // instantiation depth with zod shapes. The shapes are still validated at runtime.
  const server: any = new McpServer({ name: 'family.ancestry', version: VERSION })
  const person = {
    given: z.string().max(200).optional(),
    surname: z.string().max(200).optional(),
    sex: z.enum(['M', 'F', 'X', 'U']).optional(),
    birth_date: z.string().max(200).optional().describe('free text, GEDCOM style: "12 MAR 1901", "ABT 1890"'),
    birth_place: z.string().max(200).optional(),
    death_date: z.string().max(200).optional(),
    death_place: z.string().max(200).optional(),
    living: z.boolean().optional(),
    notes: z.string().max(20000).optional(),
  }

  server.tool('list_trees', 'List the family trees you can see, with your role in each and how many people they hold.', {}, async () => json(await client.trees()))

  server.tool(
    'search_people',
    'Search the people in a family tree by name, place or year. Every word must match. Returns ids to use with the other tools. Businesses: search_businesses.',
    { tree_id: z.string(), query: z.string().max(200).default(''), limit: z.number().int().min(1).max(500).optional() },
    async ({ tree_id, query, limit }: any) => json((await client.people(tree_id, query, limit ?? 50)).map((p) => ({ id: p.id, name: p.name, birth: [p.birth_date, p.birth_place].filter(Boolean).join(', '), death: [p.death_date, p.death_place].filter(Boolean).join(', '), living: !!p.living }))),
  )

  server.tool('get_person', 'Everything about one person: dates, places, parents, siblings, partners, children, businesses, events, sources, notes.', { tree_id: z.string(), person_id: z.string() }, async ({ tree_id, person_id }: any) => text(formatPerson(await client.person(tree_id, person_id))))

  server.tool(
    'add_person',
    "Add someone to a tree. To attach them to an existing person, give relative_of (that person's id) and as: parent, partner, child, sibling, grandparent, great_grandparent, grandchild, aunt_uncle, niece_nephew or cousin (what the NEW person is to them; via picks who is in between, and with none an \"Unknown\" person fills the gap). partner takes kind: married|engaged|partners|dating (boyfriend or girlfriend)|divorced. sibling takes sibling: full|half|adopted|foster|step and via (the shared parent, or the step-parent). grandparent takes via (which parent); without one, an 'Unknown' parent is put in between, for someone who never knew their parents. raised: true also records that they raised that person.",
    { tree_id: z.string(), ...person, relative_of: z.string().optional(), as: z.enum(['parent', 'partner', 'child', 'sibling', 'grandparent', 'great_grandparent', 'grandchild', 'aunt_uncle', 'niece_nephew', 'cousin']).optional(), relation: z.enum(['birth', 'adopted', 'step', 'foster']).optional(), kind: z.enum(['married', 'engaged', 'partners', 'dating', 'divorced']).optional(), sibling: z.enum(['full', 'half', 'adopted', 'foster', 'step']).optional(), via: z.string().optional(), raised: z.boolean().optional() },
    async ({ tree_id, ...fields }: any) => {
      const p = await client.addPerson(tree_id, { ...fields, raised: fields.raised ? '1' : undefined })
      return text(`Added ${p.name} (${p.id}).\n\n${formatPerson(p)}`)
    },
  )

  server.tool('update_person', 'Change facts about a person. Only the fields given are changed.', { tree_id: z.string(), person_id: z.string(), ...person }, async ({ tree_id, person_id, ...fields }: any) => text(formatPerson(await client.updatePerson(tree_id, person_id, fields))))

  server.tool(
    'link_relative',
    'Record that two people already in the tree are related: other_id is the parent, partner, child, sibling or grandparent of person_id. A partner takes kind: married, partners, dating (boyfriend or girlfriend) or divorced.',
    { tree_id: z.string(), person_id: z.string(), other_id: z.string(), as: z.enum(['parent', 'partner', 'child', 'sibling', 'grandparent', 'great_grandparent', 'grandchild', 'aunt_uncle', 'niece_nephew', 'cousin']), relation: z.enum(['birth', 'adopted', 'step', 'foster']).optional(), kind: z.enum(['married', 'engaged', 'partners', 'dating', 'divorced']).optional(), sibling: z.enum(['full', 'half', 'adopted', 'foster', 'step']).optional(), via: z.string().optional() },
    async ({ tree_id, person_id, other_id, ...rest }: any) => text(formatPerson(await client.addPerson(tree_id, { relative_of: person_id, existing_id: other_id, ...rest }))),
  )

  server.tool(
    'add_bond',
    `Record a bond that is not descent: other_id is person_id's <kind> (${PERSON_BONDS.join(', ')}). Grandparents who raised someone show as both grandparents and "raised by"; a coworker or neighbor needs no family line at all.`,
    { tree_id: z.string(), person_id: z.string(), other_id: z.string(), kind: z.enum(PERSON_BONDS), note: z.string().max(500).optional() },
    async ({ tree_id, person_id, ...body }: any) => text(formatPerson((await client.addBond(tree_id, person_id, body)).person)),
  )

  server.tool(
    'add_pet',
    "Add a family pet with its owner(s). Needs the tree's Family plan; without it the answer says how to get it.",
    { tree_id: z.string(), owner_ids: z.array(z.string()).min(1), name: z.string().max(200), species: z.string().max(80).optional(), birth_date: z.string().max(200).optional(), death_date: z.string().max(200).optional(), notes: z.string().max(20000).optional() },
    async ({ tree_id, name, ...fields }: any) => {
      const pet = await client.addPet(tree_id, { given: name, ...fields })
      return text(`Added ${pet.name} (${pet.id})${pet.species ? `, ${pet.species}` : ''}.`)
    },
  )

  // ---- businesses: their own entries beside the tree, free ----
  const role = z.enum(['founder', 'owner', 'partner', 'investor', 'officer', 'manager', 'employee', 'apprentice', 'other'])
  const business = {
    name: z.string().max(200).optional(),
    category: z.string().max(80).optional().describe('what it did: "Plumbing", "Farm", "Bakery"'),
    founded: z.string().max(200).optional(),
    closed: z.string().max(200).optional(),
    place: z.string().max(200).optional(),
    website: z.string().max(500).optional(),
    notes: z.string().max(20000).optional(),
  }
  const roleFields = { role, title: z.string().max(120).optional(), start_date: z.string().max(200).optional(), end_date: z.string().max(200).optional(), note: z.string().max(500).optional() }

  server.tool('list_albums', "The family's photo albums in a tree, with how many photos each holds, and whether the user may add photos (any member who signed in with their email).", { tree_id: z.string() }, async ({ tree_id }: any) => json(await client.albums(tree_id)))
  server.tool('list_photos', 'Photos in a tree, newest first: all of them, or one album (album_id from list_albums). Each has its caption, who is in it (person_id), who shared it, and a link.', { tree_id: z.string(), album_id: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, async ({ tree_id, album_id, limit }: any) => json((await client.photos(tree_id, album_id ?? '', limit ?? 100)).map((p) => ({ id: p.id, caption: p.caption, filename: p.filename, person_id: p.person_id, album_id: p.album_id, shared_by: p.uploader, date: new Date(p.created_at).toISOString().slice(0, 10), page: p.page }))))
  server.tool('create_album', 'Start a photo album in a tree ("Christmas 1985"). Any member who signed in with their email can.', { tree_id: z.string(), title: z.string().min(1).max(200), description: z.string().max(2000).optional() }, async ({ tree_id, title, description }: any) => json(await client.addAlbum(tree_id, title, description)))
  server.tool(
    'add_photo',
    'Add one photo to the family album: the image bytes as base64 (JPEG, PNG, GIF, WebP or AVIF, up to 8 MB), with an optional caption, album (album_id, or album_title to use or start one by name) and who is in it (person_id). Only photos the user gave you.',
    { tree_id: z.string(), filename: z.string().max(200), data_base64: z.string().max(12_000_000), caption: z.string().max(1000).optional(), album_id: z.string().optional(), album_title: z.string().max(200).optional(), person_id: z.string().optional() },
    async ({ tree_id, filename, data_base64, ...fields }: any) => json(await client.uploadPhoto(tree_id, filename, new Uint8Array(Buffer.from(data_base64, 'base64')), fields)),
  )
  server.tool('update_photo', "Change a photo's caption, who is in it, or its album. Only whoever shared it, or an editor, can.", { tree_id: z.string(), photo_id: z.string(), caption: z.string().max(1000).nullable().optional(), person_id: z.string().nullable().optional(), album_id: z.string().nullable().optional() }, async ({ tree_id, photo_id, ...fields }: any) => json(await client.updatePhoto(tree_id, photo_id, fields)))

  server.tool('search_businesses', 'Search the family businesses in a tree (companies, farms, shops) by name, trade, town, year, or the name of someone in it. Empty query lists them all.', { tree_id: z.string(), query: z.string().max(200).default('') }, async ({ tree_id, query }: any) => json((await client.businesses(tree_id, query, 200)).map((b) => ({ id: b.id, name: b.name, category: b.category, founded: b.founded, closed: b.closed, place: b.place, people: b.people.map((r) => `${r.label}: ${r.name}`) }))))
  server.tool('get_business', 'One business: what it did, when, where, its website, notes, and its founders, owners, partners, investors and staff (with role ids).', { tree_id: z.string(), business_id: z.string() }, async ({ tree_id, business_id }: any) => text(formatBusiness(await client.business(tree_id, business_id))))
  server.tool(
    'add_business',
    'Add a family business ("Ettinger Plumbing") as its own entry, optionally with the people in it (person ids from search_people). Businesses never appear in pedigree or descendants.',
    { tree_id: z.string(), ...business, name: z.string().min(1).max(200), people: z.array(z.object({ person_id: z.string(), ...roleFields })).max(50).optional() },
    async ({ tree_id, ...fields }: any) => {
      const b = await client.addBusiness(tree_id, fields)
      return text(`Added ${b.name} (${b.id}).

${formatBusiness(b)}`)
    },
  )
  server.tool('update_business', 'Change facts about a business. Only the fields given are changed.', { tree_id: z.string(), business_id: z.string(), ...business }, async ({ tree_id, business_id, ...fields }: any) => text(formatBusiness(await client.updateBusiness(tree_id, business_id, fields))))
  server.tool('add_business_role', "Record someone's place in a business: founder, owner, partner, investor, officer, manager, employee, apprentice or other, with an optional title and years.", { tree_id: z.string(), business_id: z.string(), person_id: z.string(), ...roleFields }, async ({ tree_id, business_id, ...body }: any) => text(formatBusiness(await client.addBusinessRole(tree_id, business_id, body))))
  server.tool('remove_business_role', "Remove one person's role from a business (role_id from get_business). The person stays in the tree.", { tree_id: z.string(), role_id: z.string() }, async ({ tree_id, role_id }: any) => {
    await client.removeBusinessRole(tree_id, role_id)
    return text('Removed.')
  })
  server.tool('link_business_contact', "Link a business to one of the user's own Network contacts (contact_id from list_contacts), or create: true to add it to their network as a business contact. Private to the user.", { tree_id: z.string(), business_id: z.string(), contact_id: z.string().nullable().optional(), create: z.boolean().optional() }, async ({ tree_id, business_id, ...body }: any) => json(await client.linkBusinessContact(tree_id, business_id, body)))

  server.tool(
    'local_recommendations',
    'Local businesses recommended by people the user knows (family, neighbors, friends, tree-mates), best first, with who vouched and why. Search by what they do or a town.',
    { query: z.string().max(200).default(''), category: z.string().max(60).optional() },
    async ({ query, category }: any) => json(await client.local(query, category)),
  )
  server.tool(
    'recommend_business',
    'Recommend a local business to everyone who knows the user. Only do this when the user asked to recommend it.',
    { name: z.string().max(200), category: z.string().max(60), town: z.string().max(120).optional(), phone: z.string().max(60).optional(), website: z.string().max(500).optional(), note: z.string().max(1000).optional() },
    async (body: any) => json(await client.recommendBusiness(body)),
  )

  server.tool('family_plan', "Whether a tree is on the one-time Family plan (pets, invite everyone), its price, and where to pay.", { tree_id: z.string() }, async ({ tree_id }: any) => json(await client.plan(tree_id)))

  server.tool(
    'add_event',
    "Record something that happened to a person. type is what happened: Birth or Death (sets their dates), Marriage, Remarriage, Started dating, Moved in together, Engagement, Separation, Divorce or Widowed (with: the partner's person id, or with_given/with_surname for someone new), Child born, Adopted a child, Took in a foster child or Became a step-parent (child: the child's person id, or child_given/child_surname; with: the other parent / the partner whose child it is), or a plain event: Occupation, Job change, Promotion, Started a business, Retirement, Education, Graduation, Military, Moved, Immigration, Emigration, Naturalization, Census, Baptism, Christening, Confirmation, Bar mitzvah, Bat mitzvah, Religion, Burial, Cremation, Medical, Award, or any other name.",
    { tree_id: z.string(), person_id: z.string(), type: z.string().max(60), date: z.string().max(200).optional(), place: z.string().max(200).optional(), description: z.string().max(5000).optional(), with: z.string().optional(), with_given: z.string().max(120).optional(), with_surname: z.string().max(120).optional(), child: z.string().optional(), child_given: z.string().max(120).optional(), child_surname: z.string().max(120).optional(), child_sex: z.enum(['M', 'F', 'X', 'U']).optional() },
    async ({ tree_id, person_id, with: withId, ...event }: any) => text((await client.addEvent(tree_id, person_id, { ...event, with_person: withId })).message ?? 'Event added.'),
  )

  server.tool('pedigree', "A person's ancestors, generation by generation (Ahnentafel numbered: father 2n, mother 2n+1).", { tree_id: z.string(), person_id: z.string(), generations: z.number().int().min(2).max(8).optional() }, async ({ tree_id, person_id, generations }: any) => text(formatPedigree(await client.pedigree(tree_id, person_id, generations ?? 4), generations ?? 4)))

  server.tool('descendants', "A person's descendants with their partners.", { tree_id: z.string(), person_id: z.string(), generations: z.number().int().min(1).max(10).optional() }, async ({ tree_id, person_id, generations }: any) => text(formatDescendants(await client.descendants(tree_id, person_id, generations ?? 3))))

  server.tool('relationship', 'How two people in a tree are related, in words ("second cousin once removed") and as the chain of people between them.', { tree_id: z.string(), a: z.string(), b: z.string() }, async ({ tree_id, a, b }: any) => json(await client.relate(tree_id, a, b)))

  server.tool('export_gedcom', 'Export a tree as GEDCOM 5.5.1 text. privacy hides details of living people.', { tree_id: z.string(), privacy: z.boolean().optional() }, async ({ tree_id, privacy }: any) => text(await client.exportGedcom(tree_id, privacy ?? true)))

  server.tool('import_gedcom', 'Import GEDCOM text into a tree you can edit.', { tree_id: z.string(), gedcom: z.string().max(25_000_000) }, async ({ tree_id, gedcom }: any) => json(await client.importGedcom(tree_id, gedcom)))

  server.tool(
    'invite_to_tree',
    'Email invites to a family tree. emails may be addresses or pasted lines like "Aunt Rose <rose@x.com>": a name that matches someone in the tree invites them to BE that person (or give person_id). Up to 20 at once on the free plan, 500 on the Family plan.',
    { tree_id: z.string(), emails: z.array(z.string().max(100_000)).min(1).max(500), role: z.enum(['viewer', 'editor', 'admin']).optional(), person_id: z.string().optional(), note: z.string().max(1000).optional() },
    async ({ tree_id, emails, ...opts }: any) => json(await client.invite(tree_id, emails, opts)),
  )

  server.tool('business_team', "A family business's team: people with accounts who work there (invited to the business, never to the tree), pending invites and requests to join.", { tree_id: z.string(), business_id: z.string() }, async ({ tree_id, business_id }: any) => json(await client.team(tree_id, business_id)))
  server.tool('invite_to_team', 'Email someone an invite to join a business as an employee, manager, officer, partner or owner. They see the business and its team, never the family tree. Only when the user asked.', { tree_id: z.string(), business_id: z.string(), email: z.string().email(), role: z.enum(['employee', 'manager', 'officer', 'partner', 'owner', 'apprentice', 'other']).optional(), title: z.string().max(200).optional(), note: z.string().max(1000).optional() }, async ({ tree_id, business_id, ...body }: any) => text(await client.inviteToTeam(tree_id, business_id, body)))
  server.tool('my_work', 'Businesses whose team the user is on.', {}, async () => json(await client.work()))
  server.tool('list_families', 'Families listed publicly at /families: id, name and the note they wrote. Never the people in a tree.', { query: z.string().max(200).default('') }, async ({ query }: any) => json(await client.families(query)))
  server.tool('ask_to_join', 'Ask a listed family for an invite: a name, an email (the user\'s, or a relative\'s they are asking for) and how they know the family. Only when the user asked.', { family_id: z.string(), name: z.string().max(120), email: z.string().email(), circle: z.enum(['family', 'friends', 'neighbors', 'business']).optional(), note: z.string().max(1000).optional() }, async ({ family_id, ...body }: any) => text(await client.askToJoin(family_id, body)))
  server.tool('tree_listing', "Whether a tree is listed at /families, its public note and URL. With listed or listing (owner only) it changes them. A listing shows the name and note, never the tree.", { tree_id: z.string(), listed: z.boolean().optional(), listing: z.string().max(1000).nullable().optional() }, async ({ tree_id, ...body }: any) => json(body.listed === undefined && body.listing === undefined ? await client.listing(tree_id) : await client.setListing(tree_id, body)))
  server.tool('join_requests', 'People asking a listed tree for an invite (owners and editors).', { tree_id: z.string() }, async ({ tree_id }: any) => json(await client.joinRequests(tree_id)))
  server.tool('answer_join_request', 'Invite (as a viewer, by the usual email) or decline someone asking to join. Declining tells them nothing. Only when the user decided.', { tree_id: z.string(), request_id: z.string(), answer: z.enum(['invite', 'decline']) }, async ({ tree_id, request_id, answer }: any) => json(await client.answerJoinRequest(tree_id, request_id, answer)))
  server.tool('tree_members', 'Who belongs to a tree, their role, and which person each one is (if they claimed a profile).', { tree_id: z.string() }, async ({ tree_id }: any) => json(await client.members(tree_id)))

  // ---- network: the people in your life, private to you ----
  const contact = {
    name: z.string().max(200).optional(),
    nickname: z.string().max(200).optional(),
    circle: z.enum(['family', 'friends', 'neighbors', 'business']).optional(),
    relationship: z.string().max(200).optional().describe('how you know them: "cousin", "college roommate", "our plumber"'),
    company: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    birthday: z.string().max(200).optional(),
    anniversary: z.string().max(200).optional(),
    emails: z.array(z.string()).max(20).optional().describe('"work: a@b.com" or just the address'),
    phones: z.array(z.string()).max(20).optional(),
    addresses: z.array(z.object({ label: z.string().optional(), lines: z.string() })).max(10).optional(),
    links: z.array(z.string().url()).max(20).optional(),
    notes: z.string().max(20000).optional(),
  }

  server.tool('list_contacts', "Search your network (family, friends, neighbors, business). Private to you; matches names, emails, phones, companies, addresses and notes.", { query: z.string().max(200).default(''), circle: z.enum(['family', 'friends', 'neighbors', 'business']).optional() }, async ({ query, circle }: any) => json(await client.contacts(query, circle)))
  server.tool('get_contact', 'Everything you keep about one contact.', { contact_id: z.string() }, async ({ contact_id }: any) => json(await client.contact(contact_id)))
  server.tool('add_contact', 'Add someone you know to your network. connect: true also emails them once to connect; only when the user asked.', { ...contact, connect: z.boolean().optional(), note_to_them: z.string().max(1000).optional().describe('a line in the connect email') }, async (fields: any) => json(await client.addContact(fields)))
  server.tool('add_person_to_network', "Add someone from a family tree to the user's own network (add a friend), linked to their page. circle defaults to friends; connect: true emails them once to connect (needs an email; only when the user asked).", { tree_id: z.string(), person_id: z.string(), circle: z.enum(['family', 'friends', 'neighbors', 'business']).optional(), email: z.string().email().optional(), relationship: z.string().max(200).optional(), connect: z.boolean().optional(), note: z.string().max(1000).optional() }, async ({ tree_id, person_id, ...body }: any) => json(await client.addPersonToNetwork(tree_id, person_id, body)))
  server.tool('update_contact', 'Change a contact. Lists (emails, phones, addresses, links) are replaced whole.', { contact_id: z.string(), ...contact }, async ({ contact_id, ...fields }: any) => json(await client.updateContact(contact_id, fields)))
  server.tool('connect_contact', 'Ask a contact to connect: one email from you, and if they say yes you can message each other. Use it for people the user actually knows, one at a time.', { contact_id: z.string(), note: z.string().max(1000).optional() }, async ({ contact_id, note }: any) => text(await client.connectContact(contact_id, note)))
  server.tool('recommend_contact', 'Recommend a contact (a neighbor, a plumber, a babysitter) to one person you are connected with or share a tree with; user_id comes from inbox().reachable. Sends their name, phones, emails, addresses and links, never your notes. Only when the user asked.', { contact_id: z.string(), user_id: z.string(), note: z.string().max(1000).optional() }, async ({ contact_id, user_id, note }: any) => json(await client.recommendContact(contact_id, user_id, note)))
  server.tool('recommendations', 'Contacts people you know recommended to you, waiting to be saved.', {}, async () => json(await client.recommendations()))
  server.tool('save_recommendation', 'Save a recommended contact into your network.', { recommendation_id: z.string() }, async ({ recommendation_id }: any) => json(await client.saveRecommendation(recommendation_id)))
  server.tool('inbox', 'Your conversations, newest first, with unread counts, and who you could write to.', {}, async () => json(await client.inbox()))
  server.tool('read_conversation', 'The messages between you and one person (marks them read).', { user_id: z.string() }, async ({ user_id }: any) => json(await client.conversation(user_id)))
  server.tool('send_message', 'Send a private message to one person you are connected with or share a tree with. Only send what the user asked you to send.', { user_id: z.string(), body: z.string().min(1).max(5000) }, async ({ user_id, body }: any) => json(await client.sendMessage(user_id, body)))

  return server
}

export async function runMcp(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport())
}
