// Serum popup: the on/off switch, today's counter, and the two word lists.
// Settings live in chrome.storage.sync; the content script reacts to changes.
'use strict';

const $ = id => document.getElementById(id);
let settings = { ...SERUM_DEFAULTS };

function save() {
  chrome.storage.sync.set(settings);
}

// Draw one list (keywords or blocklist) as removable chips.
function drawList(name) {
  const ul = $(name);
  ul.textContent = '';
  if (settings[name].length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = name === 'keywords' ? 'No keywords: nothing is hidden for lack of a match.' : 'Nothing blocked.';
    ul.appendChild(li);
    return;
  }
  for (const word of settings[name]) {
    const li = document.createElement('li');
    li.textContent = word;
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Remove ' + word;
    x.addEventListener('click', () => {
      settings[name] = settings[name].filter(w => w !== word);
      save();
      drawList(name);
    });
    li.appendChild(x);
    ul.appendChild(li);
  }
}

// Add words from an input; "a, b" adds both. Stored lower case, no repeats.
function hookForm(formId, inputId, name) {
  $(formId).addEventListener('submit', e => {
    e.preventDefault();
    const words = $(inputId).value.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    for (const w of words) if (!settings[name].includes(w)) settings[name].push(w);
    $(inputId).value = '';
    save();
    drawList(name);
  });
}

async function drawCount() {
  const { stats } = await chrome.storage.local.get('stats');
  const date = new Date().toLocaleDateString('sv');
  $('count').textContent = stats && stats.date === date ? stats.count : 0;
}

chrome.storage.sync.get(SERUM_DEFAULTS, s => {
  settings = s;
  $('enabled').checked = s.enabled;
  document.body.classList.toggle('off', !s.enabled);
  drawList('keywords');
  drawList('blocklist');
});

$('enabled').addEventListener('change', () => {
  settings.enabled = $('enabled').checked;
  document.body.classList.toggle('off', !settings.enabled);
  save();
});

hookForm('keyword-form', 'keyword-input', 'keywords');
hookForm('block-form', 'block-input', 'blocklist');

drawCount();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.stats) drawCount();
});
