const { ref, computed } = Vue;
import LabelDialog from './LabelDialog.js';
import { notesStore, loadNotes, addLabel, updateLabel, removeLabel } from '../utils/notesStore.js';
import { PRESET_COLORS, labelChipStyle } from '../utils/labelColors.js';

/**
 * Profile → Labels: the labels used to organize Inbox → Notes. New / Edit
 * open a dialog (name, description, color); edits carry to every note that
 * has the label; Delete removes it from those notes. Shares
 * utils/notesStore.js with the Notes page, so both stay in sync.
 */
export default {
  name: 'LabelsManager',
  components: { LabelDialog },
  setup() {
    const dialog = ref(null); // { label (null = new), busy, error }
    const rowError = ref(null); // { id, message }

    const usage = computed(() => {
      const counts = new Map();
      for (const n of notesStore.notes) for (const l of n.labels) counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
      return counts;
    });
    // A new label starts on the next palette color (same rotation as the server).
    const nextColor = computed(() => PRESET_COLORS[notesStore.labels.length % PRESET_COLORS.length]);

    function openDialog(label = null) {
      rowError.value = null;
      dialog.value = { label, busy: false, error: null };
    }

    async function save(fields) {
      const d = dialog.value;
      d.busy = true;
      d.error = null;
      try {
        if (d.label) await updateLabel(d.label.id, fields);
        else await addLabel(fields);
        dialog.value = null;
      } catch (e) {
        d.error = e.message;
        d.busy = false;
      }
    }

    async function remove(label) {
      const n = usage.value.get(label.id) ?? 0;
      if (!confirm(`Delete the label "${label.name}"?` + (n ? ` It will be removed from ${n} note${n === 1 ? '' : 's'}.` : ''))) return;
      try {
        await removeLabel(label.id);
      } catch (e) {
        rowError.value = { id: label.id, message: e.message };
      }
    }

    return { notesStore, loadNotes, dialog, rowError, usage, nextColor, openDialog, save, remove, labelChipStyle };
  },
  template: `
    <div class="card account-card">
      <div class="flex-between labels-head">
        <div class="card-title" style="margin-bottom:0">Labels</div>
        <button type="button" class="primary" :disabled="!notesStore.loaded" @click="openDialog()">＋ New label</button>
      </div>
      <p class="text-muted text-sm" style="margin:8px 0 4px">
        Labels organize your notes in <strong>Inbox → Notes</strong>. Edits apply to every note that has the label;
        deleting one removes it from those notes (the notes themselves stay).
      </p>

      <div class="notice error" v-if="notesStore.error" style="margin-top:12px">
        Couldn't load your labels: {{ notesStore.error }}
        <button type="button" class="link-button" @click="loadNotes">Retry</button>
      </div>
      <div class="skeleton" style="height:120px;margin-top:12px" v-else-if="!notesStore.loaded"></div>
      <p class="text-muted text-sm" style="margin:14px 0 0" v-else-if="!notesStore.labels.length">
        No labels yet — create one with <strong>＋ New label</strong>, or while saving a note.
      </p>
      <ul class="labels-list" v-else>
        <li v-for="l in notesStore.labels" :key="l.id">
          <span class="note-label labels-name" :style="labelChipStyle(l)">{{ l.name }}</span>
          <span class="labels-info">
            <span class="labels-description" v-if="l.description">{{ l.description }}</span>
            <span class="text-muted text-sm">
              {{ usage.get(l.id) ? usage.get(l.id) + ' note' + (usage.get(l.id) === 1 ? '' : 's') : 'unused' }}
            </span>
          </span>
          <span class="labels-actions">
            <button type="button" class="link-button" @click="openDialog(l)">Edit</button>
            <button type="button" class="link-button danger-link" @click="remove(l)">Delete</button>
          </span>
          <div class="notice error labels-row-error" v-if="rowError?.id === l.id">{{ rowError.message }}</div>
        </li>
      </ul>

      <LabelDialog v-if="dialog" :label="dialog.label" :default-color="nextColor"
                   :busy="dialog.busy" :error="dialog.error" @save="save" @cancel="dialog = null" />
    </div>
  `,
};
