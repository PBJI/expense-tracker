/*
  Expense tracker frontend.

  Supabase tables expected:
  - profiles
  - families (with invite_code text unique)
  - family_members
  - expenses (scope: personal | family | business, units, unit_price)

  Family onboarding uses two SECURITY DEFINER RPC functions:
  - create_family(p_name) -> server-generated invite code
  - join_family_by_invite(p_invite_code)

  See README.md for the SQL.
*/

const { createClient } = window.supabase;
const config = window.APP_CONFIG || {};
const supabaseKey = config.SUPABASE_PUBLISHABLE_KEY || config.SUPABASE_ANON_KEY || '';
const hasSupabaseConfig = Boolean(
  config.SUPABASE_URL &&
  supabaseKey &&
  !config.SUPABASE_URL.includes('YOUR-PROJECT') &&
  !/YOUR_(PUBLIC|PUBLISHABLE)/i.test(supabaseKey)
);

const sb = hasSupabaseConfig ? createClient(config.SUPABASE_URL, supabaseKey) : null;

const state = {
  scope: 'personal',
  user: null,
  familyId: config.DEFAULT_FAMILY_ID || null,
  family: null,
  familyMembers: [],
  expenses: [],
  editingId: null,
  selectedMonth: getMonthKey(new Date()),
  demoMode: !hasSupabaseConfig,
  months: new Set(),
  businessSearch: '',
  familyMode: 'create',
};

const $ = (id) => document.getElementById(id);
const fmtINR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const fmtINR0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

$('expenseDate').value = isoDate(new Date());
$('todayLine').textContent = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
}).format(new Date());

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
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, 1));
}

function safeDateLabel(dateString) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date(`${dateString}T00:00:00`));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function currentScopeExpenses() {
  return state.expenses.filter((e) => e.scope === state.scope);
}

function showStatus(message, kind = '') {
  const el = $('formStatus');
  el.textContent = message;
  el.className = `status-line ${kind}`.trim();
}

function showFamilyStatus(message, kind = '') {
  const el = $('familyStatus');
  el.textContent = message;
  el.className = `status-line ${kind}`.trim();
}

function saveLocalSuggestion(expense) {
  const key = `expense-suggestions:${state.scope}`;
  const current = JSON.parse(localStorage.getItem(key) || '[]');
  const same = current.filter((item) => item.description.toLowerCase() !== expense.description.toLowerCase());
  const entry = {
    description: expense.description,
    amount: expense.amount,
    units: expense.units ?? null,
    unit_price: expense.unit_price ?? null,
    usedAt: Date.now(),
  };
  localStorage.setItem(key, JSON.stringify([entry, ...same].slice(0, 16)));
  renderSuggestions();
  renderBusinessDatalist();
}

function readLocalSuggestions(scope = state.scope) {
  try {
    return JSON.parse(localStorage.getItem(`expense-suggestions:${scope}`) || '[]');
  } catch {
    return [];
  }
}

function renderSuggestions() {
  const items = readLocalSuggestions().slice(0, 6);
  const el = $('suggestions');
  el.innerHTML = items.length
    ? items.map((item, index) => {
        const amount = state.scope === 'business'
          ? `${item.units ?? 1} × ${fmtINR0.format(Number(item.unit_price) || 0)}`
          : fmtINR0.format(Number(item.amount) || 0);
        return `<button class="suggestion-chip" type="button" data-suggestion="${index}">${escapeHtml(item.description)} · ${escapeHtml(amount)}</button>`;
      }).join('')
    : '';

  el.querySelectorAll('[data-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = items[Number(button.dataset.suggestion)];
      if (!item) return;
      applySuggestion(item);
    });
  });
}

function renderBusinessDatalist() {
  const items = readLocalSuggestions('business');
  $('businessDescriptionOptions').innerHTML = items
    .map((item) => `<option value="${escapeHtml(item.description)}"></option>`)
    .join('');
}

function applySuggestion(item) {
  $('description').value = item.description;
  if (state.scope === 'business') {
    $('units').value = item.units || 1;
    $('unitPrice').value = item.unit_price ?? '';
    updateBusinessTotal();
    $('units').focus();
  } else {
    $('amount').value = item.amount ?? '';
    $('amount').focus();
  }
}

function applyDescriptionMatch() {
  if (state.scope !== 'business') return;
  const value = $('description').value.trim().toLowerCase();
  if (!value) return;
  const match = readLocalSuggestions('business').find(
    (item) => item.description.toLowerCase() === value
  );
  if (!match) return;
  if (!$('units').value || $('units').value === '1') $('units').value = match.units || 1;
  if (!$('unitPrice').value) $('unitPrice').value = match.unit_price ?? '';
  updateBusinessTotal();
}

function updateBusinessTotal() {
  const units = Number($('units').value);
  const unitPrice = Number($('unitPrice').value);
  const total = Number.isFinite(units) && Number.isFinite(unitPrice) ? units * unitPrice : 0;
  $('businessTotal').textContent = fmtINR.format(total || 0);
}

function loadDemoExpenses() {
  const key = 'family-expense-tracker:demo-expenses';
  let data = JSON.parse(localStorage.getItem(key) || 'null');
  if (!data) {
    const today = isoDate(new Date());
    data = [
      { id: crypto.randomUUID(), user_id: 'demo', family_id: 'demo-family', scope: 'personal', amount: 80, description: 'Auto / metro', expense_date: today, paid_by: 'me', created_at: new Date().toISOString() },
      { id: crypto.randomUUID(), user_id: 'demo', family_id: 'demo-family', scope: 'family', amount: 1250, description: 'Groceries', expense_date: today, paid_by: 'me', created_at: new Date().toISOString() },
      { id: crypto.randomUUID(), user_id: 'demo', family_id: 'demo-family', scope: 'family', amount: 1480, description: 'Electricity bill', expense_date: isoDate(Date.now() - 86400000 * 2), paid_by: 'family', created_at: new Date().toISOString() },
      { id: crypto.randomUUID(), user_id: 'demo', family_id: null, scope: 'business', amount: 3600, units: 12, unit_price: 300, description: 'Packaging boxes', expense_date: today, paid_by: 'me', created_at: new Date().toISOString() }
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
    showStatus('Demo mode: connect Supabase in config.js to sync across devices.');
    renderFamilyPill();
    return;
  }

  const { data } = await sb.auth.getSession();
  state.user = data.session?.user || null;
  updateAuthUi();

  sb.auth.onAuthStateChange(async (_event, session) => {
    state.user = session?.user || null;
    state.family = null;
    state.familyMembers = [];
    state.familyId = config.DEFAULT_FAMILY_ID || null;
    updateAuthUi();
    await refreshExpenses();
    if (state.user && !state.familyId) openFamilyDialog('create');
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
  renderFamilyPill();
  renderAccountFamily();
}

async function signIn() {
  if (!sb) return showStatus('Add your public Supabase config to config.js first.');
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo }
  });
  if (error) showStatus(error.message, 'error');
}

async function signOut() {
  if (!sb) return;
  await sb.auth.signOut();
  if ($('accountDialog').open) $('accountDialog').close();
  if ($('familyDialog').open) $('familyDialog').close();
}

async function discoverFamily() {
  if (!state.user || !sb) return null;
  if (state.familyId && state.family) return state.family;

  const { data: membership, error: membershipError } = await sb
    .from('family_members')
    .select('family_id, role')
    .eq('user_id', state.user.id)
    .limit(1)
    .maybeSingle();

  if (membershipError) throw membershipError;
  if (!membership?.family_id) {
    state.familyId = null;
    state.family = null;
    state.familyMembers = [];
    return null;
  }

  state.familyId = membership.family_id;

  const [{ data: family, error: familyError }, { data: members, error: membersError }] = await Promise.all([
    sb.from('families').select('id, name, invite_code, created_by').eq('id', state.familyId).single(),
    sb.from('family_members').select('family_id, user_id, role, joined_at').eq('family_id', state.familyId).order('joined_at', { ascending: true })
  ]);

  if (familyError) throw familyError;
  if (membersError) throw membersError;

  state.family = family;
  state.familyMembers = members || [];
  renderFamilyPill();
  renderAccountFamily();
  renderPaidByOptions();
  return state.family;
}

async function createFamily() {
  if (!state.user || !sb) return showFamilyStatus('Sign in with Google first.', 'error');
  const name = $('familyName').value.trim() || 'My Family';
  $('createFamilyBtn').disabled = true;
  showFamilyStatus('Creating family…');

  try {
    const { data: created, error } = await sb.rpc('create_family', {
      p_name: name,
    });
    if (error) throw error;

    await discoverFamily();
    showFamilyStatus('Family created. Share the invite code with the other person.', 'success');
    renderFamilyDialog();
    await refreshExpenses();
  } catch (err) {
    showFamilyStatus(normalizeSupabaseError(err, 'Could not create the family.'), 'error');
  } finally {
    $('createFamilyBtn').disabled = false;
  }
}

async function joinFamily() {
  if (!state.user || !sb) return showFamilyStatus('Sign in with Google first.', 'error');
  const inviteCode = normalizeInviteCode($('familyInviteCode').value);
  $('familyInviteCode').value = formatInviteCode(inviteCode);
  if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(inviteCode)) {
    return showFamilyStatus('Enter the 8-character invite code, for example K7XM-4QPN.', 'error');
  }

  $('joinFamilyBtn').disabled = true;
  showFamilyStatus('Joining family…');

  try {
    const { error } = await sb.rpc('join_family_by_invite', { p_invite_code: inviteCode });
    if (error) throw error;
    await discoverFamily();
    showFamilyStatus('Joined successfully.', 'success');
    renderFamilyDialog();
    await refreshExpenses();
  } catch (err) {
    showFamilyStatus(normalizeSupabaseError(err, 'Could not join that family.'), 'error');
  } finally {
    $('joinFamilyBtn').disabled = false;
  }
}

function normalizeInviteCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .slice(0, 8);
}

function formatInviteCode(value) {
  const code = normalizeInviteCode(value);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function normalizeSupabaseError(error, fallback) {
  const message = error?.message || fallback;
  if (/function .* does not exist/i.test(message)) {
    return 'Run the latest family SQL in Supabase SQL Editor once, then try again.';
  }
  if (/already.*family|already.*member/i.test(message)) return 'You are already in a family.';
  if (/full|2 members|maximum/i.test(message)) return 'That family already has 2 members.';
  if (/not found|invalid.*code|invite/i.test(message)) return 'That invite code is invalid.';
  return message;
}

function renderFamilyPill() {
  const pill = $('familyPill');
  if (!state.user || !state.family) {
    pill.classList.add('hidden');
    return;
  }
  pill.textContent = state.family.name || 'Family';
  pill.classList.remove('hidden');
}

function renderAccountFamily() {
  const block = $('accountFamilyBlock');
  const manageButton = $('manageFamilyBtn');
  if (!state.user) {
    block.textContent = '';
    manageButton.classList.add('hidden');
    return;
  }
  manageButton.classList.remove('hidden');
  if (!state.family) {
    block.innerHTML = `<div class="account-family-empty">No family joined yet.</div>`;
    return;
  }
  const owner = state.family.created_by === state.user.id;
  const members = state.familyMembers.length;
  block.innerHTML = `
    <div class="account-family-card">
      <strong>${escapeHtml(state.family.name || 'My Family')}</strong>
      <span>${members}/2 members · ${owner ? 'Owner' : 'Member'}</span>
      <span class="invite-code-inline">Invite code: <b>${escapeHtml(formatInviteCode(state.family.invite_code || '')) || '—'}</b></span>
    </div>`;
}

function renderFamilyDialog() {
  const current = $('familyCurrent');
  if (state.family) {
    current.classList.remove('hidden');
    current.innerHTML = `
      <div class="family-current-head">
        <strong>${escapeHtml(state.family.name || 'My Family')}</strong>
        <span>${state.familyMembers.length}/2 members</span>
      </div>
      <div class="invite-code-box">
        <span>Invite code</span>
        <strong>${escapeHtml(formatInviteCode(state.family.invite_code || '')) || '—'}</strong>
        <button type="button" class="ghost-btn" id="copyInviteBtn">Copy</button>
      </div>
      <div class="member-list">${state.familyMembers.map((member) => `
        <div class="member-row"><span>${member.user_id === state.user?.id ? 'You' : 'Family member'}</span><span>${member.role === 'owner' ? 'Owner' : 'Member'}</span></div>
      `).join('')}</div>
    `;
    $('copyInviteBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(formatInviteCode(state.family.invite_code));
        showFamilyStatus('Invite code copied.', 'success');
      } catch {
        showFamilyStatus(`Code: ${formatInviteCode(state.family.invite_code)}`, 'success');
      }
    });
  } else {
    current.classList.add('hidden');
  }

  if (state.family) {
    setFamilyMode('join');
  } else {
    setFamilyMode(state.familyMode || 'create');
  }
}

function setFamilyMode(mode) {
  state.familyMode = mode;
  document.querySelectorAll('[data-family-mode]').forEach((button) => {
    const active = button.dataset.familyMode === mode;
    button.classList.toggle('active', active);
  });
  $('familyCreatePanel').classList.toggle('hidden', mode !== 'create');
  $('familyJoinPanel').classList.toggle('hidden', mode !== 'join');
  showFamilyStatus('');
}

function openFamilyDialog(preferredMode = 'create') {
  state.familyMode = preferredMode;
  renderFamilyDialog();
  if (!$('familyDialog').open) $('familyDialog').showModal();
}

function renderPaidByOptions(selectedValue = $('paidBy').value) {
  const select = $('paidBy');
  if (state.scope !== 'family') {
    select.innerHTML = '<option value=\"me\">Me</option>';
    select.value = 'me';
    return;
  }

  const currentUserId = state.user?.id || (state.demoMode ? 'demo' : null);
  const otherMember = state.familyMembers.find((member) => member.user_id !== currentUserId);
  const options = ['<option value=\"me\">Me</option>'];
  if (otherMember) {
    const label = otherMember.user_id === state.family?.created_by ? 'Family member (owner)' : 'Family member';
    options.push(`<option value=\"${escapeHtml(otherMember.user_id)}\">${escapeHtml(label)}</option>`);
  } else {
    options.push('<option value=\"__not_joined\" disabled>Other member not joined</option>');
  }
  select.innerHTML = options.join('');
  select.value = [...select.options].some((option) => option.value === selectedValue) ? selectedValue : 'me';
}

async function refreshExpenses() {
  if (state.demoMode) {
    state.expenses = loadDemoExpenses();
    state.family = {
      id: 'demo-family', name: 'Demo Family', invite_code: 'K7XM-4QPN', created_by: 'demo'
    };
    state.familyId = 'demo-family';
    state.familyMembers = [
      { family_id: 'demo-family', user_id: 'demo', role: 'owner' },
      { family_id: 'demo-family', user_id: 'demo-2', role: 'member' },
    ];
    rebuildMonths();
    renderAll();
    renderFamilyPill();
    renderAccountFamily();
    renderPaidByOptions();
    return;
  }

  if (!state.user) {
    state.expenses = [];
    state.family = null;
    state.familyId = null;
    state.familyMembers = [];
    rebuildMonths();
    renderAll();
    renderFamilyPill();
    renderAccountFamily();
    renderPaidByOptions();
    return;
  }

  try {
    await discoverFamily();

    const expenseColumns = 'id,user_id,family_id,scope,description,amount,units,unit_price,paid_by,expense_date,created_at,updated_at';
    const monthStart = `${state.selectedMonth}-01`;
    const [year, month] = state.selectedMonth.split('-').map(Number);
    const nextMonth = new Date(year, month, 1);
    const nextMonthKey = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

    const personalQuery = sb.from('expenses')
      .select(expenseColumns)
      .eq('scope', 'personal')
      .eq('user_id', state.user.id)
      .gte('expense_date', monthStart)
      .lt('expense_date', nextMonthKey)
      .order('expense_date', { ascending: false })
      .limit(250);

    const businessQuery = sb.from('expenses')
      .select(expenseColumns)
      .eq('scope', 'business')
      .eq('user_id', state.user.id)
      .gte('expense_date', monthStart)
      .lt('expense_date', nextMonthKey)
      .order('expense_date', { ascending: false })
      .limit(250);

    const familyQuery = state.familyId
      ? sb.from('expenses')
        .select(expenseColumns)
        .eq('scope', 'family')
        .eq('family_id', state.familyId)
        .gte('expense_date', monthStart)
        .lt('expense_date', nextMonthKey)
        .order('expense_date', { ascending: false })
        .limit(250)
      : Promise.resolve({ data: [], error: null });

    const [personalResult, businessResult, familyResult] = await Promise.all([
      personalQuery, businessQuery, familyQuery
    ]);

    if (personalResult.error) throw personalResult.error;
    if (businessResult.error) throw businessResult.error;

    if (familyResult?.error) {
      $('familyNotice').classList.remove('hidden');
      $('familyNotice').innerHTML = `<strong>Family expenses unavailable.</strong><span>${escapeHtml(familyResult.error.message)}</span>`;
    } else {
      $('familyNotice').classList.add('hidden');
    }

    state.expenses = [
      ...(personalResult.data || []),
      ...(businessResult.data || []),
      ...(familyResult?.data || [])
    ];
    rebuildMonths();
    renderAll();
    renderFamilyPill();
    renderAccountFamily();
    renderPaidByOptions();
  } catch (error) {
    showStatus(error.message || 'Could not load expenses.', 'error');
  }
}

function rebuildMonths() {
  const months = new Set();
  const now = new Date();

  for (let offset = 0; offset < 12; offset += 1) {
    months.add(getMonthKey(new Date(now.getFullYear(), now.getMonth() - offset, 1)));
  }

  for (const expense of state.expenses) {
    if (expense.expense_date) months.add(expense.expense_date.slice(0, 7));
  }

  state.months = months;
  if (!state.months.has(state.selectedMonth)) state.selectedMonth = getMonthKey(new Date());
  renderMonthFilter();
}

function renderMonthFilter() {
  const options = [...state.months].sort().reverse();
  $('monthFilter').innerHTML = options
    .map((key) => `<option value="${key}">${escapeHtml(monthLabel(key))}</option>`).join('');
  $('monthFilter').value = state.selectedMonth;
}

function renderSummary() {
  const all = currentScopeExpenses();
  const monthKey = state.selectedMonth;
  const monthly = all.filter((e) => e.expense_date?.startsWith(monthKey));
  const today = isoDate(new Date());
  const todays = all.filter((e) => e.expense_date === today);
  const recent = [...all].sort((a, b) => new Date(b.created_at || `${b.expense_date}T00:00:00`) - new Date(a.created_at || `${a.expense_date}T00:00:00`))[0];

  $('totalMonth').textContent = fmtINR.format(sum(monthly));
  $('monthExpenseCount').textContent = `${monthly.length} ${monthly.length === 1 ? 'expense' : 'expenses'}`;
  $('totalToday').textContent = fmtINR.format(sum(todays));
  $('todayExpenseCount').textContent = `${todays.length} ${todays.length === 1 ? 'expense' : 'expenses'}`;
  $('lastAmount').textContent = recent ? fmtINR.format(Number(recent.amount)) : '—';
  $('lastExpenseMeta').textContent = recent
    ? `${recent.description} · ${safeDateLabel(recent.expense_date)}`
    : 'Nothing added yet';
}

function renderList() {
  let visible = currentScopeExpenses().filter((e) => e.expense_date?.startsWith(state.selectedMonth));

  if (state.scope === 'business' && state.businessSearch.trim()) {
    const q = state.businessSearch.trim().toLowerCase();
    visible = visible.filter((e) => e.description.toLowerCase().includes(q));
  }

  visible.sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)) || new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const title = state.scope === 'personal'
    ? 'Personal expenses'
    : state.scope === 'family'
      ? 'Family expenses'
      : 'Business expenses';
  $('listTitle').textContent = title;
  $('paidByCol').classList.toggle('hidden', state.scope !== 'family');
  $('businessFields').classList.toggle('hidden', state.scope !== 'business');
  $('standardFields').classList.toggle('hidden', state.scope === 'business');
  $('businessSearchWrap').classList.toggle('hidden', state.scope !== 'business');
  $('formKicker').textContent = state.scope === 'business' ? 'Quick add · units' : 'Quick add';

  if (state.scope === 'family') {
    if (state.user && !state.familyId && !state.demoMode) {
      $('familyNotice').classList.remove('hidden');
      $('familyNotice').innerHTML = `<strong>No family yet.</strong><span>Set one up to use shared expenses. <button type="button" class="inline-link" id="openFamilyFromNotice">Set up family</button></span>`;
      $('openFamilyFromNotice')?.addEventListener('click', () => openFamilyDialog('create'));
    } else if (state.familyId) {
      const invite = state.family?.invite_code ? ` · Code ${escapeHtml(state.family.invite_code)}` : '';
      $('familyNotice').classList.remove('hidden');
      $('familyNotice').innerHTML = `<strong>${escapeHtml(state.family?.name || 'Family')}</strong><span>${state.familyMembers.length || 1}/2 members${invite}</span>`;
    }
  } else {
    $('familyNotice').classList.add('hidden');
  }

  if (state.scope === 'business') {
    $('clearBusinessSearch').classList.toggle('hidden', !state.businessSearch);
    $('businessSearch').value = state.businessSearch;
  }

  if (!visible.length) {
    const searchEmpty = state.scope === 'business' && state.businessSearch;
    $('expenseList').innerHTML = `<div class="empty-state"><strong>${searchEmpty ? 'No matching expenses.' : 'No expenses here yet.'}</strong><span>${searchEmpty ? 'Try another search.' : 'Add one above. Repeated entries will appear as quick suggestions next time.'}</span></div>`;
    return;
  }

  $('expenseList').innerHTML = visible.map((expense) => {
    const paidBy = state.scope === 'family'
      ? (expense.paid_by === state.user?.id || expense.paid_by === 'me' ? 'Paid by me' : 'Paid by family')
      : '';
    const businessMeta = state.scope === 'business' && expense.units != null && expense.unit_price != null
      ? ` · ${escapeHtml(String(expense.units))} × ${fmtINR.format(Number(expense.unit_price))}`
      : '';
    return `<div class="expense-item">
      <div class="expense-main">
        <div class="expense-desc">${escapeHtml(expense.description)}</div>
        <div class="expense-meta">${safeDateLabel(expense.expense_date)}${businessMeta}</div>
        <div class="item-actions">
          <button class="mini-btn" data-edit="${escapeHtml(expense.id)}">Edit</button>
          <button class="mini-btn" data-delete="${escapeHtml(expense.id)}">Delete</button>
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
  renderSuggestions();
  renderBusinessDatalist();
  renderSummary();
  renderList();
  updateBusinessTotal();
}

function sum(items) {
  return items.reduce((acc, item) => acc + Number(item.amount || 0), 0);
}

function resetForm() {
  state.editingId = null;
  $('formTitle').textContent = 'New expense';
  $('saveBtn').textContent = 'Save expense';
  $('expenseForm').reset();
  $('expenseDate').value = isoDate(new Date());
  $('paidBy').value = 'me';
  $('units').value = '1';
  renderPaidByOptions();
  showStatus('');
  updateBusinessTotal();
  renderSuggestions();
}

function editExpense(id) {
  const expense = state.expenses.find((e) => e.id === id);
  if (!expense) return;
  state.editingId = id;
  $('formTitle').textContent = 'Edit expense';
  $('saveBtn').textContent = 'Update expense';
  $('description').value = expense.description;
  $('expenseDate').value = expense.expense_date;

  if (expense.scope === 'business') {
    state.scope = 'business';
    document.querySelectorAll('.screen-tab').forEach((btn) => {
      const active = btn.dataset.screen === 'business';
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    $('units').value = expense.units ?? 1;
    $('unitPrice').value = expense.unit_price ?? '';
    updateBusinessTotal();
  } else {
    $('amount').value = expense.amount;
  }

  renderPaidByOptions(expense.paid_by === state.user?.id ? 'me' : expense.paid_by);
  renderList();
  document.querySelector('.add-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (state.scope === 'business') $('units').focus(); else $('amount').focus();
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

async function saveExpense(event) {
  event.preventDefault();
  const description = $('description').value.trim();
  const expenseDate = $('expenseDate').value;

  if (!description) return showStatus('Add a short description.', 'error');
  if (description.length > 200) return showStatus('Description must be 200 characters or less.', 'error');
   if (description.length > 200) return showStatus('Description must be 200 characters or less.', 'error');
  if (!expenseDate) return showStatus('Choose a date.', 'error');

  let amount;
  let units = null;
  let unitPrice = null;

  if (state.scope === 'business') {
    units = Number($('units').value);
    unitPrice = Number($('unitPrice').value);
    amount = units * unitPrice;
    if (!Number.isFinite(units) || units <= 0) return showStatus('Enter valid units.', 'error');
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
    paid_by: state.user?.id || 'demo',
    units: state.scope === 'business' ? Math.round(units * 1000) / 1000 : null,
    unit_price: state.scope === 'business' ? Math.round(unitPrice * 100) / 100 : null,
  };

  if (state.scope === 'family') {
    if ($('paidBy').value === '__not_joined') return showStatus('Add the second family member first.', 'error');
    payload.paid_by = $('paidBy').value === 'me' ? (state.user?.id || 'demo') : $('paidBy').value;
  }

  saveLocalSuggestion(payload);

  const wasEditing = Boolean(state.editingId);

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
    openFamilyDialog('create');
    return showStatus('Set up or join your family first.', 'error');
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
  document.querySelectorAll('.screen-tab').forEach((btn) => {
    const active = btn.dataset.screen === scope;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  resetForm();
  renderPaidByOptions();
  renderAll();
}

$('expenseForm').addEventListener('submit', saveExpense);
$('clearFormBtn').addEventListener('click', resetForm);
$('refreshBtn').addEventListener('click', refreshExpenses);
$('monthFilter').addEventListener('change', async (e) => {
  state.selectedMonth = e.target.value;
  if (sb && state.user && !state.demoMode) {
    await refreshExpenses();
  } else {
    renderAll();
  }
});
document.querySelectorAll('.screen-tab').forEach((btn) => btn.addEventListener('click', () => switchScope(btn.dataset.screen)));
$('openAddBtn').addEventListener('click', () => {
  document.querySelector('.add-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (state.scope === 'business') $('units').focus(); else $('amount').focus();
});
$('signInBtn').addEventListener('click', signIn);
$('signOutBtn').addEventListener('click', signOut);
$('signOutDialogBtn').addEventListener('click', signOut);
$('accountBtn').addEventListener('click', () => $('accountDialog').showModal());
$('closeAccountBtn').addEventListener('click', () => $('accountDialog').close());
$('accountDialog').addEventListener('click', (e) => { if (e.target === $('accountDialog')) $('accountDialog').close(); });
$('manageFamilyBtn').addEventListener('click', () => openFamilyDialog(state.family ? 'join' : 'create'));
$('closeFamilyBtn').addEventListener('click', () => $('familyDialog').close());
$('familyDialog').addEventListener('click', (e) => { if (e.target === $('familyDialog')) $('familyDialog').close(); });
$('createFamilyBtn').addEventListener('click', createFamily);
$('joinFamilyBtn').addEventListener('click', joinFamily);
$('familyInviteCode').addEventListener('input', (e) => {
  e.target.value = formatInviteCode(e.target.value);
});
document.querySelectorAll('[data-family-mode]').forEach((button) => button.addEventListener('click', () => setFamilyMode(button.dataset.familyMode)));
$('businessSearch').addEventListener('input', (e) => {
  state.businessSearch = e.target.value;
  $('clearBusinessSearch').classList.toggle('hidden', !state.businessSearch);
  renderList();
});
$('clearBusinessSearch').addEventListener('click', () => {
  state.businessSearch = '';
  $('businessSearch').value = '';
  $('clearBusinessSearch').classList.add('hidden');
  renderList();
  $('businessSearch').focus();
});
$('units').addEventListener('input', updateBusinessTotal);
$('unitPrice').addEventListener('input', updateBusinessTotal);
$('description').addEventListener('change', applyDescriptionMatch);
$('description').addEventListener('blur', applyDescriptionMatch);

renderMonthFilter();
renderBusinessDatalist();
(async () => {
  await initAuth();
  await refreshExpenses();
  if (state.user && state.familyId == null && sb && !state.demoMode) openFamilyDialog('create');
})();
