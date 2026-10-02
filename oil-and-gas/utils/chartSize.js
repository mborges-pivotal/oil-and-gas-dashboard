const { ref, onMounted, onUnmounted } = Vue;

/**
 * Track a chart container's rendered width so that, on narrow screens, an
 * inline-SVG chart draws at 1:1 scale (viewBox = actual pixels) instead of
 * shrinking a fixed 720px-wide drawing — on a phone that scaled the 10px
 * axis text down to ~4px. Containers at least `narrowBelow` wide keep the
 * fixed drawing (scaled up, as before), so desktop looks unchanged.
 *
 * Returns refs { width, height }; pass the container element's ref.
 */
export function useChartSize(elRef, { defaultWidth = 720, height = 260, narrowHeight = 200, narrowBelow = 600 } = {}) {
  const width = ref(defaultWidth);
  const h = ref(height);
  let observer = null;

  function measure() {
    const w = elRef.value?.clientWidth;
    if (!w) return;
    const narrow = w < narrowBelow;
    width.value = narrow ? Math.round(w) : defaultWidth;
    h.value = narrow ? narrowHeight : height;
  }

  onMounted(() => {
    measure();
    if (typeof ResizeObserver !== 'undefined' && elRef.value) {
      observer = new ResizeObserver(measure);
      observer.observe(elRef.value);
    }
  });
  onUnmounted(() => observer?.disconnect());

  return { width, height: h };
}

/** Max x-axis labels that fit a plot this wide (~45px per label). */
export function maxTicksFor(plotWidth, cap) {
  return Math.max(3, Math.min(cap, Math.floor(plotWidth / 45)));
}
