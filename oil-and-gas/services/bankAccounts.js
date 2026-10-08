/** Client for /api/bank-accounts (server/bankAccounts.js). */
import { request } from './auth.js';

export async function fetchBankAccounts() {
  return (await request('GET', '/api/bank-accounts')).bankAccounts;
}
/** { bank, accountNumber, type, status } → bankAccount (only the last 4 digits are kept) */
export async function createBankAccount(fields) {
  return (await request('POST', '/api/bank-accounts', fields)).bankAccount;
}
export async function updateBankAccount(id, fields) {
  return (await request('PUT', `/api/bank-accounts/${encodeURIComponent(id)}`, fields)).bankAccount;
}
export async function deleteBankAccount(id) {
  await request('DELETE', `/api/bank-accounts/${encodeURIComponent(id)}`);
}

export const BANK_TYPES = [
  { id: 'checking', label: 'Checking' },
  { id: 'savings', label: 'Savings' },
  { id: 'investments', label: 'Investments' },
];
export const bankLabel = a => `${a.bank} ${BANK_TYPES.find(t => t.id === a.type)?.label.toLowerCase() ?? a.type} ••${a.last4}`;
