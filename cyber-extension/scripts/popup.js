document.addEventListener('DOMContentLoaded', () => {
  const toggleMain = document.getElementById('protectionToggle');
  const toggleURL = document.getElementById('protectionToggleURL');
  const statusDiv = document.getElementById('status');
  const confidenceDiv = document.getElementById('confidence');
  const hamburgerIcon = document.getElementById('hamburger-icon');
  const sidebar = document.getElementById('sidebar');
  const contentSections = document.querySelectorAll('.content-section');

  let sidebarOpen = false;

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
  document.getElementById('analyse-url-link').addEventListener('click', () => showContent('analyse-url-content'));
  document.getElementById('website-auditing-link').addEventListener('click', () => showContent('website-auditing-content'));
  document.getElementById('malicious-content-analyser-link').addEventListener('click', () => showContent('malicious-content-analyser-content'));
  document.getElementById('report-phishing-link').addEventListener('click', () => showContent('report-phishing-content'));
  document.getElementById('cookies-analyzer-link').addEventListener('click', () => {
    showContent('cookie-content');
    displayCookies();
  });


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

  // Initialize the popup's UI based on stored state
  chrome.storage.local.get(['protectionEnabled', 'analysisResult'], (data) => {
    if (toggleMain) toggleMain.checked = !!data.protectionEnabled;
    if (toggleURL) toggleURL.checked = !!data.protectionEnabled;
    statusDiv.textContent = data.protectionEnabled ? 'Phishing Content Removal is ON' : 'Phishing Content Removal is OFF';
    if (data.protectionEnabled) {
      updateUI(data.analysisResult);
      if (!data.analysisResult) {
        confidenceDiv.innerHTML = '<i>Waiting for analysis...</i>';
      }
    }
  });

  // Listen for changes in storage
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.analysisResult) {
      // Update UI only if protection is still enabled
      chrome.storage.local.get('protectionEnabled', (data) => {
        if (data.protectionEnabled) {
          updateUI(changes.analysisResult.newValue);
        }
      });
    }
  });

  // Handle toggle switch changes
  const handleToggleChange = (event) => {
    const isEnabled = event.target.checked;
    if (toggleMain) toggleMain.checked = isEnabled;
    if (toggleURL) toggleURL.checked = isEnabled;

    chrome.storage.local.set({ protectionEnabled: isEnabled }, () => {
      statusDiv.textContent = isEnabled ? 'Phishing Content Removal is ON' : 'Phishing Content Removal is OFF';
      console.log(`Protection state set to ${isEnabled}`);

      if (isEnabled) {
        confidenceDiv.innerHTML = '<i>Starting analysis...</i>';
        // If protection is turned on, immediately analyze the current tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0) {
            chrome.runtime.sendMessage({ action: "analyzeTab", tabId: tabs[0].id });
          }
        });
      } else {
        // If turned off, clear the analysis result and any badge text
        updateUI(null);
        chrome.storage.local.remove('analysisResult');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length > 0) {
            chrome.action.setBadgeText({ text: '', tabId: tabs[0].id });
          }
        });
      }
    });
  };

  if (toggleMain) toggleMain.addEventListener('change', handleToggleChange);
  if (toggleURL) toggleURL.addEventListener('change', handleToggleChange);

  async function displayCookies() {
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
          console.log('Fetching cookies for domain:', domain);

          // 1. Fetch descriptions from our backend
          let descriptions = {};
          try {
            const response = await fetch('http://127.0.0.1:5000/analyze-cookies', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ domain: domain })
            });
            if (response.ok) {
              const data = await response.json();
              // Create a map of cookie names to descriptions
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
            const table = document.createElement('table');
            table.classList.add('cookie-table');
            table.innerHTML = `
              <tr>
                <th>Name</th>
                <th>Value</th>
                <th>Domain</th>
                <th>Description</th>
                <th>Expires</th>
                <th>Action</th>
              </tr>
            `;
            cookies.forEach((cookie) => {
              const row = document.createElement('tr');
              const description = descriptions[cookie.name] || ''; // Get description or default to empty

              row.innerHTML = `
                <td>${cookie.name}</td>
                <td class="cookie-value-container">
                  <span class="masked-value">********</span>
                  <span class="real-value" style="display:none;">${cookie.value}</span>
                  <img src="images/view.png" class="toggle-visibility" width="20" height="20" style="cursor:pointer; vertical-align: middle; margin-left: 5px;">
                </td>
                <td>${cookie.domain}</td>
                <td>${description}</td>
                <td>${new Date(cookie.expirationDate * 1000).toLocaleString()}</td>
                <td><input type="image" height="30px" width="30px" src="./images/trash.png" class="delete-cookie-btn" data-cookie-name="${cookie.name}" data-cookie-url="https://${cookie.domain}${cookie.path}"></td>
              `;
              table.appendChild(row);
            });
            cookieList.appendChild(table);

            document.querySelectorAll('.toggle-visibility').forEach((img) => {
              img.addEventListener('click', (event) => {
                const container = event.target.closest('.cookie-value-container');
                const masked = container.querySelector('.masked-value');
                const real = container.querySelector('.real-value');
                const icon = event.target;

                if (real.style.display === 'none') {
                  // Show value
                  real.style.display = 'inline';
                  masked.style.display = 'none';
                  icon.src = 'images/hide.png';
                } else {
                  // Hide value
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
                  displayCookies();
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
      tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 15px;">No activity recorded yet. Browse websites to generate data.</td></tr>';
      document.getElementById('total-scanned').textContent = 0;
      document.getElementById('phishing-detected').textContent = 0;
      document.getElementById('legitimate-sites').textContent = 0;
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
          
          urlDisplay = `Batch Scan (${count} URLs)`;
          label = `${p_count} Phishing Found`;
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
          <td style="padding: 8px; border-bottom: 1px solid #000000;">${date.toLocaleString()}</td>
          <td style="padding: 8px; border-bottom: 1px solid #000000; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${urlDisplay}">${urlDisplay}</td>
          <td style="padding: 8px; border-bottom: 1px solid #000000; color: ${isPhishing ? '#d9534f' : '#5cb85c'}; font-weight: bold;">${label}</td>
          <td style="padding: 8px; border-bottom: 1px solid #000000;">${confidenceDisplay}</td>
          <td style="padding: 8px; border-bottom: 1px solid #000000; text-align: center;">
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
        el.innerHTML = `${arrow} ${Math.abs(change).toFixed(1)}%`;
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

      const hasData = (phishing + legitimate) > 0;
      percentageChartInstance = new Chart(ctxPercentage, {
        type: 'doughnut',
        data: {
          labels: ['Phishing', 'Legitimate'],
          datasets: [{
            data: hasData ? [phishing, legitimate] : [0, 0],
            backgroundColor: hasData ? ['#d9534f', '#5cb85c'] : ['#e0e0e0', '#e0e0e0'],
            borderWidth: 1,
            cutout: '60%'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          circumference: 180,
          rotation: -90,
          plugins: { legend: { position: 'bottom' } }
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
      if (filterMenu.style.display === 'block' && !filterMenu.contains(e.target) && e.target !== filterBtn) {
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
  if (applyCustomBtn) {
    applyCustomBtn.addEventListener('click', () => {
      const start = document.getElementById('start-date').value;
      const end = document.getElementById('end-date').value;
      if (start && end) {
        filterDashboardData('custom', { start, end });
        filterMenu.style.display = 'none';
      }
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

  // Load dashboard data initially if dashboard is the default view
  loadDashboardData();
});


// --- Chatbot Functionality ---

// Store chat history
let chatHistory = [];

const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendMessageBtn = document.getElementById('sendMessage');
const clearChatBtn = document.getElementById('clearChat');

// Function to add a message to the chat log UI
function addMessageToLog(role, content) {
  const messageWrapper = document.createElement('div');
  messageWrapper.classList.add(role === 'user' ? 'user-message' : 'bot-message');

  const messageContent = document.createElement('div');
  messageContent.classList.add('message-content');
  messageContent.textContent = content;

  messageWrapper.appendChild(messageContent);
  chatLog.appendChild(messageWrapper);
  chatLog.scrollTop = chatLog.scrollHeight; // Auto-scroll to the latest message
}

// Function to handle sending a message
async function handleSendMessage() {
  const userInput = chatInput.value.trim();
  if (!userInput) return;

  // 1. Display user's message immediately
  addMessageToLog('user', userInput);
  chatInput.value = ''; // Clear input field

  // 2. Send message to backend and get response
  try {
    const response = await fetch('http://127.0.0.1:5000/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      // Send the user's query and the current chat history
      body: JSON.stringify({ 
        query: userInput,
        history: chatHistory 
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const botResponse = data.answer || 'Sorry, I encountered an error.';

    // 3. Display bot's response
    addMessageToLog('bot', botResponse);

    // 4. Update chat history for the next request
    chatHistory.push({ role: 'user', content: userInput });
    chatHistory.push({ role: 'assistant', content: botResponse });

  } catch (error) {
    console.error('Error:', error);
    addMessageToLog('bot', 'Could not get a response. Is the server running?');
  }
}

// Function to clear the chat
function handleClearChat() {
  chatLog.innerHTML = '';
  chatHistory = [];
  console.log('Chat history cleared.');
}

// Event Listeners
sendMessageBtn.addEventListener('click', handleSendMessage);
clearChatBtn.addEventListener('click', handleClearChat);

// Allow sending message with Enter key
chatInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault(); // Prevents the default action (e.g., form submission)
    handleSendMessage();
  }
});
