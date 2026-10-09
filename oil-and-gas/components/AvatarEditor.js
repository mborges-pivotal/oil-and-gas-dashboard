const { ref, computed, onUnmounted, nextTick } = Vue;
import Avatar from './Avatar.js';
import { updateAvatar, removeAvatarPhoto } from '../services/auth.js';
import { AVATAR_EMOJIS, AVATAR_COLORS, randomPreset, squareDataUrl, fileToDataUrl } from '../utils/avatars.js';

/**
 * Profile → Profile: your avatar. Pick a preset (an emoji and a color, or a
 * random one), upload a picture, or take one with the camera — the camera
 * view needs a secure page (https or localhost); elsewhere "Take photo" opens
 * the phone's camera app through the file picker instead. Pictures are
 * cropped square and shrunk before they're sent. Emits updated(user).
 */
export default {
  name: 'AvatarEditor',
  components: { Avatar },
  props: { user: Object },
  emits: ['updated'],
  setup(props, { emit }) {
    const picking = ref(false);
    const draft = ref(null); // preset being chosen
    const busy = ref(false);
    const error = ref(null);
    const fileInput = ref(null);
    const captureInput = ref(null);
    const camera = ref(null); // { stream } while the camera view is open
    const video = ref(null);
    const hasPhoto = computed(() => !!props.user?.avatar?.image);
    const canStream = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

    async function save(fields) {
      busy.value = true;
      error.value = null;
      try {
        emit('updated', await updateAvatar(fields));
        return true;
      } catch (e) {
        error.value = e.message;
        return false;
      } finally {
        busy.value = false;
      }
    }

    function openPicker() {
      picking.value = true;
      draft.value = { ...(props.user?.avatar?.preset ?? randomPreset()) };
    }
    function shuffle() { draft.value = randomPreset(); }
    async function savePreset() {
      if (await save({ preset: draft.value })) picking.value = false;
    }

    async function onFile(e) {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try { await save({ image: await fileToDataUrl(file) }); } catch (err) { error.value = err.message; }
    }

    async function openCamera() {
      error.value = null;
      if (!canStream) { captureInput.value?.click(); return; } // phone camera app via the file picker
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false });
        camera.value = { stream };
        await nextTick();
        if (video.value) { video.value.srcObject = stream; await video.value.play().catch(() => {}); }
      } catch (e) {
        error.value = e.name === 'NotAllowedError' ? 'Camera access was blocked — allow it in the browser, or upload a photo instead.' : `Couldn't open the camera: ${e.message}`;
      }
    }
    function closeCamera() {
      camera.value?.stream.getTracks().forEach(t => t.stop());
      camera.value = null;
    }
    async function snap() {
      const v = video.value;
      if (!v?.videoWidth) return;
      try {
        // Mirror the selfie the way the preview shows it.
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        const ctx = c.getContext('2d');
        ctx.translate(c.width, 0); ctx.scale(-1, 1);
        ctx.drawImage(v, 0, 0);
        const url = squareDataUrl(c, c.width, c.height);
        if (await save({ image: url })) closeCamera();
      } catch (e) {
        error.value = e.message;
      }
    }
    async function removePhoto() {
      if (!confirm('Remove your photo? Your avatar goes back to its emoji.')) return;
      busy.value = true;
      error.value = null;
      try { emit('updated', await removeAvatarPhoto()); } catch (e) { error.value = e.message; } finally { busy.value = false; }
    }
    onUnmounted(closeCamera);

    return {
      AVATAR_EMOJIS, AVATAR_COLORS, picking, draft, busy, error, fileInput, captureInput, camera, video, hasPhoto,
      openPicker, shuffle, savePreset, onFile, openCamera, closeCamera, snap, removePhoto,
    };
  },
  template: `
    <div class="card account-card avatar-editor mb-16">
      <div class="card-title">Avatar</div>
      <div class="avatar-editor-row">
        <Avatar :avatar="user.avatar" :name="user.displayName || user.email" :size="72" />
        <div class="avatar-editor-actions">
          <button type="button" @click="openPicker" :disabled="busy">Choose avatar</button>
          <button type="button" @click="fileInput.click()" :disabled="busy">Upload photo</button>
          <button type="button" @click="openCamera" :disabled="busy">Take photo</button>
          <button type="button" class="link-button danger-link" v-if="hasPhoto" @click="removePhoto" :disabled="busy">Remove photo</button>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden @change="onFile" />
          <input ref="captureInput" type="file" accept="image/*" capture="user" hidden @change="onFile" />
        </div>
      </div>
      <p class="text-muted text-sm" style="margin:8px 0 0">
        Shown in the top bar and on the Leaderboard. Photos are cropped square and shrunk before they're saved.
        <template v-if="hasPhoto"> Your photo is shown instead of the emoji while it's set.</template>
      </p>

      <!-- Preset picker -->
      <div class="avatar-picker" v-if="picking">
        <div class="avatar-picker-preview">
          <Avatar :avatar="{ preset: draft }" :size="56" />
          <button type="button" class="link-button" @click="shuffle">🎲 Random</button>
        </div>
        <div class="avatar-emoji-grid" role="radiogroup" aria-label="Emoji">
          <button v-for="e in AVATAR_EMOJIS" :key="e" type="button" role="radio" class="avatar-emoji" :class="{ selected: draft.emoji === e }"
                  :aria-checked="draft.emoji === e" @click="draft = { ...draft, emoji: e }">{{ e }}</button>
        </div>
        <div class="avatar-colors" role="radiogroup" aria-label="Color">
          <button v-for="c in AVATAR_COLORS" :key="c" type="button" role="radio" class="avatar-color" :class="{ selected: draft.color === c }"
                  :aria-checked="draft.color === c" :aria-label="'Color ' + c" :style="{ background: 'var(--series-' + c + ')' }" @click="draft = { ...draft, color: c }"></button>
        </div>
        <div class="portfolio-actions">
          <button type="button" class="primary" @click="savePreset" :disabled="busy">{{ busy ? 'Saving…' : (hasPhoto ? 'Use this avatar (removes the photo)' : 'Save avatar') }}</button>
          <button type="button" @click="picking = false">Cancel</button>
        </div>
      </div>

      <!-- Camera -->
      <div class="modal-backdrop" v-if="camera" @click.self="closeCamera" @keydown.esc="closeCamera">
        <div class="modal avatar-camera" role="dialog" aria-modal="true" aria-label="Take a photo">
          <div class="modal-head">
            <h2>Take a photo</h2>
            <button type="button" class="modal-close" aria-label="Close" @click="closeCamera">✕</button>
          </div>
          <div class="modal-body">
            <div class="avatar-camera-frame"><video ref="video" playsinline muted></video></div>
            <p class="text-muted text-sm" style="margin:8px 0 0;text-align:center">The circle shows what your avatar will look like.</p>
          </div>
          <div class="modal-foot">
            <button type="button" @click="closeCamera">Cancel</button>
            <button type="button" class="primary" @click="snap" :disabled="busy">{{ busy ? 'Saving…' : '📸 Take photo' }}</button>
          </div>
        </div>
      </div>

      <div class="notice error" v-if="error" style="margin:10px 0 0">{{ error }}</div>
    </div>
  `,
};
