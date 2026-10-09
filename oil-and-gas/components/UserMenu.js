import Avatar from './Avatar.js';
const { ref, computed, watch, nextTick, onUnmounted } = Vue;

/**
 * Header account menu — replaces the old ⚙ Settings and Sign In tabs.
 * The button — a circle with the signed-in user's picture (or a person icon
 * when signed out) — opens a dropdown with Profile / Sign in, Settings and
 * Sign out. (The theme button is in the app's subheader.)
 */
export default {
  name: 'UserMenu',
  components: { Avatar },
  props: ['user', 'activeTab'],
  emits: ['navigate', 'sign-out'],
  setup(props, { emit }) {
    const open = ref(false);
    const root = ref(null);
    const button = ref(null);
    const menu = ref(null);

    const initials = computed(() => {
      const u = props.user;
      if (!u) return '';
      const name = (u.displayName || '').trim();
      if (name) {
        const parts = name.split(/\s+/);
        return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
      }
      return (u.email || '?')[0].toUpperCase();
    });
    const isActive = computed(() => props.activeTab === 'settings' || props.activeTab === 'account');

    function items() {
      // Only the visible items (keyboard navigation).
      return [...(menu.value?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') ?? [])]
        .filter(el => el.offsetParent !== null);
    }

    function close({ refocus = false } = {}) {
      open.value = false;
      if (refocus) button.value?.focus();
    }
    function toggle() {
      open.value = !open.value;
    }

    // Close on any press outside the menu.
    function onDocPointerDown(e) {
      if (!root.value?.contains(e.target)) close();
    }
    watch(open, isOpen => {
      if (isOpen) {
        document.addEventListener('pointerdown', onDocPointerDown);
        nextTick(() => items()[0]?.focus());
      } else {
        document.removeEventListener('pointerdown', onDocPointerDown);
      }
    });
    onUnmounted(() => document.removeEventListener('pointerdown', onDocPointerDown));

    function onButtonKeydown(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        open.value = true;
      }
    }
    function onMenuKeydown(e) {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        close({ refocus: true });
      } else if (e.key === 'Tab') {
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        list[(i + 1) % list.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        list[(i - 1 + list.length) % list.length]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        list[list.length - 1]?.focus();
      }
    }

    function go(tab) {
      emit('navigate', tab);
      close();
    }
    function signOut() {
      emit('sign-out');
      close();
    }

    return {
      open, root, button, menu, initials, isActive,
      toggle, onButtonKeydown, onMenuKeydown, go, signOut,
    };
  },
  template: `
    <div class="user-menu" ref="root">
      <button
        ref="button"
        type="button"
        class="user-menu-button"
        :class="{ active: isActive, 'signed-in': !!user }"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-label="user ? 'Account menu for ' + (user.displayName || user.email) : 'Account menu'"
        :title="user ? (user.displayName || user.email) : 'Sign in & settings'"
        @click="toggle"
        @keydown="onButtonKeydown"
      >
        <Avatar v-if="user" class="user-menu-avatar-img" :avatar="user.avatar" :name="user.displayName || user.email" :size="34" />
        <svg v-else class="user-menu-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>

      <div class="user-menu-panel" v-if="open" ref="menu" role="menu" @keydown="onMenuKeydown">
        <div class="user-menu-identity" v-if="user">
          <div class="user-menu-name">{{ user.displayName || user.email }}</div>
          <div class="text-muted text-sm" v-if="user.displayName">{{ user.email }}</div>
        </div>

        <button type="button" role="menuitem" class="user-menu-item"
                :class="{ current: activeTab === 'account' }" @click="go('account')">
          {{ user ? '👤 Profile' : 'Sign in / Register' }}
        </button>
        <button type="button" role="menuitem" class="user-menu-item"
                :class="{ current: activeTab === 'settings' }" @click="go('settings')">
          ⚙ Settings
        </button>

        <template v-if="user">
          <div class="user-menu-sep"></div>
          <button type="button" role="menuitem" class="user-menu-item" @click="signOut">Sign out</button>
        </template>
      </div>
    </div>
  `,
};
