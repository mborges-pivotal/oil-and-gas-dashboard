/**
 * A profile avatar: the uploaded photo when there is one, else the preset
 * (an emoji on its color), else initials. avatar = { preset: { emoji, color }, image }.
 */
export default {
  name: 'Avatar',
  props: { avatar: Object, name: { type: String, default: '' }, size: { type: Number, default: 32 } },
  computed: {
    initials() {
      const parts = (this.name || '').trim().split(/\s+/).filter(Boolean);
      return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
    },
    style() {
      const c = this.avatar?.preset?.color ?? 1;
      return { width: this.size + 'px', height: this.size + 'px', fontSize: Math.round(this.size * 0.55) + 'px', background: `var(--series-${c})`, color: `var(--series-${c}-ink)` };
    },
  },
  template: `
    <span class="avatar" :style="style" aria-hidden="true">
      <img v-if="avatar?.image" :src="avatar.image" alt="" />
      <template v-else-if="avatar?.preset?.emoji">{{ avatar.preset.emoji }}</template>
      <span v-else class="avatar-initials">{{ initials }}</span>
    </span>
  `,
};
