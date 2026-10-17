import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';
import { openTrends, rangeStatus } from './trends.js';

// Read the reset-link details before the Supabase client consumes and clears the URL.
const authParams = new URLSearchParams(location.hash.slice(1));
let recovering = authParams.get('type') === 'recovery';
const authLinkError = authParams.get('error_description');

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
// Dropdown fields list values already used in these tables; "fills" are filled in when a value is picked.
const PROVIDER_CHOICES = {
  noun: 'provider',
  profiles: true,
  sources: [
    { table: 'providers', column: 'name' },
    { table: 'medications', column: 'prescriber', fills: ['specialization'] },
    { table: 'visits', column: 'provider' }
  ]
};
const TEST_CHOICES = { noun: 'test', sources: [{ table: 'lab_results', column: 'test_name', fills: ['unit', 'reference_range'] }] };
const UNIT_CHOICES = { noun: 'unit', sources: [{ table: 'lab_results', column: 'unit' }] };

const sectionConfig = {
  medications: {
    title: 'Medications',
    description: 'A clear list of current and past prescriptions.',
    table: 'medications',
    primary: 'medicine',
    sortBy: 'start_date',
    groupBy: 'prescriber',
    dateFilter: true,
    ongoing: true,
    listHeading: 'Medicine history',
    fields: [
      { name: 'medicine', label: 'Medicine', required: true },
      { name: 'strength', label: 'Strength' },
      { name: 'brand', label: 'Brand name' },
      { name: 'dosage', label: 'Dosage' },
      { name: 'duration', label: 'Duration' },
      { name: 'prescriber', label: 'Prescriber', choices: PROVIDER_CHOICES },
      { name: 'specialization', label: 'Specialization' },
      { name: 'start_date', label: 'Start date', type: 'date' },
      { name: 'end_date', label: 'End date', type: 'date' },
      { name: 'notes', label: 'Notes', multiline: true }
    ]
  },
  lab_results: {
    title: 'Lab results',
    description: 'Measurements and reports, kept together with their units and ranges.',
    table: 'lab_results',
    primary: 'test_name',
    sortBy: 'test_date',
    dateFilter: true,
    file: { name: 'report_path', label: 'Report' },
    rangeCheck: { value: 'result', range: 'reference_range' },
    trends: true,
    fields: [
      { name: 'test_name', label: 'Test name', required: true, choices: TEST_CHOICES },
      { name: 'result', label: 'Result' },
      { name: 'unit', label: 'Unit', choices: UNIT_CHOICES },
      { name: 'reference_range', label: 'Reference range' },
      { name: 'test_date', label: 'Test date', type: 'date' },
      { name: 'provider', label: 'Provider', choices: PROVIDER_CHOICES },
      { name: 'report_note', label: 'Report note', multiline: true }
    ]
  },
  visits: {
    title: 'Visit notes',
    description: 'Symptoms, summaries, and notes from appointments.',
    table: 'visits',
    primary: 'visit_date',
    sortBy: 'visit_date',
    groupBy: 'provider',
    // Rx and Test are built from medications and lab results that share this visit's key.
    linked: [
      { title: 'Rx', table: 'medications', date: 'start_date', provider: 'prescriber', kind: 'rx' },
      { title: 'Test', table: 'lab_results', date: 'test_date', provider: 'provider', kind: 'test' }
    ],
    vitals: ['bp', 'pulse', 'weight', 'height'],
    detailColumns: 2,
    fields: [
      { name: 'visit_date', label: 'Visit date', type: 'date' },
      { name: 'provider', label: 'Provider', choices: PROVIDER_CHOICES },
      { name: 'advice', label: 'Advice', multiline: true },
      { name: 'symptoms', label: 'Symptoms', multiline: true },
      { name: 'bp', label: 'BP', group: 'vitals' },
      { name: 'pulse', label: 'Pulse', group: 'vitals' },
      { name: 'weight', label: 'Weight', group: 'vitals' },
      { name: 'height', label: 'Height', group: 'vitals' },
      { name: 'notes', label: 'Notes', multiline: true }
    ]
  }
};

const NEW_CHOICE = '__new__';
const REPORT_BUCKET = 'reports';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const state = { section: 'medications', records: [], editing: null, counts: {}, fileUrls: {}, userId: null, providerLinks: new Map(), linked: {}, linkedAll: {} };
const listElement = document.querySelector('#record-list');
const dialog = document.querySelector('#record-dialog');
const form = document.querySelector('#record-form');
const notice = document.querySelector('#notice');
const dialogNotice = document.querySelector('#dialog-notice');

function fileName(path) {
  return path.split('/').pop();
}

// A visit's key: its date plus the last 3 letters of the provider's name, e.g. "2023-02-23-man".
// Medications and lab results with the same key belong to that visit.
function visitKey(date, provider) {
  const name = String(provider ?? '').trim().toLocaleLowerCase().replace(/\s+$/, '');
  if (!date || name.length < 3) return null;
  return `${date}-${name.slice(-3)}`;
}

// Only http(s) links are shown, so a stored value can never run script when clicked.
function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// Records from other tables that the active section links to (Rx and Test on visit notes).
async function loadLinked() {
  state.linked = {};
  state.linkedAll = {};
  const { linked } = activeConfig();
  if (!linked) return;
  const results = await Promise.all(linked.map(source => supabase.from(source.table).select('*')));
  linked.forEach((source, index) => {
    state.linkedAll[source.table] = results[index].data ?? [];
    const byKey = new Map();
    for (const row of results[index].data ?? []) {
      const key = visitKey(row[source.date], row[source.provider]);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    }
    state.linked[source.table] = byKey;
  });
}

async function loadProviderLinks() {
  const { data } = await supabase.from('providers').select('name, profile_url');
  state.providerLinks = new Map((data ?? []).filter(row => row.profile_url).map(row => [row.name.trim(), row.profile_url]));
}

function setDialogNotice(message) {
  dialogNotice.textContent = message;
  dialogNotice.hidden = !message;
}

function escapeText(value) {
  return String(value ?? '');
}

function setNotice(message, kind = 'error') {
  notice.textContent = message;
  notice.className = `notice notice-${kind}`;
  notice.hidden = !message;
}

function setConnection(connected) {
  document.querySelector('#connection-dot').classList.toggle('is-connected', connected);
  document.querySelector('#connection-label').textContent = connected ? 'Supabase connected' : 'Supabase unavailable';
}

function activeConfig() {
  return sectionConfig[state.section];
}

function formatValue(fieldName, value) {
  if (!value) return '';
  if (fieldName.endsWith('_date') && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
  }
  return escapeText(value);
}

const ALL_DATES = '';
const NO_DATE = '__none__';

function filteredRecords() {
  const query = document.querySelector('#search-input').value.trim().toLocaleLowerCase();
  const { sortBy, dateFilter } = activeConfig();
  const date = dateFilter ? document.querySelector('#date-filter').value : ALL_DATES;
  return state.records.filter(record => {
    if (date === NO_DATE && record[sortBy]) return false;
    if (date !== ALL_DATES && date !== NO_DATE && record[sortBy] !== date) return false;
    return !query || Object.values(record).some(value => String(value ?? '').toLocaleLowerCase().includes(query));
  });
}

// Rebuild the date dropdown from the loaded records, keeping the current choice when it still exists.
function renderDateFilter() {
  const { sortBy, dateFilter } = activeConfig();
  const field = document.querySelector('#date-filter-field');
  const select = document.querySelector('#date-filter');
  field.hidden = !dateFilter;
  if (!dateFilter) return;
  const previous = select.value;
  const counts = new Map();
  let undated = 0;
  for (const record of state.records) {
    const date = record[sortBy];
    if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
    else undated += 1;
  }
  select.replaceChildren(new Option('All dates', ALL_DATES));
  for (const [date, count] of [...counts].sort(([a], [b]) => b.localeCompare(a))) {
    select.append(new Option(`${formatValue(sortBy, date)} (${count})`, date));
  }
  if (undated) select.append(new Option(`No date (${undated})`, NO_DATE));
  select.value = [...select.options].some(option => option.value === previous) ? previous : ALL_DATES;
}

function render() {
  const config = activeConfig();
  const records = filteredRecords();
  document.querySelector('#page-title').textContent = config.title;
  document.querySelector('#breadcrumb-current').textContent = config.title;
  document.querySelector('#page-description').textContent = config.description;
  document.querySelector('#result-count').textContent = `${records.length} ${records.length === 1 ? 'record' : 'records'}`;
  renderOngoing();
  const listHeading = document.querySelector('#list-heading');
  listHeading.textContent = config.listHeading ?? '';
  listHeading.hidden = !config.listHeading;
  listElement.replaceChildren();
  listElement.setAttribute('aria-busy', 'false');

  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('h2');
    title.textContent = state.records.length ? 'No matching records' : 'Nothing here yet';
    const detail = document.createElement('p');
    detail.textContent = state.records.length ? 'Try another search term or date.' :`Add a ${config.title.toLocaleLowerCase()} record to get started.`;
    empty.append(title, detail);
    listElement.append(empty);
    return;
  }

  // Alternate between two backgrounds each time the date + provider group changes.
  let groupKey = null;
  let band = 1;
  for (const record of records) {
    const key = `${record[config.sortBy] ?? ''}|${config.groupBy ? record[config.groupBy] ?? '' : ''}`;
    if (key !== groupKey) {
      groupKey = key;
      band = band === 1 ? 0 : 1;
    }
    const item = document.createElement('article');
    item.className = `record-item record-band-${band}`;
    const header = document.createElement('div');
    header.className = 'record-item-header';
    const heading = document.createElement('h2');
    heading.textContent = formatValue(config.primary, record[config.primary]) || 'Untitled record';
    if (config.rangeCheck) {
      const inRange = rangeStatus(record[config.rangeCheck.value], record[config.rangeCheck.range]);
      if (inRange !== null) {
        const dot = document.createElement('span');
        dot.className = `range-dot ${inRange ? 'range-in' : 'range-out'}`;
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', inRange ? 'Within reference range' : 'Outside reference range');
        dot.title = inRange ? 'Within reference range' : 'Outside reference range';
        heading.prepend(dot);
      }
    }
    const actions = document.createElement('div');
    actions.className = 'record-actions';
    const editButton = document.createElement('button');
    editButton.className = 'text-button';
    editButton.type = 'button';
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => openDialog(record));
    const deleteButton = document.createElement('button');
    deleteButton.className = 'text-button text-button-danger';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => deleteRecord(record));
    if (config.trends) actions.append(trendButton(state.records, record));
    actions.append(editButton, deleteButton);
    header.append(heading, actions);

    const details = document.createElement('dl');
    details.className = config.detailColumns === 2 ? 'record-details details-two-col' : 'record-details';
    for (const field of config.fields) {
      const value = record[field.name];
      // Vitals are shown in the Test section instead of the main detail list.
      if (field.name === config.primary || field.group === 'vitals' || value === null || value === undefined || value === '') continue;
      // With a file attached, the "View report" link below replaces a placeholder note.
      if (config.file && record[config.file.name] && /^see report\.?$/i.test(String(value).trim())) continue;
      const group = document.createElement('div');
      group.className = field.multiline ? 'detail-group detail-wide' : 'detail-group';
      const term = document.createElement('dt');
      term.textContent = field.label;
      const description = document.createElement('dd');
      description.textContent = formatValue(field.name, value);
      const profileUrl = field.choices?.profiles && safeUrl(state.providerLinks.get(String(value).trim()));
      if (profileUrl) {
        const profile = document.createElement('a');
        profile.className = 'profile-link';
        profile.href = profileUrl;
        profile.target = '_blank';
        profile.rel = 'noopener noreferrer';
        profile.title = `Open ${value}'s profile`;
        profile.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
        profile.append('Profile');
        description.append(' ', profile);
      }
      group.append(term, description);
      details.append(group);
    }
    const filePath = config.file && record[config.file.name];
    if (filePath) {
      const group = document.createElement('div');
      group.className = 'detail-group';
      const term = document.createElement('dt');
      term.textContent = config.file.label;
      const description = document.createElement('dd');
      const url = state.fileUrls[filePath];
      if (url) {
        const link = document.createElement('a');
        link.className = 'file-link';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.append(actionLabel('View report', 'Report'));
        link.title = fileName(filePath);
        description.append(link);
      } else {
        description.textContent = 'File unavailable';
      }
      group.append(term, description);
      details.append(group);
    }
    item.append(header, details);
    const blocks = linkedBlocks(config, record);
    if (blocks.length) {
      const grid = document.createElement('div');
      grid.className = 'linked-grid';
      grid.append(...blocks);
      item.append(grid);
    }
    listElement.append(item);
  }
}

// Still being taken: no end date, or a duration that says to continue.
function isOngoing(medication) {
  return !medication.end_date || /^contin/i.test(String(medication.duration ?? '').trim());
}

// A panel of current medicines, one per medicine name, keeping the most recent prescription.
function renderOngoing() {
  const panel = document.querySelector('#current-meds');
  const grid = document.querySelector('#current-meds-grid');
  panel.hidden = !activeConfig().ongoing;
  if (panel.hidden) return;

  const latest = new Map();
  for (const medication of state.records) {
    if (!isOngoing(medication)) continue;
    const name = String(medication.medicine ?? '').trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const seen = latest.get(key);
    if (!seen || String(medication.start_date ?? '') > String(seen.start_date ?? '')) latest.set(key, medication);
  }
  const current = [...latest.values()].sort((a, b) => String(a.medicine).localeCompare(String(b.medicine)));

  panel.hidden = !current.length;
  document.querySelector('#current-meds-count').textContent = current.length ? `${current.length}` : '';
  grid.replaceChildren();
  for (const medication of current) {
    const card = document.createElement('div');
    card.className = 'current-card';
    const name = document.createElement('p');
    name.className = 'current-name';
    name.textContent = medication.strength ? `${medication.medicine} - ${medication.strength}` : medication.medicine;
    card.append(name);
    if (medication.dosage) {
      const dosage = document.createElement('p');
      dosage.className = 'current-dosage';
      dosage.textContent = medication.dosage;
      card.append(dosage);
    }
    grid.append(card);
  }
}

// Full wording on desktop, a shorter label on phone screens.
function actionLabel(long, short) {
  const fragment = document.createDocumentFragment();
  const longLabel = document.createElement('span');
  longLabel.className = 'label-long';
  longLabel.textContent = long;
  const shortLabel = document.createElement('span');
  shortLabel.className = 'label-short';
  shortLabel.textContent = short;
  fragment.append(longLabel, shortLabel);
  return fragment;
}

function trendButton(allRecords, record) {
  const button = document.createElement('button');
  button.className = 'text-button trend-button';
  button.type = 'button';
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 15 3.5-4 3 2.5L17 9"/></svg>';
  button.append(actionLabel('View trends', 'Trend'));
  button.addEventListener('click', () => openTrends(allRecords, record));
  return button;
}

// "Leflunomide (Napa) - 10 mg, 7 days" with the dosage on the line below.
function rxLine(medication) {
  const parts = [medication.medicine || 'Unnamed medicine'];
  if (medication.brand) parts.push(` (${medication.brand})`);
  const tail = [medication.strength, medication.duration || dateSpan(medication)].filter(Boolean);
  const line = document.createElement('p');
  line.className = 'linked-line';
  line.textContent = parts.join('') + (tail.length ? ` - ${tail.join(', ')}` : '');
  const entry = document.createElement('div');
  entry.className = 'linked-entry';
  entry.append(line);
  if (medication.dosage) {
    const dosage = document.createElement('p');
    dosage.className = 'linked-sub';
    dosage.textContent = medication.dosage;
    entry.append(dosage);
  }
  return entry;
}

function dateSpan(medication) {
  if (!medication.start_date || !medication.end_date) return '';
  return `${formatValue('start_date', medication.start_date)} – ${formatValue('end_date', medication.end_date)}`;
}

// Test name plus its report link, when one is attached.
function testLine(lab) {
  const entry = document.createElement('div');
  entry.className = 'linked-entry';
  const line = document.createElement('p');
  line.className = 'linked-line';
  line.textContent = lab.test_name || 'Unnamed test';
  const url = lab.report_path && state.fileUrls[lab.report_path];
  if (url) {
    const link = document.createElement('a');
    link.className = 'file-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.append(actionLabel('View report', 'Report'));
    link.title = fileName(lab.report_path);
    line.append(link);
  }
  // Trends compare this test across every lab result, not just this visit's.
  line.append(trendButton(state.linkedAll.lab_results ?? [], lab));
  entry.append(line);
  return entry;
}

// The Rx and Test sections of a visit note, built from records sharing the visit's key.
function linkedBlocks(config, record) {
  if (!config.linked) return [];
  const key = visitKey(record[config.sortBy], record[config.groupBy]);
  const vitals = (config.vitals ?? [])
    .map(name => ({ field: config.fields.find(item => item.name === name), value: record[name] }))
    .filter(item => item.value);
  const blocks = [];

  for (const source of config.linked) {
    const rows = key ? state.linked[source.table]?.get(key) ?? [] : [];
    const showVitals = source.kind === 'test' && vitals.length;
    if (!rows.length && !showVitals) continue;

    const block = document.createElement('section');
    block.className = 'linked-block';
    const title = document.createElement('h3');
    title.textContent = source.title;
    if (key) {
      const tag = document.createElement('span');
      tag.className = 'linked-key';
      tag.title = 'Visit ID: date and the last 3 letters of the provider';
      tag.textContent = key;
      title.append(tag);
    }
    block.append(title);

    if (showVitals) {
      const list = document.createElement('dl');
      list.className = 'vitals-list';
      for (const { field, value } of vitals) {
        const group = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = field.label;
        const description = document.createElement('dd');
        description.textContent = value;
        group.append(term, description);
        list.append(group);
      }
      block.append(list);
    }

    for (const row of rows) block.append(source.kind === 'rx' ? rxLine(row) : testLine(row));
    blocks.push(block);
  }
  return blocks;
}

async function loadRecords() {
  listElement.setAttribute('aria-busy', 'true');
  listElement.innerHTML = '<div class="loading-state">Loading records…</div>';
  setNotice('');
  const { table, sortBy, groupBy } = activeConfig();
  // Most recent date first; rows sharing a date and provider stay next to each other.
  let query = supabase.from(table).select('*').order(sortBy, { ascending: false, nullsFirst: false });
  if (groupBy) query = query.order(groupBy, { ascending: true, nullsFirst: false });
  const { data, error } = await query;
  if (error) {
    setConnection(false);
    state.records = [];
    listElement.setAttribute('aria-busy', 'false');
    setNotice(`Could not load ${activeConfig().table}: ${error.message}. Check the table name, columns, and Supabase policies.`);
    renderDateFilter();
    render();
    return;
  }
  setConnection(true);
  state.records = data ?? [];
  await loadLinked();
  await Promise.all([loadFileUrls(), loadProviderLinks()]);
  renderDateFilter();
  state.counts[state.section] = state.records.length;
  document.querySelector(`#count-${state.section}`).textContent = String(state.records.length);
  render();
  await loadOtherCounts();
}

// The bucket is private, so each file gets a temporary signed link (valid 1 hour).
async function loadFileUrls() {
  state.fileUrls = {};
  const { file } = activeConfig();
  const paths = file ? state.records.map(record => record[file.name]).filter(Boolean) : [];
  // Lab reports shown inside a visit note's Test section need links too.
  for (const byKey of Object.values(state.linked)) {
    for (const rows of byKey.values()) {
      for (const row of rows) if (row.report_path) paths.push(row.report_path);
    }
  }
  if (!paths.length) return;
  const { data } = await supabase.storage.from(REPORT_BUCKET).createSignedUrls(paths, 60 * 60);
  for (const item of data ?? []) {
    if (item.signedUrl) state.fileUrls[item.path] = item.signedUrl;
  }
}

async function loadOtherCounts() {
  for (const [section, config] of Object.entries(sectionConfig)) {
    if (section === state.section) continue;
    const { count } = await supabase.from(config.table).select('*', { count: 'exact', head: true });
    if (count !== null && count !== undefined) {
      state.counts[section] = count;
      document.querySelector(`#count-${section}`).textContent = String(count);
    }
  }
}

// Values already used for a dropdown field, plus related values to fill in when one is picked.
async function loadChoices(choices) {
  const results = await Promise.all(choices.sources.map(source =>
    supabase.from(source.table).select([source.column, ...(source.fills ?? [])].join(', '))
  ));
  const names = new Set();
  const fills = new Map();
  choices.sources.forEach((source, index) => {
    for (const row of results[index].data ?? []) {
      const name = row[source.column]?.trim();
      if (!name) continue;
      names.add(name);
      const known = fills.get(name) ?? {};
      for (const column of source.fills ?? []) if (row[column]) known[column] = row[column];
      fills.set(name, known);
    }
  });
  return { names: [...names].sort((a, b) => a.localeCompare(b)), fills };
}

function choiceField(field, currentValue, options) {
  const { noun } = field.choices;
  const wrapper = document.createElement('div');
  wrapper.className = 'form-field';
  const label = document.createElement('label');
  label.textContent = field.label;
  label.htmlFor = `field-${field.name}`;

  const select = document.createElement('select');
  select.id = `field-${field.name}`;
  select.name = field.name;
  if (field.required) select.required = true;
  const names = currentValue && !options.names.includes(currentValue) ? [...options.names, currentValue] : options.names;
  select.append(new Option(`Select a ${noun}`, ''));
  for (const name of names) select.append(new Option(name, name));
  select.append(new Option(`+ Add new ${noun}…`, NEW_CHOICE));
  select.value = currentValue ?? '';

  const newName = document.createElement('input');
  newName.type = 'text';
  newName.name = `${field.name}${NEW_CHOICE}`;
  newName.placeholder = `New ${noun}`;
  newName.setAttribute('aria-label', `New ${noun}`);
  newName.hidden = true;

  let profile = null;
  if (field.choices.profiles) {
    profile = document.createElement('input');
    profile.type = 'url';
    profile.name = `${field.name}__profile`;
    profile.placeholder = 'Profile link (optional), https://…';
    profile.setAttribute('aria-label', `${field.label} profile link`);
    profile.value = state.providerLinks.get(currentValue?.trim()) ?? '';
  }

  select.addEventListener('change', () => {
    const adding = select.value === NEW_CHOICE;
    newName.hidden = !adding;
    newName.required = adding;
    if (adding) newName.focus();
    if (profile) profile.value = state.providerLinks.get(select.value) ?? '';
    // Fill related fields (e.g. specialization, unit, range) only when they are still empty.
    for (const [column, value] of Object.entries(options.fills.get(select.value) ?? {})) {
      const target = form.querySelector(`[name="${column}"]`);
      if (target && !target.value) target.value = value;
    }
  });

  wrapper.append(label, select, newName);
  if (profile) wrapper.append(profile);
  return wrapper;
}

async function openDialog(record = null) {
  state.editing = record;
  const config = activeConfig();
  document.querySelector('#dialog-title').textContent = record ? 'Edit record' : 'Add record';
  document.querySelector('#save-button').textContent = record ? 'Save changes' : 'Save record';
  const choiceFields = config.fields.filter(field => field.choices);
  const choiceOptions = new Map(await Promise.all(choiceFields.map(async field => [field.name, await loadChoices(field.choices)])));
  const fieldsContainer = document.querySelector('#form-fields');
  fieldsContainer.replaceChildren();
  for (const field of config.fields) {
    if (field.choices) {
      fieldsContainer.append(choiceField(field, record?.[field.name], choiceOptions.get(field.name)));
      continue;
    }
    const wrapper = document.createElement('label');
    wrapper.className = field.multiline ? 'form-field form-field-wide' : 'form-field';
    const label = document.createElement('span');
    label.textContent = field.label;
    const control = document.createElement(field.multiline ? 'textarea' : 'input');
    control.name = field.name;
    if (!field.multiline) control.type = field.type || 'text';
    if (field.required) control.required = true;
    control.value = record?.[field.name] ?? '';
    wrapper.append(label, control);
    fieldsContainer.append(wrapper);
  }
  if (config.file) {
    const wrapper = document.createElement('label');
    wrapper.className = 'form-field form-field-wide';
    const label = document.createElement('span');
    label.textContent = `${config.file.label} (PDF or image, up to 20 MB)`;
    const control = document.createElement('input');
    control.type = 'file';
    control.name = 'upload_file';
    control.accept = 'application/pdf,image/*';
    wrapper.append(label, control);
    fieldsContainer.append(wrapper);

    const currentPath = record?.[config.file.name];
    if (currentPath) {
      const current = document.createElement('label');
      current.className = 'file-current form-field-wide';
      const remove = document.createElement('input');
      remove.type = 'checkbox';
      remove.name = 'remove_file';
      const text = document.createElement('span');
      text.textContent = `Remove current file (${fileName(currentPath)}). Choosing a new file replaces it.`;
      current.append(remove, text);
      fieldsContainer.append(current);
    }
  }
  setDialogNotice('');
  dialog.showModal();
  fieldsContainer.querySelector(':is(input, select, textarea):not([hidden])')?.focus();
}

async function saveRecord(event) {
  event.preventDefault();
  const config = activeConfig();
  const formData = new FormData(form);
  const payload = Object.fromEntries(config.fields.map(field => {
    let value = formData.get(field.name);
    if (field.choices && value === NEW_CHOICE) value = String(formData.get(`${field.name}${NEW_CHOICE}`) ?? '').trim();
    return [field.name, value === '' ? null : value];
  }));
  const saveButton = document.querySelector('#save-button');
  const oldPath = config.file ? state.editing?.[config.file.name] ?? null : null;
  const upload = config.file ? form.querySelector('[name="upload_file"]').files[0] : null;
  const removeFile = Boolean(form.querySelector('[name="remove_file"]')?.checked);
  let newPath = null;
  setDialogNotice('');

  if (upload) {
    if (upload.size > MAX_FILE_BYTES) {
      setDialogNotice('That file is larger than 20 MB. Choose a smaller file or a lower-resolution photo.');
      return;
    }
    saveButton.disabled = true;
    saveButton.textContent = 'Uploading…';
    const safeName = upload.name.replace(/[^\w.\-]+/g, '_');
    newPath = `${state.userId}/${crypto.randomUUID()}/${safeName}`;
    const { error } = await supabase.storage.from(REPORT_BUCKET).upload(newPath, upload, { contentType: upload.type || undefined });
    if (error) {
      saveButton.disabled = false;
      saveButton.textContent = state.editing ? 'Save changes' : 'Save record';
      setDialogNotice(`Could not upload file: ${error.message}`);
      return;
    }
    payload[config.file.name] = newPath;
  } else if (config.file) {
    payload[config.file.name] = removeFile ? null : oldPath;
  }

  saveButton.disabled = true;
  const result = state.editing
    ? await supabase.from(config.table).update(payload).eq('id', state.editing.id)
    : await supabase.from(config.table).insert(payload);
  saveButton.disabled = false;
  saveButton.textContent = state.editing ? 'Save changes' : 'Save record';
  if (result.error) {
    if (newPath) await supabase.storage.from(REPORT_BUCKET).remove([newPath]);
    setDialogNotice(`Could not save record: ${result.error.message}`);
    return;
  }
  if (oldPath && (newPath || removeFile)) await supabase.storage.from(REPORT_BUCKET).remove([oldPath]);
  const profileError = await saveProfileLinks(config, payload, formData);
  dialog.close();
  form.reset();
  setNotice(state.editing ? 'Record updated.' : 'Record added.', 'success');
  state.editing = null;
  await loadRecords();
  if (profileError) setNotice(`Record saved, but the profile link could not be saved: ${profileError}`);
}

// Store a provider's profile link once (shared by every record with that name) when it changed.
// Returns an error message, or null on success.
async function saveProfileLinks(config, payload, formData) {
  for (const field of config.fields.filter(item => item.choices?.profiles)) {
    const name = payload[field.name]?.trim();
    if (!name) continue;
    const link = String(formData.get(`${field.name}__profile`) ?? '').trim();
    if (link === (state.providerLinks.get(name) ?? '')) continue;
    const { error } = await supabase.from('providers').upsert({ name, profile_url: link || null }, { onConflict: 'user_id,name' });
    if (error) return error.message;
  }
  return null;
}

async function deleteRecord(record) {
  if (!record.id || !window.confirm('Delete this record? This cannot be undone.')) return;
  const config = activeConfig();
  const { error } = await supabase.from(config.table).delete().eq('id', record.id);
  if (error) {
    setNotice(`Could not delete record: ${error.message}. Check your table id and Supabase write policies.`);
    return;
  }
  const filePath = config.file && record[config.file.name];
  if (filePath) await supabase.storage.from(REPORT_BUCKET).remove([filePath]);
  setNotice('Record deleted.', 'success');
  await loadRecords();
}

document.querySelectorAll('[data-section]').forEach(button => {
  button.addEventListener('click', () => {
    state.section = button.dataset.section;
    document.querySelectorAll('[data-section]').forEach(item => item.classList.toggle('is-active', item === button));
    document.querySelector('#search-input').value = '';
    document.querySelector('#date-filter').value = ALL_DATES;
    loadRecords();
  });
});
document.querySelector('#add-button').addEventListener('click', () => openDialog());
document.querySelector('#refresh-button').addEventListener('click', loadRecords);
document.querySelector('#search-input').addEventListener('input', render);
document.querySelector('#date-filter').addEventListener('change', render);
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
document.querySelector('#cancel-button').addEventListener('click', () => dialog.close());
form.addEventListener('submit', saveRecord);
dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});

function showSignedIn(signedIn) {
  document.querySelector('#login-screen').hidden = signedIn;
  document.querySelector('#app-shell').hidden = !signedIn;
}

// Show one card on the sign-in screen: 'login', 'forgot' or 'reset'.
function showAuthCard(name) {
  showSignedIn(false);
  for (const card of ['login', 'forgot', 'reset']) {
    document.querySelector(`#${card}-form`).hidden = card !== name;
  }
  document.querySelector(`#${name}-form input`)?.focus();
}

function setAuthNotice(id, message, kind = 'error') {
  const element = document.querySelector(id);
  element.textContent = message;
  element.className = `notice notice-${kind}`;
  element.hidden = !message;
}

async function sendResetLink(event) {
  event.preventDefault();
  const button = document.querySelector('#forgot-button');
  const email = new FormData(event.target).get('email');
  button.disabled = true;
  setAuthNotice('#forgot-notice', '');
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}${location.pathname}` });
  button.disabled = false;
  if (error) {
    setAuthNotice('#forgot-notice', `Could not send the reset link: ${error.message}`);
    return;
  }
  setAuthNotice('#forgot-notice', 'If this email has an account, a reset link is on its way. Check your inbox and spam folder; the link works once.', 'success');
}

async function saveNewPassword(event) {
  event.preventDefault();
  const button = document.querySelector('#reset-button');
  const values = new FormData(event.target);
  const password = values.get('password');
  if (password !== values.get('confirm')) {
    setAuthNotice('#reset-notice', 'The two passwords do not match.');
    return;
  }
  button.disabled = true;
  setAuthNotice('#reset-notice', '');
  const { data, error } = await supabase.auth.updateUser({ password });
  button.disabled = false;
  if (error) {
    setAuthNotice('#reset-notice', `Could not save the new password: ${error.message}`);
    return;
  }
  recovering = false;
  event.target.reset();
  enterApp(data.user);
}

function enterApp(user) {
  signedIn = true;
  state.userId = user?.id ?? null;
  showSignedIn(true);
  // Defer so the Supabase auth lock is released before querying.
  setTimeout(loadRecords, 0);
}

async function signIn(event) {
  event.preventDefault();
  const loginNotice = document.querySelector('#login-notice');
  const loginButton = document.querySelector('#login-button');
  const credentials = new FormData(event.target);
  loginNotice.hidden = true;
  loginButton.disabled = true;
  const { error } = await supabase.auth.signInWithPassword({
    email: credentials.get('email'),
    password: credentials.get('password')
  });
  loginButton.disabled = false;
  if (error) {
    loginNotice.textContent = `Could not sign in: ${error.message}`;
    loginNotice.hidden = false;
  }
}

document.querySelector('#login-form').addEventListener('submit', signIn);
document.querySelector('#forgot-form').addEventListener('submit', sendResetLink);
document.querySelector('#reset-form').addEventListener('submit', saveNewPassword);
document.querySelector('#show-forgot').addEventListener('click', () => {
  document.querySelector('#forgot-form [name="email"]').value = document.querySelector('#login-form [name="email"]').value;
  setAuthNotice('#forgot-notice', '');
  showAuthCard('forgot');
});
document.querySelector('#back-to-login').addEventListener('click', () => showAuthCard('login'));
document.querySelector('#sign-out-button').addEventListener('click', () => supabase.auth.signOut());

if (authLinkError) {
  setAuthNotice('#login-notice', `That link did not work: ${authLinkError}. Request a new reset link.`);
  history.replaceState(null, '', location.pathname);
}

let signedIn = null;
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') recovering = true;
  // A reset link signs the user in; ask for the new password before showing records.
  if (recovering && session) {
    showAuthCard('reset');
    return;
  }
  const nowSignedIn = Boolean(session);
  if (nowSignedIn === signedIn) return;
  if (nowSignedIn) {
    enterApp(session.user);
    return;
  }
  signedIn = false;
  state.userId = null;
  showAuthCard('login');
  state.records = [];
  listElement.replaceChildren();
  document.querySelector('#login-form').reset();
});