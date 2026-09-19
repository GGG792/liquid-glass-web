/* ==================== 全局 ==================== */
const $ = id => document.getElementById(id);
const chatEl = $('chat'), msgEl = $('msg');
const sendBtn = $('sendBtn'), stopBtn = $('stopBtn');
const sessionListEl = $('sessionList'), imgPreviewEl = $('imgPreview');
const island = $('island');

const API_DEFAULT = 'https://api.deepseek.com/chat/completions';

let state = {
  sessions: [], currentId: null,
  theme: 'light', apiKey: '', model: 'deepseek-v4-pro',
  modelLabel: 'V4 Pro',
  proxyUrl: '', sysPrompt: ''
};
let pendingImages = [];
let islandExpanded = false;
let islandAutoTimer = null;
let abortController = null;
let isGenerating = false;
let lastPreviewHTML = '';

/* ==================== IndexedDB ==================== */
const IDB_NAME = 'ds_images', IDB_STORE = 'imgs';
let idbPromise = null;
function openIDB() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}
async function idbPut(id, dataUrl) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ id, dataUrl });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(id) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => res(req.result ? req.result.dataUrl : null);
    req.onerror = () => rej(req.error);
  });
}
async function idbDelete(id) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function persistImages(images) {
  const ids = [];
  for (const img of images) {
    const id = 'img_' + uid();
    await idbPut(id, img.dataUrl);
    ids.push(id);
  }
  return ids;
}

/* ==================== 持久化 ==================== */
function saveState() {
  try { localStorage.setItem('ds_state', JSON.stringify(state)); }
  catch (e) { console.warn('存储失败', e); alert('本地存储空间不足，请清理旧会话或导出后删除'); }
}
function loadState() {
  try {
    const raw = localStorage.getItem('ds_state');
    if (raw) {
      const s = JSON.parse(raw);
      Object.assign(state, s);
      if (!s.theme) state.theme = 'light';
      if (!s.model) state.model = 'deepseek-v4-pro';
      if (!s.modelLabel) state.modelLabel = 'V4 Pro';
    }
  } catch (e) { console.warn(e); }
  if (!state.sessions.length) createNewSession(false);
  if (!state.sessions.find(s => s.id === state.currentId)) state.currentId = state.sessions[0].id;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function sanitize(html) {
  if (typeof DOMPurify === 'undefined') return html;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p','br','strong','em','u','s','code','pre','ul','ol','li','h1','h2','h3','h4','h5','h6','blockquote','a','img','hr','table','thead','tbody','tr','th','td','span','div','del','sup','sub'],
    ALLOWED_ATTR: ['href','src','alt','title','class','target','rel']
  });
}

/* ==================== 会话 ==================== */
function createNewSession(save = true) {
  const s = { id: uid(), title: '新对话', messages: [], createdAt: Date.now() };
  state.sessions.unshift(s);
  state.currentId = s.id;
  if (save) { saveState(); renderSessions(); renderMessages(); }
  return s;
}
function newSession() { createNewSession(true); closeSidebar(); msgEl.focus(); }
function switchSession(id) {
  if (id === state.currentId) { closeSidebar(); return; }
  state.currentId = id; saveState(); renderSessions(); renderMessages(); closeSidebar();
}
async function deleteSession(id, e) {
  if (e) e.stopPropagation();
  if (!confirm('删除这个会话？')) return;
  const s = state.sessions.find(x => x.id === id);
  if (s) {
    for (const m of s.messages) {
      if (m.images) for (const imgId of m.images) { try { await idbDelete(imgId); } catch {} }
    }
  }
  state.sessions = state.sessions.filter(x => x.id !== id);
  if (state.currentId === id) {
    if (state.sessions.length) state.currentId = state.sessions[0].id;
    else createNewSession(false);
  }
  saveState(); renderSessions(); renderMessages();
}
function currentSession() { return state.sessions.find(s => s.id === state.currentId); }

/* ==================== 渲染会话 ==================== */
function renderSessions() {
  sessionListEl.innerHTML = '';
  state.sessions.forEach(s => {
    const div = document.createElement('div');
    div.className = 'sb-item' + (s.id === state.currentId ? ' active' : '');
    div.onclick = () => switchSession(s.id);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = s.title;
    title.ondblclick = e => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'title-input';
      input.value = s.title;
      title.replaceWith(input);
      input.focus(); input.select();
      const finish = () => {
        const newTitle = input.value.trim();
        if (newTitle) { s.title = newTitle; saveState(); }
        renderSessions();
      };
      input.onblur = finish;
      input.onkeydown = ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = s.title; input.blur(); }
      };
    };
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕';
    del.onclick = e => deleteSession(s.id, e);
    div.appendChild(title); div.appendChild(del);
    sessionListEl.appendChild(div);
  });
}

/* ==================== 渲染消息 ==================== */
function renderMessages() {
  chatEl.innerHTML = '';
  const s = currentSession();
  if (!s) return;
  s.messages.forEach((m, idx) => renderMessage(m, false, idx));
  scrollBottom();
}
async function resolveImages(ids) {
  const out = [];
  for (const id of ids) {
    try { const data = await idbGet(id); if (data) out.push({ id, dataUrl: data }); } catch {}
  }
  return out;
}
function renderMessage(m, animate = true, idx = -1) {
  const div = document.createElement('div');
  div.className = 'msg lg ' + (m.role === 'user' ? 'user' : 'ai');
  div.dataset.idx = idx;
  if (!animate) div.style.animation = 'none';
  const content = document.createElement('div');
  content.className = 'content';

  if (m.role === 'user' && m.images && m.images.length) {
    const imgs = document.createElement('div');
    imgs.className = 'user-imgs';
    div.appendChild(imgs);
    resolveImages(m.images).then(list => {
      list.forEach(item => {
        const img = document.createElement('img');
        img.src = item.dataUrl;
        img.onclick = () => showLightbox(item.dataUrl);
        imgs.appendChild(img);
      });
    });
  }

  if (m.role === 'assistant' && m.reasoning && m.content) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    const summary = document.createElement('summary');
    summary.textContent = '查看思考过程';
    const inner = document.createElement('div');
    inner.className = 'inner';
    inner.textContent = m.reasoning;
    details.appendChild(summary); details.appendChild(inner);
    div.appendChild(details);
  }

  if (m.role === 'assistant' && m.content) renderMarkdown(content, m.content);
  else content.textContent = m.content || '';
  div.appendChild(content);

  if (m.failed) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11px;color:#ffb84d;margin-top:6px';
    note.textContent = '⚠ 发送失败';
    div.appendChild(note);
  }
  if (m.interrupted) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11px;color:#ffb84d;margin-top:6px';
    note.textContent = '⚠ 已中断';
    div.appendChild(note);
  }

  // 检测 HTML 并加预览按钮
  if (m.role === 'assistant' && m.content) {
    const html = extractHTML(m.content);
    if (html) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';

      const previewBtn = document.createElement('button');
      previewBtn.textContent = '▶ 立即预览';
      previewBtn.style.cssText = 'padding:9px 18px;border-radius:14px;background:linear-gradient(135deg,#6ec6ff,#4facfe);border:none;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(110,198,255,.45);transition:all .3s cubic-bezier(.34,1.56,.64,1)';
      previewBtn.onmouseenter = () => previewBtn.style.transform = 'translateY(-2px)';
      previewBtn.onmouseleave = () => previewBtn.style.transform = 'translateY(0)';
      previewBtn.onclick = (e) => {
        e.stopPropagation();
        previewHTML(html);
      };
      wrap.appendChild(previewBtn);

      const newTabBtn = document.createElement('button');
      newTabBtn.textContent = '↗ 新窗口';
      newTabBtn.style.cssText = 'padding:9px 16px;border-radius:14px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);color:var(--text);font-size:14px;font-weight:500;cursor:pointer;backdrop-filter:blur(10px)';
      newTabBtn.onclick = (e) => {
        e.stopPropagation();
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      };
      wrap.appendChild(newTabBtn);

      div.appendChild(wrap);
    }
  }

  if (m.role === 'assistant' && m.meta) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const mt = m.meta;
    let html = `<span>⏱ ${mt.elapsed}s</span><span>⚡ ${mt.speed} tok/s</span>`;
    if (mt.gotUsage) {
      html += `<span>📥 ${mt.input}</span><span>📤 ${mt.output}</span>`;
      if (mt.reasoning > 0) html += `<span>💭 ${mt.reasoning}</span>`;
      html += `<span>🔢 ${mt.total}</span>`;
    } else {
      html += `<span>📥 ~${mt.input}</span><span>📤 ~${mt.output}</span><span style="color:#ffb84d">⚠ 估算</span>`;
    }
    meta.innerHTML = html;
    const spacer = document.createElement('span'); spacer.className = 'spacer'; meta.appendChild(spacer);
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制';
    copyBtn.onclick = () => copyMsg(copyBtn, m.content);
    meta.appendChild(copyBtn);
    const regenBtn = document.createElement('button');
    regenBtn.textContent = '重新生成';
    regenBtn.onclick = () => regenerate(idx);
    meta.appendChild(regenBtn);
    div.appendChild(meta);
  }

  if (m.role === 'user') {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const spacer = document.createElement('span'); spacer.className = 'spacer'; meta.appendChild(spacer);
    const editBtn = document.createElement('button');
    editBtn.textContent = '编辑';
    editBtn.onclick = () => startEdit(div, idx, m);
    meta.appendChild(editBtn);
    const copyBtn2 = document.createElement('button');
    copyBtn2.textContent = '复制';
    copyBtn2.onclick = () => copyMsg(copyBtn2, m.content);
    meta.appendChild(copyBtn2);
    div.appendChild(meta);
  }

  chatEl.appendChild(div);
  if (animate) scrollBottom();
  return div;
}

function renderMarkdown(el, text) {
  if (typeof marked === 'undefined') { el.textContent = text; return; }
  try {
    const raw = marked.parse(text);
    el.innerHTML = sanitize(raw);
    el.querySelectorAll('pre code').forEach(b => { if (typeof hljs !== 'undefined') hljs.highlightElement(b); });
    el.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.code-copy')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.textContent = '复制';
      btn.onclick = (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText;
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = '已复制';
          setTimeout(() => btn.textContent = '复制', 1500);
        }).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = code; document.body.appendChild(ta);
          ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
          btn.textContent = '已复制';
          setTimeout(() => btn.textContent = '复制', 1500);
        });
      };
      pre.appendChild(btn);
    });
    el.querySelectorAll('img').forEach(img => { img.onclick = () => showLightbox(img.src); });
  } catch (e) { el.textContent = text; }
}

function scrollBottom() { chatEl.scrollTop = chatEl.scrollHeight; }

function copyMsg(btn, text) {
  const content = text || btn.closest('.msg').querySelector('.content').innerText;
  navigator.clipboard.writeText(content).then(() => {
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = old, 1500);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = content; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = '复制', 1500);
  });
}

/* ==================== 编辑 / 重新生成 ==================== */
function startEdit(msgDiv, idx, m) {
  if (msgDiv.querySelector('.edit-area')) return;
  const area = document.createElement('div');
  area.className = 'edit-area';
  const ta = document.createElement('textarea');
  ta.value = m.content || '';
  const btns = document.createElement('div');
  btns.className = 'btns';
  const cancel = document.createElement('button');
  cancel.textContent = '取消';
  cancel.onclick = () => area.remove();
  const ok = document.createElement('button');
  ok.textContent = '保存并重发';
  ok.className = 'primary';
  ok.onclick = async () => {
    const newText = ta.value.trim();
    if (!newText) return;
    const s = currentSession();
    s.messages = s.messages.slice(0, idx);
    saveState();
    msgEl.value = newText;
    area.remove();
    await send();
  };
  btns.appendChild(cancel); btns.appendChild(ok);
  area.appendChild(ta); area.appendChild(btns);
  msgDiv.appendChild(area);
  ta.focus();
}

async function regenerate(idx) {
  const s = currentSession();
  if (!s || idx < 0) return;
  s.messages = s.messages.slice(0, idx);
  saveState();
  renderMessages();
  const lastUser = [...s.messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return;
  const userText = lastUser.content;
  const userImages = lastUser.images || [];
  s.messages = s.messages.slice(0, s.messages.length - 1);
  pendingImages = [];
  if (userImages.length) {
    const resolved = await resolveImages(userImages);
    for (const item of resolved) pendingImages.push({ dataUrl: item.dataUrl });
    renderImagePreview();
  }
  msgEl.value = userText;
  await send();
}

/* ==================== 主题 ==================== */
function applyTheme() {
  let dark = false;
  if (state.theme === 'auto') dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  else dark = state.theme === 'dark';
  document.body.classList.toggle('dark', dark);
  $('darkBtn').textContent = dark ? '☀️ 浅色' : '🌙 深色';
  $('hljs-light').disabled = dark;
  $('hljs-dark').disabled = !dark;
}
function toggleDark() {
  const currentlyDark = document.body.classList.contains('dark');
  state.theme = currentlyDark ? 'light' : 'dark';
  applyTheme(); saveState();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.theme === 'auto') applyTheme();
});

/* ==================== 侧边栏 ==================== */
function openSidebar() { $('sidebar').classList.add('open'); $('overlay').classList.add('show'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('overlay').classList.remove('show'); }

/* ==================== 自定义模型下拉 ==================== */
function toggleModelMenu(e) {
  if (e) e.stopPropagation();
  const menu = $('modelMenu'), btn = $('modelBtn');
  menu.classList.toggle('show');
  btn.classList.toggle('active');
}
function closeModelMenu() {
  $('modelMenu').classList.remove('show');
  $('modelBtn').classList.remove('active');
}
function initModelMenu() {
  const items = document.querySelectorAll('.model-item');
  items.forEach(it => {
    if (it.dataset.value === state.model) {
      it.classList.add('active');
      $('modelLabel').textContent = it.dataset.label;
    } else {
      it.classList.remove('active');
    }
    it.onclick = (e) => {
      e.stopPropagation();
      items.forEach(x => x.classList.remove('active'));
      it.classList.add('active');
      state.model = it.dataset.value;
      state.modelLabel = it.dataset.label;
      $('modelLabel').textContent = it.dataset.label;
      updateIslandModel();
      saveState();
      closeModelMenu();
    };
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.model-select')) closeModelMenu();
  });
}

/* ==================== 设置 ==================== */
function saveSettings() {
  state.apiKey = $('k').value.trim();
  saveState();
}
function openSettings() {
  $('proxyUrl').value = state.proxyUrl || '';
  $('sysPrompt').value = state.sysPrompt || '';
  $('themeMode').value = state.theme || 'light';
  $('settingsModal').classList.add('show');
}
function closeModal(id) { $(id).classList.remove('show'); }
function saveModalSettings() {
  state.proxyUrl = $('proxyUrl').value.trim();
  state.sysPrompt = $('sysPrompt').value.trim();
  state.theme = $('themeMode').value;
  applyTheme(); saveState();
  closeModal('settingsModal');
}

/* ==================== 灵动岛 ==================== */
function toggleIsland() {
  islandExpanded = !islandExpanded;
  island.classList.toggle('expanded', islandExpanded);
  if (islandExpanded && islandAutoTimer) { clearTimeout(islandAutoTimer); islandAutoTimer = null; }
}
function setIslandGenerating(on) {
  island.classList.toggle('generating', on);
  if (on) {
    $('islandStatus').textContent = '0 tok';
    $('islandMid').textContent = '连接中';
    if (!islandExpanded) { islandExpanded = true; island.classList.add('expanded'); }
  } else {
    $('islandStatus').textContent = '就绪';
    $('islandMid').textContent = '待命';
    if (islandExpanded && !islandAutoTimer) {
      islandAutoTimer = setTimeout(() => {
        islandExpanded = false;
        island.classList.remove('expanded');
        islandAutoTimer = null;
      }, 3500);
    }
  }
}
function updateIslandModel() {
  $('islandModel').textContent = state.modelLabel || state.model;
  if (!island.classList.contains('generating')) $('islandMid').textContent = '待命';
}
function setIsland(id, val) { $(id).textContent = val; }
function resetIsland() {
  ['iSpeed','iTtft','iIn','iOut','iReason','iTotal'].forEach(id => setIsland(id, '-'));
  $('islandMid').textContent = '连接中';
  $('islandStatus').textContent = '0 tok';
}

/* ==================== 图片 ==================== */
async function handleFiles(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const compressed = await compressImageToStandard(f);
      if (compressed) {
        pendingImages.push({ dataUrl: compressed });
        renderImagePreview();
      } else {
        alert('这张图片处理失败，换一张试试');
      }
    } catch (err) {
      console.warn('图片处理失败', err);
      alert('图片太大或格式不支持，换一张试试');
    }
  }
}
function compressImageToStandard(file) {
  return new Promise(async (resolve) => {
    try {
      let width = 0, height = 0, source = null;
      if (typeof createImageBitmap === 'function') {
        try {
          source = await createImageBitmap(file);
          width = source.width; height = source.height;
        } catch (e) { console.warn('createImageBitmap 失败', e); }
      }
      if (!source) {
        const url = URL.createObjectURL(file);
        source = await new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => rej(new Error('图片解码失败'));
          img.src = url;
        });
        width = source.naturalWidth || source.width;
        height = source.naturalHeight || source.height;
      }
      const maxSize = 1024;
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height);
        width = Math.round(width * ratio); height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(source, 0, 0, width, height);
      if (source.close) source.close();
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    } catch (err) {
      console.warn('图片标准化失败', err);
      resolve(null);
    }
  });
}
function renderImagePreview() {
  imgPreviewEl.innerHTML = '';
  if (!pendingImages.length) { imgPreviewEl.classList.remove('show'); return; }
  imgPreviewEl.classList.add('show');
  pendingImages.forEach((item, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    const img = document.createElement('img');
    img.src = item.dataUrl;
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.textContent = '✕';
    rm.onclick = () => { pendingImages.splice(i, 1); renderImagePreview(); };
    d.appendChild(img); d.appendChild(rm);
    imgPreviewEl.appendChild(d);
  });
}

/* ==================== 提示词 ==================== */
const PROMPTS = [
  { name: '通用助手', text: '你是一个乐于助人的AI助手，回答简洁准确。' },
  { name: '代码专家', text: '你是一个资深程序员，回答代码问题时给出可运行的完整代码，并简要说明关键点。' },
  { name: '翻译官', text: '你是一个专业翻译，中英互译，保持原意和语气，只输出译文。' },
  { name: '文案写手', text: '你是一个文案策划，根据需求写出有吸引力的文案，风格可根据场景调整。' },
  { name: '数据分析', text: '你是一个数据分析师，帮我分析数据、解读趋势、给出结论和建议。' },
  { name: '学习导师', text: '你是一个耐心的学习导师，用通俗易懂的方式讲解知识点，必要时举例。' },
  { name: '总结提炼', text: '请帮我总结以下内容的要点，条理清晰，尽量精简：\n\n' },
  { name: '改写润色', text: '请帮我改写以下内容，使其更通顺、专业，保持原意：\n\n' }
];
function renderPrompts() {
  const el = $('prompts');
  el.innerHTML = '';
  PROMPTS.forEach(p => {
    const b = document.createElement('div');
    b.className = 'prompt-chip';
    b.textContent = p.name;
    b.onclick = () => {
      const cur = msgEl.value;
      msgEl.value = p.text + (cur && !p.text.endsWith('\n\n') ? '\n\n' + cur : cur);
      msgEl.focus(); autoResize();
    };
    el.appendChild(b);
  });
}

/* ==================== 大图 ==================== */
let lightboxScale = 1, lightboxStartDist = 0, lightboxStartScale = 1;
function showLightbox(src) {
  $('lightboxImg').src = src;
  $('lightbox').classList.add('show');
  lightboxScale = 1;
  $('lightboxImg').style.transform = 'scale(1)';
}
function closeLightbox() {
  $('lightbox').classList.remove('show');
  lightboxScale = 1;
  $('lightboxImg').style.transform = 'scale(1)';
}
function initLightbox() {
  const lbEl = $('lightbox');
  lbEl.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lightboxStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      lightboxStartScale = lightboxScale;
    }
  }, { passive: true });
  lbEl.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      lightboxScale = Math.max(0.5, Math.min(5, lightboxStartScale * dist / lightboxStartDist));
      $('lightboxImg').style.transform = `scale(${lightboxScale})`;
    }
  }, { passive: false });
  lbEl.addEventListener('dblclick', () => {
    lightboxScale = lightboxScale > 1 ? 1 : 2;
    $('lightboxImg').style.transform = `scale(${lightboxScale})`;
  });
  lbEl.addEventListener('click', e => {
    if (e.target === lbEl || e.target.classList.contains('close')) closeLightbox();
  });
}

/* ==================== 导出 / 导入 ==================== */
async function exportSessions() {
  const exportData = JSON.parse(JSON.stringify(state));
  for (const s of exportData.sessions) {
    for (const m of s.messages) {
      if (m.images && m.images.length) {
        const resolved = await resolveImages(m.images);
        m.images = resolved.map(r => r.dataUrl);
      }
    }
  }
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deepseek-sessions-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
async function importSessions(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.sessions || !Array.isArray(data.sessions)) return alert('文件格式不对');
    if (!confirm(`导入 ${data.sessions.length} 个会话？当前会话会被追加。`)) return;
    for (const s of data.sessions) {
      for (const m of s.messages) {
        if (m.images && m.images.length) {
          const ids = [];
          for (const img of m.images) {
            if (typeof img === 'string' && img.startsWith('data:')) {
              const id = 'img_' + uid();
              await idbPut(id, img);
              ids.push(id);
            } else if (typeof img === 'string') ids.push(img);
          }
          m.images = ids;
        }
      }
      s.id = s.id || uid();
    }
    state.sessions = [...data.sessions, ...state.sessions];
    state.currentId = data.sessions[0].id;
    if (data.apiKey) state.apiKey = data.apiKey;
    if (data.model) state.model = data.model;
    if (data.proxyUrl !== undefined) state.proxyUrl = data.proxyUrl;
    if (data.sysPrompt !== undefined) state.sysPrompt = data.sysPrompt;
    saveState();
    $('k').value = state.apiKey;
    initModelMenu();
    updateIslandModel(); renderSessions(); renderMessages();
    alert('导入成功');
  } catch (err) { console.warn(err); alert('导入失败：' + err.message); }
}

/* ==================== Token 估算 ==================== */
function estimateTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = text.length - chinese;
  return Math.ceil(chinese * 0.67 + other * 0.25);
}

/* ==================== HTML 提取与预览 ==================== */
function extractHTML(text) {
  if (!text) return null;

  // 1. 优先匹配 ```html ... ``` 代码块
  const fenced = text.match(/```html\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const code = fenced[1].trim();
    if (code.indexOf('<html') >= 0 || code.indexOf('<!DOCTYPE') >= 0 || code.indexOf('<body') >= 0 || code.indexOf('<div') >= 0) {
      if (code.indexOf('<html') < 0 && code.indexOf('<!DOCTYPE') < 0) {
        return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + code + '</body></html>';
      }
      return code;
    }
  }

  // 2. 无语言标记的代码块，但内容像 HTML
  const fencedNoLang = text.match(/```\s*([\s\S]*?)```/);
  if (fencedNoLang && fencedNoLang[1]) {
    const code = fencedNoLang[1].trim();
    if (code.indexOf('<!DOCTYPE') >= 0 || (code.indexOf('<html') >= 0 && code.indexOf('</html>') >= 0)) {
      return code;
    }
  }

  // 3. <!DOCTYPE html>...</html>
  const doctype = text.match(/<!DOCTYPE[\s\S]*?<\/html>/i);
  if (doctype) return doctype[0];

  // 4. <html>...</html>
  const htmlTag = text.match(/<html[\s\S]*?<\/html>/i);
  if (htmlTag) return htmlTag[0];

  // 5. 宽松：同时有 <head> 和 <body>
  if (text.indexOf('<head') >= 0 && text.indexOf('<body') >= 0) {
    const head = text.match(/<head[\s\S]*?<\/head>/i);
    const body = text.match(/<body[\s\S]*?<\/body>/i);
    if (head && body) {
      return '<!DOCTYPE html><html>' + head[0] + body[0] + '</html>';
    }
  }

  return null;
}

function previewHTML(html) {
  lastPreviewHTML = html;
  const frame = document.getElementById('previewFrame');
  frame.srcdoc = html;
  document.getElementById('previewModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closePreview() {
  document.getElementById('previewModal').classList.remove('show');
  document.getElementById('previewFrame').srcdoc = '';
  document.body.style.overflow = '';
}
function refreshPreview() {
  const frame = document.getElementById('previewFrame');
  const html = lastPreviewHTML;
  frame.srcdoc = '';
  setTimeout(() => { frame.srcdoc = html; }, 50);
}
function openPreviewNewTab() {
  const blob = new Blob([lastPreviewHTML], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ==================== 发送 ==================== */
async function send() {
  if (isGenerating) return;
  const key = $('k').value.trim();
  const useProxy = !!state.proxyUrl;
  if (!useProxy && !key) return alert('请先填写 API Key，或在设置里配置代理地址');
  const text = msgEl.value.trim();
  if (!text && !pendingImages.length) return;
  const s = currentSession();
  if (!s) return;

  let hasInvalidImage = false;
  for (const m of s.messages) {
    if (m.role === 'user' && m.images) {
      for (const id of m.images) {
        if (!id || typeof id !== 'string') { hasInvalidImage = true; break; }
      }
    }
    if (hasInvalidImage) break;
  }
  if (hasInvalidImage) {
    if (!confirm('历史记录里有损坏的图片，会导致发送失败。是否清空当前会话重新开始？')) return;
    s.messages = [];
    saveState(); renderMessages();
  }

  const imgs = pendingImages.slice();
  pendingImages = [];
  renderImagePreview();
  const imageIds = imgs.length ? await persistImages(imgs) : [];

  const userMsg = { role: 'user', content: text, images: imageIds.length ? imageIds : undefined };
  s.messages.push(userMsg);
  renderMessage(userMsg, true, s.messages.length - 1);
  saveState();

  if (s.title === '新对话' && text) {
    s.title = text.slice(0, 20) + (text.length > 20 ? '...' : '');
    renderSessions();
  }

  msgEl.value = ''; autoResize();

  const apiMessages = [];
  if (state.sysPrompt) apiMessages.push({ role: 'system', content: state.sysPrompt });
  for (const m of s.messages) {
    if (m.role === 'user' && m.images && m.images.length) {
      const arr = [];
      if (m.content) arr.push({ type: 'text', text: m.content });
      const resolved = await resolveImages(m.images);
      resolved.forEach(item => {
        if (item.dataUrl && (
            item.dataUrl.startsWith('data:image/jpeg;base64,') ||
            item.dataUrl.startsWith('data:image/png;base64,') ||
            item.dataUrl.startsWith('data:image/webp;base64,') ||
            item.dataUrl.startsWith('data:image/gif;base64,')
        )) {
          arr.push({ type: 'image_url', image_url: { url: item.dataUrl } });
        } else {
          console.warn('跳过不支持的图片格式', item.id);
        }
      });
      if (arr.length === 1 && arr[0].type === 'text') apiMessages.push({ role: 'user', content: arr[0].text });
      else if (arr.length > 0) apiMessages.push({ role: 'user', content: arr });
      else apiMessages.push({ role: 'user', content: m.content || '' });
    } else apiMessages.push({ role: m.role, content: m.content });
  }

  const aiMsg = { role: 'assistant', content: '', reasoning: '', meta: null, autoPreviewed: false };
  s.messages.push(aiMsg);
  const aiIdx = s.messages.length - 1;
  const aiEl = renderMessage(aiMsg, true, aiIdx);
  const contentEl = aiEl.querySelector('.content');

  isGenerating = true;
  sendBtn.style.display = 'none';
  stopBtn.classList.add('show');
  resetIsland();
  setIslandGenerating(true);
  abortController = new AbortController();

  const startTime = Date.now();
  let firstTokenTime = null;
  let fullText = '', reasoningText = '', isReasoning = false;
  let inputTokens = 0, outputTokens = 0, reasoningTokens = 0, totalTokens = 0;
  let gotUsage = false;

  const url = useProxy ? state.proxyUrl : API_DEFAULT;
  const headers = { 'Content-Type': 'application/json' };
  if (!useProxy) headers['Authorization'] = 'Bearer ' + key;

  try {
    const res = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: state.model, messages: apiMessages,
        stream: true, stream_options: { include_usage: true }
      }),
      signal: abortController.signal
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errMsg = err.error?.message || res.status;
      contentEl.textContent = '错误：' + errMsg;
      aiMsg.content = '错误：' + errMsg;
      aiMsg.failed = true;
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:#ff6b6b;margin-top:6px';
      note.textContent = '⚠ 发送失败，可点「重新生成」重试';
      aiEl.appendChild(note);
      saveState();
      finishGenerate();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data: ')) continue;
        const data = t.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            if (delta.reasoning_content) {
              isReasoning = true;
              reasoningText += delta.reasoning_content;
              contentEl.textContent = '💭 ' + reasoningText;
              scrollBottom();
            }
            if (delta.content) {
              if (!firstTokenTime) {
                firstTokenTime = Date.now();
                const ttft = ((firstTokenTime - startTime) / 1000).toFixed(2) + 's';
                setIsland('iTtft', ttft);
              }
              if (isReasoning) { isReasoning = false; fullText = ''; }
              fullText += delta.content;
              outputTokens = estimateTokens(fullText);
              contentEl.textContent = fullText;
              scrollBottom();
              const elapsed = (Date.now() - startTime) / 1000;
              const spd = elapsed > 0 ? (outputTokens / elapsed).toFixed(1) : '0';
              setIsland('iSpeed', spd + ' tok/s');
              setIsland('iOut', '~' + outputTokens);
              $('islandMid').textContent = spd + ' tok/s';
              $('islandStatus').textContent = '~' + outputTokens + ' tok';
            }
          }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || 0;
            outputTokens = chunk.usage.completion_tokens || 0;
            totalTokens = chunk.usage.total_tokens || 0;
            reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens || 0;
            gotUsage = true;
            setIsland('iIn', inputTokens); setIsland('iOut', outputTokens);
            setIsland('iReason', reasoningTokens); setIsland('iTotal', totalTokens);
          }
        } catch (e) {}
      }
    }

    // 流式过程中，如果已经完整检测到 HTML，自动弹出预览（只弹一次）
    if (fullText && !aiMsg.autoPreviewed) {
      const autoHtml = extractHTML(fullText);
      if (autoHtml && fullText.indexOf('</html>') >= 0) {
        aiMsg.autoPreviewed = true;
        setTimeout(() => {
          try { previewHTML(autoHtml); } catch (e) {}
        }, 500);
      }
    }

    if (fullText) renderMarkdown(contentEl, fullText);
    else if (reasoningText) contentEl.textContent = '💭 ' + reasoningText;

    if (reasoningText && fullText) {
      const details = document.createElement('details');
      details.className = 'reasoning';
      const summary = document.createElement('summary');
      summary.textContent = '查看思考过程';
      const inner = document.createElement('div');
      inner.className = 'inner';
      inner.textContent = reasoningText;
      details.appendChild(summary); details.appendChild(inner);
      aiEl.insertBefore(details, contentEl);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgSpeed = outputTokens > 0 ? (outputTokens / elapsed).toFixed(1) : '0';
    aiMsg.content = fullText || reasoningText;
    aiMsg.reasoning = reasoningText;
    aiMsg.meta = { elapsed, speed: avgSpeed, input: inputTokens, output: outputTokens, reasoning: reasoningTokens, total: totalTokens, gotUsage };
    aiMsg.interrupted = false;

    const metaEl = aiEl.querySelector('.meta');
    if (metaEl) metaEl.remove();
    const newMeta = document.createElement('div');
    newMeta.className = 'meta';
    let html = `<span>⏱ ${elapsed}s</span><span>⚡ ${avgSpeed} tok/s</span>`;
    if (gotUsage) {
      html += `<span>📥 ${inputTokens}</span><span>📤 ${outputTokens}</span>`;
      if (reasoningTokens > 0) html += `<span>💭 ${reasoningTokens}</span>`;
      html += `<span>🔢 ${totalTokens}</span>`;
    } else {
      html += `<span>📥 ~${inputTokens}</span><span>📤 ~${outputTokens}</span><span style="color:#ffb84d">⚠ 估算</span>`;
    }
    newMeta.innerHTML = html;
    const spacer = document.createElement('span'); spacer.className = 'spacer'; newMeta.appendChild(spacer);
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制';
    copyBtn.onclick = () => copyMsg(copyBtn, aiMsg.content);
    newMeta.appendChild(copyBtn);
    const regenBtn = document.createElement('button');
    regenBtn.textContent = '重新生成';
    regenBtn.onclick = () => regenerate(aiIdx);
    newMeta.appendChild(regenBtn);
    aiEl.appendChild(newMeta);

    // 流式结束后，补上预览按钮（如果流式时没触发自动预览）
    const htmlAfter = extractHTML(fullText);
    if (htmlAfter && !aiEl.querySelector('button[data-preview]')) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      const previewBtn = document.createElement('button');
      previewBtn.dataset.preview = '1';
      previewBtn.textContent = '▶ 立即预览';
      previewBtn.style.cssText = 'padding:9px 18px;border-radius:14px;background:linear-gradient(135deg,#6ec6ff,#4facfe);border:none;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(110,198,255,.45)';
      previewBtn.onclick = (e) => { e.stopPropagation(); previewHTML(htmlAfter); };
      wrap.appendChild(previewBtn);
      const newTabBtn = document.createElement('button');
      newTabBtn.textContent = '↗ 新窗口';
      newTabBtn.style.cssText = 'padding:9px 16px;border-radius:14px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);color:var(--text);font-size:14px;font-weight:500;cursor:pointer';
      newTabBtn.onclick = (e) => {
        e.stopPropagation();
        const blob = new Blob([htmlAfter], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      };
      wrap.appendChild(newTabBtn);
      aiEl.appendChild(wrap);
    }

    saveState();

  } catch (e) {
    if (e.name === 'AbortError') {
      aiMsg.interrupted = true;
      if (fullText) { renderMarkdown(contentEl, fullText); aiMsg.content = fullText; }
      else if (reasoningText) { contentEl.textContent = '💭 ' + reasoningText; aiMsg.content = reasoningText; }
      else { contentEl.textContent = '（已停止）'; aiMsg.content = ''; }
      aiMsg.reasoning = reasoningText;
      saveState();
    } else {
      contentEl.textContent = '请求失败：' + e.message;
      aiMsg.content = '请求失败：' + e.message;
      aiMsg.failed = true;
      saveState();
    }
  }

  finishGenerate();
  scrollBottom();
}

function stopGenerate() {
  if (abortController) { abortController.abort(); abortController = null; }
}
function finishGenerate() {
  isGenerating = false;
  sendBtn.disabled = false;
  sendBtn.style.display = '';
  stopBtn.classList.remove('show');
  setIslandGenerating(false);
  abortController = null;
}

/* ==================== 输入框 ==================== */
function autoResize() {
  msgEl.style.height = 'auto';
  msgEl.style.height = Math.min(msgEl.scrollHeight, 96) + 'px';
}

/* ==================== 初始化 ==================== */
function init() {
  if (location.protocol === 'file:') $('warnBar').classList.add('show');
  loadState();
  $('k').value = state.apiKey;
  applyTheme();
  renderPrompts();
  renderSessions();
  renderMessages();
  renderImagePreview();
  updateIslandModel();
  initModelMenu();
  initLightbox();

  msgEl.addEventListener('input', autoResize);
  msgEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  $('k').addEventListener('change', () => { state.apiKey = $('k').value.trim(); saveState(); });

  document.addEventListener('click', e => {
    if (islandExpanded && !island.contains(e.target)) {
      islandExpanded = false;
      island.classList.remove('expanded');
    }
  });
  $('settingsModal').addEventListener('click', e => {
    if (e.target === $('settingsModal')) closeModal('settingsModal');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const pm = document.getElementById('previewModal');
      if (pm && pm.classList.contains('show')) closePreview();
    }
  });
  window.addEventListener('beforeunload', () => { try { saveState(); } catch {} });
  window.addEventListener('pagehide', () => { try { saveState(); } catch {} });
}
init();