const { ref, reactive, computed } = Vue;
import NoteForm from './NoteForm.js';
import { notesStore, loadNotes, addManualNote, editNote, removeNote, removeLabel } from '../utils/notesStore.js';
import { safeArticleUrl, onArticleClick } from '../utils/articleViewer.js';
import { formatDate, formatRelativeTime } from '../utils/formatters.js';

/**
 * Notes tab (signed in): news articles saved from a stock's News tab (each
 * under its stock) and manual notes written here (any stocks, optional
 * link), all with labels. Filter by stock, label (any selected) and text;
 * add, edit or delete notes; delete labels.
 */
export default {
  name: 'Notes',
  components: { NoteForm },
  // embedded: shown as the Inbox's Notes sub-tab — the page title comes from Inbox.
  props: { config: Object, embedded: Boolean },
  setup(props) {
    const symbolFilter = ref('');      // '' = all stocks
    const labelFilter = ref([]);       // label ids; a note matches if it has any
    const query = ref('');
    const editing = reactive({});      // note id → { busy, error }
    const pageError = ref(null);

    const symbols = computed(() => [...new Set(notesStore.notes.flatMap(n => n.symbols))].sort());
    // Ticker suggestions for a manual note: the default watchlist, portfolio
    // positions and stocks already used in notes.
    const knownSymbols = computed(() => [...new Set([
      ...(props.config?.stocks?.tickers ?? []),
      ...Object.keys(props.config?.portfolio ?? {}),
      ...symbols.value,
    ])].sort());

    // ── New manual note ──
    const creating = ref(null); // { busy, error } while the form is open
    async function saveNew({ labels, note, symbols: syms, link }) {
      creating.value.busy = true;
      creating.value.error = null;
      try {
        await addManualNote({ labels, note, symbols: syms, link });
        creating.value = null;
      } catch (e) {
        creating.value.error = e.message;
        creating.value.busy = false;
      }
    }

    function linkHost(url) {
      try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
    }
    // Labels in use, with counts, for the filter row (unused ones too, so they can be deleted).
    const labelCounts = computed(() => {
      const counts = new Map(notesStore.labels.map(l => [l.id, 0]));
      for (const n of notesStore.notes) for (const l of n.labels) counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
      return counts;
    });

    const filtered = computed(() => {
      const q = query.value.trim().toLowerCase();
      return notesStore.notes.filter(n =>
        (!symbolFilter.value || n.symbols.includes(symbolFilter.value))
        && (!labelFilter.value.length || n.labels.some(l => labelFilter.value.includes(l.id)))
        && (!q || [n.title, n.note, n.source, n.link, ...n.symbols, ...n.labels.map(l => l.name)].some(t => t?.toLowerCase().includes(q)))
      );
    });
    const filtering = computed(() => !!(symbolFilter.value || labelFilter.value.length || query.value.trim()));

    function toggleLabel(id) {
      labelFilter.value = labelFilter.value.includes(id)
        ? labelFilter.value.filter(x => x !== id)
        : [...labelFilter.value, id];
    }
    function clearFilters() {
      symbolFilter.value = '';
      labelFilter.value = [];
      query.value = '';
    }

    async function saveEdit(note, { labels, note: body, symbols: syms, link }) {
      const f = editing[note.id];
      f.busy = true;
      f.error = null;
      try {
        const fields = { labels, note: body };
        if (note.kind === 'manual') Object.assign(fields, { symbols: syms, link });
        await editNote(note.id, fields);
        delete editing[note.id];
      } catch (e) {
        f.error = e.message;
        f.busy = false;
      }
    }

    async function deleteNoteConfirm(note) {
      const what = note.title || (note.note.length > 80 ? note.note.slice(0, 80) + '…' : note.note);
      const stocks = note.symbols.length ? note.symbols.join(', ') + ' — ' : '';
      if (!confirm(`Delete this note?\n\n${stocks}${what}`)) return;
      pageError.value = null;
      try {
        await removeNote(note.id);
      } catch (e) {
        pageError.value = `Couldn't delete the note: ${e.message}`;
      }
    }

    async function deleteLabelConfirm(label) {
      const n = labelCounts.value.get(label.id) ?? 0;
      if (!confirm(`Delete the label "${label.name}"?` + (n ? ` It will be removed from ${n} note${n === 1 ? '' : 's'}.` : ''))) return;
      pageError.value = null;
      try {
        await removeLabel(label.id);
        labelFilter.value = labelFilter.value.filter(x => x !== label.id);
      } catch (e) {
        pageError.value = `Couldn't delete the label: ${e.message}`;
      }
    }

    return {
      notesStore, loadNotes, symbolFilter, labelFilter, query, editing, pageError,
      knownSymbols, creating, saveNew, linkHost,
      symbols, labelCounts, filtered, filtering, toggleLabel, clearFilters,
      saveEdit, deleteNoteConfirm, deleteLabelConfirm,
      safeArticleUrl, onArticleClick, formatDate, formatRelativeTime,
    };
  },
  template: `
    <div class="notes-page">
      <div class="flex-between mb-16 notes-head">
        <div class="section-header" style="margin-bottom:0" v-if="!embedded">Notes</div>
        <span v-else></span>
        <div class="notes-head-right">
          <span class="text-muted text-sm" v-if="notesStore.loaded && notesStore.notes.length">
            {{ filtering ? filtered.length + ' of ' : '' }}{{ notesStore.notes.length }} note{{ notesStore.notes.length === 1 ? '' : 's' }}
          </span>
          <button type="button" class="primary" v-if="notesStore.loaded && !creating" @click="creating = { busy: false, error: null }">＋ New note</button>
        </div>
      </div>

      <!-- New manual note -->
      <div class="card note-new" v-if="creating">
        <div class="card-title" style="margin-bottom:4px">New note</div>
        <NoteForm manual :labels="notesStore.labels" :known-symbols="knownSymbols" submit-label="Add note"
                  :busy="creating.busy" :error="creating.error"
                  @save="saveNew" @cancel="creating = null" />
      </div>

      <div class="notice error" v-if="notesStore.error">
        Couldn't load your notes: {{ notesStore.error }}
        <button type="button" class="link-button" @click="loadNotes">Retry</button>
      </div>
      <div class="notice error" v-if="pageError">{{ pageError }}</div>

      <template v-if="!notesStore.loaded && notesStore.loading">
        <div class="skeleton" style="height:80px;margin-bottom:8px" v-for="i in 3" :key="i"></div>
      </template>

      <div class="notice" v-else-if="notesStore.loaded && !notesStore.notes.length && !creating">
        No notes yet. Write one with <strong>＋ New note</strong>, or open a stock on Markets → Stocks, go to its
        <strong>News</strong> tab, and use <strong>Save to notes</strong> on an article to keep it here with labels and your note.
      </div>

      <template v-else-if="notesStore.loaded && notesStore.notes.length">
        <!-- Filters -->
        <div class="notes-filters">
          <select v-model="symbolFilter" aria-label="Filter by stock">
            <option value="">All stocks</option>
            <option v-for="s in symbols" :key="s" :value="s">{{ s }}</option>
          </select>
          <input type="search" v-model="query" placeholder="Search notes…" aria-label="Search notes" />
          <button type="button" class="link-button" v-if="filtering" @click="clearFilters">Clear filters</button>
        </div>
        <div class="note-chips notes-label-filter" v-if="notesStore.labels.length" role="group" aria-label="Filter by label">
          <span class="note-chip-group" v-for="l in notesStore.labels" :key="l.id">
            <button type="button" class="note-chip" :class="{ selected: labelFilter.includes(l.id) }"
                    :aria-pressed="labelFilter.includes(l.id)" @click="toggleLabel(l.id)">
              {{ l.name }} <span class="note-chip-count">{{ labelCounts.get(l.id) }}</span>
            </button>
            <button type="button" class="note-chip-remove" :aria-label="'Delete label ' + l.name"
                    :title="'Delete label ' + l.name" @click="deleteLabelConfirm(l)">✕</button>
          </span>
        </div>

        <div class="notice" v-if="!filtered.length">No notes match these filters.</div>

        <article class="card note-card" :class="{ manual: n.kind === 'manual' }" v-for="n in filtered" :key="n.id">
          <img v-if="n.image" class="stock-news-thumb" :src="n.image" alt="" loading="lazy"
               @error="$event.target.style.display = 'none'" />
          <div class="note-body">
            <div class="note-meta">
              <span class="note-symbol" v-for="sym in n.symbols" :key="sym">{{ sym }}</span>
              <span class="note-kind" v-if="n.kind === 'manual'">Note</span>
              <span class="text-muted text-sm" v-if="n.kind === 'news'">
                {{ n.source }}<template v-if="n.source && n.pubDate"> · </template><template v-if="n.pubDate">{{ formatDate(n.pubDate) }}</template>
              </span>
              <span class="text-muted text-sm note-saved-at" :title="'Saved ' + formatDate(n.createdAt)">
                {{ n.kind === 'manual' ? 'added' : 'saved' }} {{ formatRelativeTime(n.createdAt) }}
              </span>
            </div>
            <a v-if="n.kind === 'news'" class="stock-news-title" :href="safeArticleUrl(n.link)" target="_blank" rel="noopener"
               @click="onArticleClick($event, n, config)">{{ n.title }}</a>

            <NoteForm v-if="editing[n.id]" :manual="n.kind === 'manual'" :labels="notesStore.labels"
                      :initial-labels="n.labels.map(l => l.name)" :initial-note="n.note"
                      :initial-symbols="n.symbols" :initial-link="n.link" :known-symbols="knownSymbols"
                      submit-label="Save changes" :busy="editing[n.id].busy" :error="editing[n.id].error"
                      @save="saveEdit(n, $event)" @cancel="delete editing[n.id]" />
            <template v-else>
              <p class="note-text" :class="{ 'note-text-main': n.kind === 'manual' }" v-if="n.note">{{ n.note }}</p>
              <a v-if="n.kind === 'manual' && n.link" class="note-link" :href="safeArticleUrl(n.link)" target="_blank" rel="noopener"
                 :title="n.link" @click="onArticleClick($event, { title: linkHost(n.link), link: n.link, source: linkHost(n.link) }, config)">
                🔗 {{ linkHost(n.link) }}
              </a>
              <div class="note-labels" v-if="n.labels.length">
                <span class="note-label" v-for="l in n.labels" :key="l.id">{{ l.name }}</span>
              </div>
              <div class="note-actions">
                <button type="button" class="link-button" @click="editing[n.id] = { busy: false, error: null }">Edit</button>
                <button type="button" class="link-button danger-link" @click="deleteNoteConfirm(n)">Delete</button>
              </div>
            </template>
          </div>
        </article>
      </template>
    </div>
  `,
};
