const { ref } = Vue;
import { verifyLogin } from '../utils/auth.js';

export default {
  name: 'Login',
  emits: ['success'],
  setup(props, { emit }) {
    const username = ref('');
    const password = ref('');
    const error = ref('');
    const checking = ref(false);

    async function submit() {
      if (!username.value || !password.value) return;
      checking.value = true;
      error.value = '';
      const ok = await verifyLogin(username.value, password.value);
      checking.value = false;
      if (ok) {
        emit('success');
      } else {
        error.value = 'Incorrect username or password.';
      }
    }

    return { username, password, error, checking, submit };
  },
  template: `
    <div class="login-box">
      <h3 style="margin-bottom:4px">Admin Login</h3>
      <p class="text-muted text-sm mb-16">Sign in to view and change settings.</p>
      <form @submit.prevent="submit">
        <div class="settings-row">
          <input v-model="username" placeholder="Username" autocomplete="username" />
        </div>
        <div class="settings-row">
          <input v-model="password" type="password" placeholder="Password" autocomplete="current-password" />
        </div>
        <div class="notice error text-sm" v-if="error" style="margin-bottom:8px">{{ error }}</div>
        <div class="settings-row">
          <button type="submit" class="primary" :disabled="checking">{{ checking ? 'Checking…' : 'Log in' }}</button>
        </div>
      </form>
      <p class="text-muted text-sm" style="margin-top:18px;line-height:1.5">
        Default is <code>admin</code> / <code>admin</code> — change it under Settings → Admin Account once logged in.
        This is a lightweight browser-side lock, not real access control: it keeps settings from being
        casually changed on a shared screen, but anyone with DevTools access to this page can bypass it.
      </p>
    </div>
  `,
};
