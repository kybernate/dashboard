/* =====================================================================
   Kybernate Dashboard
   GPU inventory, topology and reservations from the GPUNode resources.
   ===================================================================== */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gib = bytes => (bytes || 0) / 1024 ** 3;
  const POLL_MS = 5000;
  const STALE_MS = 3 * 60 * 1000;

  /* ---------- Language ---------- */
  const I18N = {
    en: {
      signIn: 'Sign in', signOut: 'Sign out', token: 'Token',
      signInIntro: 'Enter a Kubernetes bearer token. The dashboard acts with this token, so Kubernetes RBAC decides what you can see and change.',
      tokenHow: 'How do I get a token?',
      tokenHowText: 'Create a ServiceAccount with access to the GPU inventory and request a token for it:',
      tokenRoles: '<code>kybernate-editor</code> may reserve GPUs, <code>kybernate-viewer</code> may only look.',
      nodes: 'Nodes', view: 'View', topology: 'Topology', matrix: 'Matrix', nodeDetails: 'Node details',
      cluster: 'Cluster', readOnly: 'read only', language: 'Language',
      live: 'Live', reconnecting: 'Reconnecting…', polling: 'Refresh every 5 s',
      kpiPool: 'GPUs in the pool', kpiVram: 'VRAM in the pool', kpiPending: 'reservations pending',
      kpiHeld: 'GPUs held by pods', kpiNodes: 'GPU nodes', kpiAttention: 'nodes need attention',
      noGpu: 'no GPUs', singleGpu: 'Single GPU', noGpuLabel: 'No GPU', oneGpu: 'one GPU', noGpusFound: 'no GPUs found',
      nvAll: 'NVLink all-to-all', nvAllDesc: 'every GPU connected to every other through NVLink',
      nvPairs: n => `NVLink between ${n} GPU pair${n > 1 ? 's' : ''}`, otherwise: x => `${x} otherwise`,
      pcieSys: 'PCIe across CPU sockets', pcieHb: 'PCIe through the CPU host bridge', pcieSw: 'PCIe through a switch',
      p2pPossible: 'P2P possible', noP2p: 'no P2P', p2pOverPcie: 'P2P over PCIe', pcieSwitch: 'PCIe switch',
      inPool: n => `${n} in the pool`, pendingN: n => `${n} pending`,
      stFree: 'Free', stRegular: 'Pod', stReserved: 'Kybernate', stPending: 'Pending',
      tagMig: 'MIG', tagKyb: 'KYBERNATE', tagPending: 'PENDING', tagPod: 'POD', tagFree: 'FREE',
      legendPool: 'Kybernate pool', legendPending: 'Reservation pending', legendRegular: 'Regular pods',
      mxNote: 'In the style of <code>nvidia-smi topo -m</code> · NV# = NVLink with # links · PIX = through PCIe switches · PHB = through the CPU host bridge · SYS = across CPU sockets · hover a cell for P2P support',
      mxNv: n => `NVLink with ${n} links`, mxPix: 'PCIe switch', mxPhb: 'CPU host bridge', mxSys: 'across CPU sockets',
      p2pYes: 'P2P supported', p2pNo: 'no P2P',
      cardMore: n => `+${n} more`, cardJoins: 'Joins the Kybernate pool once the pod has ended.',
      cardInPool: 'In the Kybernate pool', cardFree: 'Free for regular pods',
      cardProcs: n => `${n} process${n > 1 ? 'es' : ''} on the GPU`, cardMig: 'MIG enabled · not offered as a whole GPU',
      vram: (u, t) => `${u} / ${t} GiB VRAM`,
      reserve: 'Reserve for Kybernate', reserved: 'Reserved for Kybernate', saving: 'Saving…',
      whyRelease: 'Return the GPU to regular pods', whyReserve: 'Reserve the GPU for Kybernate',
      whyReadOnly: 'Read only: changing reservations needs the role kybernate-editor',
      whyMig: 'Kybernate does not support MIG yet', whyHeld: p => `Reserve now: the GPU joins the pool once ${p} has ended`,
      sideNode: 'Node', sideDriver: 'Driver', sideCuda: 'CUDA', sideInventory: 'Inventory', sideAgent: 'Agent',
      sidePlugin: 'Device plugin', sideCdi: 'CDI', sideReady: 'ready', sideNoReport: 'no report', sideOff: 'off',
      sidePods: 'Pods on GPUs', sideNoPods: 'No pod holds a GPU of this node.',
      kpiWorkloads: 'workloads hot · warm', stLeased: 'Leased', tagLeased: 'LEASED',
      cardLeased: 'Leased to a Kybernate workload', legendLeased: 'Leased',
      sideWorkloads: 'Workloads', sideNoWorkloads: 'No Kybernate workload yet. Pods with the RuntimeClass kybernate appear here.',
      legendHot: 'hot · GPU', legendWarm: 'warm · RAM',
      phase: { Pending: 'Pending', Running: 'Running', Suspending: 'Suspending', Suspended: 'Suspended', Waiting: 'Waiting for GPUs', Resuming: 'Resuming', Failed: 'Failed' },
      wlOn: (node, gpus) => `${node}${gpus ? ' · GPU ' + gpus : ''}`, wlLast: (s, r) => `suspend ${s} s · resume ${r} s`,
      suspend: 'Suspend', resume: 'Resume', wlSaving: 'Sending…',
      msgWorkload: (w, st) => `${w}: ${st === 'Suspended' ? 'suspending' : 'resuming'} requested.`,
      msgWorkloadFailed: (w, e) => `${w} could not be changed: ${e}`,
      sidePendingGpus: g => `reserved, released when the pod ends: GPU ${g}`,
      ago: s => s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`, never: 'never',
      issueNoReport: 'The node agent has not reported an inventory yet.',
      issueInventory: (r, m) => `The last inventory failed (${r}): ${m}`,
      issueStale: a => `The inventory was last refreshed ${a}. Is the node agent running? Check: kubectl -n kybernate-system get pods -o wide`,
      issueConflict: 'Another device plugin, usually NVIDIA’s, serves nvidia.com/gpu on this node. Kybernate does not offer the GPUs until it is removed. With K3s: kubectl -n kube-system delete helmchart nvidia-device-plugin',
      issuePlugin: (r, m) => `The device plugin is not registered with the kubelet (${r}): ${m}`,
      issueCdi: m => `The CDI specification is incomplete, so GPUs cannot be handed to pods: ${m}`,
      issueMig: g => `GPU ${g} has MIG enabled and is not offered.`,
      issuesTitle: 'This node needs attention',
      msgReservedHeld: (g, n, p) => `GPU ${g} on ${n} is reserved. It joins the Kybernate pool once ${p} has ended.`,
      msgReserved: (g, n) => `GPU ${g} on ${n} is now in the Kybernate pool. Regular pods no longer get it.`,
      msgReleased: (g, n) => `GPU ${g} on ${n} is available to regular pods again.`,
      msgFailed: (g, e) => `GPU ${g} could not be changed: ${e}`,
      sessionEnded: 'Your session has ended. Sign in again.',
      emptyTitle: 'No GPU nodes yet',
      emptyText: 'Kybernate’s node agent creates a GPUNode for every node labelled <code>nvidia.com/gpu.present=true</code>. Check that Kybernate is installed and the agent runs: <code>kubectl -n kybernate-system get pods</code>.',
      noAccess: 'No access to the GPU inventory', notInstalled: 'Kybernate is not installed',
      topoLabel: n => `Topology of ${n}`, matrixLabel: 'GPU connection matrix',
    },
    de: {
      signIn: 'Anmelden', signOut: 'Abmelden', token: 'Token',
      signInIntro: 'Gib einen Kubernetes-Bearer-Token ein. Das Dashboard handelt mit diesem Token, Kubernetes-RBAC entscheidet also, was du sehen und ändern darfst.',
      tokenHow: 'Wie bekomme ich einen Token?',
      tokenHowText: 'Lege einen ServiceAccount mit Zugriff auf das GPU-Inventar an und fordere einen Token dafür an:',
      tokenRoles: '<code>kybernate-editor</code> darf GPUs reservieren, <code>kybernate-viewer</code> nur ansehen.',
      nodes: 'Nodes', view: 'Ansicht', topology: 'Topologie', matrix: 'Matrix', nodeDetails: 'Node-Details',
      cluster: 'Cluster', readOnly: 'nur lesen', language: 'Sprache',
      live: 'Live', reconnecting: 'Verbinde neu …', polling: 'Abfrage alle 5 s',
      kpiPool: 'GPUs im Pool', kpiVram: 'VRAM im Pool', kpiPending: 'Reservierungen offen',
      kpiHeld: 'GPUs bei Pods', kpiNodes: 'GPU-Nodes', kpiAttention: 'Nodes mit Problemen',
      noGpu: 'keine GPUs', singleGpu: 'Eine GPU', noGpuLabel: 'Keine GPU', oneGpu: 'eine GPU', noGpusFound: 'keine GPUs gefunden',
      nvAll: 'NVLink alle-zu-allen', nvAllDesc: 'jede GPU über NVLink mit jeder anderen verbunden',
      nvPairs: n => `NVLink zwischen ${n} GPU-${n > 1 ? 'Paaren' : 'Paar'}`, otherwise: x => `sonst ${x}`,
      pcieSys: 'PCIe über CPU-Sockel hinweg', pcieHb: 'PCIe über die Host Bridge der CPU', pcieSw: 'PCIe über einen Switch',
      p2pPossible: 'P2P möglich', noP2p: 'kein P2P', p2pOverPcie: 'P2P über PCIe', pcieSwitch: 'PCIe-Switch',
      inPool: n => `${n} im Pool`, pendingN: n => `${n} wartend`,
      stFree: 'Frei', stRegular: 'Pod', stReserved: 'Kybernate', stPending: 'Wartet',
      tagMig: 'MIG', tagKyb: 'KYBERNATE', tagPending: 'WARTET', tagPod: 'POD', tagFree: 'FREI',
      legendPool: 'Kybernate-Pool', legendPending: 'Reservierung wartet', legendRegular: 'Reguläre Pods',
      mxNote: 'Im Stil von <code>nvidia-smi topo -m</code> · NV# = NVLink mit # Links · PIX = über PCIe-Switches · PHB = über die Host Bridge der CPU · SYS = über CPU-Sockel hinweg · Zelle zeigt beim Überfahren, ob P2P geht',
      mxNv: n => `NVLink mit ${n} Links`, mxPix: 'PCIe-Switch', mxPhb: 'Host Bridge der CPU', mxSys: 'über CPU-Sockel hinweg',
      p2pYes: 'P2P möglich', p2pNo: 'kein P2P',
      cardMore: n => `+${n} weitere`, cardJoins: 'Kommt in den Kybernate-Pool, sobald der Pod beendet ist.',
      cardInPool: 'Im Kybernate-Pool', cardFree: 'Frei für reguläre Pods',
      cardProcs: n => `${n} ${n > 1 ? 'Prozesse' : 'Prozess'} auf der GPU`, cardMig: 'MIG aktiv · wird nicht als ganze GPU angeboten',
      vram: (u, t) => `${u} / ${t} GiB VRAM`,
      reserve: 'Für Kybernate reservieren', reserved: 'Für Kybernate reserviert', saving: 'Speichert …',
      whyRelease: 'GPU an reguläre Pods zurückgeben', whyReserve: 'GPU für Kybernate reservieren',
      whyReadOnly: 'Nur lesen: Reservierungen ändern erfordert die Rolle kybernate-editor',
      whyMig: 'Kybernate unterstützt MIG noch nicht', whyHeld: p => `Jetzt reservieren: Die GPU kommt in den Pool, sobald ${p} beendet ist`,
      sideNode: 'Node', sideDriver: 'Treiber', sideCuda: 'CUDA', sideInventory: 'Inventar', sideAgent: 'Agent',
      sidePlugin: 'Device-Plugin', sideCdi: 'CDI', sideReady: 'bereit', sideNoReport: 'keine Meldung', sideOff: 'aus',
      sidePods: 'Pods auf GPUs', sideNoPods: 'Kein Pod belegt eine GPU dieses Nodes.',
      kpiWorkloads: 'Workloads hot · warm', stLeased: 'Geleast', tagLeased: 'GELEAST',
      cardLeased: 'An einen Kybernate-Workload geleast', legendLeased: 'Geleast',
      sideWorkloads: 'Workloads', sideNoWorkloads: 'Noch kein Kybernate-Workload. Pods mit der RuntimeClass kybernate erscheinen hier.',
      legendHot: 'hot · GPU', legendWarm: 'warm · RAM',
      phase: { Pending: 'Wartet auf Start', Running: 'Läuft', Suspending: 'Wird ausgelagert', Suspended: 'Ausgelagert', Waiting: 'Wartet auf GPUs', Resuming: 'Wird fortgesetzt', Failed: 'Fehler' },
      wlOn: (node, gpus) => `${node}${gpus ? ' · GPU ' + gpus : ''}`, wlLast: (s, r) => `auslagern ${s} s · fortsetzen ${r} s`,
      suspend: 'Auslagern', resume: 'Fortsetzen', wlSaving: 'Sendet …',
      msgWorkload: (w, st) => `${w}: ${st === 'Suspended' ? 'Auslagern' : 'Fortsetzen'} angefordert.`,
      msgWorkloadFailed: (w, e) => `${w} konnte nicht geändert werden: ${e}`,
      sidePendingGpus: g => `reserviert, frei sobald der Pod endet: GPU ${g}`,
      ago: s => s < 60 ? `vor ${s} s` : s < 3600 ? `vor ${Math.round(s / 60)} min` : `vor ${Math.round(s / 3600)} h`, never: 'nie',
      issueNoReport: 'Der Node-Agent hat noch kein Inventar gemeldet.',
      issueInventory: (r, m) => `Das letzte Inventar ist fehlgeschlagen (${r}): ${m}`,
      issueStale: a => `Das Inventar wurde zuletzt ${a} aktualisiert. Läuft der Node-Agent? Prüfen: kubectl -n kybernate-system get pods -o wide`,
      issueConflict: 'Ein anderes Device-Plugin, meist das von NVIDIA, bietet auf diesem Node nvidia.com/gpu an. Kybernate bietet die GPUs erst an, wenn es entfernt ist. Bei K3s: kubectl -n kube-system delete helmchart nvidia-device-plugin',
      issuePlugin: (r, m) => `Das Device-Plugin ist nicht beim Kubelet registriert (${r}): ${m}`,
      issueCdi: m => `Die CDI-Spezifikation ist unvollständig, GPUs können nicht an Pods gegeben werden: ${m}`,
      issueMig: g => `Auf GPU ${g} ist MIG aktiv, sie wird nicht angeboten.`,
      issuesTitle: 'Dieser Node braucht Aufmerksamkeit',
      msgReservedHeld: (g, n, p) => `GPU ${g} auf ${n} ist reserviert. Sie kommt in den Kybernate-Pool, sobald ${p} beendet ist.`,
      msgReserved: (g, n) => `GPU ${g} auf ${n} ist jetzt im Kybernate-Pool. Reguläre Pods bekommen sie nicht mehr.`,
      msgReleased: (g, n) => `GPU ${g} auf ${n} steht regulären Pods wieder zur Verfügung.`,
      msgFailed: (g, e) => `GPU ${g} konnte nicht geändert werden: ${e}`,
      sessionEnded: 'Deine Sitzung ist abgelaufen. Bitte melde dich neu an.',
      emptyTitle: 'Noch keine GPU-Nodes',
      emptyText: 'Der Node-Agent von Kybernate legt für jeden Node mit dem Label <code>nvidia.com/gpu.present=true</code> einen GPUNode an. Prüfe, ob Kybernate installiert ist und der Agent läuft: <code>kubectl -n kybernate-system get pods</code>.',
      noAccess: 'Kein Zugriff auf das GPU-Inventar', notInstalled: 'Kybernate ist nicht installiert',
      topoLabel: n => `Topologie von ${n}`, matrixLabel: 'Verbindungsmatrix der GPUs',
    },
  };
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  let lang = storage.get('kybernate-lang') || ((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en');
  let num = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  const t = (key, ...args) => {
    const v = (I18N[lang] && I18N[lang][key]) ?? I18N.en[key];
    return typeof v === 'function' ? v(...args) : v;
  };
  const tPhase = p => (t('phase') || {})[p] || p || '–';
  function applyStaticTexts() {
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    $('lang').textContent = lang === 'de' ? 'EN' : 'DE';
    $('lang').title = t('language');
  }

  const state = {
    session: null,
    nodes: [],
    workloads: [],
    wlBusy: new Set(),
    sel: null,
    view: 'topo',
    msg: '',
    msgError: false,
    busy: new Set(),
    lastJSON: '',
    timer: null,
    events: null,
    live: 'off', // off | live | reconnecting | polling
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
  const condition = (node, type) => ((node.status && node.status.conditions) || []).find(c => c.type === type);

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
    if (types.has('System')) return t('pcieSys');
    if (types.has('PCIeHostBridge')) return t('pcieHb');
    return t('pcieSw');
  }

  // How the GPUs of a node are connected, in the categories of the draft.
  function fabric(node) {
    const g = gpusOf(node);
    if (g.length < 2) return { key: 'single', label: g.length ? t('singleGpu') : t('noGpuLabel'), desc: g.length ? t('oneGpu') : t('noGpusFound'), other: new Set() };
    let pairs = 0, nv = 0, p2p = true;
    const other = new Set();
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      pairs++;
      const l = linkOf(g[i], g[j]);
      const type = (l && l.type) || 'System';
      if (type === 'NVLink') nv++;
      else { other.add(type); if (!(l && l.p2p)) p2p = false; }
    }
    if (nv === pairs && g.length > 2) return { key: 'nvswitch', label: t('nvAll'), desc: t('nvAllDesc'), other };
    if (nv > 0) return { key: 'pairs', label: 'NVLink', desc: t('nvPairs', nv) + (other.size ? ', ' + t('otherwise', pcieDesc(other)) : ''), other };
    if (other.size === 1 && other.has('PCIeSwitch')) return { key: 'p2p', label: p2p ? t('p2pOverPcie') : t('pcieSwitch'), desc: t('pcieSw') + (p2p ? ', ' + t('p2pPossible') : ''), other };
    return { key: 'pcie', label: 'PCIe', desc: `${pcieDesc(other)}, ${p2p ? t('p2pPossible') : t('noP2p')}`, other };
  }

  function summary(node) {
    const g = gpusOf(node);
    if (!g.length) return t('noGpu');
    const byName = new Map();
    for (const x of g) byName.set(shortName(x.name), (byName.get(shortName(x.name)) || 0) + 1);
    const total = g.reduce((a, x) => a + gib(x.memoryTotalBytes), 0);
    return [...byName].map(([name, n]) => `${n}× ${name}`).join(' + ') + ` · ${num.format(total)} GiB`;
  }

  function ago(ts) {
    if (!ts) return t('never');
    return t('ago', Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000)));
  }

  // Everything that keeps a node from working as expected, most severe first.
  function issues(node) {
    const st = node.status || {};
    const out = [];
    if (!st.lastInventoryTime) return [t('issueNoReport')];
    const inv = condition(node, 'InventoryReady');
    if (inv && inv.status === 'False') out.push(t('issueInventory', inv.reason, inv.message));
    if (Date.now() - Date.parse(st.lastInventoryTime) > STALE_MS) out.push(t('issueStale', ago(st.lastInventoryTime)));
    const plugin = condition(node, 'DevicePluginReady');
    if (plugin && plugin.status === 'False') {
      out.push(plugin.reason === 'ConflictingPlugin' ? t('issueConflict') : t('issuePlugin', plugin.reason, plugin.message));
    }
    const cdi = condition(node, 'CDIReady');
    if (cdi && cdi.status === 'False') out.push(t('issueCdi', cdi.message));
    for (const g of gpusOf(node)) if (g.migEnabled) out.push(t('issueMig', g.index));
    return out;
  }

  const selNode = () => state.nodes.find(n => n.name === state.sel);

  /* ---------- Rendering ---------- */
  // A ServiceAccount signs in as system:serviceaccount:<namespace>:<name>. The header shows
  // only the name; the tooltip keeps the full user name.
  function shortUser(name) {
    const m = /^system:serviceaccount:[^:]+:(.+)$/.exec(name || '');
    return m ? m[1] : name;
  }

  function renderHeader() {
    const s = state.session;
    $('cluster').innerHTML = s && s.clusterName ? `${esc(t('cluster'))} <code>${esc(s.clusterName)}</code>` : '';
    $('user-name').hidden = !s;
    $('logout').hidden = !s;
    if (s) {
      $('user-name').textContent = shortUser(s.user.username);
      $('user-name').title = `${s.user.username}${s.access.reserve ? '' : ' · ' + t('readOnly')}`;
    }
    const live = $('live');
    live.hidden = !s || state.live === 'off';
    live.className = `live ${state.live}`;
    live.textContent = { live: t('live'), reconnecting: t('reconnecting'), polling: t('polling') }[state.live] || '';
  }

  function renderKpis() {
    let total = 0, pool = 0, poolMem = 0, pending = 0, held = 0, attention = 0;
    for (const n of state.nodes) {
      if (issues(n).length) attention++;
      for (const g of gpusOf(n)) {
        const r = role(n, g);
        total++;
        if (r.st === 'Reserved') { pool++; poolMem += gib(g.memoryTotalBytes); }
        if (r.st === 'PendingReservation') pending++;
        if (r.pods.length) held++;
      }
    }
    const kpis = [
      [`${pool} / ${total}`, t('kpiPool')],
      [`${num.format(poolMem)} GiB`, t('kpiVram')],
      [`${pending}`, t('kpiPending'), pending ? 'hot' : ''],
      [`${held}`, t('kpiHeld')],
      [`${state.nodes.length}`, t('kpiNodes')],
    ];
    if (state.workloads.length) {
      const hot = state.workloads.filter(w => w.status.phase === 'Running').length;
      const warm = state.workloads.filter(w => w.status.phase === 'Suspended' || w.status.phase === 'Waiting').length;
      kpis.splice(4, 0, [`${hot} · ${warm}`, t('kpiWorkloads')]);
    }
    if (attention) kpis.push([`${attention}`, t('kpiAttention'), 'alert']);
    $('dash-kpis').innerHTML = kpis.map(([b, s, c]) => `<div class="kpi ${c || ''}"><b>${esc(b)}</b><small>${esc(s)}</small></div>`).join('');
  }

  function renderNodes() {
    $('dash-nodes').innerHTML = `<p class="cap">${esc(t('nodes'))}</p>` + state.nodes.map(n => {
      const f = fabric(n);
      const bars = gpusOf(n).map(g => {
        const r = role(n, g);
        const cls = r.st === 'Reserved' ? 'k' : r.st === 'PendingReservation' ? 'p' : r.pods.length ? 'b' : '';
        return `<i class="${cls}" title="GPU ${g.index}: ${esc(r.st)}"></i>`;
      }).join('');
      const problems = issues(n);
      return `<button type="button" class="node-btn${problems.length ? ' problem' : ''}" data-node="${esc(n.name)}" aria-pressed="${n.name === state.sel}">
        <b>${problems.length ? `<span class="dot" title="${esc(problems[0])}"></span>` : ''}${esc(n.name)}</b>
        <small>${esc(summary(n))}</small>
        <span class="fab fab-${f.key}">${esc(f.label)}</span>
        <span class="mini-bar" aria-hidden="true">${bars}</span>
      </button>`;
    }).join('');
  }

  function topoSvg(node) {
    const g = gpusOf(node), n = g.length, f = fabric(node);
    if (!n) return `<p class="side-empty">${esc(t('noGpusFound'))}</p>`;
    // The drawing grows with the number of GPUs and only shrinks to fit.
    const W = Math.max(440, n * 124 + 40), H = 262, gap = 14;
    const cw = Math.min(110, (W - 40 - (n - 1) * gap) / n);
    const totalW = n * cw + (n - 1) * gap;
    const x0 = (W - totalW) / 2;
    const X = i => x0 + i * (cw + gap);
    const gy = 56, gh = 104, busY = 226;
    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('topoLabel', node.name))}">`;

    if (f.key === 'nvswitch') {
      s += `<rect x="${x0}" y="${busY - 14}" width="${totalW}" height="28" rx="8" fill="#2e365f"/><text x="${W / 2}" y="${busY + 5}" text-anchor="middle" fill="#fff" font-size="12" font-weight="700">${esc(t('nvAll'))}</text>`;
      for (let i = 0; i < n; i++) s += `<line x1="${X(i) + cw / 2}" y1="${gy + gh}" x2="${X(i) + cw / 2}" y2="${busY - 14}" stroke="#2e365f" stroke-width="5" stroke-linecap="round"/>`;
    } else if (f.key === 'p2p') {
      s += `<rect x="${W / 2 - 120}" y="${busY - 14}" width="240" height="28" rx="8" fill="#eff0f4" stroke="#9aa0b6"/><text x="${W / 2}" y="${busY + 5}" text-anchor="middle" fill="#55597a" font-size="12" font-weight="700">${esc(f.label)}</text>`;
      for (let i = 0; i < n; i++) s += `<path d="M${X(i) + cw / 2} ${gy + gh} C ${X(i) + cw / 2} ${busY - 30}, ${W / 2} ${busY - 40}, ${W / 2} ${busY - 14}" fill="none" stroke="#9aa0b6" stroke-width="3" stroke-dasharray="6 5"/>`;
    } else if (n > 1) {
      const label = f.key === 'pairs' && !f.other.size ? 'PCIe' : pcieDesc(f.other);
      s += `<line x1="${x0}" y1="${busY}" x2="${x0 + totalW}" y2="${busY}" stroke="#b8bccb" stroke-width="3" stroke-linecap="round"/><text x="${W / 2}" y="${busY + 22}" text-anchor="middle" fill="#5b6290" font-size="12">${esc(label)}</text>`;
      for (let i = 0; i < n; i++) s += `<line x1="${X(i) + cw / 2}" y1="${gy + gh}" x2="${X(i) + cw / 2}" y2="${busY}" stroke="#b8bccb" stroke-width="2"/>`;
    }

    if (f.key === 'pairs') {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const l = linkOf(g[i], g[j]);
        if (!l || l.type !== 'NVLink') continue;
        const a = X(i) + cw / 2, b = X(j) + cw / 2, h = 26 + Math.min(j - i - 1, 3) * 6;
        s += `<path d="M${a} ${gy} C ${a} ${gy - h}, ${b} ${gy - h}, ${b} ${gy}" fill="none" stroke="#2e365f" stroke-width="${Math.min(3 + (l.nvlinks || 1), 7)}" stroke-linecap="round"/>`;
        s += `<text x="${(a + b) / 2}" y="${gy - h * .75 - 4}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#2e365f">NV${l.nvlinks || ''}</text>`;
      }
    }

    for (let i = 0; i < n; i++) {
      const gpu = g[i], x = X(i), r = role(node, gpu);
      const total = gib(gpu.memoryTotalBytes), used = gib(gpu.memoryUsedBytes);
      const frac = total ? Math.min(1, used / total) : 0;
      const kyb = r.st === 'Reserved', pend = r.st === 'PendingReservation';
      const fill = kyb ? '#f4f5fb' : pend ? '#fffaf5' : '#f7f7f9';
      const stroke = kyb ? '#2e365f' : pend ? '#f0913f' : '#b8bccb';
      const dash = kyb ? '' : 'stroke-dasharray="5 4"';
      const tag = gpu.migEnabled ? t('tagMig') : gpu.leasedTo ? t('tagLeased') : kyb ? t('tagKyb') : pend ? t('tagPending') : r.pods.length ? t('tagPod') : t('tagFree');
      s += `<g>
        <rect x="${x}" y="${gy}" width="${cw}" height="${gh}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="${kyb || pend ? 2.2 : 1.6}" ${dash}/>
        <text x="${x + cw / 2}" y="${gy + 20}" text-anchor="middle" font-size="12.5" font-weight="800">GPU ${gpu.index}</text>
        <text x="${x + cw / 2}" y="${gy + 37}" text-anchor="middle" font-size="9.5" fill="#5b6290" font-family="ui-monospace, Menlo, monospace">${esc(tag)}</text>
        <rect x="${x + 9}" y="${gy + 50}" width="${cw - 18}" height="8" rx="4" fill="#e4e6f0"/>
        <rect x="${x + 9}" y="${gy + 50}" width="${Math.max(2, (cw - 18) * frac)}" height="8" rx="4" fill="${gpu.leasedTo ? '#d64f2d' : kyb ? '#2e365f' : '#9aa0b6'}"/>
        <text x="${x + cw / 2}" y="${gy + 76}" text-anchor="middle" font-size="10.5" fill="#1d2347" font-family="ui-monospace, Menlo, monospace">${num.format(used)}/${num.format(total)}G</text>
      </g>`;
      const holders = gpu.leasedTo ? [gpu.leasedTo] : r.pods;
      if (holders.length) {
        const label = holders[0].name + (holders.length > 1 ? ` +${holders.length - 1}` : '');
        const max = Math.max(4, Math.floor(cw / 6.2));
        s += `<text x="${x + cw / 2}" y="${gy + 95}" text-anchor="middle" font-size="9.5" fill="#7a7f99" font-weight="700">${esc(label.length > max ? label.slice(0, max - 1) + '…' : label)}</text>`;
      }
    }
    s += '</svg>';

    const legend = {
      nvswitch: `<span><i class="sw"></i>${esc(t('nvAll'))}</span>`,
      pairs: '<span><i></i>NVLink</span><span><i class="pcie"></i>PCIe</span>',
      p2p: `<span><i class="p2p"></i>${esc(t('pcieSwitch'))}</span>`,
      pcie: '<span><i class="pcie"></i>PCIe</span>',
      single: '',
    }[f.key];
    return s + `<div class="topo-legend">${legend}<span><i class="box"></i>${esc(t('legendPool'))}</span><span><i class="box pend"></i>${esc(t('legendPending'))}</span><span><i class="box k8s"></i>${esc(t('legendRegular'))}</span></div>`;
  }

  function matrix(node) {
    const g = gpusOf(node);
    const code = (a, b) => {
      if (a === b) return ['X', 'x', ''];
      const l = linkOf(a, b);
      const p2p = l && l.p2p ? t('p2pYes') : t('p2pNo');
      switch (l && l.type) {
        case 'NVLink': return [`NV${l.nvlinks || ''}`, 'nv', `${t('mxNv', l.nvlinks || '?')} · ${p2p}`];
        case 'PCIeSwitch': return ['PIX', 'pix', `${t('mxPix')} · ${p2p}`];
        case 'PCIeHostBridge': return ['PHB', 'phb', `${t('mxPhb')} · ${p2p}`];
        default: return ['SYS', 'sys', `${t('mxSys')} · ${p2p}`];
      }
    };
    let h = `<table aria-label="${esc(t('matrixLabel'))}"><thead><tr><th></th>` + g.map(x => `<th scope="col">GPU${x.index}</th>`).join('') + '</tr></thead><tbody>';
    for (const a of g) h += `<tr><th scope="row">GPU${a.index}</th>` + g.map(b => { const [c, k, ti] = code(a, b); return `<td class="${k}" title="${esc(ti)}">${c}</td>`; }).join('') + '</tr>';
    h += '</tbody></table>';
    h += `<p class="mx-note">${t('mxNote')}</p>`;
    return h;
  }

  function gpuCard(node, gpu) {
    const r = role(node, gpu);
    const total = gib(gpu.memoryTotalBytes), used = gib(gpu.memoryUsedBytes);
    const cls = (r.st === 'Reserved' ? 'kyb' : r.st === 'PendingReservation' ? 'pending' : r.pods.length ? 'busy' : '') + (gpu.leasedTo ? ' hot' : '');
    let badge = { Reserved: t('stReserved'), PendingReservation: t('stPending'), Regular: t('stRegular'), Free: t('stFree') }[r.st] || r.st;
    if (gpu.leasedTo) badge = t('stLeased');

    let pod;
    if (r.pods.length) {
      const first = r.pods[0];
      pod = `<b>${esc(podName(first))}</b>${first.container ? ' · ' + esc(first.container) : ''}${r.pods.length > 1 ? ' · ' + esc(t('cardMore', r.pods.length - 1)) : ''}`;
      if (r.st === 'PendingReservation') pod += `<br>${esc(t('cardJoins'))}`;
    } else if (gpu.leasedTo) {
      pod = `<b>${esc(podName(gpu.leasedTo))}</b>${gpu.leasedTo.container ? ' · ' + esc(gpu.leasedTo.container) : ''}<br>${esc(t('cardLeased'))}`;
    } else {
      pod = esc(r.st === 'Reserved' ? t('cardInPool') : t('cardFree'));
    }
    if (gpu.processCount) pod += `<br>${esc(t('cardProcs', gpu.processCount))}`;
    if (gpu.migEnabled) pod += `<br>${esc(t('cardMig'))}`;

    const canReserve = state.session && state.session.access.reserve;
    const busy = state.busy.has(gpu.uuid);
    let why = r.reserved ? t('whyRelease') : t('whyReserve');
    let disabled = '';
    if (!canReserve) { disabled = 'disabled'; why = t('whyReadOnly'); }
    else if (gpu.migEnabled && !r.reserved) { disabled = 'disabled'; why = t('whyMig'); }
    else if (busy) disabled = 'disabled';
    else if (!r.reserved && r.pods.length) why = t('whyHeld', podName(r.pods[0]));

    return `<div class="gcard ${cls}">
      <div class="gcard-h"><b>GPU ${gpu.index}</b><span class="pool-badge">${esc(badge)}</span></div>
      <div class="gcard-name">${esc(shortName(gpu.name))}${gpu.architecture ? ' · ' + esc(gpu.architecture) : ''}</div>
      <div><span class="vram">${esc(t('vram', num.format(used), num.format(total)))}</span><div class="vram-bar"><span data-w="${total ? (used / total * 100).toFixed(1) : 0}"></span></div></div>
      <div class="gcard-pod">${pod}</div>
      <label class="switch" title="${esc(why)}"><input type="checkbox" data-uuid="${esc(gpu.uuid)}" ${r.reserved ? 'checked' : ''} ${disabled}><span>${esc(busy ? t('saving') : r.reserved ? t('reserved') : t('reserve'))}</span></label>
    </div>`;
  }

  function renderMain() {
    const node = selNode();
    if (!node) return;
    const g = gpusOf(node), f = fabric(node);
    const pool = g.filter(x => role(node, x).st === 'Reserved').length;
    const pending = g.filter(x => role(node, x).st === 'PendingReservation').length;
    $('dash-node-name').textContent = node.name;
    $('dash-node-desc').textContent = `${summary(node)} · ${f.desc} · ${t('inPool', pool)}${pending ? ', ' + t('pendingN', pending) : ''}`;
    const problems = issues(node);
    $('dash-warn').hidden = !problems.length;
    $('dash-warn').innerHTML = problems.length
      ? `<b>${esc(t('issuesTitle'))}</b><ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`
      : '';
    for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', b.dataset.view === state.view);
    $('dash-topo').hidden = state.view !== 'topo';
    $('dash-matrix').hidden = state.view !== 'matrix';
    if (state.view === 'topo') $('dash-topo').innerHTML = topoSvg(node);
    else $('dash-matrix').innerHTML = matrix(node);
    $('dash-gpus').innerHTML = g.map(x => gpuCard(node, x)).join('');
    for (const el of document.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
    for (const el of document.querySelectorAll('[data-color]')) el.style.background = el.dataset.color;
    $('dash-msg').textContent = state.msg;
    $('dash-msg').classList.toggle('error', state.msgError);
  }

  function condCell(node, type) {
    const c = condition(node, type);
    if (!c) return `<dd>${esc(t('sideOff'))}</dd>`;
    return c.status === 'True' ? `<dd>${esc(t('sideReady'))}</dd>` : `<dd class="bad">${esc(c.reason)}</dd>`;
  }

  function renderSide() {
    const node = selNode();
    if (!node) return;
    const st = node.status || {};
    const inv = condition(node, 'InventoryReady');
    const agentOK = inv ? inv.status === 'True' : !!st.lastInventoryTime;
    let h = `<h4>${esc(t('sideNode'))}</h4><dl class="info">
      <dt>${esc(t('sideDriver'))}</dt><dd>${esc(st.driverVersion || '–')}</dd>
      <dt>${esc(t('sideCuda'))}</dt><dd>${esc(st.cudaDriverVersion || '–')}</dd>
      <dt>${esc(t('sideInventory'))}</dt><dd>${esc(ago(st.lastInventoryTime))}</dd>
      <dt>${esc(t('sideAgent'))}</dt><dd class="${agentOK ? '' : 'bad'}">${esc(agentOK ? t('sideReady') : (inv ? inv.reason : t('sideNoReport')))}</dd>
      <dt>${esc(t('sidePlugin'))}</dt>${condCell(node, 'DevicePluginReady')}
      <dt>${esc(t('sideCdi'))}</dt>${condCell(node, 'CDIReady')}
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
    h += `<h4>${esc(t('sidePods'))}</h4>`;
    if (!pods.size) h += `<p class="side-empty">${esc(t('sideNoPods'))}</p>`;
    for (const { p, gpus, pending } of pods.values()) {
      h += `<div class="pcard"><b>${esc(podName(p))}</b>
        <small>${p.container ? esc(p.container) + ' · ' : ''}GPU ${gpus.join(', ')}</small>
        ${pending.length ? `<small>${esc(t('sidePendingGpus', pending.join(', ')))}</small>` : ''}
      </div>`;
    }
    h += renderWorkloads();
    $('dash-side').innerHTML = h;
  }

  const PHASE_CLASS = { Running: 'ready', Suspended: 'ram', Waiting: 'busy', Suspending: 'busy', Resuming: 'busy', Pending: 'busy', Failed: 'failed' };
  const PHASE_COLOR = { ready: '#d64f2d', ram: '#f0913f', busy: '#f0913f', failed: '#a93a1e' };

  // All Kybernate workloads, as the models in the dashboard draft: the colour
  // shows where their state lives, hot in GPU memory or warm in host memory.
  function renderWorkloads() {
    let h = `<h4>${esc(t('sideWorkloads'))}</h4>`;
    h += `<div class="dash-legend"><span class="temp"><i class="t-hot"></i>${esc(t('legendHot'))}</span><span class="temp"><i class="t-warm"></i>${esc(t('legendWarm'))}</span></div>`;
    if (!state.workloads.length) return h + `<p class="side-empty">${esc(t('sideNoWorkloads'))}</p>`;
    const canSuspend = state.session && state.session.access.suspend;
    for (const w of state.workloads) {
      const st = w.status || {};
      const cls = PHASE_CLASS[st.phase] || 'busy';
      const key = `${w.namespace}/${w.name}`;
      const busy = state.wlBusy.has(key);
      const gpus = (st.containers || []).flatMap(c => (c.leasedGPUs && c.leasedGPUs.length ? c.leasedGPUs : c.physicalGPUs || []).slice(0, c.gpuCount));
      const node = state.nodes.find(n => n.name === st.nodeName);
      const idx = gpus.map(u => { const g = node && gpusOf(node).find(x => x.uuid === u); return g ? g.index : '?'; }).join(', ');
      let action = '';
      if (canSuspend && st.phase === 'Running') action = `<button type="button" data-wl="${esc(key)}" data-state="Suspended" ${busy ? 'disabled' : ''}>${esc(busy ? t('wlSaving') : t('suspend'))}</button>`;
      if (canSuspend && (st.phase === 'Suspended' || st.phase === 'Waiting' || st.phase === 'Failed') && w.spec.state !== 'Running') action = `<button type="button" data-wl="${esc(key)}" data-state="Running" ${busy ? 'disabled' : ''}>${esc(busy ? t('wlSaving') : t('resume'))}</button>`;
      h += `<div class="mcard${st.nodeName === state.sel ? ' hl' : ''}" data-wl-node="${esc(st.nodeName || '')}">
        <div class="mcard-h"><b><i data-color="${PHASE_COLOR[cls]}"></i>${esc(key)}</b><span class="state ${cls}">${esc(tPhase(st.phase))}</span></div>
        <div class="mcard-meta">${esc(t('wlOn', st.nodeName || '–', idx))} · ${esc(st.isolation || 'strict')}</div>
        ${st.lastSuspendSeconds || st.lastResumeSeconds ? `<div class="mcard-meta">${esc(t('wlLast', st.lastSuspendSeconds || '–', st.lastResumeSeconds || '–'))}</div>` : ''}
        ${st.message ? `<div class="mcard-msg">${esc(st.message)}</div>` : ''}
        ${action ? `<div class="mcard-actions">${action}</div>` : ''}
      </div>`;
    }
    return h;
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
    if (!state.session) return;
    renderKpis();
    if (!state.nodes.length) {
      showEmpty(t('emptyTitle'), t('emptyText'));
      return;
    }
    $('empty').hidden = true;
    $('app').hidden = false;
    renderNodes();
    renderMain();
    renderSide();
    for (const el of document.querySelectorAll('[data-color]')) el.style.background = el.dataset.color;
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
    stopUpdates();
    state.session = null;
    state.nodes = [];
    state.lastJSON = '';
    state.live = 'off';
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
    startUpdates();
  }

  /* ---------- Data ---------- */
  function applyItems(items, workloads) {
    const json = JSON.stringify([items, workloads]);
    if (json === state.lastJSON) { renderSide(); return; }
    state.lastJSON = json;
    state.nodes = items;
    if (workloads) state.workloads = workloads;
    if (!state.nodes.some(n => n.name === state.sel)) state.sel = state.nodes.length ? state.nodes[0].name : null;
    render();
  }

  async function refresh() {
    try {
      const [data, wl] = await Promise.all([api('/api/gpunodes'), api('/api/workloads').catch(() => ({ items: [] }))]);
      applyItems((data && data.items) || [], (wl && wl.items) || []);
    } catch (e) {
      handleError(e);
    }
  }

  function handleError(e) {
    if (e.status === 401) { showLogin(t('sessionEnded')); return; }
    if (e.status === 403 || e.status === 404) {
      renderHeader();
      showEmpty(e.status === 403 ? t('noAccess') : t('notInstalled'), esc(e.message));
      return;
    }
    setMsg(e.message, true);
  }

  // Live updates through server-sent events. If the browser cannot keep the
  // stream open, the dashboard falls back to polling.
  function startUpdates() {
    stopUpdates();
    if (!window.EventSource) { startPolling(); return; }
    const es = new EventSource('/api/gpunodes/events');
    state.events = es;
    let failures = 0;
    es.addEventListener('gpunodes', e => {
      failures = 0;
      if (state.live !== 'live') { state.live = 'live'; renderHeader(); }
      try { const d = JSON.parse(e.data); applyItems(d.items || [], d.workloads || []); } catch { /* ignore a broken event */ }
    });
    es.onerror = async () => {
      failures++;
      state.live = 'reconnecting';
      renderHeader();
      try {
        await api('/api/session');
      } catch (err) {
        if (err.status === 401) { showLogin(t('sessionEnded')); return; }
      }
      if (failures >= 3) { es.close(); state.events = null; startPolling(); }
    };
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.live = 'polling';
    renderHeader();
    state.timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }

  function stopUpdates() {
    if (state.events) state.events.close();
    state.events = null;
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
        ? (pods.length ? t('msgReservedHeld', gpu.index, node.name, podName(pods[0])) : t('msgReserved', gpu.index, node.name))
        : t('msgReleased', gpu.index, node.name));
    } catch (e) {
      if (e.status === 401) { showLogin(t('sessionEnded')); return; }
      setMsg(t('msgFailed', gpu.index, e.message), true);
    } finally {
      state.busy.delete(uuid);
      render();
      // Without the event stream, fetch the state the node agent reports.
      if (!state.events) setTimeout(refresh, 1200);
    }
  }

  async function setWorkloadState(key, target) {
    const [ns, name] = key.split('/');
    state.wlBusy.add(key);
    render();
    try {
      await api(`/api/workloads/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/state`, { method: 'PUT', body: { state: target } });
      setMsg(t('msgWorkload', key, target));
    } catch (e) {
      if (e.status === 401) { showLogin(t('sessionEnded')); return; }
      setMsg(t('msgWorkloadFailed', key, e.message), true);
    } finally {
      state.wlBusy.delete(key);
      state.lastJSON = '';
      if (!state.events) setTimeout(refresh, 1500);
      render();
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

  $('lang').addEventListener('click', () => {
    lang = lang === 'de' ? 'en' : 'de';
    num = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
    storage.set('kybernate-lang', lang);
    applyStaticTexts();
    state.msg = '';
    render();
  });

  $('app').addEventListener('click', e => {
    const nodeBtn = e.target.closest('[data-node]');
    if (nodeBtn) { state.sel = nodeBtn.dataset.node; setMsg(''); render(); return; }
    const wlBtn = e.target.closest('[data-wl]');
    if (wlBtn) { setWorkloadState(wlBtn.dataset.wl, wlBtn.dataset.state); return; }
    const wlCard = e.target.closest('[data-wl-node]');
    if (wlCard && wlCard.dataset.wlNode && state.nodes.some(n => n.name === wlCard.dataset.wlNode)) { state.sel = wlCard.dataset.wlNode; render(); return; }
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) { state.view = viewBtn.dataset.view; render(); }
  });

  $('app').addEventListener('change', e => {
    const input = e.target.closest('[data-uuid]');
    if (input) setReservation(input.dataset.uuid, input.checked);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.session && !state.events) refresh();
  });

  /* ---------- Start ---------- */
  applyStaticTexts();
  (async () => {
    try {
      state.session = await api('/api/session');
      await showApp();
    } catch (e) {
      showLogin(e.status === 401 ? '' : e.message);
    }
  })();
})();
