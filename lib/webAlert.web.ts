// lib/webAlert.web.ts
/**
 * Gives Alert.alert something to do in a browser.
 *
 * react-native-web ships Alert as a class whose alert() method is an empty
 * function. It does not warn and it does not throw - it simply returns, so
 * every one of the app's two hundred-odd alerts is silently dropped on web.
 *
 * That is not a cosmetic loss. Three different things break:
 *
 *   - errors are never reported. "Sign In Failed" and friends just vanish, and
 *     the screen sits there looking like nothing happened;
 *   - confirmations never appear, and because the answer arrives through the
 *     buttons' onPress, the work behind them never runs either. Deleting a
 *     song or a chord list quietly does nothing at all;
 *   - flows that continue inside a button - "Member Found, send a connection
 *     request?" after a QR scan - stop dead halfway.
 *
 * So the stub is replaced rather than worked around. It is patched in one
 * place instead of changing every call site, because the call sites are
 * already correct: they use the React Native API properly, and it is the web
 * implementation of that API that is missing.
 *
 * A DOM dialog is built rather than reaching for window.confirm, which offers
 * exactly two answers and cannot express a three-button alert or say which one
 * is destructive - and which would style nothing like the rest of the app.
 */

import { Alert } from 'react-native'

interface AlertButton {
  text?: string
  onPress?: (value?: string) => void
  style?: 'default' | 'cancel' | 'destructive'
}

let installed = false

export function installWebAlert(): void {
  if (installed || typeof document === 'undefined') return
  installed = true

  ;(Alert as any).alert = (
    title?: string,
    message?: string,
    buttons?: AlertButton[],
    _options?: unknown,
  ) => {
    // The React Native default: an alert with no buttons still has an OK.
    const actions: AlertButton[] =
      buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }]

    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'alertdialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.45)', 'padding:24px',
      '-webkit-font-smoothing:antialiased',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    ].join(';')

    const card = document.createElement('div')
    card.style.cssText = [
      'background:#fff', 'color:#111', 'border-radius:14px',
      'max-width:400px', 'width:100%', 'padding:20px 20px 12px',
      'box-shadow:0 12px 40px rgba(0,0,0,0.25)',
    ].join(';')

    if (title) {
      const h = document.createElement('div')
      h.textContent = title
      h.style.cssText = 'font-size:17px;font-weight:600;margin-bottom:6px'
      card.appendChild(h)
    }

    if (message) {
      const p = document.createElement('div')
      p.textContent = message
      p.style.cssText = 'font-size:14px;line-height:1.45;color:#444;white-space:pre-wrap'
      card.appendChild(p)
    }

    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;justify-content:flex-end;gap:8px;margin-top:18px;flex-wrap:wrap'

    // Closing has to be idempotent: a keyboard cancel and a click can both
    // arrive, and the caller's onPress must run once.
    let done = false
    const close = (fn?: AlertButton['onPress']) => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      // After teardown, so a handler that opens another alert is not competing
      // with this one being removed.
      try {
        fn?.()
      } catch (err) {
        console.error('Alert button handler failed:', err)
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape means the cancelling choice, matching a tap outside on native.
      const cancel = actions.find(b => b.style === 'cancel')
      if (cancel) close(cancel.onPress)
      else if (actions.length === 1) close(actions[0].onPress)
    }

    actions.forEach((button, i) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.textContent = button.text || 'OK'

      const destructive = button.style === 'destructive'
      const cancel = button.style === 'cancel'
      el.style.cssText = [
        'appearance:none', 'border:none', 'cursor:pointer',
        'padding:10px 16px', 'border-radius:8px',
        'font-size:14px', 'font-weight:600',
        destructive ? 'color:#fff' : cancel ? 'color:#333' : 'color:#fff',
        'background:' + (destructive ? '#b3261e' : cancel ? '#e9e6e1' : '#b3714a'),
      ].join(';')

      el.onclick = () => close(button.onPress)
      // The last button is the one native highlights, and the one a user
      // pressing Enter straight away expects to get.
      if (i === actions.length - 1) setTimeout(() => el.focus(), 0)
      row.appendChild(el)
    })

    card.appendChild(row)
    overlay.appendChild(card)
    document.body.appendChild(overlay)
    document.addEventListener('keydown', onKey)
  }
}
