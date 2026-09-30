/**
 * Shared state + helpers for opening news articles — either in the popup
 * viewer (components/ArticleViewer.js, mounted once in app.js) or in a new
 * browser tab, per the "Open articles in" setting (config.news.openArticlesIn).
 */

const { reactive } = Vue;

export const OPEN_ARTICLES_IN_DEFAULT = 'popup';

// The article currently shown in the popup viewer (null = closed).
export const articleViewer = reactive({ article: null });

/**
 * Feed-supplied links are third-party content: only http(s) URLs are ever
 * rendered as links, so a hostile feed can't slip in a javascript: URL.
 */
export function safeArticleUrl(link) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Click handler for article links (which are plain target="_blank" anchors,
 * so middle/Cmd/Ctrl/Shift-click and "open in new tab" keep working
 * natively). In popup mode, a plain left click opens the viewer instead.
 */
export function onArticleClick(event, article, config) {
  const mode = config?.news?.openArticlesIn ?? OPEN_ARTICLES_IN_DEFAULT;
  if (mode !== 'popup') return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!safeArticleUrl(article.link)) return;
  event.preventDefault();
  articleViewer.article = article;
}

export function closeArticleViewer() {
  articleViewer.article = null;
}
