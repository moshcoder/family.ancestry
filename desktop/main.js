// family.ancestry desktop: the web app in its own window, with the Moshpit
// plumbing done for you.
//
// family.ancestry is a Moshpit name, so an ordinary browser cannot find it
// without a DNS setting and an extra certificate. This app does both by itself,
// for this one name only:
//
//   1. sends its DNS lookups to the Moshpit DNS-over-HTTPS resolver (which
//      answers ordinary names as well), and
//   2. accepts the site's certificate only if it chains to the Moshpit Root CA
//      bundled with the app. Every other site is verified exactly as Chrome would.
//
// ANCESTRY_URL (or --url=https://your.host) points it at your own server instead.
'use strict'

const { app, BrowserWindow, shell, session, Menu, dialog } = require('electron')
const { X509Certificate } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const DOH = 'https://dns.moshcode.sh/dns-query'
const urlArg = process.argv.find((a) => a.startsWith('--url='))
const SITE = new URL((urlArg ? urlArg.slice(6) : process.env.ANCESTRY_URL) || 'https://family.ancestry')
const HOST = SITE.hostname
const ROOT = new X509Certificate(fs.readFileSync(path.join(__dirname, 'moshpit-root-ca.crt')))

/** True when the chain Chromium was handed ends in the Moshpit root and every link verifies. */
function chainsToMoshpit(cert) {
  try {
    let current = cert
    for (let depth = 0; current && depth < 5; depth++) {
      const x = new X509Certificate(current.data)
      if (x.verify(ROOT.publicKey)) return depth > 0 || x.checkHost(HOST) !== undefined
      const issuer = current.issuerCert
      if (!issuer || issuer.fingerprint === current.fingerprint) return false
      if (!x.verify(new X509Certificate(issuer.data).publicKey)) return false
      current = issuer
    }
  } catch {}
  return false
}

const isMoshpitName = () => !/\.(com|net|org|io|dev|app|sh|co|ai|world|me|us|uk|de)$/i.test(HOST) && !/^(localhost|\d+\.\d+\.\d+\.\d+)$/.test(HOST)

app.whenReady().then(async () => {
  // Every lookup goes to the Moshpit resolver, which answers ordinary names too,
  // so family.ancestry resolves without touching the system's DNS settings.
  if (isMoshpitName()) app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [DOH] })
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname === HOST && isMoshpitName()) return callback(chainsToMoshpit(request.certificate) ? 0 : -2)
    callback(-3) // -3: use Chromium's own verification
  })

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    title: 'family.ancestry',
    backgroundColor: '#f7f4ee',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })

  // Links to other sites (sources, census records) open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url)
    if (target.hostname !== HOST && !/^127\.0\.0\.1$|^localhost$/.test(target.hostname)) {
      event.preventDefault()
      if (/^https?:$/.test(target.protocol)) shell.openExternal(url)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (code === -3) return
    dialog.showMessageBox(win, {
      type: 'warning',
      message: `Could not reach ${HOST}`,
      detail: `${description} (${code}) loading ${url}.\n\nCheck your internet connection and try again.`,
      buttons: ['Retry', 'Quit'],
    }).then(({ response }) => (response === 0 ? win.loadURL(SITE.toString()) : app.quit()))
  })

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [{ label: 'My trees', accelerator: 'CmdOrCtrl+T', click: () => win.loadURL(new URL('/trees', SITE).toString()) }, { type: 'separator' }, { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'back', label: 'Back', accelerator: 'Alt+Left', click: () => win.webContents.navigationHistory.goBack() }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
      { role: 'help', submenu: [{ label: 'About family.ancestry', click: () => win.loadURL(new URL('/about', SITE).toString()) }, { label: 'Source code', click: () => shell.openExternal('https://github.com/moshcoder/family.ancestry') }] },
    ]),
  )

  win.loadURL(new URL('/trees', SITE).toString())
})

app.on('window-all-closed', () => app.quit())
