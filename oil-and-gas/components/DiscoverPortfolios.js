const { ref, watch, onMounted } = Vue;
import { formatPct, changeClass } from '../utils/formatters.js';
import { searchPublicPortfolios, setFollowing, shareLink, copyText } from '../services/social.js';

/**
 * Account → Portfolios → Discover (below the portfolio cards): public
 * portfolios from every account — best All-Time return first, or searched by
 * name, @id or owner. Follow one to get the updates it shares from then on in
 * Inbox → Activity → Following (and to like and reply to them). Forward
 * copies a link to the portfolio — nothing is sent to anyone.
 */
export default {
  name: 'DiscoverPortfolios',
  props: { initialQuery: { type: String, default: '' } },
  emits: ['go-activity'],
  setup(props) {
    const query = ref(props.initialQuery ?? '');
    const results = ref(null);
    const loading = ref(false);
    const error = ref(null);
    const busy = ref({}); // id → true while following/unfollowing
    const toast = ref(null);
    let seq = 0;
    let timer = null;

    async function search() {
      const mine = ++seq;
      loading.value = true;
      error.value = null;
      try {
        const rows = await searchPublicPortfolios(query.value.trim());
        if (mine === seq) results.value = rows;
      } catch (e) {
        if (mine === seq) error.value = e.message;
      } finally {
        if (mine === seq) loading.value = false;
      }
    }
    watch(query, () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    watch(() => props.initialQuery, q => { if (q != null && q !== query.value) query.value = q; });
    onMounted(search);

    function flash(message) {
      toast.value = message;
      setTimeout(() => { if (toast.value === message) toast.value = null; }, 2200);
    }
    async function toggleFollow(p) {
      busy.value = { ...busy.value, [p.id]: true };
      error.value = null;
      try {
        const r = await setFollowing(p.id, !p.following);
        p.following = r.following;
        p.followers = r.followers;
        if (r.following) flash(`Following @${p.id} — its new updates appear in Inbox → Activity → Following`);
      } catch (e) {
        error.value = e.message;
      } finally {
        busy.value = { ...busy.value, [p.id]: false };
      }
    }
    async function forward(p) {
      if (await copyText(shareLink(`portfolio=${p.id}`))) flash('Link copied — paste it anywhere to share this portfolio');
    }
    const initials = name => (name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

    return { query, results, loading, error, busy, toast, toggleFollow, forward, initials, formatPct, changeClass };
  },
  template: `
    <section class="discover" aria-labelledby="discover-title">
      <div class="discover-head">
        <h3 class="discover-title" id="discover-title">Discover</h3>
        <input type="search" class="discover-search" v-model="query" placeholder="Search public portfolios by name, @id or owner"
               aria-label="Search public portfolios" autocomplete="off" />
      </div>
      <p class="text-muted text-sm discover-note">
        Public portfolios from every account. <strong>Follow</strong> one to see the updates it shares from now on in
        <a href="#" @click.prevent="$emit('go-activity')">Inbox → Activity → Following</a>, and to like and reply to them.
      </p>
      <div class="toast" v-if="toast" role="status">{{ toast }}</div>
      <div class="notice error" v-if="error">{{ error }} <button type="button" class="link-button" @click="error = null">Dismiss</button></div>
      <div class="skeleton" style="height:96px" v-if="!results && loading"></div>
      <p class="text-muted text-sm" v-else-if="results && !results.length">
        {{ query.trim() ? 'No public portfolios match.' : 'No public portfolios yet.' }}
      </p>
      <ul class="discover-list" v-if="results?.length" :class="{ stale: loading }">
        <li class="card discover-item" v-for="p in results" :key="p.id">
          <span class="pf-thumb" aria-hidden="true"><img v-if="p.image" :src="p.image" alt="" /><template v-else>{{ initials(p.name) }}</template></span>
          <div class="discover-who">
            <div class="discover-name">{{ p.name }}</div>
            <div class="text-sm"><span class="post-handle">@{{ p.id }}</span> <span class="text-muted">· {{ p.owner }}</span></div>
            <div class="text-sm text-muted">
              {{ p.followers }} follower{{ p.followers === 1 ? '' : 's' }}
            </div>
          </div>
          <div class="discover-return">
            <span class="pf-card-label">All-time</span>
            <strong :class="changeClass(p.returnPct)">{{ p.returnPct != null ? formatPct(p.returnPct) : '—' }}</strong>
          </div>
          <div class="discover-actions">
            <span class="text-muted text-sm" v-if="p.mine">Yours</span>
            <button v-else type="button" :class="p.following ? 'following-btn' : 'primary'" :disabled="busy[p.id]" :aria-pressed="p.following"
                    :title="p.following ? 'Unfollow' : 'Follow — see its new updates in Inbox → Activity'" @click="toggleFollow(p)">
              {{ p.following ? '✓ Following' : '＋ Follow' }}
            </button>
            <button type="button" class="post-btn" title="Copy a link to this portfolio" @click="forward(p)"><span aria-hidden="true">↗</span> Forward</button>
          </div>
        </li>
      </ul>
    </section>
  `,
};
