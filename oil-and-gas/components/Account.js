const { ref, reactive, computed, watch } = Vue;
import { login, register, logout, updateProfile, changePassword } from '../services/auth.js';
import { formatDate } from '../utils/formatters.js';
import LabelsManager from './LabelsManager.js';
import AlertsManager from './AlertsManager.js';
import BankAccounts from './BankAccounts.js';
import AvatarEditor from './AvatarEditor.js';
import Avatar from './Avatar.js';
import DashboardSettings from './DashboardSettings.js';

// Signed-in sections, shown as a side navigation (a tab row on phones).
const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: '👤' },
  { id: 'labels',  label: 'Labels',  icon: '🏷' },
  { id: 'alerts',  label: 'Alerts',  icon: '🔔' },
  { id: 'banks',   label: 'Bank accounts', short: 'Banks', icon: '🏦' },
  { id: 'dashboard', label: 'Dashboard', icon: '⚙' },
];

const MIN_PASSWORD_LENGTH = 8; // keep in sync with server/auth.js

/**
 * Account tab: sign-in / registration when signed out. Signed in, a side
 * navigation of profile sections: Profile (display name, password,
 * sign-out), Labels (the labels used by Inbox → Notes), Alerts (every
 * stock alert: edit, pause, delete, create), Bank accounts (where deposits come from)
 * and Dashboard (the dashboard's settings — refresh, data relay, crack-spread
 * thresholds, news feeds; DashboardSettings → save-settings).
 */
export default {
  name: 'Account',
  components: { LabelsManager, AlertsManager, BankAccounts, AvatarEditor, Avatar, DashboardSettings },
  // section: which signed-in section to show (v-model:section from app.js).
  // config: dashboard settings (Alerts uses your watchlist and holdings).
  props: { user: Object, config: Object, section: { type: String, default: 'profile' } },
  emits: ['signed-in', 'signed-out', 'updated', 'update:section', 'save-settings'],
  setup(props, { emit }) {
    // ── Signed out: sign in / create account ────────────────────────────
    const mode = ref('login'); // 'login' | 'register'
    const form = reactive({ email: '', password: '', confirmPassword: '', displayName: '' });
    const authError = ref(null);
    const authBusy = ref(false);

    function switchMode(next) {
      mode.value = next;
      authError.value = null;
      form.password = '';
      form.confirmPassword = '';
    }

    async function submitAuth() {
      authError.value = null;
      if (mode.value === 'register') {
        if (form.password.length < MIN_PASSWORD_LENGTH) {
          authError.value = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
          return;
        }
        if (form.password !== form.confirmPassword) {
          authError.value = 'Passwords do not match.';
          return;
        }
      }
      authBusy.value = true;
      try {
        const user = mode.value === 'register'
          ? await register(form.email, form.password, form.displayName)
          : await login(form.email, form.password);
        form.password = '';
        form.confirmPassword = '';
        emit('signed-in', user, { isNew: mode.value === 'register' });
      } catch (err) {
        authError.value = err.message;
      } finally {
        authBusy.value = false;
      }
    }

    // ── Signed in: profile ──────────────────────────────────────────────
    const displayName = ref(props.user?.displayName ?? '');
    watch(() => props.user?.displayName, (v) => { displayName.value = v ?? ''; });
    const profileStatus = ref(null); // { type: 'success'|'error', message }
    const profileBusy = ref(false);
    const displayNameChanged = computed(() => displayName.value.trim() !== (props.user?.displayName ?? ''));

    async function saveDisplayName() {
      profileStatus.value = null;
      profileBusy.value = true;
      try {
        const user = await updateProfile({ displayName: displayName.value });
        emit('updated', user);
        profileStatus.value = { type: 'success', message: 'Profile updated.' };
      } catch (err) {
        profileStatus.value = { type: 'error', message: err.message };
      } finally {
        profileBusy.value = false;
      }
    }

    const pw = reactive({ current: '', next: '', confirm: '' });
    const pwStatus = ref(null);
    const pwBusy = ref(false);

    async function submitPasswordChange() {
      pwStatus.value = null;
      if (pw.next.length < MIN_PASSWORD_LENGTH) {
        pwStatus.value = { type: 'error', message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
        return;
      }
      if (pw.next !== pw.confirm) {
        pwStatus.value = { type: 'error', message: 'New passwords do not match.' };
        return;
      }
      pwBusy.value = true;
      try {
        await changePassword(pw.current, pw.next);
        pw.current = pw.next = pw.confirm = '';
        pwStatus.value = { type: 'success', message: 'Password changed. Other devices have been signed out.' };
      } catch (err) {
        pwStatus.value = { type: 'error', message: err.message };
      } finally {
        pwBusy.value = false;
      }
    }

    async function signOut() {
      try {
        await logout();
      } finally {
        emit('signed-out');
      }
    }

    const sections = SECTIONS;
    return {
      sections,
      mode, form, authError, authBusy, switchMode, submitAuth,
      displayName, displayNameChanged, profileStatus, profileBusy, saveDisplayName,
      pw, pwStatus, pwBusy, submitPasswordChange,
      signOut, formatDate,
    };
  },
  template: `
    <div class="account-page" :class="{ 'signed-in': user }">
      <!-- Signed out -->
      <div v-if="!user" class="card account-card">
        <div class="subtab-bar">
          <button class="subtab-btn" :class="{ active: mode === 'login' }" @click="switchMode('login')">Sign In</button>
          <button class="subtab-btn" :class="{ active: mode === 'register' }" @click="switchMode('register')">Create Account</button>
        </div>

        <p class="text-muted text-sm mb-16">
          {{ mode === 'login'
            ? 'Sign in to load your saved dashboard settings on any device.'
            : 'Create an account to save your tickers, feeds, and other settings to your profile. Your current settings will be copied into it.' }}
        </p>

        <form class="account-form" @submit.prevent="submitAuth">
          <div v-if="mode === 'register'">
            <label for="acct-name">Display name <span class="text-muted">(optional)</span></label>
            <input id="acct-name" v-model="form.displayName" autocomplete="nickname" maxlength="80" />
          </div>
          <div>
            <label for="acct-email">Email</label>
            <input id="acct-email" v-model="form.email" type="email" autocomplete="email" required />
          </div>
          <div>
            <label for="acct-password">Password</label>
            <input id="acct-password" v-model="form.password" type="password" required
              :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" />
          </div>
          <div v-if="mode === 'register'">
            <label for="acct-confirm">Confirm password</label>
            <input id="acct-confirm" v-model="form.confirmPassword" type="password" autocomplete="new-password" required />
          </div>

          <div v-if="authError" class="notice error" style="margin-bottom:0">✗ {{ authError }}</div>

          <button type="submit" class="primary" :disabled="authBusy">
            {{ authBusy ? 'Please wait…' : (mode === 'login' ? 'Sign In' : 'Create Account') }}
          </button>
        </form>
      </div>

      <!-- Signed in: side navigation of profile sections -->
      <div v-else class="profile-layout">
        <nav class="profile-nav" aria-label="Profile sections">
          <div class="profile-nav-user">
            <Avatar class="profile-nav-avatar" :avatar="user.avatar" :name="user.displayName || user.email" :size="40" />
            <div class="profile-nav-name">{{ user.displayName || 'Your profile' }}</div>
            <div class="text-muted text-sm profile-nav-email">{{ user.email }}</div>
          </div>
          <button v-for="s in sections" :key="s.id" type="button" class="profile-nav-item"
                  :class="{ active: section === s.id }" :aria-current="section === s.id ? 'page' : null"
                  @click="$emit('update:section', s.id)">
            <span class="profile-nav-icon" aria-hidden="true">{{ s.icon }}</span><span class="label-full">{{ s.label }}</span><span class="label-short" aria-hidden="true">{{ s.short ?? s.label }}</span>
          </button>
        </nav>

        <div class="profile-content">
        <LabelsManager v-if="section === 'labels'" />
        <AlertsManager v-else-if="section === 'alerts'" :config="config" />
        <BankAccounts v-else-if="section === 'banks'" />
        <DashboardSettings v-else-if="section === 'dashboard'" :config="config" @save="$emit('save-settings', $event)" />

        <template v-else>
        <div class="flex-between mb-16">
          <div class="section-header" style="margin-bottom:0">Profile</div>
          <button class="danger" @click="signOut">Sign Out</button>
        </div>

        <AvatarEditor :user="user" @updated="$emit('updated', $event)" />

        <div class="card account-card mb-16">
          <div class="card-title">Profile</div>
          <form class="account-form" @submit.prevent="saveDisplayName">
            <div>
              <label>Email</label>
              <input :value="user.email" disabled />
            </div>
            <div>
              <label for="acct-display">Display name</label>
              <input id="acct-display" v-model="displayName" maxlength="80" autocomplete="nickname" />
            </div>
            <div class="text-muted text-sm">
              Member since {{ formatDate(user.createdAt) }}.
              Your dashboard settings (tickers, feeds, thresholds, …) are saved to this profile —
              edit them in the ⚙ Settings tab.
            </div>
            <div v-if="profileStatus" class="notice" :class="{ error: profileStatus.type === 'error' }" style="margin-bottom:0">
              {{ profileStatus.type === 'error' ? '✗' : '✓' }} {{ profileStatus.message }}
            </div>
            <button type="submit" class="primary" :disabled="profileBusy || !displayNameChanged">Save Profile</button>
          </form>
        </div>

        <div class="card account-card">
          <div class="card-title">Change Password</div>
          <form class="account-form" @submit.prevent="submitPasswordChange">
            <input type="email" :value="user.email" autocomplete="username" hidden />
            <div>
              <label for="acct-pw-current">Current password</label>
              <input id="acct-pw-current" v-model="pw.current" type="password" autocomplete="current-password" required />
            </div>
            <div>
              <label for="acct-pw-new">New password</label>
              <input id="acct-pw-new" v-model="pw.next" type="password" autocomplete="new-password" required />
            </div>
            <div>
              <label for="acct-pw-confirm">Confirm new password</label>
              <input id="acct-pw-confirm" v-model="pw.confirm" type="password" autocomplete="new-password" required />
            </div>
            <div v-if="pwStatus" class="notice" :class="{ error: pwStatus.type === 'error' }" style="margin-bottom:0">
              {{ pwStatus.type === 'error' ? '✗' : '✓' }} {{ pwStatus.message }}
            </div>
            <button type="submit" class="primary" :disabled="pwBusy">{{ pwBusy ? 'Saving…' : 'Change Password' }}</button>
          </form>
        </div>
        </template>
        </div>
      </div>
    </div>
  `,
};
