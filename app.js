/*
  Frontend-only expense tracker.

  Expected Supabase tables:

  expenses
  - id uuid primary key default gen_random_uuid()
  - user_id uuid references auth.users(id)
  - family_id uuid null
  - scope text check (scope in ('personal','family','business'))
  - amount numeric not null
  - description text not null
  - expense_date date not null
  - paid_by uuid/text null
  - units numeric null
  - unit_price numeric null
  - created_at timestamptz default now()

  family_members
  - family_id uuid
  - user_id uuid

  RLS should restrict personal/business rows to their owner and family rows to family members.
*/

const { createClient } = window.supabase;
const config = window.APP_CONFIG || {};
const hasSupabaseConfig = Boolean(
  config.SUPABASE_URL &&
  config.SUPABASE_ANON_KEY &&
  !config.SUPABASE_URL.includes('YOUR-PROJECT') &&
  !config.SUPABASE_ANON_KEY.includes('YOUR_PUBLIC')
);
const sb = hasSupabaseConfig ? createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY) : null;

const state = {
  scope: 'personal',
  user: null,
  familyId: config.DEFAULT_FAMILY_ID || null,
  expenses: [],
  editingId: null,
  selectedMonth: getMonthKey(new Date()),
  demoMode: !hasSupabaseConfig,
  months: new Set(),
  businessSearch: '',
};

const $ = (id) => document.getElementById(id);
const fmtINR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const fmtINR0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

$('expenseDate').value = isoDate(new Date());
$('todayLine').textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(new Date());

function isoDate(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getMonthKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
}

function safeDateLabel(dateString) {
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${dateString}T00:00:00`));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function currentScopeExpenses() {
  return state.expenses.filter((e) => e.scope === state.scope);
}

function showStatus(message, kind = '') {
  const el = $('formStatus');
  el.textContent = message;
  el.className = `status-line ${kind}`.trim();
}

function suggestionStorageKey(scope = state.scope) {
  return `expense-suggestions:${scope}`;
}

function readLocalSuggestions(scope = state.scope) {
  try {
    const raw = JSON.parse(localStorage.getItem(suggestionStorageKey(scope)) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveLocalSuggestion(expense) {
  const description = String(expense.description || '').trim();
  if (!description) return;

  const current = readLocalSuggestions();
  const normalized = description.toLowerCase();
  const next = current.filter((item) => String(item.description || '').toLowerCase() !== normalized);

  next.unshift({
    description,
    amount: Number(expense.amount) || 0,
    units: Number(expense.units) || 1,
    unit_price: Number(expense.unit_price) || 0,
    usedAt: Date.now(),
  });

  localStorage.setItem(suggestionStorageKey(), JSON.stringify(next.slice(0, 16)));
  renderSuggestions();
}

function renderSuggestions() {
  const allItems = readLocalSuggestions();
  const searchValue = $('description').value.trim().toLowerCase();
  const items = (state.scope === 'business' && searchValue
    ? allItems.filter((item) => String(item.description).toLowerCase().includes(searchValue))
    : allItems
  ).slice(0, 6);

  $('suggestions').innerHTML = items.length
    ? items.map((item, index) => {
        const detail = state.scope === 'business'
          ? `${Number(item.units || 1)} × ${fmtINR0.format(Number(item.unit_price) || 0)}`
          : fmtINR0.format(Number(item.amount) || 0);
        return `<button class="suggestion-chip" type="button" data-suggestion="${index}">${escapeHtml(item.description)} · ${detail}</button>`;
      }).join('')
    : '';

  $('suggestions').querySelectorAll('[data-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = items[Number(button.dataset.suggestion)];
      if (!item) return;
      applySuggestion(item);
    });
  });
}

function renderBusinessDescriptionOptions() {
  const descriptions = readLocalSuggestions('business').slice(0, 16);
  $('businessDescriptionOptions').innerHTML = descriptions
    .map((item) => `<option value="${escapeHtml(item.description)}"></option>`)
    .join('');
}

function findBusinessSuggestion(description) {
  const normalized = description.trim().toLowerCase();
  if (!normalized) return null;
  return readLocalSuggestions('business').find((item) => String(item.description || '').trim().toLowerCase() === normalized) || null;
}

function applySuggestion(item) {
  $('description').value = item.description || '';
  if (state.scope === 'business') {
    $('units').value = Number(item.units || 1);
    $('unitPrice').value = Number(item.unit_price || 0);
    calculateBusinessTotal();
    $('units').focus();
  } else {
    $('amount').value = item.amount || '';
    $('amount').focus();
  }
  renderSuggestions();
}

function loadDemoExpenses() {
  const key = 'family-expense-tracker:demo-expenses';
  let data = JSON.parse(localStorage.getItem(key) || 'null');
  if (!data) {
    const today = isoDate(new Date());
    data = [
      { id: crypto.randomUUID(), user_id: 'demo', family_id: 'demo-family', scope: 'personal', amount: 80, description: 'Auto / metro', expense_date: today, paid_by: 'me', created_at: new Date().toISOString() },
      { id: crypto.randomUUID(), user_id: 'demo', family_id: 'demo-family', scope: 'family', amount: 1250, description: 'Groceries', expense_date: today, paid_by: 'me', created_at: new Date().toISOString() },
      { id: crypto.randomUUID(), user_id: 'demo', family_id: 'demo-family', scope: 'family', amount: 1480, description: 'Electricity bill', expense_date: new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10), paid_by: 'family', created_at: new Date().toISOString() },
      { id: crypto.randomUUID(), user_id: 'demo', family_id: null, scope: 'business', amount: 3600, units: 12, unit_price: 300, description: 'Courier boxes', expense_date: today, paid_by: null, created_at: new Date().toISOString() },
      { id: crypto.randomUUID(), user_id: 'demo', family_id: null, scope: 'business', amount: 975, units: 3, unit_price: 325, description: 'Printer ink', expense_date: new Date(Date.now() - 86400000 * 1).toISOString().slice(0, 10), paid_by: null, created_at: new Date().toISOString() }
    ];
    localStorage.setItem(key, JSON.stringify(data));
  }
  return data;
}

function persistDemoExpenses() {
  localStorage.setItem('family-expense-tracker:demo-expenses', JSON.stringify(state.expenses));
}

async function initAuth() {
  if (!sb) {
    $('signInBtn').textContent = 'Demo mode';
    $('loginNotice').classList.remove('hidden');
    $('formStatus').textContent = 'Demo mode: connect Supabase in config.js to sync across devices.';
    return;
  }
  const { data } = await sb.auth.getSession();
  state.user = data.session?.user || null;
  updateAuthUi();
  sb.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user || null;
    updateAuthUi();
    refreshExpenses();
  });
}

function updateAuthUi() {
  if (state.user) {
    const name = state.user.user_metadata?.full_name || state.user.email?.split('@')[0] || 'You';
    const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
    $('accountBtn').textContent = initials;
    $('accountBtn').classList.remove('hidden');
    $('signInBtn').classList.add('hidden');
    $('signOutBtn').classList.remove('hidden');
    $('loginNotice').classList.add('hidden');
    $('accountName').textContent = name;
    $('accountEmail').textContent = state.user.email || '';
  } else if (state.demoMode) {
    $('accountBtn').classList.add('hidden');
    $('signInBtn').textContent = 'Demo mode';
    $('signInBtn').classList.remove('hidden');
    $('signOutBtn').classList.add('hidden');
    $('loginNotice').classList.remove('hidden');
  } else {
    $('accountBtn').classList.add('hidden');
    $('signInBtn').textContent = 'Continue with Google';
    $('signInBtn').classList.remove('hidden');
    $('signOutBtn').classList.add('hidden');
    $('loginNotice').classList.remove('hidden');
  }
}

async function signIn() {
  if (!sb) return showStatus('Add your public Supabase config to config.js first.');
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) showStatus(error.message, 'error');
}

async function signOut() {
  if (!sb) return;
  await sb.auth.signOut();
  $('accountDialog').close();
}

async function discoverFamilyId() {
  if (state.familyId || !state.user || !sb) return state.familyId;
  const { data, error } = await sb.from('family_members').select('family_id').eq('user_id', state.user.id).limit(1).maybeSingle();
  if (!error) state.familyId = data?.family_id || null;
  return state.familyId;
}

async function refreshExpenses() {
  if (state.demoMode) {
    state.expenses = loadDemoExpenses();
    rebuildMonths();
    renderAll();
    return;
  }
  if (!state.user) {
    state.expenses = [];
    rebuildMonths();
    renderAll();
    return;
  }

  await discoverFamilyId();

  const personalQuery = sb.from('expenses').select('*').eq('scope', 'personal').eq('user_id', state.user.id).order('expense_date', { ascending: false }).limit(300);
  const businessQuery = sb.from('expenses').select('*').eq('scope', 'business').eq('user_id', state.user.id).order('expense_date', { ascending: false }).limit(300);
  const familyQuery = state.familyId
    ? sb.from('expenses').select('*').eq('scope', 'family').eq('family_id', state.familyId).order('expense_date', { ascending: false }).limit(300)
    : Promise.resolve({ data: [], error: null });

  const [personalResult, familyResult, businessResult] = await Promise.all([personalQuery, familyQuery, businessQuery]);

  if (personalResult.error) return showStatus(personalResult.error.message, 'error');
  if (businessResult.error) return showStatus(businessResult.error.message, 'error');
  if (familyResult?.error) {
    $('familyNotice').classList.remove('hidden');
  } else {
    $('familyNotice').classList.add('hidden');
  }

  state.expenses = [
    ...(personalResult.data || []),
    ...(familyResult?.data || []),
    ...(businessResult.data || [])
  ];
  rebuildMonths();
  renderAll();
}

function rebuildMonths() {
  state.months = new Set(state.expenses.map((e) => e.expense_date?.slice(0, 7)).filter(Boolean));
  state.months.add(getMonthKey(new Date()));
  if (!state.months.has(state.selectedMonth)) state.selectedMonth = getMonthKey(new Date());
  renderMonthFilter();
}

function renderMonthFilter() {
  const options = [...state.months].sort().reverse();
  $('monthFilter').innerHTML = options.map((key) => `<option value="${key}">${escapeHtml(monthLabel(key))}</option>`).join('');
  $('monthFilter').value = state.selectedMonth;
}

function renderSummary() {
  const all = currentScopeExpenses();
  const monthly = all.filter((e) => e.expense_date?.startsWith(state.selectedMonth));
  const today = isoDate(new Date());
  const todays = all.filter((e) => e.expense_date === today);
  const recent = [...all].sort((a, b) => new Date(b.created_at || `${b.expense_date}T00:00:00`) - new Date(a.created_at || `${a.expense_date}T00:00:00`))[0];

  $('totalMonth').textContent = fmtINR.format(sum(monthly));
  $('monthExpenseCount').textContent = `${monthly.length} ${monthly.length === 1 ? 'expense' : 'expenses'}`;
  $('totalToday').textContent = fmtINR.format(sum(todays));
  $('todayExpenseCount').textContent = `${todays.length} ${todays.length === 1 ? 'expense' : 'expenses'}`;
  $('lastAmount').textContent = recent ? fmtINR.format(Number(recent.amount)) : '—';
  $('lastExpenseMeta').textContent = recent ? `${recent.description} · ${safeDateLabel(recent.expense_date)}` : 'Nothing added yet';
}

function matchesBusinessSearch(expense) {
  const query = state.businessSearch.trim().toLowerCase();
  if (!query) return true;
  return String(expense.description || '').toLowerCase().includes(query);
}

function renderList() {
  const monthly = currentScopeExpenses()
    .filter((e) => e.expense_date?.startsWith(state.selectedMonth))
    .filter((e) => state.scope !== 'business' || matchesBusinessSearch(e))
    .sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)) || new Date(b.created_at || 0) - new Date(a.created_at || 0));

  $('listTitle').textContent = state.scope === 'personal' ? 'Personal expenses' : state.scope === 'family' ? 'Family expenses' : 'Business expenses';
  $('paidByCol').classList.toggle('hidden', state.scope !== 'family');
  $('standardFields').classList.toggle('hidden', state.scope === 'business');
  $('businessFields').classList.toggle('hidden', state.scope !== 'business');
  $('businessSearchWrap').classList.toggle('hidden', state.scope !== 'business');
  $('clearBusinessSearch').classList.toggle('hidden', !state.businessSearch);

  if (state.scope === 'family' && !state.familyId && state.user && !state.demoMode) {
    $('familyNotice').classList.remove('hidden');
  }

  if (!monthly.length) {
    const emptyMessage = state.scope === 'business' && state.businessSearch
      ? `No business expenses match “${escapeHtml(state.businessSearch)}”.`
      : 'No expenses here yet.';
    $('expenseList').innerHTML = `<div class="empty-state"><strong>${emptyMessage}</strong><span>Add one above. Repeated entries will appear as quick suggestions next time.</span></div>`;
    return;
  }

  $('expenseList').innerHTML = monthly.map((expense) => {
    const paidBy = state.scope === 'family' ? (expense.paid_by === state.user?.id || expense.paid_by === 'me' ? 'Paid by me' : 'Paid by family') : '';
    const businessMath = state.scope === 'business' && expense.units != null && expense.unit_price != null
      ? `<div class="expense-math">${escapeHtml(formatNumber(expense.units))} × ${fmtINR.format(Number(expense.unit_price) || 0)}</div>`
      : '';
    return `<div class="expense-item">
      <div class="expense-main">
        <div class="expense-desc">${escapeHtml(expense.description)}</div>
        <div class="expense-meta">${safeDateLabel(expense.expense_date)}</div>
        ${businessMath}
        <div class="item-actions">
          <button class="mini-btn" data-edit="${expense.id}">Edit</button>
          <button class="mini-btn" data-delete="${expense.id}">Delete</button>
        </div>
      </div>
      <div class="expense-side">
        <div class="expense-amount">${fmtINR.format(Number(expense.amount))}</div>
        ${paidBy ? `<div class="expense-paid">${paidBy}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  $('expenseList').querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => editExpense(btn.dataset.edit)));
  $('expenseList').querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', () => deleteExpense(btn.dataset.delete)));
}

function renderAll() {
  renderBusinessDescriptionOptions();
  renderSuggestions();
  renderSummary();
  renderList();
}

function sum(items) {
  return items.reduce((acc, item) => acc + Number(item.amount || 0), 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function calculateBusinessTotal() {
  const units = Number($('units').value);
  const unitPrice = Number($('unitPrice').value);
  const total = Number.isFinite(units) && Number.isFinite(unitPrice) ? units * unitPrice : 0;
  $('businessTotal').textContent = fmtINR.format(total || 0);
  return total;
}

function resetForm() {
  state.editingId = null;
  $('formTitle').textContent = state.scope === 'business' ? 'New business expense' : 'New expense';
  $('saveBtn').textContent = 'Save expense';
  $('expenseForm').reset();
  $('expenseDate').value = isoDate(new Date());
  $('paidBy').value = 'me';
  $('units').value = '1';
  $('businessTotal').textContent = fmtINR.format(0);
  showStatus('');
  renderSuggestions();
}

function editExpense(id) {
  const expense = state.expenses.find((e) => e.id === id);
  if (!expense) return;
  state.editingId = id;
  $('formTitle').textContent = state.scope === 'business' ? 'Edit business expense' : 'Edit expense';
  $('saveBtn').textContent = 'Update expense';
  $('description').value = expense.description || '';
  $('expenseDate').value = expense.expense_date;

  if (state.scope === 'business') {
    $('units').value = expense.units ?? 1;
    $('unitPrice').value = expense.unit_price ?? expense.amount ?? '';
    calculateBusinessTotal();
    $('units').focus();
  } else {
    $('amount').value = expense.amount;
    $('paidBy').value = expense.paid_by === state.user?.id ? 'me' : (expense.paid_by || 'family');
    $('amount').focus();
  }

  renderSuggestions();
  document.querySelector('.add-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteExpense(id) {
  const expense = state.expenses.find((e) => e.id === id);
  if (!expense) return;
  if (!confirm(`Delete “${expense.description}” — ${fmtINR.format(Number(expense.amount))}?`)) return;

  if (state.demoMode) {
    state.expenses = state.expenses.filter((e) => e.id !== id);
    persistDemoExpenses();
    renderAll();
    return;
  }

  const { error } = await sb.from('expenses').delete().eq('id', id);
  if (error) return showStatus(error.message, 'error');
  await refreshExpenses();
  showStatus('Expense deleted.', 'success');
}

function getBusinessValues() {
  const units = Number($('units').value);
  const unitPrice = Number($('unitPrice').value);
  const amount = units * unitPrice;
  return { units, unitPrice, amount };
}

async function saveExpense(event) {
  event.preventDefault();
  const wasEditing = Boolean(state.editingId);
  const description = $('description').value.trim();
  const expenseDate = $('expenseDate').value;

  if (!description) return showStatus('Add a short description.', 'error');
  if (!expenseDate) return showStatus('Choose a date.', 'error');

  let amount;
  let units = null;
  let unitPrice = null;

  if (state.scope === 'business') {
    ({ units, unitPrice, amount } = getBusinessValues());
    if (!Number.isFinite(units) || units <= 0) return showStatus('Enter a valid number of units.', 'error');
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return showStatus('Enter a valid price per unit.', 'error');
    if (!Number.isFinite(amount) || amount <= 0) return showStatus('Total must be greater than ₹0.', 'error');
  } else {
    amount = Number($('amount').value);
    if (!Number.isFinite(amount) || amount <= 0) return showStatus('Enter a valid amount.', 'error');
  }

  const payload = {
    amount: Math.round(amount * 100) / 100,
    description,
    expense_date: expenseDate,
    scope: state.scope,
    user_id: state.user?.id || 'demo',
    family_id: state.scope === 'family' ? (state.familyId || 'demo-family') : null,
    paid_by: state.scope === 'family' ? ($('paidBy').value === 'me' ? (state.user?.id || 'me') : 'family') : null,
    units: state.scope === 'business' ? Math.round(units * 100) / 100 : null,
    unit_price: state.scope === 'business' ? Math.round(unitPrice * 100) / 100 : null,
  };

  saveLocalSuggestion(payload);

  if (state.demoMode) {
    if (wasEditing) {
      state.expenses = state.expenses.map((e) => e.id === state.editingId ? { ...e, ...payload } : e);
    } else {
      state.expenses.unshift({ ...payload, id: crypto.randomUUID(), created_at: new Date().toISOString() });
    }
    persistDemoExpenses();
    state.selectedMonth = expenseDate.slice(0, 7);
    rebuildMonths();
    renderAll();
    resetForm();
    showStatus(wasEditing ? 'Expense updated.' : 'Expense saved.', 'success');
    return;
  }

  if (!state.user) {
    return showStatus('Sign in with Google to sync expenses. Your suggestion will stay on this device.', 'error');
  }

  if (state.scope === 'family' && !state.familyId) {
    return showStatus('Family is not configured yet. Add a family ID in config.js.', 'error');
  }

  let error;
  if (wasEditing) {
    ({ error } = await sb.from('expenses').update(payload).eq('id', state.editingId));
  } else {
    ({ error } = await sb.from('expenses').insert(payload));
  }
  if (error) return showStatus(error.message, 'error');

  state.selectedMonth = expenseDate.slice(0, 7);
  await refreshExpenses();
  resetForm();
  showStatus(wasEditing ? 'Expense updated.' : 'Expense saved.', 'success');
}

function switchScope(scope) {
  state.scope = scope;
  state.businessSearch = '';
  $('businessSearch').value = '';
  document.querySelectorAll('.screen-tab').forEach((btn) => {
    const active = btn.dataset.screen === scope;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  resetForm();
  renderAll();
}

$('expenseForm').addEventListener('submit', saveExpense);
$('clearFormBtn').addEventListener('click', resetForm);
$('refreshBtn').addEventListener('click', refreshExpenses);
$('monthFilter').addEventListener('change', (e) => { state.selectedMonth = e.target.value; renderAll(); });
document.querySelectorAll('.screen-tab').forEach((btn) => btn.addEventListener('click', () => switchScope(btn.dataset.screen)));
$('openAddBtn').addEventListener('click', () => { $('description').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
$('signInBtn').addEventListener('click', signIn);
$('signOutBtn').addEventListener('click', signOut);
$('signOutDialogBtn').addEventListener('click', signOut);
$('accountBtn').addEventListener('click', () => $('accountDialog').showModal());
$('closeAccountBtn').addEventListener('click', () => $('accountDialog').close());
$('accountDialog').addEventListener('click', (e) => { if (e.target === $('accountDialog')) $('accountDialog').close(); });
$('units').addEventListener('input', calculateBusinessTotal);
$('unitPrice').addEventListener('input', calculateBusinessTotal);
$('description').addEventListener('input', () => {
  if (state.scope === 'business') {
    const suggestion = findBusinessSuggestion($('description').value);
    if (suggestion) {
      $('units').value = Number(suggestion.units || 1);
      $('unitPrice').value = Number(suggestion.unit_price || 0);
      calculateBusinessTotal();
    }
  }
  renderSuggestions();
});
$('description').addEventListener('change', () => {
  if (state.scope !== 'business') return;
  const suggestion = findBusinessSuggestion($('description').value);
  if (suggestion) applySuggestion(suggestion);
});
$('businessSearch').addEventListener('input', (event) => {
  state.businessSearch = event.target.value;
  renderList();
});
$('clearBusinessSearch').addEventListener('click', () => {
  state.businessSearch = '';
  $('businessSearch').value = '';
  renderList();
  $('businessSearch').focus();
});

renderMonthFilter();
renderBusinessDescriptionOptions();
initAuth().then(refreshExpenses);
