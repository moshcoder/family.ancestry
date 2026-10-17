// family.ancestry: small conveniences on top of pages that already work without JavaScript.
;(() => {
  'use strict'

  const b64u = {
    encode(buf) {
      const bytes = new Uint8Array(buf)
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    },
    decode(str) {
      const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4))
      return Uint8Array.from(s, (c) => c.charCodeAt(0))
    },
  }

  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body ? JSON.stringify(body) : '{}' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  const credentialJSON = (cred) => {
    const r = cred.response
    const out = { id: cred.id, rawId: b64u.encode(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}, authenticatorAttachment: cred.authenticatorAttachment || undefined, response: { clientDataJSON: b64u.encode(r.clientDataJSON) } }
    if (r.attestationObject) {
      out.response.attestationObject = b64u.encode(r.attestationObject)
      out.response.transports = r.getTransports ? r.getTransports() : []
    }
    if (r.authenticatorData) {
      out.response.authenticatorData = b64u.encode(r.authenticatorData)
      out.response.signature = b64u.encode(r.signature)
      out.response.userHandle = r.userHandle ? b64u.encode(r.userHandle) : undefined
    }
    return out
  }

  // Passkeys belong to family.ancestry itself; on pit.world's relay (family.ancestry.pit.world) the browser refuses them.
  const hasPasskeys = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext) && !location.hostname.endsWith('.pit.world')

  // Sign in with a passkey.
  for (const button of document.querySelectorAll('[data-passkey-signin]')) {
    if (!hasPasskeys) continue
    button.hidden = false
    button.addEventListener('click', async () => {
      try {
        const opts = await post('/auth/passkey/login/options')
        opts.challenge = b64u.decode(opts.challenge)
        opts.allowCredentials = (opts.allowCredentials || []).map((c) => ({ ...c, id: b64u.decode(c.id) }))
        const cred = await navigator.credentials.get({ publicKey: opts })
        const next = button.closest('form')?.querySelector('[name=next]')?.value
        const done = await post('/auth/passkey/login/verify', { ...credentialJSON(cred), next })
        location.href = done.next || '/trees'
      } catch (error) {
        alert(`Passkey sign-in did not work: ${error.message}. Use the email link instead.`)
      }
    })
  }

  // Add a passkey from Settings.
  for (const button of document.querySelectorAll('[data-passkey-register]')) {
    const status = document.querySelector('[data-passkey-status]')
    if (!hasPasskeys) {
      button.disabled = true
      if (status) status.textContent = location.hostname.endsWith('.pit.world') ? 'Passkeys work at https://family.ancestry itself (on Moshpit), not through pit.world.' : 'This browser cannot make passkeys here (they need https).'
      continue
    }
    button.addEventListener('click', async () => {
      try {
        const opts = await post('/auth/passkey/register/options')
        opts.challenge = b64u.decode(opts.challenge)
        opts.user.id = b64u.decode(opts.user.id)
        opts.excludeCredentials = (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64u.decode(c.id) }))
        const cred = await navigator.credentials.create({ publicKey: opts })
        const label = prompt('Name this passkey (e.g. "Phone", "Laptop")', navigator.platform || 'Passkey') || 'Passkey'
        await post('/auth/passkey/register/verify', { response: credentialJSON(cred), label })
        location.reload()
      } catch (error) {
        if (status) status.textContent = `Not added: ${error.message}`
      }
    })
  }

  // Ask before anything destructive.
  for (const form of document.querySelectorAll('form[data-confirm]')) {
    form.addEventListener('submit', (event) => {
      if (!confirm(form.dataset.confirm)) event.preventDefault()
    })
  }

  for (const select of document.querySelectorAll('select[data-autosubmit]')) select.addEventListener('change', () => select.form.submit())

  for (const button of document.querySelectorAll('[data-copy-btn]')) {
    button.addEventListener('click', async () => {
      const input = button.parentElement.querySelector('[data-copy]')
      try {
        await navigator.clipboard.writeText(input.value)
        button.textContent = 'Copied'
      } catch {
        input.select()
      }
    })
  }

  // "Add an event": show only the fields the chosen event needs.
  for (const form of document.querySelectorAll('form[data-life-event]')) {
    const what = form.querySelector('[name=what]')
    const show = () => {
      const opt = what.selectedOptions[0]
      const effect = opt ? opt.dataset.effect : ''
      const need = {
        other: what.value === 'other',
        partner: Boolean(opt && opt.dataset.partner) || effect === 'child',
        child: effect === 'child' || effect === 'step-child',
        'child-only': effect === 'child',
      }
      for (const el of form.querySelectorAll('[data-show]')) el.hidden = !need[el.dataset.show]
    }
    what.addEventListener('change', show)
    show()
  }

  // The family album: send photos one at a time, so a big batch is never one huge request, and show progress.
  // A photo over 8 MB is scaled down in the browser first (longest side 4096px, JPEG).
  const MAX_PHOTO = 8 * 1024 * 1024
  const shrink = async (file) => {
    if (file.size <= MAX_PHOTO || !window.createImageBitmap) return file
    try {
      const bitmap = await createImageBitmap(file)
      const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bitmap.width * scale)
      canvas.height = Math.round(bitmap.height * scale)
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
      return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file
    } catch {
      return file
    }
  }
  for (const form of document.querySelectorAll('form[data-album-upload]')) {
    const status = form.querySelector('[data-upload-status]')
    form.addEventListener('submit', async (event) => {
      const input = form.querySelector('input[type=file]')
      const files = [...(input.files || [])]
      if (!files.length || !window.fetch || !window.FormData) return
      event.preventDefault()
      const button = form.querySelector('button')
      button.disabled = true
      status.hidden = false
      const fields = new FormData(form)
      fields.delete('file')
      let album = null
      let done = 0
      const refused = []
      for (const file of files) {
        status.textContent = `Uploading ${done + 1} of ${files.length}…`
        const body = new FormData()
        for (const [k, v] of fields) body.append(k, v)
        if (album) {
          body.set('album_id', album.id)
          body.delete('album_title')
        }
        body.append('file', await shrink(file))
        try {
          const res = await fetch(form.action, { method: 'POST', body, credentials: 'same-origin', headers: { accept: 'application/json' } })
          const data = await res.json().catch(() => ({}))
          if (data.album) album = data.album
          if (data.saved && data.saved.length) done += data.saved.length
          for (const r of data.refused || []) refused.push(r)
          if (data.error) refused.push(`${file.name}: ${data.error}`)
        } catch (error) {
          refused.push(`${file.name}: ${error.message}`)
        }
      }
      const note = `${done} photo${done === 1 ? '' : 's'} added${refused.length ? `; not added: ${refused.join('; ')}` : ''}`
      const where = album ? new URL(album.url).pathname : location.pathname
      location.href = `${where}?ok=${encodeURIComponent(note)}`
    })
  }

  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {})
})()
