const { ref, computed, watch, onMounted, onUnmounted } = Vue;
import { PRESET_COLORS, normalizeHex, inkFor, nextPreset } from '../utils/labelColors.js';

/**
 * New / edit label dialog (Profile → Labels): a live preview of the chip,
 * then Name, Description and Color. The color button cycles through common
 * colors; the hex field takes any custom one. Esc cancels; ⌘/Ctrl+Enter saves.
 * Emits save({ name, description, color }) and cancel.
 */
const MAX_NAME = 30;          // matches server/notes.js
const MAX_DESCRIPTION = 200;

export default {
  name: 'LabelDialog',
  props: {
    label: { type: Object, default: null }, // null → new label
    defaultColor: { type: String, default: PRESET_COLORS[0] },
    busy: Boolean,
    error: String,
  },
  emits: ['save', 'cancel'],
  setup(props, { emit }) {
    const name = ref(props.label?.name ?? '');
    const description = ref(props.label?.description ?? '');
    const colorText = ref(props.label?.color || props.defaultColor);
    const lastValid = ref(normalizeHex(colorText.value) ?? PRESET_COLORS[0]);
    const nameInput = ref(null);
    const localError = ref(null);
    let returnFocusTo = null;

    const color = computed(() => normalizeHex(colorText.value));
    const shown = computed(() => color.value ?? lastValid.value); // preview keeps the last good color while typing
    const ink = computed(() => inkFor(shown.value));
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

    // A validation message goes away as soon as you change what it was about.
    watch([name, colorText], () => { localError.value = null; });

    function onColorInput() {
      if (color.value) lastValid.value = color.value;
    }
    function cycleColor() {
      colorText.value = nextPreset(shown.value);
      lastValid.value = colorText.value;
    }

    function submit() {
      localError.value = null;
      const n = name.value.trim().replace(/\s+/g, ' ');
      if (!n) {
        localError.value = 'Give the label a name.';
        nameInput.value?.focus();
        return;
      }
      if (!color.value) {
        localError.value = 'Enter a color as a hex code, like #f143ab — or use the color button.';
        return;
      }
      emit('save', { name: n, description: description.value.trim(), color: color.value });
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        emit('cancel');
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    }

    onMounted(() => {
      returnFocusTo = document.activeElement;
      nameInput.value?.focus();
      nameInput.value?.select();
    });
    onUnmounted(() => returnFocusTo?.focus?.());

    return {
      name, description, colorText, color, shown, ink, nameInput, localError, isMac,
      MAX_NAME, MAX_DESCRIPTION, onColorInput, cycleColor, submit, onKeydown,
    };
  },
  template: `
    <div class="modal-backdrop" @click.self="$emit('cancel')" @keydown="onKeydown">
      <form class="modal label-dialog" role="dialog" aria-modal="true" aria-labelledby="label-dialog-title"
            @submit.prevent="submit" novalidate>
        <div class="modal-head">
          <h2 id="label-dialog-title">{{ label ? 'Edit label' : 'New label' }}</h2>
          <button type="button" class="modal-close" aria-label="Close" @click="$emit('cancel')">✕</button>
        </div>

        <div class="modal-body">
          <div class="label-preview" aria-label="Preview">
            <span class="label-chip-lg" :style="{ background: shown, color: ink }">{{ name.trim() || 'label preview' }}</span>
          </div>

          <label class="modal-field">
            <span>Name</span>
            <input ref="nameInput" v-model="name" :maxlength="MAX_NAME" autocomplete="off" />
          </label>

          <label class="modal-field">
            <span>Description</span>
            <textarea v-model="description" rows="3" :maxlength="MAX_DESCRIPTION" placeholder="Optional — what this label is for"></textarea>
          </label>

          <div class="modal-field">
            <span id="label-color-heading">Color</span>
            <div class="label-color-row">
              <button type="button" class="label-color-cycle" :style="{ background: shown, color: ink }"
                      aria-label="Next color" title="Try another color" @click="cycleColor">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6M18 3v4h-4M6 21v-4h4" fill="none"
                        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <input class="label-color-input" :class="{ valid: !!color, invalid: !color }" v-model="colorText"
                     maxlength="7" spellcheck="false" autocomplete="off" aria-labelledby="label-color-heading"
                     :aria-invalid="!color" @input="onColorInput" />
            </div>
          </div>

          <div class="notice error" v-if="localError || error" style="margin:0">{{ localError || error }}</div>
        </div>

        <div class="modal-foot">
          <button type="button" @click="$emit('cancel')">Cancel</button>
          <button type="submit" class="primary" :disabled="busy">
            {{ busy ? 'Saving…' : (label ? 'Save changes' : 'Create label') }}
            <kbd class="modal-kbd" aria-hidden="true">{{ isMac ? '⌘' : 'Ctrl' }} ↵</kbd>
          </button>
        </div>
      </form>
    </div>
  `,
};
