import * as pdfjs from './vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const FIELDS = ['fournisseur', 'affaire', 'commande'];
const ID = String.raw`(?=[A-Z0-9\-/.]*\d)([A-Z0-9][A-Z0-9\-/.]{2,})`;
const DEFAULTS = {
  profondeur_recherche: 2,
  sous_dossier: '',
  dossier_final: '{commande}',
  dossier_non_classe: '_A_CLASSER',
  patterns: {
    affaire: [String.raw`(?:n[°o]|num[ée]ro)\s*d['’]?\s*affaire\s*[:\-]?\s*` + ID,
              String.raw`\baffaire\s*(?:n[°o])?\s*[:\-]?\s*` + ID],
    commande: [String.raw`(?:bon\s+de\s+commande|commande|\bBC\b|\bPO\b)\s*(?:n[°o]|num[ée]ro)?\s*[:\-]?\s*` + ID,
               String.raw`n[°o]\s*(?:de\s+)?commande\s*[:\-]?\s*` + ID],
    fournisseur: [String.raw`fournisseur\s*[:\-]\s*([^\n\r]{2,60})`]
  },
  fournisseurs_connus: [],
  utiliser_ia: false,
  modele_ia: 'claude-sonnet-5-5'
};

const $ = s => document.querySelector(s);
const clone = o => JSON.parse(JSON.stringify(o));
function merge(user) {
  const c = clone(DEFAULTS);
  for (const [k, v] of Object.entries(user || {})) {
    if (k === 'patterns' && v && typeof v === 'object') Object.assign(c.patterns, v); else c[k] = v;
  }
  return c;
}
function loadCfg() {
  try { return merge(JSON.parse(localStorage.getItem('classeur_cfg'))); } catch { return clone(DEFAULTS); }
}
let cfg = loadCfg();
const saveCfg = () => localStorage.setItem('classeur_cfg', JSON.stringify(cfg));

// ---- dossier racine (mémorisé entre deux lancements) ----
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('classeur', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const kv = async (mode, key, val) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const s = db.transaction('kv', mode === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
    const q = mode === 'get' ? s.get(key) : s.put(val, key);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
};
let root = null;
async function ensureRoot() {
  if (!root) { await pickRoot(); return !!root; }
  if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
      (await root.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
  return true;
}
async function pickRoot() {
  try {
    root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'classeur' });
    await kv('put', 'root', root);
    $('#rootName').textContent = root.name;
  } catch { /* annulé */ }
}

// ---- extraction ----
async function pdfText(bytes) {
  try {
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    let t = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      t += c.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('') + '\n';
    }
    return t;
  } catch { return ''; }
}
function extract(text) {
  const found = { fournisseur: null, affaire: null, commande: null };
  for (const n of cfg.fournisseurs_connus) {
    if (text.toLowerCase().includes(String(n).toLowerCase())) { found.fournisseur = n; break; }
  }
  for (const f of FIELDS) {
    if (found[f]) continue;
    for (const p of cfg.patterns[f] || []) {
      const m = new RegExp(p, 'i').exec(text);
      if (m) { found[f] = m[1].trim().replace(/[.,;:]+$/, ''); break; }
    }
  }
  return found;
}
const b64 = b => { let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return btoa(s); };
async function askAI(text, bytes) {
  const key = localStorage.getItem('classeur_key');
  if (!key) return {};
  const ask = 'Extrais de ce document le nom du fournisseur, le numéro d\'affaire et le numéro de commande. ' +
    'Réponds uniquement par un objet JSON de la forme {"fournisseur": "...", "affaire": "...", "commande": "..."} ' +
    'en mettant null pour une information introuvable.';
  const content = text.trim()
    ? [{ type: 'text', text: `${ask}\n\n---\n${text.slice(0, 8000)}` }]
    : [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) } }, { type: 'text', text: ask }];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
                 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: cfg.modele_ia, max_tokens: 300, messages: [{ role: 'user', content }] })
    });
    const raw = /\{[\s\S]*\}/.exec((await r.json()).content[0].text)[0];
    const p = JSON.parse(raw);
    return Object.fromEntries(FIELDS.map(k => [k, p[k] ? String(p[k]).trim() : null]));
  } catch { return {}; }
}

// ---- rangement ----
const norm = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const safe = (v, fb) => (v ? v.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) : '') || fb;
async function findAffaire(affaire) {
  if (!affaire) return null;
  const w = norm(affaire), max = Math.max(1, +cfg.profondeur_recherche || 1), hits = [];
  async function walk(h, d, path) {
    if (d >= max) return;
    for await (const [name, e] of h.entries()) {
      if (e.kind !== 'directory') continue;
      if (norm(name).includes(w)) hits.push({ h: e, path: [...path, name] });
      await walk(e, d + 1, [...path, name]);
    }
  }
  await walk(root, 0, []);
  hits.sort((a, b) => norm(a.path.at(-1)).length - norm(b.path.at(-1)).length);
  return hits[0] || null;
}
async function sub(h, path, segs) {
  for (const p of String(path).split(/[\\/]/).filter(Boolean)) { h = await h.getDirectoryHandle(p, { create: true }); segs.push(p); }
  return h;
}
async function destination(info) {
  const hit = await findAffaire(info.affaire);
  if (!hit) { const segs = []; return { dir: await sub(root, cfg.dossier_non_classe, segs), segs, matched: false }; }
  const segs = [...hit.path];
  let dir = hit.h;
  if (cfg.sous_dossier) dir = await sub(dir, cfg.sous_dossier, segs);
  if (cfg.dossier_final) {
    const v = { commande: safe(info.commande, 'Commande_inconnue'), fournisseur: safe(info.fournisseur, 'Fournisseur_inconnu'), affaire: safe(info.affaire, 'Affaire_inconnue') };
    dir = await sub(dir, cfg.dossier_final.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? ''), segs);
  }
  return { dir, segs, matched: true };
}
const exists = async (d, n) => { try { await d.getFileHandle(n); return true; } catch { return false; } };
async function fileDoc(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = await pdfText(bytes.slice());
  const info = extract(text);
  if (cfg.utiliser_ia && FIELDS.some(k => !info[k])) {
    const ai = await askAI(text, bytes);
    for (const k of FIELDS) if (!info[k] && ai[k]) info[k] = ai[k];
  }
  const { dir, segs, matched } = await destination(info);
  const dot = file.name.lastIndexOf('.'), stem = file.name.slice(0, dot), ext = file.name.slice(dot);
  let name = file.name, n = 1;
  while (await exists(dir, name)) name = `${stem}_${n++}${ext}`;
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(file); await w.close();
  return { info, path: [root.name, ...segs, name].join('/'), complete: matched && FIELDS.every(k => info[k]) };
}

// ---- interface ----
function addRow(name, info, status, ok) {
  const tr = document.createElement('tr'); tr.className = ok ? 'ok' : 'warn';
  [name, info.fournisseur || '?', info.affaire || '?', info.commande || '?', status].forEach(v => {
    const td = document.createElement('td'); td.textContent = v; tr.append(td);
  });
  $('#rows').prepend(tr); $('#empty').hidden = true; $('#results').hidden = false;
}
async function handle(files) {
  const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name));
  if (!pdfs.length || !(await ensureRoot())) return;
  $('#drop').classList.add('busy');
  for (const f of pdfs) {
    try {
      const r = await fileDoc(f);
      addRow(f.name, r.info, (r.complete ? 'Rangé : ' : 'À vérifier : ') + r.path, r.complete);
    } catch (e) { addRow(f.name, {}, 'Erreur : ' + e.message, false); }
  }
  $('#drop').classList.remove('busy');
}
const drop = $('#drop');
drop.onclick = () => $('#file').click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } };
$('#file').onchange = e => { handle(e.target.files); e.target.value = ''; };
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files); };
window.ondragover = e => e.preventDefault();
window.ondrop = e => e.preventDefault();
$('#pick').onclick = pickRoot;
$('#ai').checked = cfg.utiliser_ia;
$('#ai').onchange = e => {
  cfg.utiliser_ia = e.target.checked; saveCfg();
  if (cfg.utiliser_ia && !localStorage.getItem('classeur_key')) $('#cfgBtn').click();
};

// réglages
const dlg = $('#dlg');
$('#cfgBtn').onclick = () => {
  $('#cfgText').value = JSON.stringify(cfg, null, 2); $('#key').value = localStorage.getItem('classeur_key') || '';
  $('#cfgErr').hidden = true; dlg.showModal();
};
$('#reset').onclick = () => { $('#cfgText').value = JSON.stringify(DEFAULTS, null, 2); };
$('#save').onclick = () => {
  try {
    const next = merge(JSON.parse($('#cfgText').value));
    for (const list of Object.values(next.patterns)) list.forEach(p => new RegExp(p, 'i'));
    cfg = next; saveCfg();
    const k = $('#key').value.trim();
    k ? localStorage.setItem('classeur_key', k) : localStorage.removeItem('classeur_key');
    $('#ai').checked = cfg.utiliser_ia; dlg.close();
  } catch (e) { $('#cfgErr').textContent = 'Réglages invalides : ' + e.message; $('#cfgErr').hidden = false; }
};

// installation + hors-ligne
let promptEvt;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptEvt = e; $('#install').hidden = false; });
$('#install').onclick = async () => { promptEvt?.prompt(); $('#install').hidden = true; };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
if (!('showDirectoryPicker' in window)) { $('#unsupported').hidden = false; $('#pick').disabled = true; }
kv('get', 'root').then(h => { if (h) { root = h; $('#rootName').textContent = h.name; } }).catch(() => {});
