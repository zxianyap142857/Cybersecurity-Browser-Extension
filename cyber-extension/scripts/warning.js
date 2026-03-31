// warning.js — Logic for the blocking popup warning page

const params = new URLSearchParams(window.location.search);
const level      = params.get('level') || 'suspicious';
const confidence = parseFloat(params.get('confidence') || '0');
const targetUrl  = params.get('url') || '';

const isPhishing = level === 'phishing';

// Apply level class
document.getElementById('card').classList.add(isPhishing ? 'level-phishing' : 'level-suspicious');

// Fill content
document.getElementById('icon').textContent           = isPhishing ? '\u{1F6D1}' : '\u26A0\uFE0F';
document.getElementById('title').textContent           = isPhishing ? 'Phishing Website Detected!' : 'Suspicious Website Detected!';
document.getElementById('confidence-badge').textContent = 'Confidence: ' + confidence.toFixed(2) + '%';
document.getElementById('description').innerHTML       = isPhishing
  ? 'This website has been identified as a <strong>phishing website</strong> with high confidence. It may attempt to steal your personal information, credentials, or financial data.'
  : 'This website has been flagged as <strong>suspicious</strong>. It may contain potentially harmful content. Proceed with caution.';
document.getElementById('url-box').textContent         = targetUrl;
document.getElementById('go-back-btn').innerHTML       = '&larr; Go Back';

// Actions
document.getElementById('go-back-btn').addEventListener('click', () => {
  chrome.tabs.getCurrent((currentTab) => {
    if (currentTab) {
      chrome.tabs.goBack(currentTab.id, () => {
        if (chrome.runtime.lastError) {
          chrome.tabs.remove(currentTab.id);
        }
      });
    }
  });
});

document.getElementById('proceed-btn').addEventListener('click', () => {
  if (targetUrl) {
    const btn = document.getElementById('proceed-btn');
    btn.disabled = true;
    btn.textContent = 'Allowing\u2026';

    chrome.runtime.sendMessage({ action: 'allowBlockedUrl', url: targetUrl }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Warning] sendMessage error:', chrome.runtime.lastError.message);
      }
      console.log('[Warning] allowBlockedUrl response:', response);
      setTimeout(() => {
        chrome.tabs.getCurrent((currentTab) => {
          if (currentTab) {
            chrome.tabs.update(currentTab.id, { url: targetUrl });
          } else {
            window.location.href = targetUrl;
          }
        });
      }, 150);
    });
  }
});
