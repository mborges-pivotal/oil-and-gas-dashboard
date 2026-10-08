const { ref, reactive, onMounted } = Vue;
import { fetchBankAccounts, createBankAccount, updateBankAccount, deleteBankAccount, BANK_TYPES } from '../services/bankAccounts.js';

/**
 * Profile → Bank accounts: external accounts that deposits into the
 * account's cash come from (Account → Summary → Deposit). Bank, account
 * number (only the last 4 digits are kept), type and status. Nothing is
 * verified with the bank yet — "connected" is your own setting, and only
 * connected accounts can be picked for a deposit.
 */
export default {
  name: 'BankAccounts',
  setup() {
    const accounts = ref([]);
    const loaded = ref(false);
    const loadError = ref(null);
    const form = ref(null); // { id (null = new), bank, accountNumber, type, status, busy, error }
    const rowError = reactive({});

    async function load() {
      loadError.value = null;
      try {
        accounts.value = await fetchBankAccounts();
        loaded.value = true;
      } catch (e) {
        loadError.value = e.message;
      }
    }
    onMounted(load);

    function openForm(a = null) {
      form.value = a
        ? { id: a.id, bank: a.bank, accountNumber: '', last4: a.last4, type: a.type, status: a.status, busy: false, error: null }
        : { id: null, bank: '', accountNumber: '', type: 'checking', status: 'connected', busy: false, error: null };
    }
    async function save() {
      const f = form.value;
      if (!f.bank.trim()) { f.error = 'Enter the bank name.'; return; }
      if (!f.id && !/^\d{4,17}$/.test(f.accountNumber.replace(/[\s-]/g, ''))) { f.error = 'Enter the account number (4 to 17 digits).'; return; }
      f.busy = true;
      f.error = null;
      try {
        if (f.id) {
          const updated = await updateBankAccount(f.id, { bank: f.bank, type: f.type, status: f.status });
          accounts.value = accounts.value.map(a => (a.id === f.id ? updated : a));
        } else {
          accounts.value = [...accounts.value, await createBankAccount({ bank: f.bank, accountNumber: f.accountNumber, type: f.type, status: f.status })];
        }
        form.value = null;
      } catch (e) {
        f.error = e.message;
        f.busy = false;
      }
    }
    async function toggleStatus(a) {
      delete rowError[a.id];
      try {
        const updated = await updateBankAccount(a.id, { status: a.status === 'connected' ? 'disconnected' : 'connected' });
        accounts.value = accounts.value.map(x => (x.id === a.id ? updated : x));
      } catch (e) {
        rowError[a.id] = e.message;
      }
    }
    async function remove(a) {
      if (!confirm(`Remove ${a.bank} ••${a.last4}?\n\nPast deposits from it stay in your account's history.`)) return;
      delete rowError[a.id];
      try {
        await deleteBankAccount(a.id);
        accounts.value = accounts.value.filter(x => x.id !== a.id);
      } catch (e) {
        rowError[a.id] = e.message;
      }
    }
    const typeLabel = t => BANK_TYPES.find(x => x.id === t)?.label ?? t;

    return { accounts, loaded, loadError, load, form, openForm, save, toggleStatus, remove, rowError, BANK_TYPES, typeLabel };
  },
  template: `
    <div class="card account-card">
      <div class="flex-between labels-head">
        <div class="card-title" style="margin-bottom:0">Bank accounts</div>
        <button type="button" class="primary" v-if="!form" :disabled="!loaded" @click="openForm()">＋ Add bank account</button>
      </div>
      <p class="text-muted text-sm" style="margin:8px 0 4px">
        External accounts you deposit into your account's cash from (<strong>Account → Summary → Deposit</strong>).
        Only the last 4 digits of the account number are stored. Accounts aren't verified with the bank yet.
      </p>

      <form class="bank-form" v-if="form" @submit.prevent="save" novalidate @input="form.error = null">
        <div class="portfolio-fields">
          <label>
            <span>Bank</span>
            <input v-model="form.bank" maxlength="60" placeholder="e.g. Chase" autocomplete="off" />
          </label>
          <label v-if="!form.id">
            <span>Account number</span>
            <input v-model="form.accountNumber" inputmode="numeric" maxlength="22" placeholder="e.g. 000123456789" autocomplete="off" />
          </label>
          <label v-else>
            <span>Account number</span>
            <input :value="'••••' + form.last4" disabled />
          </label>
          <label>
            <span>Type</span>
            <select v-model="form.type">
              <option v-for="t in BANK_TYPES" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
          </label>
          <label>
            <span>Status</span>
            <select v-model="form.status">
              <option value="connected">Connected</option>
              <option value="disconnected">Not connected</option>
            </select>
          </label>
        </div>
        <div class="notice error" v-if="form.error" style="margin:10px 0 0">{{ form.error }}</div>
        <div class="portfolio-actions">
          <button type="submit" class="primary" :disabled="form.busy">{{ form.busy ? 'Saving…' : (form.id ? 'Save changes' : 'Add account') }}</button>
          <button type="button" @click="form = null">Cancel</button>
        </div>
      </form>

      <div class="notice error" v-if="loadError" style="margin-top:12px">
        Couldn't load your bank accounts: {{ loadError }} <button type="button" class="link-button" @click="load">Retry</button>
      </div>
      <div class="skeleton" style="height:80px;margin-top:12px" v-else-if="!loaded"></div>
      <p class="text-muted text-sm" style="margin:14px 0 0" v-else-if="!accounts.length && !form">
        No bank accounts yet — add one to make deposits.
      </p>
      <ul class="bank-list" v-else>
        <li v-for="a in accounts" :key="a.id" class="bank-item">
          <span class="bank-icon" aria-hidden="true">🏦</span>
          <span class="bank-info">
            <span class="bank-name">{{ a.bank }} <span class="text-muted">••{{ a.last4 }}</span></span>
            <span class="text-muted text-sm">{{ typeLabel(a.type) }}</span>
          </span>
          <span class="bank-status" :class="a.status">{{ a.status === 'connected' ? 'Connected' : 'Not connected' }}</span>
          <span class="bank-actions">
            <button type="button" class="link-button" @click="toggleStatus(a)">{{ a.status === 'connected' ? 'Disconnect' : 'Connect' }}</button>
            <button type="button" class="link-button" @click="openForm(a)">Edit</button>
            <button type="button" class="link-button danger-link" @click="remove(a)">Remove</button>
          </span>
          <div class="notice error bank-row-error" v-if="rowError[a.id]">{{ rowError[a.id] }}</div>
        </li>
      </ul>
    </div>
  `,
};
