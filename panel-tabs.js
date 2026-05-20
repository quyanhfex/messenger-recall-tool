// Filter dropdown toggle
document.getElementById('btn-filter').addEventListener('click', () => {
  const btn = document.getElementById('btn-filter');
  const dropdown = document.getElementById('filter-dropdown');
  const isOpen = dropdown.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
  btn.setAttribute('aria-expanded', isOpen.toString());
});

// Log toggle
const logToggleEl = document.getElementById('log-toggle');
const logEl = document.getElementById('log');

// Init state
logEl.setAttribute('aria-hidden', 'true');
logToggleEl.setAttribute('aria-expanded', 'false');

const toggleLog = () => {
  const label = document.getElementById('log-label');
  const isOpen = logEl.classList.toggle('open');
  
  logToggleEl.classList.toggle('open', isOpen);
  logToggleEl.setAttribute('aria-expanded', isOpen.toString());
  
  // Quan trọng: Ẩn/hiện thật sự với screen reader
  if (isOpen) {
    logEl.removeAttribute('aria-hidden');
  } else {
    logEl.setAttribute('aria-hidden', 'true');
  }
  
  label.textContent = isOpen ? 'Log (bấm để ẩn)' : 'Log';
  if (isOpen) logEl.scrollTop = logEl.scrollHeight;
};

logToggleEl.addEventListener('click', toggleLog);
logToggleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleLog();
  }
});

// Tab switching + rv-sum sync
document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  const panel = document.getElementById(btn.dataset.tab + '-panel');
  if (panel) panel.classList.add('active');
});

function syncRvSummary() {
  const t = document.getElementById('sum-total');
  const m = document.getElementById('sum-mine');
  const s = document.getElementById('sum-sel');
  if (t) document.getElementById('rv-sum-total').textContent = t.textContent;
  if (m) document.getElementById('rv-sum-mine').textContent = m.textContent;
  if (s) document.getElementById('rv-sum-sel').textContent = s.textContent;
}
const obs = new MutationObserver(syncRvSummary);
['sum-total', 'sum-mine', 'sum-sel'].forEach(id => {
  const el = document.getElementById(id);
  if (el) obs.observe(el, { childList: true, characterData: true, subtree: true });
});
