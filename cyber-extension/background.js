// --- Backend URL with fallback (Edge may block 127.0.0.1 via Tracking Prevention) ---
const BACKEND_URLS = ['http://127.0.0.1:5000', 'http://localhost:5000'];

async function backendFetch(path, options = {}) {
  for (const base of BACKEND_URLS) {
    try {
      const res = await fetch(base + path, options);
      return res;
    } catch (e) {
      console.warn(`[backendFetch] ${base}${path} failed:`, e.message);
    }
  }
  throw new Error(`All backend URLs failed for ${path}`);
}

chrome.runtime.onInstalled.addListener(() => {
  // Initialize dashboard stats if they don't exist
  chrome.storage.local.get(['dashboardStats', 'scanHistory', 'protectionEnabled', 'warningEnabled', 'urlScanningEnabled', 'blockingPopupEnabled'], (result) => {
    if (!result.dashboardStats) {
      chrome.storage.local.set({ dashboardStats: { total: 0, phishing: 0, legitimate: 0, scannedLinks: 0, removedLinks: 0 } });
    }
    if (!result.scanHistory) {
      chrome.storage.local.set({ scanHistory: [] });
    }
    // Only set toggle defaults if they haven't been set before (preserve user choices across reloads)
    if (result.protectionEnabled === undefined) {
      chrome.storage.local.set({ protectionEnabled: false });
    }
    if (result.warningEnabled === undefined) {
      chrome.storage.local.set({ warningEnabled: true });
    }
    if (result.urlScanningEnabled === undefined) {
      chrome.storage.local.set({ urlScanningEnabled: false });
    }
    if (result.blockingPopupEnabled === undefined) {
      chrome.storage.local.set({ blockingPopupEnabled: false });
    }
  });
  console.log('Protection states initialized (preserving existing settings).');
});

// Listener for when a tab is updated (e.g., new page loads)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if the tab is fully loaded and has a URL
  if (changeInfo.status === 'complete' && tab.url) {
          // Handle local files
        if (tab.url.startsWith('file://')) {
          console.log('This is a local file. Skipping analysis.');
          chrome.storage.local.set({ analysisResult: { status: 'LOCAL FILE' } });
          chrome.action.setBadgeText({ text: 'LOCAL', tabId: tabId });
          chrome.action.setBadgeBackgroundColor({ color: '#808080', tabId: tabId });
          return;
        }

        if (tab.url.startsWith('127.0.')|| tab.url.startsWith('192.168.') || tab.url.startsWith('10.0.')||tab.url.startsWith('172.16.')) {
          console.log('This is a Local Network. Skipping Analysis Process.');
          chrome.storage.local.set({ analysisResult: { status: 'LOCAL NETWORK' } });
          chrome.action.setBadgeText({ text: 'PRIVATE', tabId: tabId });
          chrome.action.setBadgeBackgroundColor({ color: '#808080', tabId: tabId });
          return;
        }
    
        // Handle web pages
        if (tab.url.startsWith('http')) {
          chrome.storage.local.get(['protectionEnabled', 'warningEnabled', 'urlScanningEnabled', 'selectedModel'], (data) => {
            // Batch scan on page load when protection or warning is active
            if (data.protectionEnabled || data.warningEnabled) {
              console.log('Protection/Warning is ON. Auto-analyzing tab:', tab.url);
              analyzeAndCleanPage(tabId);
            }
            // URL Scanning mode: scan only the current page URL via /predict
            if (data.urlScanningEnabled) {
              console.log('URL Scanning is ON. Scanning current URL:', tab.url);
              scanSingleUrl(tabId, tab.url, data.selectedModel || 'distilbert');
            }
            // Blocking popup is now handled by webNavigation.onCommitted (see below)
          });
        }
      }
    });
    
    // Listener for messages from other parts of the extension (e.g., the popup)
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      // Allow a blocked URL when user clicks "Proceed Anyway" on warning page
      if (request.action === "allowBlockedUrl") {
        chrome.storage.session.get(['allowedBlockedUrls'], (sessionData) => {
          const allowed = sessionData.allowedBlockedUrls || [];
          if (!allowed.includes(request.url)) {
            allowed.push(request.url);
          }
          chrome.storage.session.set({ allowedBlockedUrls: allowed }, () => {
            console.log('[BlockingPopup] User chose to proceed to:', request.url);
            sendResponse({ status: 'allowed' });
          });
        });
        return true;  // async sendResponse
      }

      // Scan only the current page URL via /predict
      if (request.action === "scanCurrentUrl") {
        scanSingleUrl(request.tabId, request.url, request.model || 'distilbert');
        sendResponse({ status: "Single URL scan started" });
        return true;
      }

      if (request.action === "analyzeTab") {
        chrome.tabs.get(request.tabId, (tab) => {
          if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError.message);
            return sendResponse({ status: "Error getting tab" });
          }
    
          // Handle local files
          if (tab.url && tab.url.startsWith('file://')) {
            console.log('Received request to analyze a local file. Skipping.');
            chrome.storage.local.set({ analysisResult: { status: 'LOCAL' } });
            chrome.action.setBadgeText({ text: 'LOCAL', tabId: tab.id });
            chrome.action.setBadgeBackgroundColor({ color: '#808080', tabId: tab.id });
            return sendResponse({ status: "Local file, skipped" });
          }
    
          // Handle web pages
          console.log('Received request to analyze tab:', request.tabId);
          analyzeAndCleanPage(request.tabId);
          sendResponse({ status: "Analysis started" });
        });
      }
      return true; // Indicates that the response is sent asynchronously
    });
    
    // Scan a single URL via /predict and update badge + analysisResult
    function scanSingleUrl(tabId, pageUrl, modelName) {
      backendFetch('/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: pageUrl, model: modelName }),
      })
        .then(r => r.json())
        .then(data => {
          const isPhishing = data.prediction && data.prediction.includes('PHISHING');
          const confNum = parseFloat(data.confidence) || 0;

          if (isPhishing) {
            chrome.storage.local.set({ analysisResult: { status: 'PHISHING', confidence: confNum / 100 } });
            chrome.action.setBadgeText({ text: '!', tabId });
            chrome.action.setBadgeBackgroundColor({ color: '#d9534f', tabId });
          } else {
            chrome.storage.local.set({ analysisResult: { status: 'LEGITIMATE' } });
            chrome.action.setBadgeText({ text: '\u2713', tabId });
            chrome.action.setBadgeBackgroundColor({ color: '#008000', tabId });
          }

          // Also update dashboard stats
          chrome.storage.local.get(['dashboardStats', 'scanHistory'], (result) => {
            const stats = result.dashboardStats || { total: 0, phishing: 0, legitimate: 0, scannedLinks: 0, removedLinks: 0 };
            const history = result.scanHistory || [];
            stats.total += 1;
            stats.scannedLinks = (stats.scannedLinks || 0) + 1;
            if (isPhishing) { stats.phishing += 1; } else { stats.legitimate += 1; }
            history.push({
              type: 'single',
              url: pageUrl,
              prediction: data.prediction,
              confidence: confNum,
              timestamp: Date.now() / 1000,
            });
            chrome.storage.local.set({ dashboardStats: stats, scanHistory: history });
          });
        })
        .catch(err => {
          console.error('Single URL scan error:', err);
          chrome.action.setBadgeText({ text: 'X', tabId });
          chrome.action.setBadgeBackgroundColor({ color: '#FFA500', tabId });
        });
    }

    function analyzeAndCleanPage(tabId) {
      // 1. Get all links from the page
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        function: getAllLinksFromPage,
      }, (injectionResults) => {
        if (chrome.runtime.lastError) {
          console.error('Error injecting script:', chrome.runtime.lastError.message);
          return;
        }
        // If injection is successful, results will be an array.
        if (!injectionResults || injectionResults.length === 0) {
            console.log("Could not inject script into the page. It might be a protected page.");
            return;
        }
        const pageLinks = injectionResults[0].result;
        if (!pageLinks) {
            console.log("No links found or could not retrieve links.");
            return;
        }
        
        // Filter to ensure only http/https links are sent to avoid server crashes
        const httpLinks = pageLinks.filter(link => link.startsWith('http://') || link.startsWith('https://'));
        console.log(`Found ${pageLinks.length} unique links. ${httpLinks.length} are HTTP/HTTPS. Analyzing...`);
    
        // 2. Send links to the backend for batch prediction
        chrome.storage.local.get(['selectedModel'], (modelData) => {
          const selectedModel = modelData.selectedModel || 'distilbert';
          backendFetch('/batch_predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: httpLinks, model: selectedModel }),
          })
        .then(response => {
          if (!response.ok) {
            throw new Error(`Server error: ${response.status} ${response.statusText}`);
          }
          return response.json();
        })
        .then(data => {
          const phishingLinksWithConfidence = data.phishing_links || [];
          
          // Update Dashboard Stats
          chrome.storage.local.get(['dashboardStats', 'scanHistory'], (result) => {
            const stats = result.dashboardStats || { total: 0, phishing: 0, legitimate: 0, scannedLinks: 0, removedLinks: 0 };
            const history = result.scanHistory || [];
            
            stats.total += 1;
            stats.scannedLinks = (stats.scannedLinks || 0) + httpLinks.length;
            if (phishingLinksWithConfidence && phishingLinksWithConfidence.length > 0) {
              stats.phishing += 1;
            } else {
              stats.legitimate += 1;
            }

            // Add new entry to history
            history.push({
              type: 'batch',
              phishing_links: phishingLinksWithConfidence,
              total_scanned: httpLinks.length,
              timestamp: Date.now() / 1000 // Store as seconds to match previous format
            });

            chrome.storage.local.set({ dashboardStats: stats, scanHistory: history });

            // Build full per-URL result list for the Analyser tab table
            const phishingUrlSet = new Set(phishingLinksWithConfidence.map(p => p.url));
            const allUrlResults = httpLinks.map(url => {
              const match = phishingLinksWithConfidence.find(p => p.url === url);
              return {
                url,
                label:      phishingUrlSet.has(url) ? 'PHISHING' : 'LEGITIMATE',
                confidence: match ? (match.confidence * 100).toFixed(2) : null,
              };
            });
            chrome.storage.local.set({
              latestBatchScan: {
                results:   allUrlResults,
                timestamp: Date.now() / 1000,
              }
            });
          });

          if (phishingLinksWithConfidence && phishingLinksWithConfidence.length > 0) {
            // Extract URLs and find the highest confidence score
            const phishingLinks = phishingLinksWithConfidence.map(link => link.url);
            const highestConfidence = Math.max(...phishingLinksWithConfidence.map(link => link.confidence));
    
            console.log(`Found ${phishingLinks.length} phishing links. Highest confidence: ${highestConfidence}`);
            
            // Store the analysis result
            chrome.storage.local.set({ analysisResult: { status: 'PHISHING', confidence: highestConfidence } });
    
            // 3. Take action based on settings
            chrome.storage.local.get(['protectionEnabled', 'warningEnabled'], (settings) => {
              // Prioritize warning over removal. If warning mode is on, highlight.
              // Otherwise, if protection mode is on, remove.
              if (settings.warningEnabled === true) {
                // Highlight and Warn (Warning Mode)
                console.log('Action: Highlighting links based on warningEnabled=true.');
                chrome.scripting.executeScript({
                  target: { tabId: tabId },
                  function: highlightAndWarnLinks,
                  args: [phishingLinksWithConfidence],
                }, (warnResult) => {
                  if (chrome.runtime.lastError) {
                    console.error('Error injecting warning script:', chrome.runtime.lastError.message);
                    return;
                  }
                  const count = warnResult && warnResult[0] ? warnResult[0].result : 0;
                  console.log(`Highlighted ${count} phishing link(s).`);
                  chrome.action.setBadgeText({ text: '!', tabId: tabId });
                  chrome.action.setBadgeBackgroundColor({ color: '#FFA500', tabId: tabId }); // Orange for warning
                });
              } else if (settings.protectionEnabled === true) {
                // Remove links (Standard Protection)
                console.log('Action: Removing links based on protectionEnabled=true.');
                chrome.scripting.executeScript({
                  target: { tabId: tabId },
                  function: removeSpecificLinks,
                  args: [phishingLinks],
                }, (removalResult) => {
                  if (chrome.runtime.lastError) {
                    console.error('Error injecting removal script:', chrome.runtime.lastError.message);
                    return;
                  }
                  const count = removalResult && removalResult[0] ? removalResult[0].result : 0;
                  console.log(`Successfully removed ${count} phishing link(s).`);
                  
                  // Update removed links count
                  chrome.storage.local.get(['dashboardStats'], (result) => {
                    const stats = result.dashboardStats || { total: 0, phishing: 0, legitimate: 0, scannedLinks: 0, removedLinks: 0 };
                    stats.removedLinks = (stats.removedLinks || 0) + count;
                    chrome.storage.local.set({ dashboardStats: stats });
                  });
                  
                  // Show a badge indicating action was taken
                  chrome.action.setBadgeText({ text: '!', tabId: tabId });
                  chrome.action.setBadgeBackgroundColor({ color: '#FF0000', tabId: tabId });
                });
              } else {
                // Scan Only Mode: Just show badge if phishing detected
                chrome.action.setBadgeText({ text: '!', tabId: tabId });
                chrome.action.setBadgeBackgroundColor({ color: '#d9534f', tabId: tabId });
              }
            });
          } else {
            console.log('No phishing links were found on this page.');
            // Store the analysis result
            chrome.storage.local.set({ analysisResult: { status: 'LEGITIMATE' } });
            // Show a badge indicating the page is safe
            chrome.action.setBadgeText({ text: '✓', tabId: tabId });
            chrome.action.setBadgeBackgroundColor({ color: '#008000', tabId: tabId });
          }
        })
        .catch(error => {
          console.error('Error during batch prediction:', error);
           // Indicate an error occurred
           chrome.action.setBadgeText({ text: 'X', tabId: tabId });
           chrome.action.setBadgeBackgroundColor({ color: '#FFA500', tabId: tabId });
        });
        }); // end chrome.storage.local.get(['selectedModel'])
  });
}

// These functions will be injected into the content page, so they don't have
// access to the background script's scope.

function getAllLinksFromPage() {
  // Ensure we are in a document context before proceeding.
  if (typeof document === 'undefined') return [];
  const uniqueHrefs = new Set();

  // Collect href from <a> elements
  document.querySelectorAll('a[href]').forEach(el => uniqueHrefs.add(el.href));

  // Collect src from <img> elements (including lazy-loaded data-src)
  document.querySelectorAll('img[src]').forEach(el => {
    if (el.src) uniqueHrefs.add(el.src);
  });
  document.querySelectorAll('img[data-src]').forEach(el => {
    if (el.dataset.src) uniqueHrefs.add(el.dataset.src);
  });

  // Collect href/data-href/data-url from container elements
  // (<li>, <tr>, <div>, <h1>-<h6>, <section>, <article>, <blockquote>)
  const containers = 'li[href], li[data-href], li[data-url], ' +
    'tr[href], tr[data-href], tr[data-url], ' +
    'div[href], div[data-href], div[data-url], ' +
    'h1[href], h2[href], h3[href], h4[href], h5[href], h6[href], ' +
    'section[href], section[data-href], article[href], article[data-href], ' +
    'blockquote[href], blockquote[data-href]';
  document.querySelectorAll(containers).forEach(el => {
    const val = el.getAttribute('href') || el.dataset.href || el.dataset.url;
    if (val) {
      try { uniqueHrefs.add(new URL(val, document.location.href).href); }
      catch(e) { /* skip invalid URLs */ }
    }
  });

  // Collect src from <iframe>, <embed>, <source>
  document.querySelectorAll('iframe[src], embed[src], source[src]').forEach(el => {
    if (el.src) uniqueHrefs.add(el.src);
  });

  return Array.from(uniqueHrefs);
}

function removeSpecificLinks(phishingLinks) {
  if (typeof document === 'undefined') return 0;
  const phishingSet = new Set(phishingLinks);
  const alreadyRemoved = new Set();
  let removedCount = 0;

  // Helper: find the nearest meaningful container to remove
  // Walks up from the element to find <tr>, <li>, or heading that wraps it
  function findRemovableAncestor(el) {
    const containerTags = ['TR', 'LI', 'ARTICLE', 'SECTION', 'BLOCKQUOTE'];
    let current = el.parentElement;
    let candidate = el; // default: remove just the element itself
    while (current && current !== document.body) {
      if (containerTags.includes(current.tagName)) {
        candidate = current;
        break; // stop at the first meaningful container
      }
      // If the parent is a heading (H1-H6), remove the whole heading
      if (/^H[1-6]$/.test(current.tagName)) {
        candidate = current;
        break;
      }
      current = current.parentElement;
    }
    return candidate;
  }

  // Process <a> elements with phishing hrefs
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  for (const anchor of anchors) {
    if (!phishingSet.has(anchor.href)) continue;
    const target = findRemovableAncestor(anchor);
    if (alreadyRemoved.has(target)) continue;
    alreadyRemoved.add(target);
    if (target.parentNode) {
      target.parentNode.removeChild(target);
      removedCount++;
    }
  }

  // Process <img> elements with phishing src
  const images = Array.from(document.querySelectorAll('img[src]'));
  for (const img of images) {
    if (!phishingSet.has(img.src)) continue;
    const target = findRemovableAncestor(img);
    if (alreadyRemoved.has(target)) continue;
    alreadyRemoved.add(target);
    if (target.parentNode) {
      target.parentNode.removeChild(target);
      removedCount++;
    }
  }

  return removedCount;
}

// --- Blocking Popup: predict current page URL and redirect to warning page ---
// Use webNavigation.onCommitted for EARLY interception (fires before page renders)
// Use chrome.storage.session for allowed URLs (survives service worker restarts)

// --- Blocking Popup helper: shared logic for URL checking ---
const _pendingBlockChecks = new Set();  // Dedup: prevent double /predict for same tab+url

function _checkAndBlockUrl(tabId, pageUrl) {
  const key = `${tabId}:${pageUrl}`;
  if (_pendingBlockChecks.has(key)) return;
  _pendingBlockChecks.add(key);
  // Auto-clear after 10s to avoid memory leak
  setTimeout(() => _pendingBlockChecks.delete(key), 10000);
  // Skip non-http pages and extension pages
  if (!pageUrl.startsWith('http://') && !pageUrl.startsWith('https://')) return;

  // Skip localhost / local network
  try {
    const urlObj = new URL(pageUrl);
    const host = urlObj.hostname;
    if (host === '127.0.0.1' || host === 'localhost' ||
        host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.16.')) {
      return;
    }
  } catch (e) { return; }

  chrome.storage.local.get(['blockingPopupEnabled', 'selectedModel'], (data) => {
    console.log('[BlockingPopup] blockingPopupEnabled =', data.blockingPopupEnabled, '| URL:', pageUrl);
    if (!data.blockingPopupEnabled) return;

    // Check if user already allowed this URL (persisted in session storage)
    chrome.storage.session.get(['allowedBlockedUrls'], (sessionData) => {
      const allowed = sessionData.allowedBlockedUrls || [];
      if (allowed.includes(pageUrl)) {
        console.log('[BlockingPopup] URL is user-allowed, skipping:', pageUrl);
        return;
      }

      const modelName = data.selectedModel || 'distilbert';
      console.log('[BlockingPopup] Sending /predict for:', pageUrl, 'model:', modelName);

      backendFetch('/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: pageUrl, model: modelName }),
      })
        .then(r => {
          console.log('[BlockingPopup] /predict response status:', r.status);
          return r.json();
        })
        .then(result => {
          console.log('[BlockingPopup] Prediction result:', JSON.stringify(result));
          const confStr = result.confidence || '0%';
          const confNum = parseFloat(confStr);
          if (result.prediction && result.prediction.includes('PHISHING') && confNum >= 50) {
            const level = confNum >= 85 ? 'phishing' : 'suspicious';
            const warningUrl = chrome.runtime.getURL('warning.html')
              + '?level=' + encodeURIComponent(level)
              + '&confidence=' + encodeURIComponent(confNum)
              + '&url=' + encodeURIComponent(pageUrl);
            console.log('[BlockingPopup] REDIRECTING tab', tabId, 'to warning page. Level:', level, 'Confidence:', confNum);
            chrome.tabs.update(tabId, { url: warningUrl }, () => {
              if (chrome.runtime.lastError) {
                console.warn('[BlockingPopup] tabs.update failed:', chrome.runtime.lastError.message,
                  '— retrying in 500ms');
                // Tab may be showing error page; retry after short delay
                setTimeout(() => {
                  chrome.tabs.update(tabId, { url: warningUrl }, () => {
                    if (chrome.runtime.lastError) {
                      console.error('[BlockingPopup] Retry also failed:', chrome.runtime.lastError.message);
                    }
                  });
                }, 500);
              }
            });
          } else {
            console.log('[BlockingPopup] URL is safe, no redirect needed.');
          }
        })
        .catch(err => console.error('[BlockingPopup] Predict FETCH error:', err));
    });
  });
}

// Use onBeforeNavigate for earliest interception (fires before the request is made)
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  _checkAndBlockUrl(details.tabId, details.url);
});

// Also listen on onCommitted as a fallback (fires after server responds)
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  _checkAndBlockUrl(details.tabId, details.url);
});

function highlightAndWarnLinks(phishingLinksWithConfidence) {
  if (typeof document === 'undefined') return 0;

  const phishingMap = {};
  phishingLinksWithConfidence.forEach(item => { phishingMap[item.url] = item; });
  const alreadyHighlighted = new Set();
  let highlightedCount = 0;
  let maxConfidence = 0;

  // Helper: find the nearest meaningful container to highlight
  function findHighlightableAncestor(el) {
    const containerTags = ['TR', 'LI', 'ARTICLE', 'SECTION', 'BLOCKQUOTE'];
    let current = el.parentElement;
    let candidate = el;
    while (current && current !== document.body) {
      if (containerTags.includes(current.tagName)) {
        candidate = current;
        break;
      }
      if (/^H[1-6]$/.test(current.tagName)) {
        candidate = current;
        break;
      }
      current = current.parentElement;
    }
    return candidate;
  }

  // Helper: apply highlight styles to an element and its container
  function applyHighlight(el, container, conf) {
    // Style the direct element (link / image)
    el.style.backgroundColor = 'rgba(250, 118, 140, 0.57)';
    el.style.border = '2px solid #ff0000';
    el.style.color = '#ff0000';
    el.style.fontWeight = 'bold';
    el.title = `⚠️ Phishing Risk! Confidence: ${(conf * 100).toFixed(2)}%`;

    // If the container is different from the element, highlight the container too
    if (container !== el) {
      container.style.backgroundColor = 'rgba(255, 200, 200, 0.4)';
      container.style.border = '2px dashed #ff0000';
      container.style.borderRadius = '4px';
      container.style.position = 'relative';

      // Add a small warning badge to the container if not already added
      if (!container.querySelector('.cyber-ext-phishing-badge')) {
        const badge = document.createElement('span');
        badge.className = 'cyber-ext-phishing-badge';
        badge.textContent = '⚠️ Phishing';
        badge.style.cssText = `
          position: absolute; top: -10px; right: -10px;
          background: #d9534f; color: #fff; font-size: 11px;
          padding: 2px 7px; border-radius: 10px; z-index: 999999;
          font-family: Arial, sans-serif; font-weight: bold;
          box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        `;
        container.appendChild(badge);
      }
    }
  }

  // Process <a> elements
  document.querySelectorAll('a[href]').forEach(link => {
    const data = phishingMap[link.href];
    if (!data) return;
    const conf = data.confidence || 0;
    if (conf > maxConfidence) maxConfidence = conf;
    const container = findHighlightableAncestor(link);
    applyHighlight(link, container, conf);
    if (!alreadyHighlighted.has(link)) {
      alreadyHighlighted.add(link);
      highlightedCount++;
    }
  });

  // Process <img> elements
  document.querySelectorAll('img[src]').forEach(img => {
    const data = phishingMap[img.src];
    if (!data) return;
    const conf = data.confidence || 0;
    if (conf > maxConfidence) maxConfidence = conf;
    const container = findHighlightableAncestor(img);
    applyHighlight(img, container, conf);
    if (!alreadyHighlighted.has(img)) {
      alreadyHighlighted.add(img);
      highlightedCount++;
    }
  });

  if (highlightedCount > 0) {
    // Remove existing popup if any
    const existingPopup = document.getElementById('cyber-extension-warning-popup');
    if (existingPopup) existingPopup.remove();

    // Create warning popup on page
    const popup = document.createElement('div');
    popup.id = 'cyber-extension-warning-popup';
    popup.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 320px;
      background-color: #fff3cd;
      color: #856404;
      border: 1px solid #ffeeba;
      padding: 15px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 2147483647;
      font-family: Arial, sans-serif;
      font-size: 14px;
      text-align: left;
    `;

    const title = document.createElement('h3');
    title.innerText = '⚠️ Malicious Content Detected';
    title.style.margin = '0 0 10px 0';
    title.style.fontSize = '16px';
    title.style.color = '#721c24';
    popup.appendChild(title);

    const message = document.createElement('p');
    message.innerHTML = `Found <strong>${highlightedCount}</strong> potential phishing element(s).<br>Highest Confidence: <strong>${(maxConfidence * 100).toFixed(2)}%</strong><br>Affected links, images, and their containers are highlighted in red.`;
    message.style.margin = '0 0 10px 0';
    popup.appendChild(message);

    const closeBtn = document.createElement('button');
    closeBtn.innerText = 'Dismiss';
    closeBtn.style.cssText = `
      background-color: #856404;
      color: white;
      border: none;
      padding: 5px 10px;
      border-radius: 3px;
      cursor: pointer;
      float: right;
    `;
    closeBtn.onclick = () => popup.remove();
    popup.appendChild(closeBtn);

    document.body.appendChild(popup);
  }

  return highlightedCount;
}
