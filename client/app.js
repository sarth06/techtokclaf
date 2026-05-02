/**
 * TechTokClaf — Shared Frontend Utilities
 * Provides: token management, API helpers, toast notifications
 */

const App = (() => {
  let _token = null;

  // ── Token management ──────────────────────────────────
  function setToken(token) {
    _token = token;
  }

  function getToken() {
    return _token;
  }

  // ── API helpers ────────────────────────────────────────
  function authHeaders(extra) {
    return Object.assign(
      { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json' },
      extra
    );
  }

  async function handleResponse(res) {
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const message = (typeof body === 'object' && body.error) ? body.error : String(body);
      throw new Error(message || `HTTP ${res.status}`);
    }
    return body;
  }

  async function apiGet(path) {
    const res = await fetch(path, { headers: authHeaders() });
    return handleResponse(res);
  }

  async function apiPost(path, data) {
    const res = await fetch(path, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  }

  async function apiPut(path, data) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  }

  async function apiDelete(path) {
    const res = await fetch(path, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    return handleResponse(res);
  }

  // ── Toast Notifications ────────────────────────────────
  function toast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `
      <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
      <span>${String(message)}</span>
    `;
    container.appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(40px)';
      el.style.transition = 'opacity .3s, transform .3s';
      setTimeout(() => el.remove(), 350);
    }, duration);
  }

  return { setToken, getToken, apiGet, apiPost, apiPut, apiDelete, toast };
})();
