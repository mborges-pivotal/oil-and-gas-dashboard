/**
 * Shared, reactive copy of the signed-in user's notes and labels — used by
 * the stock News tab (save / "Saved" state) and the Notes page, so both see
 * the same data without refetching. app.js loads it on sign-in and clears
 * it on sign-out.
 */
import * as api from '../services/notes.js';

const { reactive } = Vue;

export const notesStore = reactive({
  notes: [],        // newest first
  labels: [],       // [{ id, name }], alphabetical
  loaded: false,
  loading: false,
  error: null,
});

export async function loadNotes() {
  notesStore.loading = true;
  notesStore.error = null;
  try {
    const { notes, labels } = await api.fetchNotes();
    notesStore.notes = notes;
    notesStore.labels = labels;
    notesStore.loaded = true;
  } catch (e) {
    notesStore.error = e.message;
  } finally {
    notesStore.loading = false;
  }
}

export function clearNotes() {
  Object.assign(notesStore, { notes: [], labels: [], loaded: false, loading: false, error: null });
}

/** The news note saved for this article under this stock, if any. */
export function findNote(symbol, link) {
  return notesStore.notes.find(n => n.kind === 'news' && n.link === link && n.symbols.includes(symbol)) ?? null;
}

export async function addNote(article, note, labels) {
  const res = await api.createNote(article, note, labels);
  notesStore.notes.unshift(res.note);
  notesStore.labels = res.labels;
  return res.note;
}

export async function addManualNote(fields) {
  const res = await api.createManualNote(fields);
  notesStore.notes.unshift(res.note);
  notesStore.labels = res.labels;
  return res.note;
}

export async function editNote(id, fields) {
  const res = await api.updateNote(id, fields);
  const i = notesStore.notes.findIndex(n => n.id === id);
  if (i !== -1) notesStore.notes[i] = res.note;
  notesStore.labels = res.labels;
  return res.note;
}

export async function removeNote(id) {
  await api.deleteNote(id);
  notesStore.notes = notesStore.notes.filter(n => n.id !== id);
}

/** fields: { name, description?, color? } */
export async function addLabel(fields) {
  const res = await api.createLabel(fields);
  notesStore.labels = res.labels;
  return res.label;
}

/** Update a label's name / description / color — carried to every note that has it. */
export async function updateLabel(id, fields) {
  const res = await api.updateLabel(id, fields);
  notesStore.labels = res.labels;
  const updated = res.labels.find(l => l.id === id);
  for (const n of notesStore.notes) {
    for (const l of n.labels) if (l.id === id) Object.assign(l, { name: updated.name, color: updated.color });
  }
}

export async function removeLabel(id) {
  await api.deleteLabel(id);
  notesStore.labels = notesStore.labels.filter(l => l.id !== id);
  for (const n of notesStore.notes) n.labels = n.labels.filter(l => l.id !== id);
}
