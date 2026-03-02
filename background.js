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
  chrome.storage.local.set({ protectionEnabled: false });
  console.log('Protection state initialized to false.');
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
          chrome.storage.local.get('protectionEnabled', (data) => {
            if (data.protectionEnabled) {
              console.log('Protection is ON. Auto-analyzing tab:', tab.url);
              analyzeAndCleanPage(tabId);
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
        fetch('http://127.0.0.1:5000/batch_predict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: httpLinks }),
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
          });

          if (phishingLinksWithConfidence && phishingLinksWithConfidence.length > 0) {
            // Extract URLs and find the highest confidence score
            const phishingLinks = phishingLinksWithConfidence.map(link => link.url);
            const highestConfidence = Math.max(...phishingLinksWithConfidence.map(link => link.confidence));
    
            console.log(`Found ${phishingLinks.length} phishing links. Highest confidence: ${highestConfidence}`);
            
            // Store the analysis result
            chrome.storage.local.set({ analysisResult: { status: 'PHISHING', confidence: highestConfidence } });
    
            // 3. Inject script to remove only the identified phishing links
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              function: removeSpecificLinks,
              args: [phishingLinks],
            }, (removalResult) => {
              if (chrome.runtime.lastError) {
                console.error('Error injecting removal script:', chrome.runtime.lastError.message);
                return;
              }
              const count = removalResult[0].result;
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
