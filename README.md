# family.ancestry

Private family trees for your family. What you'd use Ancestry for, without the
subscription, and without your family's history becoming someone else's product.
Open source (MIT).

**https://family.ancestry**, a name on the [Moshpit network](https://pit.world).
The desktop app, the CLI and the MCP server reach it by themselves; a browser
needs [one setting](https://pit.world/connect).

- **Trees** you build together: editors add and fix, viewers look. Invite by link.
- **People** with dates, places, notes and stories, photos, and a life timeline.
- **Families** the GEDCOM way: partners plus children (birth, adopted, step, foster).
- **Pedigree** (3–6 generations, Ahnentafel numbers) and **descendant** charts.
- **"How are we related?"** in words: *first cousin once removed*, *mother-in-law*.
- **Sources and citations**, so you know where every fact came from.
- **GEDCOM 5.5.1 import and export.** Bring your tree from Ancestry, FamilySearch,
  MyHeritage, Gramps or RootsMagic, and take it with you. Exports can hide living people.
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
ancestry pedigree Robert -g 4
ancestry descendants Johann
ancestry relate Robert Anna          # Anna Ettinger is Robert Ettinger's aunt.
ancestry export --privacy -o family.ged
```

`--json` on any command prints JSON. `ANCESTRY_URL` points every client at another
server (your own, or `http://127.0.0.1:8792`).

### MCP tools

`list_trees`, `search_people`, `get_person`, `add_person`, `update_person`,
`link_relative`, `add_event`, `pedigree`, `descendants`, `relationship`,
`export_gedcom`, `import_gedcom`. The assistant acts as you: it sees the trees
you see, and changes only the ones you can edit.

### API

| | |
|---|---|
| `GET /api/v1/me` | you and your trees |
| `GET/POST /api/v1/trees` | list / create (`{name}`) |
| `GET /api/v1/trees/:tree/people?q=` | list or search |
| `POST /api/v1/trees/:tree/people` | add (`{given, surname, ..., relative_of?, as?: parent\|partner\|child, existing_id?}`) |
| `GET/PATCH/DELETE /api/v1/trees/:tree/people/:id` | one person, with parents, partners, children, events, sources, photos |
| `POST /api/v1/trees/:tree/people/:id/events` | add a life event |
| `GET /api/v1/trees/:tree/pedigree/:id?generations=4` | ancestors |
| `GET /api/v1/trees/:tree/descendants/:id?generations=3` | descendants |
| `GET /api/v1/trees/:tree/relate?a=&b=` | relationship in words, and the path |
| `POST /api/v1/trees/:tree/import` | GEDCOM text body |
| `GET /api/v1/trees/:tree/export?privacy=1` | GEDCOM |

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
