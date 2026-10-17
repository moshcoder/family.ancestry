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

  const hasPasskeys = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext)

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
      if (status) status.textContent = 'This browser cannot make passkeys here (they need https).'
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

  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {})
})()
