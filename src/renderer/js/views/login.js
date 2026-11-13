import { api } from '../api.js';
import { store } from '../store.js';
import { confirmDialog } from '../dialog.js';
import { h, fill, icon, button, spinner, novaMark } from '../ui.js';

const MAX_SAVED = 6;

// Sign-in: pick a server (found on the network, used before, or typed), then a user.
export function loginView({ onDone, message, start }) {
  const panel = h('div', { class: 'login-panel', role: 'main' });
  const el = h('div', { class: 'login' },
    h('div', { class: 'login-drag' }),
    panel);

  let server = null;
  let security = null;
  let qcTimer = null;

  const header = (title, sub, extra) => h('div', { class: 'login-head' },
    novaMark('big'),
    h('h1', null, title),
    sub ? h('p', null, sub) : null,
    extra);

  const errorLine = () => h('div', { class: 'login-error', role: 'alert' });

  const savedServers = () => (store.get('servers') || []).filter((s) => s?.url);

  function serverItem(s, onPick) {
    return h('button', { class: 'server-item', onclick: () => onPick(s.url) },
      icon('server'),
      h('span', { class: 'server-item-text' }, h('span', null, s.name || s.url), h('span', null, s.url)),
      icon('chevronRight'));
  }

  function stepServer(prefill = '', err = message) {
    clearInterval(qcTimer);
    const input = h('input', { class: 'input', placeholder: 'e.g. 192.168.1.20 or https://jellyfin.example.com', value: prefill, spellcheck: false });
    const errEl = errorLine();
    if (err) errEl.textContent = err;
    const found = h('div', { class: 'server-list', 'aria-live': 'polite' });
    const known = savedServers();

    const connect = async (address = input.value) => {
      input.value = address;
      errEl.textContent = '';
      go.disabled = true;
      go.replaceChildren(h('span', { class: 'spinner small' }), h('span', null, 'Connecting…'));
      try {
        const res = await api.findServer(address);
        // Plain HTTP outside the home network would send the password readable to anyone on the way.
        if (!res.encrypted && !res.privateHost && !(await confirmInsecure(res.base))) return;
        server = { url: res.base, name: res.info.ServerName, id: res.info.Id, version: res.info.Version };
        security = res.encrypted ? 'encrypted' : res.privateHost ? 'local' : 'insecure';
        api.configure({ base: res.base, signedIn: false, userId: '', serverVersion: res.info.Version });
        await stepUser();
      } catch (e) {
        errEl.textContent = e.message;
      } finally {
        go.disabled = false;
        go.replaceChildren(h('span', null, 'Connect'));
      }
    };
    const go = button('Connect', { variant: 'primary', onclick: () => connect(), cls: 'wide' });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && connect());

    fill(panel,
      header('Welcome to Nova', 'Connect to your Jellyfin server'),
      found,
      known.length ? h('div', { class: 'server-list' },
        h('div', { class: 'server-list-label' }, 'Used before'),
        known.map((s) => serverItem(s, connect))) : null,
      h('label', { class: 'field' }, h('span', null, 'Server address'), input),
      errEl,
      go);
    setTimeout(() => input.focus(), 50);

    // Servers that answer Jellyfin's local network discovery.
    window.nova.discoverServers().then((list) => {
      const fresh = (list || []).filter((d) => !known.some((k) => k.id === d.id));
      if (!fresh.length || !found.isConnected) return;
      fill(found,
        h('div', { class: 'server-list-label' }, 'On this network'),
        fresh.map((s) => serverItem(s, connect)));
    }).catch(() => {});
  }

  function confirmInsecure(base) {
    return confirmDialog({
      title: 'This connection is not encrypted',
      body: `${base} uses plain HTTP. Your password and everything you watch would travel unencrypted over the internet. Use an https:// address if your server has one.`,
      confirm: 'Connect anyway',
      cancel: 'Go back',
      danger: true,
    });
  }

  function securityLine() {
    const [ic, text, cls] = {
      encrypted: ['lock', 'Encrypted connection', ''],
      local: ['home', 'On your local network', ''],
      insecure: ['lockOpen', 'Not encrypted', 'insecure'],
    }[security] || [];
    return ic ? h('span', { class: `login-secure ${cls}`.trim() }, icon(ic), text) : null;
  }

  async function stepUser() {
    panel.replaceChildren(spinner('Loading users…'));
    const [users, qcEnabled] = await Promise.all([api.publicUsers(), api.quickConnectEnabled()]);

    const userInput = h('input', { class: 'input', placeholder: 'Username', autocomplete: 'username', spellcheck: false });
    const passInput = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const remembered = store.get('lastUsername');
    if (remembered) userInput.value = remembered;
    const errEl = errorLine();

    const submit = async () => {
      errEl.textContent = '';
      if (!userInput.value.trim()) {
        errEl.textContent = 'Enter your username.';
        userInput.focus();
        return;
      }
      go.disabled = true;
      try {
        const auth = await api.login(userInput.value.trim(), passInput.value);
        store.set('lastUsername', userInput.value.trim());
        finish(auth);
      } catch (e) {
        errEl.textContent = e.status === 401
          ? 'That username and password didn\'t match. Check them and try again.'
          : `Couldn't sign in: ${e.message}. Check that the server is running, then try again.`;
      } finally {
        go.disabled = false;
      }
    };
    const go = button('Sign in', { variant: 'primary', onclick: submit });
    passInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    userInput.addEventListener('keydown', (e) => e.key === 'Enter' && passInput.focus());

    const userTiles = users?.length
      ? h('div', { class: 'user-tiles' }, users.map((u) => h('button', {
        class: 'user-tile',
        onclick: () => {
          userInput.value = u.Name;
          passInput.focus();
        },
      },
      u.PrimaryImageTag
        ? h('img', { class: 'avatar', src: api.userImage(u.Id, u.PrimaryImageTag), alt: '' })
        : h('div', { class: 'avatar avatar-letter' }, u.Name[0].toUpperCase()),
      h('span', null, u.Name))))
      : null;

    fill(panel,
      header(server.name || 'Sign in', `${server.url}${server.version ? ' · Jellyfin ' + server.version : ''}`, securityLine()),
      userTiles,
      h('label', { class: 'field' }, h('span', null, 'Username'), userInput),
      h('label', { class: 'field' }, h('span', null, 'Password'), passInput),
      errEl,
      h('div', { class: 'login-split' },
        go,
        qcEnabled ? button('Quick Connect', { onclick: stepQuickConnect, title: 'Approve this device from another signed-in device' }) : null),
      h('button', { class: 'link-btn', onclick: () => stepServer(server.url, '') }, 'Change server'));
    setTimeout(() => (userInput.value ? passInput : userInput).focus(), 50);
  }

  async function stepQuickConnect() {
    panel.replaceChildren(spinner('Starting Quick Connect…'));
    try {
      const qc = await api.quickConnectInitiate();
      fill(panel,
        header('Quick Connect', 'On a device that is already signed in, open Settings → Quick Connect and enter this code:'),
        h('div', { class: 'qc-code', 'aria-label': `Code ${qc.Code.split('').join(' ')}` }, qc.Code),
        h('div', { class: 'qc-wait', role: 'status' }, h('span', { class: 'spinner small' }), 'Waiting for approval…'),
        h('button', { class: 'link-btn', onclick: () => { clearInterval(qcTimer); stepUser(); } }, 'Back to password sign in'));
      clearInterval(qcTimer);
      qcTimer = setInterval(async () => {
        try {
          const st = await api.quickConnectCheck(qc.Secret);
          if (st?.Authenticated) {
            clearInterval(qcTimer);
            finish(await api.quickConnectAuth(qc.Secret));
          }
        } catch {
          // keep polling
        }
      }, 3000);
    } catch (e) {
      stepUser().then(() => {
        panel.querySelector('.login-error').textContent = `Quick Connect didn't start (${e.message}). It may be turned off on the server; sign in with your password instead.`;
      });
    }
  }

  function finish(auth) {
    clearInterval(qcTimer);
    // Remember the server for next time, most recent first.
    const list = [{ url: server.url, name: server.name, id: server.id }, ...savedServers().filter((s) => s.url !== server.url)];
    store.set('servers', list.slice(0, MAX_SAVED));
    onDone({ server, auth });
  }

  const saved = store.get('server');
  if (start === 'users' && saved?.url) {
    // Switch user: straight to this server's users.
    panel.replaceChildren(spinner('Connecting…'));
    api.findServer(saved.url)
      .then((res) => {
        server = { url: res.base, name: res.info.ServerName, id: res.info.Id, version: res.info.Version };
        security = res.encrypted ? 'encrypted' : res.privateHost ? 'local' : 'insecure';
        api.configure({ base: res.base, signedIn: false, userId: '', serverVersion: res.info.Version });
        return stepUser();
      })
      .catch((e) => stepServer(saved.url, e.message));
  } else {
    stepServer(start === 'server' ? '' : saved?.url || '');
  }
  return el;
}
