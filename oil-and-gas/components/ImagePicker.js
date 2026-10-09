const { ref, computed, onUnmounted, nextTick } = Vue;
import { squareDataUrl, fileToDataUrl } from '../utils/avatars.js';

/**
 * Pick a square picture: from the photo library (phones) or a file (desktop),
 * or with the camera. On phones (a touch screen) the buttons read "Choose
 * from library" and "Take photo" (the rear camera); on desktop "Upload image"
 * and "Take photo" (the webcam). A live camera view needs a secure page
 * (https or localhost); elsewhere "Take photo" opens the phone's camera app.
 * Pictures are cropped square and shrunk before `picked(dataUrl)` is emitted.
 */
export default {
  name: 'ImagePicker',
  props: {
    busy: Boolean,
    hasImage: Boolean,
    facing: { type: String, default: 'environment' }, // camera: 'environment' (rear) or 'user'
    removeLabel: { type: String, default: 'Remove image' },
  },
  emits: ['picked', 'remove'],
  setup(props, { emit }) {
    const fileInput = ref(null);
    const captureInput = ref(null);
    const camera = ref(null);
    const video = ref(null);
    const error = ref(null);
    const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    const canStream = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
    const mirror = computed(() => props.facing === 'user');

    async function onFile(e) {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      error.value = null;
      try { emit('picked', await fileToDataUrl(file)); } catch (err) { error.value = err.message; }
    }
    async function openCamera() {
      error.value = null;
      if (!canStream) { captureInput.value?.click(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: props.facing, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
        camera.value = { stream };
        await nextTick();
        if (video.value) { video.value.srcObject = stream; await video.value.play().catch(() => {}); }
      } catch (e) {
        error.value = e.name === 'NotAllowedError' ? 'Camera access was blocked — allow it in the browser, or pick a picture instead.' : `Couldn't open the camera: ${e.message}`;
      }
    }
    function closeCamera() {
      camera.value?.stream.getTracks().forEach(t => t.stop());
      camera.value = null;
    }
    function snap() {
      const v = video.value;
      if (!v?.videoWidth) return;
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        const ctx = c.getContext('2d');
        if (mirror.value) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(v, 0, 0);
        emit('picked', squareDataUrl(c, c.width, c.height));
        closeCamera();
      } catch (e) {
        error.value = e.message;
      }
    }
    onUnmounted(closeCamera);
    return { fileInput, captureInput, camera, video, error, touch, mirror, onFile, openCamera, closeCamera, snap };
  },
  template: `
    <div class="image-picker">
      <div class="image-picker-actions">
        <button type="button" :disabled="busy" @click="fileInput.click()">{{ touch ? 'Choose from library' : 'Upload image' }}</button>
        <button type="button" :disabled="busy" @click="openCamera">Take photo</button>
        <button type="button" class="link-button danger-link" v-if="hasImage" :disabled="busy" @click="$emit('remove')">{{ removeLabel }}</button>
        <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
        <input ref="captureInput" type="file" accept="image/*" :capture="facing" hidden @change="onFile" />
      </div>
      <div class="notice error" v-if="error" style="margin:8px 0 0">{{ error }}</div>

      <div class="modal-backdrop" v-if="camera" @click.self="closeCamera" @keydown.esc="closeCamera">
        <div class="modal avatar-camera" role="dialog" aria-modal="true" aria-label="Take a photo">
          <div class="modal-head">
            <h2>Take a photo</h2>
            <button type="button" class="modal-close" aria-label="Close" @click="closeCamera">✕</button>
          </div>
          <div class="modal-body">
            <div class="avatar-camera-frame square"><video ref="video" playsinline muted :class="{ mirror }"></video></div>
            <p class="text-muted text-sm" style="margin:8px 0 0;text-align:center">The square is what's kept.</p>
          </div>
          <div class="modal-foot">
            <button type="button" @click="closeCamera">Cancel</button>
            <button type="button" class="primary" @click="snap">📸 Take photo</button>
          </div>
        </div>
      </div>
    </div>
  `,
};
