const { ref, reactive, computed, watch } = Vue;
import NoteForm from './NoteForm.js';
import { notesStore, loadNotes, addManualNote, editNote, removeNote } from '../utils/notesStore.js';
import { safeArticleUrl, onArticleClick } from '../utils/articleViewer.js';
import { formatDate, formatRelativeTime } from '../utils/formatters.js';
import { labelChipStyle } from '../utils/labelColors.js';
import { portfolioList } from '../utils/portfolios.js';

/**
 * Notes tab (signed in): news articles saved from a stock's News tab (each
 * under its stock) and manual notes written here (any stocks, optional
 * link), all with labels. Filter by stock, label (any selected) and text;
 * add and edit notes, or archive them — archived notes sit in a collapsible
 * group under the active ones, where they can be restored or deleted.
 * Labels are managed in Profile → Labels.
 */
// One note's card — used for the active list and the Archived group (expects `n`, from `list`).
const NOTE_CARD = `
        <article class="card note-card" :class="{ manual: n.kind === 'manual', archived: !!n.archivedAt }" v-for="n in list" :key="n.id">
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
                <span class="note-label" v-for="l in n.labels" :key="l.id" :style="labelChipStyle(l)">{{ l.name }}</span>
              </div>
              <div class="note-actions" v-if="n.archivedAt">
                <span class="text-muted text-sm" :title="'Archived ' + formatDate(n.archivedAt)">archived {{ formatRelativeTime(n.archivedAt) }}</span>
                <button type="button" class="link-button" @click="setArchived(n, false)">Restore</button>
                <button type="button" class="link-button danger-link" @click="deleteNoteConfirm(n)">Delete</button>
              </div>
              <div class="note-actions" v-else>
                <button type="button" class="link-button" @click="editing[n.id] = { busy: false, error: null }">Edit</button>
                <button type="button" class="link-button" @click="setArchived(n, true)">Archive</button>
              </div>
            </template>
          </div>
        </article>
`;

export default {
  name: 'Notes',
  components: { NoteForm },
  // embedded: shown as the Inbox's Notes sub-tab — the page title comes from Inbox.
  props: { config: Object, embedded: Boolean },
  emits: ['manage-labels'],
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
      ...portfolioList(props.config).flatMap(p => Object.keys(p.portfolio ?? {})),
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
    const activeNotes = computed(() => filtered.value.filter(n => !n.archivedAt));
    // Most recently archived first.
    const archivedNotes = computed(() => filtered.value.filter(n => n.archivedAt)
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)));
    const activeTotal = computed(() => notesStore.notes.filter(n => !n.archivedAt).length);
    const archivedTotal = computed(() => notesStore.notes.length - activeTotal.value);

    // Archived group open? (remembered per browser; starts collapsed)
    const ARCHIVE_KEY = 'oilgas_notes_archived_open';
    const archivedOpen = ref((() => {
      try { return localStorage.getItem(ARCHIVE_KEY) === '1'; } catch { return false; }
    })());
    watch(archivedOpen, open => { try { localStorage.setItem(ARCHIVE_KEY, open ? '1' : '0'); } catch { /* per-browser only */ } });

    async function setArchived(note, archived) {
      pageError.value = null;
      delete editing[note.id];
      try {
        await editNote(note.id, { archived });
      } catch (e) {
        pageError.value = `Couldn't ${archived ? 'archive' : 'restore'} the note: ${e.message}`;
      }
    }

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
      if (!confirm(`Delete this archived note for good?\n\n${stocks}${what}`)) return;
      pageError.value = null;
      try {
        await removeNote(note.id);
      } catch (e) {
        pageError.value = `Couldn't delete the note: ${e.message}`;
      }
    }

    return {
      notesStore, loadNotes, symbolFilter, labelFilter, query, editing, pageError,
      knownSymbols, creating, saveNew, linkHost,
      symbols, labelCounts, filtered, filtering, toggleLabel, clearFilters,
      saveEdit, deleteNoteConfirm, activeNotes, archivedNotes, activeTotal, archivedTotal, archivedOpen, setArchived,
      safeArticleUrl, onArticleClick, formatDate, formatRelativeTime, labelChipStyle,
    };
  },
  template: `
    <div class="notes-page">
      <div class="flex-between mb-16 notes-head">
        <div class="section-header" style="margin-bottom:0" v-if="!embedded">Notes</div>
        <span v-else></span>
        <div class="notes-head-right">
          <span class="text-muted text-sm" v-if="notesStore.loaded && notesStore.notes.length">
            {{ filtering ? activeNotes.length + ' of ' : '' }}{{ activeTotal }} note{{ activeTotal === 1 ? '' : 's' }}<template v-if="archivedTotal"> · {{ archivedTotal }} archived</template>
          </span>
          <button type="button" class="link-button" v-if="notesStore.loaded" @click="$emit('manage-labels')">Manage labels</button>
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
          <button v-for="l in notesStore.labels" :key="l.id" type="button" class="note-chip" :class="{ selected: labelFilter.includes(l.id) }"
                  :aria-pressed="labelFilter.includes(l.id)" :title="l.description || null" @click="toggleLabel(l.id)">
            <span class="label-dot" :style="{ background: l.color }" aria-hidden="true"></span>{{ l.name }} <span class="note-chip-count">{{ labelCounts.get(l.id) }}</span>
          </button>
        </div>

        <div class="notice" v-if="!filtered.length">No notes match these filters.</div>

        <div class="notice" v-if="!activeNotes.length && filtered.length">No active notes{{ filtering ? ' match these filters' : '' }} — see Archived below.</div>
        <template v-for="list in [activeNotes]" :key="'active'">${NOTE_CARD}</template>

        <!-- Archived: collapsible, under the active notes; restore or delete -->
        <section class="notes-archived" v-if="archivedTotal">
          <button type="button" class="notes-archived-toggle" :aria-expanded="archivedOpen" aria-controls="notes-archived-list"
                  @click="archivedOpen = !archivedOpen">
            <span class="holdings-chevron" aria-hidden="true">▶</span>
            Archived <span class="holdings-count">{{ filtering ? archivedNotes.length + ' of ' + archivedTotal : archivedTotal }}</span>
          </button>
          <div id="notes-archived-list" v-show="archivedOpen">
            <p class="text-muted text-sm" v-if="!archivedNotes.length" style="margin:8px 0 0">No archived notes match these filters.</p>
            <template v-for="list in [archivedNotes]" :key="'archived'">${NOTE_CARD}</template>
          </div>
        </section>
      </template>
    </div>
  `,
};
