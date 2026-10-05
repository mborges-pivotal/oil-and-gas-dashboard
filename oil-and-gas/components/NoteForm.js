const { ref, computed, onMounted } = Vue;

/**
 * Note form: labels + note text, used to save a news article to Notes
 * (stock News tab) and to edit a note (Notes page). With `manual` it also
 * edits the note's stocks and optional link (manual notes, written on the
 * Notes page) and the text becomes required.
 *
 * Existing labels are toggle chips; typing a name and pressing Enter (or
 * comma) adds a new one. Stocks work the same way: type a ticker, Enter.
 * Emits save({ labels, note }) — plus { symbols, link } when manual — and cancel.
 */
const MAX_LABELS = 10;          // per note — matches server/notes.js
const MAX_LABEL_LENGTH = 30;
const MAX_SYMBOLS = 10;
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,19}$/;

let uid = 0;

export default {
  name: 'NoteForm',
  props: {
    labels: { type: Array, default: () => [] },        // the user's labels: [{ id, name }]
    initialLabels: { type: Array, default: () => [] }, // names selected to start with
    initialNote: { type: String, default: '' },
    manual: Boolean,
    initialSymbols: { type: Array, default: () => [] },
    initialLink: { type: String, default: '' },
    knownSymbols: { type: Array, default: () => [] },  // ticker suggestions
    submitLabel: { type: String, default: 'Save' },
    busy: Boolean,
    error: String,
  },
  emits: ['save', 'cancel'],
  setup(props, { emit }) {
    const id = ++uid;
    const selected = ref([...props.initialLabels]);
    const note = ref(props.initialNote);
    const newLabel = ref('');
    const symbols = ref([...props.initialSymbols]);
    const newSymbol = ref('');
    const link = ref(props.initialLink);
    const localError = ref(null);
    const noteInput = ref(null);

    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    const isSelected = name => selected.value.some(s => same(s, name));
    // Existing labels plus any new ones typed in this form.
    const chips = computed(() => {
      const names = props.labels.map(l => l.name);
      for (const s of selected.value) if (!names.some(n => same(n, s))) names.push(s);
      return names;
    });
    const atLimit = computed(() => selected.value.length >= MAX_LABELS);

    function toggle(name) {
      if (isSelected(name)) selected.value = selected.value.filter(s => !same(s, name));
      else if (!atLimit.value) selected.value = [...selected.value, name];
    }

    function addNewLabel() {
      const name = newLabel.value.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LENGTH);
      newLabel.value = '';
      if (!name || atLimit.value) return;
      // Reuse an existing label's spelling when the name matches one.
      const existing = chips.value.find(n => same(n, name));
      if (!isSelected(existing ?? name)) selected.value = [...selected.value, existing ?? name];
    }

    function onLabelKeydown(e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addNewLabel();
      } else if (e.key === 'Backspace' && !newLabel.value && selected.value.length) {
        selected.value = selected.value.slice(0, -1);
      }
    }

    // ── Stocks (manual notes) ──
    const symbolSuggestions = computed(() => props.knownSymbols.filter(s => !symbols.value.includes(s)));
    function addSymbol() {
      const sym = newSymbol.value.trim().toUpperCase();
      if (!sym) return true;
      if (!TICKER_RE.test(sym)) {
        localError.value = `"${newSymbol.value.trim()}" isn't a ticker symbol.`;
        return false;
      }
      if (symbols.value.length >= MAX_SYMBOLS && !symbols.value.includes(sym)) {
        localError.value = `A note can have at most ${MAX_SYMBOLS} stocks.`;
        return false;
      }
      localError.value = null;
      newSymbol.value = '';
      if (!symbols.value.includes(sym)) symbols.value = [...symbols.value, sym];
      return true;
    }
    function removeSymbol(sym) {
      symbols.value = symbols.value.filter(s => s !== sym);
    }
    function onSymbolKeydown(e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
        e.preventDefault();
        addSymbol();
      } else if (e.key === 'Backspace' && !newSymbol.value && symbols.value.length) {
        symbols.value = symbols.value.slice(0, -1);
      }
    }

    function submit() {
      localError.value = null;
      if (newLabel.value.trim()) addNewLabel(); // a typed-but-not-added label counts
      const payload = { labels: selected.value, note: note.value.trim() };
      if (props.manual) {
        if (!addSymbol()) return; // likewise a typed ticker
        const url = link.value.trim();
        if (url) {
          try {
            const u = new URL(url);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
          } catch {
            localError.value = 'The link must be a web address starting with http:// or https://';
            return;
          }
        }
        if (!payload.note) {
          localError.value = 'Write something in the note.';
          noteInput.value?.focus();
          return;
        }
        Object.assign(payload, { symbols: symbols.value, link: url });
      }
      emit('save', payload);
    }

    onMounted(() => noteInput.value?.focus());

    return {
      id, selected, note, newLabel, symbols, newSymbol, link, localError, noteInput, chips, atLimit,
      MAX_LABELS, MAX_LABEL_LENGTH, MAX_SYMBOLS, symbolSuggestions,
      isSelected, toggle, addNewLabel, onLabelKeydown, addSymbol, removeSymbol, onSymbolKeydown, submit,
    };
  },
  template: `
    <form class="note-form" @submit.prevent="submit" @keydown.esc.stop="$emit('cancel')" @click.stop novalidate>
      <div class="note-form-labels">
        <span class="note-form-heading">Labels</span>
        <div class="note-chips" role="group" aria-label="Labels">
          <button v-for="name in chips" :key="name" type="button" class="note-chip"
                  :class="{ selected: isSelected(name) }" :aria-pressed="isSelected(name)"
                  :disabled="!isSelected(name) && atLimit" @click="toggle(name)">
            <span aria-hidden="true">{{ isSelected(name) ? '✓ ' : '' }}</span>{{ name }}
          </button>
          <input class="note-new-label" v-model="newLabel" :maxlength="MAX_LABEL_LENGTH"
                 :placeholder="atLimit ? 'Max ' + MAX_LABELS + ' labels' : (chips.length ? '+ New label' : 'Add a label, press Enter')"
                 :disabled="atLimit" aria-label="New label" @keydown="onLabelKeydown" />
        </div>
      </div>

      <template v-if="manual">
        <div class="note-form-labels">
          <span class="note-form-heading">Stocks</span>
          <div class="note-chips" role="group" aria-label="Stocks">
            <span class="note-chip selected note-symbol-chip" v-for="s in symbols" :key="s">
              {{ s }}
              <button type="button" class="note-symbol-remove" :aria-label="'Remove ' + s" @click="removeSymbol(s)">✕</button>
            </span>
            <input class="note-new-label note-new-symbol" v-model="newSymbol" maxlength="20" autocomplete="off"
                   :list="'note-symbols-' + id" :placeholder="symbols.length ? '+ Ticker' : 'Add a ticker, press Enter (optional)'"
                   aria-label="Add a stock ticker" @keydown="onSymbolKeydown" @change="addSymbol" />
            <datalist :id="'note-symbols-' + id">
              <option v-for="s in symbolSuggestions" :key="s" :value="s"></option>
            </datalist>
          </div>
        </div>
        <label class="note-form-heading" style="display:block">
          Link <span class="note-optional">(optional)</span>
          <input class="note-link-input" type="url" inputmode="url" v-model="link" placeholder="https://…" />
        </label>
      </template>

      <label class="note-form-heading" style="display:block">
        Note
        <textarea ref="noteInput" v-model="note" rows="3" maxlength="5000"
                  :placeholder="manual ? 'Your note…' : 'Why it matters, what to watch…'"></textarea>
      </label>
      <div class="notice error note-form-error" v-if="localError || error">{{ localError || error }}</div>
      <div class="note-form-actions">
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : submitLabel }}</button>
        <button type="button" @click="$emit('cancel')">Cancel</button>
      </div>
    </form>
  `,
};
