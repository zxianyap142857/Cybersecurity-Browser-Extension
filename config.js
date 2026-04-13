// --- Backend Configuration ---
// Supports both local (Flask on localhost) and cloud (GCP Cloud Run) modes.
// Switch between modes using the Backend selector in the sidebar.

const BACKEND_CONFIG = {
  // Cloud Run service URLs
  cloud: {
    predict: 'https://predict-service-1024751986605.asia-southeast1.run.app',
    cookie:  'https://cookie-service-1024751986605.asia-southeast1.run.app',
    kbChat:  'https://kb-chat-service-1024751986605.asia-southeast1.run.app',
    apiKey:  '',  // Set via chrome.storage.local['cloudApiKey']
  },

  // Local development server
  local: {
    urls: ['http://127.0.0.1:5000', 'http://localhost:5000'],
  },

  // Default mode: 'local' for developer setup, change to 'cloud' if preferred
  defaultMode: 'local',
};

// Endpoint-to-service routing map for cloud mode
const CLOUD_ROUTE_MAP = {
  '/predict':             'predict',
  '/batch_predict':       'predict',
  '/scan_page':           'predict',
  '/report':              'predict',
  '/report_count':        'predict',
  '/fl_train':            'predict',
  '/fl_status':           'predict',
  '/model/update':        'predict',
  '/model/update_status': 'predict',
  '/api/history':         'predict',
  '/analyze-cookies':     'cookie',
  '/chat':                'kbChat',
  '/kb/rows':             'kbChat',
  '/kb/add':              'kbChat',
  '/kb/delete':           'kbChat',
  '/kb/rebuild':          'kbChat',
  '/kb/archive':          'kbChat',
  '/kb/restore':          'kbChat',
};

/**
 * Smart backend fetch with cloud/local routing.
 * In cloud mode, routes each endpoint to the correct Cloud Run service.
 * In local mode, tries 127.0.0.1 then localhost (Edge/Opera fallback).
 */
async function backendFetch(path, options = {}) {
  const mode = await _getBackendMode();

  if (mode === 'cloud') {
    return _cloudFetch(path, options);
  } else {
    return _localFetch(path, options);
  }
}

async function _getBackendMode() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['backendMode'], (data) => {
        resolve(data.backendMode || BACKEND_CONFIG.defaultMode);
      });
    } catch {
      resolve(BACKEND_CONFIG.defaultMode);
    }
  });
}

async function _cloudFetch(path, options) {
  const serviceKey = CLOUD_ROUTE_MAP[path] || CLOUD_ROUTE_MAP[path.split('?')[0]];
  if (!serviceKey) {
    throw new Error(`No cloud route configured for ${path}`);
  }

  const baseUrl = BACKEND_CONFIG.cloud[serviceKey];
  if (!baseUrl || baseUrl.includes('REPLACE')) {
    throw new Error(`Cloud service URL not configured for ${serviceKey}. Update config.js with your Cloud Run URLs.`);
  }

  const apiKey = await _getCloudApiKey();
  if (apiKey) {
    options.headers = options.headers || {};
    options.headers['X-API-Key'] = apiKey;
  }

  try {
    const res = await fetch(baseUrl + path, options);
    return res;
  } catch (e) {
    console.error(`[backendFetch] Cloud ${serviceKey}${path} failed:`, e.message);
    throw new Error(`Cloud backend unavailable for ${path}`);
  }
}

async function _localFetch(path, options) {
  for (const base of BACKEND_CONFIG.local.urls) {
    try {
      const res = await fetch(base + path, options);
      return res;
    } catch (e) {
      console.warn(`[backendFetch] ${base}${path} failed:`, e.message);
    }
  }
  throw new Error(`All local backend URLs failed for ${path}. Make sure the Flask backend is running.`);
}

async function _getCloudApiKey() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['cloudApiKey'], (data) => {
        resolve(data.cloudApiKey || BACKEND_CONFIG.cloud.apiKey || '');
      });
    } catch {
      resolve('');
    }
  });
}
