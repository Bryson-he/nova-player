import { api } from '../api.js';
import { store } from '../store.js';
import { h, fill, icon, button, spinner } from '../ui.js';

export function loginView({ onDone, message }) {
  const panel = h('div', { class: 'login-panel' });
  const el = h('div', { class: 'login' },
    h('div', { class: 'login-drag' }),
    h('div', { class: 'login-glow' }),
    panel);

  let server = null;
  let qcTimer = null;

  const header = (title, sub) => h('div', { class: 'login-head' },
    h('div', { class: 'brand-mark big' }, icon('play')),
    h('h1', null, title),
    sub ? h('p', null, sub) : null);

  const errorLine = () => h('div', { class: 'login-error' });

  function stepServer(prefill = '', err = message) {
    clearInterval(qcTimer);
    const input = h('input', { class: 'input', placeholder: 'e.g. 192.168.1.20:8096 or https://jellyfin.example.com', value: prefill, autofocus: true });
    const errEl = errorLine();
    if (err) errEl.textContent = err;
    const submit = async () => {
      errEl.textContent = '';
      go.disabled = true;
      go.replaceChildren(h('span', { class: 'spinner small' }), h('span', null, 'Connecting…'));
      try {
        const { base, info } = await api.findServer(input.value);
        server = { url: base, name: info.ServerName, id: info.Id, version: info.Version };
        api.configure({ base, token: '', userId: '', serverVersion: info.Version });
        await stepUser();
      } catch (e) {
        errEl.textContent = e.message;
      } finally {
        go.disabled = false;
        go.replaceChildren(h('span', null, 'Connect'));
      }
    };
    const go = button('Connect', { variant: 'primary', onclick: submit, cls: 'wide' });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    fill(panel, 
      header('Welcome to Nova', 'Connect to your Jellyfin server'),
      h('label', { class: 'field' }, h('span', null, 'Server address'), input),
      errEl,
      go);
    setTimeout(() => input.focus(), 50);
  }

  async function stepUser() {
    panel.replaceChildren(spinner('Loading users…'));
    const [users, qcEnabled] = await Promise.all([api.publicUsers(), api.quickConnectEnabled()]);

    const userInput = h('input', { class: 'input', placeholder: 'Username', autocomplete: 'username' });
    const passInput = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const remembered = store.get('lastUsername');
    if (remembered) userInput.value = remembered;
    const errEl = errorLine();

    const submit = async () => {
      errEl.textContent = '';
      go.disabled = true;
      try {
        const auth = await api.login(userInput.value.trim(), passInput.value);
        store.set('lastUsername', userInput.value.trim());
        finish(auth);
      } catch (e) {
        errEl.textContent = e.status === 401 ? 'Wrong username or password.' : e.message;
      } finally {
        go.disabled = false;
      }
    };
    const go = button('Sign in', { variant: 'primary', onclick: submit, cls: 'wide' });
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
      header(server.name || 'Sign in', `${server.url}${server.version ? ' · Jellyfin ' + server.version : ''}`),
      userTiles,
      h('label', { class: 'field' }, h('span', null, 'Username'), userInput),
      h('label', { class: 'field' }, h('span', null, 'Password'), passInput),
      errEl,
      go,
      qcEnabled ? button('Use Quick Connect', { onclick: stepQuickConnect, cls: 'wide' }) : null,
      h('button', { class: 'link-btn', onclick: () => stepServer(server.url) }, 'Change server'));
    setTimeout(() => (userInput.value ? passInput : userInput).focus(), 50);
  }

  async function stepQuickConnect() {
    panel.replaceChildren(spinner('Starting Quick Connect…'));
    try {
      const qc = await api.quickConnectInitiate();
      panel.replaceChildren(
        header('Quick Connect', 'On a device that is already signed in, open Settings → Quick Connect and enter this code:'),
        h('div', { class: 'qc-code' }, qc.Code),
        h('div', { class: 'qc-wait' }, h('span', { class: 'spinner small' }), 'Waiting for approval…'),
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
        panel.querySelector('.login-error').textContent = `Quick Connect failed: ${e.message}`;
      });
    }
  }

  function finish(auth) {
    clearInterval(qcTimer);
    onDone({ server, auth });
  }

  const saved = store.get('server');
  stepServer(saved?.url || '');
  return el;
}
