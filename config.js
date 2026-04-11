// --- Backend Configuration (Local Development Only) ---
// This is the open-source version for local development.
// The extension connects to a Flask backend running on your machine.

const BACKEND_CONFIG = {
  cloud: {
    predict: '',
    cookie:  '',
    kbChat:  '',
    apiKey:  '',
  },
  local: {
    urls: ['http://127.0.0.1:5000', 'http://localhost:5000'],
  },
  defaultMode: 'local',
};

const CLOUD_ROUTE_MAP = {};

/**
 * Backend fetch for local development.
 * Tries 127.0.0.1 then falls back to localhost (Edge/Opera compatibility).
 */
async function backendFetch(path, options = {}) {
  for (const base of BACKEND_CONFIG.local.urls) {
    try {
      const res = await fetch(base + path, options);
      return res;
    } catch (e) {
      console.warn(`[backendFetch] ${base}${path} failed:`, e.message);
    }
  }
  throw new Error(`All backend URLs failed for ${path}. Make sure the Flask backend is running.`);
}
