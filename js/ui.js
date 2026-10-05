// Utilidades pequeñas de interfaz.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function options(list, selected, { value = 'id', label = 'name', empty } = {}) {
  let html = empty != null ? `<option value="">${esc(empty)}</option>` : '';
  for (const item of list) {
    const v = typeof item === 'object' ? item[value] : item;
    const l = typeof item === 'object' ? (typeof label === 'function' ? label(item) : item[label]) : item;
    html += `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(l)}</option>`;
  }
  return html;
}

// Hoja inferior tipo iOS. Devuelve el elemento para enlazar eventos.
export function openSheet(title, bodyHtml) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head">
        <button type="button" class="link" data-close>Cancelar</button>
        <h2>${esc(title)}</h2>
        <span class="sheet-spacer"></span>
      </div>
      <div class="sheet-body">${bodyHtml}</div>
    </div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) closeSheet();
  });
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => wrap.classList.add('open'));
  return wrap.querySelector('.sheet');
}

export function closeSheet() {
  document.querySelectorAll('.sheet-backdrop').forEach(el => el.remove());
  document.body.classList.remove('no-scroll');
}

let toastTimer;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const file = new File([blob], filename, { type });
  // En iPhone, compartir permite guardarlo en Archivos o iCloud.
  if (navigator.canShare?.({ files: [file] })) {
    return navigator.share({ files: [file], title: filename }).catch(() => {});
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const buf = new Uint8Array(r.result);
      let text = new TextDecoder('utf-8').decode(buf);
      // Muchos bancos exportan en Latin-1; si hay caracteres inválidos, reintenta.
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
      resolve(text);
    };
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}
