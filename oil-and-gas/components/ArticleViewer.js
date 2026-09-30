const { ref, computed, watch, nextTick, onUnmounted } = Vue;
import { articleViewer, closeArticleViewer, safeArticleUrl } from '../utils/articleViewer.js';

// Show the frame after this long even if the server's framing check hasn't
// answered yet — an unknown answer means "just try it" anyway, so there's
// no point making the reader stare at a spinner for a slow site.
const CHECK_WAIT_MS = 1500;

// origin -> true | false, for the life of the page. Only definite answers
// are cached — an unknown one (network error, endpoint unavailable, site
// timed out) is asked again next time rather than stuck for the session.
const frameCheckCache = new Map();

async function checkEmbeddable(url) {
  const origin = new URL(url).origin;
  if (frameCheckCache.has(origin)) return frameCheckCache.get(origin);
  let embeddable = null;
  try {
    const res = await fetch(`/api/frame-check?url=${encodeURIComponent(url)}`);
    if (res.ok) embeddable = (await res.json()).embeddable ?? null;
  } catch {
    // leave unknown
  }
  if (embeddable !== null) frameCheckCache.set(origin, embeddable);
  return embeddable;
}

/**
 * Popup viewer for news articles: the article in a sandboxed iframe, with
 * "Open in new tab" and close. Many sites forbid being framed; the server
 * checks the site's headers (/api/frame-check) and, when framing is
 * blocked, this shows a notice + new-tab button instead of a broken frame.
 */
export default {
  name: 'ArticleViewer',
  setup() {
    const article = computed(() => articleViewer.article);
    const url = computed(() => article.value && safeArticleUrl(article.value.link));
    // 'checking' | 'frame' | 'blocked'
    const state = ref('checking');
    // True when the frame is shown without a confirmed "embeddable" answer
    // — a site that blocks framing then shows only the browser's bare
    // "refused to connect" page, and the page can't detect that, so show a
    // hint pointing at "Open in new tab".
    const unverified = ref(false);
    const blockedReason = ref('');
    const frameLoaded = ref(false);
    const closeBtn = ref(null);
    let returnFocusTo = null;
    let openToken = 0;

    async function open(targetUrl) {
      const token = ++openToken;
      frameLoaded.value = false;
      blockedReason.value = '';

      // An http:// page can't load inside this page when it's served over
      // https (mixed content) — no need to ask the server.
      if (location.protocol === 'https:' && targetUrl.startsWith('http:')) {
        state.value = 'blocked';
        blockedReason.value = 'This article is served over an insecure connection, so it can’t be shown inside the dashboard.';
        return;
      }

      state.value = 'checking';
      unverified.value = false;
      const check = checkEmbeddable(targetUrl);
      const first = await Promise.race([check, new Promise((r) => setTimeout(() => r('timeout'), CHECK_WAIT_MS))]);
      if (token !== openToken) return;
      if (first === false) return markBlocked();
      unverified.value = first !== true;
      state.value = 'frame';
      if (first !== 'timeout') return;
      const result = await check;
      if (token !== openToken) return;
      if (result === false) markBlocked();
      else unverified.value = result !== true;
    }

    function markBlocked() {
      state.value = 'blocked';
      blockedReason.value = 'This site doesn’t allow its pages to be shown inside other websites.';
    }

    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }

    function close() {
      closeArticleViewer();
    }

    watch(url, async (next, prev) => {
      if (next && !prev) {
        returnFocusTo = document.activeElement;
        document.body.style.overflow = 'hidden'; // no background scroll behind the modal
        window.addEventListener('keydown', onKeydown);
      }
      if (next) {
        open(next);
        await nextTick();
        closeBtn.value?.focus();
      } else if (prev) {
        openToken++;
        document.body.style.overflow = '';
        window.removeEventListener('keydown', onKeydown);
        returnFocusTo?.focus?.();
        returnFocusTo = null;
      }
    });

    onUnmounted(() => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKeydown);
    });

    const host = computed(() => (url.value ? new URL(url.value).hostname.replace(/^www\./, '') : ''));

    return { article, url, host, state, unverified, blockedReason, frameLoaded, closeBtn, close };
  },
  template: `
    <div v-if="url" class="article-viewer-backdrop" @click.self="close">
      <div class="article-viewer" role="dialog" aria-modal="true" :aria-label="article.title">
        <div class="article-viewer-bar">
          <div class="article-viewer-title">
            <span class="source-badge" v-if="article.source">{{ article.source }}</span>
            <span class="article-viewer-heading" :title="article.title">{{ article.title }}</span>
            <span class="text-muted text-sm article-viewer-host">{{ host }}</span>
          </div>
          <div class="flex gap-8" style="flex:none">
            <a class="button-link" :href="url" target="_blank" rel="noopener noreferrer" @click="close">Open in new tab ↗</a>
            <button ref="closeBtn" type="button" @click="close" aria-label="Close article">✕</button>
          </div>
        </div>

        <div v-if="state === 'frame' && unverified" class="article-viewer-hint text-sm">
          Page not showing? Some sites don’t allow being displayed inside other websites —
          <a :href="url" target="_blank" rel="noopener noreferrer" @click="close">open it in a new tab ↗</a>
        </div>

        <div class="article-viewer-body">
          <div v-if="state === 'blocked'" class="article-viewer-blocked">
            <div class="article-viewer-blocked-title">Can’t show this article here</div>
            <p class="text-muted">{{ blockedReason }}</p>
            <a class="button-link primary" :href="url" target="_blank" rel="noopener noreferrer" @click="close">Open in new tab ↗</a>
          </div>
          <template v-else>
            <div v-if="state === 'checking' || !frameLoaded" class="article-viewer-loading loading-text">Loading article…</div>
            <!-- sandbox without allow-top-navigation: the framed site can't
                 redirect the dashboard itself ("frame busting") -->
            <iframe
              v-if="state === 'frame'"
              :key="url"
              :src="url"
              :title="article.title"
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
              referrerpolicy="strict-origin-when-cross-origin"
              @load="frameLoaded = true"
            ></iframe>
          </template>
        </div>
      </div>
    </div>
  `,
};
