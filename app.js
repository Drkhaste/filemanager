import { GitHubApi, GitHubApiError } from './github-api.js';
import { loadMonaco, languageForPath, isLikelyBinary } from './editor.js';
import { formatJalali, relativeTime } from './jalali.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  api: null,
  user: null,
  repos: [],
  currentRepo: null,      // { owner, name, default_branch }
  branches: [],
  currentBranch: null,
  treeEntries: [],        // flat list from git tree API
  expandedDirs: new Set(),
  currentPath: null,
  currentSha: null,
  originalContent: '',
  isDirty: false,
  isPreview: false,
  monaco: null,
  editor: null,
  diffEditor: null,
  fileSearch: '',
  repoSearch: ''
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, opts = {}) => Object.assign(document.createElement(tag), opts);

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'ghfm:token';
function saveToken(token, remember) {
  if (remember) { localStorage.setItem(TOKEN_KEY, token); sessionStorage.removeItem(TOKEN_KEY); }
  else { sessionStorage.setItem(TOKEN_KEY, token); localStorage.removeItem(TOKEN_KEY); }
}
function loadToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}
function cacheKey(repo, branch) { return `ghfm:tree:${repo.full_name}:${branch}`; }
function saveTreeCache(repo, branch, tree) {
  try { localStorage.setItem(cacheKey(repo, branch), JSON.stringify({ tree, ts: Date.now() })); } catch { /* quota */ }
}
function loadTreeCache(repo, branch) {
  try {
    const raw = localStorage.getItem(cacheKey(repo, branch));
    return raw ? JSON.parse(raw).tree : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function toast(message, type = 'info') {
  const stack = $('#toast-stack');
  const t = el('div', { className: `toast${type === 'error' ? ' error' : ''}`, textContent: message });
  stack.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
function openModal({ title, fields = [], confirmLabel = 'Confirm', danger = false, onConfirm }) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const backdrop = el('div', { className: 'modal-backdrop' });
  const modal = el('div', { className: 'modal' });
  modal.appendChild(el('h2', { textContent: title }));

  const inputs = {};
  fields.forEach((f) => {
    const wrap = el('div', { className: 'field' });
    wrap.appendChild(el('label', { textContent: f.label }));
    let input;
    if (f.type === 'textarea') {
      input = el('textarea');
      if (f.value) input.value = f.value;
    } else {
      input = el('input', { type: f.type || 'text' });
      if (f.value) input.value = f.value;
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    wrap.appendChild(input);
    modal.appendChild(wrap);
    inputs[f.key] = input;
  });

  const actions = el('div', { className: 'actions' });
  const cancelBtn = el('button', { className: 'btn', textContent: 'Cancel' });
  const confirmBtn = el('button', { className: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, textContent: confirmLabel });
  if (!danger) confirmBtn.style.width = 'auto';
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  const close = () => { root.innerHTML = ''; };
  cancelBtn.onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  confirmBtn.onclick = async () => {
    const values = {};
    Object.entries(inputs).forEach(([k, i]) => { values[k] = i.value; });
    confirmBtn.disabled = true;
    try {
      await onConfirm(values, close);
    } catch (err) {
      toast(err.message || 'Something went wrong', 'error');
      confirmBtn.disabled = false;
    }
  };

  const firstInput = Object.values(inputs)[0];
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
}

// ---------------------------------------------------------------------------
// Auth / login
// ---------------------------------------------------------------------------
async function tryLogin(token, remember) {
  const api = new GitHubApi(token);
  const user = await api.getUser();
  state.api = api;
  state.user = user;
  saveToken(token, remember);
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const chip = $('#user-chip');
  chip.innerHTML = '';
  chip.appendChild(el('img', { src: user.avatar_url, alt: '' }));
  chip.appendChild(el('span', { textContent: user.login }));
  await loadRepos();
}

$('#login-btn').addEventListener('click', async () => {
  const token = $('#pat-input').value.trim();
  const remember = $('#remember-token').checked;
  const errorBox = $('#login-error');
  errorBox.classList.add('hidden');
  if (!token) { errorBox.textContent = 'Enter a token first.'; errorBox.classList.remove('hidden'); return; }
  const btn = $('#login-btn');
  btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    await tryLogin(token, remember);
  } catch (err) {
    errorBox.textContent = err.status === 401
      ? 'That token was rejected by GitHub. Check it and try again.'
      : (err.message || 'Could not connect to GitHub.');
    errorBox.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Connect to GitHub';
  }
});
$('#pat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });

$('#logout-btn').addEventListener('click', () => {
  if (state.isDirty && !confirm('You have unsaved changes. Disconnect anyway?')) return;
  clearToken();
  location.reload();
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('ghfm:theme', theme);
  if (state.monaco) state.monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
}
$('#theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(current);
});
applyTheme(localStorage.getItem('ghfm:theme') || 'dark');

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------
async function loadRepos() {
  const list = $('#repo-list');
  list.innerHTML = '<li class="tree-empty">Loading repositories…</li>';
  try {
    const repos = await state.api.listRepos();
    state.repos = repos;
    renderRepoList();
  } catch (err) {
    list.innerHTML = '';
    toast('Failed to load repositories: ' + err.message, 'error');
  }
}

function renderRepoList() {
  const list = $('#repo-list');
  list.innerHTML = '';
  const q = state.repoSearch.toLowerCase();
  const filtered = state.repos.filter((r) => r.full_name.toLowerCase().includes(q));
  if (!filtered.length) {
    list.innerHTML = '<li class="tree-empty">No repositories match.</li>';
    return;
  }
  filtered.forEach((repo) => {
    const item = el('li', { className: 'repo-item' });
    if (state.currentRepo && state.currentRepo.full_name === repo.full_name) item.classList.add('active');
    item.appendChild(el('div', { className: 'name', textContent: repo.name }));
    item.appendChild(el('div', { className: 'meta', textContent: `${repo.owner.login} · ${repo.private ? 'private' : 'public'}` }));
    item.addEventListener('click', () => selectRepo(repo));
    list.appendChild(item);
  });
}
$('#repo-search').addEventListener('input', (e) => { state.repoSearch = e.target.value; renderRepoList(); });

async function selectRepo(repo) {
  if (state.isDirty && !confirm('Discard unsaved changes and switch repository?')) return;
  state.currentRepo = repo;
  state.currentPath = null;
  state.expandedDirs = new Set();
  renderRepoList();
  showEmptyState();
  activateMobilePane('tree-pane');

  const branchSelect = $('#branch-select');
  branchSelect.innerHTML = '<option>Loading…</option>';
  try {
    const branches = await state.api.listBranches(repo.owner.login, repo.name);
    state.branches = branches;
    branchSelect.innerHTML = '';
    branches.forEach((b) => branchSelect.appendChild(el('option', { value: b.name, textContent: b.name })));
    const defaultBranch = repo.default_branch;
    branchSelect.value = branches.some((b) => b.name === defaultBranch) ? defaultBranch : branches[0]?.name;
    state.currentBranch = branchSelect.value;
    await loadTree();
  } catch (err) {
    toast('Failed to load branches: ' + err.message, 'error');
  }
}
$('#branch-select').addEventListener('change', async (e) => {
  state.currentBranch = e.target.value;
  state.currentPath = null;
  state.expandedDirs = new Set();
  showEmptyState();
  await loadTree();
});
$('#refresh-tree-btn').addEventListener('click', () => loadTree(true));

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------
async function loadTree(forceFresh = false) {
  const repo = state.currentRepo;
  const branch = state.currentBranch;
  if (!repo || !branch) return;

  const cached = !forceFresh ? loadTreeCache(repo, branch) : null;
  if (cached) {
    state.treeEntries = cached;
    renderTree();
  } else {
    $('#file-tree').innerHTML = '<div class="tree-loading">Loading files…</div>';
  }

  try {
    const data = await state.api.getTree(repo.owner.login, repo.name, branch);
    state.treeEntries = data.tree;
    saveTreeCache(repo, branch, data.tree);
    renderTree();
    if (data.truncated) toast('This repository is large — the file list was truncated by GitHub.', 'error');
  } catch (err) {
    if (!cached) $('#file-tree').innerHTML = `<div class="tree-empty">Failed to load: ${err.message}</div>`;
    else toast('Could not refresh file list: ' + err.message, 'error');
  }
}

function buildChildrenMap() {
  const map = new Map(); // parentPath ('' for root) -> [entries]
  state.treeEntries.forEach((entry) => {
    const idx = entry.path.lastIndexOf('/');
    const parent = idx === -1 ? '' : entry.path.slice(0, idx);
    if (!map.has(parent)) map.set(parent, []);
    map.get(parent).push(entry);
  });
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }
  return map;
}

function renderTree() {
  const container = $('#file-tree');
  container.innerHTML = '';

  if (state.fileSearch.trim()) {
    const q = state.fileSearch.toLowerCase();
    const matches = state.treeEntries.filter((e) => e.type === 'blob' && e.path.toLowerCase().includes(q));
    if (!matches.length) { container.innerHTML = '<div class="tree-empty">No files match your search.</div>'; return; }
    matches.slice(0, 300).forEach((entry) => container.appendChild(renderRow(entry, 0, entry.path.split('/').pop())));
    return;
  }

  const childrenMap = buildChildrenMap();
  if (!state.treeEntries.length) { container.innerHTML = '<div class="tree-empty">This repository has no files on this branch.</div>'; return; }

  function walk(parentPath, depth) {
    const children = childrenMap.get(parentPath) || [];
    children.forEach((entry) => {
      const label = entry.path.split('/').pop();
      container.appendChild(renderRow(entry, depth, label));
      if (entry.type === 'tree' && state.expandedDirs.has(entry.path)) {
        walk(entry.path, depth + 1);
      }
    });
  }
  walk('', 0);
  renderBreadcrumbs();
}

function renderRow(entry, depth, label) {
  const row = el('div', { className: `tree-row ${entry.type === 'tree' ? 'dir' : 'file'}` });
  row.style.paddingLeft = `${8 + depth * 14}px`;
  if (entry.path === state.currentPath) row.classList.add('active');
  const arrow = entry.type === 'tree' ? (state.expandedDirs.has(entry.path) ? '▾' : '▸') : fileIcon(label);
  row.appendChild(el('span', { className: 'ico', textContent: arrow }));
  row.appendChild(el('span', { textContent: label }));
  row.title = entry.path;
  row.addEventListener('click', () => {
    if (entry.type === 'tree') {
      if (state.expandedDirs.has(entry.path)) state.expandedDirs.delete(entry.path);
      else state.expandedDirs.add(entry.path);
      renderTree();
    } else {
      openFile(entry.path, entry.sha);
    }
  });
  return row;
}

function fileIcon(name) {
  if (/\.(md|markdown)$/i.test(name)) return '≡';
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(name)) return '▧';
  if (/\.json$/i.test(name)) return '{}';
  return '·';
}

$('#file-search').addEventListener('input', (e) => { state.fileSearch = e.target.value; renderTree(); });

function renderBreadcrumbs() {
  const bar = $('#breadcrumbs');
  bar.innerHTML = '';
  if (!state.currentRepo) return;
  const root = el('span', { textContent: state.currentRepo.name });
  root.addEventListener('click', () => { state.expandedDirs = new Set(); renderTree(); });
  bar.appendChild(root);
  if (!state.currentPath) return;
  const parts = state.currentPath.split('/');
  parts.forEach((part, i) => {
    bar.appendChild(el('span', { className: 'sep', textContent: '/' }));
    const dirPath = parts.slice(0, i + 1).join('/');
    const isLast = i === parts.length - 1;
    const span = el('span', { textContent: part });
    if (!isLast) {
      span.addEventListener('click', () => {
        let acc = '';
        parts.slice(0, i + 1).forEach((p) => { acc = acc ? `${acc}/${p}` : p; state.expandedDirs.add(acc); });
        renderTree();
      });
    }
    bar.appendChild(span);
  });
}

// ---------------------------------------------------------------------------
// File open / edit / save
// ---------------------------------------------------------------------------
function showEmptyState() {
  $('#empty-state').classList.remove('hidden');
  $('#editor-view').classList.add('hidden');
  $('#diff-view').classList.add('hidden');
  $('#history-view').classList.add('hidden');
  $('#main-tabs').classList.add('hidden');
  state.currentPath = null;
  setDirty(false);
}

function setDirty(dirty) {
  state.isDirty = dirty;
  $('#editor-toolbar').classList.toggle('dirty', dirty);
}

async function openFile(path, knownSha) {
  if (state.isDirty && !confirm('Discard unsaved changes to the current file?')) return;
  const repo = state.currentRepo;
  $('#empty-state').classList.add('hidden');
  $('#main-tabs').classList.remove('hidden');
  $('#history-view').classList.add('hidden');
  $('#diff-view').classList.add('hidden');
  switchMainTab('editor');
  activateMobilePane('main-pane');

  if (isLikelyBinary(path)) {
    $('#editor-view').classList.remove('hidden');
    $('#current-path').textContent = path;
    state.currentPath = path;
    renderTree();
    const host = $('#monaco-host');
    host.innerHTML = '<div style="padding:24px;color:var(--text-2);">Binary file — preview isn\'t supported. Use Download to save it locally.</div>';
    $('#md-preview').classList.add('hidden');
    host.classList.remove('hidden');
    setDirty(false);
    return;
  }

  $('#current-path').textContent = path + ' — loading…';
  try {
    const file = await state.api.getFileContent(repo.owner.login, repo.name, path, state.currentBranch);
    state.currentPath = path;
    state.currentSha = file.sha;
    state.originalContent = file.content;
    $('#current-path').textContent = path;
    renderTree();
    renderBreadcrumbs();
    await ensureEditor();
    const model = state.monaco.editor.createModel(file.content, languageForPath(path));
    state.editor.setModel(model);
    $('#editor-view').classList.remove('hidden');
    $('#monaco-host').classList.remove('hidden');
    $('#md-preview').classList.add('hidden');
    state.isPreview = false;
    setDirty(false);
  } catch (err) {
    toast('Could not open file: ' + err.message, 'error');
    $('#current-path').textContent = path;
  }
}

async function ensureEditor() {
  if (state.editor) return;
  const monaco = await loadMonaco();
  state.monaco = monaco;
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
  state.editor = monaco.editor.create($('#monaco-host'), {
    automaticLayout: true,
    theme,
    minimap: { enabled: window.innerWidth > 900 },
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    scrollBeyondLastLine: false
  });
  state.editor.onDidChangeModelContent(() => {
    const model = state.editor.getModel();
    if (!model) return;
    setDirty(model.getValue() !== state.originalContent);
    if (state.isPreview) renderMarkdownPreview();
  });
}

function renderMarkdownPreview() {
  const model = state.editor.getModel();
  if (!model) return;
  $('#md-preview').innerHTML = window.marked ? window.marked.parse(model.getValue()) : model.getValue();
}

$('#preview-toggle-btn').addEventListener('click', () => {
  if (!state.currentPath || !/\.(md|markdown)$/i.test(state.currentPath)) {
    toast('Preview is available for Markdown files.');
    return;
  }
  state.isPreview = !state.isPreview;
  $('#md-preview').classList.toggle('hidden', !state.isPreview);
  $('#monaco-host').classList.toggle('hidden', state.isPreview);
  if (state.isPreview) renderMarkdownPreview();
});

$('#save-btn').addEventListener('click', () => {
  if (!state.currentPath) return;
  const model = state.editor?.getModel();
  if (!model) return;
  openModal({
    title: 'Commit changes',
    fields: [{ key: 'message', label: 'Commit message', type: 'textarea', value: `Update ${state.currentPath}` }],
    confirmLabel: 'Commit',
    onConfirm: async ({ message }, close) => {
      const repo = state.currentRepo;
      const result = await state.api.createOrUpdateFile(
        repo.owner.login, repo.name, state.currentPath, model.getValue(),
        message || `Update ${state.currentPath}`, state.currentBranch, state.currentSha
      );
      state.currentSha = result.content.sha;
      state.originalContent = model.getValue();
      setDirty(false);
      close();
      toast('Committed successfully.');
      loadTree(true);
    }
  });
});

$('#download-btn').addEventListener('click', () => {
  if (!state.currentPath) return;
  const content = state.editor?.getModel()?.getValue() ?? state.originalContent;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: state.currentPath.split('/').pop() });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

$('#delete-file-btn').addEventListener('click', () => {
  if (!state.currentPath) return;
  openModal({
    title: `Delete ${state.currentPath}?`,
    fields: [{ key: 'message', label: 'Commit message', value: `Delete ${state.currentPath}` }],
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async ({ message }, close) => {
      const repo = state.currentRepo;
      await state.api.deleteFile(repo.owner.login, repo.name, state.currentPath, message || `Delete ${state.currentPath}`, state.currentBranch, state.currentSha);
      close();
      toast('File deleted.');
      showEmptyState();
      loadTree(true);
    }
  });
});

$('#rename-btn').addEventListener('click', () => {
  if (!state.currentPath) return;
  openModal({
    title: 'Rename / move file',
    fields: [
      { key: 'newPath', label: 'New path', value: state.currentPath },
      { key: 'message', label: 'Commit message', value: `Rename ${state.currentPath}` }
    ],
    confirmLabel: 'Rename',
    onConfirm: async ({ newPath, message }, close) => {
      if (!newPath || newPath === state.currentPath) { close(); return; }
      const repo = state.currentRepo;
      const entry = state.treeEntries.find((e) => e.path === state.currentPath);
      await state.api.renameOrMove(
        repo.owner.login, repo.name, state.currentBranch,
        state.currentPath, newPath, entry.sha, entry.mode, message || `Rename ${state.currentPath} to ${newPath}`
      );
      close();
      toast('Renamed successfully.');
      showEmptyState();
      await loadTree(true);
      openFile(newPath);
    }
  });
});

// ---------------------------------------------------------------------------
// Create file / folder / upload
// ---------------------------------------------------------------------------
function currentDir() {
  if (!state.currentPath) return '';
  const idx = state.currentPath.lastIndexOf('/');
  return idx === -1 ? '' : state.currentPath.slice(0, idx);
}

$('#new-file-btn').addEventListener('click', () => {
  if (!state.currentRepo) { toast('Select a repository first.'); return; }
  const dir = currentDir();
  openModal({
    title: 'Create new file',
    fields: [{ key: 'path', label: 'File path', value: dir ? `${dir}/` : '', placeholder: 'folder/example.txt' }],
    confirmLabel: 'Create',
    onConfirm: async ({ path }, close) => {
      if (!path.trim()) throw new Error('Enter a file path.');
      const repo = state.currentRepo;
      await state.api.createOrUpdateFile(repo.owner.login, repo.name, path.trim(), '', `Create ${path.trim()}`, state.currentBranch);
      close();
      toast('File created.');
      await loadTree(true);
      openFile(path.trim());
    }
  });
});

$('#new-folder-btn').addEventListener('click', () => {
  if (!state.currentRepo) { toast('Select a repository first.'); return; }
  const dir = currentDir();
  openModal({
    title: 'Create new folder',
    fields: [{ key: 'path', label: 'Folder path', value: dir ? `${dir}/` : '', placeholder: 'folder/subfolder' }],
    confirmLabel: 'Create',
    onConfirm: async ({ path }, close) => {
      if (!path.trim()) throw new Error('Enter a folder path.');
      const repo = state.currentRepo;
      await state.api.createFolderPlaceholder(repo.owner.login, repo.name, path.trim().replace(/\/$/, ''), state.currentBranch);
      close();
      toast('Folder created.');
      loadTree(true);
    }
  });
});

$('#upload-btn').addEventListener('click', () => $('#upload-input').click());
$('#upload-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !state.currentRepo) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    const dir = currentDir();
    const targetPath = dir ? `${dir}/${file.name}` : file.name;
    openModal({
      title: 'Upload file',
      fields: [
        { key: 'path', label: 'Destination path', value: targetPath },
        { key: 'message', label: 'Commit message', value: `Upload ${file.name}` }
      ],
      confirmLabel: 'Upload',
      onConfirm: async ({ path, message }, close) => {
        const repo = state.currentRepo;
        await state.api.uploadBinaryFile(repo.owner.login, repo.name, path.trim(), base64, message || `Upload ${path}`, state.currentBranch);
        close();
        toast('Uploaded successfully.');
        loadTree(true);
      }
    });
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// ---------------------------------------------------------------------------
// Tabs: editor / history
// ---------------------------------------------------------------------------
function switchMainTab(tab) {
  document.querySelectorAll('.main-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#editor-view').classList.toggle('hidden', tab !== 'editor');
  $('#history-view').classList.toggle('hidden', tab !== 'history');
  $('#diff-view').classList.add('hidden');
  if (tab === 'history') loadHistory();
}
document.querySelectorAll('.main-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchMainTab(btn.dataset.tab));
});

async function loadHistory() {
  const panel = $('#history-view');
  panel.innerHTML = '<div class="tree-loading">Loading history…</div>';
  const repo = state.currentRepo;
  try {
    const commits = await state.api.listCommitsForPath(repo.owner.login, repo.name, state.currentPath, state.currentBranch);
    panel.innerHTML = '';
    if (!commits.length) { panel.innerHTML = '<div class="tree-empty">No commit history found for this file.</div>'; return; }
    commits.forEach((c, idx) => {
      const row = el('div', { className: 'commit-row' });
      const info = el('div');
      info.appendChild(el('div', { className: 'msg', textContent: c.commit.message.split('\n')[0] }));
      const date = c.commit.author?.date || c.commit.committer?.date;
      info.appendChild(el('div', {
        className: 'meta',
        textContent: `${c.sha.slice(0, 7)} · ${c.commit.author?.name || 'unknown'} · ${relativeTime(date)} · ${formatJalali(date, 'numeric')}`
      }));
      row.appendChild(info);
      const actions = el('div', { className: 'actions' });
      const viewBtn = el('button', { className: 'btn', textContent: 'View diff' });
      viewBtn.addEventListener('click', () => openDiff(c.sha, commits[idx + 1]?.sha));
      const restoreBtn = el('button', { className: 'btn', textContent: 'Restore' });
      restoreBtn.addEventListener('click', () => restoreVersion(c.sha));
      actions.appendChild(viewBtn);
      actions.appendChild(restoreBtn);
      row.appendChild(actions);
      panel.appendChild(row);
    });
  } catch (err) {
    panel.innerHTML = `<div class="tree-empty">Failed to load history: ${err.message}</div>`;
  }
}

async function openDiff(newerSha, olderSha) {
  const repo = state.currentRepo;
  $('#editor-view').classList.add('hidden');
  $('#history-view').classList.add('hidden');
  $('#diff-view').classList.remove('hidden');
  $('#diff-host').innerHTML = '';
  try {
    const newer = await state.api.getContentAtRef(repo.owner.login, repo.name, state.currentPath, newerSha);
    let olderContent = '';
    if (olderSha) {
      try {
        const older = await state.api.getContentAtRef(repo.owner.login, repo.name, state.currentPath, olderSha);
        olderContent = older.content;
      } catch { olderContent = ''; }
    }
    await ensureEditor();
    const monaco = state.monaco;
    if (!state.diffEditor) {
      state.diffEditor = monaco.editor.createDiffEditor($('#diff-host'), {
        automaticLayout: true,
        readOnly: true,
        theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark'
      });
    }
    const lang = languageForPath(state.currentPath);
    state.diffEditor.setModel({
      original: monaco.editor.createModel(olderContent, lang),
      modified: monaco.editor.createModel(newer.content, lang)
    });
  } catch (err) {
    toast('Could not load diff: ' + err.message, 'error');
    switchMainTab('history');
  }
}

async function restoreVersion(sha) {
  if (!confirm('Restore this version? This will create a new commit with the old content.')) return;
  const repo = state.currentRepo;
  try {
    const old = await state.api.getContentAtRef(repo.owner.login, repo.name, state.currentPath, sha);
    const current = await state.api.getFileContent(repo.owner.login, repo.name, state.currentPath, state.currentBranch);
    await state.api.createOrUpdateFile(
      repo.owner.login, repo.name, state.currentPath, old.content,
      `Restore ${state.currentPath} to ${sha.slice(0, 7)}`, state.currentBranch, current.sha
    );
    toast('Version restored.');
    openFile(state.currentPath);
    switchMainTab('editor');
  } catch (err) {
    toast('Restore failed: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Mobile pane switching
// ---------------------------------------------------------------------------
function activateMobilePane(paneId) {
  if (window.innerWidth > 860) return;
  ['rail', 'tree-pane', 'main-pane'].forEach((id) => $(`#${id}`).classList.toggle('mobile-active', id === paneId));
  document.querySelectorAll('#mobile-tab-bar button').forEach((b) => b.classList.toggle('active', b.dataset.pane === paneId));
}
document.querySelectorAll('#mobile-tab-bar button').forEach((btn) => {
  btn.addEventListener('click', () => activateMobilePane(btn.dataset.pane));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  const token = loadToken();
  if (!token) return;
  try {
    await tryLogin(token, !!localStorage.getItem(TOKEN_KEY));
  } catch {
    clearToken();
  }
})();
