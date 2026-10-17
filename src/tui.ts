/**
 * `ancestry tui`: browse a family tree in the terminal.
 *
 * Left: people (type to search). Right: the selected person. Enter on a relative
 * jumps to them, Tab switches panes, t cycles trees, o opens in the browser,
 * Ctrl+C or q (when not typing) quits.
 */
import { createApp } from '@profullstack/hqtui'
import { AncestryClient, type PersonDetail, type PersonSummary, type TreeSummary } from './client.js'
import { formatPerson, openUrl } from './cli.js'

export type TuiState = {
  trees: TreeSummary[]
  tree: number
  query: string
  people: PersonSummary[]
  selected: number
  detail: PersonDetail | null
  focus: 'list' | 'detail'
  relSelected: number
  busy: boolean
  error: string | null
}

export const initialState = (): TuiState => ({ trees: [], tree: 0, query: '', people: [], selected: 0, detail: null, focus: 'list', relSelected: 0, busy: false, error: null })

/** Everyone the detail pane links to, in display order. */
export const relatives = (d: PersonDetail | null) =>
  d ? [...d.parents.flatMap((f) => f.parents), ...d.parents.flatMap((f) => f.siblings), ...d.unions.flatMap((u) => [...(u.partner ? [u.partner] : []), ...u.children])] : []

export type Action = 'quit' | 'search' | 'load' | 'jump' | 'open' | 'tree' | null

/** Pure key handling, so it can be tested without a terminal. */
export function onKey(state: TuiState, key: { name: string; key: string; char?: string }): Action {
  if (key.key === 'ctrl+c') return 'quit'
  if (key.name === 'tab') {
    state.focus = state.focus === 'list' ? 'detail' : 'list'
    state.relSelected = 0
    return null
  }
  if (state.focus === 'detail') {
    const rels = relatives(state.detail)
    if (key.name === 'down' || key.name === 'j') state.relSelected = Math.min(rels.length - 1, state.relSelected + 1)
    else if (key.name === 'up' || key.name === 'k') state.relSelected = Math.max(0, state.relSelected - 1)
    else if (key.name === 'enter') return rels.length ? 'jump' : null
    else if (key.name === 'escape') state.focus = 'list'
    else if (key.name === 'o' || key.char === 'o') return 'open'
    else if (key.name === 'q' || key.char === 'q') return 'quit'
    return null
  }
  if (key.name === 'down') {
    state.selected = Math.min(state.people.length - 1, state.selected + 1)
    return 'load'
  }
  if (key.name === 'up') {
    state.selected = Math.max(0, state.selected - 1)
    return 'load'
  }
  if (key.name === 'enter') {
    state.focus = 'detail'
    return 'load'
  }
  if (key.name === 'backspace') {
    state.query = state.query.slice(0, -1)
    return 'search'
  }
  if (key.name === 'escape') {
    if (state.query) {
      state.query = ''
      return 'search'
    }
    return 'quit'
  }
  if (key.key === 'ctrl+t') return 'tree'
  if (key.char && key.char.length === 1 && !key.key.startsWith('ctrl+')) {
    state.query += key.char
    return 'search'
  }
  return null
}

export async function runTui(client = new AncestryClient()): Promise<void> {
  const state = initialState()
  const app = await createApp({ title: 'family.ancestry', quitKeys: [] })
  const tree = () => state.trees[state.tree]
  let seq = 0

  const guard = async (fn: () => Promise<void>) => {
    state.busy = true
    state.error = null
    app.invalidate()
    try {
      await fn()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      state.busy = false
      app.invalidate()
    }
  }
  const load = () =>
    guard(async () => {
      const p = state.people[state.selected]
      state.detail = p && tree() ? await client.person(tree()!.id, p.id) : null
    })
  const search = () =>
    guard(async () => {
      const mine = ++seq
      if (!tree()) return
      const people = await client.people(tree()!.id, state.query, 300)
      if (mine !== seq) return
      state.people = people
      state.selected = 0
      await load()
    })

  await guard(async () => {
    state.trees = await client.trees()
    if (!state.trees.length) throw new Error('No trees yet. Make one at the website or with: ancestry new "My family"')
  })
  if (state.trees.length) await search()

  app.on('key', (event: any) => {
    const action = onKey(state, event)
    if (action === 'quit') app.quit()
    else if (action === 'search') void search()
    else if (action === 'load') void load()
    else if (action === 'tree') {
      state.tree = (state.tree + 1) % Math.max(1, state.trees.length)
      state.query = ''
      void search()
    } else if (action === 'open' && state.detail) openUrl(state.detail.url)
    else if (action === 'jump') {
      const target = relatives(state.detail)[state.relSelected]
      if (target && tree())
        void guard(async () => {
          state.detail = await client.person(tree()!.id, target.id)
          state.relSelected = 0
        })
    }
    app.invalidate()
  })

  app.render(({ ui, theme }: any) => {
    ui.row({ size: 1 }, (header: any) => {
      header.text(' family.ancestry', { fg: theme.accent, bold: true, size: 17 })
      header.text(tree() ? `${tree()!.name} · ${tree()!.people} people${state.trees.length > 1 ? '  (Ctrl+T next tree)' : ''}` : '', { fg: theme.muted })
      header.text(`${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    ui.grid({ columns: ['2fr', '3fr'], rows: ['1fr'], gap: 1 }, (row: any) => {
      row.panel({ title: `People${state.query ? `: ${state.query}▏` : ' (type to search)'}` }, (p: any) => {
        p.list({ items: state.people.map((x) => ({ label: `${x.name} ${yrs(x)}` })), selected: state.focus === 'list' ? state.selected : -1, followSelection: true, scrollbar: true })
      })
      row.panel({ title: state.busy ? 'Loading…' : state.detail ? state.detail.name : 'Person' }, (p: any) => {
        if (state.error) return p.text(state.error, { fg: theme.danger ?? theme.accent })
        if (!state.detail) return p.text('Pick someone on the left.', { fg: theme.muted })
        p.text(formatPerson(state.detail), { fg: theme.text })
        const rels = relatives(state.detail)
        if (state.focus === 'detail' && rels.length) p.list({ items: rels.map((r) => ({ label: `→ ${r.name}` })), selected: state.relSelected, followSelection: true })
      })
    })
    ui.statusBar({
      items:
        state.focus === 'list'
          ? [{ key: '↑↓', label: 'move' }, { key: 'Enter', label: 'relatives' }, { key: 'Tab', label: 'pane' }, { key: 'Esc', label: 'clear/quit' }]
          : [{ key: '↑↓', label: 'pick relative' }, { key: 'Enter', label: 'go' }, { key: 'o', label: 'open in browser' }, { key: 'Tab', label: 'pane' }, { key: 'q', label: 'quit' }],
      right: [{ label: 'private to your family' }],
    })
  })

  await app.start()
}

const yrs = (p: { birth_date: string | null; death_date: string | null }) => {
  const y = (d: string | null) => d?.match(/\b(\d{4})\b/)?.[1]
  return y(p.birth_date) || y(p.death_date) ? `(${y(p.birth_date) ?? '?'}–${y(p.death_date) ?? ''})` : ''
}
