// Filter dropdown toggle
document.getElementById('btn-filter').addEventListener('click', () => {
  const btn = document.getElementById('btn-filter');
  const dropdown = document.getElementById('filter-dropdown');
  const isOpen = dropdown.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
});

// Log toggle
document.getElementById('log-toggle').addEventListener('click', () => {
  const toggle = document.getElementById('log-toggle');
  const log = document.getElementById('log');
  const label = document.getElementById('log-label');
  const isOpen = log.classList.toggle('open');
  toggle.classList.toggle('open', isOpen);
  label.textContent = isOpen ? 'Log (bấm để ẩn)' : 'Log';
  if (isOpen) log.scrollTop = log.scrollHeight;
});

// Tab switching + rv-sum sync
document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
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
