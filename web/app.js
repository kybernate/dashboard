/* =====================================================================
   Kybernate Dashboard
   GPU inventory, topology and reservations from the GPUNode resources.
   ===================================================================== */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const gib = bytes => (bytes || 0) / 1024 ** 3;
  const POLL_MS = 5000;
  const STALE_MS = 3 * 60 * 1000;

  const state = {
    session: null,
    nodes: [],
    sel: null,
    view: 'topo',
    msg: '',
    msgError: false,
    busy: new Set(),
    lastJSON: '',
    timer: null,
  };

  /* ---------- API ---------- */
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') opts.headers['X-Kybernate-Request'] = '1';
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch { data = null; }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- Derived data ---------- */
  const gpusOf = node => [...((node.status && node.status.gpus) || [])].sort((a, b) => a.index - b.index);
  const reservedIn = node => new Set((node.spec && node.spec.reservedGPUs) || []);
  const podName = p => `${p.namespace}/${p.name}`;
  const shortName = name => String(name || 'GPU').replace(/^NVIDIA\s+/, '');

  function role(node, gpu) {
    const reserved = reservedIn(node).has(gpu.uuid);
    const pods = gpu.allocatedTo || [];
    const st = gpu.state || (reserved ? (pods.length ? 'PendingReservation' : 'Reserved') : (pods.length ? 'Regular' : 'Free'));
    return { reserved, pods, st };
  }

  function linkOf(a, b) {
    return (a.links || []).find(l => l.peerUUID === b.uuid) || (b.links || []).find(l => l.peerUUID === a.uuid) || null;
  }

  function pcieDesc(types) {
    if (types.has('System')) return 'PCIe across CPU sockets';
    if (types.has('PCIeHostBridge')) return 'PCIe through the CPU host bridge';
    return 'PCIe through a switch';
  }

  // How the GPUs of a node are connected, in the categories of the draft.
  function fabric(node) {
    const g = gpusOf(node);
    if (g.length < 2) return { key: 'single', label: g.length ? 'Single GPU' : 'No GPU', desc: g.length ? 'one GPU' : 'no GPUs found', other: new Set() };
    let pairs = 0, nv = 0, p2p = true;
    const other = new Set();
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      pairs++;
      const l = linkOf(g[i], g[j]);
      const type = (l && l.type) || 'System';
      if (type === 'NVLink') nv++;
      else { other.add(type); if (!(l && l.p2p)) p2p = false; }
    }
    if (nv === pairs && g.length > 2) return { key: 'nvswitch', label: 'NVLink all-to-all', desc: 'every GPU connected to every other through NVLink', other };
    if (nv > 0) return { key: 'pairs', label: 'NVLink', desc: `NVLink between ${nv} GPU pair${nv > 1 ? 's' : ''}${other.size ? ', ' + pcieDesc(other) + ' otherwise' : ''}`, other };
    if (other.size === 1 && other.has('PCIeSwitch')) return { key: 'p2p', label: p2p ? 'P2P over PCIe' : 'PCIe switch', desc: `PCIe through a switch${p2p ? ', P2P possible' : ''}`, other };
    return { key: 'pcie', label: 'PCIe', desc: `${pcieDesc(other)}${p2p ? ', P2P possible' : ', no P2P'}`, other };
  }

  function summary(node) {
    const g = gpusOf(node);
    if (!g.length) return 'no GPUs';
    const byName = new Map();
    for (const x of g) byName.set(shortName(x.name), (byName.get(shortName(x.name)) || 0) + 1);
    const total = g.reduce((a, x) => a + gib(x.memoryTotalBytes), 0);
    return [...byName].map(([name, n]) => `${n}× ${name}`).join(' + ') + ` · ${num.format(total)} GiB`;
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  }

  function nodeIssue(node) {
    const st = node.status || {};
    if (!st.lastInventoryTime) return 'The node agent has not reported an inventory yet.';
    const cond = (st.conditions || []).find(c => c.type === 'InventoryReady');
    if (cond && cond.status === 'False') return `The last inventory failed (${cond.reason}): ${cond.message}`;
    if (Date.now() - Date.parse(st.lastInventoryTime) > STALE_MS) return `The inventory was last refreshed ${ago(st.lastInventoryTime)}. Is the node agent running?`;
    return '';
  }

  const selNode = () => state.nodes.find(n => n.name === state.sel);

  /* ---------- Rendering ---------- */
  function renderHeader() {
    const s = state.session;
    $('cluster').innerHTML = s && s.clusterName ? `Cluster <code>${esc(s.clusterName)}</code>` : '';
    $('user').hidden = !s;
    if (s) {
      $('user-name').textContent = s.user.username;
      $('user-name').title = `${s.user.username}${s.access.reserve ? '' : ' · read only'}`;
    }
  }

  function renderKpis() {
    let total = 0, pool = 0, poolMem = 0, pending = 0, held = 0;
    for (const n of state.nodes) for (const g of gpusOf(n)) {
      const r = role(n, g);
      total++;
      if (r.st === 'Reserved') { pool++; poolMem += gib(g.memoryTotalBytes); }
      if (r.st === 'PendingReservation') pending++;
      if (r.pods.length) held++;
    }
    $('dash-kpis').innerHTML = [
      [`${pool} / ${total}`, 'GPUs in the Kybernate pool'],
      [`${num.format(poolMem)} GiB`, 'VRAM in the pool'],
      [`${pending}`, 'reservations pending', pending ? 'hot' : ''],
      [`${held}`, 'GPUs held by pods'],
      [`${state.nodes.length}`, 'GPU nodes'],
    ].map(([b, s, c]) => `<div class="kpi ${c || ''}"><b>${esc(b)}</b><small>${esc(s)}</small></div>`).join('');
  }

  function renderNodes() {
    $('dash-nodes').innerHTML = '<p class="cap">Nodes</p>' + state.nodes.map(n => {
      const f = fabric(n);
      const bars = gpusOf(n).map(g => {
        const r = role(n, g);
        const cls = r.st === 'Reserved' ? 'k' : r.st === 'PendingReservation' ? 'p' : r.pods.length ? 'b' : '';
        return `<i class="${cls}" title="GPU ${g.index}: ${esc(r.st)}"></i>`;
      }).join('');
      const issue = nodeIssue(n);
      return `<button type="button" class="node-btn" data-node="${esc(n.name)}" aria-pressed="${n.name === state.sel}">
        <b>${issue ? `<span class="dot" title="${esc(issue)}"></span>` : ''}${esc(n.name)}</b>
        <small>${esc(summary(n))}</small>
        <span class="fab fab-${f.key}">${esc(f.label)}</span>
        <span class="mini-bar" aria-hidden="true">${bars}</span>
      </button>`;
    }).join('');
  }

  function topoSvg(node) {
    const g = gpusOf(node), n = g.length, f = fabric(node);
    if (!n) return '<p class="side-empty">No GPUs reported.</p>';
    // The drawing grows with the number of GPUs and only shrinks to fit.
    const W = Math.max(440, n * 124 + 40), H = 262, gap = 14;
    const cw = Math.min(110, (W - 40 - (n - 1) * gap) / n);
    const totalW = n * cw + (n - 1) * gap;
    const x0 = (W - totalW) / 2;
    const X = i => x0 + i * (cw + gap);
    const gy = 56, gh = 104, busY = 226;
    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Topology of ${esc(node.name)}">`;

    // Connections below the GPUs
    if (f.key === 'nvswitch') {
      s += `<rect x="${x0}" y="${busY - 14}" width="${totalW}" height="28" rx="8" fill="#2e365f"/><text x="${W / 2}" y="${busY + 5}" text-anchor="middle" fill="#fff" font-size="12" font-weight="700">NVLink · all-to-all</text>`;
      for (let i = 0; i < n; i++) s += `<line x1="${X(i) + cw / 2}" y1="${gy + gh}" x2="${X(i) + cw / 2}" y2="${busY - 14}" stroke="#2e365f" stroke-width="5" stroke-linecap="round"/>`;
    } else if (f.key === 'p2p') {
      s += `<rect x="${W / 2 - 120}" y="${busY - 14}" width="240" height="28" rx="8" fill="#eff0f4" stroke="#9aa0b6"/><text x="${W / 2}" y="${busY + 5}" text-anchor="middle" fill="#55597a" font-size="12" font-weight="700">${esc(f.label)}</text>`;
      for (let i = 0; i < n; i++) s += `<path d="M${X(i) + cw / 2} ${gy + gh} C ${X(i) + cw / 2} ${busY - 30}, ${W / 2} ${busY - 40}, ${W / 2} ${busY - 14}" fill="none" stroke="#9aa0b6" stroke-width="3" stroke-dasharray="6 5"/>`;
    } else if (n > 1) {
      const label = f.key === 'pairs' && !f.other.size ? 'PCIe' : pcieDesc(f.other);
      s += `<line x1="${x0}" y1="${busY}" x2="${x0 + totalW}" y2="${busY}" stroke="#b8bccb" stroke-width="3" stroke-linecap="round"/><text x="${W / 2}" y="${busY + 22}" text-anchor="middle" fill="#5b6290" font-size="12">${esc(label)}</text>`;
      for (let i = 0; i < n; i++) s += `<line x1="${X(i) + cw / 2}" y1="${gy + gh}" x2="${X(i) + cw / 2}" y2="${busY}" stroke="#b8bccb" stroke-width="2"/>`;
    }

    // NVLink arcs between individual GPUs
    if (f.key === 'pairs') {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const l = linkOf(g[i], g[j]);
        if (!l || l.type !== 'NVLink') continue;
        const a = X(i) + cw / 2, b = X(j) + cw / 2, h = 26 + Math.min(j - i - 1, 3) * 6;
        s += `<path d="M${a} ${gy} C ${a} ${gy - h}, ${b} ${gy - h}, ${b} ${gy}" fill="none" stroke="#2e365f" stroke-width="${Math.min(3 + (l.nvlinks || 1), 7)}" stroke-linecap="round"/>`;
        s += `<text x="${(a + b) / 2}" y="${gy - h * .75 - 4}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#2e365f">NV${l.nvlinks || ''}</text>`;
      }
    }

    // GPUs
    for (let i = 0; i < n; i++) {
      const gpu = g[i], x = X(i), r = role(node, gpu);
      const total = gib(gpu.memoryTotalBytes), used = gib(gpu.memoryUsedBytes);
      const frac = total ? Math.min(1, used / total) : 0;
      const kyb = r.st === 'Reserved', pend = r.st === 'PendingReservation';
      const fill = kyb ? '#f4f5fb' : pend ? '#fffaf5' : '#f7f7f9';
      const stroke = kyb ? '#2e365f' : pend ? '#f0913f' : '#b8bccb';
      const dash = kyb ? '' : 'stroke-dasharray="5 4"';
      const tag = gpu.migEnabled ? 'MIG' : kyb ? 'KYBERNATE' : pend ? 'PENDING' : r.pods.length ? 'POD' : 'FREE';
      s += `<g>
        <rect x="${x}" y="${gy}" width="${cw}" height="${gh}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="${kyb || pend ? 2.2 : 1.6}" ${dash}/>
        <text x="${x + cw / 2}" y="${gy + 20}" text-anchor="middle" font-size="12.5" font-weight="800">GPU ${gpu.index}</text>
        <text x="${x + cw / 2}" y="${gy + 37}" text-anchor="middle" font-size="9.5" fill="#5b6290" font-family="ui-monospace, Menlo, monospace">${tag}</text>
        <rect x="${x + 9}" y="${gy + 50}" width="${cw - 18}" height="8" rx="4" fill="#e4e6f0"/>
        <rect x="${x + 9}" y="${gy + 50}" width="${Math.max(2, (cw - 18) * frac)}" height="8" rx="4" fill="${kyb ? '#2e365f' : '#9aa0b6'}"/>
        <text x="${x + cw / 2}" y="${gy + 76}" text-anchor="middle" font-size="10.5" fill="#1d2347" font-family="ui-monospace, Menlo, monospace">${num.format(used)}/${num.format(total)}G</text>
      </g>`;
      if (r.pods.length) {
        const label = r.pods[0].name + (r.pods.length > 1 ? ` +${r.pods.length - 1}` : '');
        const max = Math.max(4, Math.floor(cw / 6.2));
        s += `<text x="${x + cw / 2}" y="${gy + 95}" text-anchor="middle" font-size="9.5" fill="#7a7f99" font-weight="700">${esc(label.length > max ? label.slice(0, max - 1) + '…' : label)}</text>`;
      }
    }
    s += '</svg>';

    const legend = {
      nvswitch: '<span><i class="sw"></i>NVLink all-to-all</span>',
      pairs: '<span><i></i>NVLink</span><span><i class="pcie"></i>PCIe</span>',
      p2p: '<span><i class="p2p"></i>PCIe switch</span>',
      pcie: '<span><i class="pcie"></i>PCIe</span>',
      single: '',
    }[f.key];
    return s + `<div class="topo-legend">${legend}<span><i class="box"></i>Kybernate pool</span><span><i class="box pend"></i>Reservation pending</span><span><i class="box k8s"></i>Regular pods</span></div>`;
  }

  function matrix(node) {
    const g = gpusOf(node);
    const code = (a, b) => {
      if (a === b) return ['X', 'x', ''];
      const l = linkOf(a, b);
      const p2p = l && l.p2p ? 'P2P supported' : 'no P2P';
      switch (l && l.type) {
        case 'NVLink': return [`NV${l.nvlinks || ''}`, 'nv', `NVLink with ${l.nvlinks || '?'} links · ${p2p}`];
        case 'PCIeSwitch': return ['PIX', 'pix', `PCIe switch · ${p2p}`];
        case 'PCIeHostBridge': return ['PHB', 'phb', `CPU host bridge · ${p2p}`];
        default: return ['SYS', 'sys', `across CPU sockets · ${p2p}`];
      }
    };
    let h = '<table aria-label="GPU connection matrix"><thead><tr><th></th>' + g.map(x => `<th scope="col">GPU${x.index}</th>`).join('') + '</tr></thead><tbody>';
    for (const a of g) h += `<tr><th scope="row">GPU${a.index}</th>` + g.map(b => { const [c, k, t] = code(a, b); return `<td class="${k}" title="${esc(t)}">${c}</td>`; }).join('') + '</tr>';
    h += '</tbody></table>';
    h += '<p class="mx-note">In the style of <code>nvidia-smi topo -m</code> · NV# = NVLink with # links · PIX = through PCIe switches · PHB = through the CPU host bridge · SYS = across CPU sockets · hover a cell for P2P support</p>';
    return h;
  }

  function gpuCard(node, gpu) {
    const r = role(node, gpu);
    const total = gib(gpu.memoryTotalBytes), used = gib(gpu.memoryUsedBytes);
    const cls = r.st === 'Reserved' ? 'kyb' : r.st === 'PendingReservation' ? 'pending' : r.pods.length ? 'busy' : '';
    const badge = { Reserved: 'Kybernate', PendingReservation: 'Pending', Regular: 'Pod', Free: 'Free' }[r.st] || r.st;

    let pod;
    if (r.pods.length) {
      const first = r.pods[0];
      pod = `<b>${esc(podName(first))}</b>${first.container ? ' · ' + esc(first.container) : ''}${r.pods.length > 1 ? ` · +${r.pods.length - 1} more` : ''}`;
      if (r.st === 'PendingReservation') pod += '<br>Joins the Kybernate pool once the pod has ended.';
    } else {
      pod = r.st === 'Reserved' ? 'In the Kybernate pool' : 'Free for regular pods';
    }
    if (gpu.processCount) pod += `<br>${gpu.processCount} process${gpu.processCount > 1 ? 'es' : ''} on the GPU`;
    if (gpu.migEnabled) pod += '<br>MIG enabled · not offered as a whole GPU';

    const canReserve = state.session && state.session.access.reserve;
    const busy = state.busy.has(gpu.uuid);
    let why = r.reserved ? 'Return the GPU to regular pods' : 'Reserve the GPU for Kybernate';
    let disabled = '';
    if (!canReserve) { disabled = 'disabled'; why = 'Read only: changing reservations needs the role kybernate-editor'; }
    else if (gpu.migEnabled && !r.reserved) { disabled = 'disabled'; why = 'Kybernate does not support MIG yet'; }
    else if (busy) disabled = 'disabled';
    else if (!r.reserved && r.pods.length) why = `Reserve now: the GPU joins the pool once ${podName(r.pods[0])} has ended`;

    return `<div class="gcard ${cls}">
      <div class="gcard-h"><b>GPU ${gpu.index}</b><span class="pool-badge">${esc(badge)}</span></div>
      <div class="gcard-name">${esc(shortName(gpu.name))}${gpu.architecture ? ' · ' + esc(gpu.architecture) : ''}</div>
      <div><span class="vram">${num.format(used)} / ${num.format(total)} GiB VRAM</span><div class="vram-bar"><span data-w="${total ? (used / total * 100).toFixed(1) : 0}"></span></div></div>
      <div class="gcard-pod">${pod}</div>
      <label class="switch" title="${esc(why)}"><input type="checkbox" data-uuid="${esc(gpu.uuid)}" ${r.reserved ? 'checked' : ''} ${disabled}><span>${busy ? 'Saving…' : r.reserved ? 'Reserved for Kybernate' : 'Reserve for Kybernate'}</span></label>
    </div>`;
  }

  function renderMain() {
    const node = selNode();
    if (!node) return;
    const g = gpusOf(node), f = fabric(node);
    const pool = g.filter(x => role(node, x).st === 'Reserved').length;
    const pending = g.filter(x => role(node, x).st === 'PendingReservation').length;
    $('dash-node-name').textContent = node.name;
    $('dash-node-desc').textContent = `${summary(node)} · ${f.desc} · ${pool} in the pool${pending ? `, ${pending} pending` : ''}`;
    const issue = nodeIssue(node);
    $('dash-warn').hidden = !issue;
    $('dash-warn').textContent = issue;
    for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', b.dataset.view === state.view);
    $('dash-topo').hidden = state.view !== 'topo';
    $('dash-matrix').hidden = state.view !== 'matrix';
    if (state.view === 'topo') $('dash-topo').innerHTML = topoSvg(node);
    else $('dash-matrix').innerHTML = matrix(node);
    $('dash-gpus').innerHTML = g.map(x => gpuCard(node, x)).join('');
    for (const el of document.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
    $('dash-msg').textContent = state.msg;
    $('dash-msg').classList.toggle('error', state.msgError);
  }

  function renderSide() {
    const node = selNode();
    if (!node) return;
    const st = node.status || {};
    const cond = (st.conditions || []).find(c => c.type === 'InventoryReady');
    const agentOK = cond ? cond.status === 'True' : !!st.lastInventoryTime;
    let h = `<h4>Node</h4><dl class="info">
      <dt>Driver</dt><dd>${esc(st.driverVersion || '–')}</dd>
      <dt>CUDA</dt><dd>${esc(st.cudaDriverVersion || '–')}</dd>
      <dt>Inventory</dt><dd>${esc(ago(st.lastInventoryTime))}</dd>
      <dt>Agent</dt><dd class="${agentOK ? '' : 'bad'}">${agentOK ? 'ready' : esc(cond ? cond.reason : 'no report')}</dd>
    </dl>`;

    const pods = new Map();
    for (const g of gpusOf(node)) {
      const r = role(node, g);
      for (const p of r.pods) {
        const key = `${podName(p)}/${p.container || ''}`;
        if (!pods.has(key)) pods.set(key, { p, gpus: [], pending: [] });
        pods.get(key).gpus.push(g.index);
        if (r.st === 'PendingReservation') pods.get(key).pending.push(g.index);
      }
    }
    h += '<h4>Pods on GPUs</h4>';
    if (!pods.size) h += '<p class="side-empty">No pod holds a GPU of this node.</p>';
    for (const { p, gpus, pending } of pods.values()) {
      h += `<div class="pcard"><b>${esc(podName(p))}</b>
        <small>${p.container ? esc(p.container) + ' · ' : ''}GPU ${gpus.join(', ')}</small>
        ${pending.length ? `<small>reserved, released when the pod ends: GPU ${pending.join(', ')}</small>` : ''}
      </div>`;
    }
    $('dash-side').innerHTML = h;
  }

  // Re-render while keeping the keyboard focus on the same control.
  function render() {
    const active = document.activeElement;
    let keep = null;
    if (active && active.dataset) {
      if (active.dataset.uuid) keep = `[data-uuid="${CSS.escape(active.dataset.uuid)}"]`;
      else if (active.dataset.node) keep = `[data-node="${CSS.escape(active.dataset.node)}"]`;
      else if (active.dataset.view) keep = `[data-view="${CSS.escape(active.dataset.view)}"]`;
    }
    renderHeader();
    renderKpis();
    if (!state.nodes.length) {
      showEmpty('No GPU nodes yet', 'Kybernate’s node agent creates a GPUNode for every node labelled <code>nvidia.com/gpu.present=true</code>. Check that Kybernate is installed and the agent runs: <code>kubectl -n kybernate-system get pods</code>.');
      return;
    }
    $('empty').hidden = true;
    $('app').hidden = false;
    renderNodes();
    renderMain();
    renderSide();
    if (keep) {
      const el = document.querySelector(keep);
      if (el) el.focus({ preventScroll: true });
    }
  }

  function setMsg(text, error = false) {
    state.msg = text;
    state.msgError = error;
    $('dash-msg').textContent = text;
    $('dash-msg').classList.toggle('error', error);
  }

  /* ---------- Views ---------- */
  function showLogin(error = '') {
    stopPolling();
    state.session = null;
    state.nodes = [];
    state.lastJSON = '';
    renderHeader();
    $('dash-kpis').innerHTML = '';
    $('app').hidden = true;
    $('empty').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = error;
    $('token').focus();
  }

  function showEmpty(title, html) {
    $('app').hidden = true;
    $('empty').hidden = false;
    $('empty').innerHTML = `<div class="empty-card"><h1>${esc(title)}</h1><p>${html}</p></div>`;
  }

  async function showApp() {
    $('login').hidden = true;
    renderHeader();
    await refresh();
    startPolling();
  }

  /* ---------- Data ---------- */
  async function refresh() {
    try {
      const data = await api('/api/gpunodes');
      const items = (data && data.items) || [];
      const json = JSON.stringify(items);
      if (json === state.lastJSON) { renderSide(); return; }
      state.lastJSON = json;
      state.nodes = items;
      if (!state.nodes.some(n => n.name === state.sel)) state.sel = state.nodes.length ? state.nodes[0].name : null;
      render();
    } catch (e) {
      if (e.status === 401) { showLogin('Your session has ended. Sign in again.'); return; }
      if (e.status === 403 || e.status === 404) {
        renderHeader();
        showEmpty(e.status === 403 ? 'No access to the GPU inventory' : 'Kybernate is not installed', esc(e.message));
        return;
      }
      setMsg(e.message, true);
    }
  }

  function startPolling() {
    stopPolling();
    state.timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }
  function stopPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function setReservation(uuid, reserved) {
    const node = selNode();
    const gpu = node && gpusOf(node).find(g => g.uuid === uuid);
    if (!gpu) return;
    state.busy.add(uuid);
    render();
    try {
      const updated = await api(`/api/gpunodes/${encodeURIComponent(node.name)}/gpus/${encodeURIComponent(uuid)}/reservation`, { method: 'PUT', body: { reserved } });
      node.spec = updated.spec;
      node.status = updated.status;
      state.lastJSON = '';
      const pods = gpu.allocatedTo || [];
      setMsg(reserved
        ? (pods.length
          ? `GPU ${gpu.index} on ${node.name} is reserved. It joins the Kybernate pool once ${podName(pods[0])} has ended.`
          : `GPU ${gpu.index} on ${node.name} is now in the Kybernate pool. Regular pods no longer get it.`)
        : `GPU ${gpu.index} on ${node.name} is available to regular pods again.`);
    } catch (e) {
      if (e.status === 401) { showLogin('Your session has ended. Sign in again.'); return; }
      setMsg(`GPU ${gpu.index} could not be changed: ${e.message}`, true);
    } finally {
      state.busy.delete(uuid);
      render();
      // The node agent updates the state of the GPU within about a second.
      setTimeout(refresh, 1200);
    }
  }

  /* ---------- Events ---------- */
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const token = $('token').value.trim();
    if (!token) return;
    $('login-submit').disabled = true;
    $('login-error').textContent = '';
    try {
      state.session = await api('/api/login', { method: 'POST', body: { token } });
      $('token').value = '';
      await showApp();
    } catch (err) {
      $('login-error').textContent = err.message;
    } finally {
      $('login-submit').disabled = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* signed out locally anyway */ }
    showLogin();
  });

  $('app').addEventListener('click', e => {
    const nodeBtn = e.target.closest('[data-node]');
    if (nodeBtn) { state.sel = nodeBtn.dataset.node; setMsg(''); render(); return; }
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) { state.view = viewBtn.dataset.view; render(); }
  });

  $('app').addEventListener('change', e => {
    const input = e.target.closest('[data-uuid]');
    if (input) setReservation(input.dataset.uuid, input.checked);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.session) refresh();
  });

  /* ---------- Start ---------- */
  (async () => {
    try {
      state.session = await api('/api/session');
      await showApp();
    } catch (e) {
      showLogin(e.status === 401 ? '' : e.message);
    }
  })();
})();
