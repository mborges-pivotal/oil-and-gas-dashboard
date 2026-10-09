const { ref, reactive, computed, watch, onMounted } = Vue;
import Avatar from './Avatar.js';
import { inboxStore } from '../utils/inboxStore.js';
import { formatRelativeTime } from '../utils/formatters.js';
import {
  fetchFeed, fetchPost, markFeedRead, deletePost, setLiked, fetchReplies, addReply, deleteReply,
  setFollowing, shareLink, copyText,
} from '../services/social.js';

const TABS = [
  { id: 'you',       label: 'You' },
  { id: 'following', label: 'Following' },
];
const MAX_REPLY = 2000;

// One update — a feed item or the focused one (p).
const POST_CARD = `
  <article class="card post-card" :aria-label="'Update from @' + p.portfolio.id">
    <header class="post-head">
      <div class="post-trades">
        <span v-for="(t, i) in p.trades" :key="i" class="post-trade">
          <span class="post-action" :class="t.action">{{ t.action === 'buy' ? 'BUY' : 'SELL' }}</span>
          <span class="post-ticker">{{ t.symbol }}</span>
        </span>
      </div>
      <div class="post-meta">
        <span class="pf-thumb post-thumb" aria-hidden="true"><img v-if="p.portfolio.image" :src="p.portfolio.image" alt="" /><template v-else>{{ initials(p.portfolio.name) }}</template></span>
        <span class="post-handle">@{{ p.portfolio.id }}</span>
        <span class="text-muted text-sm post-by">{{ p.portfolio.name }} · {{ p.owner }}</span>
        <span class="post-private text-sm" v-if="p.mine && !p.portfolio.public" title="Private portfolio — only you see this update">🔒 only you</span>
        <span class="text-muted text-sm post-time" :title="new Date(p.createdAt).toLocaleString()">{{ formatRelativeTime(p.createdAt) }}</span>
      </div>
    </header>
    <p class="post-message" v-if="p.message">{{ p.message }}</p>
    <footer class="post-actions">
      <button type="button" class="post-btn" :class="{ liked: p.liked }" :disabled="!p.canInteract" :aria-pressed="p.liked"
              :title="p.canInteract ? (p.liked ? 'Unlike' : 'Like') : 'Follow the portfolio to like'" @click="toggleLike(p)">
        <span aria-hidden="true">{{ p.liked ? '♥' : '♡' }}</span> {{ p.likes }}<span class="sr-only"> likes</span>
      </button>
      <button type="button" class="post-btn" :aria-expanded="!!threads[p.id]?.open" @click="openThread(p)" title="Replies">
        <span aria-hidden="true">💬</span> {{ p.replies }}<span class="sr-only"> replies</span>
      </button>
      <button type="button" class="post-btn" @click="forward(p)" title="Copy a link to this update">
        <span aria-hidden="true">↗</span> Forward
      </button>
      <button type="button" class="post-btn" v-if="!p.mine && !p.canInteract && p.portfolio.public" @click="follow(p)">＋ Follow @{{ p.portfolio.id }}</button>
      <button type="button" class="link-button danger-link post-delete" v-if="p.mine" @click="remove(p)">Delete</button>
    </footer>
    <div class="notice error" v-if="rowError[p.id]" style="margin:8px 0 0">{{ rowError[p.id] }}</div>

    <div class="post-thread" v-if="threads[p.id]?.open">
      <div class="skeleton" style="height:40px" v-if="threads[p.id].loading"></div>
      <p class="text-muted text-sm" v-else-if="threads[p.id].replies && !threads[p.id].replies.length" style="margin:0 0 8px">No replies yet.</p>
      <ul class="reply-list" v-if="threads[p.id].replies?.length">
        <li class="reply" v-for="r in threads[p.id].replies" :key="r.id">
          <Avatar :avatar="r.avatar" :name="r.author" :size="26" />
          <div class="reply-body">
            <div class="text-sm"><strong>{{ r.author }}</strong>
              <span class="post-owner-tag" v-if="r.byOwner">author</span>
              <span class="text-muted"> · {{ formatRelativeTime(r.createdAt) }}</span>
              <button type="button" class="link-button danger-link reply-delete" v-if="r.canDelete" @click="removeReply(p, r)">Delete</button>
            </div>
            <div class="reply-text">{{ r.body }}</div>
          </div>
        </li>
      </ul>
      <form class="reply-form" v-if="p.canInteract" @submit.prevent="sendReply(p)">
        <textarea v-model="threads[p.id].draft" rows="2" :maxlength="MAX_REPLY" placeholder="Write a reply…" aria-label="Reply"
                  @keydown.enter.meta.prevent="sendReply(p)" @keydown.enter.ctrl.prevent="sendReply(p)"></textarea>
        <div class="reply-form-foot">
          <span class="text-muted text-sm" v-if="threads[p.id].draft.length > MAX_REPLY - 200">{{ MAX_REPLY - threads[p.id].draft.length }} left</span>
          <button type="submit" class="primary" :disabled="!threads[p.id].draft.trim() || threads[p.id].busy">{{ threads[p.id].busy ? 'Sending…' : 'Reply' }}</button>
        </div>
      </form>
      <p class="text-muted text-sm" v-else style="margin:4px 0 0">Only followers of @{{ p.portfolio.id }} can reply.</p>
      <div class="notice error" v-if="threads[p.id].error" style="margin:8px 0 0">{{ threads[p.id].error }}</div>
    </div>
  </article>
`;

/**
 * Inbox → Activity: portfolio updates (server/social.js).
 *  - You: the updates you've shared (Account → Transactions → Share update),
 *    with others' likes and replies.
 *  - Following: updates from public portfolios you follow, posted since you
 *    followed. Followers (and the author) can like ♥ and reply.
 * Forward copies a link to the update — nothing is sent to anyone. Opening a
 * link (#post=<id>) shows that update on top (read-only unless you follow).
 */
export default {
  name: 'ActivityFeed',
  components: { Avatar },
  props: { focusPost: { type: [Number, String], default: null } },
  emits: ['discover', 'share', 'clear-focus'],
  setup(props, { emit }) {
    const TAB_KEY = 'oilgas_activity_tab';
    const tab = ref((() => {
      try { return localStorage.getItem(TAB_KEY) === 'following' ? 'following' : 'you'; } catch { return 'you'; }
    })());
    watch(tab, t => { try { localStorage.setItem(TAB_KEY, t); } catch { /* per-browser only */ } });

    const feeds = reactive({ you: null, following: null }); // { posts, more } once loaded
    const loading = ref(false);
    const error = ref(null);
    const toast = ref(null);
    const rowError = reactive({}); // post id → message

    async function load(t, older = false) {
      loading.value = true;
      error.value = null;
      try {
        const before = older ? feeds[t]?.posts.at(-1)?.id : null;
        const page = await fetchFeed(t, before);
        feeds[t] = older ? { posts: [...feeds[t].posts, ...page.posts], more: page.more } : { posts: page.posts, more: page.more };
        if (!older && inboxStore.activity[t]) {
          // Seen: clear this feed's badge (the server keeps when it was read).
          const n = await markFeedRead(t).catch(() => null);
          if (n) inboxStore.activity = { you: n.you, following: n.following };
        }
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }
    watch(tab, t => load(t), { immediate: true });
    // New activity while open (the badge counted up): refresh that feed.
    watch(() => inboxStore.activity[tab.value], n => { if (n && !loading.value) load(tab.value); });

    // A forwarded link: that one update, on top.
    const focused = ref(null);
    const focusError = ref(null);
    async function loadFocus() {
      focused.value = null;
      focusError.value = null;
      if (!props.focusPost) return;
      try {
        focused.value = await fetchPost(props.focusPost);
        openThread(focused.value, true);
      } catch (e) {
        focusError.value = e.message === 'Update not found' ? 'That update is no longer available — it was deleted or its portfolio is now private.' : e.message;
      }
    }
    watch(() => props.focusPost, loadFocus);
    onMounted(loadFocus);

    const posts = computed(() => (feeds[tab.value]?.posts ?? []).filter(p => p.id !== focused.value?.id));

    // The same update can be in a feed and on top (focused): keep both copies in step.
    function replacePost(updated) {
      for (const t of ['you', 'following']) {
        const list = feeds[t]?.posts;
        const i = list?.findIndex(p => p.id === updated.id) ?? -1;
        if (i >= 0) list[i] = { ...list[i], ...updated };
      }
      if (focused.value?.id === updated.id) focused.value = { ...focused.value, ...updated };
    }
    function dropPost(id) {
      for (const t of ['you', 'following']) if (feeds[t]) feeds[t].posts = feeds[t].posts.filter(p => p.id !== id);
      if (focused.value?.id === id) { focused.value = null; emit('clear-focus'); }
    }

    function flash(message) {
      toast.value = message;
      setTimeout(() => { if (toast.value === message) toast.value = null; }, 2200);
    }

    async function toggleLike(p) {
      if (!p.canInteract) return;
      delete rowError[p.id];
      // Optimistic, then the server's numbers.
      replacePost({ id: p.id, liked: !p.liked, likes: p.likes + (p.liked ? -1 : 1) });
      try {
        replacePost(await setLiked(p.id, !p.liked));
      } catch (e) {
        replacePost({ id: p.id, liked: p.liked, likes: p.likes });
        rowError[p.id] = e.message;
      }
    }
    async function forward(p) {
      if (await copyText(shareLink(`post=${p.id}`))) flash('Link copied — paste it anywhere to share this update');
    }
    async function remove(p) {
      if (!confirm('Delete this update? Its likes and replies are deleted too.')) return;
      delete rowError[p.id];
      try {
        await deletePost(p.id);
        dropPost(p.id);
      } catch (e) { rowError[p.id] = e.message; }
    }
    async function follow(p) {
      delete rowError[p.id];
      try {
        await setFollowing(p.portfolio.id, true);
        replacePost(await fetchPost(p.id));
        flash(`Following @${p.portfolio.id} — its new updates appear under Following`);
      } catch (e) { rowError[p.id] = e.message; }
    }

    // Reply threads: post id → { open, replies, loading, draft, busy, error }
    const threads = reactive({});
    async function openThread(p, keepOpen = false) {
      const t = threads[p.id] ??= { open: false, replies: null, loading: false, draft: '', busy: false, error: null };
      t.open = keepOpen || !t.open;
      if (!t.open || t.replies) return;
      t.loading = true;
      try { t.replies = await fetchReplies(p.id); } catch (e) { t.error = e.message; }
      t.loading = false;
    }
    async function sendReply(p) {
      const t = threads[p.id];
      const body = t.draft.trim();
      if (!body || t.busy) return;
      t.busy = true;
      t.error = null;
      try {
        const { reply, post } = await addReply(p.id, body);
        t.replies = [...(t.replies ?? []), reply];
        t.draft = '';
        replacePost(post);
      } catch (e) { t.error = e.message; }
      t.busy = false;
    }
    async function removeReply(p, r) {
      if (!confirm('Delete this reply?')) return;
      const t = threads[p.id];
      t.error = null;
      try {
        await deleteReply(r.id);
        t.replies = t.replies.filter(x => x.id !== r.id);
        replacePost({ id: p.id, replies: Math.max(0, p.replies - 1) });
      } catch (e) { t.error = e.message; }
    }

    return {
      TABS, MAX_REPLY, tab, feeds, loading, error, toast, rowError, posts, focused, focusError, threads, inboxStore,
      initials: name => (name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(),
      load, toggleLike, forward, remove, follow, openThread, sendReply, removeReply, formatRelativeTime,
    };
  },
  template: `
    <div class="activity-feed">
      <div class="activity-feed-head">
        <div class="note-chips" role="tablist" aria-label="Activity">
          <button v-for="t in TABS" :key="t.id" type="button" role="tab" class="note-chip" :class="{ selected: tab === t.id }"
                  :aria-selected="tab === t.id" @click="tab = t.id">
            {{ t.label }}<span class="count-badge" v-if="inboxStore.activity[t.id]" :aria-label="inboxStore.activity[t.id] + ' new'">{{ inboxStore.activity[t.id] }}</span>
          </button>
        </div>
        <div class="activity-feed-links">
          <button type="button" class="link-button" @click="$emit('discover')">Discover portfolios</button>
          <button type="button" class="primary" @click="$emit('share')">Share update</button>
        </div>
      </div>
      <div class="toast" v-if="toast" role="status">{{ toast }}</div>

      <!-- A forwarded link -->
      <div class="notice" v-if="focusError">
        {{ focusError }} <button type="button" class="link-button" @click="$emit('clear-focus')">Dismiss</button>
      </div>
      <section v-if="focused" class="post-focus" aria-label="Shared update">
        <div class="post-focus-head text-sm text-muted">
          Shared update <button type="button" class="link-button" aria-label="Close" @click="$emit('clear-focus')">✕</button>
        </div>
        <template v-for="p in [focused]" :key="'f' + p.id">
          ${POST_CARD}
        </template>
      </section>

      <div class="notice error" v-if="error">
        Couldn't load activity: {{ error }} <button type="button" class="link-button" @click="load(tab)">Retry</button>
      </div>
      <div class="skeleton" style="height:140px" v-else-if="!feeds[tab]"></div>
      <div class="notice" v-else-if="!posts.length && !focused">
        <template v-if="tab === 'you'">
          No updates yet. Share your buys and sells from <strong>Account → Transactions → Share update</strong>.
          Updates from a public portfolio also go to everyone following it.
        </template>
        <template v-else>
          Nothing here yet. Follow public portfolios in <a href="#" @click.prevent="$emit('discover')">Account → Portfolios → Discover</a>;
          the updates they share from then on show up here.
        </template>
      </div>
      <ul class="post-list" v-if="posts.length">
        <li v-for="p in posts" :key="p.id">${POST_CARD}</li>
      </ul>
      <button type="button" class="activity-more" v-if="feeds[tab]?.more" :disabled="loading" @click="load(tab, true)">
        {{ loading ? 'Loading…' : 'Show older updates' }}
      </button>
    </div>
  `,
};
