import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const sectionConfig = {
  medications: {
    title: 'Medications',
    description: 'A clear list of current and past prescriptions.',
    table: 'medications',
    primary: 'medicine',
    sortBy: 'start_date',
    groupBy: 'prescriber',
    fields: [
      { name: 'medicine', label: 'Medicine', required: true },
      { name: 'strength', label: 'Strength' },
      { name: 'brand', label: 'Brand name' },
      { name: 'dosage', label: 'Dosage' },
      { name: 'prescriber', label: 'Prescriber' },
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
    file: { name: 'report_path', label: 'Report' },
    fields: [
      { name: 'test_name', label: 'Test name', required: true },
      { name: 'result', label: 'Result' },
      { name: 'unit', label: 'Unit' },
      { name: 'reference_range', label: 'Reference range' },
      { name: 'test_date', label: 'Test date', type: 'date' },
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
    fields: [
      { name: 'visit_date', label: 'Visit date', type: 'date' },
      { name: 'provider', label: 'Provider' },
      { name: 'summary', label: 'Summary' },
      { name: 'symptoms', label: 'Symptoms', multiline: true },
      { name: 'notes', label: 'Notes', multiline: true }
    ]
  }
};

const REPORT_BUCKET = 'reports';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const state = { section: 'medications', records: [], editing: null, counts: {}, fileUrls: {}, userId: null };
const listElement = document.querySelector('#record-list');
const dialog = document.querySelector('#record-dialog');
const form = document.querySelector('#record-form');
const notice = document.querySelector('#notice');
const dialogNotice = document.querySelector('#dialog-notice');

function fileName(path) {
  return path.split('/').pop();
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

function filteredRecords() {
  const query = document.querySelector('#search-input').value.trim().toLocaleLowerCase();
  if (!query) return state.records;
  return state.records.filter(record => Object.values(record).some(value => String(value ?? '').toLocaleLowerCase().includes(query)));
}

function render() {
  const config = activeConfig();
  const records = filteredRecords();
  document.querySelector('#page-title').textContent = config.title;
  document.querySelector('#breadcrumb-current').textContent = config.title;
  document.querySelector('#page-description').textContent = config.description;
  document.querySelector('#result-count').textContent = `${records.length} ${records.length === 1 ? 'record' : 'records'}`;
  listElement.replaceChildren();
  listElement.setAttribute('aria-busy', 'false');

  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('h2');
    title.textContent = state.records.length ? 'No matching records' : 'Nothing here yet';
    const detail = document.createElement('p');
    detail.textContent = state.records.length ? 'Try another search term.' : `Add a ${config.title.toLocaleLowerCase()} record to get started.`;
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
    heading.textContent = escapeText(record[config.primary]) || 'Untitled record';
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
    actions.append(editButton, deleteButton);
    header.append(heading, actions);

    const details = document.createElement('dl');
    details.className = 'record-details';
    for (const field of config.fields) {
      const value = record[field.name];
      if (field.name === config.primary || value === null || value === undefined || value === '') continue;
      // With a file attached, the "View report" link below replaces a placeholder note.
      if (config.file && record[config.file.name] && /^see report\.?$/i.test(String(value).trim())) continue;
      const group = document.createElement('div');
      group.className = field.multiline ? 'detail-group detail-wide' : 'detail-group';
      const term = document.createElement('dt');
      term.textContent = field.label;
      const description = document.createElement('dd');
      description.textContent = formatValue(field.name, value);
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
        link.textContent = 'View report';
        link.title = fileName(filePath);
        description.append(link);
      } else {
        description.textContent = 'File unavailable';
      }
      group.append(term, description);
      details.append(group);
    }
    item.append(header, details);
    listElement.append(item);
  }
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
    render();
    return;
  }
  setConnection(true);
  state.records = data ?? [];
  await loadFileUrls();
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

function openDialog(record = null) {
  state.editing = record;
  const config = activeConfig();
  document.querySelector('#dialog-title').textContent = record ? 'Edit record' : 'Add record';
  document.querySelector('#save-button').textContent = record ? 'Save changes' : 'Save record';
  const fieldsContainer = document.querySelector('#form-fields');
  fieldsContainer.replaceChildren();
  for (const field of config.fields) {
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
  fieldsContainer.querySelector('input, textarea')?.focus();
}

async function saveRecord(event) {
  event.preventDefault();
  const config = activeConfig();
  const payload = Object.fromEntries(config.fields.map(field => {
    const value = new FormData(form).get(field.name);
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
  dialog.close();
  form.reset();
  setNotice(state.editing ? 'Record updated.' : 'Record added.', 'success');
  state.editing = null;
  await loadRecords();
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
    loadRecords();
  });
});
document.querySelector('#add-button').addEventListener('click', () => openDialog());
document.querySelector('#refresh-button').addEventListener('click', loadRecords);
document.querySelector('#search-input').addEventListener('input', render);
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
document.querySelector('#sign-out-button').addEventListener('click', () => supabase.auth.signOut());

let signedIn = null;
supabase.auth.onAuthStateChange((_event, session) => {
  const nowSignedIn = Boolean(session);
  if (nowSignedIn === signedIn) return;
  signedIn = nowSignedIn;
  state.userId = session?.user.id ?? null;
  showSignedIn(signedIn);
  if (signedIn) {
    // Defer so the Supabase auth lock is released before querying.
    setTimeout(loadRecords, 0);
  } else {
    state.records = [];
    listElement.replaceChildren();
    document.querySelector('#login-form').reset();
  }
});