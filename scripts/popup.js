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

  function loadDashboardData() {
    console.log("Loading dashboard data from local storage...");
    chrome.storage.local.get(['scanHistory'], (result) => {
      const history = result.scanHistory || [];
      console.log("Scan history retrieved:", history);
      updateDashboardUI(history);
    });
  }

  function updateDashboardUI(history) {
    let total = 0;
    let phishing = 0;
    let legitimate = 0;
    
    const tableBody = document.querySelector('#activity-table tbody');
    if (!tableBody) return;
    
    tableBody.innerHTML = ''; 

    // Check if history exists
    if (!history || history.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 15px;">No activity recorded yet. Browse websites to generate data.</td></tr>';
      document.getElementById('total-scanned').textContent = 0;
      document.getElementById('phishing-detected').textContent = 0;
      document.getElementById('legitimate-sites').textContent = 0;
    } else {
      // Sort history by timestamp descending (newest first)
      const reversedHistory = [...history].reverse();

      reversedHistory.forEach(entry => {
        let isPhishing = false;
        let label = '';
        let urlDisplay = '';
        let confidenceDisplay = '';
        
        if (entry.type === 'batch') {
          const count = entry.total_scanned || 0;
          const p_links = entry.phishing_links || [];
          const p_count = p_links.length;
          
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
          
          if (typeof prediction === 'string' && prediction.includes('PHISHING')) {
            phishing += 1;
            isPhishing = true;
            label = 'PHISHING';
          } else {
            legitimate += 1;
            label = 'LEGITIMATE';
          }
          
          urlDisplay = entry.url;
          confidenceDisplay = (typeof confidence === 'number') ? confidence.toFixed(2) + '%' : confidence;
        }

        // Add row to table
        const row = document.createElement('tr');
        const date = new Date((entry.timestamp || Date.now()) * 1000);
        row.innerHTML = `
          <td style="padding: 8px; border-bottom: 1px solid #000000;">${date.toLocaleString()}</td>
          <td style="padding: 8px; border-bottom: 1px solid #000000; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${urlDisplay}">${urlDisplay}</td>
          <td style="padding: 8px; border-bottom: 1px solid #000000; color: ${isPhishing ? '#d9534f' : '#5cb85c'}; font-weight: bold;">${label}</td>
          <td style="padding: 8px; border-bottom: 1px solid #000000;">${confidenceDisplay}</td>
        `;
        tableBody.appendChild(row);
      });

      // Update Metrics
      document.getElementById('total-scanned').textContent = total;
      document.getElementById('phishing-detected').textContent = phishing;
      document.getElementById('legitimate-sites').textContent = legitimate;
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
