# family.ancestry

Private family trees for your family. What you'd use Ancestry for, without the
subscription, and without your family's history becoming someone else's product.
Open source (MIT).

**https://family.ancestry**, a name on the [Moshpit network](https://pit.world).
The desktop app, the CLI and the MCP server reach it by themselves; a browser
needs [one setting](https://pit.world/connect).

- **Trees** you build together: editors add and fix, viewers look. Invite by email
  or by link: **paste a whole list** (a To: line, a spreadsheet column,
  `Aunt Rose <rose@example.com>`), 20 at a time, 500 on the Family plan.
- **Families overlap.** Start a tree (or fill one) by ticking people you already have:
  anyone in your other trees or your network. They come over with their dates, events and
  photo; the partners, parents, children and bonds among the people you tick stay linked;
  anyone who has an account keeps their own profile and can see the new tree.
  `ancestry pickable`, `ancestry bring`, `ancestry new --from`, MCP `bring_people`.
- **Join the family as yourself.** Right after you add someone, the page quietly offers
  to invite them; they join *as that person* and keep their own profile up to date,
  even as a viewer. A pasted name that matches someone in the tree invites them as that
  person; everyone else picks themselves ("Which one is you?") or adds themselves when
  they join, then adds a photo. A profile is only ever claimed by the email address the
  invite went to: signing in with an emailed link is the proof.
- **Local:** businesses recommended by people you know. Your family, neighbors and
  friends say who they use (the plumber, the dentist, the bakery) and why; you see the
  picks of your connections and tree-mates, ranked by how many vouch for a place and how
  close they are to you. No strangers' reviews, nothing paid to the top. See [Local](#local).
- **Network (add-on, free for everyone):** family, friends, neighbors and business contacts with
  every detail you keep (emails, phones, addresses, birthdays, links, notes), vCard
  import/export, and a private **Inbox**. See [Network](#network).
- **People** with dates, places, notes and stories, photos, and a life timeline.
- **Every kind of family.** Partners (married, partners, or boyfriend / girlfriend) plus
  children (birth, adopted, step, foster), the GEDCOM way. Add a **brother or sister** directly: full (even when nobody knows the
  parents), half through a chosen parent, adopted, foster, or step through a step-parent.
  Add a **grandparent** when the parent between is unknown (an "Unknown" parent holds the
  place). And bonds that are not descent: **raised by**, guardian, godparent, caregiver,
  chosen family, and the rest of a life: friend, best friend, neighbor, roommate, coworker,
  business partner, employer, client, family doctor, classmate, teacher, mentor. Grandparents
  who raised you are both. All of it round-trips through
  GEDCOM (`PEDI`, `ASSO`/`RELA`).
- **Pets** (Family plan): the dogs, cats and horses that were family too, with owners,
  photos and stories. They never appear as anyone's parent or child, nor in GEDCOM.
- **Pedigree** (3–6 generations, Ahnentafel numbers) and **descendant** charts.
- **"How are we related?"** in words: *first cousin once removed*, *mother-in-law*,
  *half-sister*, *stepbrother*, *adoptive mother*, *grandfather (by adoption)*. Only a
  marriage makes an in-law: a daughter's boyfriend is *daughter's boyfriend*.
- **Sources and citations**, so you know where every fact came from.
- **GEDCOM 5.5.1 import and export.** Bring your tree from Ancestry, FamilySearch,
  MyHeritage, Gramps or RootsMagic, and take it with you. Exports can hide living people.
- **Family photo album**, free: every photo in the tree on one page (`/t/:tree/photos`), and
  albums ("Christmas 1985") that any verified member adds to, viewers included. Pick a whole
  batch at once; the page sends them one by one and shrinks anything over 8 MB. Tag who is in
  a photo and it shows on their page too.
- **Family businesses**, free: "Ettinger Plumbing" as its own entry, with its founders,
  owners, partners, investors and employees (titles and years), founded/closed dates,
  place, website, notes and photos. On each person's page and in search; never in a
  pedigree or descendant chart. GEDCOM carries them as a custom `_BUS` record.
- **Sign in** with an emailed link (which is also sign-up) or a passkey. No passwords.

## Every surface

| | |
|---|---|
| Web + phone (PWA) | https://family.ancestry, "Install app" from the browser menu |
| Desktop | macOS / Windows / Linux builds on the [releases page](https://github.com/moshcoder/family.ancestry/releases) |
| CLI | `bun add -g familyancestry`, then `ancestry login` |
| TUI | `ancestry tui` |
| MCP | `claude mcp add ancestry -- ancestry mcp` |
| API | JSON under `/api/v1`, `Authorization: Bearer fa_...` |

### CLI

```sh
ancestry login                       # browser sign-in (auth code + PKCE); or --token fa_...
ancestry import ~/Downloads/tree.ged # into a new tree, which becomes your default
ancestry people ettinger             # search
ancestry show "Johann Ettinger"
ancestry add --given Lily --surname Ettinger --born 2015 --living --child-of "Robert Ettinger"
ancestry add --given Sam --sibling-of Lily --sibling half --via Robert
ancestry add --given Rose --grandparent-of Lily --raised   # parents unknown: an "Unknown" parent goes between
ancestry bond Lily godparent "Aunt Karen"
ancestry pet Lily Rex --species Dog       # Family plan
ancestry plan                             # ancestry plan buy --chain USDC_POL
ancestry claim "Lily Ettinger"            # this is me
ancestry business add "Ettinger Plumbing" --category Plumbing --founded 1952 --place Sacramento --founder Karl
ancestry business role "Ettinger Plumbing" Robert owner --title "Master plumber" --from 1971 --to 1990
ancestry businesses plumbing              # ancestry business "Ettinger Plumbing" shows its people
ancestry business link "Ettinger Plumbing" "Ettinger office"   # to one of your contacts (or --create)
ancestry search ettinger                  # people and businesses
ancestry upload ~/Pictures/xmas85/*.jpg --album "Christmas 1985" --of Rose
ancestry albums                           # ancestry photos --album "Christmas 1985"
ancestry local plumber                    # who the people you know use
ancestry local add "Joe's Plumbing" --category Plumber --town Sacramento --note "Came on a Sunday"
ancestry pedigree Robert -g 4
ancestry descendants Johann
ancestry relate Robert Anna          # Anna Ettinger is Robert Ettinger's aunt.
ancestry export --privacy -o family.ged
ancestry invite rose@example.com --as "Rose Ettinger"   # she joins as Rose, keeps her own profile
ancestry invite a@example.com b@example.com --role editor --note "Help with Grandpa's side"
ancestry invite --file family-emails.txt  # any pasted list; --file - reads stdin
ancestry contact add --name "Dr. Patel" --circle business --relationship "our dentist" --phone "555 0142"
ancestry contact add --name "Pat Lee" --email pat@example.com --circle friends --connect   # add a friend + ask to connect
ancestry contact add --person "Kurt Rademacher" --email kurt@example.com --connect     # someone in your tree, into your network
ancestry contacts import ~/phone.vcf --circle family
ancestry connect "Aunt Rose"         # one email; if she says yes, you can message
ancestry inbox
ancestry message "Aunt Rose" "Are you coming Sunday?"
```

`--json` on any command prints JSON. `ANCESTRY_URL` points every client at another
server (your own, or `http://127.0.0.1:8792`).

### MCP tools

`list_trees`, `search_people`, `get_person`, `add_person`, `update_person`,
`link_relative` (parent, partner, child, sibling, grandparent), `add_bond`, `add_pet`,
`family_plan`, `search_businesses`, `get_business`, `add_business`, `update_business`,
`add_business_role`, `remove_business_role`, `link_business_contact`, `list_albums`, `list_photos`, `create_album`, `add_photo`, `update_photo`, `local_recommendations`, `recommend_business`, `add_event`, `pedigree`, `descendants`, `relationship`,
`export_gedcom`, `import_gedcom`, `invite_to_tree`, `tree_members`, and for the
network `list_contacts`, `get_contact`, `add_contact`, `add_person_to_network`, `update_contact`,
`connect_contact`, `inbox`, `read_conversation`, `send_message`. The assistant acts
as you: it sees the trees you see, and changes only the ones you can edit.

### API

| | |
|---|---|
| `GET /api/v1/me` | you and your trees |
| `GET/POST /api/v1/trees` | list / create (`{name}`) |
| `GET /api/v1/trees/:tree/people?q=` | list or search |
| `POST /api/v1/trees/:tree/people` | add (`{given, surname, ..., relative_of?, as?: parent\|partner\|child\|sibling\|grandparent, relation?, sibling?: full\|half\|adopted\|foster\|step, via?, raised?, existing_id?}`) |
| `POST /api/v1/trees/:tree/people/:id/bonds`, `DELETE .../bonds/:bond` | a bond (`{kind: raised_by\|guardian\|godparent\|caregiver\|chosen_family, other_id or person fields, note?}`) |
| `POST /api/v1/trees/:tree/pets` | a pet (`{owner_id(s), given, species?}`); 402 without the Family plan |
| `GET /api/v1/trees/:tree/plan`, `POST .../plan/checkout` | the Family plan; start a payment (`{chain}`) |
| `POST /api/v1/trees/:tree/claim` | this is me (`{person_id}`) or add me (person fields) |
| `GET/PATCH/DELETE /api/v1/trees/:tree/people/:id` | one person, with parents, siblings (and their kind), partners, children, bonds, pets, events, sources, photos |
| `POST /api/v1/trees/:tree/people/:id/events` | add a life event |
| `GET /api/v1/trees/:tree/pedigree/:id?generations=4` | ancestors |
| `GET /api/v1/trees/:tree/descendants/:id?generations=3` | descendants |
| `GET /api/v1/trees/:tree/relate?a=&b=` | relationship in words, and the path |
| `POST /api/v1/trees/:tree/import` | GEDCOM text body |
| `GET /api/v1/trees/:tree/export?privacy=1` | GEDCOM |
| `GET /api/v1/trees/:tree/members` | members, with the person each one is |
| `GET/POST /api/v1/trees/:tree/invites`, `DELETE .../invites/:id` | pending invites; invite (`{emails, role?, person_id?, note?}`; no emails = a link) |
| `GET/POST /api/v1/trees/:tree/businesses?q=` | businesses: list or search / add (`{name, category?, founded?, closed?, place?, website?, notes?, people?: [{person_id, role, title?, start_date?, end_date?}]}`) |
| `GET/PATCH/DELETE /api/v1/trees/:tree/businesses/:id` | one business, with its people, photos and your own linked contact |
| `POST /api/v1/trees/:tree/businesses/:id/people`, `DELETE .../business-roles/:role` | someone's role (`{person_id or given+surname, role: founder\|owner\|partner\|investor\|officer\|manager\|employee\|apprentice\|other, title?, start_date?, end_date?, note?}`) |
| `POST /api/v1/trees/:tree/businesses/:id/contact` | link one of your Network contacts (`{contact_id}`, `null` unlinks, `{create: true}` adds it); private to you |
| `GET /api/v1/trees/:tree/search?q=` | people and businesses at once |
| `GET/POST /api/v1/trees/:tree/albums`, `GET/PATCH/DELETE .../albums/:id` | photo albums (`{title, description?, cover_id?}`); an album's GET carries its photos |
| `GET /api/v1/trees/:tree/photos?album=&before=` | photos, newest first |
| `POST /api/v1/trees/:tree/photos` | add photos: multipart `file` (up to 20) or JSON `{filename, data_base64}`, with `caption?`, `album_id?` or `album_title?`, `person_id?` |
| `GET/PATCH/DELETE /api/v1/trees/:tree/photos/:id` | one photo (`{caption?, person_id?, album_id?}`) |
| `GET /api/v1/local?q=&category=`, `POST /api/v1/local`, `DELETE /api/v1/local/:id` | recommendations from people you know; recommend (`{name, category, town?, phone?, website?, note?}` or `{contact_id}`) |
| `GET/POST /api/v1/contacts?q=&circle=` | your network: list / add (`{connect: true, note_to_them?}` also asks them to connect) |
| `GET /api/v1/families?q=`, `POST /api/v1/families/:tree/request` | listed families (id, name, note); ask one for an invite (`{name, email, circle?, note?}`, always 202) |
| `GET/POST /api/v1/trees/:tree/listing` | the tree's public listing (`{listed, listing}`, owner) |
| `GET /api/v1/trees/:tree/requests`, `POST .../requests/:id/invite\|decline` | people asking to join (owners and editors) |
| `POST /api/v1/trees/:tree/people/:person/contact` | someone in the tree into your network (`{circle?, email?, relationship?, connect?, note?}`); one contact per person |
| `GET/PATCH/DELETE /api/v1/contacts/:id` | one contact |
| `POST /api/v1/contacts/:id/connect` | ask them to connect (`{note?}`) |
| `POST /api/v1/contacts/import?circle=`, `GET /api/v1/contacts.vcf` | vCard in and out |
| `GET /api/v1/inbox`, `GET/POST /api/v1/inbox/:user` | conversations; read / send (`{body}`) |

## Family plan

One payment per tree, once, for good: **$49** (`FAMILY_PLAN_USD`), in crypto through
CoinPay. It covers the whole family: pets, pasting up to 500 invites at a time, and no
daily invitation limit for anyone in the tree (a 2,000/day ceiling only stops runaway
scripts). Everything else stays free. Trees owned by an `ADMIN_EMAILS` account are on
the plan without paying.

The server needs `COINPAY_API_KEY`, `COINPAY_BUSINESS_ID` and `COINPAY_WEBHOOK_SECRET`,
with the business's webhook pointed at `/webhooks/coinpay`. A payment is written down
before the buyer leaves; the signed webhook settles it, and only a payment we started
can mark a tree paid. `COINPAY_CHAINS` limits checkout to chains the business holds
wallets for.

## Businesses

`src/business.ts`. A business is its own table, not a person, so no bloodline walk
(pedigree, descendants, relationships, siblings) can reach one, and it is free on every
tree. Roles: founder, owner, partner, investor, officer, manager, employee, apprentice,
other, each with an optional title, years and note; one person can hold several. A
member may link a business to one of their own Network contacts; contacts stay
private, so each member sees only their own link.

In GEDCOM a business is a custom `0 @B1@ _BUS` record (NAME, TYPE, `_FOUNDED`/`_CLOSED`
with DATE, PLAC, WWW, NOTE, and `_ROLE @I..@` with TYPE, TITL, `_FROM`, `_TO`, NOTE)
that other programs skip. Each role is also an `OCCU` on the person ("Founder, Ettinger
Plumbing", `DATE FROM .. TO ..`) marked `2 _BUS @B1@`, so other programs still show
it; our import skips a marked OCCU and rebuilds the role from `_BUS`, so a round trip
never doubles anything. A privacy export keeps the business and leaves out what living
people did.

## Photo album

`src/album.ts`. Photos stay in the one SQLite file (`media`, now with `album_id` and
`uploaded_by`); `albums` is a table of its own. **Verified member** = any member of the tree
(owner, editor, viewer) who signed in with their own email; a pit.world-only account has a
placeholder `@pit.invalid` address, so it can look but not add until it signs in with an
email. The uploader and the tree's editors may caption, retag, move or delete a photo;
whoever started an album and the editors may rename or delete it (photos stay). Files are
judged by their bytes (JPEG, PNG, GIF, WebP, AVIF), 8 MB each, 500 a day per person.

`family.tree` is ours too: any request whose Host is in `ANCESTRY_REDIRECT_HOSTS` (default
`family.tree` on the official site) gets a 301 to the same path on family.ancestry, or on
family.ancestry.pit.world when it came through the relay.

## Local

`src/local.ts`. A recommendation snapshots the business (name, category, town, phone,
website, a line on why) when you share it; your contacts themselves stay private. You
see your own picks and those of everyone you are connected with or share a tree with,
grouped by phone, then website, then name and town. Score = sum of how close each
recommender is to you: family and neighbors 3, friends and tree-mates 2, other
connections 1 (your own circle for them decides). Blocks hide both ways.

## Ads

Pages carry one [crawlproof](https://crawlproof.com) unit: a fluid text link in the
footer everywhere, and a 300×250 on Local and Network. It is a cross-origin frame
(`/api/ads/frame`), so the CSP gains one `frame-src` and nothing else: no ad script,
no cookie. `CRAWLPROOF_AD_SLOT` sets the slot; `off` removes the units.

## Business teams

A family business ("Profullstack, Inc.") can have a team: people with their own accounts
who work there. Tree editors and up invite them from the business page by email, as an
employee, manager, officer, partner or owner, with a title. They join the business, never
the tree: at `/w/:business` they see what it is, where, its website and the team (the
leaders who have accounts, then everyone invited), and nothing from the family tree. Joining
connects them with whoever invited them. Owners and admins can list a business at
`/families`; anyone can ask to join the team, and the family invites or declines.
Code: `src/team.ts`. CLI: `ancestry team <business> [invite <email> --as employee --title T]`,
`ancestry work`. MCP: `business_team`, `invite_to_team`, `my_work`. API:
`/api/v1/trees/:tree/businesses/:biz/team` (GET, POST invite, DELETE `/:user`), `.../listing`,
`.../requests/:id/invite|decline`, `/api/v1/work`, `/api/v1/families/businesses`,
`POST /api/v1/families/b/:biz/request`.

## Listed families

A tree can be found without being seen. On the Members page the owner can list it at
`/families`: strangers see the tree's name and a note the owner writes, and nothing from
inside it (no people, no names, no counts, no members, not who owns it). The tree stays
private; non-members still get a 404.

Anyone can ask for an invite with a name, an email (theirs or a relative's) and how they
know the family (family, friend, neighbor, business). The visitor always gets the same
answer, so a request never reveals whether an address is already in the tree. Requests wait
on the Members page; an owner or editor sends the ordinary viewer invite or declines, and
declining sends nothing. Limits: 5 requests an hour per address, 3 a day per email, 50 a day
per tree, plus a hidden field for bots. Code: `src/listing.ts`. CLI: `ancestry listing on
--note "..."`, `ancestry requests [invite|decline <id>]`, `ancestry families`, `ancestry ask`.
MCP: `list_families`, `ask_to_join`, `tree_listing`, `join_requests`, `answer_join_request`.

## Network

An add-on with its own tables and routes (`src/network*.ts`), included free with every
account. Anything we ever charge for is covered by a
[Profullstack Power Key](https://profullstack.com/plans).

It is for people who know each other, and the rules are in the code, not just the copy:

- Contacts are private to whoever saved them. No public profiles, no follower counts,
  no "people you may know", no directory to browse.
- You can message someone only if you both said yes to connecting, or you share a tree.
  One person at a time; there is no broadcast.
- Joining a tree from someone's invite connects you with them, as family.
- Every living person's page has **Add to my network** (circle, email, and "email them
  to connect" in one step); after that it says **In my network**. The Add form on
  /network has the same "email them to connect" box, so adding a friend and inviting
  them is one step.
- Either side can block; a block ends the conversation both ways and is never revealed.
- Per sender: 40 invitations (tree or connect) a day (no limit for a family on the
  Family plan), 120 messages an hour. A new
  message emails the recipient once per unread run, not once per message.

## Running it

```sh
bun install
bun src/server.ts            # http://127.0.0.1:8792, data in ~/.local/share/family-ancestry
```

| env | |
|---|---|
| `PORT` (8792), `HOST` (127.0.0.1) | where it listens |
| `ANCESTRY_SITE` | the public URL, used in links and for passkeys (default `https://family.ancestry`) |
| `ANCESTRY_DATA_DIR` | where `family.db` lives (everything, photos included, is in that one SQLite file) |
| `RESEND_API_KEY`, `MAIL_FROM` | sign-in and invite mail; without a key, links are printed to the log |

Production is dev2: `/opt/family.ancestry`, `bin/install.sh` (OpenInstall) runs it as the
systemd unit `family-ancestry`; secrets in `/root/.local/share/family-ancestry/app.env`
from the vault `profullstack/family-ancestry--prod`. Every merge to `main` deploys.

nginx serves `family.ancestry` on 80 and 443 (no redirect; see the seo.rank notes on why
Moshpit names serve both) and proxies to 8792. The certificate is signed by the Moshpit
registry and renewed by `moshpit-renew-riotcoder.timer`, because the name belongs to the
riotcoder account and its certificates live in `/etc/ssl/moshpit-riotcoder`.

## License

MIT
