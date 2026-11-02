// dom.js: tiny DOM helpers. All text goes in through text nodes, never as
// HTML strings: the page shows agent output, which is untrusted.

// h('div', { class: 'x', onclick: fn, title: 't', dataset: { id } }, 'text', child, [more])
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

export async function text(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// A status badge: icon + label, colored by tone.
export function badge(info, extra = '') {
  return h('span', { class: `badge tone-${info.tone} ${extra}` }, h('span', { class: 'badge-icon', 'aria-hidden': 'true' }, info.icon), info.label);
}

// confirmButton: first click arms it ("Click again to …"), second click acts.
// Avoids browser confirm() dialogs.
export function confirmButton(label, armedLabel, onConfirm, cls = 'danger') {
  let armed = false;
  let timer;
  const button = h('button', {
    class: cls,
    onclick: async () => {
      if (!armed) {
        armed = true;
        button.textContent = armedLabel;
        timer = setTimeout(() => { armed = false; button.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      button.disabled = true;
      try { await onConfirm(); } finally { button.disabled = false; armed = false; button.textContent = label; }
    },
  }, label);
  return button;
}
