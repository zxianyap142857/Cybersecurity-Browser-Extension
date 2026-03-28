chrome.runtime.onInstalled.addListener(() => {
  // Initialize dashboard stats if they don't exist
  chrome.storage.local.get(['dashboardStats', 'scanHistory'], (result) => {
    if (!result.dashboardStats) {
      chrome.storage.local.set({ dashboardStats: { total: 0, phishing: 0, legitimate: 0, scannedLinks: 0, removedLinks: 0 } });
    }
    if (!result.scanHistory) {
      chrome.storage.local.set({ scanHistory: [] });
    }
  });
  chrome.storage.local.set({ protectionEnabled: false, warningEnabled: true, urlScanningEnabled: false, blockingPopupEnabled: false });
  console.log('Protection states initialized.');
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
          chrome.storage.local.get(['protectionEnabled', 'warningEnabled', 'urlScanningEnabled', 'blockingPopupEnabled', 'selectedModel'], (data) => {
            if (data.protectionEnabled || data.warningEnabled || data.urlScanningEnabled) {
              console.log('Protection/Warning/Scanning is ON. Auto-analyzing tab:', tab.url);
              analyzeAndCleanPage(tabId);
            }
            // Blocking popup: predict the current page URL and show overlay if phishing
            if (data.blockingPopupEnabled) {
              checkAndBlockPage(tabId, tab.url, data.selectedModel || 'distilbert');
            }
          });
        }
      }
    });
    
    // Listener for messages from other parts of the extension (e.g., the popup)
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
          fetch('http://127.0.0.1:5000/batch_predict', {
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
  const links = Array.from(document.getElementsByTagName('a'));
  const uniqueHrefs = new Set(links.map(link => link.href));
  return Array.from(uniqueHrefs);
}

function removeSpecificLinks(phishingLinks) {
  if (typeof document === 'undefined') return 0;
  const links = document.getElementsByTagName('a');
  let removedCount = 0;
  for (let i = links.length - 1; i >= 0; i--) {
    if (phishingLinks.includes(links[i].href)) {
      links[i].parentNode.removeChild(links[i]);
      removedCount++;
    }
  }
  return removedCount;
}

// --- Blocking Popup: predict current page URL and show full-page warning ---
function checkAndBlockPage(tabId, pageUrl, modelName) {
  fetch('http://127.0.0.1:5000/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: pageUrl, model: modelName }),
  })
    .then(r => r.json())
    .then(data => {
      const confStr = data.confidence || '0%';
      const confNum = parseFloat(confStr);   // e.g. 92.35
      if (data.prediction && data.prediction.includes('PHISHING') && confNum >= 50) {
        const level = confNum >= 85 ? 'phishing' : 'suspicious';
        chrome.scripting.executeScript({
          target: { tabId },
          func: showBlockingOverlay,
          args: [level, confNum, pageUrl],
        });
      }
    })
    .catch(err => console.error('Blocking popup predict error:', err));
}

function showBlockingOverlay(level, confidence, pageUrl) {
  // Don't inject twice
  if (document.getElementById('cyber-ext-blocking-overlay')) return;

  const isPhishing = level === 'phishing';
  const bgColor = isPhishing ? '#dc3545' : '#fd7e14';
  const icon = isPhishing ? '🛑' : '⚠️';
  const title = isPhishing ? 'Phishing Website Detected!' : 'Suspicious Website Detected!';
  const description = isPhishing
    ? 'This website has been identified as a <strong>phishing website</strong> with high confidence. It may attempt to steal your personal information, credentials, or financial data.'
    : 'This website has been flagged as <strong>suspicious</strong>. It may contain potentially harmful content. Proceed with caution.';

  const overlay = document.createElement('div');
  overlay.id = 'cyber-ext-blocking-overlay';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.92); z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;

  overlay.innerHTML = `
    <div style="background: #fff; border-radius: 16px; padding: 40px; max-width: 520px; width: 90%;
                text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5);">
      <div style="font-size: 64px; margin-bottom: 16px;">${icon}</div>
      <h1 style="margin: 0 0 8px 0; font-size: 24px; color: ${bgColor};">${title}</h1>
      <p style="font-size: 14px; color: #666; margin: 0 0 16px 0;">Confidence: <strong style="color: ${bgColor};">${confidence.toFixed(2)}%</strong></p>
      <p style="font-size: 15px; color: #333; line-height: 1.5; margin: 0 0 12px 0;">${description}</p>
      <p style="font-size: 13px; color: #888; word-break: break-all; margin: 0 0 28px 0; padding: 8px; background: #f5f5f5; border-radius: 6px;">${pageUrl}</p>
      <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
        <button id="cyber-ext-go-back-btn" style="
          background: ${bgColor}; color: #fff; border: none; padding: 12px 32px;
          border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;
          min-width: 140px;">← Go Back</button>
        <button id="cyber-ext-proceed-btn" style="
          background: transparent; color: #888; border: 2px solid #ccc; padding: 12px 32px;
          border-radius: 8px; font-size: 16px; cursor: pointer;
          min-width: 140px;">Proceed Anyway</button>
      </div>
      <p style="font-size: 11px; color: #aaa; margin-top: 20px;">Detected by Cybersecurity Browser Extension</p>
    </div>
  `;

  document.body.appendChild(overlay);

  // Block scrolling
  document.body.style.overflow = 'hidden';

  document.getElementById('cyber-ext-go-back-btn').addEventListener('click', () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.close();
    }
  });

  document.getElementById('cyber-ext-proceed-btn').addEventListener('click', () => {
    overlay.remove();
    document.body.style.overflow = '';
  });
}

function highlightAndWarnLinks(phishingLinksWithConfidence) {
  if (typeof document === 'undefined') return 0;
  
  const links = document.getElementsByTagName('a');
  const phishingUrls = phishingLinksWithConfidence.map(item => item.url);
  let highlightedCount = 0;
  let maxConfidence = 0;

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (phishingUrls.includes(link.href)) {
      // Highlight Style
      link.style.backgroundColor = 'rgba(250, 118, 140, 0.57)'; // Pink with 50% transparency
      link.style.border = '2px solid #ff0000'; // Red border
      link.style.color = '#ff0000'; // Red text
      link.style.fontWeight = 'bold';
      
      const linkData = phishingLinksWithConfidence.find(item => item.url === link.href);
      let conf = 0;
      if (linkData) {
          conf = linkData.confidence;
          if (conf > maxConfidence) maxConfidence = conf;
          // Add tooltip
          link.title = `⚠️ Phishing Risk! Confidence: ${(conf * 100).toFixed(2)}%`;
      }
      highlightedCount++;
    }
  }

  if (highlightedCount > 0) {
      // Create Popup on page
      const popup = document.createElement('div');
      popup.id = 'cyber-extension-warning-popup';
      popup.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        width: 300px;
        background-color: #fff3cd;
        color: #856404;
        border: 1px solid #ffeeba;
        padding: 15px;
        border-radius: 5px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
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
      message.innerHTML = `Found <strong>${highlightedCount}</strong> potential phishing link(s).<br>Highest Confidence: <strong>${(maxConfidence * 100).toFixed(2)}%</strong><br>Malicious links are highlighted in yellow/red.`;
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
