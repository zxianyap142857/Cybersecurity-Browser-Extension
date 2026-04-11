// backendFetch() is provided by config.js (loaded before this script)

document.addEventListener('DOMContentLoaded', () => {
  const toggleMain = document.getElementById('protectionToggle');
  const toggleURL = document.getElementById('protectionToggleURL');
  const toggleWarning = document.getElementById('warningToggle');
  const statusDiv = document.getElementById('status');
  const confidenceDiv = document.getElementById('confidence');
  const hamburgerIcon = document.getElementById('hamburger-icon');
  const sidebar = document.getElementById('sidebar');
  const contentSections = document.querySelectorAll('.content-section');

  let sidebarOpen = false;

  // --- Theme Management ---
  const themeToggleBtn = document.getElementById('theme-toggle-btn');

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
    } else {
      document.body.removeAttribute('data-theme');
    }
    if (themeToggleBtn) {
      themeToggleBtn.textContent = theme === 'dark' ? 'Switch to Light' : 'Switch to Dark';
    }
    if (typeof Chart !== 'undefined') {
      const isDark = theme === 'dark';
      Chart.defaults.color = isDark ? '#a0a0b8' : '#666666';
      Chart.defaults.borderColor = isDark ? '#252548' : '#e0e0e0';
    }
  }

  chrome.storage.local.get(['themePreference'], (result) => {
    applyTheme(result.themePreference || 'light');
    loadDashboardData();
  });

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const isDark = document.body.getAttribute('data-theme') === 'dark';
      const next = isDark ? 'light' : 'dark';
      applyTheme(next);
      chrome.storage.local.set({ themePreference: next });
      loadDashboardData(); // Re-render charts with new theme
    });
  }

  // --- Backend Mode Selector ---
  const backendModeSelect = document.getElementById('backend-mode-select');
  if (backendModeSelect) {
    chrome.storage.local.get(['backendMode'], (data) => {
      backendModeSelect.value = data.backendMode || BACKEND_CONFIG.defaultMode;
    });
    backendModeSelect.addEventListener('change', () => {
      chrome.storage.local.set({ backendMode: backendModeSelect.value });
    });
  }

  hamburgerIcon.addEventListener('click', () => {
    if (sidebarOpen) {
      sidebar.style.width = '80px';
      sidebar.classList.remove('sidebar-open');
      contentSections.forEach(section => {
        section.style.marginLeft = '80px';
      });
    } else {
      sidebar.style.width = '250px';
      sidebar.classList.add('sidebar-open');
      contentSections.forEach(section => {
        section.style.marginLeft = '250px';
      });
    }
    sidebarOpen = !sidebarOpen;
  });

  function showContent(contentId) {
    contentSections.forEach(section => {
      section.style.display = 'none';
    });
    const sectionToShow = document.getElementById(contentId);
    if (sectionToShow) {
      sectionToShow.style.display = 'block';
    }
  }

  // Sidebar link event listeners
  document.getElementById('dashboard-link').addEventListener('click', () => {
    showContent('dashboard-content');
    loadDashboardData();
  });
  document.getElementById('analyse-url-link').addEventListener('click', () => {
    showContent('analyse-url-content');
    loadBatchScanResults();
  });
  document.getElementById('knowledge-base-management-link').addEventListener('click', () => {
    showContent('knowledge-base-management-content');
    loadKbRows();
  });
  document.getElementById('website-auditing-link').addEventListener('click', () => showContent('website-auditing-content'));
  document.getElementById('malicious-content-analyser-link').addEventListener('click', () => showContent('malicious-content-analyser-content'));
  document.getElementById('report-phishing-link').addEventListener('click', () => {
    showContent('report-phishing-content');
    const sel = document.getElementById('report-model-select');
    if (sel) fetchReportCount(sel.value);
    fetchFlStatus();
  });
  document.getElementById('cookies-analyzer-link').addEventListener('click', () => showContent('cookie-content'));


  function updateUI(result) {
    if (!result) {
      confidenceDiv.innerHTML = '';
      return;
    }

    switch (result.status) {
      case 'LOCAL FILE':
        confidenceDiv.innerHTML = 'You are currently in local Directories';
        break;
      case 'LOCAL NETWORK':
        confidenceDiv.innerHTML = `You currently in the Private Network`;
        break;
      case 'LEGITIMATE':
        confidenceDiv.innerHTML = `<b>Result:</b> LEGITIMATE / SAFE `;
        break;
      case 'PHISHING':
        confidenceDiv.innerHTML = `<b>Result:</b> PHISHING / MALICIOUS<br> <b>Confidence:</b> ${(result.confidence * 100).toFixed(2)}%`;
        break;
      default:
        confidenceDiv.innerHTML = '';
        break;
    }
  }

  // Model selector persistence
  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    chrome.storage.local.get(['selectedModel'], (data) => {
      if (data.selectedModel) modelSelect.value = data.selectedModel;
    });
    modelSelect.addEventListener('change', () => {
      chrome.storage.local.set({ selectedModel: modelSelect.value });
    });
  }

  // --- Update Model Button ---
  const updateModelBtn = document.getElementById('update-model-btn');
  const modelUpdateProgress = document.getElementById('model-update-progress');
  const modelUpdateLabel = document.getElementById('model-update-label');
  const modelUpdatePercent = document.getElementById('model-update-percent');
  const modelUpdateBar = document.getElementById('model-update-bar');
  const modelUpdateFile = document.getElementById('model-update-file');

  let modelUpdatePollTimer = null;

  function pollModelUpdateStatus() {
    backendFetch('/model/update_status')
      .then(r => r.json())
      .then(status => {
        if (status.state === 'downloading') {
          modelUpdateProgress.style.display = 'block';
          modelUpdateBar.style.width = status.progress + '%';
          modelUpdatePercent.textContent = status.progress + '%';
          modelUpdateLabel.textContent = `Downloading ${status.model} model... (${status.completed_files}/${status.total_files} files)`;
          modelUpdateFile.textContent = status.current_file ? `Current: ${status.current_file}` : '';
          modelUpdateBtn.disabled = true;
          modelUpdateBtn.textContent = 'Updating...';
          modelUpdateBtn.style.backgroundColor = '#999';
        } else if (status.state === 'done') {
          modelUpdateBar.style.width = '100%';
          modelUpdateBar.style.background = 'linear-gradient(90deg, #4caf50, #388e3c)';
          modelUpdatePercent.textContent = '100%';
          modelUpdateLabel.textContent = `${status.model} model updated successfully!`;
          modelUpdateLabel.style.color = '#2e7d32';
          modelUpdateFile.textContent = '';
          modelUpdateBtn.disabled = false;
          modelUpdateBtn.textContent = 'Update Model';
          modelUpdateBtn.style.backgroundColor = '#ff9800';
          clearInterval(modelUpdatePollTimer);
          modelUpdatePollTimer = null;
          // Hide progress after 5 seconds
          setTimeout(() => {
            modelUpdateProgress.style.display = 'none';
            modelUpdateBar.style.background = 'linear-gradient(90deg, #ff9800, #f57c00)';
            modelUpdateLabel.style.color = '#333';
          }, 5000);
        } else if (status.state === 'error') {
          modelUpdateBar.style.width = '100%';
          modelUpdateBar.style.background = '#f44336';
          modelUpdatePercent.textContent = 'Error';
          modelUpdateLabel.textContent = `Update failed: ${status.error}`;
          modelUpdateLabel.style.color = '#c62828';
          modelUpdateFile.textContent = '';
          modelUpdateBtn.disabled = false;
          modelUpdateBtn.textContent = 'Retry Update';
          modelUpdateBtn.style.backgroundColor = '#f44336';
          clearInterval(modelUpdatePollTimer);
          modelUpdatePollTimer = null;
        } else {
          // idle — stop polling
          clearInterval(modelUpdatePollTimer);
          modelUpdatePollTimer = null;
        }
      })
      .catch(err => {
        console.warn('[ModelUpdate] Poll error:', err);
      });
  }

  if (updateModelBtn) {
    updateModelBtn.addEventListener('click', () => {
      const selectedModel = modelSelect ? modelSelect.value : 'distilbert';
      updateModelBtn.disabled = true;
      updateModelBtn.textContent = 'Starting...';
      updateModelBtn.style.backgroundColor = '#999';

      // Reset progress bar appearance
      modelUpdateProgress.style.display = 'block';
      modelUpdateBar.style.width = '0%';
      modelUpdateBar.style.background = 'linear-gradient(90deg, #ff9800, #f57c00)';
      modelUpdatePercent.textContent = '0%';
      modelUpdateLabel.textContent = 'Connecting to cloud storage...';
      modelUpdateLabel.style.color = '#333';
      modelUpdateFile.textContent = '';

      backendFetch('/model/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.status === 'already_running') {
            modelUpdateLabel.textContent = 'Update already in progress...';
          }
          // Start polling for progress
          if (!modelUpdatePollTimer) {
            modelUpdatePollTimer = setInterval(pollModelUpdateStatus, 1000);
          }
        })
        .catch(err => {
          modelUpdateLabel.textContent = `Failed to start: ${err.message}`;
          modelUpdateLabel.style.color = '#c62828';
          modelUpdateBar.style.background = '#f44336';
          modelUpdateBar.style.width = '100%';
          modelUpdatePercent.textContent = 'Error';
          updateModelBtn.disabled = false;
          updateModelBtn.textContent = 'Retry Update';
          updateModelBtn.style.backgroundColor = '#f44336';
        });
    });
  }

  // Initialize the popup's UI based on stored state
  chrome.storage.local.get(['protectionEnabled', 'warningEnabled', 'urlScanningEnabled', 'analysisResult'], (data) => {
    var protectionOn = !!data.protectionEnabled;
    var warningOn = !!data.warningEnabled;
    var urlScanningOn = !!data.urlScanningEnabled;

    if (toggleMain) toggleMain.checked = protectionOn;
    if (toggleURL) toggleURL.checked = urlScanningOn;
    if (toggleWarning) toggleWarning.checked = warningOn;

    if (protectionOn) {
      statusDiv.textContent = 'Phishing Content Removal is ON';
    } else if (warningOn) {
      statusDiv.textContent = 'Warning & Highlight is ON';
    } else if (urlScanningOn) {
      statusDiv.textContent = 'URL Scanning is ON';
    } else {
      statusDiv.textContent = 'Protection is OFF';
    }

    if (data.protectionEnabled || data.warningEnabled || data.urlScanningEnabled) {
      updateUI(data.analysisResult);
      if (!data.analysisResult) {
        confidenceDiv.innerHTML = '<i>Waiting for analysis...</i>';
      }
    }
  });


  // Function to update state and UI — toggles only set the action mode, no auto scan
  function updateProtectionState(protectionEnabled, warningEnabled) {
    chrome.storage.local.set({ protectionEnabled, warningEnabled }, () => {
      if (toggleMain) toggleMain.checked = protectionEnabled;
      if (toggleWarning) toggleWarning.checked = warningEnabled;

      if (protectionEnabled) {
        statusDiv.textContent = 'Phishing Content Removal is ON';
      } else if (warningEnabled) {
        statusDiv.textContent = 'Warning & Highlight is ON';
      } else {
        statusDiv.textContent = 'Protection is OFF';
      }
      console.log(`State updated - Protection: ${protectionEnabled}, Warning: ${warningEnabled}`);
    });
  }

  // Handle "Remove & Hidden" toggle (Main) - Enables Removal
  const handleProtectionChange = (event) => {
    const isEnabled = event.target.checked;

    // If protection is turned on/off, warning is forced off.
    updateProtectionState(isEnabled, false);
  };

  // Handle "Warning & Highlight" toggle - Enables Warning/Highlighting
  const handleWarningChange = (event) => {
    const isEnabled = event.target.checked;

    // If warning is turned on/off, protection is forced off.
    updateProtectionState(false, isEnabled);
  };

  // Handle "Analyse URLs" toggle (URL) - Scan current page URL only via /predict
  const handleUrlScanningChange = (event) => {
    const isEnabled = event.target.checked;
    chrome.storage.local.set({ urlScanningEnabled: isEnabled }, () => {
      if (isEnabled) {
        statusDiv.textContent = 'URL Scanning is ON';
        confidenceDiv.innerHTML = '<i>Analysing current URL...</i>';
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0 && tabs[0].url) {
            const pageUrl = tabs[0].url;
            const tabId   = tabs[0].id;
            const model   = modelSelect ? modelSelect.value : 'distilbert';

            // Call /predict directly from popup (avoids message-passing issues)
            backendFetch('/predict', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: pageUrl, model }),
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
                // updateUI will fire via storage.onChanged listener
              })
              .catch(err => {
                console.error('URL scan error:', err);
                confidenceDiv.innerHTML = `<span style="color:red;">Error: ${err.message}</span>`;
              });
          }
        });
      } else {
        statusDiv.textContent = 'Protection is OFF';
        confidenceDiv.innerHTML = '';
        chrome.storage.local.remove('analysisResult');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0) {
            chrome.action.setBadgeText({ text: '', tabId: tabs[0].id });
          }
        });
      }
    });
  };

  // Ensure event listeners are correctly assigned to separate functions
  if (toggleMain) toggleMain.addEventListener('change', handleProtectionChange);
  if (toggleURL) toggleURL.addEventListener('change', handleUrlScanningChange);
  if (toggleWarning) toggleWarning.addEventListener('change', handleWarningChange);

  // --- Batch Predict Button ---
  const batchScanActionBtn = document.getElementById('batchScanActionBtn');
  const batchScanActionStatus = document.getElementById('batchScanActionStatus');
  if (batchScanActionBtn) {
    batchScanActionBtn.addEventListener('click', () => {
      chrome.storage.local.get(['protectionEnabled', 'warningEnabled'], (data) => {
        if (!data.protectionEnabled && !data.warningEnabled) {
          if (batchScanActionStatus) batchScanActionStatus.textContent = 'Please enable Warning or Protection toggle first.';
          return;
        }

        batchScanActionBtn.disabled = true;
        batchScanActionBtn.textContent = 'Scanning...';
        if (batchScanActionStatus) batchScanActionStatus.textContent = 'Running batch prediction on all page links...';

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0) {
            chrome.runtime.sendMessage({ action: "analyzeTab", tabId: tabs[0].id }, () => {
              batchScanActionBtn.disabled = false;
              batchScanActionBtn.textContent = 'Batch Predict Page URLs';
              if (batchScanActionStatus) batchScanActionStatus.textContent = 'Batch scan triggered. Results will appear shortly.';
            });
          } else {
            batchScanActionBtn.disabled = false;
            batchScanActionBtn.textContent = 'Batch Predict Page URLs';
          }
        });
      });
    });
  }

  // --- Blocking Popup Toggle ---
  const blockingPopupToggle = document.getElementById('blockingPopupToggle');
  if (blockingPopupToggle) {
    chrome.storage.local.get(['blockingPopupEnabled'], (data) => {
      blockingPopupToggle.checked = !!data.blockingPopupEnabled;
    });
    blockingPopupToggle.addEventListener('change', () => {
      chrome.storage.local.set({ blockingPopupEnabled: blockingPopupToggle.checked });
    });
  }

  // --- Cookie Scrape Toggle persistence ---
  const cookieScrapeToggle = document.getElementById('cookie-scrape-toggle');
  const cookieScrapeHint = document.getElementById('cookie-scrape-hint');
  if (cookieScrapeToggle) {
    chrome.storage.local.get('cookieScrapeEnabled', (res) => {
      const enabled = res.cookieScrapeEnabled !== undefined ? res.cookieScrapeEnabled : true;
      cookieScrapeToggle.checked = enabled;
      updateScrapeHint(enabled);
    });
    cookieScrapeToggle.addEventListener('change', () => {
      chrome.storage.local.set({ cookieScrapeEnabled: cookieScrapeToggle.checked });
      updateScrapeHint(cookieScrapeToggle.checked);
    });
  }
  function updateScrapeHint(enabled) {
    if (!cookieScrapeHint) return;
    if (enabled) {
      cookieScrapeHint.innerHTML =
        '<strong>ON:</strong> Fetches cookie descriptions via web scraping (slower, ~15-25s) &nbsp;|&nbsp; ' +
        '<strong>OFF:</strong> Extracts browser cookies only (instant)';
    } else {
      cookieScrapeHint.innerHTML =
        '<strong>OFF:</strong> Extracting browser cookies only (instant) &mdash; no description lookup';
    }
  }

  const scanCookiesBtn = document.getElementById('scan-cookies-btn');
  if (scanCookiesBtn) {
    scanCookiesBtn.addEventListener('click', () => {
      const cookieList = document.getElementById('cookie-list');
      const scrapeOn = cookieScrapeToggle ? cookieScrapeToggle.checked : true;
      if (scrapeOn) {
        if (cookieList) cookieList.innerHTML = '<p>Scanning cookies &amp; fetching descriptions... Please wait (~15-25s).</p>';
      } else {
        if (cookieList) cookieList.innerHTML = '<p>Extracting cookies...</p>';
      }
      displayCookies(scrapeOn);
    });
  }

  async function displayCookies(withScraping = true) {
    if (!chrome.cookies) {
      console.error('chrome.cookies API is not available.');
      const cookieList = document.getElementById('cookie-list');
      cookieList.innerHTML = '<p>Error: chrome.cookies API is not available. You required to reload the extension.</p>';
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length > 0 && tabs[0].url) {
        try {
          const url = new URL(tabs[0].url);
          const domain = url.hostname;
          console.log('Fetching cookies for domain:', domain, '| scraping:', withScraping);

          // 1. Optionally fetch descriptions from backend (web scraping)
          let descriptions = {};
          if (withScraping) {
            try {
              const response = await backendFetch('/analyze-cookies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain: domain })
              });
              if (response.ok) {
                const data = await response.json();
                if (data.cookies) {
                  data.cookies.forEach(cookieInfo => {
                    const cookieName = cookieInfo[0];
                    const cookieDesc = cookieInfo[2];
                    descriptions[cookieName] = cookieDesc;
                  });
                }
              }
            } catch (e) {
              console.error("Could not fetch cookie descriptions from backend:", e);
            }
          }

          // 2. Get cookies from the browser and build the table
          chrome.cookies.getAll({ domain: domain }, (cookies) => {
            if (chrome.runtime.lastError) {
              console.error('Error getting cookies:', chrome.runtime.lastError);
              const cookieList = document.getElementById('cookie-list');
              cookieList.innerHTML = `<p>Error fetching cookies: ${chrome.runtime.lastError.message}</p>`;
              return;
            }

            const cookieList = document.getElementById('cookie-list');
            cookieList.innerHTML = '';
            if (cookies.length === 0) {
              cookieList.innerHTML = '<p>No cookies found for this domain.</p>';
              return;
            }

            cookies.forEach((cookie, index) => {
              const div = document.createElement('div');
              div.className = 'cookie-card';
              const description = descriptions[cookie.name] || '';
              const expires = cookie.expirationDate ? new Date(cookie.expirationDate * 1000).toLocaleString() : 'Session';

              // Only show Description row if scraping was enabled
              const descRow = withScraping
                ? `<div class="cookie-row"><strong>Description:</strong> ${description || '<em>Not found</em>'}</div>`
                : '';

              div.innerHTML = `
                <div class="cookie-header">Cookie ${index + 1}</div>
                <div class="cookie-body">
                  <div class="cookie-row"><strong>Name:</strong> ${cookie.name}</div>
                  <div class="cookie-row cookie-value-container">
                    <strong>Value:</strong>
                    <span class="masked-value">********</span>
                    <span class="real-value" style="display:none;">${cookie.value}</span>
                    <img src="images/view.png" class="toggle-visibility" width="20" height="20" style="cursor:pointer; vertical-align: middle; margin-left: 5px;">
                  </div>
                  <div class="cookie-row"><strong>Domain:</strong> ${cookie.domain}</div>
                  ${descRow}
                  <div class="cookie-row"><strong>Path:</strong> ${cookie.path}</div>
                  <div class="cookie-row"><strong>Secure:</strong> ${cookie.secure ? 'Yes' : 'No'}</div>
                  <div class="cookie-row"><strong>HttpOnly:</strong> ${cookie.httpOnly ? 'Yes' : 'No'}</div>
                  <div class="cookie-row"><strong>SameSite:</strong> ${cookie.sameSite || 'unspecified'}</div>
                  <div class="cookie-row"><strong>Expires:</strong> ${expires}</div>
                  <div class="cookie-row"><strong>Action:</strong> <input type="image" height="30px" width="30px" src="./images/trash.png" class="delete-cookie-btn" data-cookie-name="${cookie.name}" data-cookie-url="https://${cookie.domain}${cookie.path}" style="vertical-align: middle;"></div>
                </div>
              `;
              cookieList.appendChild(div);
            });

            document.querySelectorAll('.toggle-visibility').forEach((img) => {
              img.addEventListener('click', (event) => {
                const container = event.target.closest('.cookie-value-container');
                const masked = container.querySelector('.masked-value');
                const real = container.querySelector('.real-value');
                const icon = event.target;

                if (real.style.display === 'none') {
                  real.style.display = 'inline';
                  masked.style.display = 'none';
                  icon.src = 'images/hide.png';
                } else {
                  real.style.display = 'none';
                  masked.style.display = 'inline';
                  icon.src = 'images/view.png';
                }
              });
            });

            document.querySelectorAll('.delete-cookie-btn').forEach((button) => {
              button.addEventListener('click', (event) => {
                const cookieName = event.target.dataset.cookieName;
                const cookieUrl = event.target.dataset.cookieUrl;
                chrome.cookies.remove({ url: cookieUrl, name: cookieName }, () => {
                  const scrapeOn = cookieScrapeToggle ? cookieScrapeToggle.checked : true;
                  displayCookies(scrapeOn);
                });
              });
            });
          });
        } catch (e) {
          console.error('Invalid URL:', tabs[0].url, e);
          const cookieList = document.getElementById('cookie-list');
          cookieList.innerHTML = '<p>Cannot fetch cookies for this page.</p>';
        }
      } else {
        const cookieList = document.getElementById('cookie-list');
        cookieList.innerHTML = '<p>Could not get active tab information.</p>';
      }
    });
  }

  // --- Dashboard Logic ---
  let threatChartInstance = null;
  let percentageChartInstance = null;
  let riskScoreChartInstance = null;
  let fullScanHistory = [];

  function loadDashboardData() {
    console.log("Loading dashboard data from local storage...");
    chrome.storage.local.get(['scanHistory'], (result) => {
      const history = result.scanHistory || [];
      fullScanHistory = history; // Store full history for filtering
      console.log("Scan history retrieved:", history);
      updateDashboardUI(history);
    });
  }

  function updateDashboardUI(history) {
    let total = 0;
    let phishing = 0;
    let legitimate = 0;

    // Variables for Today vs Yesterday comparison
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000; // Start of today in seconds
    const yesterdayStart = todayStart - 86400; // Start of yesterday
    
    let todayStats = { total: 0, phishing: 0, legit: 0 };
    let yestStats = { total: 0, phishing: 0, legit: 0 };
    
    const tableBody = document.querySelector('#activity-table tbody');
    if (!tableBody) return;
    
    tableBody.innerHTML = ''; 

    // Check if history exists
    if (!history || history.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 15px; color: var(--text-muted);">No activity recorded yet. Browse websites to generate data.</td></tr>';
      document.getElementById('total-scanned').textContent = 0;
      document.getElementById('phishing-detected').textContent = 0;
      document.getElementById('legitimate-sites').textContent = 0;
      const rateEl = document.getElementById('detection-rate');
      if (rateEl) rateEl.textContent = '0%';
      const scoreEl = document.getElementById('risk-score-value');
      if (scoreEl) scoreEl.textContent = '0';
      const levelEl = document.getElementById('risk-score-level');
      if (levelEl) { levelEl.textContent = 'Low'; levelEl.style.background = '#2ecc71'; levelEl.style.color = 'white'; }
    } else {
      // Sort history by timestamp descending (newest first)
      const reversedHistory = [...history].reverse();

      reversedHistory.forEach((entry, index) => {
        let isPhishing = false;
        let label = '';
        let urlDisplay = '';
        let confidenceDisplay = '';
        let entryTotal = 0;
        let entryPhishing = 0;
        
        if (entry.type === 'batch') {
          const count = entry.total_scanned || 0;
          const p_links = entry.phishing_links || [];
          const p_count = p_links.length;
          
          entryTotal = count;
          entryPhishing = p_count;

          total += count;
          phishing += p_count;
          legitimate += (count - p_count);
          
          if (p_count > 0) isPhishing = true;
          
          urlDisplay = `Batch Scan <br>(${count} URLs)`;
          label = `${p_count} Phishing Link Found`;
          confidenceDisplay = 'N/A';
        } else {
          total += 1;
          const prediction = entry.prediction || '';
          const confidence = entry.confidence || 0;
          
          entryTotal = 1;
          
          if (typeof prediction === 'string' && prediction.includes('PHISHING')) {
            phishing += 1;
            isPhishing = true;
            entryPhishing = 1;
            label = 'PHISHING';
          } else {
            legitimate += 1;
            label = 'LEGITIMATE';
          }
          
          urlDisplay = entry.url;
          confidenceDisplay = (typeof confidence === 'number') ? confidence.toFixed(2) + '%' : confidence;
        }

        // Calculate Today vs Yesterday stats
        const ts = entry.timestamp || 0;
        if (ts >= todayStart) {
            todayStats.total += entryTotal;
            todayStats.phishing += entryPhishing;
            todayStats.legit += (entryTotal - entryPhishing);
        } else if (ts >= yesterdayStart && ts < todayStart) {
            yestStats.total += entryTotal;
            yestStats.phishing += entryPhishing;
            yestStats.legit += (entryTotal - entryPhishing);
        }

        // Add row to table
        const row = document.createElement('tr');
        const date = new Date((entry.timestamp || Date.now()) * 1000);
        const originalIndex = history.length - 1 - index; // Calculate index in original array
        row.innerHTML = `
          <td>${date.toLocaleString()}</td>
          <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${urlDisplay}">${urlDisplay}</td>
          <td style="color: ${isPhishing ? '#ff4757' : '#2ecc71'}; font-weight: bold;">${label}</td>
          <td>${confidenceDisplay}</td>
          <td>
            <img src="images/trash.png" class="delete-history-btn" data-index="${originalIndex}" width="20" style="cursor: pointer;" title="Delete Record">
          </td>
        `;
        tableBody.appendChild(row);
      });

      // Attach event listeners to delete buttons
      document.querySelectorAll('.delete-history-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(e.target.dataset.index);
          deleteHistoryRecord(idx);
        });
      });

      // Update Metrics
      document.getElementById('total-scanned').textContent = total;
      document.getElementById('phishing-detected').textContent = phishing;
      document.getElementById('legitimate-sites').textContent = legitimate;

      // Update Detection Rate
      const rateEl = document.getElementById('detection-rate');
      if (rateEl) {
        rateEl.textContent = total > 0 ? ((phishing / total) * 100).toFixed(1) + '%' : '0%';
      }

      // Update Comparison Metrics
      updateComparison('total-change', todayStats.total, yestStats.total, false);
      updateComparison('phishing-change', todayStats.phishing, yestStats.phishing, true); // True = Increase is Bad (Red)
      updateComparison('legit-change', todayStats.legit, yestStats.legit, false);
    }

    function updateComparison(elementId, today, yesterday, isBadIfIncrease) {
        const el = document.getElementById(elementId);
        if (!el) return;

        if (yesterday === 0) {
            if (today > 0) {
                el.innerHTML = '&#x2197; 100%'; // Up arrow
                el.style.color = isBadIfIncrease ? '#d9534f' : '#5cb85c'; // Red if bad, Green if good
            } else {
                el.innerHTML = '- 0%';
                el.style.color = '#666';
            }
            return;
        }

        const change = ((today - yesterday) / yesterday) * 100;
        const arrow = change >= 0 ? '&#x2197;' : '&#x2198;'; // Up (2197) or Down (2198)
        
        // Determine color
        // If isBadIfIncrease is true (Phishing): Increase (>0) -> Red, Decrease (<0) -> Green
        // If isBadIfIncrease is false (Legit/Total): Increase (>0) -> Green, Decrease (<0) -> Red
        const isGood = isBadIfIncrease ? (change <= 0) : (change >= 0);
        el.style.color = isGood ? '#5cb85c' : '#d9534f';
        el.innerHTML = `${arrow} ${Math.abs(change).toFixed(1)}% Compared to Yesterday`;
    }

    // --- Render Charts using Chart.js ---
    if (typeof Chart === 'undefined') return;

    // 1. Threat Trends Chart (Line Chart)
    const ctx = document.getElementById('threatChart');
    if (ctx) {
      if (threatChartInstance) threatChartInstance.destroy();

      // Process data: Group by Date
      const dateMap = new Map();
      const sortedHistory = [...history].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      sortedHistory.forEach(entry => {
        const date = new Date((entry.timestamp || Date.now()) * 1000).toLocaleDateString();
        if (!dateMap.has(date)) dateMap.set(date, { phishing: 0, legitimate: 0 });
        const stats = dateMap.get(date);

        if (entry.type === 'batch') {
          const p_count = (entry.phishing_links || []).length;
          const total = entry.total_scanned || 0;
          stats.phishing += p_count;
          stats.legitimate += (total - p_count);
        } else {
          const prediction = entry.prediction || '';
          if (typeof prediction === 'string' && prediction.includes('PHISHING')) stats.phishing++;
          else stats.legitimate++;
        }
      });

      const labels = Array.from(dateMap.keys());
      const pData = Array.from(dateMap.values()).map(v => v.phishing);
      const lData = Array.from(dateMap.values()).map(v => v.legitimate);

      threatChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Phishing',
              data: pData,
              borderColor: '#d9534f',
              backgroundColor: 'rgba(217, 83, 79, 0.2)',
              fill: true,
              tension: 0.3
            },
            {
              label: 'Legitimate',
              data: lData,
              borderColor: '#5cb85c',
              backgroundColor: 'rgba(92, 184, 92, 0.2)',
              fill: true,
              tension: 0.3
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          plugins: { title: { display: true, text: 'Threats Detected Over Time' } }
        }
      });
    }

    // 2. Percentage Chart (Doughnut)
    const ctxPercentage = document.getElementById('percentageChart');
    if (ctxPercentage) {
      if (percentageChartInstance) percentageChartInstance.destroy();
      const isDark = document.body.getAttribute('data-theme') === 'dark';

      const hasData = (phishing + legitimate) > 0;
      percentageChartInstance = new Chart(ctxPercentage, {
        type: 'doughnut',
        data: {
          labels: ['Phishing', 'Legitimate'],
          datasets: [{
            data: hasData ? [phishing, legitimate] : [1],
            backgroundColor: hasData ? ['#ff4757', '#2ecc71'] : [isDark ? '#252548' : '#e0e0e0'],
            borderWidth: 0,
            cutout: '65%'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: isDark ? '#a0a0b8' : '#666', padding: 16, usePointStyle: true } },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  const t = phishing + legitimate;
                  const pct = t > 0 ? ((ctx.raw / t) * 100).toFixed(1) : 0;
                  return ctx.label + ': ' + ctx.raw + ' (' + pct + '%)';
                }
              }
            }
          }
        }
      });
    }

    // 3. Risk Score Chart (Gauge)
    const riskCtx = document.getElementById('riskScoreChart');
    if (riskCtx && typeof Chart !== 'undefined') {
      if (riskScoreChartInstance) riskScoreChartInstance.destroy();
      const isDark = document.body.getAttribute('data-theme') === 'dark';

      const score = total > 0 ? Math.round((phishing / total) * 1000) : 0;
      const level = score <= 250 ? 'Low' : score <= 500 ? 'Medium' : score <= 750 ? 'High' : 'Critical';
      const gaugeColor = score <= 250 ? '#2ecc71' : score <= 500 ? '#f39c12' : score <= 750 ? '#ff6b35' : '#ff4757';

      const scoreEl = document.getElementById('risk-score-value');
      const levelEl = document.getElementById('risk-score-level');
      if (scoreEl) scoreEl.textContent = score;
      if (levelEl) {
        levelEl.textContent = level;
        levelEl.style.background = gaugeColor;
        levelEl.style.color = 'white';
      }

      riskScoreChartInstance = new Chart(riskCtx, {
        type: 'doughnut',
        data: {
          datasets: [{
            data: [score, 1000 - score],
            backgroundColor: [gaugeColor, isDark ? '#1a1a3e' : '#e8e8e8'],
            borderWidth: 0,
            cutout: '78%'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          rotation: -90,
          circumference: 180,
          plugins: { legend: { display: false }, tooltip: { enabled: false } }
        }
      });
    }
  }

  // --- Filter Logic ---
  const filterBtn = document.getElementById('filter-btn');
  const filterMenu = document.getElementById('filter-menu');
  const customRangeInputs = document.getElementById('custom-range-inputs');

  if (filterBtn && filterMenu) {
    filterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      filterMenu.style.display = filterMenu.style.display === 'block' ? 'none' : 'block';
    });

    document.addEventListener('click', (e) => {
      if (filterMenu.style.display === 'block' && !filterMenu.contains(e.target) && !filterBtn.contains(e.target)) {
        filterMenu.style.display = 'none';
      }
    });
  }

  document.querySelectorAll('.filter-option').forEach(option => {
    option.addEventListener('click', (e) => {
      const range = e.target.dataset.range;
      if (range === 'custom') {
        customRangeInputs.style.display = customRangeInputs.style.display === 'block' ? 'none' : 'block';
      } else {
        customRangeInputs.style.display = 'none';
        filterMenu.style.display = 'none';
        filterDashboardData(range);
      }
    });
  });

  const applyCustomBtn = document.getElementById('apply-custom-filter');
  const filterDateError = document.getElementById('filter-date-error');
  if (applyCustomBtn) {
    applyCustomBtn.addEventListener('click', () => {
      const start = document.getElementById('start-date').value;
      const end = document.getElementById('end-date').value;

      // Clear previous error
      if (filterDateError) { filterDateError.style.display = 'none'; filterDateError.textContent = ''; }

      if (!start || !end) {
        if (filterDateError) { filterDateError.textContent = 'Please select both start and end dates.'; filterDateError.style.display = 'block'; }
        return;
      }
      if (start > end) {
        if (filterDateError) { filterDateError.textContent = 'Start date cannot be after end date.'; filterDateError.style.display = 'block'; }
        return;
      }

      filterDashboardData('custom', { start, end });
      filterMenu.style.display = 'none';
    });
  }

  function filterDashboardData(range, customRange) {
    const now = Date.now();
    let filtered = fullScanHistory;
    let startTime = 0;

    if (range === '24h') startTime = now - (24 * 60 * 60 * 1000);
    else if (range === '3d') startTime = now - (3 * 24 * 60 * 60 * 1000);
    else if (range === '7d') startTime = now - (7 * 24 * 60 * 60 * 1000);
    else if (range === 'custom' && customRange) {
      const s = new Date(customRange.start).getTime();
      const e = new Date(customRange.end).getTime() + (24 * 60 * 60 * 1000); // End of selected day
      filtered = fullScanHistory.filter(entry => {
        const ts = (entry.timestamp || 0) * 1000;
        return ts >= s && ts < e;
      });
      updateDashboardUI(filtered);
      return;
    }

    if (startTime > 0) {
      filtered = fullScanHistory.filter(entry => (entry.timestamp || 0) * 1000 >= startTime);
    }
    updateDashboardUI(filtered);
  }

  // --- History Management Functions ---
  
  function deleteHistoryRecord(index) {
    chrome.storage.local.get(['scanHistory'], (result) => {
      const history = result.scanHistory || [];
      if (index >= 0 && index < history.length) {
        history.splice(index, 1); // Remove the item
        chrome.storage.local.set({ scanHistory: history }, () => {
          loadDashboardData(); // Refresh UI
        });
      }
    });
  }

  const clearHistoryBtn = document.getElementById('clear-history-btn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      if (confirm("Are you sure you want to clear all scan history? This cannot be undone.")) {
        chrome.storage.local.set({ scanHistory: [] }, loadDashboardData);
      }
    });
  }

  // --- Knowledge Base Management ---

  function setKbStatus(msg, color) {
    const el = document.getElementById('kb-status');
    if (el) { el.textContent = msg; el.style.color = color || '#555'; }
  }

  function renderKbTable(rows) {
    const tbody = document.getElementById('kb-tbody');
    if (!tbody) return;
    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:16px; color: var(--text-muted);">No entries found.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    rows.forEach((row, idx) => {
      const tr = document.createElement('tr');
      tr.style.backgroundColor = idx % 2 === 0 ? '#fff' : '#f9f9f9';
      tr.innerHTML = `
        <td style="padding:7px 10px; border-bottom:1px solid #eee; color:#777;">${idx + 1}</td>
        <td style="padding:7px 10px; border-bottom:1px solid #eee; vertical-align:top;">${row.question}</td>
        <td style="padding:7px 10px; border-bottom:1px solid #eee; vertical-align:top; white-space:pre-wrap;">${row.output}</td>
        <td style="padding:7px 10px; border-bottom:1px solid #eee; text-align:center;">
          <img src="images/trash.png" width="18" class="kb-delete-btn" data-index="${idx}"
            style="cursor:pointer; opacity:0.7;" title="Delete row">
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.kb-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index);
        if (!confirm(`Delete entry #${idx + 1}?`)) return;
        setKbStatus('Deleting...', '#555');
        try {
          const res = await backendFetch('/kb/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: idx }),
          });
          const data = await res.json();
          if (res.ok) {
            setKbStatus(`Deleted. ${data.total} entries remain. Vector DB updated.`, '#5cb85c');
            loadKbRows();
          } else {
            setKbStatus(`Error: ${data.error}`, '#d9534f');
          }
        } catch (e) {
          setKbStatus('Could not reach server.', '#d9534f');
        }
      });
    });
  }

  async function loadKbRows() {
    setKbStatus('Loading...', '#555');
    try {
      const res = await backendFetch('/kb/rows');
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      renderKbTable(data.rows);
      setKbStatus(`${data.total} entries loaded.`, '#555');
    } catch (e) {
      setKbStatus('Could not load knowledge base. Is the server running?', '#d9534f');
    }
  }

  // Add entry form
  const kbAddForm = document.getElementById('kb-add-form');
  if (kbAddForm) {
    kbAddForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const question = (document.getElementById('kb-question-input').value || '').trim();
      const output   = (document.getElementById('kb-output-input').value   || '').trim();
      if (!question || !output) {
        setKbStatus('Please fill in both Question and Answer.', '#d9534f');
        return;
      }
      setKbStatus('Adding entry...', '#555');
      try {
        const res = await backendFetch('/kb/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, output }),
        });
        const data = await res.json();
        if (res.ok) {
          setKbStatus(`Added! ${data.total} entries total. Vector DB updated.`, '#5cb85c');
          document.getElementById('kb-question-input').value = '';
          document.getElementById('kb-output-input').value   = '';
          loadKbRows();
        } else {
          setKbStatus(`Error: ${data.error}`, '#d9534f');
        }
      } catch (e) {
        setKbStatus('Could not reach server.', '#d9534f');
      }
    });
  }

  // Manual rebuild button
  const kbRebuildBtn = document.getElementById('kb-rebuild-btn');
  if (kbRebuildBtn) {
    kbRebuildBtn.addEventListener('click', async () => {
      kbRebuildBtn.disabled = true;
      setKbStatus('Rebuilding Vector DB...', '#2196F3');
      try {
        const res = await backendFetch('/kb/rebuild', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          setKbStatus(`Vector DB rebuilt with ${data.total} entries.`, '#5cb85c');
        } else {
          setKbStatus(`Error: ${data.error}`, '#d9534f');
        }
      } catch (e) {
        setKbStatus('Could not reach server.', '#d9534f');
      } finally {
        kbRebuildBtn.disabled = false;
      }
    });
  }

  // --- Batch Scan Results Table ---

  function renderBatchScanTable(scanData) {
    const tbody = document.getElementById('batch-scan-tbody');
    const meta  = document.getElementById('batch-scan-meta');
    if (!tbody) return;

    // Never scanned
    if (!scanData) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:16px; color: var(--text-muted);">No scan data yet. Scan a page to see results.</td></tr>';
      if (meta) meta.textContent = '';
      return;
    }

    const ts = scanData.timestamp ? new Date(scanData.timestamp * 1000).toLocaleString() : '';

    // Scanned but page had no outgoing HTTP links
    if (!scanData.results || scanData.results.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:16px; color: var(--text-muted);">No HTTP links found on this page.</td></tr>';
      if (meta) meta.textContent = `Last scanned: ${ts} - 0 URLs found`;
      return;
    }

    if (meta) meta.textContent = `Last scanned: ${ts} - ${scanData.results.length} URL(s) found`;

    tbody.innerHTML = '';
    scanData.results.forEach((item, idx) => {
      const isPhishing = item.label === 'PHISHING';
      const row = document.createElement('tr');
      row.style.backgroundColor = isPhishing ? 'rgba(217,83,79,0.12)' : 'rgba(92,184,92,0.10)';
      const explainBtn = isPhishing
        ? `<button class="explain-url-btn" data-url="${item.url}" data-confidence="${item.confidence}" style="background:#e91e63; color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:600;">Explain</button>`
        : '<span style="color:var(--text-muted); font-size:11px;">-</span>';
      row.innerHTML = `
        <td style="padding:7px 10px; border-bottom:1px solid #ddd; color: var(--text-secondary);">${idx + 1}</td>
        <td style="padding:7px 10px; border-bottom:1px solid #ddd; max-width:300px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${item.url}">${item.url}</span>
            <img src="images/copy.png" width="14" height="14" class="copy-url-btn" data-url="${item.url}"
              style="cursor:pointer; flex-shrink:0; opacity:0.6;" title="Copy URL">
          </div>
        </td>
        <td style="padding:7px 10px; border-bottom:1px solid #ddd; text-align:center; font-weight:bold; color:${isPhishing ? '#d9534f' : '#038303'};">${item.label}</td>
        <td style="padding:7px 10px; border-bottom:1px solid #ddd; text-align:center;">${item.confidence !== null ? item.confidence + '%' : '-'}</td>
        <td style="padding:7px 10px; border-bottom:1px solid #ddd; text-align:center;">${explainBtn}</td>
      `;
      tbody.appendChild(row);
    });

    // Attach copy handlers
    tbody.querySelectorAll('.copy-url-btn').forEach(img => {
      img.addEventListener('click', () => {
        navigator.clipboard.writeText(img.dataset.url).then(() => {
          const orig = img.src;
          img.style.opacity = '1';
          setTimeout(() => { img.style.opacity = '0.6'; }, 1000);
        });
      });
    });

    // Attach Explain handlers
    tbody.querySelectorAll('.explain-url-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        explainPhishingUrl(btn.dataset.url, btn.dataset.confidence);
      });
    });
  }

  function loadBatchScanResults() {
    chrome.storage.local.get(['latestBatchScan'], (data) => {
      renderBatchScanTable(data.latestBatchScan || null);
    });
  }

  // "Refresh" button — manually reloads latestBatchScan from storage
  const refreshScanBtn = document.getElementById('refresh-scan-btn');
  if (refreshScanBtn) {
    refreshScanBtn.addEventListener('click', loadBatchScanResults);
  }

  // "Scan Page URLs" button — batch-scans all links on the page via /scan_page
  const batchScanPageBtn = document.getElementById('batch-scan-page-btn');
  if (batchScanPageBtn) {
    batchScanPageBtn.addEventListener('click', () => {
      batchScanPageBtn.disabled = true;
      batchScanPageBtn.textContent = 'Scanning...';
      const meta = document.getElementById('batch-scan-meta');
      if (meta) meta.textContent = 'Fetching and analysing all page links...';

      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs.length || !tabs[0].url) {
          batchScanPageBtn.disabled = false;
          batchScanPageBtn.textContent = 'Scan Page URLs';
          return;
        }

        const pageUrl = tabs[0].url;
        const model   = modelSelect ? modelSelect.value : 'distilbert';

        try {
          const res = await backendFetch('/scan_page', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ url: pageUrl, model }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server error ${res.status}`);
          }

          const data = await res.json();
          const scanData = { results: data.results, timestamp: data.timestamp };

          chrome.storage.local.set({ latestBatchScan: scanData });
          renderBatchScanTable(scanData);
        } catch (e) {
          if (meta) meta.textContent = `Error: ${e.message}`;
        } finally {
          batchScanPageBtn.disabled = false;
          batchScanPageBtn.textContent = 'Scan Page URLs';
        }
      });
    });
  }

  // "Scan Current URL" button — scans only the current page URL via /predict
  const scanPageBtn = document.getElementById('scan-page-btn');
  if (scanPageBtn) {
    scanPageBtn.addEventListener('click', () => {
      scanPageBtn.disabled = true;
      scanPageBtn.textContent = 'Scanning...';
      const meta = document.getElementById('batch-scan-meta');
      if (meta) meta.textContent = 'Analysing current page URL...';

      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs.length || !tabs[0].url) {
          scanPageBtn.disabled = false;
          scanPageBtn.textContent = 'Scan Current URL';
          return;
        }

        const pageUrl = tabs[0].url;
        const model   = modelSelect ? modelSelect.value : 'distilbert';

        try {
          const res = await backendFetch('/predict', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ url: pageUrl, model }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server error ${res.status}`);
          }

          const data = await res.json();
          // data = { url, prediction: "PHISHING / MALICIOUS" | "LEGITIMATE / SAFE", confidence: "92.35%", model }
          const confNum = parseFloat(data.confidence) || 0;
          const label = data.prediction.includes('PHISHING') ? 'PHISHING' : 'LEGITIMATE';
          const scanData = {
            results: [{
              url: data.url,
              label: label,
              confidence: confNum.toFixed(2),
            }],
            timestamp: Date.now() / 1000,
          };

          chrome.storage.local.set({ latestBatchScan: scanData });
          renderBatchScanTable(scanData);
        } catch (e) {
          if (meta) meta.textContent = `Error: ${e.message}`;
        } finally {
          scanPageBtn.disabled = false;
          scanPageBtn.textContent = 'Scan Current URL';
        }
      });
    });
  }

  // Live-update the table when background.js writes latestBatchScan
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.latestBatchScan) {
      renderBatchScanTable(changes.latestBatchScan.newValue);
    }
    if (namespace === 'local' && changes.analysisResult) {
      chrome.storage.local.get(['protectionEnabled', 'warningEnabled', 'urlScanningEnabled'], (data) => {
        if (data.protectionEnabled || data.warningEnabled || data.urlScanningEnabled) {
          updateUI(changes.analysisResult.newValue);
        }
      });
    }
  });

  // Pre-load batch scan data so it's ready when user switches to Analyse URL tab
  loadBatchScanResults();

  // --- Security Report & URL Explanation (Claude API) ---

  async function getClaudeApiKey() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['claudeApiKey'], (data) => resolve(data.claudeApiKey || ''));
    });
  }

  async function callClaudeForReport(systemPrompt, userMessage) {
    const apiKey = await getClaudeApiKey();
    if (!apiKey) throw new Error('No Claude API key set. Go to Website Auditing → select Claude → enter your API key.');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API error ${response.status}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || 'No response from Claude.';
  }

  // --- Explain Phishing URL ---
  async function explainPhishingUrl(url, confidence) {
    const panel = document.getElementById('url-explain-panel');
    const content = document.getElementById('url-explain-content');
    if (!panel || !content) return;

    panel.style.display = 'block';
    content.textContent = 'Analyzing URL... Please wait.';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const systemPrompt =
      'You are a cybersecurity analyst specializing in phishing URL detection. ' +
      'When given a URL flagged as phishing, provide a structured analysis explaining WHY it is suspicious. ' +
      'Break down the URL components (domain, path, query params, TLD) and identify red flags such as: ' +
      'typosquatting, suspicious subdomains, unusual TLDs, encoded characters, IP-based URLs, ' +
      'excessive path depth, brand impersonation, misleading keywords, and known phishing patterns. ' +
      'Be specific and educational. Format with clear sections.';

    const userMessage =
      `Analyze this URL that was flagged as PHISHING with ${confidence}% confidence:\n\n` +
      `URL: ${url}\n\n` +
      'Provide:\n' +
      '1. **URL Breakdown** — dissect each component\n' +
      '2. **Red Flags** — specific suspicious indicators found\n' +
      '3. **Risk Assessment** — why this URL is dangerous\n' +
      '4. **Recommendation** — what the user should do';

    try {
      const result = await callClaudeForReport(systemPrompt, userMessage);
      content.textContent = result;
    } catch (e) {
      content.textContent = `Error: ${e.message}`;
    }
  }

  document.getElementById('close-explain-btn')?.addEventListener('click', () => {
    document.getElementById('url-explain-panel').style.display = 'none';
  });

  // --- Generate Security Report ---
  async function generateSecurityReport() {
    const panel = document.getElementById('security-report-panel');
    const content = document.getElementById('security-report-content');
    if (!panel || !content) return;

    panel.style.display = 'block';
    content.textContent = 'Generating security report... This may take a moment.';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Collect scan data from storage
    const storageData = await new Promise((resolve) => {
      chrome.storage.local.get(['latestBatchScan', 'scanHistory', 'analysisResult'], resolve);
    });

    const batchScan = storageData.latestBatchScan;
    const scanHistory = storageData.scanHistory || [];
    const currentAnalysis = storageData.analysisResult;

    // Build scan summary
    let scanSummary = '';

    // Current single-URL analysis
    if (currentAnalysis) {
      scanSummary += `## Current URL Analysis\n`;
      scanSummary += `Status: ${currentAnalysis.status || 'N/A'}\n`;
      scanSummary += `Confidence: ${currentAnalysis.confidence || 'N/A'}\n\n`;
    }

    // Latest batch scan results
    if (batchScan && batchScan.results && batchScan.results.length > 0) {
      const phishingUrls = batchScan.results.filter(r => r.label === 'PHISHING');
      const legitimateUrls = batchScan.results.filter(r => r.label !== 'PHISHING');

      scanSummary += `## Latest Batch Scan (${new Date(batchScan.timestamp * 1000).toLocaleString()})\n`;
      scanSummary += `Total URLs scanned: ${batchScan.results.length}\n`;
      scanSummary += `Phishing detected: ${phishingUrls.length}\n`;
      scanSummary += `Legitimate: ${legitimateUrls.length}\n\n`;

      if (phishingUrls.length > 0) {
        scanSummary += `### Phishing URLs Found:\n`;
        phishingUrls.forEach((u, i) => {
          scanSummary += `${i + 1}. ${u.url} (confidence: ${u.confidence}%)\n`;
        });
        scanSummary += '\n';
      }

      if (legitimateUrls.length > 0) {
        scanSummary += `### Legitimate URLs:\n`;
        legitimateUrls.slice(0, 10).forEach((u, i) => {
          scanSummary += `${i + 1}. ${u.url} (confidence: ${u.confidence}%)\n`;
        });
        if (legitimateUrls.length > 10) scanSummary += `... and ${legitimateUrls.length - 10} more\n`;
        scanSummary += '\n';
      }
    }

    // Historical stats
    if (scanHistory.length > 0) {
      let totalScanned = 0, totalPhishing = 0;
      scanHistory.forEach(entry => {
        if (entry.type === 'batch') {
          totalScanned += entry.total_scanned || 0;
          totalPhishing += (entry.phishing_links || []).length;
        } else {
          totalScanned += 1;
          if ((entry.prediction || '').includes('PHISHING')) totalPhishing += 1;
        }
      });
      scanSummary += `## Historical Summary (${scanHistory.length} scan sessions)\n`;
      scanSummary += `Total URLs scanned: ${totalScanned}\n`;
      scanSummary += `Total phishing detected: ${totalPhishing}\n`;
      scanSummary += `Risk score: ${totalScanned > 0 ? Math.round((totalPhishing / totalScanned) * 1000) : 0} / 1000\n\n`;
    }

    // Optionally attach page HTML
    const includeHtml = document.getElementById('report-include-html')?.checked;
    let pageHtml = '';
    if (includeHtml) {
      try {
        const html = await getPageHtml();
        if (html) {
          pageHtml = '\n## Current Page HTML\n```html\n' + truncateHtml(html, 10000) + '\n```\n';
        }
      } catch (e) {
        pageHtml = '\n(Could not extract page HTML)\n';
      }
    }

    if (!scanSummary && !pageHtml) {
      content.textContent = 'No scan data available. Run a scan first, then generate a report.';
      return;
    }

    const systemPrompt =
      'You are a cybersecurity analyst generating a structured security report for a website. ' +
      'Based on the scan data provided (and optionally the page HTML), produce a professional report with:\n\n' +
      '1. **Executive Summary** — one paragraph overview of the security posture\n' +
      '2. **Threat Assessment** — categorize threats found (Critical/High/Medium/Low)\n' +
      '3. **Phishing URL Analysis** — for each phishing URL found, explain what makes it suspicious\n' +
      '4. **Page Content Analysis** — if HTML is provided, identify suspicious elements (hidden iframes, obfuscated scripts, fake login forms, external resource loading from unusual domains)\n' +
      '5. **Cookie & Privacy Concerns** — if relevant data is available\n' +
      '6. **Recommendations** — actionable steps to protect against the threats found\n' +
      '7. **Risk Rating** — overall risk level with justification\n\n' +
      'Be specific, reference actual URLs and patterns from the data. Use clear formatting.';

    const userMessage = `Generate a security report based on the following scan data:\n\n${scanSummary}${pageHtml}`;

    try {
      const result = await callClaudeForReport(systemPrompt, userMessage);
      content.textContent = result;
    } catch (e) {
      content.textContent = `Error: ${e.message}`;
    }
  }

  document.getElementById('generate-report-btn')?.addEventListener('click', generateSecurityReport);
  document.getElementById('close-report-btn')?.addEventListener('click', () => {
    document.getElementById('security-report-panel').style.display = 'none';
  });

  // --- Report Form & Federated Learning ---

  const reportForm        = document.getElementById('report-form');
  const reportStatus      = document.getElementById('report-status');
  const reportModelSelect = document.getElementById('report-model-select');
  const flReportCount     = document.getElementById('fl-report-count');
  const flTrainBtn        = document.getElementById('fl-train-btn');
  const flStatusDisplay   = document.getElementById('fl-status-display');

  let _flPolling = null; // setInterval handle for status polling

  async function fetchReportCount(modelName) {
    try {
      const res = await backendFetch(`/report_count?model=${modelName}`);
      if (res.ok) {
        const data = await res.json();
        if (flReportCount) flReportCount.textContent = data.count;
      }
    } catch (e) {
      console.error('Could not fetch report count:', e);
    }
  }

  async function fetchFlStatus() {
    try {
      const res = await backendFetch('/fl_status');
      if (!res.ok) return;
      const data = await res.json();
      if (flStatusDisplay) {
        flStatusDisplay.textContent = data.message || '';
        flStatusDisplay.style.color = data.state === 'running' ? '#2196F3' : '#555';
      }
      if (flTrainBtn) flTrainBtn.disabled = data.state === 'running';

      // Stop polling once training is idle
      if (data.state !== 'running' && _flPolling) {
        clearInterval(_flPolling);
        _flPolling = null;
        // Refresh count after training completes
        if (reportModelSelect) fetchReportCount(reportModelSelect.value);
      }
    } catch (e) {
      console.error('Could not fetch FL status:', e);
    }
  }

  // Keep count in sync when the model selector changes
  if (reportModelSelect) {
    reportModelSelect.addEventListener('change', () => {
      fetchReportCount(reportModelSelect.value);
    });
  }

  // Handle report form submission
  if (reportForm) {
    reportForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const urlInput  = document.getElementById('report-url-input');
      const typeInput = document.getElementById('report-website-type');
      const url       = urlInput ? urlInput.value.trim() : '';
      const model     = reportModelSelect ? reportModelSelect.value : 'distilbert';
      const label     = typeInput ? parseInt(typeInput.value) : 0;

      if (!url) {
        if (reportStatus) { reportStatus.textContent = 'Please enter a URL.'; reportStatus.style.color = '#d9534f'; }
        return;
      }

      if (reportStatus) { reportStatus.textContent = 'Submitting...'; reportStatus.style.color = '#555'; }

      try {
        const res = await backendFetch('/report', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ url, model, label }),
        });

        if (res.ok) {
          const data = await res.json();
          if (reportStatus) {
            reportStatus.textContent = `Report saved! Reports for ${model}: ${data.model_reports}`;
            reportStatus.style.color = '#5cb85c';
          }
          if (flReportCount) flReportCount.textContent = data.model_reports;
          if (urlInput) urlInput.value = '';
        } else {
          const err = await res.json();
          if (reportStatus) { reportStatus.textContent = `Error: ${err.error || 'Unknown error'}`; reportStatus.style.color = '#d9534f'; }
        }
      } catch (e) {
        if (reportStatus) { reportStatus.textContent = 'Could not reach server. Is it running?'; reportStatus.style.color = '#d9534f'; }
      }
    });
  }

  // Show/hide GCP fields based on mode radio
  const flModeLocal      = document.getElementById('fl-mode-local');
  const flModeGcp        = document.getElementById('fl-mode-gcp');
  const gcpUrlSection    = document.getElementById('gcp-url-section');
  const gcpUrlInput      = document.getElementById('gcp-url-input');
  const gcpApiKeyInput   = document.getElementById('gcp-api-key-input');

  function updateModeSection() {
    const isGcp = flModeGcp && flModeGcp.checked;
    if (gcpUrlSection) gcpUrlSection.style.display = isGcp ? 'block' : 'none';
  }
  if (flModeLocal) flModeLocal.addEventListener('change', updateModeSection);
  if (flModeGcp)   flModeGcp.addEventListener('change',   updateModeSection);

  // Persist GCP URL in storage
  if (gcpUrlInput) {
    chrome.storage.local.get(['gcpServerUrl'], (d) => { if (d.gcpServerUrl) gcpUrlInput.value = d.gcpServerUrl; });
    gcpUrlInput.addEventListener('change', () =>
      chrome.storage.local.set({ gcpServerUrl: gcpUrlInput.value.trim() })
    );
  }

  // Handle "Train Model Now" button
  if (flTrainBtn) {
    flTrainBtn.addEventListener('click', async () => {
      const model  = reportModelSelect ? reportModelSelect.value : 'distilbert';
      const mode   = flModeGcp && flModeGcp.checked ? 'gcp' : 'local';
      const gcpUrl = gcpUrlInput ? gcpUrlInput.value.trim() : '';
      const apiKey = gcpApiKeyInput ? gcpApiKeyInput.value.trim() : '';

      if (mode === 'gcp' && !gcpUrl) {
        if (flStatusDisplay) { flStatusDisplay.textContent = 'Please enter the GCP Server URL.'; flStatusDisplay.style.color = '#d9534f'; }
        return;
      }

      flTrainBtn.disabled = true;
      if (flStatusDisplay) {
        flStatusDisplay.textContent = mode === 'gcp'
          ? `Connecting to GCP server...`
          : 'Starting local training...';
        flStatusDisplay.style.color = '#2196F3';
      }

      try {
        const body = { model, rounds: 3, mode };
        if (mode === 'gcp') { body.gcp_url = gcpUrl; body.api_key = apiKey; }

        const res = await backendFetch('/fl_train', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });

        const data = await res.json();
        if (res.ok) {
          if (flStatusDisplay) {
            flStatusDisplay.textContent = mode === 'gcp'
              ? `GCP FL started — uploading adapter, waiting for aggregation...`
              : `Local training started (${data.rounds} rounds)...`;
            flStatusDisplay.style.color = '#2196F3';
          }
          if (_flPolling) clearInterval(_flPolling);
          _flPolling = setInterval(fetchFlStatus, 3000);
        } else {
          flTrainBtn.disabled = false;
          if (flStatusDisplay) { flStatusDisplay.textContent = data.message || data.error || 'Error starting training.'; flStatusDisplay.style.color = '#d9534f'; }
        }
      } catch (e) {
        flTrainBtn.disabled = false;
        if (flStatusDisplay) { flStatusDisplay.textContent = 'Could not reach local server.'; flStatusDisplay.style.color = '#d9534f'; }
      }
    });
  }
});


// --- Chatbot Functionality ---

// Store chat history
let chatHistory = [];

const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendMessageBtn = document.getElementById('sendMessage');
const clearChatBtn = document.getElementById('clearChat');
const chatModelSelect = document.getElementById('chat-model-select');
const claudeKeyRow = document.getElementById('claude-key-row');
const claudeApiKeyInput = document.getElementById('claude-api-key-input');
const claudeKeySaveBtn = document.getElementById('claude-key-save-btn');
const claudeKeyStatus = document.getElementById('claude-key-status');

const CLAUDE_SYSTEM_PROMPT_GENERAL =
  'You are a cybersecurity expert assistant embedded in a Chrome extension. ' +
  'Help the user audit websites for phishing, malicious content, suspicious cookies, ' +
  'unsafe scripts, and security best practices. Be concise and practical.';

const CLAUDE_SYSTEM_PROMPT_STRICT =
  'You are a cybersecurity website-auditing assistant embedded in a Chrome extension. ' +
  'You ONLY answer questions directly related to website auditing, including: ' +
  'phishing detection, malicious URL analysis, cookie security, SSL/TLS inspection, ' +
  'Content Security Policy (CSP), HTTP header analysis, XSS/CSRF/SQL injection risks, ' +
  'suspicious scripts/iframes, domain reputation, WHOIS lookups, and security best practices for websites.\n\n' +
  'If the user asks about anything NOT related to website auditing or web security, ' +
  'politely decline and remind them that you are specialised for website auditing only. ' +
  'For example: "I\'m specialised in website auditing and web security. Could you rephrase your question in that context?"\n\n' +
  'Be concise, practical, and always ground your answers in security evidence.';

const auditOnlyToggle = document.getElementById('audit-only-toggle');

// Persist toggle state
chrome.storage.local.get(['auditOnlyMode'], (data) => {
  const enabled = data.auditOnlyMode !== false;  // default ON
  auditOnlyToggle.checked = enabled;
});
auditOnlyToggle.addEventListener('change', () => {
  chrome.storage.local.set({ auditOnlyMode: auditOnlyToggle.checked });
});

function getActiveSystemPrompt() {
  return auditOnlyToggle.checked ? CLAUDE_SYSTEM_PROMPT_STRICT : CLAUDE_SYSTEM_PROMPT_GENERAL;
}

// ---- Chat persistence helpers ----
function chatStorageKey() {
  return 'chatHistory_' + chatModelSelect.value;
}

function saveChatHistory() {
  chrome.storage.local.set({ [chatStorageKey()]: chatHistory });
}

function loadChatFromStorage() {
  chatLog.innerHTML = '';
  chrome.storage.local.get([chatStorageKey()], (data) => {
    chatHistory = data[chatStorageKey()] || [];
    chatHistory.forEach((msg) => {
      addMessageToLog(msg.role === 'user' ? 'user' : 'bot', msg.content);
    });
  });
}

// Load persisted model selection and API key
chrome.storage.local.get(['chatModel', 'claudeApiKey'], (data) => {
  const model = data.chatModel || 'starcoder2';
  chatModelSelect.value = model;
  applyChatModelUI(model);
  if (data.claudeApiKey) {
    claudeApiKeyInput.value = data.claudeApiKey;
    claudeKeyStatus.textContent = 'Key saved.';
  }
  // Load chat history for the active model
  loadChatFromStorage();
});

function applyChatModelUI(model) {
  if (model === 'claude') {
    claudeKeyRow.style.display = 'flex';
    chatInput.placeholder = '     Ask Claude...';
  } else {
    claudeKeyRow.style.display = 'none';
    chatInput.placeholder = '     Ask StarCoder2...';
  }
}

chatModelSelect.addEventListener('change', () => {
  const model = chatModelSelect.value;
  chrome.storage.local.set({ chatModel: model });
  applyChatModelUI(model);
  loadChatFromStorage();   // load that model's saved history
});

claudeKeySaveBtn.addEventListener('click', () => {
  const key = claudeApiKeyInput.value.trim();
  if (!key) { claudeKeyStatus.textContent = 'Enter a key first.'; return; }
  chrome.storage.local.set({ claudeApiKey: key }, () => {
    claudeKeyStatus.textContent = 'Saved!';
    setTimeout(() => { claudeKeyStatus.textContent = 'Key saved.'; }, 2000);
  });
});

const claudeKeyClearBtn = document.getElementById('claude-key-clear-btn');
claudeKeyClearBtn.addEventListener('click', () => {
  chrome.storage.local.remove('claudeApiKey', () => {
    claudeApiKeyInput.value = '';
    claudeKeyStatus.textContent = 'Key cleared.';
    setTimeout(() => { claudeKeyStatus.textContent = ''; }, 2000);
  });
});

// Add a message bubble to the chat log
function addMessageToLog(role, content) {
  const messageWrapper = document.createElement('div');
  messageWrapper.classList.add(role === 'user' ? 'user-message' : 'bot-message');
  const messageContent = document.createElement('div');
  messageContent.classList.add('message-content');
  messageContent.textContent = content;
  messageWrapper.appendChild(messageContent);
  chatLog.appendChild(messageWrapper);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// StarCoder2 via local Flask
async function sendToStarcoder(userInput) {
  const response = await backendFetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: userInput, history: chatHistory, audit_only: auditOnlyToggle.checked }),
  });
  if (!response.ok) throw new Error(`Server error ${response.status}`);
  const data = await response.json();
  return data.answer || 'Sorry, I encountered an error.';
}

// Claude via Anthropic API (direct browser call)
async function sendToClaude(userInput) {
  const apiKey = claudeApiKeyInput.value.trim();
  if (!apiKey) throw new Error('No Claude API key set. Enter your key and click Save.');

  // Build messages array (Claude format — same as chatHistory)
  const messages = [
    ...chatHistory,
    { role: 'user', content: userInput },
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: getActiveSystemPrompt(),
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || 'No response from Claude.';
}

// --- Helper: extract current tab's HTML via chrome.scripting ---
const attachHtmlCb = document.getElementById('attach-html-cb');

async function getPageHtml() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

function truncateHtml(html, maxChars = 12000) {
  if (html.length <= maxChars) return html;
  return html.slice(0, maxChars) + '\n... [HTML truncated]';
}

// Main send handler
async function handleSendMessage() {
  const userInput = chatInput.value.trim();
  if (!userInput) return;

  addMessageToLog('user', userInput);
  chatInput.value = '';

  const model = chatModelSelect.value;
  const thinkingEl = document.createElement('div');
  thinkingEl.classList.add('bot-message');
  thinkingEl.innerHTML = '<div class="message-content" style="color: var(--text-muted); font-style:italic;">Thinking...</div>';
  chatLog.appendChild(thinkingEl);
  chatLog.scrollTop = chatLog.scrollHeight;

  try {
    // Optionally attach page HTML
    let queryForModel = userInput;
    if (attachHtmlCb.checked) {
      const html = await getPageHtml();
      if (html) {
        queryForModel = userInput +
          '\n\n--- CURRENT PAGE HTML (for auditing) ---\n' +
          truncateHtml(html) +
          '\n--- END HTML ---';
      }
    }

    const botResponse = model === 'claude'
      ? await sendToClaude(queryForModel)
      : await sendToStarcoder(queryForModel);

    chatLog.removeChild(thinkingEl);
    addMessageToLog('bot', botResponse);
    // Store the original user input (not the huge HTML) in history
    chatHistory.push({ role: 'user', content: userInput });
    chatHistory.push({ role: 'assistant', content: botResponse });
    saveChatHistory();
  } catch (error) {
    chatLog.removeChild(thinkingEl);
    addMessageToLog('bot', `Error: ${error.message}`);
  }
}

function handleClearChat() {
  chatLog.innerHTML = '';
  chatHistory = [];
  saveChatHistory();   // remove from storage
}

sendMessageBtn.addEventListener('click', handleSendMessage);
clearChatBtn.addEventListener('click', handleClearChat);
chatInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleSendMessage();
  }
});
