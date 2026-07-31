// ==UserScript==
// @name         ROE
// @namespace    roe.spawntracker
// @version      7.44.0
// @description  Tracks mob spawns; auto-syncs inventory on quickbar desync, resources and marketplace listings. Toolbar-only mode: clicking tab buttons opens/closes floating panels. Panel positions saved across sessions. Batch notifications: multiple ready alerts collapsed into one summary toast. Auto-loads a pre-explored minimap (maze/mines/forest) from GitHub on first run.
// @match        https://embervault.ruyui.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      coinmarketcap.com
// @connect      api.coinmarketcap.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ─── Built-in minimap auto-seed (loaded from GitHub) ───────────────────────
  // On first run only, fetches maps.json (pre-explored trail/entries/stairs
  // for maze/mines/minesLower/forest) from the same repo this script is
  // hosted in, and writes it into the same localStorage keys the rest of the
  // script already reads (roeMazeTrail, roeMazeEntries, etc — see
  // ROE_SEED_KEY_MAP below). Never overwrites a key the user already has
  // data in, and never runs again after the first successful (or attempted)
  // pass, so re-walking your own trail later is never clobbered.
  //
  // EDIT THIS URL to point at the raw maps.json in your GitHub repo, e.g.
  // https://raw.githubusercontent.com/<user>/<repo>/main/maps.json
  const ROE_SEED_MAPS_URL = 'https://raw.githubusercontent.com/MrSnorch/RoE-Tracker/refs/heads/main/maps.json';

  const ROE_SEED_KEY_MAP = [
    ['maze',       { trail: 'roeMazeTrail',       entries: 'roeMazeEntries', stairs: 'roeMazeStairs', stairsBlacklist: 'roeMazeStairsBlacklist' }],
    ['mines',      { trail: 'roeMinesTrail' }],
    ['minesLower', { trail: 'roeMinesLowerTrail' }],
    ['forest',     { trail: 'roeForestTrail',     entry: 'roeForestEntry',   dungeonEntries: 'roeForestDungeonEntries' }],
  ];

  function _applySeedData(data) {
    try {
      for (const [group, keys] of ROE_SEED_KEY_MAP) {
        const groupData = data[group];
        if (!groupData) continue;
        for (const field in keys) {
          const lsKey = keys[field];
          const value = groupData[field];
          if (value === undefined) continue;
          if (localStorage.getItem(lsKey) !== null) continue; // don't clobber existing user data
          const toStore = typeof value === 'string' ? value : JSON.stringify(value);
          localStorage.setItem(lsKey, toStore);
        }
      }
    } catch (_) { /* best-effort */ }
  }

  (function seedBuiltInMapsFromGitHub() {
    try {
      if (localStorage.getItem('roeSeedApplied') === '1') return;
      if (!ROE_SEED_MAPS_URL || ROE_SEED_MAPS_URL.indexOf('<user>') !== -1) return; // not configured yet
      if (typeof GM_xmlhttpRequest === 'undefined') return;
      GM_xmlhttpRequest({
        method: 'GET',
        url: ROE_SEED_MAPS_URL,
        onload: function (res) {
          let applied = false;
          try {
            if (res.status >= 200 && res.status < 300) {
              const data = JSON.parse(res.responseText);
              _applySeedData(data);
              applied = true;
            }
          } catch (_) { /* ignore malformed response */ }
          try { localStorage.setItem('roeSeedApplied', '1'); } catch (_) {}
          // The rest of the script already read the (empty) trail keys
          // synchronously before this async response came back, so a single
          // reload is needed for the freshly-seeded data to actually show up
          // on the minimap. Only happens once, on first install.
          if (applied) { try { location.reload(); } catch (_) {} }
        },
        onerror: function () {
          // Network hiccup — don't set the flag, so it retries on next reload
          // instead of permanently giving up on a blank minimap.
        },
      });
    } catch (_) { /* seeding is best-effort; never block script init */ }
  })();

  // Set by initOverlayScrollbars() below; called from every drag/resize
  // mousemove handler so the overlay scrollbar track/thumb stay glued to
  // their content element instead of lagging behind on the 400ms poll
  // (which is what made the scrollbar visibly "detach" while the window
  // was being dragged).
  let _ovScrollRefresh = null;

  // ─── State ───────────────────────────────────────────────────────────────────
  let prevEnemies = {};
  let knownTypes  = new Set();
  let knownZones  = new Set();

  let lastStateByZone     = {};
  let lastResourcesByZone = {};
  let knownResNames       = new Set();

  // ─── Tracking ────────────────────────────────────────────────────────────────
  let trackedResources          = new Map();
  let trackedMobs               = new Map();
  let trackIdCounter            = 0;
  let previousTrackedStates     = new Map();
  let previousTrackedMobStates  = new Map();

  // Per-node ready state, keyed as `${trackId}:${nodeKey}` (nodeKey = mob id
  // or resource idx). Lets us fire one notification per individual spawn
  // point instead of only reacting to the group's aggregate readyCount —
  // farming multiple spawn points of the same tracked entry no longer causes
  // one point's respawn to mask another's, and there's no cooldown gate on
  // this path (each point notifies independently, every time it goes
  // not-ready → ready).
  let previousNodeReadyState    = new Map();

  // ─── Track display order (drag-and-drop reordering) ──────────────────────────
  let _trackDisplayOrder = {}; // id → display index
  let _dragTrackId   = null;   // id or array of ids being dragged
  let _dragTrackKind = null;   // 'mob' | 'res'
  let _dragTrackZone = null;
  let _fp_track      = null;   // active render target for track pane (module-level for compact access)
  let _trackFullOpen = false;  // true while the ⚙️-opened full Track view (settings/manage) is showing
  let _qbFullOpen = localStorage.getItem('roeQBFullOpen') === '1'; // true while the ⚙️-opened full Durability view (settings/manage) is showing — persisted across reloads
  const QB_FULL_WIDTH  = 350;
  const QB_FULL_HEIGHT = 600;
  const QB_FULL_SIZE_STORAGE_KEY = 'roeQBFullSize';
  function saveQBFullSize(w, h) {
    try { localStorage.setItem(QB_FULL_SIZE_STORAGE_KEY, JSON.stringify({ width: w, height: h })); } catch (_) {}
  }
  function loadQBFullSize() {
    try {
      const raw = localStorage.getItem(QB_FULL_SIZE_STORAGE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.width === 'number' && typeof p.height === 'number') return p;
    } catch (_) {}
    return null;
  }
  // Compact-view name-column width cache — must be initialized this early
  // (before float panels are restored from a previous session, see
  // 'restoring float tabs' below) or the QB floating panel's very first
  // paint would see this as 0/undefined and start at width:auto, then jump
  // to the real fitted width a moment later once renderQBPane runs.
  var _qbNameMeasureCanvas   = null;
  var _qbCompactNameColWidth = (() => {
    const v = parseFloat(localStorage.getItem('roeQBCompactNameColWidth'));
    return isNaN(v) ? 0 : v;
  })(); // px — widest label seen so far (persisted across reloads so the compact panel doesn't jump/resize as new items are seen)
  var QB_NAME_COL_FONT   = '13px monospace';
  var QB_NAME_COL_BUFFER = 16; // extra px for the " ✋" active-weapon marker

  // ─── Point-to-target overlay (click a mob/resource dot in Track to aim at it) ──
  let _pointerTarget = null; // { zone, x, y, label, key } or null
  const POINTER_REACHED_RADIUS = 3; // world units — pointer target auto-clears once the player gets this close
  // Death-drop route is tracked completely separately from the manual
  // pointer-arrow target — previously both shared _pointerTarget, so setting
  // a manual waypoint after dying silently overwrote (and lost) the route
  // back to your own dropped runes. Kept in its own variable/render path so
  // the two can coexist: a manual waypoint no longer clobbers the death-drop
  // marker, and vice versa.
  let _deathDropTarget = null; // { zone, x, y, label, key } or null
  function _pointerKey(zone, pos) { return `${zone}::${pos.x.toFixed(2)}::${pos.y.toFixed(2)}`; }
  // Populated once per renderMazeMap() frame with every mob/resource marker's
  // screen position + label, so the canvas mousemove handler can hit-test
  // against it and show a hover tooltip without redoing any zone/world math.
  const _mazeMapHoverMarkers = []; // [{ x, y, r, label, sub }]
  let _mazeMapOffscreenDropArrows = []; // [{ x, y, r, drop, cluster, color }] — clickable edge-arrows for world drops, rebuilt each render
  let _edgeArrowCandidates = []; // [{ pos:{x,y}, color, kind, meta }] — every marker eligible for an edge arrow, collected during this render then clustered/drawn once at the end
  // One-directional hysteresis for how many leading (near-player) route
  // waypoints get dropped from the drawn dashed line — see the drop-count
  // logic in mazeMapTick. Keyed to the current pointer target so a fresh
  // target starts clean; the count itself only ever grows within that
  // target, never shrinks back down on its own, which is what stops the
  // line's start from visibly jittering as the interpolated player dot
  // drifts back and forth across the drop radius from frame to frame.
  let _pointerDropHysteresisRef = { value: { key: null, count: 0 } };
  let _deathDropDropHysteresisRef = { value: { key: null, count: 0 } };
  let _pointerPinScreenPos = null; // { x, y } of the manual waypoint pin's tip, last render, for click hit-testing
  let _deathDropPinScreenPos = null; // same, for the death-drop pin


  // ─── Resource respawn timers ─────────────────────────────────────────────────
  const resourceRespawnTimers = new Map();

  // Timers are keyed as `${globalIdx}:${resourceNodeId}`, where resourceNodeId
  // is a per-tree-type constant from the server (blackoak=1, ironwood=5,
  // godwood=3, etc — NOT always 0). Code that only knows the node's idx (not
  // its resourceNodeId) must search all keys for that idx via getNodeMaxTimer
  // rather than assuming `${idx}:0` — a hardcoded ":0" silently misses every
  // resource type whose id isn't 0, making the node look like it has no
  // active timer even while it's on cooldown.

  // ─── Enemy respawn timers ─────────────────────────────────────────────────────
  const enemyRespawnTimers = new Map();

  // ─── Stable (position-keyed) timers — survive session ID changes on reload ───
  // Mob key:      "zone|statsKey|roundedX|roundedY" (statsKey is stable for mobs)
  // Resource key: "zone|roundedX|roundedY"          (no resource name — slot may alternate between variants)
  let _stableMobTimers = {}; // posKey → respawnAt (ms epoch)
  let _stableResTimers = {}; // posKey → { expiresAt: ms, diedResource: string }

  function _mobPosKey(zone, statsKey, pos) {
    return `${zone}|${statsKey}|${Math.round(pos.x)}|${Math.round(pos.y)}`;
  }
  function _resPosKey(zone, pos) {
    return `${zone}|${Math.round(pos.x)}|${Math.round(pos.y)}`;
  }
  function _saveStableMobTimers() {
    try { localStorage.setItem(STABLE_MOB_TIMERS_KEY, JSON.stringify(_stableMobTimers)); } catch (_) {}
  }
  function _saveStableResTimers() {
    try { localStorage.setItem(STABLE_RES_TIMERS_KEY, JSON.stringify(_stableResTimers)); } catch (_) {}
  }
  function _loadStableTimers() {
    try {
      const m = localStorage.getItem(STABLE_MOB_TIMERS_KEY);
      const r = localStorage.getItem(STABLE_RES_TIMERS_KEY);
      if (m) _stableMobTimers = JSON.parse(m);
      if (r) _stableResTimers = JSON.parse(r);
      // Prune expired entries
      const now = Date.now();
      Object.keys(_stableMobTimers).forEach(k => { if (_stableMobTimers[k] <= now) delete _stableMobTimers[k]; });
      Object.keys(_stableResTimers).forEach(k => { if ((_stableResTimers[k]?.expiresAt ?? 0) <= now) delete _stableResTimers[k]; });
    } catch (_) {}
  }

  // ─── Respawn duration learning ────────────────────────────────────────────────
  // Records the wall-clock time at which we saw each entity killed via
  // combat_hit_ack, so that the next spawn_state can teach us the respawn
  // window for that statsKey.  Also caches learned durations for instant
  // timer display on future kills of the same mob type.
  const _recentKillTimes    = new Map(); // entity.id → Date.now() at kill moment
  const knownRespawnDurations = new Map(); // statsKey  → duration ms

  // ─── Resource respawn duration learning ──────────────────────────────────────
  // Learned from slots where server provides cooldownExpiresAt + we tracked deathTime.
  // Used to estimate timers for variant slots where cooldownExpiresAt is absent.
  const knownResDurations = new Map(); // resource name → duration ms
  const _slotDeathTimes   = {};        // posKey → { deathTime: ms, resource: string|null }
  const _estimatedEnemyTimers = new Set(); // entity IDs whose timer is estimated (not from server)

  // ─── Inventory / quickbar state ──────────────────────────────────────────────
  let _inventoryBySlot     = {};       // slot (number) → itemId (string)
  let _quickBarInstancesFromInv = []; // QuickBarInstances array from last inventory event
  let _inventoryByInstance = {};       // instanceId (string) → { itemId, Level, Durability, MaxDurability, Quantity }
  let _inventorySlotByInstance = {};   // instanceId (string) → slot (number) — needed for quickbar_set restore
  let _quickbarRefs    = new Map(); // quickbar SlotId (number) → RefInstanceId (string)
  let _equippedWeaponInstanceId = null; // equippedWeaponInstanceId from InventoryDetails
  const _knownItemIdByInstance = new Map(); // instanceId → itemId, persists across inventory snapshot wipes
                                              // (quickselect can reference an instanceId the next
                                              // inventory snapshot hasn't caught up to yet)
  let _runestoneQty    = null;     // null = not yet seen, number = quantity
  // Tracks our own unclaimed death-drop specifically (not just "rune balance
  // is 0") so the warning banner reflects "you died and your runes are still
  // on the ground", and clears only when that exact dropId is picked up.
  let _pendingDeathDrop = null;    // { dropId, quantity } or null
  let _chestItems = [];      // merged chest/storage items [{itemId, quantity, slots}], persisted (see below)
  let _chestLastAt = 0;
  let _inventoryReady  = false;    // true after first inventory event
  let _quickbarReady   = false;    // true after first quickselect event
  let _qbDesyncActive  = false;    // true while desired QB differs from quickselect
  let _qbActionAt      = 0;        // last quickbar_set timestamp
  let _lastEquipAt     = 0;        // last inventory_equip — server needs time to send updated quickselect
  let _lastInventoryAt = 0;        // ts of last 'inventory' event — a fresh inventory snapshot is trustworthy
                                    // even if it wasn't triggered by our own action (e.g. zone load / reconnect),
                                    // so the very next quickselect shouldn't distrust it and flip back to "Loading..."
  const _qbEventLog    = [];       // [{ts, type, detail}] shown in QB pane
  const QB_EVENT_LOG_MAX = 100;

  let _qbDesired = new Map(); // SlotId → instanceId — desired QB state set by user via quickbar_set

  // ─── Durability / inventory persistence — survive page reloads ───────────────
  // Mirrors the current inventory + quickbar snapshot to localStorage so the
  // Durability panel can show last-known item/durability data immediately on
  // page load, before the server sends fresh 'inventory'/'quickselect' events
  // (which remain authoritative and simply overwrite this cache once they arrive).
  const QB_INVENTORY_STORAGE_KEY = 'roeQBInventoryState';
  function _saveQBInventoryState() {
    try {
      localStorage.setItem(QB_INVENTORY_STORAGE_KEY, JSON.stringify({
        inventoryBySlot:          _inventoryBySlot,
        inventoryByInstance:      _inventoryByInstance,
        inventorySlotByInstance:  _inventorySlotByInstance,
        quickBarInstancesFromInv: _quickBarInstancesFromInv,
        quickbarRefs:             Array.from(_quickbarRefs.entries()),
        equippedWeaponInstanceId: _equippedWeaponInstanceId,
        runestoneQty:             _runestoneQty,
        pendingDeathDrop:         _pendingDeathDrop,
        chestItems:               _chestItems,
        chestLastAt:              _chestLastAt,
      }));
    } catch (_) {}
  }
  function _loadQBInventoryState() {
    try {
      const raw = localStorage.getItem(QB_INVENTORY_STORAGE_KEY);
      if (!raw) return;
      const st = JSON.parse(raw);
      if (st.inventoryBySlot)                 _inventoryBySlot = st.inventoryBySlot;
      if (st.inventoryByInstance)              _inventoryByInstance = st.inventoryByInstance;
      if (st.inventorySlotByInstance)          _inventorySlotByInstance = st.inventorySlotByInstance;
      if (Array.isArray(st.quickBarInstancesFromInv)) _quickBarInstancesFromInv = st.quickBarInstancesFromInv;
      if (Array.isArray(st.quickbarRefs))      _quickbarRefs = new Map(st.quickbarRefs);
      if (st.equippedWeaponInstanceId !== undefined)  _equippedWeaponInstanceId = st.equippedWeaponInstanceId;
      if (st.runestoneQty !== undefined)       _runestoneQty = st.runestoneQty;
      if (st.pendingDeathDrop !== undefined)   _pendingDeathDrop = st.pendingDeathDrop;
      if (Array.isArray(st.chestItems))        _chestItems = st.chestItems;
      if (st.chestLastAt !== undefined)        _chestLastAt = st.chestLastAt;
      // Show the restored snapshot right away; real events overwrite it as they arrive.
      if (Object.keys(_inventoryByInstance).length > 0) _inventoryReady = true;
      if (_quickbarRefs.size > 0) _quickbarReady = true;
    } catch (_) {}
  }
  _loadQBInventoryState();

  function checkQBDesync() {
    if (!_inventoryReady || !_quickbarReady) return;
    const mismatches = [];
    for (const [slotId, instanceId] of _qbDesired) {
      const qsInstance = _quickbarRefs.get(slotId) ?? null;
      if (qsInstance !== instanceId) {
        const desiredItem = (_inventoryByInstance[instanceId]  || {}).itemId ?? instanceId;
        const qsItem      = qsInstance ? ((_inventoryByInstance[qsInstance] || {}).itemId ?? qsInstance) : 'empty';
        const display = slotId === 9 ? 0 : slotId + 1;
        mismatches.push(`slot${display}: desired=${desiredItem} ≠ qs=${qsItem}`);
      }
    }
    const isDesync = mismatches.length > 0;
    if (isDesync && !_qbDesyncActive) {
      _qbDesyncActive = true;
      addSysLog('QB_DESYNC', { mismatches });
      _qbEventLog.push({ ts: Date.now(), type: 'desync', detail: mismatches.join(', ') });
      if (_qbEventLog.length > QB_EVENT_LOG_MAX) _qbEventLog.shift();
    } else if (!isDesync && _qbDesyncActive) {
      _qbDesyncActive = false;
      addSysLog('QB_SYNC', {});
      _qbEventLog.push({ ts: Date.now(), type: 'sync', detail: 'resolved' });
      if (_qbEventLog.length > QB_EVENT_LOG_MAX) _qbEventLog.shift();
    }
    if (activeTab === 'qb' || _poppedOut.has('qb')) renderQBPane();
    if (activeTab === 'chest' || _poppedOut.has('chest')) renderChestPane();
  }

  function isGatheringTool(itemId) {
    return /(axe|pick|shovel|hatchet|scythe)/.test(String(itemId).toLowerCase());
  }

  function isWeaponItem(itemId) {
    return /(sword|blade|dagger|spear|bow|staff|mace|club|lance)/.test(String(itemId).toLowerCase());
  }

  function isToolItem(itemId) {
    return isGatheringTool(itemId) || isWeaponItem(itemId);
  }

  // Splits a lowercase run-together item name into Title Case words.
  // e.g. "crystalshortsword" → "Crystal Short Sword"
  //      "titaniumpickaxe"   → "Titanium Pickaxe"
  //      "blackoaktree"      → "Black Oak Tree"
  const _FMT_WORDS = [
    // materials / prefixes (longer first to win greedy match)
    'titanium','crystal','bronze','copper','silver','golden','gold','iron',
    'black','blood','dread','shadow','mist','moon','god','cinder','bronzewood',
    'ironwood','dreadwood','godwood','goldleaf','silverleaf','bloodroot',
    'cinderheartree','cinderheart',
    // weapon types — no compound *sword entries so they split to e.g. "Short Sword"
    'sword',
    'pickaxe','hatchet','scythe','shovel','axe',
    'dagger','spear','lance','staff','mace','club','blade','bow',
    'short','long','great',
    // resource node components (split to "Ore Node" etc.)
    'ore','rock','node','bones',
    // tree / plant
    'woodtree','leaftree',
    'wood','tree','leaf','vine','flower','weed','petal','lily','bane','witch',
    'root','heart','oak',
    // misc
    'mourning','rune','stone','runestone',
    'dino',
  ].sort((a, b) => b.length - a.length); // longest first

  function formatItemId(raw) {
    if (!raw) return raw;
    let s = String(raw).toLowerCase();
    const parts = [];
    while (s.length > 0) {
      let matched = false;
      for (const w of _FMT_WORDS) {
        if (s.startsWith(w)) {
          parts.push(w.charAt(0).toUpperCase() + w.slice(1));
          s = s.slice(w.length);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Unknown segment: consume up to next known word boundary or end
        let end = 1;
        while (end < s.length) {
          const rest = s.slice(end);
          if (_FMT_WORDS.some(w => rest.startsWith(w))) break;
          end++;
        }
        const seg = s.slice(0, end);
        parts.push(seg.charAt(0).toUpperCase() + seg.slice(1));
        s = s.slice(end);
      }
    }
    return parts.join(' ');
  }

  function getToolsNotInQuickbar() {
    const missing = [];
    // instanceId → itemId, seeded from the (possibly stale) inventory snapshot,
    // merged with anything we've ever learned so quickbar-referenced instances
    // that arrived after the last inventory snapshot are still recognized as tools.
    const allKnown = new Map(_knownItemIdByInstance);
    Object.entries(_inventoryByInstance).forEach(([instanceId, item]) => {
      allKnown.set(instanceId, item.itemId);
    });
    allKnown.forEach((itemId, instanceId) => {
      if (!isToolItem(itemId)) return;
      // Check if this instance is referenced by any quickbar slot
      const isInQuickbar = Array.from(_quickbarRefs.values()).includes(instanceId);
      if (!isInQuickbar && instanceId !== _equippedWeaponInstanceId) missing.push(itemId);
    });
    return missing;
  }

  function repositionWarnings() {
    const ids = ['roeClaimWarn', 'roeRunestoneWarn', 'roeToolWarn'];
    let nextTop = 15;
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.style.display === 'none') return;
      el.style.top = nextTop + 'px';
      nextTop += (el.offsetHeight || 44) + 8;
    });
  }

  function updateToolWarning() {
    if (!_domReady) return;
    const el = document.getElementById('roeToolWarn');
    if (!el) return;
    const missing = getToolsNotInQuickbar();
    if (missing.length === 0) {
      el.style.display = 'none';
    } else {
      const counts = {};
      missing.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
      const parts = Object.entries(counts).map(([id, n]) => n > 1 ? `${formatItemId(id)} x${n}` : formatItemId(id));
      el.textContent = '⚠️ Tools not in quickbar: ' + parts.join(', ');
      el.title = 'Tools not in quickbar:\n' + parts.join('\n');
      el.style.display = 'block';
    }
    repositionWarnings();
    // ─ Check for broken tools (Durability=0) on inventory load ─
    // Toast only for the currently equipped item (gold slot)
    const _durEl = document.getElementById('roeDurWarn');
    if (_durEl && _equippedWeaponInstanceId) {
      const item = _inventoryByInstance[_equippedWeaponInstanceId];
      if (item && item.MaxDurability > 0 && item.Durability === 0) {
        // Only re-trigger the toast when this instance just became the broken
        // one — otherwise every inventory/quickselect update while it stays
        // broken would restart the 3s timer and re-flash the toast.
        if (_lastBrokenToastInstanceId !== item.instanceId) {
          _lastBrokenToastInstanceId = item.instanceId;
          const msg = `🔴 ${formatItemId(item.itemId)} BROKEN!`;
          _showDurBrokenMsg(_durEl, msg);
          notifyTrack(null, msg);
        }
      } else {
        _lastBrokenToastInstanceId = null;
      }
    }
  }

  function updateRunestoneWarning() {
    if (!_domReady) return;
    const el = document.getElementById('roeRunestoneWarn');
    if (!el) return;
    // Driven by _pendingDeathDrop (set on player_death, cleared only when
    // that exact dropId comes back via pickup_death_drop_ack) rather than
    // "rune balance == 0" — the old rule fired for any zero balance (e.g.
    // just spent all runes) and could clear itself early if runes arrived
    // from an unrelated source (market buy) while the death drop still sat
    // on the ground.
    if (_pendingDeathDrop) {
      el.textContent = '⚠️ Pick up your Runes!';
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
    repositionWarnings();
  }

  // ─── Claim status ─────────────────────────────────────────────────────────────
  const CLAIM_API_URL = 'https://roe-prod-20fe6d199715.herokuapp.com/api/ruyui-nfts/my-nfts';
  let _claimAuthToken = localStorage.getItem('roeClaimAuthToken') || null;
  const _savedNextClaimAt = localStorage.getItem('roeNextClaimAt');
  let _nextClaimAt = _savedNextClaimAt ? new Date(_savedNextClaimAt) : null;
  if (_nextClaimAt && isNaN(_nextClaimAt.getTime())) _nextClaimAt = null; // guard against Invalid Date
  let _claimEmoji = localStorage.getItem('roeClaimEmoji');
  if (!_claimEmoji || (_claimEmoji !== '✓' && _nextClaimAt && _nextClaimAt > new Date())) {
    _claimEmoji = (_nextClaimAt && _nextClaimAt > new Date()) ? '✓' : '…';
    try { localStorage.setItem('roeClaimEmoji', _claimEmoji); } catch (_) {}
  }
  console.log('[ROE claim] restored on load — emoji:', _claimEmoji, '| nextClaimAt:', _nextClaimAt, '| raw saved:', _savedNextClaimAt);
  let _domReady       = false;
  let _socketReady    = false;

  // ─── Player position (from OUT move events) ───────────────────────────────────
  let _playerPos = null; // { x, y } or null

  // ─── Mine maze exit tracking ───────────────────────────────────────────────────
  // Mines/MinesLower share the same coordinate space (position is continuous across
  // the zone-label flip), so remembering the spot where we walked in from Town is
  // enough to always point back the way we came, even after diving into MinesLower.
  const MAZE_ZONES = new Set(['Mines', 'MinesLower']);
  const MAZE_GROUP_LABEL = 'Mines/MinesLower';
  // ─── Minimap Auto behavior for Mines/MinesLower ────────────────────────
  // Auto always shows whichever level (Mines or MinesLower) the player is
  // actually standing in — no separate combined/split toggle needed. The
  // combined view (one map spanning both levels) is still available, just
  // by picking "Mines (Combined)" manually from the map dropdown instead of
  // a dedicated button. Both trails (combined + each split level) are always
  // recorded in parallel regardless of which one is currently displayed, so
  // switching between Auto and manual Combined never loses progress.
  // Track-pane display grouping: Mines and MinesLower are shown together under
  // one combined header since they're really the same physical space.
  function _trackZoneGroup(zone) { return MAZE_ZONES.has(zone) ? MAZE_GROUP_LABEL : zone; }
  function _trackZoneGroupRealZones(group) { return group === MAZE_GROUP_LABEL ? Array.from(MAZE_ZONES) : [group]; }
  // Every distinct entry/exit point into the maze from Town/Forest, and every
  // distinct Mines<->MinesLower staircase point (the maze can have more than
  // one physical door and more than one staircase). Deduped by proximity so
  // walking the same door/staircase repeatedly doesn't pile up near-duplicate
  // points — points within GATE_DEDUP_DIST world units are treated as the
  // same gate.
  const GATE_DEDUP_DIST = 15; // crossing the entry tile at slightly different spots on each trip
  // (e.g. re-entering Mines from Forest) previously piled up near-duplicate
  // white squares at the tight 5-unit tolerance — same underlying noise the
  // staircase detector already accounts for at 15 units, see STAIRS_DEDUP_DIST.
  // Staircase tiles have some physical width, so crossing them at different
  // spots on different trips lands further apart than a simple door does —
  // use a wider dedup radius than GATE_DEDUP_DIST to cut down on duplicates
  // in the first place (on top of the blacklist below).
  const STAIRS_DEDUP_DIST = 15;
  // Preview flip: once the player's (client-side, pre-server-confirm)
  // position has stayed within this radius of a known staircase for
  // STAIRS_PREVIEW_DWELL_MS, the split minimap switches to the *other*
  // level immediately instead of waiting for the server's spawn_state to
  // confirm the zone actually changed. Cleared either when the real zone
  // change arrives (handleSpawnState) or when the player steps back out of
  // this radius without ever crossing.
  const STAIRS_PREVIEW_TRIGGER = 5;
  // Player must stand within STAIRS_PREVIEW_TRIGGER continuously for this
  // long before the preview actually flips — a brief pass-through near a
  // staircase (e.g. walking past on the way elsewhere) shouldn't trigger it.
  const STAIRS_PREVIEW_DWELL_MS = 1000;
  let _stairsPreviewDwellStart = null; // ms timestamp player entered the trigger radius, or null
  // Real position samples right at a staircase can jitter/teleport back and
  // forth (server-side rubber-banding at the doorway), which would otherwise
  // flip the preview on/off rapidly and yank the camera with it. Once the
  // preview toggles, further toggles are ignored for this long.
  const STAIRS_PREVIEW_HOLD_MS = 2000;
  let _lastFlipToggleAt = 0;
  let _pendingSplitFlip = null; // null | 'mines' | 'minesLower'
  // Right after a fresh entry into the maze, the player can spawn close to an
  // already-known staircase without intending to use it — so the preview is
  // disarmed on entry and only re-armed once they've walked far enough away
  // from every known staircase. Only then can approaching one trigger a flip.
  let _stairsPreviewArmed = true;
  function _updateStairPreviewFlip() {
    if (!_minimapSettings.stairsPreview || !MAZE_ZONES.has(_currentZone) || !_playerPos || !_mazeStairs.length) {
      _pendingSplitFlip = null;
      _stairsPreviewDwellStart = null;
      return;
    }
    const realGroup = _currentZone === 'MinesLower' ? 'minesLower' : 'mines';
    const nearestDist = _mazeStairs.reduce(
      (min, s) => Math.min(min, Math.hypot(s.x - _playerPos.x, s.y - _playerPos.y)), Infinity);
    if (!_stairsPreviewArmed) {
      if (nearestDist > STAIRS_PREVIEW_TRIGGER) _stairsPreviewArmed = true;
      return;
    }
    const now = Date.now();
    if (_pendingSplitFlip) {
      if (_pendingSplitFlip === realGroup || nearestDist > STAIRS_PREVIEW_TRIGGER) {
        _pendingSplitFlip = null;
        _lastFlipToggleAt = now;
      }
    } else if (nearestDist <= STAIRS_PREVIEW_TRIGGER) {
      if (_stairsPreviewDwellStart == null) {
        _stairsPreviewDwellStart = now;
      } else if (now - _stairsPreviewDwellStart >= STAIRS_PREVIEW_DWELL_MS) {
        _pendingSplitFlip = realGroup === 'minesLower' ? 'mines' : 'minesLower';
        _lastFlipToggleAt = now;
        _stairsPreviewDwellStart = null;
      }
    } else {
      _stairsPreviewDwellStart = null;
    }
  }
  function _addUniqueGate(list, p, dist = GATE_DEDUP_DIST) {
    if (list.some(g => Math.hypot(g.x - p.x, g.y - p.y) < dist)) return false;
    list.push({ x: p.x, y: p.y });
    return true;
  }
  let _mazeEntries = []; // [{x,y}, ...]
  try {
    const savedEntries = JSON.parse(localStorage.getItem('roeMazeEntries'));
    if (Array.isArray(savedEntries)) _mazeEntries = savedEntries;
  } catch (_) {}
  // Migrate the old single-point format (roeMazeEntry) so upgrading users
  // don't lose their already-recorded entrance.
  if (_mazeEntries.length === 0) {
    try {
      const legacy = JSON.parse(localStorage.getItem('roeMazeEntry'));
      if (legacy && typeof legacy.x === 'number' && typeof legacy.y === 'number') {
        _mazeEntries.push({ x: legacy.x, y: legacy.y });
      }
    } catch (_) {}
  }
  function saveMazeEntries() {
    try { localStorage.setItem('roeMazeEntries', JSON.stringify(_mazeEntries)); } catch (_) {}
  }
  let _mazeStairs = []; // [{x,y}, ...] — Mines<->MinesLower transition points
  try {
    const savedStairs = JSON.parse(localStorage.getItem('roeMazeStairs'));
    if (Array.isArray(savedStairs)) _mazeStairs = savedStairs;
  } catch (_) {}
  function saveMazeStairs() {
    try { localStorage.setItem('roeMazeStairs', JSON.stringify(_mazeStairs)); } catch (_) {}
  }
  // Staircase detection is noisy — the staircase tile itself has some width,
  // so crossing it at slightly different spots on different trips can each
  // land >GATE_DEDUP_DIST apart and register as a "new" staircase, piling up
  // near-duplicate white squares over time. Points the user explicitly
  // deleted are remembered here so they don't just get re-detected on the
  // next crossing.
  let _mazeStairsBlacklist = []; // [{x,y}, ...]
  try {
    const savedBl = JSON.parse(localStorage.getItem('roeMazeStairsBlacklist'));
    if (Array.isArray(savedBl)) _mazeStairsBlacklist = savedBl;
  } catch (_) {}
  function saveMazeStairsBlacklist() {
    try { localStorage.setItem('roeMazeStairsBlacklist', JSON.stringify(_mazeStairsBlacklist)); } catch (_) {}
  }
  const STAIRS_BLACKLIST_DIST = 20; // world units
  function _isBlacklistedStair(p) {
    return _mazeStairsBlacklist.some(b => Math.hypot(b.x - p.x, b.y - p.y) < STAIRS_BLACKLIST_DIST);
  }

  // ─── Trail cuts ─────────────────────────────────────────────────────────
  // Manual "scissors" tool: places a marker that punches a real hole into
  // the trail's raw paint layer (before blur/threshold runs), so two
  // physically-close-but-separate passages don't get bridged solid by the
  // smoothing pass into one blob. Only visible as red dots while Edit Mode
  // is on (see roeMazeMapCutMode below) — the cut itself is a permanent,
  // always-applied effect on the baked trail regardless of Edit Mode.
  // Keyed per map group (mines/minesLower/forest/maze/custom:<zone>) since
  // cuts only make sense relative to one specific trail's pixel layer.
  const _mazeCutsByGroup = new Map(); // group -> [{x,y}, ...] (world coords)
  const _walkCutSeenByGroup = new Map(); // group -> Set of grid cell keys already cut by walk-mode, so re-walking a passage doesn't restack points
  function _walkCutSeenFor(group) {
    let s = _walkCutSeenByGroup.get(group);
    if (!s) { s = new Set(); _walkCutSeenByGroup.set(group, s); }
    return s;
  }
  function _cutsFor(group) {
    let arr = _mazeCutsByGroup.get(group);
    if (!arr) {
      arr = [];
      try {
        const saved = JSON.parse(localStorage.getItem('roeMazeCuts::' + group));
        if (Array.isArray(saved)) arr = saved;
      } catch (_) {}
      _mazeCutsByGroup.set(group, arr);
    }
    return arr;
  }
  function _saveCutsFor(group) {
    try { localStorage.setItem('roeMazeCuts::' + group, JSON.stringify(_cutsFor(group))); } catch (_) {}
  }

  // Last spot the player died in the maze — set from the real player_death
  // event (see handlePlayerDeath below).
  let _mazeDeathPoint = null; // { x, y } or null

  try {
    const savedDeath = localStorage.getItem('roeMazeDeathPoint');
    if (savedDeath) _mazeDeathPoint = JSON.parse(savedDeath);
  } catch (_) {}
  function saveMazeDeathPoint() {
    try {
      if (_mazeDeathPoint) localStorage.setItem('roeMazeDeathPoint', JSON.stringify(_mazeDeathPoint));
      else localStorage.removeItem('roeMazeDeathPoint');
    } catch (_) {}
  }

  // ─── Maze trail (accumulates into the growing minimap) ───────────────────────
  // Stored as a flat, deduplicated list of visited grid cells. Each entry is
  // one cell on a fixed MAZE_TRAIL_MIN_STEP-sized world grid, drawn as a
  // filled square (see _paintTrailRange) — walking the same routes over and
  // over just re-marks already-visited cells, and adjacent cells tile into
  // a solid revealed area with no gaps.
  const MAZE_TRAIL_MIN_STEP = 2.2;  // world units per grid cell (was 1.2 — too twitchy during combat)
  const CUT_RADIUS_WORLD = MAZE_TRAIL_MIN_STEP * 0.8; // world units punched out per cut point — sized close to one trail circle's own radius (~0.75x MAZE_TRAIL_MIN_STEP, see CELL_CIRCLE_RADIUS_FACTOR), just enough to sever a bridged neck without eating a wide swath of real trail around the click
  function _trailCellKey(p) {
    return Math.round(p.x / MAZE_TRAIL_MIN_STEP) + ',' + Math.round(p.y / MAZE_TRAIL_MIN_STEP);
  }
  // Grid used by walk-cut mode to dedupe dropped points — sized to the cut's
  // own radius (smaller than the trail's grid) so cuts still tile edge-to-
  // edge along the walked line without gaps, but don't restack on a cell
  // already cut.
  function _cutCellKey(p) {
    return Math.round(p.x / CUT_RADIUS_WORLD) + ',' + Math.round(p.y / CUT_RADIUS_WORLD);
  }
  // Move events don't always arrive one per grid cell — fast movement, combat
  // knockback, or a laggy socket can land two samples many world units apart.
  // Without this, a fast crossing would only mark the start and end cell as
  // visited, leaving every cell in between unrevealed even though the player
  // walked straight through them. This fills the straight line between
  // `from` and `to` with evenly spaced points one MIN_STEP apart, so every
  // crossed cell gets marked. Capped by TRAIL_TELEPORT_CUTOFF so genuine
  // teleports/zone entries still show up as a single isolated cell rather
  // than marking a long straight line of cells across the whole map.
  const TRAIL_TELEPORT_CUTOFF = 40; // world units
  function _stepPoints(from, to) {
    if (!from) return [to];
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist > TRAIL_TELEPORT_CUTOFF || dist <= MAZE_TRAIL_MIN_STEP) return [to];
    const steps = Math.ceil(dist / MAZE_TRAIL_MIN_STEP);
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
    return pts;
  }

  // ─── Shortest path through the explored trail ─────────────────────────────
  // Reuses the trail's own dedup grid (_trailCellKey/MAZE_TRAIL_MIN_STEP) as a
  // walkability graph — a cell is walkable if the player has actually walked
  // through it (it's in the trail's `seen` Set). A plain shortest-hop route
  // through that raw walked-cell set hugs whatever line the player happened
  // to walk (often one edge of the corridor, or a jagged combat-circling
  // path) rather than the middle of the passage. To route through the
  // center instead, each walkable cell gets a "clearance" score — its
  // distance (in cells) to the nearest un-walked cell, i.e. to the nearest
  // wall — and pathfinding is weighted to prefer high-clearance cells. Falls
  // back to null (→ straight line in the caller) if the start/end aren't
  // near explored ground or no path connects them.
  const PATH_NEIGHBOR_OFFSETS = [
    [-1, -1, Math.SQRT2], [0, -1, 1], [1, -1, Math.SQRT2],
    [-1,  0, 1],                      [1,  0, 1],
    [-1,  1, Math.SQRT2], [0,  1, 1], [1,  1, Math.SQRT2],
  ];
  const PATH_MAX_VISITED = 15000; // safety cap so an unreachable target can't search the whole map every recompute
  const PATH_CENTER_BIAS = 4; // higher = hugs the corridor center more strongly (at the cost of extra length)
  function _cellKeyToWorld(key) {
    const parts = key.split(',');
    return { x: Number(parts[0]) * MAZE_TRAIL_MIN_STEP, y: Number(parts[1]) * MAZE_TRAIL_MIN_STEP };
  }
  // Targets (mobs, doors) usually sit just off the trail center-line rather
  // than exactly on a visited cell, so search outward in a growing ring.
  function _nearestWalkableCell(worldPt, seenSet, maxRadius) {
    const gx0 = Math.round(worldPt.x / MAZE_TRAIL_MIN_STEP);
    const gy0 = Math.round(worldPt.y / MAZE_TRAIL_MIN_STEP);
    for (let r = 0; r <= maxRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only, skip already-checked interior
          const key = (gx0 + dx) + ',' + (gy0 + dy);
          if (seenSet.has(key)) return key;
        }
      }
    }
    return null;
  }
  // Multi-source BFS from every walkable cell that touches an un-walked
  // neighbor (a "wall-adjacent" cell, clearance 0) outward through the
  // walked area — standard grid distance-transform. Recomputing this from
  // scratch is O(explored cells), so it's cached per group and only redone
  // when the explored set actually grows (see _getClearanceMap below).
  function _computeClearance(seenSet) {
    const dist = new Map();
    const queue = [];
    for (const key of seenSet) {
      const commaIdx = key.indexOf(',');
      const gx = Number(key.slice(0, commaIdx)), gy = Number(key.slice(commaIdx + 1));
      let isBoundary = false;
      for (const [dx, dy] of PATH_NEIGHBOR_OFFSETS) {
        if (!seenSet.has((gx + dx) + ',' + (gy + dy))) { isBoundary = true; break; }
      }
      if (isBoundary) { dist.set(key, 0); queue.push(key); }
    }
    let head = 0;
    while (head < queue.length) {
      const key = queue[head++];
      const d = dist.get(key);
      const commaIdx = key.indexOf(',');
      const gx = Number(key.slice(0, commaIdx)), gy = Number(key.slice(commaIdx + 1));
      for (const [dx, dy] of PATH_NEIGHBOR_OFFSETS) {
        const nKey = (gx + dx) + ',' + (gy + dy);
        if (!seenSet.has(nKey) || dist.has(nKey)) continue;
        dist.set(nKey, d + 1);
        queue.push(nKey);
      }
    }
    return dist;
  }
  const _clearanceCache = {
    maze: { size: -1, map: null }, forest: { size: -1, map: null },
    mines: { size: -1, map: null }, minesLower: { size: -1, map: null },
  };
  function _getClearanceMap(group, seenSet) {
    // Custom zones aren't known ahead of time, so their cache slots are
    // created lazily here instead of being pre-listed above.
    let cache = _clearanceCache[group];
    if (!cache) { cache = { size: -1, map: null }; _clearanceCache[group] = cache; }
    if (cache.size !== seenSet.size) {
      cache.map = _computeClearance(seenSet);
      cache.size = seenSet.size;
    }
    return cache.map;
  }
  // Minimal binary min-heap for the Dijkstra frontier below — a plain
  // linear-scan "find min" would be O(n) per pop, which adds up badly once
  // the explored area gets into the thousands of cells.
  class _MinHeap {
    constructor() { this.arr = []; }
    get size() { return this.arr.length; }
    push(key, priority) {
      this.arr.push({ key, priority });
      let i = this.arr.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.arr[p].priority <= this.arr[i].priority) break;
        [this.arr[p], this.arr[i]] = [this.arr[i], this.arr[p]];
        i = p;
      }
    }
    pop() {
      const top = this.arr[0];
      const last = this.arr.pop();
      if (this.arr.length > 0) {
        this.arr[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = i * 2 + 2;
          let smallest = i;
          if (l < this.arr.length && this.arr[l].priority < this.arr[smallest].priority) smallest = l;
          if (r < this.arr.length && this.arr[r].priority < this.arr[smallest].priority) smallest = r;
          if (smallest === i) break;
          [this.arr[i], this.arr[smallest]] = [this.arr[smallest], this.arr[i]];
          i = smallest;
        }
      }
      return top;
    }
  }
  function _findMazePath(startWorld, endWorld, seenSet, clearance) {
    const startKey = _nearestWalkableCell(startWorld, seenSet, 4);
    const endKey   = _nearestWalkableCell(endWorld, seenSet, 4);
    if (!startKey || !endKey) return null;
    if (startKey === endKey) return [_cellKeyToWorld(startKey)];
    const endComma = endKey.indexOf(',');
    const egx = Number(endKey.slice(0, endComma)), egy = Number(endKey.slice(endComma + 1));
    // Octile-distance heuristic — admissible since every real step costs at
    // least its plain grid length (the clearance multiplier is always >= 1)
    // — turns this from plain Dijkstra (expands evenly in every direction
    // until it happens to hit the target) into A* (fans out toward it).
    // With explored areas in the thousands of cells this is the difference
    // between a full-area flood fill and a search that stays close to the
    // straight line, which is what showed up as 250-450ms hitches on
    // stair-graph rebuilds and maze-crossing route recomputes.
    const _heuristic = (gx, gy) => {
      const dx = Math.abs(gx - egx), dy = Math.abs(gy - egy);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const best = new Map([[startKey, 0]]);
    const cameFrom = new Map([[startKey, null]]);
    const visited = new Set();
    const heap = new _MinHeap();
    const startComma = startKey.indexOf(',');
    heap.push(startKey, _heuristic(Number(startKey.slice(0, startComma)), Number(startKey.slice(startComma + 1))));
    while (heap.size > 0) {
      const { key } = heap.pop();
      if (visited.has(key)) continue;
      visited.add(key);
      if (visited.size > PATH_MAX_VISITED) return null;
      if (key === endKey) break;
      const g = best.get(key);
      const commaIdx = key.indexOf(',');
      const gx = Number(key.slice(0, commaIdx)), gy = Number(key.slice(commaIdx + 1));
      for (const [dx, dy, stepLen] of PATH_NEIGHBOR_OFFSETS) {
        const nKey = (gx + dx) + ',' + (gy + dy);
        if (visited.has(nKey) || !seenSet.has(nKey)) continue;
        const nClearance = clearance.get(nKey) || 0;
        const stepCost = stepLen * (1 + PATH_CENTER_BIAS / (nClearance + 1));
        const nd = g + stepCost;
        if (!best.has(nKey) || nd < best.get(nKey)) {
          best.set(nKey, nd);
          cameFrom.set(nKey, key);
          heap.push(nKey, nd + _heuristic(gx + dx, gy + dy));
        }
      }
    }
    if (!cameFrom.has(endKey)) return null; // unreachable through explored area
    const path = [];
    let cur = endKey;
    while (cur) { path.push(_cellKeyToWorld(cur)); cur = cameFrom.get(cur); }
    path.reverse();
    return path;
  }
  // startEdges needs the shortest path from the player to every stair — doing
  // that as N separate _findMazePath calls (one per stair) means each one
  // independently re-explores much of the same nearby territory around the
  // player, since they all share the same start point. On a 13-stair level
  // that was ~6x more total node visits than necessary (measured: ~25000 vs
  // ~4000) and the dominant cost of every maze-crossing route recompute.
  // A single Dijkstra flood from the player, picking off each target as it's
  // reached and stopping once all of them are found, does the shared
  // exploration work exactly once. No single-target heuristic applies here
  // (there's no one direction to bias toward with several scattered
  // targets), so this is plain Dijkstra rather than A* — but the multi-
  // target early exit more than makes up for it.
  function _findMazePathsToTargets(startWorld, targetWorlds, seenSet, clearance) {
    const startKey = _nearestWalkableCell(startWorld, seenSet, 4);
    const targetKeys = targetWorlds.map(tw => _nearestWalkableCell(tw, seenSet, 4));
    if (!startKey) return targetKeys.map(() => null);
    const best = new Map([[startKey, 0]]);
    const cameFrom = new Map([[startKey, null]]);
    const visited = new Set();
    const heap = new _MinHeap();
    heap.push(startKey, 0);
    const remaining = new Set(targetKeys.filter(Boolean));
    remaining.delete(startKey);
    while (heap.size > 0 && remaining.size > 0) {
      const { key, priority } = heap.pop();
      if (visited.has(key)) continue;
      visited.add(key);
      if (visited.size > PATH_MAX_VISITED) break;
      remaining.delete(key);
      const commaIdx = key.indexOf(',');
      const gx = Number(key.slice(0, commaIdx)), gy = Number(key.slice(commaIdx + 1));
      for (const [dx, dy, stepLen] of PATH_NEIGHBOR_OFFSETS) {
        const nKey = (gx + dx) + ',' + (gy + dy);
        if (visited.has(nKey) || !seenSet.has(nKey)) continue;
        const nClearance = clearance.get(nKey) || 0;
        const stepCost = stepLen * (1 + PATH_CENTER_BIAS / (nClearance + 1));
        const nd = priority + stepCost;
        if (!best.has(nKey) || nd < best.get(nKey)) {
          best.set(nKey, nd);
          cameFrom.set(nKey, key);
          heap.push(nKey, nd);
        }
      }
    }
    return targetKeys.map(tk => {
      if (!tk) return null;
      if (tk === startKey) return [_cellKeyToWorld(startKey)];
      if (!cameFrom.has(tk)) return null;
      const path = [];
      let cur = tk;
      while (cur) { path.push(_cellKeyToWorld(cur)); cur = cameFrom.get(cur); }
      path.reverse();
      return path;
    });
  }
  function _pathLen(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return d;
  }
  // Stair-to-stair connectivity within one level's own explored cells rarely
  // changes (only grows as more trail gets walked or a new stair is found),
  // so it's cached instead of re-pathing every stair pair on every recompute.
  const _stairGraphCache = { mines: { key: null, edges: null, computedAt: 0 }, minesLower: { key: null, edges: null, computedAt: 0 } };
  // Rebuilding is O(stairs²) Dijkstra searches (each up to PATH_MAX_VISITED
  // nodes) — cheap in isolation but `seen.size` (part of the cache key)
  // grows on almost every step while walking through unexplored territory,
  // which used to force this full rebuild on every single _getPointerPath
  // recompute for a maze zone (i.e. a noticeable hitch while moving with an
  // active pointer route). Throttling the rebuild to this interval means
  // exploring keeps using a briefly-stale graph instead — same trade-off
  // POINTER_PATH_STALE_MS already accepts for the route itself — rather
  // than paying the full cost on every newly-discovered cell.
  const STAIR_GRAPH_STALE_MS = 3000;
  const _stairGraphPending = { mines: false, minesLower: false };
  // The rebuild itself (not just how often it runs) is what caused a real
  // hitch: with a lot of explored trail (thousands of cells) and a dozen-plus
  // stairs, the O(stairs²) BFS pass alone measured ~35ms — and since this
  // runs from inside _mazeRoutePath, which itself only runs inside the
  // already-deferred `setTimeout(0)` callback from _getPointerPath, that
  // 35ms landed in the *same* macrotask as the route recompute, defeating
  // the point of deferring it (confirmed by a browser "'setTimeout' handler
  // took 71ms" violation immediately followed by an 85ms frame gap in a
  // capture). Fix: once a graph has been built at least once for a group,
  // never block on a refresh again — hand back the still-good stale graph
  // immediately and rebuild in the background on its own macrotask. Routing
  // briefly uses slightly-outdated stair connectivity while that finishes,
  // same trade-off already made for staleness elsewhere. Only the very
  // first build for a group (no graph yet at all) still runs inline, since
  // there's nothing usable to fall back to yet — but that happens once per
  // group, not on a growing-trail cadence.
  function _rebuildStairGraph(group, seen, clearance) {
    const _dbgT0 = performance.now();
    const edges = _mazeStairs.map(() => []);
    for (let i = 0; i < _mazeStairs.length; i++) {
      const remainingStairs = _mazeStairs.slice(i + 1);
      if (!remainingStairs.length) continue;
      const paths = _findMazePathsToTargets(_mazeStairs[i], remainingStairs, seen, clearance);
      for (let k = 0; k < remainingStairs.length; k++) {
        const path = paths[k];
        if (!path) continue;
        const j = i + 1 + k;
        const len = _pathLen(path);
        edges[i].push({ to: j, path, len });
        edges[j].push({ to: i, path: path.slice().reverse(), len });
      }
    }
    if (window.__roeDbgPerf) console.warn(`[ROE perf] stair graph rebuild (${group}): ${(performance.now() - _dbgT0).toFixed(1)}ms, ${_mazeStairs.length} stairs, ${seen.size} explored cells`);
    return edges;
  }
  function _stairGraphFor(group) {
    const seen = _trailSeenFor(group);
    const clearance = _getClearanceMap(group, seen);
    const key = _mazeStairs.length + ':' + seen.size;
    const cache = _stairGraphCache[group];
    if (cache.key === key) return cache.edges;
    if (cache.edges && Date.now() - cache.computedAt < STAIR_GRAPH_STALE_MS) return cache.edges;
    if (!cache.edges) {
      // Bootstrap: nothing to fall back to yet, so this one has to be inline.
      cache.edges = _rebuildStairGraph(group, seen, clearance);
      cache.key = key;
      cache.computedAt = Date.now();
      return cache.edges;
    }
    // A usable (if stale) graph already exists — serve it now and refresh
    // in the background instead of blocking this call.
    if (!_stairGraphPending[group]) {
      _stairGraphPending[group] = true;
      setTimeout(() => {
        _stairGraphPending[group] = false;
        const freshSeen = _trailSeenFor(group);
        const freshClearance = _getClearanceMap(group, freshSeen);
        cache.edges = _rebuildStairGraph(group, freshSeen, freshClearance);
        cache.key = _mazeStairs.length + ':' + freshSeen.size;
        cache.computedAt = Date.now();
      }, 0);
    }
    return cache.edges;
  }
  // Some corridors are only reachable via a detour through the other level
  // — this can be true even when the player and target are nominally in the
  // "same" zone, since one part of that level's explored trail may connect
  // to the rest only by crossing out to the other level and back in through
  // a different staircase. So this always runs the full stair graph search
  // (a direct in-zone path is just one more edge in it, from START straight
  // to END) rather than only doing so when the two zones currently differ.
  // Only the FIRST hop out of the player's position is actually used —
  // once they walk it (and cross, if it's a staircase), their zone/position
  // changes, the pointer path cache invalidates, and this whole search
  // reruns from the new position, picking the next hop of the (freshly
  // recomputed) optimal route.
  // endEdges (stair -> target) depends only on the target and how much of
  // its zone has been explored — not on the player's position at all. But
  // it used to get recomputed alongside startEdges on every single call,
  // meaning every drift/stale tick re-ran a full n-stair pathfind to the
  // target even though the player moving is the only thing that actually
  // changed. Caching it here means only startEdges (n calls) still needs
  // redoing each recompute instead of both (2n calls) — this is what
  // showed up as 50-95ms hitches on every maze-crossing route recompute.
  let _endEdgesCache = { key: null, edges: null };
  // startEdges (player -> every stair) used to be recomputed from scratch on
  // every single call — there was no cache key that *could* hit, since it
  // was keyed off the player's exact live position, which changes every
  // step. Bucketing the position onto a coarse grid means ordinary movement
  // within the same ~24-unit cell (or standing still while the stale timer
  // fires) reuses the last search instead of paying for it again; only
  // crossing into a new bucket, or newly-explored trail growing playerSeen,
  // invalidates it. The returned path's first few points may then start
  // slightly behind the player's current spot, but _getPointerPath already
  // trims consumed waypoints as the player walks, exactly like it does for
  // the normal POINTER_PATH_MAX_DRIFT tolerance — so this is the same
  // trade-off already accepted elsewhere, just applied here too.
  const STARTEDGES_POS_QUANT = 24;
  let _startEdgesCache = { key: null, edges: null };
  function _mazeRoutePath(playerPos, playerZone, targetPos, targetZone) {
    const playerGroup = playerZone === 'MinesLower' ? 'minesLower' : 'mines';
    const targetGroup = targetZone === 'MinesLower' ? 'minesLower' : 'mines';
    const playerSeen = _trailSeenFor(playerGroup), targetSeen = _trailSeenFor(targetGroup);
    const playerClearance = _getClearanceMap(playerGroup, playerSeen);
    const targetClearance = _getClearanceMap(targetGroup, targetSeen);

    // Direct in-zone edge, only possible when player and target share a zone.
    const directPath = playerZone === targetZone
      ? _findMazePath(playerPos, targetPos, playerSeen, playerClearance)
      : null;

    const n = _mazeStairs.length;
    if (!n) return directPath ? { waypoints: directPath, endPoint: targetPos } : null;

    const endEdgesKey = (targetPos.key || (targetPos.x + ',' + targetPos.y)) + ':' + n + ':' + targetGroup + ':' + targetSeen.size;
    let endEdges;
    if (_endEdgesCache.key === endEdgesKey) {
      endEdges = _endEdgesCache.edges;
    } else {
      const legsB = _findMazePathsToTargets(targetPos, _mazeStairs, targetSeen, targetClearance);
      endEdges = legsB.map(legB => legB ? { path: legB.slice().reverse(), len: _pathLen(legB) } : undefined);
      _endEdgesCache = { key: endEdgesKey, edges: endEdges };
    }

    const startEdgesKey = playerGroup + ':' + n + ':' + playerSeen.size + ':'
      + Math.round(playerPos.x / STARTEDGES_POS_QUANT) + ',' + Math.round(playerPos.y / STARTEDGES_POS_QUANT);
    let startEdges; // player -> stair i, via playerGroup's explored cells
    if (_startEdgesCache.key === startEdgesKey) {
      startEdges = _startEdgesCache.edges;
    } else {
      const legsA = _findMazePathsToTargets(playerPos, _mazeStairs, playerSeen, playerClearance);
      startEdges = legsA.map(legA => legA ? { path: legA, len: _pathLen(legA) } : undefined);
      _startEdgesCache = { key: startEdgesKey, edges: startEdges };
    }


    // Both levels' stair-to-stair graphs are always relevant, even when
    // player and target share a zone: a shortcut between two stairs that
    // are nominally on the same level can itself only exist by detouring
    // through the other level (free to cross at any stair), so limiting
    // this to just playerGroup/targetGroup would silently drop that route.
    const minesGraph      = _stairGraphFor('mines');
    const minesLowerGraph = _stairGraphFor('minesLower');

    // Dijkstra over nodes 0..n-1 (stairs), plus START (n) and END (n+1).
    const START = n, END = n + 1;
    const dist = new Array(n + 2).fill(Infinity);
    const prevNode = new Array(n + 2).fill(null);
    const visited  = new Array(n + 2).fill(false);
    dist[START] = 0;
    if (directPath) { dist[END] = _pathLen(directPath); prevNode[END] = START; }
    for (;;) {
      let u = -1, ud = Infinity;
      for (let k = 0; k < n + 2; k++) if (!visited[k] && dist[k] < ud) { ud = dist[k]; u = k; }
      if (u === -1 || u === END) break;
      visited[u] = true;
      const relax = (v, w) => { const nd = dist[u] + w; if (nd < dist[v]) { dist[v] = nd; prevNode[v] = u; } };
      if (u === START) {
        for (let i = 0; i < n; i++) if (startEdges[i]) relax(i, startEdges[i].len);
      } else {
        if (endEdges[u]) relax(END, endEdges[u].len);
        for (const e of minesGraph[u] || []) relax(e.to, e.len);
        for (const e of minesLowerGraph[u] || []) relax(e.to, e.len);
      }
    }
    if (dist[END] === Infinity) {
      // No full route through to the target yet. Picking whichever
      // reachable stair is nearest to the *player* trivially picks the
      // stair just crossed (distance ~0 right after arriving), which
      // sends the player straight back — a ping-pong loop. Heading toward
      // whichever reachable stair sits closest (straight-line) to the
      // *target* at least moves in the right general direction instead.
      let bi = -1, bClosestToTarget = Infinity;
      for (let i = 0; i < n; i++) {
        if (!startEdges[i]) continue;
        const d = Math.hypot(_mazeStairs[i].x - targetPos.x, _mazeStairs[i].y - targetPos.y);
        if (d < bClosestToTarget) { bClosestToTarget = d; bi = i; }
      }
      if (bi !== -1) return { waypoints: startEdges[bi].path, endPoint: _mazeStairs[bi] };
      return directPath ? { waypoints: directPath, endPoint: targetPos } : null;
    }
    if (prevNode[END] === START) {
      // Going straight there (no stair detour) won outright.
      return { waypoints: directPath, endPoint: targetPos };
    }
    // Walk back from END to find the first hop taken out of START.
    let cur = END;
    while (prevNode[cur] !== START) cur = prevNode[cur];
    return { waypoints: startEdges[cur].path, endPoint: _mazeStairs[cur] };
  }
  // Full recompute (the stair-graph search) isn't cheap, so instead of
  // redoing it on every step, the already-computed path is just "consumed"
  // as the player walks it — dropping waypoints they've passed. A full
  // recompute only happens when the target or zone changes, when the
  // player has drifted off the last computed line (they went the wrong
  // way, or a shortcut into newly-explored trail opened up), or
  // periodically in the background to catch newly-explored trail even
  // while still tracking the old line fine.
  let _pointerPathCache = { targetKey: null, playerZone: null, fullPath: null, computedAt: 0 };
  let _deathDropPathCache = { targetKey: null, playerZone: null, fullPath: null, computedAt: 0 };
  const POINTER_PATH_MAX_DRIFT = 10;         // world units off the line before forcing a recompute
  const POINTER_PATH_STALE_MS  = 5000;       // periodic background recompute even while on-track
  const POINTER_PATH_ANCHOR_LOOKAHEAD = 120; // world units ahead of the player to reconnect to on a drift/stale recompute, instead of re-pathing all the way to the target
  // Maze-crossing routes (Mines <-> MinesLower) always pay the full n-stair
  // Dijkstra/A* search since they can't use the cheap partial reroute below
  // — see canPartialReroute. That search used to cost ~10-30ms (or worse,
  // once the stair-graph rebuild above got folded in), and with the tight
  // 10-unit drift tolerance a player walking steadily (e.g. down a long
  // straight corridor) could out-run the recompute: by the time a fresh
  // path landed, they'd already moved past its start far enough to trip the
  // drift check again, scheduling another full recompute next frame,
  // forever. A looser drift tolerance plus a floor on how often the search
  // can re-run fixed that.
  // Now that the stair-graph rebuild is decoupled into its own background
  // macrotask (see _stairGraphFor), the search itself typically costs
  // 0-6ms in practice — cheap enough that both numbers below can be pulled
  // back down close to the non-maze-crossing values. Keeping them at their
  // original wider setting instead meant a *genuine* deviation (player
  // actually walking off the drawn route, not just riding a long corridor)
  // sat there looking wrong until the drift math finally noticed — up to
  // MAZE_CROSSING_MAX_DRIFT units away — or, failing that, until the full
  // POINTER_PATH_STALE_MS background refresh caught it, which is what read
  // as "the line stays straight for several seconds before snapping to the
  // right one". Small enough now that a real detour gets picked up quickly,
  // still large enough to not re-trigger every frame on a straight walk.
  const MAZE_CROSSING_MAX_DRIFT = 15;
  const MAZE_CROSSING_RECOMPUTE_MIN_INTERVAL_MS = 150;
  // The perpendicular-distance drift check above is a poor detector for a
  // player who has turned onto a different but roughly-parallel corridor:
  // distance to the *old* line grows slowly in that case even though the
  // direction of travel has already clearly diverged, so it can take a
  // while to cross even a modest drift threshold. In practice the periodic
  // stale-timer refresh, not the drift check, is what actually catches this
  // — which is why the line looked stuck for however long
  // POINTER_PATH_STALE_MS (5s) took to fire, on top of whatever the drift
  // tolerance let slide. Since a maze-crossing recompute is now cheap
  // (~9-14ms, no inline stair-graph rebuild), it can afford its own, much
  // shorter periodic refresh instead of sharing the 5s interval meant for
  // the (cheaper, more frequent-by-nature) same-level case.
  const MAZE_CROSSING_STALE_MS = 2500;
  let _lastMazeCrossingFullRecomputeAt = 0;
  function _distToSegment(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
  }
  // Same projection as _distToSegment but unclamped — used to tell whether
  // the player has actually passed a waypoint along the route direction,
  // not just gotten closer to the next point by straight-line distance.
  // On a sharp turn, straight-line distance to pts[0] can stay smaller than
  // to pts[1] well after the player has already walked past pts[0] (the
  // old point sits off to the side, not behind), so the old dCur/dNext
  // comparison failed to drop it — leaving the dashed line hooking back
  // to that stale point and drawing a visible loop each time it happened.
  function _segmentT(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    return len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 1;
  }
  let _pointerPathPending = false;
  let _deathDropPathPending = false;
  function _getPointerPath(group, target, cacheRef, pendingRef) {
    // Defaults preserve the original single-target behavior for any other
    // caller — target/cache/pending become explicit so this same routing
    // logic can be reused for the death-drop marker without the two paths
    // sharing (and overwriting) each other's cache.
    target = target || _pointerTarget;
    if (!target || !_playerPos) return null;
    const isPending = pendingRef ? pendingRef.get() : _pointerPathPending;
    const setPending = pendingRef ? pendingRef.set : (v) => { _pointerPathPending = v; };
    const cache = cacheRef || _pointerPathCache;
    const playerZone = group === 'forest' ? 'Forest' : _currentZone;
    const targetChanged = cache.targetKey !== target.key;
    const zoneChanged   = cache.playerZone !== playerZone;
    // Maze-crossing routes (Mines <-> MinesLower) can't use the cheap partial
    // reroute below (see canPartialReroute), so every stale tick pays the
    // full n-stair Dijkstra/A* search again — ~120-165ms in practice, enough
    // to show up as a felt micro-freeze every time the stale timer fires.
    // Same-level routes stay on the short interval since their stale
    // recompute is the cheap partial-reroute path.
    const isMazeCrossing = group !== 'forest' && MAZE_ZONES.has(playerZone) && MAZE_ZONES.has(target.zone);

    // Anchor all "where is the player right now" decisions below to the same
    // smoothed/lerped position the dashed line is actually drawn from
    // (_mapDisplayPlayer — see the render call site), not the raw _playerPos.
    // _playerPos jumps straight to the commanded destination the instant a
    // `move` is emitted, while the dot/line-start glides there over time. If
    // trimming and rerouting judge "has the player passed this point" against
    // the already-jumped-ahead raw position — especially right after
    // reversing direction, when the new _playerPos can legitimately be
    // *behind* where the dot still visually is — the path gets computed from
    // a different point than the line is drawn from, producing a visible
    // kink/half-loop where the two disagree. Falls back to _playerPos only
    // if no smoothed position exists yet (e.g. right after a zone change).
    const anchorPos = _mapDisplayPlayer || _playerPos;

    // Drop any leading waypoints the player has already walked past. Kept
    // even when the drift/stale check below forces a recompute, since it's
    // then reused as the tail for a partial reroute instead of being thrown
    // away — see canPartialReroute.
    let trimmedPts = null;
    if (!targetChanged && !zoneChanged && cache.fullPath) {
      let pts = cache.fullPath;
      while (pts.length > 1) {
        // Has the player passed pts[0] along the pts[0]->pts[1] direction?
        // t >= 1 means the projection landed beyond pts[1], i.e. the player
        // is now ahead of this segment, not just nearer to its far end.
        const t = _segmentT(anchorPos, pts[0], pts[1]);
        if (t >= 1) pts = pts.slice(1); else break;
      }
      trimmedPts = pts;
      const drift = pts.length > 1
        ? _distToSegment(anchorPos, pts[0], pts[1])
        : Math.hypot(anchorPos.x - pts[0].x, anchorPos.y - pts[0].y);
      const staleMs = isMazeCrossing ? MAZE_CROSSING_STALE_MS : POINTER_PATH_STALE_MS;
      let stale = Date.now() - cache.computedAt >= staleMs;
      // A maze-crossing full recompute costs 9-25ms in practice (this was
      // scoped assuming ~9-14ms), so the bare 1.2s stale timer alone fires
      // often enough to tank frame time on its own. Route it through the
      // same recompute-rate floor the drift trigger already respects below,
      // instead of forcing a full search every time the short timer elapses.
      if (isMazeCrossing && stale && (Date.now() - _lastMazeCrossingFullRecomputeAt) < MAZE_CROSSING_RECOMPUTE_MIN_INTERVAL_MS) {
        stale = false;
      }
      const driftLimit = isMazeCrossing ? MAZE_CROSSING_MAX_DRIFT : POINTER_PATH_MAX_DRIFT;
      if (drift <= driftLimit && !stale) {
        cache.fullPath = pts;
        return { waypoints: pts.slice(0, -1), endPoint: pts[pts.length - 1] };
      }
    }

    // A real recompute is needed (target/zone changed, drifted off the
    // line, or gone stale). The maze branch below can still take a few ms
    // (stair graph + start/end edge searches) — running that synchronously
    // right here, inside the same call that's drawing this frame's
    // minimap, is what showed up as a dropped frame right as the route
    // updated. Deferring it one macrotask lets the current frame finish
    // painting first; this call (and any others until the timeout lands)
    // just returns the last known path — or null/straight-line if there
    // isn't one yet for this target — for those couple of frames instead.
    // Same target/zone, just drifted or gone stale (not a fresh target): the
    // cached tail from trimmedPts is still a valid route, only the bit next
    // to the player needs fixing. Re-pathing from the player to a nearby
    // anchor point on that tail — instead of all the way to the target —
    // keeps the Dijkstra search small no matter how far off the target
    // itself is, and the stale timer can safely keep firing often since each
    // recompute now only costs as much as the local anchor distance. Skipped
    // for maze-crossing routes (stairs between Mines/MinesLower): the anchor
    // could legitimately sit on the other floor, and the two levels share one
    // coordinate space, so there's no safe way to tell from the point alone.
    const canPartialReroute = !targetChanged && !zoneChanged && !isMazeCrossing && trimmedPts && trimmedPts.length > 1;
    const _dbgReason = targetChanged ? 'target-changed' : zoneChanged ? 'zone-changed' : 'drift-or-stale';
    // Only the maze-crossing case is expensive enough to throttle, and only
    // when it's the drift/stale reason doing the triggering — a genuine
    // target or zone change still needs to respond immediately, otherwise
    // the arrow/line would visibly lag behind a fresh click or a stair
    // crossing. While throttled, keep serving the trimmed (already-walked-
    // past waypoints dropped) tail from the old path instead of the
    // untrimmed one, so the line still visually keeps up with the player
    // even though the route itself hasn't been refreshed yet.
    const throttledMazeCrossing = isMazeCrossing && !targetChanged && !zoneChanged
      && (Date.now() - _lastMazeCrossingFullRecomputeAt) < MAZE_CROSSING_RECOMPUTE_MIN_INTERVAL_MS;
    if (throttledMazeCrossing) {
      if (trimmedPts && trimmedPts.length) cache.fullPath = trimmedPts;
    } else if (!isPending) {
      setPending(true);
      const targetKeyAtSchedule = target.key;
      const partialBase = canPartialReroute ? trimmedPts : null;
      setTimeout(() => {
        setPending(false);
        // Target changed while waiting — this result is moot, the next
        // call will see targetChanged again and schedule a fresh one.
        if (!target || target.key !== targetKeyAtSchedule || !_playerPos) return;
        const _dbgT0 = performance.now();
        // Re-read the smoothed position here (not the one captured when this
        // callback was scheduled) — this runs a macrotask later, and the dot
        // keeps gliding in that time. Pathing from wherever it's drawn *now*
        // keeps the search consistent with the line's actual start point;
        // falls back to raw _playerPos only if no smoothed position exists.
        const anchorPosNow = _mapDisplayPlayer || _playerPos;
        const routeGroup = group === 'forest' ? 'forest'
          : _customZoneFromGroup(group) ? group
          : (playerZone === 'MinesLower' ? 'minesLower' : 'mines');
        let fullPath = null;
        let usedPartial = false;
        if (partialBase) {
          // Walk forward along the cached tail until POINTER_PATH_ANCHOR_LOOKAHEAD
          // world units out (or the tail runs out) and reconnect there.
          let travelled = 0, anchorIdx = 1;
          for (; anchorIdx < partialBase.length - 1; anchorIdx++) {
            travelled += Math.hypot(partialBase[anchorIdx].x - partialBase[anchorIdx - 1].x, partialBase[anchorIdx].y - partialBase[anchorIdx - 1].y);
            if (travelled >= POINTER_PATH_ANCHOR_LOOKAHEAD) break;
          }
          const anchor = partialBase[anchorIdx];
          const seenSet = _trailSeenFor(routeGroup);
          const clearance = _getClearanceMap(routeGroup, seenSet);
          const localWaypoints = _findMazePath(anchorPosNow, anchor, seenSet, clearance);
          if (localWaypoints) { fullPath = [...localWaypoints, ...partialBase.slice(anchorIdx + 1)]; usedPartial = true; }
        }
        if (!fullPath) {
          let result;
          if (isMazeCrossing) {
            // Mines/MinesLower routing — may need zero, one, or several staircase
            // crossings, so this always runs the full stair graph search rather
            // than only when the two zones currently happen to differ (parts of
            // a single level can themselves only be reachable via a detour
            // through the other level).
            const route = _mazeRoutePath(anchorPosNow, playerZone, target, target.zone);
            result = route || { waypoints: null, endPoint: target };
          } else {
            // Same level (or Forest) — route within that level's own explored
            // cells, using whichever specific zone the player/target are
            // actually in rather than the currently-displayed split/combined view.
            const seenSet = _trailSeenFor(routeGroup);
            const clearance = _getClearanceMap(routeGroup, seenSet);
            const waypoints = _findMazePath(anchorPosNow, target, seenSet, clearance);
            result = { waypoints, endPoint: target };
          }
          fullPath = [...(result.waypoints || []), result.endPoint];
        }
        Object.assign(cache, { targetKey: target.key, playerZone, fullPath, computedAt: Date.now() });
        if (isMazeCrossing && !usedPartial) _lastMazeCrossingFullRecomputeAt = Date.now();
        const _dbgMode = usedPartial ? 'partial' : (isMazeCrossing ? 'full-maze-crossing' : 'full-same-level');
        if (window.__roeDbgPerf) console.warn(`[ROE perf] pointer path recompute (${_dbgReason}, ${_dbgMode}): ${(performance.now() - _dbgT0).toFixed(1)}ms, ${fullPath.length} pts`);
      }, 0);
    }

    if (cache.fullPath && cache.targetKey === target.key) {
      const pts = cache.fullPath;
      return { waypoints: pts.slice(0, -1), endPoint: pts[pts.length - 1] };
    }
    return null; // caller falls back to a straight line to the target
  }

  // ─── Compact binary trail encoding ─────────────────────────────────────────
  // Every point is already snapped onto the MAZE_TRAIL_MIN_STEP dedup grid
  // (see _trailCellKey), so storing raw floats keeps ~15 digits of noise
  // that carries zero extra information — it's the same grid cell either
  // way. Packing each axis into a signed 16-bit grid-cell index and
  // base64-encoding the raw bytes turns a ~50-byte-per-point JSON entry
  // into ~4 raw bytes (~5.3 base64 chars) per point, losing nothing beyond
  // what dedup already discarded. Int16 covers cell indices up to ±32767,
  // i.e. ±~72000 world units at the current step — far past any real map.
  function _packTrail(points) {
    const buf = new Int16Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
      buf[i * 2]     = Math.round(points[i].x / MAZE_TRAIL_MIN_STEP);
      buf[i * 2 + 1] = Math.round(points[i].y / MAZE_TRAIL_MIN_STEP);
    }
    const bytes = new Uint8Array(buf.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function _unpackTrail(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    const points = [];
    for (let i = 0; i + 1 < buf.length; i += 2) {
      points.push({ x: buf[i] * MAZE_TRAIL_MIN_STEP, y: buf[i + 1] * MAZE_TRAIL_MIN_STEP });
    }
    return points;
  }
  // Accepts either an already-decoded point array (legacy export format, or
  // a plain JS array coming from import) or a packed base64 string, so
  // import stays compatible with older exports too.
  function _decodeTrailField(field) {
    if (Array.isArray(field)) return field;
    if (typeof field === 'string') { try { return _unpackTrail(field); } catch (_) { return []; } }
    return [];
  }
  // Migrates the old stroke format ([[{x,y},...], ...]) into a flat, deduped
  // point list, in case someone's upgrading from an older script version.
  function _loadTrail(key) {
    const points = [];
    const seen = new Set();
    const raw = localStorage.getItem(key);
    if (raw) {
      try {
        let flat;
        if (raw[0] === '[') {
          // Legacy formats: flat JSON point array, or the old nested
          // stroke array ([[{x,y},...], ...]) from older script versions.
          const saved = JSON.parse(raw);
          flat = Array.isArray(saved[0]) ? saved.flat() : saved;
        } else {
          // Current format: packed base64 (see _packTrail/_unpackTrail).
          flat = _unpackTrail(raw);
        }
        flat.forEach(p => {
          if (!p) return;
          const k = _trailCellKey(p);
          if (!seen.has(k)) { seen.add(k); points.push(p); }
        });
      } catch (_) {}
    }
    return { points, seen };
  }

  // Running bounds box per trail, kept up to date in O(1) as points are
  // pushed. mazeMapTargetBounds() used to recompute min/max over the *whole*
  // trail array every animation frame via `Math.min(...pts.map(...))` — fine
  // for a few hundred points, but with a large trail (thousands+) that both
  // wastes CPU every single frame and risks "Maximum call stack size
  // exceeded" once the array is big enough to blow the spread-argument
  // limit. Full rescans (_computeBounds) are now only done on bulk edits
  // (clear/delete/import), which are rare.
  function _computeBounds(points) {
    if (!points.length) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
  }
  function _extendBounds(bounds, p) {
    if (!bounds) return { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
    if (p.x < bounds.minX) bounds.minX = p.x;
    if (p.x > bounds.maxX) bounds.maxX = p.x;
    if (p.y < bounds.minY) bounds.minY = p.y;
    if (p.y > bounds.maxY) bounds.maxY = p.y;
    return bounds;
  }

  const { points: _mazeTrail, seen: _mazeTrailSeen } = _loadTrail('roeMazeTrail');
  let _mazeTrailBounds = _computeBounds(_mazeTrail);
  let _mazeTrailSaveTimer = null;
  function saveMazeTrail() {
    // Throttled — walking pushes points often, no need to hit localStorage every step
    if (_mazeTrailSaveTimer) return;
    _mazeTrailSaveTimer = setTimeout(() => {
      _mazeTrailSaveTimer = null;
      try { localStorage.setItem('roeMazeTrail', _packTrail(_mazeTrail)); } catch (_) {}
    }, 2000);
  }

  // Separate Mines-only and MinesLower-only trails, recorded in parallel with
  // the combined one above (see the Auto behavior comment near MAZE_ZONES)
  // so the "each level gets its own map" view has real data to draw from.
  const { points: _minesTrail, seen: _minesTrailSeen } = _loadTrail('roeMinesTrail');
  let _minesTrailBounds = _computeBounds(_minesTrail);
  let _minesTrailSaveTimer = null;
  function saveMinesTrail() {
    if (_minesTrailSaveTimer) return;
    _minesTrailSaveTimer = setTimeout(() => {
      _minesTrailSaveTimer = null;
      try { localStorage.setItem('roeMinesTrail', _packTrail(_minesTrail)); } catch (_) {}
    }, 2000);
  }

  const { points: _minesLowerTrail, seen: _minesLowerTrailSeen } = _loadTrail('roeMinesLowerTrail');
  let _minesLowerTrailBounds = _computeBounds(_minesLowerTrail);
  let _minesLowerTrailSaveTimer = null;
  function saveMinesLowerTrail() {
    if (_minesLowerTrailSaveTimer) return;
    _minesLowerTrailSaveTimer = setTimeout(() => {
      _minesLowerTrailSaveTimer = null;
      try { localStorage.setItem('roeMinesLowerTrail', _packTrail(_minesLowerTrail)); } catch (_) {}
    }, 2000);
  }

  // ─── Forest exit tracking (same idea as the maze one, single zone) ───────────
  const FOREST_ZONES = new Set(['Forest']);
  let _forestEntry = null; // { x, y } — position when we last entered Forest from outside
  try {
    const savedForestEntry = localStorage.getItem('roeForestEntry');
    if (savedForestEntry) _forestEntry = JSON.parse(savedForestEntry);
  } catch (_) {}
  function saveForestEntry() {
    try {
      if (_forestEntry) localStorage.setItem('roeForestEntry', JSON.stringify(_forestEntry));
      else localStorage.removeItem('roeForestEntry');
    } catch (_) {}
  }
  // Every distinct spot in Forest where the player walked straight into the
  // maze (Forest connects directly to Mines, not just via Town). Reuses the
  // same dedup helper as the maze's own entries/stairs arrays.
  let _forestDungeonEntries = []; // [{x,y}, ...]
  try {
    const savedFDE = JSON.parse(localStorage.getItem('roeForestDungeonEntries'));
    if (Array.isArray(savedFDE)) _forestDungeonEntries = savedFDE;
  } catch (_) {}
  function saveForestDungeonEntries() {
    try { localStorage.setItem('roeForestDungeonEntries', JSON.stringify(_forestDungeonEntries)); } catch (_) {}
  }

  const { points: _forestTrail, seen: _forestTrailSeen } = _loadTrail('roeForestTrail');
  let _forestTrailBounds = _computeBounds(_forestTrail);
  let _forestTrailSaveTimer = null;
  function saveForestTrail() {
    if (_forestTrailSaveTimer) return;
    _forestTrailSaveTimer = setTimeout(() => {
      _forestTrailSaveTimer = null;
      try { localStorage.setItem('roeForestTrail', _packTrail(_forestTrail)); } catch (_) {}
    }, 2000);
  }

  // ─── Custom (user-added) minimaps ───────────────────────────────────────────
  // The built-in maps (Forest, Mines/MinesLower) are hardcoded because they
  // need special gate/staircase/routing logic. Any other zone (Town, etc.)
  // can still get a plain trail-only minimap on demand: click ➕ while
  // standing in it and it registers as a new trackable zone, storing its own
  // trail/bounds/move-history keyed by zone name instead of a dedicated
  // variable per zone. Persisted so it keeps tracking across reloads.
  const CUSTOM_MAP_ZONES_KEY = 'roeCustomMapZones';
  let _customMapZones = [];
  try {
    const savedCustomZones = JSON.parse(localStorage.getItem(CUSTOM_MAP_ZONES_KEY));
    if (Array.isArray(savedCustomZones)) _customMapZones = savedCustomZones.filter(z => typeof z === 'string' && z);
  } catch (_) {}
  function _saveCustomMapZones() {
    try { localStorage.setItem(CUSTOM_MAP_ZONES_KEY, JSON.stringify(_customMapZones)); } catch (_) {}
  }
  function _isCustomMapZone(zone) { return !!zone && _customMapZones.includes(zone); }
  // group string → zone name, for the 'custom:ZoneName' group keys used
  // everywhere below (null if `group` isn't a custom-zone group).
  function _customZoneFromGroup(group) {
    return (typeof group === 'string' && group.indexOf('custom:') === 0) ? group.slice(7) : null;
  }
  function _customGroupFor(zone) { return 'custom:' + zone; }

  const _customMapStore = new Map(); // zone name → { trail, seen, bounds, moveHist, lastPushedKey, lastRawPos, saveTimer }
  function _customMapEntry(zone) {
    let entry = _customMapStore.get(zone);
    if (!entry) {
      const { points, seen } = _loadTrail('roeCustomTrail::' + zone);
      entry = {
        trail: points,
        seen,
        bounds: _computeBounds(points),
        moveHist: [],
        lastPushedKey: null,
        lastRawPos: null,
        saveTimer: null,
      };
      _customMapStore.set(zone, entry);
      // Best-effort: pick up any previously-baked disk cache for this zone
      // (see _loadTrailLayerCache) so a returning player doesn't have to
      // replay the whole trail from scratch.
      try { _loadTrailLayerCache(_customGroupFor(zone), _trailLayerStateFor(_customGroupFor(zone))); } catch (_) {}
    }
    return entry;
  }
  function _saveCustomTrail(zone) {
    const entry = _customMapEntry(zone);
    if (entry.saveTimer) return;
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null;
      try { localStorage.setItem('roeCustomTrail::' + zone, _packTrail(entry.trail)); } catch (_) {}
    }, 2000);
  }
  // Registers whatever zone the player is currently standing in as a new
  // trackable minimap. No-ops (returns null) if there's no known position
  // yet, or the zone is already tracked (built-in or previously added).
  function _addCustomMinimapForCurrentZone() {
    const zone = _currentZone;
    if (!zone || !_playerPos) return null;
    if (MAZE_ZONES.has(zone) || FOREST_ZONES.has(zone) || _isCustomMapZone(zone)) return zone;
    _customMapZones.push(zone);
    _saveCustomMapZones();
    _customMapEntry(zone); // pre-warm storage
    // Switch straight to Auto so the freshly-added zone shows immediately —
    // it'll be picked up by _realMapGroup() since the player is standing in it.
    _mapManualMode = false;
    _saveMapManualMode();
    _mapView = null; _mapDisplayPlayer = null; _mapInterp = null;
    _mapPanX = 0; _mapPanY = 0;
    _saveMapPan();
    return zone;
  }
  function _removeCustomMapZone(zone) {
    _customMapZones = _customMapZones.filter(z => z !== zone);
    _saveCustomMapZones();
    _customMapStore.delete(zone);
    try { localStorage.removeItem('roeCustomTrail::' + zone); } catch (_) {}
    if (_mapManualMode && _mapManualGroup === _customGroupFor(zone)) {
      _mapManualMode = false;
      _saveMapManualMode();
    }
  }

  // ─── Generic per-group trail accessors ─────────────────────────────────
  // Everything below used to hardcode a binary forest/maze ternary; now that
  // there are 4 built-in map groups ('forest', 'maze', 'mines',
  // 'minesLower') plus any number of custom 'custom:ZoneName' groups, that
  // logic is centralized here instead of repeating the branch at every call site.
  function _trailPointsFor(group) {
    const cz = _customZoneFromGroup(group);
    if (cz) return _customMapEntry(cz).trail;
    if (group === 'forest')      return _forestTrail;
    if (group === 'mines')       return _minesTrail;
    if (group === 'minesLower')  return _minesLowerTrail;
    return _mazeTrail;
  }
  function _trailSeenFor(group) {
    const cz = _customZoneFromGroup(group);
    if (cz) return _customMapEntry(cz).seen;
    if (group === 'forest')      return _forestTrailSeen;
    if (group === 'mines')       return _minesTrailSeen;
    if (group === 'minesLower')  return _minesLowerTrailSeen;
    return _mazeTrailSeen;
  }
  function _trailBoundsFor(group) {
    const cz = _customZoneFromGroup(group);
    if (cz) return _customMapEntry(cz).bounds;
    if (group === 'forest')      return _forestTrailBounds;
    if (group === 'mines')       return _minesTrailBounds;
    if (group === 'minesLower')  return _minesLowerTrailBounds;
    return _mazeTrailBounds;
  }
  function _setTrailBoundsFor(group, bounds) {
    const cz = _customZoneFromGroup(group);
    if (cz) { _customMapEntry(cz).bounds = bounds; return; }
    if (group === 'forest')            _forestTrailBounds = bounds;
    else if (group === 'mines')        _minesTrailBounds = bounds;
    else if (group === 'minesLower')   _minesLowerTrailBounds = bounds;
    else                                _mazeTrailBounds = bounds;
  }
  function _saveTrailFor(group) {
    const cz = _customZoneFromGroup(group);
    if (cz) return _saveCustomTrail(cz);
    if (group === 'forest')      return saveForestTrail();
    if (group === 'mines')       return saveMinesTrail();
    if (group === 'minesLower')  return saveMinesLowerTrail();
    return saveMazeTrail();
  }


  // dot interpolates between these instead of chasing the newest one, so it
  // always moves smoothly at a steady pace rather than jumping then easing.
  let _mazeMoveHist = []; // [{x,y,t}, {x,y,t}]
  let _forestMoveHist = []; // [{x,y,t}, {x,y,t}] — same idea, for the Forest minimap
  // Tracks the key of the last point actually pushed (not skipped as a dupe)
  // during the *current* zone visit, so a boundary glitch (the move event
  // right as the zone flips landing a stray point) can be safely undone on
  // exit without risking deletion of older, unrelated trail data.
  let _mazeLastPushedKey   = null;
  let _forestLastPushedKey = null;
  // Same idea as _mazeLastPushedKey, but tracked separately per split-mode
  // trail so a stray point can be undone from exactly the right one when
  // leaving Mines, leaving MinesLower, or crossing the staircase between them.
  let _minesLastPushedKey      = null;
  let _minesLowerLastPushedKey = null;
  // Last raw (non-grid-snapped) position we actually saw while in this zone
  // group — the interpolation source point for _stepPoints(). Reset to null
  // on a fresh zone entry so we never draw a line across a teleport/loading
  // screen using a stale position from a previous visit or a different zone.
  let _mazeLastRawPos   = null;
  let _forestLastRawPos = null;
  let _playerMoveHist = []; // [{x,y,t}, {x,y,t}] — general, any zone, used to ease the pointer overlay

  // ─── Runestone drops on the ground (from restore_world_drops + live loot_drop) ─
  let _worldDropRunes = []; // [{ dropId, quantity, pos:{x,y} }, ...]
  // ─── Other item drops on the ground (player-dropped items, mob loot, etc.) ───
  let _worldDropItems = []; // [{ dropId, itemId, quantity, pos:{x,y} }, ...]

  // ─── Auto-sync toggle ────────────────────────────────────────────────────────

  // ─── WS Log (UI ring buffer — capped, for display only) ─────────────────────
  const wsLog = [];
  const MAX_UI_EVENTS = 500;          // max entries kept in RAM for the log UI pane
  let wsLogSkippedCount = 0;
  let _captureAll = false;

  // ─── Persistent log write toggle ──────────────────────────────────────────────
  // When false: UI log and ring buffer work as usual, but OPFS/IDB write is skipped.
  let _persistLogEnabled = localStorage.getItem('roe_persistLogEnabled') !== '0';

  // ─── Full log stop toggle ─────────────────────────────────────────────────────
  // When true: nothing is logged at all — no UI log, no ring buffer, no OPFS/IDB
  // write, no console capture. Survives reload via localStorage.
  let _allLogsStopped = localStorage.getItem('roe_allLogsStopped') === '1';

  // ─── WS Ring buffer (always captures ALL events, last 5 min) ─────────────────
  // Stores every IN/OUT/SYS event regardless of WS_LOG_SKIP or _captureAll.
  // Trimmed on a 30-second interval — no per-event overhead.
  const wsRingBuffer = [];
  const WS_RING_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

  // ─── Persistent OPFS Logger ───────────────────────────────────────────────────
  //  Black-box flight recorder: auto-starts, survives reloads, zero RAM growth.
  //  Falls back to IndexedDB if OPFS is unavailable (non-Chromium).
  //
  //  OPFS files:
  //    wslog.ndjson              ← current (append-only)
  //    wslog.1.ndjson  …  wslog.4.ndjson   ← rotated, oldest = highest index
  //
  //  Public surface:
  //    persistentLogger.enqueue(dir, event, data)   ← hot path, synchronous
  //    exportLogs()                                  ← downloads all log data
  // ─────────────────────────────────────────────────────────────────────────────
  const OPFS_MAX_BYTES = 20 * 1024 * 1024; // rotate at 20 MB (~16h of play, 5 files ≈ a month of history)
  const OPFS_MAX_FILES = 5;                  // rotated slots to keep
  const OPFS_FLUSH_MS  = 500;                // periodic flush interval
  const OPFS_BATCH_MAX = 300;                // also flush immediately at this depth

  // Events to drop from the persistent log entirely.
  // These are high-frequency / zero-analysis-value events that account for
  // ~57 % of raw log volume (move+ack+worldclock+ping/pong alone).
  // Kept separate from WS_LOG_SKIP so UI display and OPFS retention are
  // tunable independently.
  const OPFS_SKIP = new Set([
    // Player movement — fires every ~750 ms, coords already in move_ack
    'move', 'move_ack',
    // In-game clock — ticks in lockstep with movement, single number
    'worldclock_save', 'worldclock_save_ack',
    // WebSocket heartbeat
    'ping', 'pong',
    // Fire-and-forget sync triggers — no useful payload
    'sync_minimap', 'sync_cooldowns', 'sync_buffs', 'sync_stats',
    'request_spawn_state',
    // Minimap fog-of-war matrix (50×50 tiles, ~15 KB each, changes slowly)
    'minimap',
    // Current player buffs — only needed for combat debugging
    'active_buffs',
  ]);

  const persistentLogger = (() => {
    const st = {
      ready:     false,
      useIDB:    false,
      queue:     [],      // serialized NDJSON lines waiting to be written
      flushing:  false,
      dirHandle: null,    // OPFS root directory handle
      fileName:  'wslog.ndjson',
      fileSize:  0,       // running byte count; updated after every write
      idbDb:     null,
      idbSeq:    0,
    };

    // ── OPFS helpers ────────────────────────────────────────────────────────

    async function opfsSize(name) {
      try {
        const fh = await st.dirHandle.getFileHandle(name);
        return (await fh.getFile()).size;
      } catch { return 0; }
    }

    async function opfsExists(name) {
      try { await st.dirHandle.getFileHandle(name); return true; } catch { return false; }
    }

    async function opfsDelete(name) {
      try { await st.dirHandle.removeEntry(name); } catch {}
    }

    // OPFS has no rename — copy via ArrayBuffer then delete source.
    async function opfsCopy(from, to) {
      try {
        const srcFh = await st.dirHandle.getFileHandle(from);
        const buf   = await (await srcFh.getFile()).arrayBuffer();
        const dstFh = await st.dirHandle.getFileHandle(to, { create: true });
        const w     = await dstFh.createWritable({ keepExistingData: false });
        await w.write(buf);
        await w.close();
      } catch {}
    }

    // ── Log rotation ────────────────────────────────────────────────────────

    async function rotateIfNeeded() {
      if (st.fileSize < OPFS_MAX_BYTES) return;
      // Drop oldest slot
      await opfsDelete(`wslog.${OPFS_MAX_FILES - 1}.ndjson`);
      // Shift: wslog.(N-1) → wslog.N … wslog.1 → wslog.2
      for (let i = OPFS_MAX_FILES - 2; i >= 1; i--) {
        const from = `wslog.${i}.ndjson`;
        const to   = `wslog.${i + 1}.ndjson`;
        if (await opfsExists(from)) {
          await opfsCopy(from, to);
          await opfsDelete(from);
        }
      }
      // Move current → wslog.1
      if (await opfsExists(st.fileName)) {
        await opfsCopy(st.fileName, 'wslog.1.ndjson');
      }
      // Truncate current file to zero
      const fh = await st.dirHandle.getFileHandle(st.fileName, { create: true });
      const w  = await fh.createWritable({ keepExistingData: false });
      await w.close();
      st.fileSize = 0;
      console.log('[ROE logger] rotated — new log started');
    }

    // ── OPFS append ─────────────────────────────────────────────────────────

    async function opfsAppend(lines) {
      const chunk = lines.join('\n') + '\n';
      const bytes = new TextEncoder().encode(chunk);
      const fh    = await st.dirHandle.getFileHandle(st.fileName, { create: true });
      // createWritable with keepExistingData=true + seek to end = safe append
      const w = await fh.createWritable({ keepExistingData: true });
      await w.seek(st.fileSize);
      await w.write(bytes);
      await w.close();
      st.fileSize += bytes.byteLength;
      await rotateIfNeeded();
    }

    // ── IndexedDB fallback ──────────────────────────────────────────────────

    function idbOpen() {
      return new Promise((res, rej) => {
        const req = indexedDB.open('roe_wslog_v1', 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('ev'))
            db.createObjectStore('ev', { keyPath: 'seq' });
        };
        req.onsuccess = e => { st.idbDb = e.target.result; res(); };
        req.onerror   = () => rej(req.error);
      });
    }

    function idbAppend(lines) {
      return new Promise(res => {
        if (!st.idbDb) { res(); return; }
        const tx    = st.idbDb.transaction('ev', 'readwrite');
        const store = tx.objectStore('ev');
        lines.forEach(line => { store.put({ seq: ++st.idbSeq, line }); });
        tx.oncomplete = res;
        tx.onerror    = res; // never block on IDB errors
      });
    }

    // ── Flush loop ──────────────────────────────────────────────────────────

    async function flush() {
      if (st.flushing || st.queue.length === 0) return;
      st.flushing = true;
      try {
        const batch = st.queue.splice(0, Math.min(st.queue.length, OPFS_BATCH_MAX));
        await (st.useIDB ? idbAppend(batch) : opfsAppend(batch));
      } catch (err) {
        // Warn but do not re-enqueue — accept rare data loss over cascading failures
        console.warn('[ROE logger] flush error (will retry next interval):', err);
      } finally {
        st.flushing = false;
        if (st.queue.length > 0) setTimeout(flush, 50);
      }
    }

    // ── enqueue (hot path — called on every WS event) ───────────────────────

    function enqueue(dir, event, data) {
      if (!st.ready) return;
      if (!_persistLogEnabled) return;    // persistent write disabled by user
      if (OPFS_SKIP.has(event)) return;   // drop noise before any allocation
      try {
        st.queue.push(JSON.stringify({ ts: Date.now(), dir, event, data }));
        if (st.queue.length >= OPFS_BATCH_MAX) flush(); // emergency flush
      } catch { /* swallow JSON serialization errors */ }
    }

    // ── Init ────────────────────────────────────────────────────────────────

    async function init() {
      try {
        st.dirHandle = await navigator.storage.getDirectory();
        st.fileSize  = await opfsSize(st.fileName);
        st.ready     = true;
        console.log(`[ROE logger] OPFS ready — ${st.fileName} existing size=${st.fileSize}`);
      } catch (e1) {
        console.warn('[ROE logger] OPFS unavailable, trying IndexedDB:', e1.message);
        try {
          await idbOpen();
          st.useIDB = true;
          st.ready  = true;
          console.log('[ROE logger] IndexedDB fallback ready');
        } catch (e2) {
          console.error('[ROE logger] All persistent storage unavailable:', e2);
        }
      }
      setInterval(flush, OPFS_FLUSH_MS);
    }

    return { enqueue, init, _st: st };
  })();

  // Start immediately — non-blocking, does not delay page load
  persistentLogger.init();

  // ─── Console log capture (Unity WebGL writes to native console.log) ──────────
  const DURABILITY_PER_HIT = 5;
  let _durWarnThreshold = parseInt(localStorage.getItem('roe_durWarnThreshold') ?? '3', 10) || 3; // stored in hits
  const _DUR_WARN_KEYWORDS = ['sword', 'axe', 'pickaxe'];
  let _durWarnKeywords = JSON.parse(localStorage.getItem('roe_durWarnKeywords') ?? 'null') ?? ['sword'];
  const _durItemMatches = id => _durWarnKeywords.length === 0 || _durWarnKeywords.some(k => id.toLowerCase().includes(k));
  let _showInvId = localStorage.getItem('roe_showInvId') !== 'false'; // default: true

  // ─── BROKEN toast: keep it on screen for a few seconds ───────────────────────
  // The item breaking usually triggers a fresh inventory/durability update within
  // the same tick (server push), which would otherwise immediately re-run the
  // "hide since Durability===0 doesn't match the near-break range" branch and
  // wipe the 🔴 BROKEN message before anyone reads it. _durBrokenUntil records
  // how long the toast must be protected from being overwritten/hidden by those
  // other update paths.
  var _durBrokenUntil = 0;
  var _lastBrokenToastInstanceId = null; // instanceId last shown via the BROKEN toast, so repeat updates don't re-trigger it
  const DUR_BROKEN_TOAST_MS = 3000;
  function _showDurBrokenMsg(el, msg) {
    if (!el) return;
    _durBrokenUntil = Date.now() + DUR_BROKEN_TOAST_MS;
    el.textContent = msg;
    el.style.animation = 'none';
    el.style.display = 'block';
    setTimeout(() => {
      // Only hide if nothing re-broke/re-shown a newer toast in the meantime.
      if (Date.now() >= _durBrokenUntil) el.style.display = 'none';
    }, DUR_BROKEN_TOAST_MS);
  }
  // ─── QB compact mode: show only selected slots (0-9) and/or in-hand ─────────
  // (compact Durability view is now always the default; full view opened via ⚙️ in title bar, see _qbFullOpen)
  let _qbCompactSlots = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('roe_qbCompactSlots') || '[]');
      return new Set(Array.isArray(raw) ? raw.filter(n => Number.isInteger(n) && n >= 0 && n <= 9) : []);
    } catch { return new Set(); }
  })();
  let _qbCompactShowHand = localStorage.getItem('roe_qbCompactShowHand') !== 'false'; // default: true
  function _saveQBCompactSlots() { localStorage.setItem('roe_qbCompactSlots', JSON.stringify([..._qbCompactSlots])); }
  let _durSliderRow   = null; // persistent DOM element — survives renderQBPane redraws
  let _durSliderDragging = false; // true while user drags the slider
  (function hookNativeConsole() {
    const _origLog = pageWindow.console.log.bind(pageWindow.console);
    pageWindow.console.log = function (...args) {
      _origLog(...args);
      if (_allLogsStopped) return;
      try {
        const msg = sanitizeLogData(args.map(a => typeof a === 'string' ? a : '').join(' '));
        if (!msg) return;
        // Log to wsLog with CON dir so it appears in log pane
        const entry = { ts: Date.now(), dir: 'CON', event: 'console', data: msg };
        wsRingBuffer.push(entry);
        if (_captureAll || msg.includes('DAMAGE') || msg.includes('Hit Left') || msg.includes('Hit Right') || msg.includes('DeltaBail') || msg.includes('QuickBar') || msg.includes('ReapplyQS') || msg.includes('BRANCH')) {
          wsLog.push(entry);
          if (wsLog.length > MAX_UI_EVENTS) wsLog.splice(0, wsLog.length - MAX_UI_EVENTS);
          if (activeTab === 'log' || _poppedOut.has('log')) _scheduleLogRender();
        }
        // Durability tracking on hit
        if ((msg.includes('[DAMAGE-OUT-ACK]') || msg.startsWith('Hit Left:')) && _equippedWeaponInstanceId) {
          const item = _inventoryByInstance[_equippedWeaponInstanceId];
          if (item && item.MaxDurability > 0 && item.Durability > 0) {
            const prevDur = item.Durability;
            item.Durability = Math.max(0, item.Durability - DURABILITY_PER_HIT);
            _saveQBInventoryState();
            if (activeTab === 'qb' || _poppedOut.has('qb')) renderQBPane();
            if (activeTab === 'chest' || _poppedOut.has('chest')) renderChestPane();
            // Update durability overlay from live tracking value (not waiting for server inventory)
            const _durEl = document.getElementById('roeDurWarn');
            if (_durEl) {
              if (item.Durability === 0 && prevDur > 0) {
                // Just broke this tick — show the BROKEN toast and skip the
                // warn/hide branch entirely so it can't flash off in the same update.
                const _brokenMsg = `🔴 ${formatItemId(item.itemId)} BROKEN!`;
                _lastBrokenToastInstanceId = item.instanceId;
                _showDurBrokenMsg(_durEl, _brokenMsg);
                setTimeout(() => notifyTrack(null, _brokenMsg), 0);
              } else if (item.Durability > 0 && item.Durability <= _durWarnThreshold * 5) {
                const pct = item.Durability / item.MaxDurability;
                const col = pct > 0.1 ? '#ca6' : '#e55';
                _durEl.textContent = `⚠️ ${formatItemId(item.itemId)} ${Math.ceil(item.Durability/5)}/${Math.ceil(item.MaxDurability/5)} hits left!`;
                _durEl.style.animation = 'roeBlink 1s step-start infinite';
                _durEl.style.display = 'block';
                if (prevDur > _durWarnThreshold * 5) {
                  const _warnMsg = `⚠️ ${formatItemId(item.itemId)} ${Math.ceil(item.Durability/5)}/${Math.ceil(item.MaxDurability/5)} hits left!`;
                  setTimeout(() => notifyTrack(null, _warnMsg), 0);
                }
              } else if (Date.now() >= _durBrokenUntil) {
                _durEl.style.display = 'none';
              }
            }
          }
        }
      } catch(e) {}
    };
  })();

  // ─── exportLogs() — download all log files without loading them into RAM ─────
  async function exportLogs() {
    const st = persistentLogger._st;
    if (!st.ready) { alert('[ROE logger] Logger not ready yet.'); return; }
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `roe-wslog-${ts}.ndjson`;

    if (st.useIDB) {
      const rows = await new Promise((res, rej) => {
        const tx  = st.idbDb.transaction('ev', 'readonly');
        const req = tx.objectStore('ev').getAll();
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
      });
      const blob = new Blob([rows.map(r => r.line).join('\n') + '\n'],
                            { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }

    // OPFS: pass array of File objects to Blob() — browser streams them
    // from disk without loading the full content into JS heap.
    const blobs = [];
    for (let i = OPFS_MAX_FILES - 1; i >= 1; i--) {
      try {
        const fh = await st.dirHandle.getFileHandle(`wslog.${i}.ndjson`);
        blobs.push(await fh.getFile());
      } catch {}
    }
    try {
      const fh = await st.dirHandle.getFileHandle(st.fileName);
      blobs.push(await fh.getFile());
    } catch {}

    if (!blobs.length) { alert('[ROE logger] No log files found.'); return; }
    const blob = new Blob(blobs, { type: 'application/x-ndjson' });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
    console.log(`[ROE logger] exported ${blobs.length} segment(s), ~${(blob.size / 1024 / 1024).toFixed(1)} MB`);
  }

  // ─── clearAllLogs() — wipe ALL persistent log storage + UI buffer ────────────
  async function clearAllLogs() {
    const st = persistentLogger._st;

    // 1. Clear UI ring buffer and display log
    wsLog.length = 0;
    wsLogSkippedCount = 0;
    wsRingBuffer.length = 0;

    if (!st.ready) return;

    if (st.useIDB) {
      // IndexedDB fallback — clear the entire object store
      await new Promise(res => {
        try {
          const tx    = st.idbDb.transaction('ev', 'readwrite');
          const store = tx.objectStore('ev');
          const req   = store.clear();
          req.onsuccess = res;
          req.onerror   = res;
          st.idbSeq = 0;
        } catch { res(); }
      });
    } else {
      // OPFS — delete all rotated slots then truncate the current file
      for (let i = OPFS_MAX_FILES - 1; i >= 1; i--) {
        try { await st.dirHandle.removeEntry(`wslog.${i}.ndjson`); } catch {}
      }
      try {
        const fh = await st.dirHandle.getFileHandle(st.fileName, { create: true });
        const w  = await fh.createWritable({ keepExistingData: false });
        await w.close();
      } catch {}
      st.fileSize = 0;
    }

    // 2. Also flush any pending queue so nothing gets written after the wipe
    st.queue.length = 0;

    console.log('[ROE logger] All logs cleared by user');
  }

  // Marketplace
  const marketListings = new Map();
  const marketSales = [];
  const marketShopPrices = new Map();
  const marketPendingRequests = [];
  let marketLastListingsAt = 0;
  let marketLastSalesAt = 0;
  let marketLastPricesAt = 0;
  let marketPagesLoaded = 0;
  let marketRefreshSeenIds = null;
  let marketExpandedGroups = new Set();
  let marketEthUsd = 0;
  let marketEthUsdUpdatedAt = 0;
  let marketEthUsdLoading = false;
  let marketEthUsdError = '';

  // ─── Chest / Inventory state ──────────────────────────────────────────────────
  let _chestSearch = '';
  let _chestSortBy = 'value_desc'; // 'value_desc' | 'qty_desc' | 'name_asc'

  const WS_LOG_SKIP = new Set([
    'move', 'move_ack',
    'worldclock_save', 'worldclock_save_ack',
    'ping', 'pong',
    'stats',
    'inventory',
    'quickselect',
    'quickbar_set', 'quickbar_set_ack',
    'gameinfo_get', 'gameinfo_ack',
    'item_pickup',       'item_pickup_ack',
    'combat_hit',        'combat_hit_ack',
    'gather_hit',        'gather_hit_ack',
    'inventory_equip',   'inventory_equip_ack',
    'inventory_transfer','inventory_transfer_ack',
    'random', 'random_result',
    'resource_cooldown',
    'sync_minimap', 'sync_cooldowns', 'request_spawn_state',
    'player:drop', 'player:drop:completed', 'loot_drop',
    'active_buffs', 'sync_buffs',
    'player:sleep', 'sleep_ack',
    'quests',
    // NOTE: 'take_damage' and 'player:damage:taken' were removed from this
    // skip list on purpose (temporary block-timing investigation) — we need
    // real timestamps of enemy hits in the log to compare against the
    // player's right-mouse-button block presses (see rmb_down/rmb_up below).
    // Re-add them here once the timing question is answered, to cut log noise.
  ]);

  // ─── Log sanitization — strips Bearer tokens and other secrets ──────────────
  // Matches JWT-shaped tokens: three base64url segments separated by dots.
  const _JWT_RE = /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g;
  // Also catch bare tokens assigned/printed without "Bearer " prefix
  const _TOKEN_FIELDS = new Set(['authToken', 'token', 'accessToken', 'refreshToken']);

  function _redactJwt(str) {
    return str.replace(_JWT_RE, 'Bearer [REDACTED]');
  }

  function sanitizeLogData(data) {
    if (typeof data === 'string') {
      return _redactJwt(data);
    }
    if (data === null || typeof data !== 'object') return data;
    if (Array.isArray(data)) return data.map(sanitizeLogData);
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (_TOKEN_FIELDS.has(k) && typeof v === 'string') {
        // Keep first 10 chars of header so you can still identify the token type
        out[k] = v.slice(0, 10) + '…[REDACTED]';
      } else if (typeof v === 'string') {
        out[k] = _redactJwt(v);
      } else if (typeof v === 'object' && v !== null) {
        out[k] = sanitizeLogData(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Log pane can receive many events per second during combat (WS events,
  // filtered console lines). Rendering synchronously on every single one
  // replaces the pane's innerHTML mid-interaction, which can destroy a
  // button between mousedown and click and make clicks appear to "not
  // register". Coalesce bursts into at most one render per animation frame,
  // and additionally suppress re-render entirely while a click is in flight.
  let _logRenderScheduled = false;
  let _logPointerDown = false;
  function _scheduleLogRender() {
    if (_logRenderScheduled) return;
    _logRenderScheduled = true;
    requestAnimationFrame(() => {
      _logRenderScheduled = false;
      renderLogPane();
    });
  }

  function addWsLog(dir, event, data) {
    if (_allLogsStopped) return;
    const safeData = sanitizeLogData(data);
    const entry = { ts: Date.now(), dir, event, data: safeData };
    wsRingBuffer.push(entry);                        // always capture for 5-min ring buffer
    persistentLogger.enqueue(dir, event, safeData);  // ← persistent write (all events)
    // Block-timing investigation: take_damage is the client's own report of
    // an enemy attack tick (see rmb_down/rmb_up above) — isBlocking/damage
    // tell us the outcome, but not whether RMB was actually held down at
    // that instant from OUR measured rmb_down/up log, which is the ground
    // truth we actually want to compare against. Compute and log it here.
    if (event === 'take_damage' && data) {
      const heldNow = _rmbDownAt !== null; // RMB currently down per our own listeners
      addSysLog('block_result', {
        entityIndex: data.entityIndex, enemyType: data.enemyType,
        damage: data.damage, isBlocking: data.isBlocking,
        rmbHeldPerOurListener: heldNow,
        rmbDownAt: _rmbDownAt, tickAt: entry.ts,
        heldForMsBeforeTick: heldNow ? (entry.ts - _rmbDownAt) : null,
        mismatch: heldNow !== !!data.isBlocking
      });
    }
    if (!_captureAll && WS_LOG_SKIP.has(event)) {
      wsLogSkippedCount++;
      return;
    }
    wsLog.push(entry);
    // Cap UI buffer — prevents RAM growth during long sessions
    if (wsLog.length > MAX_UI_EVENTS) wsLog.splice(0, wsLog.length - MAX_UI_EVENTS);
    if (activeTab === 'log' || _poppedOut.has('log')) _scheduleLogRender();
  }

  function addSysLog(handler, data) {
    if (_allLogsStopped) return;
    const safeData = sanitizeLogData(data);
    const entry = { ts: Date.now(), dir: 'SYS', event: handler, data: safeData };
    wsRingBuffer.push(entry);                        // always capture for ring buffer
    persistentLogger.enqueue('SYS', handler, safeData); // ← persistent write
    wsLog.push(entry);
    if (wsLog.length > MAX_UI_EVENTS) wsLog.splice(0, wsLog.length - MAX_UI_EVENTS);
    if (activeTab === 'log' || _poppedOut.has('log')) _scheduleLogRender();
  }

  // ─── Block-timing investigation: log right-mouse-button hold (the game's
  // block/parry input) so its real-world timestamps can be compared in the
  // log against enemy-hit events (take_damage / player:damage:taken) to work
  // out the actual block window, instead of guessing at "~0.5s before impact".
  // Capture phase + passive so this can never interfere with the game's own
  // handling of the right-click (no preventDefault, no stopPropagation).
  let _rmbDownAt = null;
  document.addEventListener('mousedown', e => {
    if (e.button !== 2) return;
    _rmbDownAt = Date.now();
    addSysLog('rmb_down', { ts: _rmbDownAt });
  }, { capture: true, passive: true });
  document.addEventListener('mouseup', e => {
    if (e.button !== 2) return;
    const upAt = Date.now();
    addSysLog('rmb_up', { ts: upAt, heldMs: _rmbDownAt ? (upAt - _rmbDownAt) : null });
    _rmbDownAt = null;
  }, { capture: true, passive: true });

  // ─── fix: zones already seen this session ────────────────────────────────────
  let _seenZones = new Set();

  // ─── Current zone ─────────────────────────────────────────────────────────────
  let _currentZone = null;

  // ─── Damage Log state ──────────────────────────────────────────────────────
  // Rolling feed of combat events (outgoing hits/kills, incoming hits/blocks,
  // player deaths) — session-only, cleared on reload — plus running totals,
  // which ARE persisted to localStorage so they accumulate across
  // reloads/sessions instead of resetting. Only "Reset stats" clears totals.
  const DAMAGE_LOG_MAX_FEED = 300;
  const DAMAGE_LOG_STORAGE_KEY = 'roeDamageLog';
  const _emptyDamageStats = () => ({
    dmgDealt: 0, dmgTaken: 0, blockedCount: 0, unblockedCount: 0,
    hits: 0, crits: 0, kills: 0, deaths: 0,
    byEnemy: {}, // enemyType -> { dmgDealt, dmgTaken, hits, kills, timesKilledBy }
  });
  let _damageFeed = [];         // newest first: { ts, kind: 'hit'|'kill'|'incoming'|'death', ... } — NOT persisted
  let _damageStats = _emptyDamageStats();
  // UI sub-state for the Damage tab — declared here (not down near
  // renderDamagePane) because restoring a previously-open floating panel on
  // page load calls setTab() -> applyCompactMode() -> renderDamagePane()
  // during early init, before the file's execution has reached a `let`
  // declared further down — that throws "Cannot access before
  // initialization" the moment a Damage panel is restored open.
  let _damageSubTab = 'feed';      // 'feed' | 'stats'
  let _damageFeedFilter = 'ALL';   // 'ALL' | 'dealt' | 'incoming' | 'death'
  (function _loadDamageLog() {
    try {
      const raw = localStorage.getItem(DAMAGE_LOG_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.stats) _damageStats = Object.assign(_emptyDamageStats(), parsed.stats, { byEnemy: parsed.stats.byEnemy || {} });
    } catch (_) {}
  })();
  let _damageLogSaveScheduled = false;
  function _saveDamageLog() {
    if (_damageLogSaveScheduled) return;
    _damageLogSaveScheduled = true;
    // Coalesce bursts (e.g. several hits in the same combat tick) into one
    // write instead of hitting localStorage on every single event.
    setTimeout(() => {
      _damageLogSaveScheduled = false;
      try {
        localStorage.setItem(DAMAGE_LOG_STORAGE_KEY, JSON.stringify({ stats: _damageStats }));
      } catch (_) {}
    }, 500);
  }
  function _damageFeedPush(entry) {
    _damageFeed.unshift(entry);
    if (_damageFeed.length > DAMAGE_LOG_MAX_FEED) _damageFeed.length = DAMAGE_LOG_MAX_FEED;
    _saveDamageLog();
    if (activeTab === 'damage' || _poppedOut.has('damage')) renderDamagePane();
  }
  function _damageStatsForEnemy(enemyType) {
    if (!_damageStats.byEnemy[enemyType]) {
      _damageStats.byEnemy[enemyType] = { dmgDealt: 0, dmgTaken: 0, hits: 0, kills: 0, timesKilledBy: 0 };
    }
    return _damageStats.byEnemy[enemyType];
  }

  // ─── Zones restricted to current-zone-only visibility in tracking ─────────────
  const ZONE_RESTRICTED = new Set(['Forest', 'Mines']);

  // ─── Notify cooldowns ────────────────────────────────────────────────────────
  let _notifyCooldowns   = new Map();
  const NOTIFY_COOLDOWN_MS      = 60_000;
  const NOTIFY_COOLDOWN_STORAGE = 'roeSpawnMonitor_notifyCooldowns';

  function saveNotifyCooldowns() {
    try {
      const obj = {};
      _notifyCooldowns.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(NOTIFY_COOLDOWN_STORAGE, JSON.stringify(obj));
    } catch (e) {}
  }

  function loadNotifyCooldowns() {
    try {
      const raw = localStorage.getItem(NOTIFY_COOLDOWN_STORAGE);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const now = Date.now();
      Object.entries(obj).forEach(([k, v]) => {
        if (typeof v === 'number' && (now - v) < NOTIFY_COOLDOWN_MS) {
          _notifyCooldowns.set(k, v);
        }
      });
    } catch (e) {}
  }

  let _hooked_socket = null;

  // ─── Storage keys ────────────────────────────────────────────────────────────
  const TRACK_STORAGE_KEY          = 'roeSpawnMonitor_tracked';
  const WORLD_SNAPSHOT_STORAGE_KEY = 'roeSpawnMonitor_worldSnapshot';
  const RESPAWN_DUR_STORAGE_KEY    = 'roeSpawnMonitor_respawnDurations';
  const RES_DUR_STORAGE_KEY        = 'roeSpawnMonitor_resDurations';
  const STORAGE_KEY                = 'roeSpawnMonitor_filters';
  const NOTIFY_STORAGE_KEY         = 'roeSpawnMonitor_notifyPrefs';
  const TAB_ORDER_STORAGE_KEY      = 'roeSpawnMonitor_tabOrder';
  const PANEL_STORAGE_KEY          = 'roeSpawnMonitor_panel';
  const PANEL_POS_STORAGE_KEY      = 'roeSpawnMonitor_panelPos';
  const CHROME_HIDDEN_KEY          = 'roeSpawnMonitor_chromeHidden';
  const PANEL_PIN_STORAGE_KEY      = 'roeSpawnMonitor_panelPin';
  const SEEN_ZONES_STORAGE_KEY     = 'roeSpawnMonitor_seenZones';
  const MARKET_STORAGE_KEY         = 'roeSpawnMonitor_marketSnapshot';
  const STABLE_MOB_TIMERS_KEY      = 'roeSpawnMonitor_stableMobTimers';
  const STABLE_RES_TIMERS_KEY      = 'roeSpawnMonitor_stableResTimers';
  const TRACK_ORDER_STORAGE_KEY    = 'roeSpawnMonitor_trackOrder';
  const FLOAT_POS_STORAGE_KEY      = 'roeSpawnMonitor_floatPos';
  const FLOAT_OPEN_STORAGE_KEY     = 'roeSpawnMonitor_floatOpen';
  const MINIMAP_TAB_STORAGE_KEY    = 'roeSpawnMonitor_minimapTabOn';

  // ─── Floating panels state ────────────────────────────────────────────────────
  const _poppedOut   = new Set();   // tab keys currently floating
  const _floatPanels = {};          // tabKey → floating div element
  let _stickyPanels  = localStorage.getItem('roeStickyPanels') === '1'; // move floats with main panel

  // ─── Collapse state for Res/Mobs group rows ──────────────────────────────────
  const _expandedResGroups  = new Set(); // gkey strings that are expanded
  const _expandedMobGroups  = new Set(); // "zone_statsKey" strings that are expanded

  const TAB_KEY_TO_ID = { state: 'tabState', res: 'tabRes', track: 'tabTrack', market: 'tabMarket', chest: 'tabChest', log: 'tabLog', qb: 'tabQB', damage: 'tabDamage' };
  const TAB_LABELS    = { state: '👾 Mobs', res: '🌿 Res', track: '🔔 Track', market: '$ Market', chest: '📦 Bag & Chest', log: '📋 Log', qb: '🛡️ Durability', damage: '⚔️ Damage' };

  function saveFloatOpen() {
    try { localStorage.setItem(FLOAT_OPEN_STORAGE_KEY, JSON.stringify(Array.from(_poppedOut))); } catch (_) {}
  }

  function saveFloatPositions() {
    // Merge with previously saved data so closing one panel doesn't wipe others
    const pos = loadFloatPositions();
    Object.entries(_floatPanels).forEach(([key, el]) => {
      pos[key] = {
        left:   parseInt(el.style.left)  || pos[key]?.left  || 100,
        top:    parseInt(el.style.top)   || pos[key]?.top   || 100,
        width:  parseInt(el.style.width) || pos[key]?.width || 220,
        height: parseInt(el.style.height) || pos[key]?.height || null,
      };
    });
    try { localStorage.setItem(FLOAT_POS_STORAGE_KEY, JSON.stringify(pos)); } catch (_) {}
  }
  function loadFloatPositions() {
    try { return JSON.parse(localStorage.getItem(FLOAT_POS_STORAGE_KEY) || '{}'); } catch (_) { return {}; }
  }

  // ⚠️ THIS is where tab panels actually get their real-world size/layout ⚠️
  // Every toolbar tab button calls toggleFloat() -> popOutTab() -> here.
  // The docked `panel`/setTab() elsewhere in the file is effectively unused
  // (nobody pops tabs back into it in normal play) — width/height/resize
  // fixes belong in THIS function (`fp.style.cssText` below and the
  // per-tab width/height/resize-handle conditionals throughout it), not in
  // setTab(). See the warning comment on setTab() for the postmortem.
  function makeFloatingPanel(tabKey) {
    if (_floatPanels[tabKey]) return _floatPanels[tabKey];
    const savedPos = loadFloatPositions();
    const sp = savedPos[tabKey] || {};
    const startLeft = sp.left != null ? sp.left : (100 + Object.keys(_floatPanels).length * 30);
    const startTop  = sp.top  != null ? sp.top  : (100 + Object.keys(_floatPanels).length * 30);
    const qbSaved   = tabKey === 'qb' ? loadQBFullSize() : null;
    // Compact QB (not full view) still gets an explicit starting width instead of
    // 'auto' when we have a cached name-column measurement from a previous
    // session — otherwise the panel paints once at its native shrink-to-fit
    // width (collapsed/undersized, since content isn't measured yet) and then
    // jumps to the fitted px width a frame later once renderQBPane's fit
    // logic runs. Priming it here means the first paint is already correct.
    const qbCompactStartW = (tabKey === 'qb' && !_qbFullOpen && _qbCompactNameColWidth > 0)
      ? (_qbCompactNameColWidth + QB_NAME_COL_BUFFER + 60) // + room for badge/icon/durability columns
      : null;
    const startW    = (tabKey === 'track' || (tabKey === 'qb' && !_qbFullOpen) || tabKey === 'chest')
      ? qbCompactStartW
      : (tabKey === 'qb' ? (qbSaved ? qbSaved.width : QB_FULL_WIDTH) : (sp.width ?? 220));
    const isAutoHeight = tabKey === 'track' || (tabKey === 'qb' && !_qbFullOpen) || tabKey === 'chest';
    const isAutoHeightNow = () => tabKey === 'track' || (tabKey === 'qb' && !_qbFullOpen) || tabKey === 'chest';
    const startH    = isAutoHeight ? null : (tabKey === 'qb' ? (qbSaved ? qbSaved.height : QB_FULL_HEIGHT) : (sp.height ?? null));
    const minW      = (tabKey === 'track' || (tabKey === 'qb' && !_qbFullOpen) || tabKey === 'chest') ? 0 : 160;

    const fp = document.createElement('div');
    const heightCss = (tabKey === 'chest' || tabKey === 'market' || tabKey === 'damage') ? 'height:600px;' : (startH ? 'height:' + startH + 'px;' : '');
    const widthCss = (tabKey === 'chest' || tabKey === 'market') ? 'width:650px;' : tabKey === 'damage' ? 'width:300px;' : (startW != null ? ('width:' + startW + 'px;') : 'width:auto;');
    fp.style.cssText = 'position:fixed;z-index:10000010;left:' + startLeft + 'px;top:' + startTop + 'px;' + widthCss + heightCss + 'background:#0d0d14;border:1px solid #2a2a4a;border-radius:6px;box-shadow:0 4px 24px rgba(0,0,0,0.8);display:flex;flex-direction:column;font-family:monospace;min-width:' + minW + 'px;min-height:0;max-height:95vh;overflow:hidden;';

    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 6px;background:#13132a;border-bottom:1px solid #2a2a4a;cursor:move;user-select:none;flex-shrink:0;border-radius:6px 6px 0 0;';
    const titleSpan = document.createElement('span');
    titleSpan.style.cssText = 'color:#7b8fff;font-size:11px;font-weight:bold;';
    titleSpan.textContent = TAB_LABELS[tabKey];
    const closeBtn = document.createElement('button');
    if (tabKey === 'track') {
      closeBtn.textContent = '⚙️';
      closeBtn.title = 'Open full Track view';
      closeBtn.style.cssText = 'background:none;border:none;color:#7b8fff;cursor:pointer;font-size:12px;padding:0 2px;line-height:1;';
      closeBtn.onclick = () => openTrackFullView();
    } else if (tabKey === 'qb') {
      if (_qbFullOpen) {
        closeBtn.textContent = 'Back';
        closeBtn.title = 'Back to compact Durability view';
        closeBtn.style.cssText = 'background:none;border:1px solid #444;color:#aaa;cursor:pointer;font-size:10px;padding:1px 7px;line-height:1.5;border-radius:3px;';
        closeBtn.onclick = () => closeQBFullView();
      } else {
        closeBtn.textContent = '⚙️';
        closeBtn.title = 'Open full Durability view';
        closeBtn.style.cssText = 'background:none;border:none;color:#7b8fff;cursor:pointer;font-size:12px;padding:0 2px;line-height:1;';
        closeBtn.onclick = () => openQBFullView();
      }
    } else {
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'background:none;border:none;color:#555;cursor:pointer;font-size:11px;padding:0 2px;line-height:1;';
      closeBtn.onmouseenter = () => { closeBtn.style.color = '#e55'; };
      closeBtn.onmouseleave = () => { closeBtn.style.color = '#555'; };
      closeBtn.onclick = () => dockTab(tabKey);
    }

    function _makeToggleBtn(label, getState, onToggle) {
      const btn = document.createElement('button');
      const update = () => {
        const on = getState();
        btn.textContent = label;
        btn.style.cssText = `background:none;border:1px solid ${on ? '#4caf50' : '#444'};color:${on ? '#4caf50' : '#666'};cursor:pointer;font-size:10px;padding:0 4px;line-height:1.6;border-radius:3px;margin-left:3px;`;
      };
      update();
      btn.onclick = () => { onToggle(); update(); };
      return btn;
    }

    titleBar.appendChild(titleSpan);

    if (tabKey === 'qb') {
    }

    titleBar.appendChild(closeBtn);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'roe-float-content';
    contentDiv.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;min-height:0;';

    fp.appendChild(titleBar);
    fp.appendChild(contentDiv);

    // Resize handle (bottom-right corner)
    const resizeHandle = document.createElement('div');
    resizeHandle.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:se-resize;z-index:2;opacity:0.5;';
    if (tabKey === 'track' || (tabKey === 'qb' && !_qbFullOpen) || tabKey === 'chest' || tabKey === 'damage' || tabKey === 'market') resizeHandle.style.display = 'none';
    resizeHandle.innerHTML = '<svg width="10" height="10" style="position:absolute;right:2px;bottom:2px;" viewBox="0 0 10 10"><path d="M9 1L1 9M9 5L5 9M9 9" stroke="#7b8fff" stroke-width="1.5" stroke-linecap="round"/></svg>';
    fp.appendChild(resizeHandle);

    document.body.appendChild(fp);

    // Resize
    let resizing = false, resStartX = 0, resStartY = 0, resStartW = 0, resStartH = 0;
    resizeHandle.addEventListener('mousedown', e => {
      resizing  = true;
      resStartX = e.clientX;
      resStartY = e.clientY;
      resStartW = fp.offsetWidth;
      resStartH = fp.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      const newW = Math.max(minW, resStartW + (e.clientX - resStartX));
      fp.style.width = newW + 'px';
      if (!isAutoHeightNow()) {
        const newH = Math.max(30, resStartH + (e.clientY - resStartY));
        fp.style.height = newH + 'px';
      }
      if (_ovScrollRefresh) _ovScrollRefresh();
    });
    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        fp.style.width = fp.offsetWidth + 'px';
        if (!isAutoHeightNow()) fp.style.height = fp.offsetHeight + 'px';
        if (tabKey === 'qb' && _qbFullOpen) {
          saveQBFullSize(fp.offsetWidth, fp.offsetHeight);
        } else {
          saveFloatPositions();
        }
      }
    });

    // ResizeObserver for compact mode on the floating track panel
    if (tabKey === 'track' && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(entries => {
        if (!_poppedOut.has('track')) return;
        const w = entries[0].contentRect.width;
        const mode = w < 200 ? 'micro' : w < 320 ? 'compact' : 'full';
        if (mode !== _compactMode) {
          _compactMode = mode;
          renderTrackPane();
        }
      }).observe(fp);
    }

    // Drag
    let dx = 0, dy = 0, dragging = false;
    // Keep titleBar cursor in sync with pin state
    function _updateFpCursor() {
      titleBar.style.cursor = panelPinned ? 'default' : 'move';
    }
    _updateFpCursor();
    fp._updateCursor = _updateFpCursor; // expose so applyPinState can call it
    fp._resizeHandle = resizeHandle;    // expose so track full-view can lock size
    fp._closeBtn     = closeBtn;        // expose so track full-view can swap ✕ for Back
    titleBar.addEventListener('mousedown', e => {
      if (e.target === closeBtn) return;
      if (panelPinned) return; // pinned — no drag
      dragging = true;
      dx = e.clientX - fp.offsetLeft;
      dy = e.clientY - fp.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      fp.style.left = Math.max(0, Math.min(window.innerWidth  - fp.offsetWidth,  e.clientX - dx)) + 'px';
      fp.style.top  = Math.max(0, Math.min(window.innerHeight - fp.offsetHeight, e.clientY - dy)) + 'px';
      if (_ovScrollRefresh) _ovScrollRefresh();
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        fp.style.left = Math.max(0, Math.min(window.innerWidth  - fp.offsetWidth,  fp.offsetLeft)) + 'px';
        fp.style.top  = Math.max(0, Math.min(window.innerHeight - fp.offsetHeight, fp.offsetTop))  + 'px';
        saveFloatPositions();
      }
    });

    _floatPanels[tabKey] = fp;
    return fp;
  }

  function popOutTab(tabKey) {
    if (_poppedOut.has(tabKey)) return;
    _poppedOut.add(tabKey);
    saveFloatOpen();
    const btn = document.getElementById(TAB_KEY_TO_ID[tabKey]);
    if (btn) { btn.style.opacity = ''; btn.title = ''; }
    const fp = makeFloatingPanel(tabKey);
    renderTabContent(tabKey);
    if (typeof _updateTabBtnHighlight === 'function') _updateTabBtnHighlight(tabKey);
    // Apply correct compact mode after panel is rendered in DOM (offsetWidth is 0 before layout)
    if (tabKey === 'track') {
      requestAnimationFrame(() => {
        const w = fp.offsetWidth || parseInt(fp.style.width) || 220;
        const mode = w < 200 ? 'micro' : w < 320 ? 'compact' : 'full';
        if (mode !== _compactMode) {
          _compactMode = mode;
          renderTrackPane();
        }
      });
    }
  }

  function dockTab(tabKey) {
    if (!_poppedOut.has(tabKey)) return;
    // Save position and size before removing the element
    saveFloatPositions();
    _poppedOut.delete(tabKey);
    saveFloatOpen();
    const fp = _floatPanels[tabKey];
    if (fp) { fp.remove(); delete _floatPanels[tabKey]; }
    const btn = document.getElementById(TAB_KEY_TO_ID[tabKey]);
    if (btn) { btn.style.opacity = ''; btn.title = ''; }
    // Restore compact mode based on main panel width
    if (tabKey === 'track') {
      const w = panel.offsetWidth || 0;
      _compactMode = w < 200 ? 'micro' : w < 320 ? 'compact' : 'full';
      _trackFullOpen = false;
    }
    if (tabKey === 'qb') {
      _qbFullOpen = false;
    }
    if (typeof _updateTabBtnHighlight === 'function') _updateTabBtnHighlight(tabKey);
    saveFloatPositions();
  }

  function renderTabContent(tabKey) {
    if (tabKey === 'state')  renderStatePane();
    if (tabKey === 'res')    renderResPane();
    if (tabKey === 'track')  renderTrackPane();
    if (tabKey === 'market') renderMarketPane();
    if (tabKey === 'chest')  renderChestPane();
    if (tabKey === 'log')    renderLogPane();
    if (tabKey === 'damage') renderDamagePane();
    if (tabKey === 'qb')     renderQBPane();
  }

  // ─── Seen zones load/save ────────────────────────────────────────────────────
  function saveSeenZones() {
    try { localStorage.setItem(SEEN_ZONES_STORAGE_KEY, JSON.stringify(Array.from(_seenZones))); } catch (e) {}
  }

  function loadSeenZones() {
    try {
      const raw = localStorage.getItem(SEEN_ZONES_STORAGE_KEY);
      if (!raw) return;
      JSON.parse(raw).forEach(z => _seenZones.add(z));
    } catch (e) {}
  }

  // ─── Serializers ─────────────────────────────────────────────────────────────
  function serializeTrackedNodes(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map(n => ({
      idx:   typeof n.idx === 'number' ? n.idx : null,
      id:    n.id ?? null,
      active: n.active === true,
      alive:  n.alive  === true,
      hp:    Number(n.hp)    || 0,
      maxHp: Number(n.maxHp) || 0,
      pos:   { x: Number(n?.pos?.x) || 0, y: Number(n?.pos?.y) || 0 }
    }));
  }

  function serializeWorldEnemies(enemies) {
    return (Array.isArray(enemies) ? enemies : []).map(e => ({
      id:         e.id ?? null,
      entityIndex:e.entityIndex ?? null,
      statsKey:   e.statsKey || '',
      type:       e.type     || '',
      alive:      e.alive    === true,
      hp:    Number(e.hp)    || 0,
      maxHp: Number(e.maxHp) || 0,
      respawnAt: typeof e.respawnAt === 'number' ? e.respawnAt : null,
      pos:   { x: Number(e?.pos?.x) || 0, y: Number(e?.pos?.y) || 0 }
    }));
  }

  function serializeWorldResources(resources) {
    return (Array.isArray(resources) ? resources : []).map((r, idx) => ({
      idx:      typeof r.idx === 'number' ? r.idx : idx,
      id:       r.id       ?? null,
      resource: r.resource || '',
      type:     r.type     || '',
      rarity:   r.rarity   || '',
      weakness: r.weakness || '',
      active:   r.active   === true,
      hp:    Number(r.hp)    || 0,
      maxHp: Number(r.maxHp) || 0,
      cooldownExpiresAt: typeof r.cooldownExpiresAt === 'number' ? r.cooldownExpiresAt : null,
      pos:   { x: Number(r?.pos?.x) || 0, y: Number(r?.pos?.y) || 0 }
    }));
  }

  function rebuildPrevEnemiesFromSnapshot() {
    const restored = { __zones: {} };
    Object.entries(lastStateByZone).forEach(([zone, enemies]) => {
      restored.__zones[zone] = true;
      enemies.forEach(e => { if (e && e.id != null) restored[e.id] = { ...e }; });
    });
    prevEnemies = restored;
  }

  function saveRespawnDurations() {
    try {
      const obj = {};
      knownRespawnDurations.forEach((ms, key) => { obj[key] = ms; });
      localStorage.setItem(RESPAWN_DUR_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {}
  }

  function loadRespawnDurations() {
    try {
      const raw = localStorage.getItem(RESPAWN_DUR_STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      Object.entries(obj).forEach(([key, ms]) => {
        if (typeof ms === 'number' && ms > 0) knownRespawnDurations.set(key, ms);
      });
    } catch (e) {}
  }

  function saveResDurations() {
    try {
      const obj = {};
      knownResDurations.forEach((ms, key) => { obj[key] = ms; });
      localStorage.setItem(RES_DUR_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {}
  }

  function loadResDurations() {
    try {
      const raw = localStorage.getItem(RES_DUR_STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      Object.entries(obj).forEach(([key, ms]) => {
        if (typeof ms === 'number' && ms > 0) knownResDurations.set(key, ms);
      });
    } catch (e) {}
  }

  // ─── World snapshot ──────────────────────────────────────────────────────────
  function saveWorldSnapshot() {
    try {
      const sz = {}, rz = {};
      Object.entries(lastStateByZone).forEach(([z, e])     => { sz[z] = serializeWorldEnemies(e); });
      Object.entries(lastResourcesByZone).forEach(([z, r]) => { rz[z] = serializeWorldResources(r); });
      localStorage.setItem(WORLD_SNAPSHOT_STORAGE_KEY, JSON.stringify({
        lastStateByZone: sz, lastResourcesByZone: rz,
        knownZones:    Array.from(knownZones),
        knownTypes:    Array.from(knownTypes),
        knownResNames: Array.from(knownResNames)
      }));
    } catch (e) {}
  }

  function loadWorldSnapshot() {
    try {
      const raw = localStorage.getItem(WORLD_SNAPSHOT_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      const rsz = {}, rrz = {};
      Object.entries(p.lastStateByZone     || {}).forEach(([z, e]) => { rsz[z] = serializeWorldEnemies(e); });
      Object.entries(p.lastResourcesByZone || {}).forEach(([z, r]) => { rrz[z] = serializeWorldResources(r); });
      lastStateByZone = rsz; lastResourcesByZone = rrz;
      knownZones    = new Set(Array.isArray(p.knownZones)    ? p.knownZones    : []);
      knownTypes    = new Set(Array.isArray(p.knownTypes)    ? p.knownTypes    : []);
      knownResNames = new Set(Array.isArray(p.knownResNames) ? p.knownResNames : []);
      Object.keys(rsz).forEach(z => knownZones.add(z));
      Object.keys(rrz).forEach(z => knownZones.add(z));
      Object.values(rsz).forEach(es => es.forEach(e => knownTypes.add(e.statsKey)));
      Object.values(rrz).forEach(rs => rs.forEach(r => knownResNames.add(r.resource)));
      rebuildPrevEnemiesFromSnapshot();
      _reseedTimersFromSnapshot();
    } catch (e) {}
  }

  function _reseedTimersFromSnapshot() {
    const now = Date.now();
    Object.values(lastResourcesByZone).forEach(resources => {
      resources.forEach(r => {
        if (!r.active && r.cooldownExpiresAt && r.cooldownExpiresAt > now) {
          // See getNodeMaxTimer: resourceRespawnTimers keys carry a per-type
          // resourceNodeId suffix (not always 0), so check by prefix here
          // rather than assuming `${idx}:0` — otherwise a real timer under
          // e.g. `${idx}:3` looks absent and gets silently duplicated/missed.
          if (!getNodeMaxTimer(r.idx)) resourceRespawnTimers.set(`${r.idx}:0`, r.cooldownExpiresAt);
        }
      });
    });
    Object.values(lastStateByZone).forEach(enemies => {
      enemies.forEach(e => {
        if (!e.alive && e.respawnAt && e.respawnAt > now) enemyRespawnTimers.set(e.id, e.respawnAt);
      });
    });
  }

  // ─── Reseed in-memory timers from stable storage + tracked nodes ─────────────
  // Called once after loadTracked() + _loadStableTimers() both complete.
  // Fixes the "orange squares after reload" bug: loadTracked() restores
  // nodes with active:false / alive:false but resourceRespawnTimers /
  // enemyRespawnTimers are in-memory Maps (cleared on reload).  Without this
  // reseed the render code sees "dead node, no timer" → draws orange.
  //
  // Strategy:
  //   Resources – match dead tracked node by position → _stableResTimers[zone|x|y]
  //               → inject expiresAt into resourceRespawnTimers[idx:0]
  //   Mobs      – match dead tracked node by (zone, statsKey, pos)
  //               → _stableMobTimers[zone|statsKey|x|y]
  //               → inject respawnAt into enemyRespawnTimers[n.id]
  //               (n.id is stale after reload but the render reads the same
  //                stale id from the saved node, so the lookup still works
  //                until the next live spawn_state replaces the nodes)
  function _reseedTimersFromTracked() {
    const now = Date.now();

    trackedResources.forEach(v => {
      const zone = v.zone;
      v.nodes.forEach(n => {
        if (n.active || n.idx == null) return;
        // Same resourceNodeId-suffix caveat as getNodeMaxTimer — check by
        // prefix, not a hardcoded `${idx}:0`.
        if (getNodeMaxTimer(n.idx)) return;                    // already seeded
        if (!n.pos) return;
        const pk    = _resPosKey(zone, n.pos);
        const entry = _stableResTimers[pk];
        if (entry && entry.expiresAt > now) {
          resourceRespawnTimers.set(`${n.idx}:0`, entry.expiresAt);
        }
      });
    });

    trackedMobs.forEach(v => {
      const zone     = v.zone;
      const statsKey = v.statsKey;
      v.nodes.forEach(n => {
        if (n.alive || n.id == null) return;
        if (enemyRespawnTimers.has(n.id)) return;             // already seeded
        if (!n.pos) return;
        const pk         = _mobPosKey(zone, statsKey, n.pos);
        const respawnAt  = _stableMobTimers[pk];
        if (respawnAt && respawnAt > now) {
          enemyRespawnTimers.set(n.id, respawnAt);
        }
      });
    });
  }

  // ─── Tracked save/load ───────────────────────────────────────────────────────
  function saveTracked() {
    try {
      const resources = [], mobs = [];
      trackedResources.forEach((v, k) => resources.push({
        id: k, zone: v.zone, resource: v.resource, type: v.type,
        rarity: v.rarity, weakness: v.weakness, notifyOnSpawn: v.notifyOnSpawn,
        notifyOnlyWhenFull: v.notifyOnlyWhenFull === true,
        nodes: serializeTrackedNodes(v.nodes)
      }));
      trackedMobs.forEach((v, k) => mobs.push({
        id: k, zone: v.zone, statsKey: v.statsKey, type: v.type,
        notifyOnSpawn: v.notifyOnSpawn, notifyOnlyWhenFull: v.notifyOnlyWhenFull === true,
        nodes: serializeTrackedNodes(v.nodes)
      }));
      localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify({ resources, mobs, counter: trackIdCounter }));
    } catch (e) {}
  }

  function loadTracked() {
    try {
      const raw = localStorage.getItem(TRACK_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      const resources = Array.isArray(p.resources) ? p.resources : (p.arr || []);
      const mobs      = Array.isArray(p.mobs)      ? p.mobs      : [];
      trackIdCounter  = p.counter || 0;
      resources.forEach(item => {
        const nodes = serializeTrackedNodes(item.nodes);
        trackedResources.set(item.id, { kind: 'resource', zone: item.zone, resource: item.resource,
          type: item.type, rarity: item.rarity, weakness: item.weakness,
          notifyOnSpawn: item.notifyOnSpawn !== false, notifyOnlyWhenFull: item.notifyOnlyWhenFull === true, nodes });
        const aC = nodes.filter(n => n.active).length;
        previousTrackedStates.set(item.id, { activeCount: aC, readyCount: aC });
      });
      mobs.forEach(item => {
        const nodes = serializeTrackedNodes(item.nodes);
        trackedMobs.set(item.id, { kind: 'mob', zone: item.zone, statsKey: item.statsKey,
          type: item.type, notifyOnSpawn: item.notifyOnSpawn !== false, notifyOnlyWhenFull: item.notifyOnlyWhenFull === true, nodes });
        const alivC = nodes.filter(n => n.alive).length;
        previousTrackedMobStates.set(item.id, { aliveCount: alivC, readyCount: alivC });
      });
    } catch (e) {}
  }

  // ─── Track display order helpers ─────────────────────────────────────────────
  function _saveTrackOrder() {
    try { localStorage.setItem(TRACK_ORDER_STORAGE_KEY, JSON.stringify(_trackDisplayOrder)); } catch (_) {}
  }
  function _loadTrackOrder() {
    try { const r = localStorage.getItem(TRACK_ORDER_STORAGE_KEY); if (r) _trackDisplayOrder = JSON.parse(r); } catch (_) {}
  }
  // Moves dragIds to the position of dropId within the same zone+kind bucket.
  function _reorderTrackEntry(dragIds, dropId, kind, zone) {
    dragIds = Array.isArray(dragIds) ? dragIds : [dragIds];
    const map = kind === 'mob' ? trackedMobs : trackedResources;
    const ids = [];
    map.forEach((v, k) => { if (v.zone === zone) ids.push(k); });
    ids.sort((a, b) => (_trackDisplayOrder[a] ?? 9999) - (_trackDisplayOrder[b] ?? 9999));
    const cleaned = ids.filter(id => !dragIds.includes(id));
    const ti = cleaned.indexOf(dropId);
    if (ti === -1) return;
    cleaned.splice(ti, 0, ...dragIds);
    cleaned.forEach((id, i) => { _trackDisplayOrder[id] = i; });
    _saveTrackOrder();
  }
  // Attaches HTML5 drag-and-drop to a track row. id may be a string or array (variant group).
  function _attachTrackDrag(row, id, kind, zone) {
    const ids = Array.isArray(id) ? id : [id];
    const primaryId = ids[0];
    row.draggable = true;
    row.style.cursor = 'grab';
    row.addEventListener('dragstart', e => {
      _dragTrackId = ids; _dragTrackKind = kind; _dragTrackZone = zone;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => { row.style.opacity = '0.4'; }, 0);
    });
    row.addEventListener('dragend', () => { row.style.opacity = ''; row.style.borderTop = ''; });
    row.addEventListener('dragover', e => {
      const dragIds = Array.isArray(_dragTrackId) ? _dragTrackId : [_dragTrackId];
      if (dragIds.includes(primaryId) || _dragTrackKind !== kind || _dragTrackZone !== zone) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.style.borderTop = '2px solid #7b8fff';
    });
    row.addEventListener('dragleave', e => {
      if (!row.contains(e.relatedTarget)) row.style.borderTop = '';
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.style.borderTop = '';
      const dragIds = Array.isArray(_dragTrackId) ? _dragTrackId : [_dragTrackId];
      if (dragIds.includes(primaryId) || _dragTrackKind !== kind || _dragTrackZone !== zone) return;
      _reorderTrackEntry(_dragTrackId, primaryId, kind, zone);
      renderTrackPane();
    });
    // Prevent accidental drag when clicking buttons/inputs inside the row
    row.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') {
        row.draggable = false;
        const restore = () => { row.draggable = true; document.removeEventListener('mouseup', restore); };
        document.addEventListener('mouseup', restore);
      }
    });
  }

  function safeJsonParse(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function marketItemTypeName(type) {
    const map = {
      0: 'Tool', 1: 'Weapon', 2: 'Offhand', 3: 'Weapon',
      4: 'Wood', 5: 'Ore', 6: 'Consumable', 7: 'Material',
      8: 'Quest', 9: 'Gem', 10: 'Crafting', 11: 'Accessory',
      12: 'Armor', 13: 'Crafted', 14: 'Box'
    };
    return map[Number(type)] || `Type ${type ?? '?'}`;
  }

  function weiToEthString(rawWei, maxFrac = 6) {
    try {
      const wei = BigInt(String(rawWei || '0'));
      const base = 1000000000000000000n;
      const whole = wei / base;
      const frac = String(wei % base).padStart(18, '0');
      const trimmed = frac.slice(0, maxFrac).replace(/0+$/, '');
      return trimmed ? `${whole}.${trimmed}` : String(whole);
    } catch (e) {
      const n = Number(rawWei || 0) / 1e18;
      return Number.isFinite(n) ? n.toFixed(maxFrac).replace(/0+$/, '').replace(/\.$/, '') : '0';
    }
  }

  function marketTotalWei(priceWei, qty) {
    try { return BigInt(String(priceWei || '0')) * BigInt(Math.max(0, Number(qty) || 0)); }
    catch (e) { return 0n; }
  }

  function compareWei(a, b) {
    const av = BigInt(String(a || '0'));
    const bv = BigInt(String(b || '0'));
    return av < bv ? -1 : av > bv ? 1 : 0;
  }

  function shortAddress(addr) {
    const s = String(addr || '');
    return s.length > 14 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s;
  }

  function relativeAge(ts) {
    const t = Date.parse(ts || '');
    if (!Number.isFinite(t)) return '';
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 48) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
  }

  // Returns exact countdown from now to timestamp ms
  // Formats a raw duration in ms (e.g. 90000 → "1m 30s"), not a future timestamp
  function fmtDuration(ms) {
    if (!ms || ms <= 0) return '?';
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m.toString().padStart(2,'0')}m`;
    if (m > 0) return `${m}m ${s > 0 ? s.toString().padStart(2,'0') + 's' : ''}`.trim();
    return `${s}s`;
  }

  function fmtMs(ms) {
    const sec = Math.max(0, Math.floor((ms - Date.now()) / 1000));
    if (sec === 0) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m.toString().padStart(2,'0')}m ${s.toString().padStart(2,'0')}s`;
    if (m > 0) return `${m}m ${s.toString().padStart(2,'0')}s`;
    return `${s}s`;
  }

  // Returns colour for a respawn timer based on time remaining
  function timerColor(ms, estimated) {
    if (estimated) return '#7b6a3c';
    const sec = Math.max(0, Math.floor((ms - Date.now()) / 1000));
    if (sec < 60)  return '#e03030';   // < 1 min  — red
    if (sec < 300) return '#e07030';   // < 5 min  — orange
    return '#ffd700';                  // rest     — gold
  }

  // Word-segment dictionary for lowercase compound resource names.
  // Greedy longest-match: tries longest known word first at each position.
  const _WORDS = [
    'titanium','mourning','bloodroot','silverleaf','mistweed','moonpetal',
    'bronze','silver','copper','crystal',
    'shadow','golden','black','blood','dread','cinder','iron','gold','mist',
    'moon','god','oak','ore','wood','leaf','root','vine','weed','petal',
    'lily','rock','bone','bones','heart','dino','node','tree','flower',
  ].sort((a, b) => b.length - a.length); // longest first for greedy match

  // Strips trailing type-indicator suffixes already conveyed by the icon.
  // Keeps meaningful name parts (Vine, Lily, Leaf, Weed, Petal, etc).
  function formatResName(raw) {
    const name = formatDisplayName(raw);
    if (!name) return name;
    const stripped = name
      .replace(/ Ore Node$/, ' Ore')
      .replace(/ Node$/, '')
      .replace(/ Tree$/, '')
      .replace(/ Flower$/, '')
      .replace(/ Bones$/, '')
      .replace(/ Rock$/, '');
    // Crystal and Dino don't have "Ore" in their raw name but are ore resources
    return /^(Crystal|Dino)$/.test(stripped) ? stripped + ' Ore' : stripped;
  }

  function formatDisplayName(raw) {
    if (!raw) return raw;
    // PascalCase mob names (e.g. "OreElemental" → "Ore Elemental")
    if (/^[A-Z]/.test(raw)) {
      return raw.replace(/([A-Z])/g, ' $1').trim();
    }
    // Lowercase compound resource names (e.g. "godwoodtree" → "God Wood Tree")
    const words = [];
    let s = raw.toLowerCase();
    while (s.length > 0) {
      const match = _WORDS.find(w => s.startsWith(w));
      if (match) {
        words.push(match.charAt(0).toUpperCase() + match.slice(1));
        s = s.slice(match.length);
      } else {
        // unknown tail — capitalise and append as-is
        words.push(s.charAt(0).toUpperCase() + s.slice(1));
        break;
      }
    }
    return words.join(' ');
  }

  // Compresses a list of formatted names by factoring out the longest common
  // word suffix: ["Gold Ore Node", "Titanium Ore Node"] → "Gold / Titanium Ore Node"
  function compactGroupLabel(names) {
    if (names.length <= 1) return names[0] || '';
    const split   = names.map(n => n.split(' '));
    const minLen  = Math.min(...split.map(w => w.length));
    let suffixLen = 0;
    for (let i = 1; i <= minLen - 1; i++) {
      const tail = split[0].slice(split[0].length - i).join(' ');
      if (split.every(w => w.slice(w.length - i).join(' ') === tail)) suffixLen = i;
      else break;
    }
    if (suffixLen === 0) return names.join('|');
    const suffix   = split[0].slice(split[0].length - suffixLen).join(' ');
    const prefixes = split.map(w => w.slice(0, w.length - suffixLen).join(' ')).filter(Boolean);
    return prefixes.join('|') + ' ' + suffix;
  }

  function normalizeMarketItemId(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function weiToEthNumber(rawWei) {
    try { return Number(BigInt(String(rawWei || '0'))) / 1e18; }
    catch (e) { return Number(rawWei || 0) / 1e18; }
  }

  function formatNumber(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function formatUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '-';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function getMarketShopPrice(itemId) {
    const key = normalizeMarketItemId(itemId);
    return marketShopPrices.get(key) || null;
  }

  function getMerchantMetrics(listing) {
    const shop = getMarketShopPrice(listing.itemId);
    const sellPrice = Number(shop?.sellPrice || 0);
    const qty = Number(listing.qtyRemaining || 0);
    const runes = sellPrice > 0 && qty > 0 ? sellPrice * qty : 0;
    const eth = weiToEthNumber(listing.totalWei);
    const usd = marketEthUsd > 0 ? eth * marketEthUsd : 0;
    return {
      known: sellPrice > 0,
      sellPrice,
      runes,
      eth,
      usd,
      runesPerEth: eth > 0 && runes > 0 ? runes / eth : 0,
      runesPerUsd: usd > 0 && runes > 0 ? runes / usd : 0,
      usdPer1000Runes: usd > 0 && runes > 0 ? (usd / runes) * 1000 : 0
    };
  }

  function normalizeMarketListing(raw, existing) {
    const info = typeof raw.info === 'string' ? safeJsonParse(raw.info, {}) : (raw.info || {});
    const qtyRemaining = Number(raw.qtyRemaining ?? info.qty ?? raw.qtyTotal ?? 0) || 0;
    const qtyTotal = Number(raw.qtyTotal ?? info.qty ?? qtyRemaining) || qtyRemaining;
    const priceWei = String(raw.price ?? '0');
    const itemName = info.ItemName || info.itemName || raw.itemName || raw.itemId || 'Unknown item';
    const itemId = normalizeMarketItemId(info.ItemId || info.itemId || raw.itemId || itemName);
    return {
      id: String(raw._id || raw.id || raw.listingId || `${itemId}:${raw.seller}:${raw.createdAt}:${priceWei}`),
      itemName,
      itemId,
      itemType: Number(info.itemType ?? raw.itemType ?? -1),
      itemTypeName: marketItemTypeName(info.itemType ?? raw.itemType),
      level: Number(info.level ?? 0) || 0,
      durability: Number(info.durability ?? 0) || 0,
      durabilityMax: Number(info.durabilityMax ?? 0) || 0,
      qtyRemaining,
      qtyTotal,
      priceWei,
      totalWei: String(marketTotalWei(priceWei, qtyRemaining)),
      seller: raw.seller || '',
      isActive: raw.isActive !== false && raw.exists !== false && qtyRemaining > 0,
      createdAt: raw.createdAt || raw.updatedAt || '',
      updatedAt: raw.updatedAt || raw.createdAt || '',
      tx: raw.lastEventTxHash || raw.createdAtTxHash || '',
      block: raw.lastEventBlock || raw.createdAtBlock || null,
      firstSeenAt: existing?.firstSeenAt || Date.now(),
      lastSeenAt: Date.now()
    };
  }

  function saveMarketSnapshot() {
    try {
      localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify({
        listings: Array.from(marketListings.values()).slice(0, 2500),
        sales: marketSales.slice(0, 300),
        shopPrices: Array.from(marketShopPrices.values()),
        marketLastListingsAt,
        marketLastSalesAt,
        marketLastPricesAt,
        marketPagesLoaded,
        marketEthUsd,
        marketEthUsdUpdatedAt
      }));
    } catch (e) {}
  }

  function loadMarketSnapshot() {
    try {
      const raw = localStorage.getItem(MARKET_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      (Array.isArray(p.listings) ? p.listings : []).forEach(item => {
        if (item?.id) marketListings.set(item.id, item);
      });
      (Array.isArray(p.sales) ? p.sales : []).forEach(s => marketSales.push(s));
      (Array.isArray(p.shopPrices) ? p.shopPrices : []).forEach(item => {
        const key = normalizeMarketItemId(item.itemId);
        if (key) marketShopPrices.set(key, { itemId: key, buyPrice: Number(item.buyPrice) || 0, sellPrice: Number(item.sellPrice) || 0 });
      });
      marketLastListingsAt = p.marketLastListingsAt || 0;
      marketLastSalesAt = p.marketLastSalesAt || 0;
      marketLastPricesAt = p.marketLastPricesAt || 0;
      marketPagesLoaded = p.marketPagesLoaded || 0;
      marketEthUsd = Number(p.marketEthUsd || 0) || 0;
      marketEthUsdUpdatedAt = Number(p.marketEthUsdUpdatedAt || 0) || 0;
    } catch (e) {}
  }

  function noteMarketplaceRequest(event, payload) {
    if (event !== 'marketplace:getAllListings' && event !== 'marketplace:getGlobalSales') return;
    marketPendingRequests.push({ event, payload: payload || {}, ts: Date.now() });
    if (marketPendingRequests.length > 40) marketPendingRequests.shift();
  }

  function takeMarketplaceRequest(event) {
    const idx = marketPendingRequests.findIndex(r => r.event === event);
    if (idx === -1) return null;
    return marketPendingRequests.splice(idx, 1)[0];
  }

  function handleMarketplaceListingsResponse(data) {
    if (!data || data.ok === false) return;
    const req = takeMarketplaceRequest('marketplace:getAllListings');
    const listings = Array.isArray(data.data) ? data.data : [];
    const page = Number(req?.payload?.page || 0);
    const limit = Number(req?.payload?.limit || listings.length || 0);
    const activeOnly = req?.payload?.activeOnly !== false;

    if (page === 1) {
      marketRefreshSeenIds = new Set();
      marketPagesLoaded = 0;
    }
    if (!marketRefreshSeenIds) marketRefreshSeenIds = new Set();

    listings.forEach(raw => {
      const id = String(raw._id || raw.id || raw.listingId || '');
      const existing = id ? marketListings.get(id) : null;
      const normalized = normalizeMarketListing(raw, existing);
      marketListings.set(normalized.id, normalized);
      marketRefreshSeenIds.add(normalized.id);
    });

    if (activeOnly && limit > 0 && listings.length < limit && marketRefreshSeenIds.size > 0) {
      Array.from(marketListings.keys()).forEach(id => {
        if (!marketRefreshSeenIds.has(id)) marketListings.delete(id);
      });
      marketRefreshSeenIds = null;
    }

    marketLastListingsAt = Date.now();
    marketPagesLoaded += 1;
    saveMarketSnapshot();
    updateMarketTab();
    if (activeTab === 'market' || _poppedOut.has('market')) renderMarketPane();
    if (activeTab === 'chest')  renderChestPane();
  }

  function normalizeMarketSale(raw) {
    const info = typeof raw.info === 'string' ? safeJsonParse(raw.info, {}) : (raw.info || {});
    const qty = Number(info.qty ?? raw.qty ?? raw.qtyTotal ?? 0) || 0;
    const priceWei = String(raw.price ?? '0');
    return {
      id: String(raw._id || raw.id || `${raw.seller}:${raw.buyer}:${raw.createdAt}:${priceWei}`),
      itemName: info.ItemName || info.itemName || raw.itemId || 'Unknown item',
      itemId: info.ItemId || info.itemId || raw.itemId || '',
      itemTypeName: marketItemTypeName(info.itemType ?? raw.itemType),
      qty,
      priceWei,
      totalWei: String(marketTotalWei(priceWei, qty || 1)),
      seller: raw.seller || '',
      buyer: raw.buyer || '',
      createdAt: raw.createdAt || raw.updatedAt || '',
      seenAt: Date.now()
    };
  }

  function handleMarketplaceSalesResponse(data) {
    if (!data || data.ok === false) return;
    takeMarketplaceRequest('marketplace:getGlobalSales');
    const sales = Array.isArray(data.data) ? data.data : [];
    sales.forEach(raw => marketSales.unshift(normalizeMarketSale(raw)));
    const seen = new Set();
    for (let i = marketSales.length - 1; i >= 0; i--) {
      if (seen.has(marketSales[i].id)) marketSales.splice(i, 1);
      else seen.add(marketSales[i].id);
    }
    marketSales.splice(300);
    marketLastSalesAt = Date.now();
    saveMarketSnapshot();
    if (activeTab === 'market' || _poppedOut.has('market')) renderMarketPane();
  }

  function handleShopPricesAck(data) {
    if (!data?.success) return;
    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    items.forEach(item => {
      const key = normalizeMarketItemId(item.itemId);
      if (!key) return;
      marketShopPrices.set(key, {
        itemId: key,
        buyPrice: Number(item.buyPrice) || 0,
        sellPrice: Number(item.sellPrice) || 0
      });
    });
    if (items.length) {
      marketLastPricesAt = Date.now();
      saveMarketSnapshot();
      if (activeTab === 'market' || _poppedOut.has('market')) renderMarketPane();
      if (activeTab === 'chest')  renderChestPane();
      addSysLog('shop_prices', { count: items.length });
    }
  }

  function validEthUsdPrice(value) {
    const price = Number(String(value ?? '').replace(/[$,\s]/g, ''));
    return price > 100 && price < 100000 ? price : 0;
  }

  function parseEthUsdFromCoinMarketCapApi(text) {
    try {
      const json = typeof text === 'string' ? JSON.parse(text) : text;
      const statsPrice = validEthUsdPrice(json?.data?.statistics?.price);
      if (statsPrice) return statsPrice;

      const stack = [json];
      const seen = new Set();
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);

        const isEth = node.id === 1027 || node.slug === 'ethereum' ||
          (node.symbol === 'ETH' && String(node.name || '').toLowerCase() === 'ethereum');
        if (isEth) {
          const direct = validEthUsdPrice(node.price || node.priceUsd || node.close);
          if (direct) return direct;
          const quote = node.quote?.USD || node.quotes?.USD || node.statistics;
          const quoted = validEthUsdPrice(quote?.price || quote?.priceUsd);
          if (quoted) return quoted;
        }

        Object.values(node).forEach(v => {
          if (v && typeof v === 'object') stack.push(v);
        });
      }
    } catch (e) {}
    return 0;
  }

  function parseEthUsdFromCoinMarketCapHtml(html) {
    const text = String(html || '');
    try {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const xpath = '/html/body/div[1]/div[2]/div/div[2]/div/div/div[1]/div/section/div/div[2]/span';
      const node = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      const xpathPrice = validEthUsdPrice(node?.textContent);
      if (xpathPrice) return xpathPrice;
    } catch (e) {}

    const patterns = [
      /Ethereum price today is\s*\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/i,
      /Ethereum to USD Chart[\s\S]{0,2000}?\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/i,
      /"name"\s*:\s*"Ethereum"[\s\S]{0,3000}?"symbol"\s*:\s*"ETH"[\s\S]{0,3000}?"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i
    ];
    for (const re of patterns) {
      const m = text.match(re);
      const price = m ? validEthUsdPrice(m[1]) : 0;
      if (price) return price;
    }
    return 0;
  }

  function requestText(url, onOk, onFail) {
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json,text/html,application/xhtml+xml' },
        onload: res => onOk(res.responseText),
        onerror: onFail,
        ontimeout: onFail,
        timeout: 12000
      });
      return;
    }
    fetch(url).then(r => r.text()).then(onOk).catch(onFail);
  }

  function fetchEthUsdFromCoinMarketCap() {
    if (marketEthUsdLoading) return;
    marketEthUsdLoading = true;
    marketEthUsdError = '';
    if (activeTab === 'market' || _poppedOut.has('market')) renderMarketPane();

    const done = (price, err) => {
      marketEthUsdLoading = false;
      if (price > 0) {
        marketEthUsd = price;
        marketEthUsdUpdatedAt = Date.now();
        marketEthUsdError = '';
        saveMarketSnapshot();
        saveFilters();
      } else {
        marketEthUsdError = err || 'CMC parse failed';
      }
      if (activeTab === 'market' || _poppedOut.has('market')) renderMarketPane();
    };

    const apiUrl = 'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?id=1027&range=1D';
    const pageUrl = 'https://coinmarketcap.com/currencies/ethereum/';
    requestText(
      apiUrl,
      apiText => {
        const apiPrice = parseEthUsdFromCoinMarketCapApi(apiText);
        if (apiPrice) { done(apiPrice, null); return; }
        requestText(
          pageUrl,
          html => done(parseEthUsdFromCoinMarketCapHtml(html), 'CMC parse failed'),
          () => done(0, 'CMC request failed')
        );
      },
      () => {
        requestText(
          pageUrl,
          html => done(parseEthUsdFromCoinMarketCapHtml(html), 'CMC parse failed'),
          () => done(0, 'CMC request failed')
        );
      }
    );
  }

  // ─── Panel position save/load ─────────────────────────────────────────────────
  function savePanelPos() {
    try {
      localStorage.setItem(PANEL_POS_STORAGE_KEY, JSON.stringify({
        left: panel.offsetLeft,
        top:  panel.offsetTop
      }));
    } catch (e) {}
  }

  function loadPanelPos() {
    try {
      const raw = localStorage.getItem(PANEL_POS_STORAGE_KEY);
      if (!raw) return false;
      const p = JSON.parse(raw);
      if (typeof p.left === 'number' && typeof p.top === 'number') {
        panel.style.right = 'auto';
        panel.style.left  = p.left + 'px';
        panel.style.top   = p.top  + 'px';
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ─── Panel pin save/load ─────────────────────────────────────────────────────
  function savePanelPin(pinned) {
    try { localStorage.setItem(PANEL_PIN_STORAGE_KEY, pinned ? '1' : '0'); } catch (e) {}
  }

  function loadPanelPin() {
    try { return localStorage.getItem(PANEL_PIN_STORAGE_KEY) === '1'; } catch (e) { return false; }
  }

  // ─── Filters ─────────────────────────────────────────────────────────────────
  let filterZone   = 'ALL';
  let filterType   = 'ALL';
  let filterStatus = 'ALL';

  let resFilterZone   = 'ALL';
  let resFilterType   = 'ALL';
  let resFilterName   = 'ALL';
  let resFilterStatus = 'ALL';

  let marketSearch = '';
  let marketTypeFilter = 'ALL';
  let marketSort = 'unit_asc';
  let marketRenderTimer = null;

  function scheduleMarketRender() {
    clearTimeout(marketRenderTimer);
    marketRenderTimer = setTimeout(() => {
      if (activeTab === 'market' || _poppedOut.has('market')) renderMarketPane();
    }, 250);
  }

  function saveFilters() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        filterZone, filterType, filterStatus,
        resFilterZone, resFilterType, resFilterName, resFilterStatus,
        marketSearch, marketTypeFilter, marketSort, marketEthUsd,
        resSearch: document.getElementById('roeResSearch')?.value || ''
      }));
    } catch (e) {}
  }

  const DEFAULT_NOTIFY_PREFS = { soundEnabled: true, desktopEnabled: false, toastEnabled: true };

  function loadNotifyPrefs() {
    try {
      const raw = localStorage.getItem(NOTIFY_STORAGE_KEY);
      const p   = raw ? JSON.parse(raw) : {};
      return {
        soundEnabled:   p.soundEnabled !== false,
        desktopEnabled: p.desktopEnabled === true &&
          typeof Notification !== 'undefined' && Notification.permission === 'granted',
        toastEnabled:   p.toastEnabled !== false
      };
    } catch (e) { return { ...DEFAULT_NOTIFY_PREFS }; }
  }

  function saveNotifyPrefs() {
    try { localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(notificationPrefs)); } catch (e) {}
  }

  function loadPanelState()  { return null; }
  function clearPanelState() { try { localStorage.removeItem(PANEL_STORAGE_KEY); } catch (e) {} }

  // ─── Experimental tabs (Market/Chest/Log/QB) — gated behind a warning ────
  const EXPERIMENTAL_KEY      = 'roeSpawnMonitor_experimentalEnabled';
  const EXPERIMENTAL_TAB_KEYS = ['market', 'chest', 'log'];
  function _loadExperimentalEnabled() {
    try { return localStorage.getItem(EXPERIMENTAL_KEY) === '1'; } catch (_) { return false; }
  }
  let _experimentalEnabled = _loadExperimentalEnabled();
  function _saveExperimentalEnabled() {
    try { localStorage.setItem(EXPERIMENTAL_KEY, _experimentalEnabled ? '1' : '0'); } catch (_) {}
  }

  const notificationPrefs = loadNotifyPrefs();

  loadTracked();
  _loadTrackOrder();
  loadWorldSnapshot();
  loadMarketSnapshot();
  loadNotifyCooldowns();
  loadSeenZones();
  loadRespawnDurations();
  _loadStableTimers();
  loadResDurations();
  // Must run after BOTH loadTracked() and _loadStableTimers() complete so that
  // tracked node positions and stable timers are both available.
  _reseedTimersFromTracked();

  // ─── Style helpers ───────────────────────────────────────────────────────────
  function btnStyle(bg) {
    return `background:${bg};color:#ccc;border:1px solid #444;border-radius:4px;
            padding:3px 8px;cursor:pointer;font-size:11px;font-family:monospace;`;
  }
  function selStyle() {
    return `background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:4px;
            padding:2px 4px;font-size:11px;font-family:monospace;`;
  }
  function tabStyle(active) {
    return `flex:1;padding:5px 8px;border:none;cursor:pointer;font-size:11px;font-family:monospace;
            background:${active ? '#1a1a2e' : '#0d0d0d'};
            color:${active ? '#7b8fff' : '#666'};
            border-bottom:2px solid ${active ? '#7b8fff' : 'transparent'};
            white-space:nowrap;`;
  }

  // ─── Confirm popover ─────────────────────────────────────────────────────────
  let _activeConfirm = null;

  function showConfirm(anchorEl, msg, onConfirm) {
    if (_activeConfirm) { _activeConfirm.remove(); _activeConfirm = null; }

    const pop = document.createElement('div');
    pop.style.cssText = `
      position:fixed;z-index:10000020;
      background:#1a1218;border:1px solid #c44;border-radius:5px;
      padding:7px 10px;display:flex;align-items:center;gap:7px;
      box-shadow:0 3px 14px rgba(0,0,0,0.8);font-family:monospace;font-size:11px;
      white-space:nowrap;
    `;
    pop.innerHTML = `<span style="color:#ccc">${msg}</span>`;

    const yesBtn = document.createElement('button');
    yesBtn.textContent = 'Yes';
    yesBtn.style.cssText = `background:#5a1a1a;color:#ff6b6b;border:1px solid #c44;
      border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;font-family:monospace;`;
    yesBtn.onmouseover = () => { yesBtn.style.background = '#7a1a1a'; };
    yesBtn.onmouseout  = () => { yesBtn.style.background = '#5a1a1a'; };

    const noBtn = document.createElement('button');
    noBtn.textContent = 'No';
    noBtn.style.cssText = `background:#1a1a2a;color:#888;border:1px solid #333;
      border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;font-family:monospace;`;
    noBtn.onmouseover = () => { noBtn.style.background = '#222236'; };
    noBtn.onmouseout  = () => { noBtn.style.background = '#1a1a2a'; };

    pop.appendChild(yesBtn);
    pop.appendChild(noBtn);
    document.body.appendChild(pop);
    _activeConfirm = pop;

    const rect = anchorEl.getBoundingClientRect();
    const pw = 220, ph = 40;
    let left = rect.left - pw + rect.width;
    let top  = rect.bottom + 4;
    if (left < 4) left = 4;
    if (top + ph > window.innerHeight) top = rect.top - ph - 4;
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';

    const close = () => { pop.remove(); _activeConfirm = null; document.removeEventListener('mousedown', outsideClick); };
    const outsideClick = e => { if (!pop.contains(e.target) && e.target !== anchorEl) close(); };

    yesBtn.onclick = e => { e.stopPropagation(); close(); onConfirm(); };
    noBtn.onclick  = e => { e.stopPropagation(); close(); };
    setTimeout(() => document.addEventListener('mousedown', outsideClick), 0);
  }

  // ─── Confirm popover (wrapping variant, for longer warning text) ──────────────
  function showConfirmWrap(anchorEl, msg, onConfirm) {
    if (_activeConfirm) { _activeConfirm.remove(); _activeConfirm = null; }

    const pop = document.createElement('div');
    pop.style.cssText = `
      position:fixed;z-index:10000020;width:250px;
      background:#1a1218;border:1px solid #c44;border-radius:5px;
      padding:9px 11px;display:flex;flex-direction:column;gap:8px;
      box-shadow:0 3px 14px rgba(0,0,0,0.8);font-family:monospace;font-size:11px;
    `;
    pop.innerHTML = `<span style="color:#ccc;white-space:normal;line-height:1.4;">${msg}</span>`;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:7px;';

    const yesBtn = document.createElement('button');
    yesBtn.textContent = 'Yes';
    yesBtn.style.cssText = `background:#5a1a1a;color:#ff6b6b;border:1px solid #c44;
      border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;font-family:monospace;`;
    yesBtn.onmouseover = () => { yesBtn.style.background = '#7a1a1a'; };
    yesBtn.onmouseout  = () => { yesBtn.style.background = '#5a1a1a'; };

    const noBtn = document.createElement('button');
    noBtn.textContent = 'No';
    noBtn.style.cssText = `background:#1a1a2a;color:#888;border:1px solid #333;
      border-radius:3px;padding:2px 8px;cursor:pointer;font-size:11px;font-family:monospace;`;
    noBtn.onmouseover = () => { noBtn.style.background = '#222236'; };
    noBtn.onmouseout  = () => { noBtn.style.background = '#1a1a2a'; };

    btnRow.appendChild(yesBtn);
    btnRow.appendChild(noBtn);
    pop.appendChild(btnRow);
    document.body.appendChild(pop);
    _activeConfirm = pop;

    const rect = anchorEl.getBoundingClientRect();
    const pw = 250;
    let left = rect.left - pw + rect.width;
    let top  = rect.bottom + 4;
    if (left < 4) left = 4;
    if (left + pw > window.innerWidth - 4) left = window.innerWidth - pw - 4;
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
    // Flip above the anchor if it would overflow the bottom of the viewport
    // (measured after insertion, since height depends on wrapped text).
    const ph = pop.offsetHeight;
    if (top + ph > window.innerHeight) pop.style.top = (rect.top - ph - 4) + 'px';

    const close = () => { pop.remove(); _activeConfirm = null; document.removeEventListener('mousedown', outsideClick); };
    const outsideClick = e => { if (!pop.contains(e.target) && e.target !== anchorEl) close(); };

    yesBtn.onclick = e => { e.stopPropagation(); close(); onConfirm(); };
    noBtn.onclick  = e => { e.stopPropagation(); close(); };
    setTimeout(() => document.addEventListener('mousedown', outsideClick), 0);
  }

  // ─── Panel ───────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'roeSpawnPanel';
  panel.style.cssText = `
    position:fixed;top:10px;right:10px;width:auto;
    background:rgba(10,10,10,0.97);color:#e0e0e0;
    font-family:'Consolas',monospace;font-size:12px;
    z-index:999999;border:1px solid #333;border-radius:6px;
    display:flex;flex-direction:column;
    box-shadow:0 4px 24px rgba(0,0,0,0.7);
    user-select:none;min-width:0;min-height:0;max-height:90vh;
    overflow:hidden;
  `;

  // ─── Tool warning notification (top-center overlay) ─────────────────────────
  const toolWarnEl = document.createElement('div');
  toolWarnEl.id = 'roeToolWarn';
  toolWarnEl.title = '';
  toolWarnEl.style.cssText = `
    position:fixed;top:15px;left:50%;transform:translateX(-50%);
    z-index:9999999;display:none;
    background:rgba(8,12,28,0.95);color:#fff;
    border:2px solid #e07000;border-radius:10px;
    padding:9px 26px 9px 18px;
    font-family:'Consolas',monospace;font-size:18px;font-weight:bold;
    pointer-events:none;white-space:nowrap;
    box-shadow:0 0 10px rgba(220,110,0,0.8),0 0 30px rgba(220,110,0,0.4),0 4px 16px rgba(0,0,0,0.8);
    animation:roeBlink 1s step-start infinite;
  `;
  document.body.appendChild(toolWarnEl);

  // ─── Durability warning notification (top-center overlay) ────────────────────
  const durWarnEl = document.createElement('div');
  durWarnEl.id = 'roeDurWarn';
  durWarnEl.style.cssText = `
    position:fixed;top:15px;left:50%;transform:translateX(-50%);
    z-index:9999997;display:none;
    background:rgba(8,12,28,0.95);color:#fff;
    border:2px solid #e07000;border-radius:10px;
    padding:9px 26px 9px 18px;
    font-family:'Consolas',monospace;font-size:18px;font-weight:bold;
    pointer-events:none;white-space:nowrap;
    box-shadow:0 0 10px rgba(220,110,0,0.8),0 0 30px rgba(220,110,0,0.4),0 4px 16px rgba(0,0,0,0.8);
  `;
  document.body.appendChild(durWarnEl);

  // ─── Claim warning notification (top-center overlay) ─────────────────────────
  const claimWarnEl = document.createElement('div');
  claimWarnEl.id = 'roeClaimWarn';
  claimWarnEl.style.cssText = `
    position:fixed;top:15px;left:50%;transform:translateX(-50%);
    z-index:9999998;display:none;
    background:rgba(8,12,28,0.95);color:#fff;
    border:2px solid #e07000;border-radius:10px;
    padding:9px 26px 9px 18px;
    font-family:'Consolas',monospace;font-size:18px;font-weight:bold;
    pointer-events:none;white-space:nowrap;
    box-shadow:0 0 10px rgba(220,110,0,0.8),0 0 30px rgba(220,110,0,0.4),0 4px 16px rgba(0,0,0,0.8);
    animation:roeBlink 1s step-start infinite;
  `;
  document.body.appendChild(claimWarnEl);

  // ─── Runestone warning notification (top-center overlay) ─────────────────────
  const runestoneWarnEl = document.createElement('div');
  runestoneWarnEl.id = 'roeRunestoneWarn';
  runestoneWarnEl.style.cssText = `
    position:fixed;top:15px;left:50%;transform:translateX(-50%);
    z-index:9999997;display:none;
    background:rgba(8,12,28,0.95);color:#fff;
    border:2px solid #e07000;border-radius:10px;
    padding:9px 26px 9px 18px;
    font-family:'Consolas',monospace;font-size:18px;font-weight:bold;
    pointer-events:none;white-space:nowrap;
    box-shadow:0 0 10px rgba(220,110,0,0.8),0 0 30px rgba(220,110,0,0.4),0 4px 16px rgba(0,0,0,0.8);
    animation:roeBlink 1s step-start infinite;
  `;
  document.body.appendChild(runestoneWarnEl);
  _domReady = true;

  // ─── Header ──────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = `
    padding:6px 8px;background:#1a1a2e;border-bottom:1px solid #333;
    border-radius:6px 6px 0 0;display:flex;align-items:center;gap:4px;
    flex-wrap:nowrap;cursor:grab;flex-shrink:0;width:max-content;min-width:100%;box-sizing:border-box;
  `;
  header.innerHTML = `
    <span id="roeTitle" style="color:#7b8fff;font-weight:bold;font-size:14px;white-space:nowrap;cursor:pointer;line-height:1;vertical-align:middle;font-family:monospace;">…</span>
    <span id="roeClaimCountdown" style="display:none;color:#aaa;font-size:11px;white-space:nowrap;"></span>
    <span id="roeNextClaim" style="display:none;color:#888;font-size:10px;white-space:nowrap;"></span>
    <span id="roeSpawnCount" style="display:none"></span>
    <div id="roeGearWrap" style="position:relative;display:inline-block;margin-left:auto;">
      <button id="roeGearBtn" title="Settings" style="${btnStyle('#222')}padding:2px 6px;font-size:12px;">⚙️</button>
      <div id="roeGearMenu" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:#1a1a2e;border:1px solid #444;border-radius:4px;padding:4px 4px;flex-direction:row;gap:4px;z-index:99999;white-space:nowrap;">
        <button id="roePinBtn"  title="Pin / Unpin panel" style="${btnStyle('#222')}padding:2px 6px;font-size:12px;">📌</button>
        <button id="roeEyeBtn"  title="Toggle auto-hide" style="${btnStyle('#222')}padding:2px 6px;font-size:12px;opacity:1;">👁️</button>
        <button id="roeMagnetBtn" title="Stick floating panels to main panel (move all together)" style="${btnStyle('#222')}padding:2px 6px;font-size:12px;opacity:1;">🧲</button>
        <button id="roeExperimentalBtn" title="Toggle experimental tabs: Market, Chest, Log" style="${btnStyle('#222')}padding:2px 6px;font-size:11px;">🧪 Experimental</button>
      </div>
    </div>
    <button id="roeMinBtn"  style="${btnStyle('#222')}padding:2px 6px;">▼</button>
  `;

  // ─── Hidden filter inputs ────────────────────────────────────────────────────
  const filterBar = document.createElement('div');
  filterBar.id = 'roeMobFilterBar';
  filterBar.style.cssText = 'display:none;height:0;padding:0;margin:0;border:none;overflow:hidden;';
  filterBar.innerHTML = `
    <select id="roeZoneFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeMobFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeStatusFilter"><option value="ALL" selected>ALL</option></select>
    <input type="checkbox" id="roeOnlyNew">
    <input id="roeSearch" type="text" value="">
  `;

  const resFilterBar = document.createElement('div');
  resFilterBar.id = 'roeResFilterBar';
  resFilterBar.style.cssText = 'display:none;height:0;padding:0;margin:0;border:none;overflow:hidden;';
  resFilterBar.innerHTML = `
    <select id="roeResZoneFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeResTypeFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeResNameFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeResStatusFilter"><option value="ALL" selected>ALL</option></select>
    <input id="roeResSearch" type="text" value="">
  `;

  // ─── Tabs ────────────────────────────────────────────────────────────────────
  const tabBar = document.createElement('div');
  tabBar.style.cssText = `display:flex;background:#0d0d0d;border-bottom:1px solid #222;flex-shrink:0;width:100%;min-width:0;`;

  const TAB_DEFS = [
    ['tabMarket', '🛒', 'Market'],
    ['tabTrack', '🔔', 'Track'],
    ['tabChest', '📦', 'Chest'],
    ['tabDamage', '⚔️', 'Damage'],
    ['tabLog',   '📋', 'Log'],
    ['tabQB',    '🛡️', 'Durability'],
    ['tabMap',   '🗺️', 'Map'],
  ];
  const TAB_ID_TO_KEY_STATIC = { tabState: 'state', tabRes: 'res', tabTrack: 'track', tabMarket: 'market', tabChest: 'chest', tabDamage: 'damage', tabLog: 'log', tabQB: 'qb', tabMap: 'map' };
  const _expTabWraps = {}; // tabKey -> wrapper element, for experimental tabs only
  TAB_DEFS.forEach(([id, icon, label]) => {
    const tabKey = TAB_ID_TO_KEY_STATIC[id];
    // Wrap in a relative container
    const wrap = document.createElement('div');
    wrap.className = 'roe-tab-wrap';
    wrap.style.cssText = 'position:relative;flex:1;display:flex;';

    const btn = document.createElement('button');
    btn.id = id;
    btn.style.cssText = tabStyle(false);
    btn.dataset.icon  = icon;
    btn.dataset.label = label;
    btn.textContent   = icon;

    wrap.appendChild(btn);
    tabBar.appendChild(wrap);

    if (EXPERIMENTAL_TAB_KEYS.includes(tabKey)) {
      _expTabWraps[tabKey] = wrap;
      if (!_experimentalEnabled) wrap.style.display = 'none';
    }
  });

  // Show/hide the experimental tab buttons and, when disabling, dock any of
  // them that are currently floating (they become fully inaccessible again).
  function _applyExperimentalTabsVisibility() {
    Object.keys(_expTabWraps).forEach(k => {
      _expTabWraps[k].style.display = _experimentalEnabled ? 'flex' : 'none';
    });
    if (!_experimentalEnabled) {
      EXPERIMENTAL_TAB_KEYS.forEach(k => { if (_poppedOut.has(k)) dockTab(k); });
    }
  }

  // ─── Content ─────────────────────────────────────────────────────────────────
  const content = document.createElement('div');
  content.id = 'roeContent';
  content.style.cssText = `flex:1;overflow-y:auto;overflow-x:hidden;padding:6px 6px 0;min-height:0;`;

  const statePane = document.createElement('div'); statePane.id = 'roeStatePane';
  const resPane   = document.createElement('div'); resPane.id   = 'roeResPane';   resPane.style.display   = 'none';
  const trackPane = document.createElement('div'); trackPane.id = 'roeTrackPane'; trackPane.style.display = 'none';
  const marketPane = document.createElement('div'); marketPane.id = 'roeMarketPane'; marketPane.style.display = 'none';
  const chestPane = document.createElement('div'); chestPane.id = 'roeChestPane'; chestPane.style.display = 'none';
  const logPane   = document.createElement('div'); logPane.id   = 'roeLogPane';   logPane.style.display   = 'none';
  const qbPane    = document.createElement('div'); qbPane.id    = 'roeQBPane';    qbPane.style.display    = 'none';
  const damagePane = document.createElement('div'); damagePane.id = 'roeDamagePane'; damagePane.style.display = 'none';

  content.appendChild(statePane);
  content.appendChild(resPane);
  content.appendChild(trackPane);
  content.appendChild(marketPane);
  content.appendChild(chestPane);
  content.appendChild(logPane);
  content.appendChild(qbPane);
  content.appendChild(damagePane);

  // ─── Resize handles (corner handles removed — right edge only) ────────────────
  const resizeHandleSW = document.createElement('div');
  resizeHandleSW.style.display = 'none';

  const resizeHandleSE = document.createElement('div');
  resizeHandleSE.style.display = 'none';

  // resizeHandleSE not appended — corner resize removed
  const _roeStyle = document.createElement('style');
  _roeStyle.textContent = `
    @keyframes roeBlink{0%,100%{opacity:1}50%{opacity:0}}
    .roe-float-content, #roeContent, #roeMazeMapResList, #roeMazeMapMobList {
      scrollbar-width: none;
    }
    .roe-float-content::-webkit-scrollbar,
    #roeContent::-webkit-scrollbar,
    #roeMazeMapResList::-webkit-scrollbar,
    #roeMazeMapMobList::-webkit-scrollbar {
      width: 0;
      height: 0;
    }
    .roe-ov-scrollbar-track {
      position: fixed;
      width: 12px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
      z-index: 10000030;
    }
    .roe-ov-scrollbar-track.roe-ov-visible {
      opacity: 1;
      pointer-events: auto;
    }
    .roe-ov-scrollbar-thumb {
      position: absolute;
      left: 3px;
      width: 6px;
      border-radius: 3px;
      background-color: #2a3050;
      cursor: pointer;
      transition: background-color 0.2s ease;
    }
    /* Invisible hit-area padding around the thumb so it's easier to grab —
       the visible bar stays 6px wide but the clickable/drag-start zone is
       wider, matching how native OS scrollbars are more forgiving to grab
       than their visual width suggests. */
    .roe-ov-scrollbar-thumb::before {
      content: '';
      position: absolute;
      left: -4px;
      right: -4px;
      top: 0;
      bottom: 0;
    }
    .roe-ov-scrollbar-thumb:hover {
      background-color: #3a4570;
    }
    .roe-tab-wrap + .roe-tab-wrap { border-left: 1px solid #26283a; }
    #roeMazeMap.roe-minimap-collapsed {
      border-color: transparent !important;
      background: transparent !important;
    }
    #roeMazeMap.roe-minimap-collapsed > *:not(#roeMazeMapCanvas) {
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(_roeStyle);


  // ─── Maze map (floating, shown only in Mines/MinesLower) ─────────────────────
  // Fills in as you walk: every visited spot gets plotted, auto-scaled to fit
  // whatever you've explored so far — no camera/zoom guessing needed since it's
  // an abstract map, not an overlay on the game's own rendering.
  let _mapDeleteMode = false; // when true, clicking the canvas removes the nearest point instead of panel drag
  try { _mapDeleteMode = localStorage.getItem('roeMazeMapDeleteMode') === '1'; } catch (_) {}
  // Separate toggle: when true, clicking the canvas only removes staircase
  // markers (white squares), ignoring trail dots — lets you pick off just
  // the unwanted ones without touching everything else.
  let _mapStairsDeleteMode = false;
  try { _mapStairsDeleteMode = localStorage.getItem('roeMazeMapStairsDeleteMode') === '1'; } catch (_) {}
  // Manual point-adding mode: clicking the canvas drops a trail point at
  // that world position, same as if the player had actually walked there —
  // useful for patching a gap or sketching a route without physically
  // covering the ground first.
  let _mapAddPointMode = false;
  try { _mapAddPointMode = localStorage.getItem('roeMazeMapAddPointMode') === '1'; } catch (_) {}
  // Scissors tool: clicking the canvas punches a cut into the trail's raw
  // paint layer at that world position (see _cutsFor/_paintTrailRange) —
  // clicking an existing cut removes it instead. The cuts themselves are
  // always applied to the baked trail; this only controls whether clicking
  // the map places/removes one, same shape as _mapAddPointMode above.
  let _mapCutMode = false;
  try { _mapCutMode = localStorage.getItem('roeMazeMapCutMode') === '1'; } catch (_) {}
  // Area-erase mode for cuts: click removes every cut point within
  // CUT_ERASE_RADIUS_PX (screen pixels) of the click, for quickly clearing a
  // patch of over-eager walk-cut points instead of removing them one by one.
  let _mapCutEraseMode = false;
  try { _mapCutEraseMode = localStorage.getItem('roeMazeMapCutEraseMode') === '1'; } catch (_) {}
  const CUT_ERASE_RADIUS_PX = 20;
  // Walk-and-cut: while on, a cut is dropped automatically at the player's
  // feet as they walk (throttled by distance, same grid as MAZE_TRAIL_MIN_STEP)
  // instead of needing a manual click per point — for tracing out a whole
  // narrow passage by just walking it. Independent of _mapCutMode/click
  // mode above; not part of the click-tool mutual-exclusion set since it
  // isn't a canvas-click tool. Always off on reload — this is a "hold my
  // hand while I do a specific task" mode, not a sticky preference, and an
  // accidentally-left-on state silently cutting the map on every future
  // walk would be a nasty surprise.
  let _mapCutWalkMode = false;
  let _mapCutWalkLastRawPos = null; // world {x,y} of the last move sample, used to interpolate cut points across fast/laggy movement (same idea as _mazeLastRawPos for the real trail)
  // Inverse of the 🪜✖ delete-stairs mode: clicking near a previously
  // deleted (blacklisted) staircase spot restores it — removes it from
  // _mazeStairsBlacklist and puts the marker back at its original position.
  // Only restores real deletions, never places a brand new marker wherever
  // you click.
  let _mapAddStairsMode = false;
  try { _mapAddStairsMode = localStorage.getItem('roeMazeMapAddStairsMode') === '1'; } catch (_) {}
  // Manual zoom multiplier — 1 = auto-fit to the whole explored area (the
  // default/original behavior). Scrolling the canvas zooms in/out around the
  // player's current position; the zoom-reset button snaps back to auto-fit.
  // Stored per map group (mines/minesLower/forest/custom zones/etc) rather
  // than as one shared value — each map's explored area is a different
  // size/shape, so a zoom level that's comfortable on one is usually wrong
  // for another.
  let _mapZoomByGroup = {};
  try {
    const savedZoomMap = JSON.parse(localStorage.getItem('roeMazeMapZoomByGroup') || '{}');
    if (savedZoomMap && typeof savedZoomMap === 'object') _mapZoomByGroup = savedZoomMap;
  } catch (_) {}
  // Legacy single-value key, migrated once into the current group's slot the
  // first time we know what group that is (see renderMazeMap) so anyone
  // upgrading doesn't just lose their existing zoom setting outright.
  let _legacyMapZoom = null;
  try {
    const savedZoomLegacy = parseFloat(localStorage.getItem('roeMazeMapZoom'));
    if (!isNaN(savedZoomLegacy)) _legacyMapZoom = savedZoomLegacy;
  } catch (_) {}
  let _mapZoom = 1;
  const MAP_ZOOM_MIN = 0.5, MAP_ZOOM_MAX = 8;
  let _mapZoomIndicatorUntil = 0; // Date.now() timestamp; indicator shows while now < this
  const MAP_ZOOM_INDICATOR_MS = 1400; // how long the "123%" readout stays visible after the last wheel tick
  let _mapZoomIndicatorTimer = null; // handle for the timeout that re-renders once to hide it
  // Loads _mapZoom for whichever group is about to be rendered — called at
  // the top of renderMazeMap so switching tabs/zones picks up that group's
  // own remembered zoom instead of carrying over whatever the previous
  // group happened to be showing.
  function _loadMapZoomFor(group) {
    if (Object.prototype.hasOwnProperty.call(_mapZoomByGroup, group)) {
      _mapZoom = _mapZoomByGroup[group];
    } else if (_legacyMapZoom !== null) {
      _mapZoom = _legacyMapZoom;
    } else {
      _mapZoom = 1;
    }
  }
  function _saveMapZoom(group) {
    _mapZoomByGroup[group] = _mapZoom;
    try { localStorage.setItem('roeMazeMapZoomByGroup', JSON.stringify(_mapZoomByGroup)); } catch (_) {}
  }
  let _lastRenderedMapGroup = null; // detects group changes so per-group zoom only reloads then, not every frame
  // Manual pan offset (world units), added on top of the auto-fit/zoom view.
  // Left-mouse-dragging the canvas shifts this; the 🔍 reset button and
  // zone/clear resets zero it back out along with the zoom.
  //
  // Deliberately NOT restored from localStorage on load: this is a raw
  // world-space offset, only meaningful relative to whatever map group
  // (Mines/Forest/a custom zone — each its own coordinate space) it was
  // recorded against. Every live zone transition already zeroes it out for
  // exactly this reason (see the _mapPanX = 0 resets scattered through the
  // zone-change handlers below) — restoring a stale value on page load,
  // when the current group may be completely different from whichever one
  // was on screen at last save, reintroduced that same mismatch as a
  // visible jump/shift on the very first render after reload.
  let _mapPanX = 0, _mapPanY = 0;
  function _saveMapPan() { try { localStorage.setItem('roeMazeMapPan', JSON.stringify({ x: _mapPanX, y: _mapPanY })); } catch (_) {} }
  // Follow mode: when true, the view re-centers on the player every frame
  // (like a camera-follow) instead of auto-fitting the whole explored area,
  // and manual left-drag panning is disabled while it's active.
  let _mapFollowPlayer = false;
  try { _mapFollowPlayer = localStorage.getItem('roeMazeMapFollow') === '1'; } catch (_) {}
  let _mapPanDragging = false; // true while a manual pan drag is in progress — lets the per-frame cursor sync in mazeMapTick avoid fighting the 'grabbing' cursor
  let _mapHoveringMarker = false; // true while the cursor sits over a mob/resource/entry/stairs marker — lets the per-frame cursor sync avoid fighting the hover handler's 'default' cursor
  // Enemy markers: all alive mobs in the zone are plotted by default now
  // (previously this was an opt-in toggle via the 👾 header button — that
  // button was removed and per-type visibility moved into the ⚙️ settings
  // popover's "Мобы на карте" list instead).
  const _mapShowAllMobs = true;

  // ─── Manual map viewing mode ───────────────────────────────────────────────
  // Auto (default): the widget only shows/tracks whichever zone the player is
  // actually standing in — original behavior.
  // Manual: the player picks any zone's map from a dropdown and it stays open
  // regardless of where they currently are. The live player dot / distance
  // readouts only draw when the manually-picked zone matches the real one
  // (recording of new trail data always follows the real zone either way).
  const MAP_MANUAL_MODE_KEY  = 'roeSpawnMonitor_mapManualMode';
  const MAP_MANUAL_GROUP_KEY = 'roeSpawnMonitor_mapManualGroup';
  let _mapManualMode = false;
  try { _mapManualMode = localStorage.getItem(MAP_MANUAL_MODE_KEY) === '1'; } catch (_) {}
  let _mapManualGroup = 'maze';
  try { _mapManualGroup = localStorage.getItem(MAP_MANUAL_GROUP_KEY) || 'maze'; } catch (_) {}
  function _saveMapManualMode()  { try { localStorage.setItem(MAP_MANUAL_MODE_KEY, _mapManualMode ? '1' : '0'); } catch (_) {} }
  function _saveMapManualGroup() { try { localStorage.setItem(MAP_MANUAL_GROUP_KEY, _mapManualGroup); } catch (_) {} }

  // ─── Minimap settings (⚙️) — line thickness + perf toggles ──────────────────
  const MINIMAP_SETTINGS_KEY = 'roeSpawnMonitor_minimapSettings';
  const MINIMAP_SETTINGS_DEFAULTS = { thickness: 1, fps: 20, glow: true, smoothing: false, bakeScale: 6, radiusScale: 1, hiddenResources: [], hiddenMobs: [], editMode: false, glitchEffect: true, stairsPreview: true };
  function _loadMinimapSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(MINIMAP_SETTINGS_KEY) || '{}');
      return { ...MINIMAP_SETTINGS_DEFAULTS, ...raw };
    } catch (_) { return { ...MINIMAP_SETTINGS_DEFAULTS }; }
  }
  let _minimapSettings = _loadMinimapSettings();
  function _saveMinimapSettings() {
    try { localStorage.setItem(MINIMAP_SETTINGS_KEY, JSON.stringify(_minimapSettings)); } catch (_) {}
  }
  const mazeMap = document.createElement('div');
  mazeMap.id = 'roeMazeMap';
  mazeMap.style.cssText = `
    position:fixed; z-index:99998; display:none;
    width:202px; padding:6px; box-sizing:border-box;
    background:rgba(20,20,30,0.9); border:1px solid #444; border-radius:10px;
    text-align:center; font-family:sans-serif; user-select:none;
  `;
  mazeMap.innerHTML = `
    <div id="roeMazeMapHandle" style="font-size:10px;color:#999;cursor:move;padding-bottom:4px;display:flex;justify-content:space-between;align-items:center;">
      <span id="roeMazeMapTitle" style="flex:1;min-width:0;text-align:left;">🗺️ MINE MAP</span>
      <span id="roeMazeMapCoords" style="flex:0 0 auto;text-align:center;font-size:11px;color:#e0e0e0;font-family:monospace;white-space:nowrap;"></span>
      <span style="flex:1;min-width:0;display:flex;justify-content:flex-end;gap:6px;">
        <span id="roeMazeMapFollow" title="Follow player (map re-centers on you as you move)" style="cursor:pointer;opacity:.7;">🎯</span>
        <span id="roeMazeMapSettings" title="Minimap settings" style="cursor:pointer;opacity:.7;">⚙️</span>
      </span>
    </div>
    <div id="roeMazeMapModeRow" style="display:flex;align-items:center;gap:4px;padding-bottom:4px;">
      <select id="roeMazeMapZoneSelect" title="Auto follows the zone you're actually in. Pick a specific map to switch to manual." style="flex:1;min-width:0;background:#0d0d0d;color:#eee;border:1px solid #333;border-radius:3px;font-size:10px;padding:2px;">
        <option value="auto">🔄 Auto</option>
        <option value="maze">🗺️ Mines (Combined)</option>
        <option value="mines">⛏️ Mines Upper</option>
        <option value="minesLower">⛏️ Mines Lower</option>
        <option value="forest">🌲 Forest</option>
      </select>
    </div>
    <div id="roeMazeMapClearPop" style="display:none;position:absolute;right:4px;top:26px;z-index:100010;background:#181828;border:1px solid #444;border-radius:6px;padding:8px 10px;font-size:11px;color:#ccc;text-align:left;width:150px;box-shadow:0 4px 16px rgba(0,0,0,0.6);">
      <div style="color:#ff8080;font-weight:bold;margin-bottom:6px;">🗑️ Какую карту очистить?</div>
      <div id="roeMazeMapClearMaze"       style="cursor:pointer;padding:4px 2px;border-radius:3px;">🗺️ Mines Full</div>
      <div id="roeMazeMapClearMines"      style="cursor:pointer;padding:4px 2px;border-radius:3px;">⛏️ Mines</div>
      <div id="roeMazeMapClearMinesLower" style="cursor:pointer;padding:4px 2px;border-radius:3px;">⛏️ Mines Lower</div>
      <div id="roeMazeMapClearForest"     style="cursor:pointer;padding:4px 2px;border-radius:3px;">🌲 Forest</div>
      <div id="roeMazeMapClearCustomList"></div>
    </div>
    <div id="roeMazeMapExportPop" style="display:none;position:absolute;right:180px;top:26px;z-index:100011;background:#181828;border:1px solid #444;border-radius:6px;padding:8px 10px;font-size:11px;color:#ccc;text-align:left;width:170px;box-shadow:0 4px 16px rgba(0,0,0,0.6);">
      <div style="color:#7bc6ff;font-weight:bold;margin-bottom:6px;">⬇️ Какую карту экспортировать?</div>
      <div id="roeMazeMapExportAll"        style="cursor:pointer;padding:4px 2px;border-radius:3px;">📦 Все карты</div>
      <div id="roeMazeMapExportMaze"       style="cursor:pointer;padding:4px 2px;border-radius:3px;">🗺️ Mines Full</div>
      <div id="roeMazeMapExportMines"      style="cursor:pointer;padding:4px 2px;border-radius:3px;">⛏️ Mines</div>
      <div id="roeMazeMapExportMinesLower" style="cursor:pointer;padding:4px 2px;border-radius:3px;">⛏️ Mines Lower</div>
      <div id="roeMazeMapExportForest"     style="cursor:pointer;padding:4px 2px;border-radius:3px;">🌲 Forest</div>
      <div id="roeMazeMapExportCustomList"></div>
    </div>
    <div id="roeMazeMapSettingsPop" style="display:none;position:absolute;right:4px;top:26px;z-index:100010;background:#181828;border:1px solid #444;border-radius:6px;padding:8px 10px;font-size:11px;color:#ccc;text-align:left;width:170px;box-shadow:0 4px 16px rgba(0,0,0,0.6);">
      <div style="color:#7b8fff;font-weight:bold;margin-bottom:6px;">🗺️ Настройки карты</div>
      <div style="display:flex;gap:6px;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #333;">
        <span id="roeMazeMapExport" title="Export map" style="cursor:pointer;opacity:.7;flex:1;text-align:center;">⬇️ Export</span>
        <span id="roeMazeMapImport" title="Import map" style="cursor:pointer;opacity:.7;flex:1;text-align:center;">⬆️ Import</span>
      </div>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #333;">
        <input type="checkbox" id="roeMazeMapEditMode" style="margin:0;">✏️ Edit Mode
      </label>
      <label style="display:block;margin-bottom:6px;">Толщина линии
        <select id="roeMazeMapThickness" style="width:100%;margin-top:2px;background:#0d0d0d;color:#eee;border:1px solid #333;border-radius:3px;font-size:11px;padding:2px;">
          <option value="0.6">Тонкая</option>
          <option value="1">Обычная</option>
          <option value="1.5">Толстая</option>
          <option value="2.2">Очень толстая</option>
        </select>
      </label>
      <label style="display:block;margin-bottom:6px;">Радиус тропы
        <select id="roeMazeMapRadiusScale" title="Уменьшает сам круг под точкой тропы, а не только размытие поверх него — сужает тропу физически, но при низких значениях диагональные проходы могут рваться на отдельные точки." style="width:100%;margin-top:2px;background:#0d0d0d;color:#eee;border:1px solid #333;border-radius:3px;font-size:11px;padding:2px;">
          <option value="1">Полный (без разрывов)</option>
          <option value="0.75">Узкий</option>
          <option value="0.55">Очень узкий</option>
        </select>
      </label>
      <label style="display:block;margin-bottom:6px;">Частота отрисовки
        <select id="roeMazeMapFps" style="width:100%;margin-top:2px;background:#0d0d0d;color:#eee;border:1px solid #333;border-radius:3px;font-size:11px;padding:2px;">
          <option value="10">Экономия (10 fps)</option>
          <option value="20">Обычная (20 fps)</option>
          <option value="30">Плавная (30 fps)</option>
          <option value="60">Максимум (60 fps)</option>
        </select>
      </label>
      <label style="display:block;margin-bottom:6px;">Качество тропы
        <select id="roeMazeMapBakeScale" style="width:100%;margin-top:2px;background:#0d0d0d;color:#eee;border:1px solid #333;border-radius:3px;font-size:11px;padding:2px;">
          <option value="6">Высокое</option>
          <option value="3">Среднее</option>
          <option value="1.5">Низкое (экономия FPS)</option>
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
        <input type="checkbox" id="roeMazeMapGlow" style="margin:0;">Свечение по краю
      </label>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;margin-top:4px;">
        <input type="checkbox" id="roeMazeMapSmoothing" style="margin:0;">Сглаживание тропы
      </label>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;margin-top:4px;">
        <input type="checkbox" id="roeMazeMapGlitch" style="margin:0;">Глитч на пустых картах
      </label>
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;margin-top:4px;">
        <input type="checkbox" id="roeMazeMapStairsPreview" style="margin:0;">Превью лестницы заранее
      </label>
      <div style="margin-top:8px;border-top:1px solid #333;padding-top:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Ресурсы на карте</span>
          <span>
            <span id="roeMazeMapResAll" style="cursor:pointer;color:#7b8fff;">все</span> /
            <span id="roeMazeMapResNone" style="cursor:pointer;color:#7b8fff;">нет</span>
          </span>
        </div>
        <div id="roeMazeMapResList" style="max-height:120px;overflow-y:auto;"></div>
      </div>
      <div style="margin-top:8px;border-top:1px solid #333;padding-top:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span>Мобы на карте</span>
          <span>
            <span id="roeMazeMapMobAll" style="cursor:pointer;color:#7b8fff;">все</span> /
            <span id="roeMazeMapMobNone" style="cursor:pointer;color:#7b8fff;">нет</span>
          </span>
        </div>
        <div id="roeMazeMapMobList" style="max-height:120px;overflow-y:auto;"></div>
      </div>
    </div>
    <canvas id="roeMazeMapCanvas" width="186" height="186" style="display:block;border-radius:6px;background:#0d0d0d;border:1px solid #333;cursor:grab;"></canvas>
    <div id="roeMazeMapTooltip" style="display:none;position:absolute;z-index:99999;pointer-events:none;background:#14141e;border:1px solid #555;border-radius:5px;padding:4px 9px;font-size:14px;color:#eee;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>
    <div id="roeMazeMapEditRow" style="display:none;justify-content:center;flex-wrap:wrap;gap:6px;margin-top:4px;">
      <span id="roeMazeMapClearStairs" title="Delete staircase markers: click this, then click each unwanted one" style="cursor:pointer;opacity:.7;">🪜✖</span>
      <span id="roeMazeMapAddStairs" title="Click near a previously-deleted staircase marker to restore it (removes it from the blacklist) — does not place new markers" style="cursor:pointer;opacity:.7;">🪜➕</span>
      <span id="roeMazeMapDeleteMode" title="Click points (or staircase markers) on the map to remove them" style="cursor:pointer;opacity:.7;">🖊️</span>
      <span id="roeMazeMapAddPointMode" title="Click the map to manually drop a trail point there" style="cursor:pointer;opacity:.7;">📍</span>
      <span id="roeMazeMapCutMode" title="Click the map to punch a cut into the trail — severs two nearby passages that blur/smoothing bridged together. Click an existing cut (shown as a red dot) to remove it. Cuts stay invisible/applied outside Edit Mode." style="cursor:pointer;opacity:.7;">✂️</span>
      <span id="roeMazeMapCutWalkMode" title="Walk mode: while active, cuts are dropped automatically at your feet as you walk instead of needing manual clicks — useful for tracing out a narrow passage." style="cursor:pointer;opacity:.7;">🚶✂️</span>
      <span id="roeMazeMapCutEraseMode" title="Area-erase cuts: click a spot to remove every cut point within a radius of it — handy for clearing a patch of walk-cut points at once instead of one by one." style="cursor:pointer;opacity:.7;">🧹✂️</span>
      <span id="roeMazeMapClear" title="Clear map" style="cursor:pointer;opacity:.7;">🗑️</span>
      <span id="roeMazeMapAddZone" title="Начать отслеживать текущую зону как новую мини-карту" style="cursor:pointer;opacity:.7;">➕</span>
    </div>
    <div id="roeMazeMapResizeE" title="Drag to resize width" style="position:absolute;right:0;top:50%;width:6px;height:36px;margin-top:-18px;cursor:ew-resize;user-select:none;"></div>
    <div id="roeMazeMapResizeS" title="Drag to resize height" style="position:absolute;left:50%;bottom:0;width:36px;height:6px;margin-left:-18px;cursor:ns-resize;user-select:none;"></div>
    <div id="roeMazeMapResize" title="Drag to resize" style="position:absolute;right:3px;bottom:3px;width:13px;height:13px;line-height:13px;font-size:11px;color:#999;cursor:nwse-resize;user-select:none;">⇲</div>
    <div id="roeMazeMapDist" style="display:none;font-size:11px;color:#eee;margin-top:4px;font-family:monospace;">🚪 0u</div>
    <div id="roeMazeMapStairsDist" style="display:none;font-size:11px;color:#eee;margin-top:2px;font-family:monospace;">🪜 —</div>
    <div id="roeMazeMapRune" style="font-size:11px;color:#e0b3ff;margin-top:2px;font-family:monospace;text-align:left;"></div>
  `;
  document.body.appendChild(mazeMap);

  // ─── Auto-hide minimap UI: only the canvas stays visible until the mouse
  // is actually over the minimap; everything else (title bar, controls,
  // coords, resize handles, etc.) fades out via visibility:hidden (not
  // display:none) so their layout space stays reserved — the box's total
  // size, and so the canvas's position within it, never changes between
  // collapsed/expanded. No compensation math needed as a result (an
  // earlier display:none-based version did shift the canvas and needed a
  // measure-and-nudge workaround here; that workaround proved fragile
  // across the collapsed-on-load case, so it's simpler and more robust to
  // just not create the shift in the first place).
  mazeMap.classList.add('roe-minimap-collapsed');
  function _mazeMapSetCollapsed(collapsed) {
    mazeMap.classList.toggle('roe-minimap-collapsed', collapsed);
  }
  mazeMap.addEventListener('mouseenter', () => _mazeMapSetCollapsed(false));
  mazeMap.addEventListener('mouseleave', () => _mazeMapSetCollapsed(true));

  // Cached refs — avoid getElementById/querySelector on every animation frame
  const _mazeMapCanvasEl  = mazeMap.querySelector('#roeMazeMapCanvas');
  const _mazeMapTitleEl   = mazeMap.querySelector('#roeMazeMapTitle');
  const _mazeMapDistEl    = mazeMap.querySelector('#roeMazeMapDist');
  const _mazeMapStairsDistEl = mazeMap.querySelector('#roeMazeMapStairsDist');
  const _mazeMapCoordsEl  = mazeMap.querySelector('#roeMazeMapCoords');
  const _mazeMapRuneEl    = mazeMap.querySelector('#roeMazeMapRune');

  (function initMazeMapDrag() {
    const handle = mazeMap.querySelector('#roeMazeMapHandle');
    let dragging = false, dx = 0, dy = 0;
    function place(left, top) {
      left = Math.max(0, Math.min(window.innerWidth - mazeMap.offsetWidth, left));
      top  = Math.max(0, Math.min(window.innerHeight - mazeMap.offsetHeight, top));
      mazeMap.style.left = left + 'px';
      mazeMap.style.top  = top + 'px';
      try { localStorage.setItem('roeMazeMapPos', JSON.stringify({ left, top })); } catch (_) {}
    }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('roeMazeMapPos')); } catch (_) {}
    place(saved?.left ?? (window.innerWidth - 230), saved?.top ?? 140);
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('span[id^="roeMazeMap"]:not(#roeMazeMapTitle):not(#roeMazeMapCoords)')) return;
      dragging = true;
      dx = e.clientX - mazeMap.offsetLeft;
      dy = e.clientY - mazeMap.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => { if (dragging) place(e.clientX - dx, e.clientY - dy); });
    document.addEventListener('mouseup', () => { dragging = false; });
  })();

  (function initMazeMapResize() {
    const resizeHandle  = mazeMap.querySelector('#roeMazeMapResize');
    const resizeHandleE = mazeMap.querySelector('#roeMazeMapResizeE');
    const resizeHandleS = mazeMap.querySelector('#roeMazeMapResizeS');
    const canvas = mazeMap.querySelector('#roeMazeMapCanvas');

    [resizeHandleE, resizeHandleS].forEach(h => {
      h.addEventListener('mouseenter', () => { h.style.background = 'rgba(123,143,255,0.35)'; });
      h.addEventListener('mouseleave', () => { h.style.background = 'transparent'; });
    });
    const MIN_SIZE = 140, MAX_SIZE = 900, PANEL_CHROME = 16; // 6px padding × 2 + 1px border × 2 + 2px extra right-side margin

    // Once the user drags height explicitly (bottom edge or corner),
    // renderMazeMap's auto aspect-fit stops overwriting canvas.height —
    // otherwise the very next frame would snap it back to the fitted value.
    let _manualHeight = false;
    try { _manualHeight = localStorage.getItem('roeMazeMapManualHeight') === '1'; } catch (_) {}
    window._mazeMapManualHeight = _manualHeight;

    function clampPos() {
      // While the panel is hidden (display:none, the default until the user
      // toggles it on), offsetLeft/offsetTop/offsetWidth all read as 0 — not
      // the real CSS values. Clamping against those zeros here would stomp
      // the position we just restored from localStorage with {left:0,top:0}
      // on every script load. Only clamp once the panel is actually visible.
      if (mazeMap.style.display === 'none') return;
      // Keep the panel fully on-screen even after growing a lot — same clamp
      // logic as the drag handler, just re-applied against the new footprint.
      const left = Math.max(0, Math.min(window.innerWidth - mazeMap.offsetWidth, mazeMap.offsetLeft));
      const top  = Math.max(0, Math.min(window.innerHeight - mazeMap.offsetHeight, mazeMap.offsetTop));
      mazeMap.style.left = left + 'px';
      mazeMap.style.top  = top + 'px';
      try { localStorage.setItem('roeMazeMapPos', JSON.stringify({ left, top })); } catch (_) {}
    }

    function applyWidth(width) {
      width = Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, width)));
      canvas.width = width;
      mazeMap.style.width = (width + PANEL_CHROME) + 'px';
      try { localStorage.setItem('roeMazeMapSize', String(width)); } catch (_) {}
      clampPos();
      return width;
    }

    function applyHeight(height) {
      height = Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, height)));
      canvas.height = height;
      _manualHeight = true;
      window._mazeMapManualHeight = true;
      try {
        localStorage.setItem('roeMazeMapHeight', String(height));
        localStorage.setItem('roeMazeMapManualHeight', '1');
      } catch (_) {}
      clampPos();
      return height;
    }

    let savedWidth = null;
    try { savedWidth = parseInt(localStorage.getItem('roeMazeMapSize'), 10); } catch (_) {}
    if (savedWidth && !isNaN(savedWidth)) applyWidth(savedWidth);

    if (_manualHeight) {
      let savedHeight = null;
      try { savedHeight = parseInt(localStorage.getItem('roeMazeMapHeight'), 10); } catch (_) {}
      if (savedHeight && !isNaN(savedHeight)) applyHeight(savedHeight);
    }

    // Corner handle: both dimensions at once.
    let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
    resizeHandle.addEventListener('mousedown', e => {
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startW = canvas.width; startH = canvas.height;
      e.preventDefault();
      e.stopPropagation(); // don't also start a panel drag
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      applyWidth(startW + (e.clientX - startX));
      applyHeight(startH + (e.clientY - startY));
      renderMazeMap();
    });
    document.addEventListener('mouseup', () => { resizing = false; });

    // Right edge: width only.
    let resizingE = false, startXE = 0, startWE = 0;
    resizeHandleE.addEventListener('mousedown', e => {
      resizingE = true;
      startXE = e.clientX;
      startWE = canvas.width;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
      if (!resizingE) return;
      applyWidth(startWE + (e.clientX - startXE));
      renderMazeMap();
    });
    document.addEventListener('mouseup', () => { resizingE = false; });

    // Bottom edge: height only.
    let resizingS = false, startYS = 0, startHS = 0;
    resizeHandleS.addEventListener('mousedown', e => {
      resizingS = true;
      startYS = e.clientY;
      startHS = canvas.height;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
      if (!resizingS) return;
      applyHeight(startHS + (e.clientY - startYS));
      renderMazeMap();
    });
    document.addEventListener('mouseup', () => { resizingS = false; });
  })();

  function _clearMapGroup(group) {
    const _czToClear = _customZoneFromGroup(group);
    _cutsFor(group).length = 0;
    _saveCutsFor(group);
    if (group === 'forest') {
      _forestTrail.length = 0;
      saveForestTrail();
      _forestTrailSeen.clear();
      _forestLastPushedKey = null;
      _forestTrailBounds = null;
      _forceTrailRebake('forest');
    } else if (_czToClear) {
      const entry = _customMapEntry(_czToClear);
      entry.trail.length = 0;
      entry.seen.clear();
      entry.bounds = null;
      entry.lastPushedKey = null;
      _saveCustomTrail(_czToClear);
      _forceTrailRebake(group);
    } else {
      // 'maze' (combined), 'mines', or 'minesLower' — only wipes the
      // trail for the requested map; the other split/combined trails
      // (and the shared entries/stairs/death marker) are left untouched.
      const trail = _trailPointsFor(group);
      const seen  = _trailSeenFor(group);
      trail.length = 0;
      seen.clear();
      _saveTrailFor(group);
      _setTrailBoundsFor(group, null);
      if (group === 'mines')      _minesLastPushedKey = null;
      else if (group === 'minesLower') _minesLowerLastPushedKey = null;
      else _mazeLastPushedKey = null;
      // Death marker is shared across maze/mines/minesLower (same world
      // coords) — clear it alongside any of them, same as before.
      _mazeDeathPoint = null;
      saveMazeDeathPoint();
      _forceTrailRebake(group);
    }
    // Only reset the camera/pan if we just cleared the map currently being
    // looked at — clearing a different map shouldn't yank the view away.
    if (group === _activeMapGroup()) {
      _mapView = null;
      _mapDisplayPlayer = null; _mapInterp = null;
      _mapPanX = 0; _mapPanY = 0;
      _saveMapPan();
    }
    renderMazeMap();
  }

  const clearBtn = mazeMap.querySelector('#roeMazeMapClear');
  const clearPop = mazeMap.querySelector('#roeMazeMapClearPop');
  const clearOptions = [
    ['#roeMazeMapClearMaze',       'maze',       'Mines Full'],
    ['#roeMazeMapClearMines',      'mines',      'Mines'],
    ['#roeMazeMapClearMinesLower', 'minesLower', 'Mines Lower'],
    ['#roeMazeMapClearForest',     'forest',     'Forest'],
  ];
  clearOptions.forEach(([sel, group, label]) => {
    const el = mazeMap.querySelector(sel);
    el.addEventListener('mouseenter', () => { el.style.background = '#2a2a3d'; });
    el.addEventListener('mouseleave', () => { el.style.background = ''; });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      clearPop.style.display = 'none';
      showConfirm(el, `Clear ${label}?`, () => _clearMapGroup(group));
    });
  });

  // One row per user-added custom minimap: 🧹 clears its trail (keeps
  // tracking the zone), ✖ stops tracking it entirely and forgets its trail.
  const clearCustomList = mazeMap.querySelector('#roeMazeMapClearCustomList');
  function _populateCustomClearList() {
    clearCustomList.innerHTML = '';
    _customMapZones.forEach(zone => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 2px;border-radius:3px;gap:6px;';
      row.innerHTML = `<span style="cursor:pointer;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📍 ${zone}</span><span title="Перестать отслеживать" style="cursor:pointer;opacity:.7;flex:0 0 auto;">✖</span>`;
      row.addEventListener('mouseenter', () => { row.style.background = '#2a2a3d'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.firstElementChild.addEventListener('click', (e) => {
        e.stopPropagation();
        clearPop.style.display = 'none';
        showConfirm(row, `Clear ${zone}?`, () => _clearMapGroup(_customGroupFor(zone)));
      });
      row.lastElementChild.addEventListener('click', (e) => {
        e.stopPropagation();
        clearPop.style.display = 'none';
        showConfirm(row, `Stop tracking ${zone}?`, () => {
          _removeCustomMapZone(zone);
          _populateCustomZoneOptions();
          _populateCustomClearList();
          _populateCustomExportList();
          renderMazeMap();
        });
      });
      clearCustomList.appendChild(row);
    });
  }
  _populateCustomClearList();
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = clearPop.style.display === 'none';
    if (opening) {
      mazeMap.querySelector('#roeMazeMapSettingsPop').style.display = 'none';
      mazeMap.querySelector('#roeMazeMapExportPop').style.display = 'none';
    }
    clearPop.style.display = opening ? 'block' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (clearPop.style.display === 'none') return;
    if (clearPop.contains(e.target) || e.target === clearBtn) return;
    clearPop.style.display = 'none';
  });
  clearPop.addEventListener('click', (e) => e.stopPropagation());

    // ─── Map export: pick which map to export instead of always bundling
    // everything — same popup pattern as the 🗑️ clear-map menu above.
    function _exportPayloadFor(group) {
      if (group === 'maze') {
        return { maze: { trail: _packTrail(_mazeTrail), entries: _mazeEntries, stairs: _mazeStairs, stairsBlacklist: _mazeStairsBlacklist } };
      }
      if (group === 'mines')      return { mines:      { trail: _packTrail(_minesTrail) } };
      if (group === 'minesLower') return { minesLower: { trail: _packTrail(_minesLowerTrail) } };
      if (group === 'forest')     return { forest: { trail: _packTrail(_forestTrail), entry: _forestEntry, dungeonEntries: _forestDungeonEntries } };
      const cz = _customZoneFromGroup(group);
      if (cz) {
        const entry = _customMapEntry(cz);
        return { custom: { [cz]: { trail: _packTrail(entry.trail) } } };
      }
      return null;
    }
    function _exportAllPayload() {
      const payload = {
        maze:       { trail: _packTrail(_mazeTrail),   entries: _mazeEntries, stairs: _mazeStairs, stairsBlacklist: _mazeStairsBlacklist },
        mines:      { trail: _packTrail(_minesTrail) },
        minesLower: { trail: _packTrail(_minesLowerTrail) },
        forest:     { trail: _packTrail(_forestTrail), entry: _forestEntry, dungeonEntries: _forestDungeonEntries },
      };
      if (_customMapZones.length) {
        payload.custom = {};
        _customMapZones.forEach(zone => {
          payload.custom[zone] = { trail: _packTrail(_customMapEntry(zone).trail) };
        });
      }
      return payload;
    }
    function _doExport(payload, label, pointCount) {
      const json = JSON.stringify(payload);
      _copyToClipboard(json, `${label} (${pointCount} pts, ${Math.round(json.length / 1024)} KB)`);
    }

    const exportPop = mazeMap.querySelector('#roeMazeMapExportPop');
    const exportOptions = [
      ['#roeMazeMapExportAll',        null,         '📦 Все карты'],
      ['#roeMazeMapExportMaze',       'maze',       'Mines Full'],
      ['#roeMazeMapExportMines',      'mines',      'Mines'],
      ['#roeMazeMapExportMinesLower', 'minesLower', 'Mines Lower'],
      ['#roeMazeMapExportForest',     'forest',     'Forest'],
    ];
    exportOptions.forEach(([sel, group, label]) => {
      const el = mazeMap.querySelector(sel);
      el.addEventListener('mouseenter', () => { el.style.background = '#2a2a3d'; });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        exportPop.style.display = 'none';
        if (group === null) {
          _doExport(_exportAllPayload(), 'All maps', `${_mazeTrail.length} mine + ${_forestTrail.length} forest`);
        } else {
          _doExport(_exportPayloadFor(group), label, _mapData(group).trail.length);
        }
      });
    });
    // One row per user-added custom minimap, same list style as the clear popup.
    const exportCustomList = mazeMap.querySelector('#roeMazeMapExportCustomList');
    function _populateCustomExportList() {
      exportCustomList.innerHTML = '';
      _customMapZones.forEach(zone => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:4px 2px;border-radius:3px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        row.textContent = `📍 ${zone}`;
        row.addEventListener('mouseenter', () => { row.style.background = '#2a2a3d'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          exportPop.style.display = 'none';
          _doExport(_exportPayloadFor(_customGroupFor(zone)), zone, _customMapEntry(zone).trail.length);
        });
        exportCustomList.appendChild(row);
      });
    }
    _populateCustomExportList();
    const exportBtn = mazeMap.querySelector('#roeMazeMapExport');
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = exportPop.style.display === 'none';
      if (opening) clearPop.style.display = 'none';
      exportPop.style.display = opening ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => {
      if (exportPop.style.display === 'none') return;
      if (exportPop.contains(e.target) || e.target === exportBtn) return;
      exportPop.style.display = 'none';
    });
    exportPop.addEventListener('click', (e) => e.stopPropagation());

    mazeMap.querySelector('#roeMazeMapImport').addEventListener('click', () => {
      const raw = prompt('Paste exported map JSON:');
      if (!raw) return;
      let data;
      try { data = JSON.parse(raw); } catch (_) { alert('❌ Invalid JSON'); return; }

      const applyGroup = (pointsField, entry, trail, seen, saveTrail, saveEntry, setEntry) => {
        const points = _decodeTrailField(pointsField);
        if (!Array.isArray(points)) return 0;
        let added = 0;
        points.forEach(p => {
          if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return;
          const key = _trailCellKey(p);
          if (!seen.has(key)) { seen.add(key); trail.push({ x: p.x, y: p.y }); added++; }
        });
        saveTrail();
        if (entry && typeof entry.x === 'number' && typeof entry.y === 'number') {
          setEntry(entry);
          saveEntry();
        }
        return added;
      };

      const addedMaze = data.maze
        ? applyGroup(data.maze.trail, null, _mazeTrail, _mazeTrailSeen, saveMazeTrail, saveMazeEntries, () => {})
        : 0;
      const addedMines = data.mines
        ? applyGroup(data.mines.trail, null, _minesTrail, _minesTrailSeen, saveMinesTrail, () => {}, () => {})
        : 0;
      const addedMinesLower = data.minesLower
        ? applyGroup(data.minesLower.trail, null, _minesLowerTrail, _minesLowerTrailSeen, saveMinesLowerTrail, () => {}, () => {})
        : 0;
      const addedForest = data.forest
        ? applyGroup(data.forest.trail, data.forest.entry, _forestTrail, _forestTrailSeen, saveForestTrail, saveForestEntry, p => { _forestEntry = p; })
        : 0;
      if (Array.isArray(data.maze?.entries)) {
        data.maze.entries.forEach(p => {
          if (p && typeof p.x === 'number' && typeof p.y === 'number') _addUniqueGate(_mazeEntries, p);
        });
        saveMazeEntries();
      }
      if (Array.isArray(data.maze?.stairsBlacklist)) {
        data.maze.stairsBlacklist.forEach(p => {
          if (p && typeof p.x === 'number' && typeof p.y === 'number' && !_isBlacklistedStair(p)) _mazeStairsBlacklist.push({ x: p.x, y: p.y });
        });
        saveMazeStairsBlacklist();
      }
      if (Array.isArray(data.maze?.stairs)) {
        data.maze.stairs.forEach(p => {
          if (p && typeof p.x === 'number' && typeof p.y === 'number' && !_isBlacklistedStair(p)) _addUniqueGate(_mazeStairs, p, STAIRS_DEDUP_DIST);
        });
        saveMazeStairs();
      }
      if (Array.isArray(data.forest?.dungeonEntries)) {
        data.forest.dungeonEntries.forEach(p => {
          if (p && typeof p.x === 'number' && typeof p.y === 'number') _addUniqueGate(_forestDungeonEntries, p);
        });
        saveForestDungeonEntries();
      }
      if (addedMaze)       { _mazeTrailBounds       = _computeBounds(_mazeTrail); }
      if (addedMines)      { _minesTrailBounds      = _computeBounds(_minesTrail); }
      if (addedMinesLower) { _minesLowerTrailBounds = _computeBounds(_minesLowerTrail); }
      if (addedForest)     { _forestTrailBounds     = _computeBounds(_forestTrail); }

      _mapView = null;
      _mapDisplayPlayer = null; _mapInterp = null;
      _mapPanX = 0; _mapPanY = 0;
      _saveMapPan();
      renderMazeMap();
      alert(`✅ Imported ${addedMaze} mine + ${addedMines} mines + ${addedMinesLower} mines-lower + ${addedForest} forest points`);
    });

    function _mazeMapCursor() {
      if (_mapDeleteMode || _mapStairsDeleteMode || _mapAddPointMode || _mapAddStairsMode || _mapCutMode || _mapCutEraseMode) return 'crosshair';
      return _playerIsIdleForPan() ? 'grab' : 'default';
    }

    // Idle threshold for "follow player, but let me pan while they're not
    // moving": if the last recorded move sample is older than this, the
    // player is considered stationary and manual panning is allowed even
    // with 🎯 follow-mode on. Camera snaps back to centering on the player
    // the moment they move again (see the movement-detection block below).
    // Kept comfortably above the typical ~300-500ms gap between real move
    // packets during continuous walking (see DEFAULT_STEP_DURATION_MS) —
    // a threshold too close to that packet spacing flips idle/moving back
    // and forth on every packet gap, which reads as the cursor flickering
    // between the grab hand and the normal pointer while just walking.
    const FOLLOW_IDLE_MS = 1200;
    function _playerIsIdleForPan() {
      if (!_mapFollowPlayer) return true; // follow off — always free to pan
      const group = _activeMapGroup();
      if (group !== _realMapGroup()) return true; // not viewing live zone — nothing to follow anyway
      const { moveHist } = _mapData(group);
      const last = moveHist[moveHist.length - 1];
      if (!last) return true;
      return (Date.now() - last.t) >= FOLLOW_IDLE_MS;
    }

    // The five map click-modes (delete points, delete stairs, add point, add
    // stairs, cut) are mutually exclusive — a click can only mean one thing
    // at a time. Turning one on turns all the others off.
    function _exitOtherMapClickModes(except) {
      if (except !== 'delete' && _mapDeleteMode) {
        _mapDeleteMode = false; _syncDeleteModeBtn();
        try { localStorage.setItem('roeMazeMapDeleteMode', '0'); } catch (_) {}
      }
      if (except !== 'stairsDelete' && _mapStairsDeleteMode) {
        _mapStairsDeleteMode = false; _syncStairsDeleteBtn();
        try { localStorage.setItem('roeMazeMapStairsDeleteMode', '0'); } catch (_) {}
      }
      if (except !== 'addPoint' && _mapAddPointMode) {
        _mapAddPointMode = false; _syncAddPointModeBtn();
        try { localStorage.setItem('roeMazeMapAddPointMode', '0'); } catch (_) {}
      }
      if (except !== 'addStairs' && _mapAddStairsMode) {
        _mapAddStairsMode = false; _syncAddStairsModeBtn();
        try { localStorage.setItem('roeMazeMapAddStairsMode', '0'); } catch (_) {}
      }
      if (except !== 'cut' && _mapCutMode) {
        _mapCutMode = false; _syncCutModeBtn();
        try { localStorage.setItem('roeMazeMapCutMode', '0'); } catch (_) {}
      }
      if (except !== 'cutErase' && _mapCutEraseMode) {
        _mapCutEraseMode = false; _syncCutEraseModeBtn();
        try { localStorage.setItem('roeMazeMapCutEraseMode', '0'); } catch (_) {}
      }
    }

    const deleteModeBtn = mazeMap.querySelector('#roeMazeMapDeleteMode');
    function _syncDeleteModeBtn() {
      deleteModeBtn.style.opacity = _mapDeleteMode ? '1' : '.7';
      deleteModeBtn.style.background = _mapDeleteMode ? '#7b8fff' : '';
      deleteModeBtn.style.borderRadius = _mapDeleteMode ? '3px' : '';
    }
    _syncDeleteModeBtn();
    deleteModeBtn.addEventListener('click', () => {
      _mapDeleteMode = !_mapDeleteMode;
      if (_mapDeleteMode) _exitOtherMapClickModes('delete');
      _syncDeleteModeBtn();
      try { localStorage.setItem('roeMazeMapDeleteMode', _mapDeleteMode ? '1' : '0'); } catch (_) {}
      const canvas = mazeMap.querySelector('#roeMazeMapCanvas');
      if (canvas) canvas.style.cursor = _mazeMapCursor();
    });

    // 📍 — manual point-adding mode: clicking the map drops a trail point at
    // that world position (converted from screen coords via the same
    // view/zoom/pan the render uses), feeding it through the exact same
    // path/bounds/bake pipeline a real footstep would.
    const addPointModeBtn = mazeMap.querySelector('#roeMazeMapAddPointMode');
    function _syncAddPointModeBtn() {
      addPointModeBtn.style.opacity = _mapAddPointMode ? '1' : '.7';
      addPointModeBtn.style.background = _mapAddPointMode ? '#7b8fff' : '';
      addPointModeBtn.style.borderRadius = _mapAddPointMode ? '3px' : '';
    }
    _syncAddPointModeBtn();
    addPointModeBtn.addEventListener('click', () => {
      _mapAddPointMode = !_mapAddPointMode;
      if (_mapAddPointMode) _exitOtherMapClickModes('addPoint');
      _syncAddPointModeBtn();
      try { localStorage.setItem('roeMazeMapAddPointMode', _mapAddPointMode ? '1' : '0'); } catch (_) {}
      const canvas = mazeMap.querySelector('#roeMazeMapCanvas');
      if (canvas) canvas.style.cursor = _mazeMapCursor();
    });

    const cutModeBtn = mazeMap.querySelector('#roeMazeMapCutMode');
    function _syncCutModeBtn() {
      cutModeBtn.style.opacity = _mapCutMode ? '1' : '.7';
      cutModeBtn.style.background = _mapCutMode ? '#7b8fff' : '';
      cutModeBtn.style.borderRadius = _mapCutMode ? '3px' : '';
    }
    _syncCutModeBtn();
    cutModeBtn.addEventListener('click', () => {
      _mapCutMode = !_mapCutMode;
      if (_mapCutMode) _exitOtherMapClickModes('cut');
      _syncCutModeBtn();
      try { localStorage.setItem('roeMazeMapCutMode', _mapCutMode ? '1' : '0'); } catch (_) {}
      const canvas = mazeMap.querySelector('#roeMazeMapCanvas');
      if (canvas) canvas.style.cursor = _mazeMapCursor();
    });

    const cutWalkModeBtn = mazeMap.querySelector('#roeMazeMapCutWalkMode');
    function _syncCutWalkModeBtn() {
      cutWalkModeBtn.style.opacity = _mapCutWalkMode ? '1' : '.7';
      cutWalkModeBtn.style.background = _mapCutWalkMode ? '#ff6666' : '';
      cutWalkModeBtn.style.borderRadius = _mapCutWalkMode ? '3px' : '';
    }
    _syncCutWalkModeBtn();
    cutWalkModeBtn.addEventListener('click', () => {
      _mapCutWalkMode = !_mapCutWalkMode;
      _mapCutWalkLastRawPos = null; // don't draw a line from wherever the player was before toggling on
      _syncCutWalkModeBtn();
      notifyTrack(null, _mapCutWalkMode
        ? '🚶✂️ Walk-cut ON — cuts will drop automatically as you walk. Turn it off when done!'
        : '🚶✂️ Walk-cut OFF');
    });

    // 🧹✂️ — area-erase for cuts: click removes every cut within
    // CUT_ERASE_RADIUS_PX of the click, for clearing a patch of over-eager
    // walk-cut points at once instead of removing them one by one.
    const cutEraseModeBtn = mazeMap.querySelector('#roeMazeMapCutEraseMode');
    function _syncCutEraseModeBtn() {
      cutEraseModeBtn.style.opacity = _mapCutEraseMode ? '1' : '.7';
      cutEraseModeBtn.style.background = _mapCutEraseMode ? '#7b8fff' : '';
      cutEraseModeBtn.style.borderRadius = _mapCutEraseMode ? '3px' : '';
    }
    _syncCutEraseModeBtn();
    cutEraseModeBtn.addEventListener('click', () => {
      _mapCutEraseMode = !_mapCutEraseMode;
      if (_mapCutEraseMode) _exitOtherMapClickModes('cutErase');
      _syncCutEraseModeBtn();
      try { localStorage.setItem('roeMazeMapCutEraseMode', _mapCutEraseMode ? '1' : '0'); } catch (_) {}
      const canvas = mazeMap.querySelector('#roeMazeMapCanvas');
      if (canvas) canvas.style.cursor = _mazeMapCursor();
    });

    // 🪜➕ — inverse of 🪜✖: clicking near a previously-deleted (blacklisted)
    // staircase spot restores it to _mazeStairs at its original coordinates
    // and removes it from _mazeStairsBlacklist. It does not place new
    // markers at arbitrary click positions — only Mines/MinesLower track a
    // blacklist, so this is a no-op on Forest/custom maps.
    const addStairsBtn = mazeMap.querySelector('#roeMazeMapAddStairs');
    function _syncAddStairsModeBtn() {
      addStairsBtn.style.opacity = _mapAddStairsMode ? '1' : '.7';
      addStairsBtn.style.background = _mapAddStairsMode ? '#7b8fff' : '';
      addStairsBtn.style.borderRadius = _mapAddStairsMode ? '3px' : '';
    }
    _syncAddStairsModeBtn();
    addStairsBtn.addEventListener('click', () => {
      _mapAddStairsMode = !_mapAddStairsMode;
      if (_mapAddStairsMode) _exitOtherMapClickModes('addStairs');
      _syncAddStairsModeBtn();
      try { localStorage.setItem('roeMazeMapAddStairsMode', _mapAddStairsMode ? '1' : '0'); } catch (_) {}
      const canvas = mazeMap.querySelector('#roeMazeMapCanvas');
      if (canvas) canvas.style.cursor = _mazeMapCursor();
    });

    const followBtn = mazeMap.querySelector('#roeMazeMapFollow');
    function _syncFollowBtn() {
      followBtn.style.opacity = _mapFollowPlayer ? '1' : '.7';
      followBtn.style.background = _mapFollowPlayer ? '#7b8fff' : '';
      followBtn.style.borderRadius = _mapFollowPlayer ? '3px' : '';
    }
    _syncFollowBtn();
    followBtn.addEventListener('click', () => {
      _mapFollowPlayer = !_mapFollowPlayer;
      _syncFollowBtn();
      try { localStorage.setItem('roeMazeMapFollow', _mapFollowPlayer ? '1' : '0'); } catch (_) {}
      // Snap out of any manual pan so the camera starts centered on the
      // player right away instead of easing in from wherever it was left.
      _mapPanX = 0; _mapPanY = 0;
      _saveMapPan();
      const canvas = mazeMap.querySelector('#roeMazeMapCanvas');
      if (canvas) canvas.style.cursor = _mazeMapCursor();
    });
    // Match the canvas cursor to whatever delete/follow state was restored
    // from storage, instead of always starting on the static "grab" default.
    { const _c0 = mazeMap.querySelector('#roeMazeMapCanvas'); if (_c0) _c0.style.cursor = _mazeMapCursor(); }

    // Combined Mines+MinesLower map vs a separate map per level. Both trails
    // are always being recorded regardless of which one is currently shown
    // (see the 'move' handler) — Auto always displays the split (per-level)
    // view; the combined view is reachable via the map dropdown instead.


    // Map viewing mode: "Auto" follows the real current zone (original
    // behavior). Picking a specific zone switches to manual — it stays open
    // regardless of where the player actually is.
    const zoneSelectEl = mazeMap.querySelector('#roeMazeMapZoneSelect');
    // Custom zones are appended as extra <option>s (tagged data-custom so a
    // re-populate can tell them apart from the fixed built-in ones above).
    function _populateCustomZoneOptions() {
      zoneSelectEl.querySelectorAll('option[data-custom="1"]').forEach(o => o.remove());
      _customMapZones.forEach(z => {
        const opt = document.createElement('option');
        opt.value = _customGroupFor(z);
        opt.dataset.custom = '1';
        opt.textContent = `📍 ${z}`;
        zoneSelectEl.appendChild(opt);
      });
    }
    _populateCustomZoneOptions();
    function _syncMapModeUI() {
      zoneSelectEl.value = _mapManualMode ? _mapManualGroup : 'auto';
    }
    _syncMapModeUI();
    function _resetMapViewSnap() {
      _mapView = null;
      _mapDisplayPlayer = null; _mapInterp = null;
      _mapPanX = 0; _mapPanY = 0;
      _saveMapPan();
      renderMazeMap();
    }
    zoneSelectEl.addEventListener('change', () => {
      const val = zoneSelectEl.value;
      _mapManualMode = val !== 'auto';
      _saveMapManualMode();
      if (_mapManualMode) {
        _mapManualGroup = val;
        _saveMapManualGroup();
      }
      _resetMapViewSnap();
    });

    // ➕ — register whatever zone the player is currently standing in as a
    // new trackable minimap (a plain trail-only map, no gates/staircases).
    // Auto-detects the zone from the player's live position; does nothing
    // if it's already tracked (built-in or previously added) or if we don't
    // know where the player is yet.
    const addZoneBtn = mazeMap.querySelector('#roeMazeMapAddZone');
    addZoneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!_currentZone || !_playerPos) {
        notifyTrack(null, '📍 Позиция игрока ещё не известна');
        return;
      }
      const alreadyTracked = MAZE_ZONES.has(_currentZone) || FOREST_ZONES.has(_currentZone) || _isCustomMapZone(_currentZone);
      const zone = _addCustomMinimapForCurrentZone();
      if (!zone) return;
      _populateCustomZoneOptions();
      _populateCustomClearList();
      _populateCustomExportList();
      _syncMapModeUI();
      _resetMapViewSnap();
      notifyTrack(null, alreadyTracked ? `🗺️ ${zone} уже отслеживается` : `🗺️ Добавлена новая карта: ${zone}`);
    });

    // Toggle: clicking the canvas while active removes only the staircase
    // marker you click, one at a time — leaves the general 🖊️ delete mode
    // for trail dots, and doesn't touch any other staircase markers.
    const clearStairsBtn = mazeMap.querySelector('#roeMazeMapClearStairs');
    function _syncStairsDeleteBtn() {
      clearStairsBtn.style.opacity = _mapStairsDeleteMode ? '1' : '.7';
      clearStairsBtn.style.background = _mapStairsDeleteMode ? '#7b8fff' : '';
      clearStairsBtn.style.borderRadius = _mapStairsDeleteMode ? '3px' : '';
    }
    _syncStairsDeleteBtn();
    clearStairsBtn.addEventListener('click', () => {
      _mapStairsDeleteMode = !_mapStairsDeleteMode;
      if (_mapStairsDeleteMode) _exitOtherMapClickModes('stairsDelete');
      _syncStairsDeleteBtn();
      try { localStorage.setItem('roeMazeMapStairsDeleteMode', _mapStairsDeleteMode ? '1' : '0'); } catch (_) {}
      const canvas = mazeMap.querySelector('#roeMazeMapCanvas');
      if (canvas) canvas.style.cursor = _mazeMapCursor();
    });

    // ─── Settings popover (⚙️) — line thickness + perf toggles ────────────────
    const settingsBtn = mazeMap.querySelector('#roeMazeMapSettings');
    const settingsPop = mazeMap.querySelector('#roeMazeMapSettingsPop');
    const thicknessSel = mazeMap.querySelector('#roeMazeMapThickness');
    const radiusScaleSel = mazeMap.querySelector('#roeMazeMapRadiusScale');
    const fpsSel       = mazeMap.querySelector('#roeMazeMapFps');
    const glowChk      = mazeMap.querySelector('#roeMazeMapGlow');
    const smoothingChk = mazeMap.querySelector('#roeMazeMapSmoothing');
    const glitchChk    = mazeMap.querySelector('#roeMazeMapGlitch');
    const stairsPreviewChk = mazeMap.querySelector('#roeMazeMapStairsPreview');
    const bakeScaleSel = mazeMap.querySelector('#roeMazeMapBakeScale');
    const editModeChk  = mazeMap.querySelector('#roeMazeMapEditMode');

    // Edit Mode toggle — the staircase/point add-delete and clear-map
    // buttons clutter the panel and risk accidental map edits, so the whole
    // row is hidden unless Edit Mode is explicitly turned on. Export/Import
    // live in the Settings popup instead (see roeMazeMapExport above) since
    // they're read-only/safe actions, not something that needs gating.
    const editRow = mazeMap.querySelector('#roeMazeMapEditRow');
    const distRow = mazeMap.querySelector('#roeMazeMapDist');
    const stairsDistRow = mazeMap.querySelector('#roeMazeMapStairsDist');
    function _syncEditModeButtons() {
      editRow.style.display = _minimapSettings.editMode ? 'flex' : 'none';
      distRow.style.display = _minimapSettings.editMode ? '' : 'none';
      stairsDistRow.style.display = _minimapSettings.editMode ? '' : 'none';
    }
    editModeChk.checked = _minimapSettings.editMode;
    _syncEditModeButtons();
    editModeChk.addEventListener('change', () => {
      _minimapSettings.editMode = editModeChk.checked;
      _saveMinimapSettings();
      _syncEditModeButtons();
      // The delete/add-point/add-stairs tools live inside the row that Edit
      // Mode hides — leaving one active while its button disappears would
      // mean clicks on the map keep silently deleting/adding points with no
      // visible indicator of why. Cancel all of them on exit.
      if (!_minimapSettings.editMode) {
        _exitOtherMapClickModes(null);
        if (_mapCutWalkMode) { _mapCutWalkMode = false; _syncCutWalkModeBtn(); }
      }
    });

    thicknessSel.value = String(_minimapSettings.thickness);
    radiusScaleSel.value = String(_minimapSettings.radiusScale);
    fpsSel.value       = String(_minimapSettings.fps);
    glowChk.checked    = _minimapSettings.glow;
    smoothingChk.checked = _minimapSettings.smoothing;
    glitchChk.checked  = _minimapSettings.glitchEffect;
    stairsPreviewChk.checked = _minimapSettings.stairsPreview;
    bakeScaleSel.value = String(_minimapSettings.bakeScale);

    const resListEl = mazeMap.querySelector('#roeMazeMapResList');
    function _refreshResFilterList() {
      const names = Array.from(knownResNames).sort((a, b) => a.localeCompare(b));
      resListEl.innerHTML = names.map(n => `
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:1px 0;">
          <input type="checkbox" class="roeMazeMapResChk" value="${n}" ${_minimapSettings.hiddenResources.includes(n) ? '' : 'checked'} style="margin:0;">${formatResName(n)}
        </label>`).join('');
      resListEl.querySelectorAll('.roeMazeMapResChk').forEach(chk => {
        chk.addEventListener('change', () => {
          const name = chk.value;
          const hidden = new Set(_minimapSettings.hiddenResources);
          if (chk.checked) hidden.delete(name); else hidden.add(name);
          _minimapSettings.hiddenResources = Array.from(hidden);
          _saveMinimapSettings();
          renderMazeMap();
        });
      });
    }
    mazeMap.querySelector('#roeMazeMapResAll').addEventListener('click', () => {
      _minimapSettings.hiddenResources = [];
      _saveMinimapSettings();
      _refreshResFilterList();
      renderMazeMap();
    });
    mazeMap.querySelector('#roeMazeMapResNone').addEventListener('click', () => {
      _minimapSettings.hiddenResources = Array.from(knownResNames);
      _saveMinimapSettings();
      _refreshResFilterList();
      renderMazeMap();
    });

    const mobListEl = mazeMap.querySelector('#roeMazeMapMobList');
    function _refreshMobFilterList() {
      const names = Array.from(knownTypes).sort((a, b) => a.localeCompare(b));
      mobListEl.innerHTML = names.map(n => `
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:1px 0;">
          <input type="checkbox" class="roeMazeMapMobChk" value="${n}" ${_minimapSettings.hiddenMobs.includes(n) ? '' : 'checked'} style="margin:0;">${formatDisplayName(n)}
        </label>`).join('');
      mobListEl.querySelectorAll('.roeMazeMapMobChk').forEach(chk => {
        chk.addEventListener('change', () => {
          const name = chk.value;
          const hidden = new Set(_minimapSettings.hiddenMobs);
          if (chk.checked) hidden.delete(name); else hidden.add(name);
          _minimapSettings.hiddenMobs = Array.from(hidden);
          _saveMinimapSettings();
          renderMazeMap();
        });
      });
    }
    mazeMap.querySelector('#roeMazeMapMobAll').addEventListener('click', () => {
      _minimapSettings.hiddenMobs = [];
      _saveMinimapSettings();
      _refreshMobFilterList();
      renderMazeMap();
    });
    mazeMap.querySelector('#roeMazeMapMobNone').addEventListener('click', () => {
      _minimapSettings.hiddenMobs = Array.from(knownTypes);
      _saveMinimapSettings();
      _refreshMobFilterList();
      renderMazeMap();
    });

    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = settingsPop.style.display === 'none';
      if (opening) {
        mazeMap.querySelector('#roeMazeMapClearPop').style.display = 'none';
        mazeMap.querySelector('#roeMazeMapExportPop').style.display = 'none';
      }
      settingsPop.style.display = opening ? 'block' : 'none';
      if (opening) { _refreshResFilterList(); _refreshMobFilterList(); }
    });
    // Close on outside click, but not on clicks inside the popover itself
    // (a <select>/<input> click bubbles up through mazeMap otherwise).
    document.addEventListener('click', (e) => {
      if (settingsPop.style.display === 'none') return;
      if (settingsPop.contains(e.target) || e.target === settingsBtn) return;
      settingsPop.style.display = 'none';
    });
    settingsPop.addEventListener('click', (e) => e.stopPropagation());

    // Redraws every already-explored cell at the new size/glow — needed
    // because those bake into the canvas at paint time, so old cells
    // wouldn't otherwise pick up a setting changed after the fact.
    function _rebakeBothTrails() {
      _forceTrailRebake('maze');
      _forceTrailRebake('forest');
      _forceTrailRebake('mines');
      _forceTrailRebake('minesLower');
      // Any user-added custom minimaps also need a full clean repaint here —
      // otherwise only newly-walked cells pick up the new setting and
      // already-baked ones stay stuck looking like the old (messy) render.
      _customMapZones.forEach(z => _forceTrailRebake(_customGroupFor(z)));
    }

    thicknessSel.addEventListener('change', () => {
      _minimapSettings.thickness = parseFloat(thicknessSel.value) || 1;
      _saveMinimapSettings();
      _rebakeBothTrails();
    });
    radiusScaleSel.addEventListener('change', () => {
      _minimapSettings.radiusScale = parseFloat(radiusScaleSel.value) || 1;
      _saveMinimapSettings();
      _rebakeBothTrails();
    });
    fpsSel.addEventListener('change', () => {
      _minimapSettings.fps = parseInt(fpsSel.value, 10) || 20;
      _saveMinimapSettings();
    });
    glowChk.addEventListener('change', () => {
      _minimapSettings.glow = glowChk.checked;
      _saveMinimapSettings();
      _rebakeBothTrails();
    });
    smoothingChk.addEventListener('change', () => {
      _minimapSettings.smoothing = smoothingChk.checked;
      _saveMinimapSettings();
    });
    glitchChk.addEventListener('change', () => {
      _minimapSettings.glitchEffect = glitchChk.checked;
      _saveMinimapSettings();
    });
    stairsPreviewChk.addEventListener('change', () => {
      _minimapSettings.stairsPreview = stairsPreviewChk.checked;
      _saveMinimapSettings();
      if (!_minimapSettings.stairsPreview) {
        _pendingSplitFlip = null;
        _stairsPreviewDwellStart = null;
      }
    });
    bakeScaleSel.addEventListener('change', () => {
      _minimapSettings.bakeScale = parseFloat(bakeScaleSel.value) || 6;
      _saveMinimapSettings();
      _rebakeBothTrails();
    });

    mazeMap.querySelector('#roeMazeMapCanvas').addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      _mapZoom = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, _mapZoom * factor));
      _saveMapZoom(_activeMapGroup());
      // Briefly show a "123%" readout in the corner so scroll-to-zoom gives
      // some feedback on the current level, then let it fade back out —
      // otherwise there's no on-map indication of how zoomed in you are.
      _mapZoomIndicatorUntil = Date.now() + MAP_ZOOM_INDICATOR_MS;
      renderMazeMap();
      clearTimeout(_mapZoomIndicatorTimer);
      _mapZoomIndicatorTimer = setTimeout(renderMazeMap, MAP_ZOOM_INDICATOR_MS + 20);
    }, { passive: false });

    // ─── Hover tooltip: shows the mob/resource name under the cursor ──────────
    // Hit-tests against _mazeMapHoverMarkers, rebuilt fresh every renderMazeMap()
    // frame, so this stays correct as the camera pans/zooms without redoing any
    // world-to-screen math itself.
    //
    // Positioning uses a single generic per-axis helper (_clampAxis) applied
    // identically to X and Y in viewport (clientX/clientY) coordinates, then
    // converted once to mazeMap-relative coordinates for the actual
    // position:fixed styles. This replaced an earlier version that mixed
    // canvas-relative and mazeMap-relative math with separate hand-rolled
    // flip/clamp logic per axis — same idea (Popper/Floating-UI style
    // "placement + collision" positioning), just written out plainly so it
    // doesn't need an extra dependency.
    {
      const _hoverCanvas = mazeMap.querySelector('#roeMazeMapCanvas');
      const _hoverTip = mazeMap.querySelector('#roeMazeMapTooltip');
      let _hoveredMarker = null; // the marker object currently shown in the tooltip, so the 1s tick can re-render its countdown without needing mouse movement
      function _renderHoverTipContent(hit) {
        const subIsPositive = hit.sub === 'alive' || hit.sub === 'alive · tracked' || hit.sub === 'active';
        const subIsNegative = hit.sub === 'dead' || hit.sub === 'dead · tracked' || hit.sub === 'depleted';
        const subColor = subIsPositive ? '#4caf50' : subIsNegative ? '#e03030' : '#999';
        // "tracked" mobs are drawn purple on the map (#a855f7) — color that
        // word to match instead of leaving it the same green/red as alive/dead.
        const subText = hit.sub && hit.sub.endsWith(' · tracked')
          ? `${hit.sub.slice(0, -(' · tracked'.length))} · <span style="color:#a855f7;">tracked</span>`
          : escapeHtml(hit.sub || '');
        const respawnText = hit.respawnAt
          ? ` <span style="color:#fff;">-</span> <span style="color:${timerColor(hit.respawnAt)};font-size:14px;font-family:monospace;font-variant-numeric:tabular-nums">${fmtMs(hit.respawnAt)}</span>`
          : '';
        const statusLine = hit.sub
          ? `<br><span style="color:${subColor};">${subText}</span>${respawnText}`
          : '';
        _hoverTip.innerHTML = `<b>${escapeHtml(hit.label)}</b>${statusLine}`;
      }
      // Generic 1-D placement: prefer `cursorPos + gap`, flip to
      // `cursorPos - gap - size` if that overflows past `boundsEnd`, then
      // hard-clamp into [boundsStart + pad, boundsEnd - size - pad] no
      // matter which branch ran. Used identically for both X and Y (same
      // gap/pad) so the two axes can never drift out of sync or need their
      // own special-cased margins.
      function _clampAxis(cursorPos, size, boundsStart, boundsEnd, gap, pad) {
        const fitsForward = cursorPos + gap + size <= boundsEnd - pad;
        let pos = fitsForward ? (cursorPos + gap) : (cursorPos - gap - size);
        return Math.max(boundsStart + pad, Math.min(pos, boundsEnd - size - pad));
      }
      _hoverCanvas.addEventListener('mousemove', (e) => {
        if (!_hoverTip) return;
        const canvasRect = _hoverCanvas.getBoundingClientRect();
        const mx = (e.clientX - canvasRect.left) * (_hoverCanvas.width / canvasRect.width);
        const my = (e.clientY - canvasRect.top) * (_hoverCanvas.height / canvasRect.height);
        let hit = null, hitDist = Infinity;
        for (const m of _mazeMapHoverMarkers) {
          const d = Math.hypot(m.x - mx, m.y - my);
          if (d <= m.r && d < hitDist) { hit = m; hitDist = d; }
        }
        // The manual waypoint pin is clickable-to-clear (see the click
        // handler), so show a pointer cursor over it instead of the grab
        // hand used for panning — same treatment as hovering any other
        // clickable marker.
        const PIN_HOVER_RADIUS = 14;
        const overPointerPin = _pointerPinScreenPos
          && Math.hypot(mx - _pointerPinScreenPos.x, my - (_pointerPinScreenPos.y - 9)) <= PIN_HOVER_RADIUS;
        let overDropArrow = null;
        for (const arrow of _mazeMapOffscreenDropArrows) {
          if (Math.hypot(mx - arrow.x, my - arrow.y) <= arrow.r) { overDropArrow = arrow; break; }
        }
        if (hit) {
          _hoveredMarker = hit;
          _renderHoverTipContent(hit);
          _hoverTip.style.display = 'block';
          // Everything below is done in viewport coordinates (clientX/clientY),
          // bounded by the CANVAS's own rect — not the whole mazeMap widget,
          // which also includes the header/title bar and dropdown above the
          // canvas — then converted to mazeMap-relative px once at the end
          // since that's what mazeMap's position:fixed children use.
          const tipWidth = _hoverTip.offsetWidth;
          const tipHeight = _hoverTip.offsetHeight;
          const gap = 8;   // gap between cursor and tooltip
          const pad = 4;   // breathing room from the canvas's own edges, all sides

          const clientLeft = _clampAxis(e.clientX, tipWidth,  canvasRect.left, canvasRect.right,  gap, pad);
          const clientTop  = _clampAxis(e.clientY, tipHeight, canvasRect.top,  canvasRect.bottom, gap, pad);

          const mapRect = mazeMap.getBoundingClientRect();
          _hoverTip.style.left = `${clientLeft - mapRect.left}px`;
          _hoverTip.style.top = `${clientTop - mapRect.top}px`;
          // Normal cursor over a marker — the grab hand only makes sense over
          // empty map background, not something you'd double-click as a target.
          _mapHoveringMarker = true;
          if (!_mapPanDragging) _hoverCanvas.style.cursor = 'default';
        } else if (overPointerPin && _pointerTarget) {
          // Same tooltip treatment as a mob/resource marker — shows the
          // waypoint's label plus a hint that clicking clears it, since
          // that's not otherwise obvious just from the pointer cursor.
          _hoveredMarker = null;
          _hoverTip.innerHTML = `<b>${escapeHtml(_pointerTarget.label || '📍 Waypoint')}</b><br><span style="color:#999;">клик — снять метку</span>`;
          _hoverTip.style.display = 'block';
          const tipWidth = _hoverTip.offsetWidth;
          const tipHeight = _hoverTip.offsetHeight;
          const gap = 8, pad = 4;
          const clientLeft = _clampAxis(e.clientX, tipWidth,  canvasRect.left, canvasRect.right,  gap, pad);
          const clientTop  = _clampAxis(e.clientY, tipHeight, canvasRect.top,  canvasRect.bottom, gap, pad);
          const mapRect = mazeMap.getBoundingClientRect();
          _hoverTip.style.left = `${clientLeft - mapRect.left}px`;
          _hoverTip.style.top = `${clientTop - mapRect.top}px`;
          _mapHoveringMarker = true;
          if (!_mapPanDragging) _hoverCanvas.style.cursor = 'pointer';
        } else if (overDropArrow) {
          const n = overDropArrow.nearest;
          const nearestWorldPos = overDropArrow.kind === 'drop' ? n.meta.drop.pos : n.pos;
          const worldDist = _playerPos ? Math.round(Math.hypot(nearestWorldPos.x - _playerPos.x, nearestWorldPos.y - _playerPos.y)) : null;
          let titleHtml, clickHint;
          if (overDropArrow.kind === 'drop') {
            const isRune = n.meta.isRune;
            titleHtml = `<b>${isRune ? '💠 Runestone drop' : '📦 Item drop'}</b>`;
            clickHint = 'клик — проложить маршрут';
          } else if (overDropArrow.kind === 'death') {
            titleHtml = `<b>💀 Death spot</b>`;
            clickHint = 'клик — проложить маршрут';
          } else if (overDropArrow.kind === 'trackedMob') {
            titleHtml = `<b>${escapeHtml(n.meta.label)}</b>`;
            clickHint = 'клик — проложить маршрут';
          } else { // 'pin' — the manual waypoint or death-drop marker itself
            titleHtml = `<b>${escapeHtml(n.meta.label)}</b>`;
            clickHint = 'уже выбрано как цель';
          }
          _hoveredMarker = null;
          _hoverTip.innerHTML = titleHtml
            + (worldDist !== null ? `<br><span style="color:#999;">${worldDist}m away</span>` : '')
            + `<br><span style="color:#999;">${clickHint}</span>`;
          _hoverTip.style.display = 'block';
          const tipWidth = _hoverTip.offsetWidth;
          const tipHeight = _hoverTip.offsetHeight;
          const gap = 8, pad = 4;
          const clientLeft = _clampAxis(e.clientX, tipWidth,  canvasRect.left, canvasRect.right,  gap, pad);
          const clientTop  = _clampAxis(e.clientY, tipHeight, canvasRect.top,  canvasRect.bottom, gap, pad);
          const mapRect = mazeMap.getBoundingClientRect();
          _hoverTip.style.left = `${clientLeft - mapRect.left}px`;
          _hoverTip.style.top = `${clientTop - mapRect.top}px`;
          _mapHoveringMarker = true;
          if (!_mapPanDragging) _hoverCanvas.style.cursor = 'pointer';
        } else {
          _hoveredMarker = null;
          _hoverTip.style.display = 'none';
          _mapHoveringMarker = false;
          if (!_mapPanDragging && !(_mapDeleteMode || _mapStairsDeleteMode || _mapAddPointMode || _mapAddStairsMode || _mapCutMode || _mapCutEraseMode)) {
            _hoverCanvas.style.cursor = _mazeMapCursor();
          }
        }
      });
      _hoverCanvas.addEventListener('mouseleave', () => {
        _hoveredMarker = null;
        if (_hoverTip) _hoverTip.style.display = 'none';
        _mapHoveringMarker = false;
      });
      // The mousemove handler only re-renders on cursor movement, so a
      // countdown would otherwise sit frozen at whatever value it had when
      // the mouse last moved — tick it forward once a second while the
      // cursor stays still over a marker with a respawn timer.
      setInterval(() => {
        if (!_hoveredMarker || !_hoverTip || _hoverTip.style.display === 'none') return;
        if (!_hoveredMarker.respawnAt) return;
        _renderHoverTipContent(_hoveredMarker);
      }, 1000);
    }


    // ─── Left-mouse pan ────────────────────────────────────────────────────────
    // Drag the canvas itself to shift what part of the explored area is shown,
    // independent of panel position/delete-mode. Disabled while delete mode is
    // active so a click there still just deletes the nearest point.
    (function initMazeMapPan() {
      const canvas = mazeMap.querySelector('#roeMazeMapCanvas');
      let panning = false, panned = false;
      let startClientX = 0, startClientY = 0, startPanX = 0, startPanY = 0;

      canvas.addEventListener('mousedown', e => {
        if (e.button !== 0 || _mapDeleteMode || _mapStairsDeleteMode || _mapAddPointMode || _mapAddStairsMode || _mapCutMode || _mapCutEraseMode || !_mapView) return;
        if (_mapFollowPlayer && !_playerIsIdleForPan()) return;
        panning = true; panned = false;
        _mapPanDragging = true;
        startClientX = e.clientX; startClientY = e.clientY;
        startPanX = _mapPanX; startPanY = _mapPanY;
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();
      });
      document.addEventListener('mousemove', e => {
        if (!panning || !_mapView) return;
        const rangeX = Math.max(_mapView.maxX - _mapView.minX, 1);
        const rangeY = Math.max(_mapView.maxY - _mapView.minY, 1);
        const scale = Math.min(canvas.width / rangeX, canvas.height / rangeY);
        const dxScreen = e.clientX - startClientX, dyScreen = e.clientY - startClientY;
        if (Math.hypot(dxScreen, dyScreen) > 2) panned = true;
        // Content should track the cursor 1:1 — dragging right/down slides the
        // camera left/up (world Y is flipped on screen, see _mapToScreen).
        _mapPanX = startPanX - dxScreen / scale;
        _mapPanY = startPanY + dyScreen / scale;
      });
      document.addEventListener('mouseup', () => {
        if (!panning) return;
        panning = false;
        _mapPanDragging = false;
        canvas.style.cursor = _mazeMapCursor();
        if (panned) _saveMapPan();
        // Swallow the click that follows a real drag so delete-mode-off drags
        // never get misread as anything else; harmless when delete mode is on
        // since this only runs while it was off during the drag.
        if (panned) {
          const swallow = ev => { ev.stopPropagation(); canvas.removeEventListener('click', swallow, true); };
          canvas.addEventListener('click', swallow, true);
        }
      });
    })();

    // Current view including manual pan — used for rendering and hit-testing
    // so dragging the map and clicking to delete points stay in sync.
    function _pannedView() {
      if (!_mapView) return null;
      if (!_mapPanX && !_mapPanY) return _mapView;
      return {
        minX: _mapView.minX + _mapPanX, maxX: _mapView.maxX + _mapPanX,
        minY: _mapView.minY + _mapPanY, maxY: _mapView.maxY + _mapPanY,
      };
    }

    mazeMap.querySelector('#roeMazeMapCanvas').addEventListener('click', (e) => {
      // Clicking directly on the pin itself (manual waypoint or death-drop
      // marker) clears that marker — same effect as double-clicking the
      // same spot again for the manual one, but doesn't require re-finding
      // the exact original click location once the pin has a route drawn.
      {
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
        const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);
        const PIN_HIT_RADIUS = 14; // px in canvas space; pin glyph is ~14px wide, ~18px tall
        if (_pointerPinScreenPos) {
          const d = Math.hypot(clickX - _pointerPinScreenPos.x, clickY - (_pointerPinScreenPos.y - 9));
          if (d <= PIN_HIT_RADIUS) {
            _pointerTarget = null;
            _pointerPathCache = { targetKey: null, playerZone: null, fullPath: null, computedAt: 0 };
            renderMazeMap();
            if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
            return;
          }
        }
        // The death-drop pin is intentionally NOT clickable-to-clear — it
        // marks runes the player actually dropped and needs to stay put
        // until they're picked back up (pickup_death_drop_ack) or the
        // player walks up to the spot, not dismissed by an accidental or
        // impatient click.

        // Clicking an edge-of-map arrow (an off-screen drop, death spot,
        // tracked mob, or existing pin) sets it as the manual pointer
        // target — reuses the existing route/pin system rather than
        // needing its own separate tracking. Arrows for a pin that's
        // already the current target (or the non-clickable death-drop pin)
        // are inert on click — nothing to set that isn't already set.
        for (const arrow of _mazeMapOffscreenDropArrows) {
          const d = Math.hypot(clickX - arrow.x, clickY - arrow.y);
          if (d <= arrow.r) {
            if (arrow.kind === 'pin') return; // already a target; arrow is just a locator, not a new click target
            const n = arrow.nearest;
            let label, pos;
            if (arrow.kind === 'drop') {
              label = n.meta.isRune ? '💠 Runestone drop' : '📦 Item drop';
              pos = n.meta.drop.pos;
            } else if (arrow.kind === 'death') {
              label = '💀 Death spot';
              pos = n.pos;
            } else if (arrow.kind === 'trackedMob') {
              label = n.meta.label;
              pos = n.pos;
            } else {
              return;
            }
            const zone = _currentZone;
            const key = _pointerKey(zone, pos);
            _pointerTarget = (_pointerTarget && _pointerTarget.key === key)
              ? null
              : { zone, x: pos.x, y: pos.y, label, key };
            _pointerPathCache = { targetKey: null, playerZone: null, fullPath: null, computedAt: 0 };
            renderMazeMap();
            if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
            return;
          }
        }
      }
      if (_mapAddStairsMode) {
        if (!_mapView) return;
        const group = _activeMapGroup();
        if (!group) return;
        if (group !== 'maze' && group !== 'mines' && group !== 'minesLower') {
          notifyTrack(null, '🪜 У этой карты нет чёрного списка лестниц');
          return;
        }
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
        const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);
        const view = _pannedView();
        // Only ever restores an existing blacklisted spot back to
        // _mazeStairs at its original coordinates — never places a brand
        // new marker whereever you happen to click, since a manually
        // guessed position could be off and would need cleaning up later.
        let nearestIdx = -1, nearestDist = Infinity;
        _mazeStairsBlacklist.forEach((p, i) => {
          const s = _mapToScreen(p, view, canvas.width, canvas.height);
          const d = Math.hypot(s.x - clickX, s.y - clickY);
          if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        });
        if (nearestIdx === -1 || nearestDist > 12) {
          notifyTrack(null, '🪜 Рядом нет удалённых лестниц для восстановления');
          return;
        }
        const [restored] = _mazeStairsBlacklist.splice(nearestIdx, 1);
        saveMazeStairsBlacklist();
        if (_addUniqueGate(_mazeStairs, restored, STAIRS_DEDUP_DIST)) saveMazeStairs();
        renderMazeMap();
        return;
      }
      if (_mapAddPointMode) {
        if (!_mapView) return;
        const group = _activeMapGroup();
        if (!group) return;
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
        const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);
        const wp = _screenToMap(clickX, clickY, _pannedView(), canvas.width, canvas.height);
        // Snap onto the same cell-center grid real footsteps use (matches
        // _trailCellKey) so a manually-added point bakes/dedupes exactly
        // like a walked one — no special-casing needed anywhere downstream.
        const cx = Math.round(wp.x / MAZE_TRAIL_MIN_STEP) * MAZE_TRAIL_MIN_STEP;
        const cy = Math.round(wp.y / MAZE_TRAIL_MIN_STEP) * MAZE_TRAIL_MIN_STEP;
        const key = _trailCellKey({ x: cx, y: cy });
        const seen = _trailSeenFor(group);
        if (!seen.has(key)) {
          seen.add(key);
          _trailPointsFor(group).push({ x: cx, y: cy });
          _setTrailBoundsFor(group, _extendBounds(_trailBoundsFor(group), { x: cx, y: cy }));
          _saveTrailFor(group);
        }
        renderMazeMap();
        return;
      }
      if (_mapCutMode) {
        if (!_mapView) return;
        const group = _activeMapGroup();
        if (!group) return;
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
        const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);
        const view = _pannedView();
        const cuts = _cutsFor(group);
        // Clicking an existing cut (shown as a red dot in Edit Mode) removes
        // it instead of stacking a duplicate on top.
        let nearestIdx = -1, nearestDist = Infinity;
        cuts.forEach((p, i) => {
          const s = _mapToScreen(p, view, canvas.width, canvas.height);
          const d = Math.hypot(s.x - clickX, s.y - clickY);
          if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        });
        if (nearestIdx !== -1 && nearestDist <= 8) {
          cuts.splice(nearestIdx, 1);
        } else {
          const wp = _screenToMap(clickX, clickY, view, canvas.width, canvas.height);
          cuts.push({ x: wp.x, y: wp.y });
        }
        _saveCutsFor(group);
        // Cuts are baked directly into rawCanvas (see _paintTrailRange) —
        // force a full rebake so this add/remove takes effect immediately
        // instead of waiting for the next new trail point in this area.
        _forceTrailRebake(group);
        renderMazeMap();
        return;
      }
      if (_mapCutEraseMode) {
        if (!_mapView) return;
        const group = _activeMapGroup();
        if (!group) return;
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
        const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);
        const view = _pannedView();
        const cuts = _cutsFor(group);
        const kept = [];
        let removedAny = false;
        cuts.forEach(p => {
          const s = _mapToScreen(p, view, canvas.width, canvas.height);
          const d = Math.hypot(s.x - clickX, s.y - clickY);
          if (d <= CUT_ERASE_RADIUS_PX) {
            removedAny = true;
            // Un-mark this cell so walk-cut mode can re-cut here later
            // instead of treating it as already-seen and skipping it.
            _walkCutSeenFor(group).delete(_cutCellKey(p));
          } else {
            kept.push(p);
          }
        });
        if (removedAny) {
          cuts.length = 0;
          cuts.push(...kept);
          _saveCutsFor(group);
          _forceTrailRebake(group);
          renderMazeMap();
        }
        return;
      }
      if (!(_mapDeleteMode || _mapStairsDeleteMode) || !_mapView) return;
      const group = _activeMapGroup();
      if (!group) return;
      const { trail, seen, stairs } = _mapData(group);
      const canvas = e.target;
      const rect = canvas.getBoundingClientRect();
      const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
      const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);
      const view = _pannedView();

      // Stairs-only mode (🪜✖) never touches trail dots — only look for a
      // staircase marker under the click.
      let nearestIdx = -1, nearestDist = Infinity;
      if (_mapDeleteMode) {
        trail.forEach((p, i) => {
          const s = _mapToScreen(p, view, canvas.width, canvas.height);
          const d = Math.hypot(s.x - clickX, s.y - clickY);
          if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        });
      }

      // Staircase markers (white squares) — checked in both modes, so a
      // single unwanted one can be removed by clicking it.
      let nearestStairIdx = -1, nearestStairDist = Infinity;
      stairs.forEach((p, i) => {
        const s = _mapToScreen(p, view, canvas.width, canvas.height);
        const d = Math.hypot(s.x - clickX, s.y - clickY);
        if (d < nearestStairDist) { nearestStairDist = d; nearestStairIdx = i; }
      });

      const trailHit = nearestIdx !== -1 && nearestDist <= 8;
      const stairHit = nearestStairIdx !== -1 && nearestStairDist <= 8;

      // Prefer the stair hit when both are within range — the square is the
      // more deliberate click target and easy to miss by a pixel or two
      // onto a nearby trail dot underneath it.
      if (stairHit && (!trailHit || nearestStairDist <= nearestDist)) {
        const removed = stairs[nearestStairIdx];
        stairs.splice(nearestStairIdx, 1);
        if (group === 'forest') {
          saveForestDungeonEntries();
        } else {
          // Shared across maze/mines/minesLower — also blacklist this exact
          // spot so the noisy detection doesn't just re-add it next crossing.
          saveMazeStairs();
          _mazeStairsBlacklist.push({ x: removed.x, y: removed.y });
          saveMazeStairsBlacklist();
        }
        renderMazeMap();
        return;
      }

      if (trailHit) {
        const removed = trail[nearestIdx];
        trail.splice(nearestIdx, 1);
        seen.delete(_trailCellKey(removed));
        _saveTrailFor(group);
        _setTrailBoundsFor(group, _computeBounds(_trailPointsFor(group)));
        _forceTrailRebake(group);
        renderMazeMap();
      }
      return;
    });

    // ─── Click-to-route: double-click (no edit mode active) sets the pointer-
    // arrow target, either snapping onto whatever marker is under the cursor
    // (mob, resource, entrance, staircase) or dropping a plain ground waypoint
    // otherwise. Double-clicking the currently-active target again clears it,
    // same toggle behavior as the dots in the Track pane. Double-click (not
    // single) so it doesn't fire on ordinary clicks used for panning/other UI.
    mazeMap.querySelector('#roeMazeMapCanvas').addEventListener('dblclick', (e) => {
      if (_mapAddStairsMode || _mapAddPointMode || _mapDeleteMode || _mapStairsDeleteMode) return;
      if (!_mapView) return;
      const group = _activeMapGroup();
      if (!group) return;
      // Only makes sense while looking at the zone the player is actually
      // in — routing to a point in a different/manually-viewed zone would
      // have no live position to path from.
      if (group !== _realMapGroup()) return;
      const canvas = e.target;
      const rect = canvas.getBoundingClientRect();
      const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
      const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);

      // Snap onto the nearest drawn marker (mob/resource/entry/staircase) if
      // the click landed on one — reuses the same hit-test list the hover
      // tooltip builds, so "click near a dot" behaves the same as hovering it.
      let hit = null, hitDist = Infinity;
      for (const m of _mazeMapHoverMarkers) {
        const d = Math.hypot(m.x - clickX, m.y - clickY);
        if (d <= m.r + 3 && d < hitDist) { hit = m; hitDist = d; }
      }

      const view = _pannedView();
      const wp = hit ? null : _screenToMap(clickX, clickY, view, canvas.width, canvas.height);

      // A plain ground click (no marker hit) must land near the actual
      // explored trail — otherwise it's a click into unexplored black space,
      // which has no real path to route through and previously let you drop
      // a waypoint literally anywhere on the canvas, dashed line pointing
      // into the void. Snap radius is generous enough to cover gaps between
      // individual trail dots (same idea as their drawn coverage radius).
      if (!hit) {
        const { trail } = _mapData(group);
        const snapDist = MAZE_TRAIL_MIN_STEP * 3;
        const nearTrail = trail.some(p => Math.hypot(p.x - wp.x, p.y - wp.y) <= snapDist);
        if (!nearTrail) return;
      }

      const targetPos = hit ? { x: hit.wx, y: hit.wy } : wp;
      const targetZone = hit && hit.wzone ? hit.wzone : _currentZone;
      const label = hit ? hit.label : '📍 Waypoint';
      const key = _pointerKey(targetZone, targetPos);

      _pointerTarget = (_pointerTarget && _pointerTarget.key === key)
        ? null
        : { zone: targetZone, x: targetPos.x, y: targetPos.y, label, key };
      renderMazeMap();
      if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
    });

  // Smoothed view state — lerped toward the real data each frame so the map pans/
  // zooms gradually instead of snapping whenever a new far corner gets explored.
  let _mapView = null;          // { minX, maxX, minY, maxY } — currently displayed bounds
  let _mapDisplayPlayer = null; // { x, y } — currently displayed player position
  let _mapInterp = null;        // { fromX, fromY, toX, toY, startT, duration, targetT } — active chase-lerp segment
  let _mapZoneEnterT = null;    // Date.now() when the current zone's moveHist was last reset (fresh zone entry) — used to derive a real duration for the first move sample instead of guessing
  const DEFAULT_STEP_DURATION_MS = 400; // last-resort fallback duration if _mapZoneEnterT isn't available for some reason
  let _lastCombatActionT = null; // Date.now() of the last combat_hit — used to slow the map dot down slightly on the repositioning dash that comes with an attack
  const COMBAT_DASH_SLOWDOWN = 2; // duration multiplier applied to a segment whose real sample landed shortly after an attack

  // Offscreen layers holding the painted trail dots, one per group — baked
  // in FIXED WORLD-SPACE coordinates (not view/screen pixels). Previously
  // these were cached in view-space, which meant any camera pan (e.g. the
  // 🎯 follow-player mode, which re-centers the camera on the player every
  // frame while moving) invalidated the cache and forced a full redraw of
  // the entire trail — possibly thousands of points — on nearly every
  // single frame during movement. Baking in world-space means the cache
  // only needs to change when the trail itself grows into new territory;
  // camera panning/zooming is just a cheap drawImage crop each frame.
  const BAKE_PX_PER_UNIT = 6;   // default/fallback resolution of the baked world-space layer — see _minimapSettings.bakeScale for the user-configurable version
  const BAKE_PADDING     = 15;  // world units of slack before a full rebake is needed
  // Max trail points painted per animation frame. A large backlog (first
  // bake after a page reload/zone re-entry with thousands of already-saved
  // points, or a rebake triggered by exploring past the padded margin) used
  // to get painted — and its glow composite — in one single synchronous
  // call, which is exactly the freeze players hit walking into a
  // heavily-explored zone. Capping it here spreads that backlog across
  // successive frames (mazeMapTick already re-renders every frame while a
  // map group is active) instead of blocking the main thread once.
  const TRAIL_PAINT_CHUNK = 4000;
  function _makeTrailLayerState() {
    return {
      canvas: document.createElement('canvas'),
      rawCanvas: document.createElement('canvas'), // unblurred circle fills only — see _paintTrailRange
      scale: null,                 // BAKE_PX_PER_UNIT once baked
      originX: null, originY: null,// world coords at layer pixel (0,0)
      coverMinX: 0, coverMaxX: 0, coverMinY: 0, coverMaxY: 0, // world bounds currently baked
      bakedCount: 0,                // how many trail points are already painted in
    };
  }
  const _mazeTrailLayerState   = _makeTrailLayerState();
  const _forestTrailLayerState = _makeTrailLayerState();
  const _minesTrailLayerState      = _makeTrailLayerState();
  const _minesLowerTrailLayerState = _makeTrailLayerState();
  const _customTrailLayerStates = new Map(); // zone name → layer state
  function _trailLayerStateFor(group) {
    const cz = _customZoneFromGroup(group);
    if (cz) {
      let state = _customTrailLayerStates.get(cz);
      if (!state) { state = _makeTrailLayerState(); _customTrailLayerStates.set(cz, state); }
      return state;
    }
    if (group === 'forest')      return _forestTrailLayerState;
    if (group === 'mines')       return _minesTrailLayerState;
    if (group === 'minesLower')  return _minesLowerTrailLayerState;
    return _mazeTrailLayerState;
  }

  // ─── Baked-trail-layer disk cache (IndexedDB) ───────────────────────────────
  // The raw trail points already persist across reloads via localStorage
  // (_loadTrail/saveMazeTrail/saveForestTrail), but the expensive part — the
  // baked cell-grid canvas built from those points — never did, so every
  // reload or zone re-entry had to replay the entire trail (potentially
  // thousands of points) from scratch. That replay was the freeze on walking
  // into a heavily-explored zone. Caching the finished image means a normal
  // reload only has to paint whatever points were added since the last
  // save. IndexedDB (not localStorage) because the images can be a few
  // hundred KB–low MB each, well past what's sane to cram into
  // localStorage alongside everything else already stored there.
  const TRAIL_CACHE_DB    = 'roeTrailCache';
  const TRAIL_CACHE_STORE = 'bakes';
  let _trailCacheDBPromise = null;
  function _openTrailCacheDB() {
    if (_trailCacheDBPromise) return _trailCacheDBPromise;
    _trailCacheDBPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(TRAIL_CACHE_DB, 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore(TRAIL_CACHE_STORE); } catch (_) {} };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => resolve(null);
      } catch (_) { resolve(null); }
    });
    return _trailCacheDBPromise;
  }

  // Rebuilds state.rawCanvas (the unblurred circle-fill layer that
  // _paintTrailRange's smoothing pass reads as blur source — see that
  // function) from scratch for trail[0..toIdx). Only state.canvas gets
  // persisted to the IndexedDB cache; rawCanvas doesn't, so after a cache
  // restore it's empty even though state.bakedCount says thousands of
  // points are already baked into state.canvas. Without this, the next
  // incremental paint call resizes/clears the (already empty) rawCanvas to
  // match state.canvas and draws only the newly-walked segment onto it —
  // the blur pass at the boundary between old (cached) and new territory
  // then reads mostly-empty context, and its output overwrites a chunk of
  // the correctly-cached pixels with a result computed from incomplete
  // data (stray dots/broken edges right at that seam).
  function _rebuildRawCircles(state, trail, toIdx) {
    if (!state.rawCanvas) state.rawCanvas = document.createElement('canvas');
    if (state.rawCanvas.width !== state.canvas.width || state.rawCanvas.height !== state.canvas.height) {
      state.rawCanvas.width  = state.canvas.width;
      state.rawCanvas.height = state.canvas.height;
    }
    const coverageRadiusPx = Math.max(1, state.scale * MAZE_TRAIL_MIN_STEP * CELL_CIRCLE_RADIUS_FACTOR * (_minimapSettings.radiusScale ?? 1));
    const ctx = state.rawCanvas.getContext('2d');
    ctx.fillStyle = '#facc15';
    for (let i = 0; i < toIdx; i++) {
      const p = trail[i];
      const cx = Math.round(p.x / MAZE_TRAIL_MIN_STEP) * MAZE_TRAIL_MIN_STEP;
      const cy = Math.round(p.y / MAZE_TRAIL_MIN_STEP) * MAZE_TRAIL_MIN_STEP;
      const s = _trailWorldToLayerPx(state, { x: cx, y: cy });
      ctx.beginPath();
      ctx.arc(s.x, s.y, coverageRadiusPx, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Restores a previously-saved bake into `state`, if one exists and no
  // live rebake has already happened in the meantime (this runs async, so
  // a fast-moving player could already have triggered a real rebake by the
  // time the DB read resolves — in that case just skip, the live data wins).
  async function _loadTrailLayerCache(group, state) {
    const db = await _openTrailCacheDB();
    if (!db) return;
    let record;
    try {
      record = await new Promise((resolve, reject) => {
        const tx  = db.transaction(TRAIL_CACHE_STORE, 'readonly');
        const req = tx.objectStore(TRAIL_CACHE_STORE).get(group);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => reject(req.error);
      });
    } catch (_) { return; }
    if (!record || !record.rawBlob || state.scale) return;
    try {
      const rawBmp = await createImageBitmap(record.rawBlob);
      if (state.scale) return; // a live rebake won the race while we were decoding
      state.canvas.width  = record.w;
      state.canvas.height = record.h;
      state.canvas.getContext('2d').drawImage(rawBmp, 0, 0);
      state.scale     = record.scale;
      state.originX   = record.originX;
      state.originY   = record.originY;
      state.coverMinX = record.coverMinX; state.coverMaxX = record.coverMaxX;
      state.coverMinY = record.coverMinY; state.coverMaxY = record.coverMaxY;
      // Never trust a cached count beyond what's actually in the current
      // trail (e.g. trail was cleared/edited while the cache was stale).
      const trail = _trailPointsFor(group);
      state.bakedCount = Math.min(record.bakedCount || 0, trail.length);
      _rebuildRawCircles(state, trail, state.bakedCount);
    } catch (_) { /* corrupt/unreadable cache — falls back to a normal rebake */ }
  }
  _loadTrailLayerCache('maze',       _mazeTrailLayerState);
  _loadTrailLayerCache('forest',     _forestTrailLayerState);
  _loadTrailLayerCache('mines',      _minesTrailLayerState);
  _loadTrailLayerCache('minesLower', _minesLowerTrailLayerState);

  const TRAIL_CACHE_SAVE_THROTTLE_MS = 8000; // toBlob()+IDB write is cheap but not free — don't do it every frame
  const _trailCacheSaveTimer = { maze: null, forest: null };
  function _maybeSaveTrailLayerCache(group, state) {
    if (_trailCacheSaveTimer[group]) return;
    _trailCacheSaveTimer[group] = setTimeout(async () => {
      _trailCacheSaveTimer[group] = null;
      if (!state.scale) return;
      try {
        const db = await _openTrailCacheDB();
        if (!db) return;
        const rawBlob = await new Promise(resolve => state.canvas.toBlob(resolve));
        if (!rawBlob) return;
        const record = {
          w: state.canvas.width, h: state.canvas.height,
          scale: state.scale, originX: state.originX, originY: state.originY,
          coverMinX: state.coverMinX, coverMaxX: state.coverMaxX,
          coverMinY: state.coverMinY, coverMaxY: state.coverMaxY,
          bakedCount: state.bakedCount,
          rawBlob,
        };
        const tx = db.transaction(TRAIL_CACHE_STORE, 'readwrite');
        tx.objectStore(TRAIL_CACHE_STORE).put(record, group);
      } catch (_) { /* best-effort cache — safe to just skip this save */ }
    }, TRAIL_CACHE_SAVE_THROTTLE_MS);
  }

  function _trailWorldToLayerPx(state, p) {
    return { x: (p.x - state.originX) * state.scale, y: (state.originY - p.y) * state.scale };
  }

  // Paints trail[fromIdx..] onto the (already-sized) layer canvas as a
  // cell-grid reveal: every trail point is already deduplicated onto the
  // MAZE_TRAIL_MIN_STEP world grid (see _trailCellKey), so each point IS a
  // visited cell — painted here as a filled circle centered on that cell.
  // _stepPoints already backfills one point per crossed cell for fast
  // movement, so ordinary walking never leaves holes; only genuine
  // teleports (>TRAIL_TELEPORT_CUTOFF) show up as an isolated single cell.
  //
  // A circle doesn't tile a square grid the way a square does — four
  // neighboring cells' circles naturally leave a diamond-shaped bald spot
  // between them if the radius is only half the cell width. CELL_CIRCLE_
  // RADIUS_FACTOR fixes that: it's the half-diagonal of a cell (√2/2 ≈
  // 0.707, plus a small safety margin for rounding), so a single circle
  // fully covers its own square cell. Since the underlying cells already
  // tile with zero gaps, a circle that fully covers its own cell guarantees
  // the *union* of all circles covers the whole explored area too — no
  // bald spots — while still rendering as soft round dots instead of a
  // hard-edged grid.
  const CELL_CIRCLE_RADIUS_FACTOR = Math.SQRT2 / 2 * 1.06;
  // Smooths the crisp core silhouette: blur the circle union, then snap
  // its alpha back to solid past a cutoff. This rounds off the concave
  // "staircase" dips between adjacent cell-circles on diagonal paths,
  // without leaving a translucent haze (that's what the glow pass is for).
  // Cost is bounded to the same small dirty-rect the glow pass already
  // uses, so it scales with newly-explored cells, not the whole map.
  const TRAIL_SMOOTH_RADIUS_PX = 4;
  // Threshold is no longer a constant — see _trailSmoothThreshold below.
  // matching a Gaussian blur's own boundary crossing, so the final shape
  // hugs the original crisp radius instead of puffing outward. A lower
  // cutoff (more lenient) keeps pixels further outside the real edge,
  // growing the silhouette past what the circles actually cover.
  // Extra margin (beyond the segment's own bbox) used only as blur SOURCE
  // context, never itself written back. A cropped drawImage+filter treats
  // its crop edge as transparent, so without this margin any pre-existing
  // solid trail sitting right at the segment bbox's edge (constant, since
  // cells are packed edge-to-edge along the walked path) fades toward
  // transparent right at that edge — a grid of holes/edge artifacts at
  // every past paint call's box boundary. Must exceed the blur's
  // effective spread (~3× its px radius).
  const TRAIL_SMOOTH_PROC_PAD = Math.ceil(TRAIL_SMOOTH_RADIUS_PX * 4);
  // _minimapSettings.thickness used to scale the circle radius directly,
  // but a smaller radius reopens REAL gaps on diagonal steps (adjacent
  // diagonal cells are ~1.4x further apart than orthogonal ones — see
  // CELL_CIRCLE_RADIUS_FACTOR), not just a leaner look; that's what
  // produced the disconnected diamond dots on "Мелкие". So the circle
  // radius now always stays at full coverage (guaranteed connectivity),
  // and thickness instead scales how hard the smoothing pass erodes the
  // blurred silhouette afterward: a higher threshold keeps only pixels
  // deep inside the blur, shrinking the visible line without breaking
  // the connections between cells that full-radius circles guarantee.
  // 135 (~50%) is the "Обычные" anchor point (see _paintTrailRange's
  // TRAIL_SMOOTH_THRESHOLD comment for why 50% avoids outward puffing).
  function _trailSmoothThreshold() {
    return Math.round(Math.min(220, Math.max(30, 135 - (_minimapSettings.thickness - 1) * 100)));
  }
  function _paintTrailRange(state, trail, fromIdx, toIdx = trail.length, group = null) {
    const ctx = state.canvas.getContext('2d');
    // Always the smallest radius that fully covers a cell (see
    // CELL_CIRCLE_RADIUS_FACTOR above) — guarantees no real gaps even on
    // diagonal steps, at radiusScale 1. Lowering ⚙️ "Радиус тропы" shrinks
    // this floor itself (not just the blur erosion _trailSmoothThreshold
    // does on top of it) — physically narrows the trail, which is the only
    // way to stop two nearby parallel passes (e.g. walking a loop around a
    // small building) from bridging solid before blur/threshold even runs.
    // Trade-off: below ~1 this can reopen real gaps on diagonal steps.
    const coverageRadiusPx = Math.max(1, state.scale * MAZE_TRAIL_MIN_STEP * CELL_CIRCLE_RADIUS_FACTOR * (_minimapSettings.radiusScale ?? 1));
    if (fromIdx >= toIdx) return;

    // Bounding box (in layer pixels) covering just the segment being
    // (re)painted, padded for the widest circle + blur radius the glow
    // pass might use. Restricting the glow composite to this box instead of
    // the full canvas matters on a large explored map (millions of px) —
    // clearing/blur-compositing the WHOLE thing on every new trail point
    // while walking was the actual cause of multi-second stutters.
    const GLOW_PAD = Math.ceil(coverageRadiusPx * 1.5 + TRAIL_SMOOTH_RADIUS_PX * 2 + 6);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = fromIdx; i < toIdx; i++) {
      const s = _trailWorldToLayerPx(state, trail[i]);
      if (s.x < bx0) bx0 = s.x; if (s.x > bx1) bx1 = s.x;
      if (s.y < by0) by0 = s.y; if (s.y > by1) by1 = s.y;
    }
    bx0 = Math.max(0, Math.floor(bx0 - GLOW_PAD));
    by0 = Math.max(0, Math.floor(by0 - GLOW_PAD));
    bx1 = Math.min(state.canvas.width,  Math.ceil(bx1 + GLOW_PAD));
    by1 = Math.min(state.canvas.height, Math.ceil(by1 + GLOW_PAD));
    const bw = Math.max(1, bx1 - bx0), bh = Math.max(1, by1 - by0);

    const drawShape = (targetCtx, radiusPx) => {
      targetCtx.fillStyle = '#facc15';
      for (let i = fromIdx; i < toIdx; i++) {
        const p = trail[i];
        // Re-snap onto the cell-center grid (matches _trailCellKey) rather
        // than trusting the point's raw float coords — guarantees every
        // point belonging to the same cell paints at the identical center.
        const cx = Math.round(p.x / MAZE_TRAIL_MIN_STEP) * MAZE_TRAIL_MIN_STEP;
        const cy = Math.round(p.y / MAZE_TRAIL_MIN_STEP) * MAZE_TRAIL_MIN_STEP;
        const s = _trailWorldToLayerPx(state, { x: cx, y: cy });
        targetCtx.beginPath();
        targetCtx.arc(s.x, s.y, radiusPx, 0, Math.PI * 2);
        targetCtx.fill();
      }
    };

    // Smoothed core pass — replaces painting circles straight onto ctx.
    // Blurs+thresholds from a padded processing rect (px0..py1, real
    // pixels copied from state.canvas) so the blur has genuine context
    // beyond the inner bbox instead of a hard transparent crop edge — see
    // TRAIL_SMOOTH_PROC_PAD. Only the inner bbox (bx0..by1) actually gets
    // written back to ctx; the padding is read-only context for the blur.
    // Runs first (before glow) since it rewrites the whole inner bbox —
    // glow is composited on top of this smoothed base below.
    if (!state.rawCanvas) state.rawCanvas = document.createElement('canvas');
    if (state.rawCanvas.width !== state.canvas.width || state.rawCanvas.height !== state.canvas.height) {
      state.rawCanvas.width  = state.canvas.width;
      state.rawCanvas.height = state.canvas.height;
    }
    // Circles accumulate here permanently and get blurred fresh every call —
    // this canvas never receives the thresholded/glow output back, so
    // repeated incremental paints over the same nearby area can't
    // progressively re-blur already-processed pixels into a smear (that was
    // the actual bug: reading state.canvas here instead used to feed the
    // glow halo composited by the *previous* call straight back into this
    // call's blur input, baking it in and compounding worse each revisit).
    drawShape(state.rawCanvas.getContext('2d'), coverageRadiusPx);

    // Cuts (manual "scissors" tool — see roeMazeMapCutMode) punch a real
    // destination-out hole into rawCanvas here, before blur/threshold runs.
    // Re-applying every cut on every paint call (not just when a cut is
    // freshly added) is deliberate and cheap: rawCanvas only ever
    // accumulates painted circles, so a spot this loop already cut stays
    // cut — this just guards against a newly-painted trail circle from a
    // later walk landing on top of an old cut and re-filling it.
    if (group) {
      const cuts = _cutsFor(group);
      if (cuts.length) {
        const rawCtx = state.rawCanvas.getContext('2d');
        rawCtx.save();
        rawCtx.globalCompositeOperation = 'destination-out';
        const cutRadiusPx = Math.max(1, state.scale * CUT_RADIUS_WORLD);
        cuts.forEach(c => {
          const s = _trailWorldToLayerPx(state, c);
          rawCtx.beginPath();
          rawCtx.arc(s.x, s.y, cutRadiusPx, 0, Math.PI * 2);
          rawCtx.fill();
        });
        rawCtx.restore();
      }
    }

    const px0 = Math.max(0, bx0 - TRAIL_SMOOTH_PROC_PAD);
    const py0 = Math.max(0, by0 - TRAIL_SMOOTH_PROC_PAD);
    const px1 = Math.min(state.canvas.width,  bx1 + TRAIL_SMOOTH_PROC_PAD);
    const py1 = Math.min(state.canvas.height, by1 + TRAIL_SMOOTH_PROC_PAD);
    const pw = Math.max(1, px1 - px0), ph = Math.max(1, py1 - py0);

    if (!state.smoothBlurred)  state.smoothBlurred  = document.createElement('canvas');
    // willReadFrequently: this canvas gets getImageData() read back on every
    // call (below) as part of the trail smoothing pass — without the hint
    // the browser logs a "readback operations are faster with
    // willReadFrequently" warning and may pick a slower backing store.
    if (!state.smoothBlurredCtx) state.smoothBlurredCtx = state.smoothBlurred.getContext('2d', { willReadFrequently: true });
    const blurredCtx = state.smoothBlurredCtx;
    if (state.smoothBlurred.width !== state.canvas.width || state.smoothBlurred.height !== state.canvas.height) {
      state.smoothBlurred.width  = state.canvas.width;
      state.smoothBlurred.height = state.canvas.height;
    } else {
      blurredCtx.clearRect(px0, py0, pw, ph);
    }

    blurredCtx.save();
    blurredCtx.filter = `blur(${TRAIL_SMOOTH_RADIUS_PX}px)`;
    blurredCtx.drawImage(state.rawCanvas, px0, py0, pw, ph, px0, py0, pw, ph);
    blurredCtx.restore();

    // Read back only the inner bbox — it sits TRAIL_SMOOTH_PROC_PAD away
    // from the processing rect's own crop edge, so it's unaffected by
    // that edge's transparency artifact.
    const smoothed = blurredCtx.getImageData(bx0, by0, bw, bh);
    const sd = smoothed.data;
    const smoothThreshold = _trailSmoothThreshold();
    // Real anti-aliasing instead of a hard binary cut: keep a narrow linear
    // ramp of the blur's own analog alpha around the threshold, rather than
    // snapping everything to 0/255. A hard cut through a saddle point in the
    // combined alpha field of two adjacent circles (where their Gaussian
    // falloffs meet) reads as a sharp cusp/spike; a graded crossing there
    // instead just looks like a soft, slightly recessed neck -- same as
    // everywhere else on the shape. This doesn't touch the blur radius
    // itself, so the overall smoothness/roundedness of the trail (which
    // comes from TRAIL_SMOOTH_RADIUS_PX, unchanged) is the same as before.
    // AA_BAND is deliberately narrow (not TRAIL_SMOOTH_RADIUS_PX-wide) so
    // the core stays crisp/opaque and doesn't turn into a translucent haze
    // (that's what the glow pass is for).
    const AA_BAND = 24;
    const aaLo = smoothThreshold - AA_BAND, aaHi = smoothThreshold + AA_BAND;
    for (let i = 3; i < sd.length; i += 4) {
      const v = sd[i];
      sd[i] = v <= aaLo ? 0 : v >= aaHi ? 255 : Math.round((v - aaLo) / (aaHi - aaLo) * 255);
    }
    ctx.clearRect(bx0, by0, bw, bh);
    ctx.putImageData(smoothed, bx0, by0);

    // Glow pass — slightly oversized circles painted onto a reusable
    // scratch canvas, then composited in blurred, giving explored territory
    // a soft outer edge. Only the newly-added range gets (re)painted onto
    // the scratch each call, same as the main incremental painter.
    // Skippable via settings (⚙️ → "Свечение") — the blur composite is the
    // single most expensive part of a paint call, so turning it off is the
    // main perf lever for low-end machines / huge explored maps.
    if (_minimapSettings.glow) {
      if (!state.glowScratch) state.glowScratch = document.createElement('canvas');
      if (state.glowScratch.width !== state.canvas.width || state.glowScratch.height !== state.canvas.height) {
        state.glowScratch.width  = state.canvas.width;
        state.glowScratch.height = state.canvas.height;
      } else {
        state.glowScratch.getContext('2d').clearRect(bx0, by0, bw, bh);
      }
      drawShape(state.glowScratch.getContext('2d'), coverageRadiusPx * 1.5);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.filter = 'blur(2.5px)';
      ctx.drawImage(state.glowScratch, bx0, by0, bw, bh, bx0, by0, bw, bh);
      ctx.restore();
    }

    state.bakedCount = toIdx;
  }

  // Grows the layer to cover `bounds` (+padding). Unlike a naive rebake
  // (clear everything, repaint every point from scratch), this copies the
  // already-baked pixels into the resized canvas at the right offset, so
  // cost is independent of how many points are already in the trail — it's
  // just a canvas resize + one drawImage. Only the points added since the
  // last bake (state.bakedCount onward) still need painting, which the
  // caller (_ensureTrailLayerFresh) already does for every call anyway.
  //
  // This matters because BAKE_PADDING is a fairly small margin: walking in
  // a straight line into freshly-explored territory pushes `bounds` past
  // it again every few steps. The old version did a full O(trail size)
  // repaint (plus an unthrottled full closing pass) on *every* one of
  // those triggers — i.e. a multi-thousand-point repaint every few steps
  // while exploring, which is exactly the freeze the growth case caused.
  // If there's no existing canvas to copy from (first bake for this group,
  // or after _forceTrailRebake resets state.scale), this degrades to a
  // plain clear+resize and the caller's normal incremental paint fills it
  // in from bakedCount (which _forceTrailRebake also resets to 0).
  function _rebakeTrailLayer(state, trail, bounds) {
    const bakeScale = _minimapSettings.bakeScale || BAKE_PX_PER_UNIT;
    const minX = bounds.minX - BAKE_PADDING, maxX = bounds.maxX + BAKE_PADDING;
    const minY = bounds.minY - BAKE_PADDING, maxY = bounds.maxY + BAKE_PADDING;
    const newW = Math.max(1, Math.ceil((maxX - minX) * bakeScale));
    const newH = Math.max(1, Math.ceil((maxY - minY) * bakeScale));

    // If the previous bake (live or restored from the disk cache) was made
    // at a different scale than what's currently configured, its pixels
    // can't be pasted as-is: drawImage below copies 1:1 with no destination
    // resize, so a scale mismatch (e.g. cache saved at bakeScale 6, now set
    // to 1.5) crams the old, larger image into the new, smaller canvas and
    // clips most of it off — the previously-explored trail appears to
    // vanish even though the point data is intact. Treating it as "no
    // content to preserve" instead forces a full, correctly-scaled repaint.
    const hadContent = state.scale === bakeScale && state.canvas.width > 0 && state.canvas.height > 0;
    let oldCanvas = null, oldRaw = null, offsetX = 0, offsetY = 0;
    if (hadContent) {
      // Snapshot before resizing — resizing a <canvas> element clears it.
      oldCanvas = document.createElement('canvas');
      oldCanvas.width = state.canvas.width;
      oldCanvas.height = state.canvas.height;
      oldCanvas.getContext('2d').drawImage(state.canvas, 0, 0);
      if (state.rawCanvas && state.rawCanvas.width > 0) {
        oldRaw = document.createElement('canvas');
        oldRaw.width = state.rawCanvas.width;
        oldRaw.height = state.rawCanvas.height;
        oldRaw.getContext('2d').drawImage(state.rawCanvas, 0, 0);
      }
      offsetX = Math.round((state.originX - minX) * bakeScale);
      offsetY = Math.round((maxY - state.originY) * bakeScale);
    }

    state.canvas.width  = newW;
    state.canvas.height = newH;
    if (!state.rawCanvas) state.rawCanvas = document.createElement('canvas');
    state.rawCanvas.width  = newW;
    state.rawCanvas.height = newH;
    state.scale   = bakeScale;
    state.originX = minX;
    state.originY = maxY;
    state.coverMinX = minX; state.coverMaxX = maxX;
    state.coverMinY = minY; state.coverMaxY = maxY;

    const ctx = state.canvas.getContext('2d');
    ctx.clearRect(0, 0, newW, newH);
    const rawCtx = state.rawCanvas.getContext('2d');
    rawCtx.clearRect(0, 0, newW, newH);
    if (oldCanvas) {
      ctx.drawImage(oldCanvas, offsetX, offsetY);
      if (oldRaw) rawCtx.drawImage(oldRaw, offsetX, offsetY);
    } else {
      state.bakedCount = 0; // nothing preserved — caller repaints everything
    }
  }

  // Ensures the layer for `group` reflects the current trail, doing the
  // minimum work: nothing if unchanged, an incremental append for new
  // points within the already-baked area, growing the canvas first if the
  // explored area has pushed past the padded margin.
  function _ensureTrailLayerFresh(group) {
    const state  = _trailLayerStateFor(group);
    const trail  = _trailPointsFor(group);
    const bounds = _trailBoundsFor(group);
    if (!bounds) { state.scale = null; state.bakedCount = 0; return state; }
    const SAFETY = BAKE_PADDING * 0.5;
    const needsGrow = !state.scale ||
      bounds.minX < state.coverMinX + SAFETY || bounds.maxX > state.coverMaxX - SAFETY ||
      bounds.minY < state.coverMinY + SAFETY || bounds.maxY > state.coverMaxY - SAFETY;
    if (needsGrow) {
      const _dbgT0 = performance.now();
      _rebakeTrailLayer(state, trail, bounds);
      if (window.__roeDbgPerf) console.warn(`[ROE perf] trail layer grow (${group}): ${(performance.now() - _dbgT0).toFixed(1)}ms, ${trail.length} pts`);
    }
    const hasNewPoints = trail.length > state.bakedCount;
    if (hasNewPoints) {
      // Cap how many points get painted in this single call — see
      // TRAIL_PAINT_CHUNK. A big backlog (first bake after a reload/zone
      // entry, or a rebake that reset bakedCount) gets caught up over
      // several frames instead of blocking on the whole trail at once.
      // The ordinary per-step case (a handful of new points) is far below
      // the cap and still paints in one shot, same as before.
      const remaining = trail.length - state.bakedCount;
      const toIdx = remaining > TRAIL_PAINT_CHUNK ? state.bakedCount + TRAIL_PAINT_CHUNK : trail.length;
      _paintTrailRange(state, trail, state.bakedCount, toIdx, group);
    }
    if (needsGrow || hasNewPoints) {
      _maybeSaveTrailLayerCache(group, state);
    }
    return state;
  }

  // Forces a full rebake on the next _ensureTrailLayerFresh call. Needed
  // whenever points are REMOVED from a trail (delete-by-click, clear) —
  // the incremental/coverage checks above only detect growth, so a
  // shrinking edit would otherwise leave stale baked pixels on screen.
  function _forceTrailRebake(group) {
    const state = _trailLayerStateFor(group);
    state.scale = null;
    state.bakedCount = 0;
  }

  // Which zone group (if any) the minimap widget should track right now, and
  // the state bundle that goes with it — lets the render/tick code stay
  // written once instead of duplicated per zone.
  function _realMapGroup() {
    if (MAZE_ZONES.has(_currentZone)) {
      return _pendingSplitFlip || (_currentZone === 'MinesLower' ? 'minesLower' : 'mines');
    }
    if (FOREST_ZONES.has(_currentZone)) return 'forest';
    if (_isCustomMapZone(_currentZone)) return _customGroupFor(_currentZone);
    return null;
  }
  function _activeMapGroup() {
    return _mapManualMode ? _mapManualGroup : _realMapGroup();
  }
  // Whether the group currently being displayed actually contains the
  // player's real current position — used to decide whether to draw the
  // live player dot / distance readouts / pointer-target line. A plain
  // `group === _realMapGroup()` check breaks for the manually-selected
  // combined 'maze' view: Auto's _realMapGroup() only ever returns the
  // split 'mines'/'minesLower' group, so 'maze' would never equal it even
  // while the player is physically standing in the mines — the fix is to
  // treat 'maze' as containing the player whenever they're in either split
  // level, not just an exact key match.
  function _groupShowsRealZone(group) {
    if (group === 'maze') return MAZE_ZONES.has(_currentZone);
    return group === _realMapGroup();
  }
  function _mapData(group) {
    if (group === 'forest') {
      return { trail: _forestTrail, seen: _forestTrailSeen, entries: _forestEntry ? [_forestEntry] : [], stairs: _forestDungeonEntries, moveHist: _forestMoveHist, label: '🗺️ FOREST MAP', bounds: _forestTrailBounds };
    }
    // 'mines' and 'minesLower' reuse the same gates/staircases/death point as
    // the combined maze view (they're markers in the same shared world
    // coordinate space) — only the trail itself is split.
    if (group === 'mines') {
      return { trail: _minesTrail, seen: _minesTrailSeen, entries: _mazeEntries, stairs: _mazeStairs, moveHist: _mazeMoveHist, label: '🗺️ MINES MAP', death: _mazeDeathPoint, bounds: _minesTrailBounds };
    }
    if (group === 'minesLower') {
      return { trail: _minesLowerTrail, seen: _minesLowerTrailSeen, entries: [], stairs: _mazeStairs, moveHist: _mazeMoveHist, label: '🗺️ MINES LOWER MAP', death: _mazeDeathPoint, bounds: _minesLowerTrailBounds };
    }
    const cz = _customZoneFromGroup(group);
    if (cz) {
      const entry = _customMapEntry(cz);
      return { trail: entry.trail, seen: entry.seen, entries: [], stairs: [], moveHist: entry.moveHist, label: `🗺️ ${cz.toUpperCase()} MAP`, bounds: entry.bounds };
    }
    return { trail: _mazeTrail, seen: _mazeTrailSeen, entries: _mazeEntries, stairs: _mazeStairs, moveHist: _mazeMoveHist, label: '🗺️ MINE MAP', death: _mazeDeathPoint, bounds: _mazeTrailBounds };
  }

  // Same world→screen projection the canvas draw uses — shared so the
  // click-to-delete handler can hit-test points against exactly what's drawn.
  function _mapToScreen(p, view, W, H) {
    const rangeX = Math.max(view.maxX - view.minX, 1), rangeY = Math.max(view.maxY - view.minY, 1);
    const scale = Math.min(W / rangeX, H / rangeY);
    const offX = (W - rangeX * scale) / 2, offY = (H - rangeY * scale) / 2;
    return {
      x: offX + (p.x - view.minX) * scale,
      y: H - (offY + (p.y - view.minY) * scale),
    };
  }
  // Inverse of _mapToScreen — used by 📍 manual point-adding mode to turn a
  // click position back into a world coordinate.
  function _screenToMap(sx, sy, view, W, H) {
    const rangeX = Math.max(view.maxX - view.minX, 1), rangeY = Math.max(view.maxY - view.minY, 1);
    const scale = Math.min(W / rangeX, H / rangeY);
    const offX = (W - rangeX * scale) / 2, offY = (H - rangeY * scale) / 2;
    return {
      x: (sx - offX) / scale + view.minX,
      y: (H - sy - offY) / scale + view.minY,
    };
  }

  function mazeMapTargetBounds() {
    const group = _activeMapGroup();
    const { bounds, entries, stairs, death } = _mapData(group);
    const PAD = 6; // world units of padding around the explored area
    // Uses the incrementally-maintained trail bounds cache instead of
    // scanning every trail point each frame (see _computeBounds/_extendBounds
    // above) — only the player/entries/stairs/death points are compared here.
    // _playerPos is briefly null during a zone transition (old zone's
    // position cleared, new one not in yet) — this used to throw here every
    // frame in that window instead of just falling back to the other points.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    if (_playerPos) { minX = maxX = _playerPos.x; minY = maxY = _playerPos.y; }
    if (bounds) {
      if (bounds.minX < minX) minX = bounds.minX;
      if (bounds.maxX > maxX) maxX = bounds.maxX;
      if (bounds.minY < minY) minY = bounds.minY;
      if (bounds.maxY > maxY) maxY = bounds.maxY;
    }
    entries.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    stairs.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    if (death) {
      if (death.x < minX) minX = death.x;
      if (death.x > maxX) maxX = death.x;
      if (death.y < minY) minY = death.y;
      if (death.y > maxY) maxY = death.y;
    }
    if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = 0; }
    return { minX: minX - PAD, maxX: maxX + PAD, minY: minY - PAD, maxY: maxY + PAD };
  }

  // renderMazeMap() (clearRect + drawImage of the whole baked layer + every
  // marker) was running unconditionally on every requestAnimationFrame —
  // 60 times a second — even while the camera had already settled and
  // nothing on screen was actually changing. That's a fixed per-frame cost
  // that shows up equally everywhere (any zone, moving or standing still,
  // regardless of the 👾 toggle), unlike the trail-baking cost which only
  // showed up on growth/entry. The camera/player-dot interpolation above
  // still runs every frame (plain arithmetic, effectively free) so panning
  // stays smooth; only the actual canvas redraw is capped to ~20fps, which
  // is plenty for a minimap.
  const MAP_RENDER_INTERVAL_MS = 50;
  let _lastMapRenderAt = 0;

  // ─── Minimap tab (🗺️) — gates the whole minimap system on/off ────────────────
  // The map only does any work (bounds calc, trail baking, canvas render) while
  // this is true, and stays fully hidden otherwise, regardless of zone.
  let _minimapEnabled = false;
  let _mazeMapPosReapplied = false;
  try { _minimapEnabled = localStorage.getItem(MINIMAP_TAB_STORAGE_KEY) === '1'; } catch (_) {}


  function _updateMapTabHighlight() {
    const btn = document.getElementById('tabMap');
    if (!btn) return;
    btn.style.cssText = tabStyle(_minimapEnabled);
    btn.style.flex = '1';
    btn.textContent = btn.dataset.icon;
  }

  function toggleMinimapTab() {
    _minimapEnabled = !_minimapEnabled;
    try { localStorage.setItem(MINIMAP_TAB_STORAGE_KEY, _minimapEnabled ? '1' : '0'); } catch (_) {}
    if (!_minimapEnabled) mazeMap.style.display = 'none';
    _updateMapTabHighlight();
  }

  let _dbgLastFrameAt = 0;
  // Real rolling FPS measurement, logged once a second, tagged with how
  // much of that window had the dashed pointer-route line on screen and
  // how expensive drawing it was — to tell apart "rare recompute spikes"
  // (already fixed) from "small but constant per-frame draw cost" (a
  // continuous tax on every frame, which reads as a steady average FPS
  // drop rather than an occasional stutter, and wouldn't necessarily cross
  // the renderMazeMap >8ms warning threshold on its own).
  let _dbgFpsWindowStart = 0;
  let _dbgFpsFrameCount = 0;
  let _dbgFpsPointerFrames = 0;
  let _dbgDashDrawTotalMs = 0;
  let _dbgDashDrawMaxMs = 0;
  let _dbgDashDrawCalls = 0;
  let _dbgLastDashPts = 0;
  let _dbgLastDashPxLen = 0;
  const DBG_FPS_LOG_INTERVAL_MS = 1000;
  // Master switch for all "[ROE perf] ..." console.warn spam (fps, render
  // timing, trail-layer rebuilds, stair-graph rebuilds, pointer-path
  // recompute). Off by default — this is perf-tuning instrumentation, not
  // something that should be printing every second during normal play.
  // Flip to true from the browser console (window.__roeDbgPerf = true) when
  // actually profiling something.
  window.__roeDbgPerf = window.__roeDbgPerf || false;
  function mazeMapTick() {
    requestAnimationFrame(mazeMapTick);
    const _dbgNow = performance.now();
    if (window.__roeDbgPerf && _dbgLastFrameAt && _dbgNow - _dbgLastFrameAt > 80) {
      console.warn(`[ROE perf] frame gap: ${(_dbgNow - _dbgLastFrameAt).toFixed(1)}ms`);
    }
    _dbgLastFrameAt = _dbgNow;
    if (!_dbgFpsWindowStart) _dbgFpsWindowStart = _dbgNow;
    _dbgFpsFrameCount++;
    if (_dbgNow - _dbgFpsWindowStart >= DBG_FPS_LOG_INTERVAL_MS) {
      const elapsed = _dbgNow - _dbgFpsWindowStart;
      if (window.__roeDbgPerf) {
        const fps = (_dbgFpsFrameCount / elapsed * 1000).toFixed(1);
        const pointerPct = (100 * _dbgFpsPointerFrames / _dbgFpsFrameCount).toFixed(0);
        const dashAvg = _dbgDashDrawCalls ? (_dbgDashDrawTotalMs / _dbgDashDrawCalls).toFixed(2) : '0';
        console.warn(`[ROE perf] fps: ${fps} (${_dbgFpsFrameCount}f/${elapsed.toFixed(0)}ms), pointer-line drawn ${pointerPct}% of frames, dash-draw avg ${dashAvg}ms max ${_dbgDashDrawMaxMs.toFixed(2)}ms over ${_dbgDashDrawCalls} calls, last route ${_dbgLastDashPts}pts/${_dbgLastDashPxLen.toFixed(0)}px`);
      }
      _dbgFpsWindowStart = _dbgNow;
      _dbgFpsFrameCount = 0;
      _dbgFpsPointerFrames = 0;
      _dbgDashDrawTotalMs = 0;
      _dbgDashDrawMaxMs = 0;
      _dbgDashDrawCalls = 0;
    }
    if (!_minimapEnabled) { mazeMap.style.display = 'none'; return; }
    mazeMap.style.display = 'block';
    if (!_mazeMapPosReapplied) {
      // First real frame the panel is actually visible/laid-out (init runs
      // while display:none, so offsetWidth/Height are 0 there and any
      // earlier clamp math can't be trusted). Now that the collapsed state
      // uses visibility:hidden instead of display:none for the hidden
      // controls (see the .roe-minimap-collapsed CSS rule), the box's size
      // -- and so the canvas's position within it -- is identical whether
      // collapsed or expanded, so this is a plain restore-and-clamp, same
      // as the other floating panels' loadPanelPos().
      _mazeMapPosReapplied = true;
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('roeMazeMapPos')); } catch (_) {}
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        const left = Math.max(0, Math.min(window.innerWidth  - mazeMap.offsetWidth,  saved.left));
        const top  = Math.max(0, Math.min(window.innerHeight - mazeMap.offsetHeight, saved.top));
        mazeMap.style.left = left + 'px';
        mazeMap.style.top  = top  + 'px';
      }
    }
    const group = _activeMapGroup();
    if (!group) { _renderMapPlaceholder(); return; }
    const viewingRealZone = _groupShowsRealZone(group);

    const { moveHist } = _mapData(group);

    // Player dot: chase-lerp toward the newest real sample over the real
    // duration between the last two samples (span = b.t - a.t), starting
    // each new segment from wherever the dot currently is instead of a fixed
    // anchor — that combo avoids both failure modes tried before:
    // - lerping a fixed a→b pair snapped whenever a new sample landed before
    //   frac reached 1 (uneven packet timing, common in combat)
    // - chasing at a flat speed instead of the real span arrives at the
    //   target early whenever real speed is below the chase speed, then
    //   visibly sits waiting for the next packet
    // Using the real span as duration means frac reaches 1 right around when
    // the next real packet is actually expected, so there's no premature
    // wait. moveHist.length can be 1 right after a zone-entry reset (only
    // one real sample pushed so far) — for that case 'a' is synthesized from
    // _mapZoneEnterT (stamped at the reset), the real elapsed time the
    // player stood still before making their first move, instead of a
    // guessed constant.
    // A segment whose target sample landed within 1s of the last combat_hit
    // is the auto-reposition dash toward the enemy — stretched by
    // COMBAT_DASH_SLOWDOWN so it doesn't look like an abrupt jerk on attack.
    // Only meaningful while actually standing in the zone being viewed.
    if (viewingRealZone && _playerPos) {
      if (moveHist.length >= 1) {
        const b = moveHist[moveHist.length - 1];
        const a = moveHist.length === 2 ? moveHist[0]
          : (_mapZoneEnterT ? { x: _mapDisplayPlayer ? _mapDisplayPlayer.x : b.x, y: _mapDisplayPlayer ? _mapDisplayPlayer.y : b.y, t: _mapZoneEnterT } : null);
        if (!_mapInterp || _mapInterp.targetT !== b.t) {
          const from = _mapDisplayPlayer || a || b;
          const isCombatDash = _lastCombatActionT !== null && b.t - _lastCombatActionT >= 0 && b.t - _lastCombatActionT <= 1000;
          const baseDuration = a ? Math.max(b.t - a.t, 1) : DEFAULT_STEP_DURATION_MS;
          _mapInterp = {
            fromX: from.x, fromY: from.y,
            toX: b.x, toY: b.y,
            startT: Date.now(),
            duration: isCombatDash ? baseDuration * COMBAT_DASH_SLOWDOWN : baseDuration,
            targetT: b.t,
          };
        }
        const frac = Math.min(1, (Date.now() - _mapInterp.startT) / _mapInterp.duration);
        _mapDisplayPlayer = {
          x: _mapInterp.fromX + (_mapInterp.toX - _mapInterp.fromX) * frac,
          y: _mapInterp.fromY + (_mapInterp.toY - _mapInterp.fromY) * frac,
        };
      } else {
        _mapDisplayPlayer = { x: _playerPos.x, y: _playerPos.y };
        _mapInterp = null;
      }
    } else {
      _mapDisplayPlayer = null;
      _mapInterp = null;
    }

    // Auto-clear the pointer-arrow target once the player has actually
    // walked up to it — a manually-dropped waypoint (or a snapped marker)
    // that's already been reached is just clutter, same as if the user had
    // double-clicked it again to toggle it off. Only checked against the
    // real live position/zone (not a manually-viewed other zone).
    if (_pointerTarget && _playerPos && _currentZone === _pointerTarget.zone) {
      const distToTarget = Math.hypot(_playerPos.x - _pointerTarget.x, _playerPos.y - _pointerTarget.y);
      if (distToTarget <= POINTER_REACHED_RADIUS) {
        _pointerTarget = null;
        _pointerPathCache = { targetKey: null, playerZone: null, fullPath: null, computedAt: 0 };
      }
    }
    // The death-drop marker is intentionally NOT auto-cleared by proximity —
    // it should stay up until the runes are actually picked back up
    // (pickup_death_drop_ack, handled elsewhere), even if the player just
    // walks past/through the spot without looting.

    let target = mazeMapTargetBounds();
    // Follow mode + manual pan: once the player moves again after being idle
    // (the pan-while-idle window from _playerIsIdleForPan), snap the camera
    // back onto them instead of leaving it wherever it was dragged to.
    if (_mapFollowPlayer && (_mapPanX || _mapPanY) && viewingRealZone) {
      const { moveHist } = _mapData(group);
      const last = moveHist[moveHist.length - 1];
      if (last && (Date.now() - last.t) < FOLLOW_IDLE_MS) {
        _mapPanX = 0; _mapPanY = 0;
        _saveMapPan();
      }
    }
    // Keep the cursor in sync with whether panning is currently possible —
    // idle vs moving flips this every frame under follow mode, so a one-off
    // update on mode-toggle clicks isn't enough. Skipped while an edit mode
    // owns the cursor, while actively dragging (grabbing stays put), and
    // while hovering a marker (the hover handler owns the cursor there).
    if (!_mapPanDragging && !_mapHoveringMarker && !(_mapDeleteMode || _mapStairsDeleteMode || _mapAddPointMode || _mapAddStairsMode || _mapCutMode || _mapCutEraseMode)) {
      const _cEl = _mazeMapCanvasEl;
      if (_cEl) {
        const _wantCursor = _playerIsIdleForPan() ? 'grab' : 'default';
        if (_cEl.style.cursor !== _wantCursor) _cEl.style.cursor = _wantCursor;
      }
    }
    // Zoom must work even when viewing a manually-selected map you're not
    // currently standing in (_mapDisplayPlayer is null there, since there's
    // no live position to show a dot for). In that case zoom around the
    // center of the auto-fit box instead of the player.
    const _zoomAnchor = _mapDisplayPlayer || {
      x: (target.minX + target.maxX) / 2,
      y: (target.minY + target.maxY) / 2,
    };
    if (_mapZoom !== 1 || (_mapDisplayPlayer && _mapFollowPlayer)) {
      // Shrink the auto-fit box around the player's *smoothed* position
      // (same one the blue dot uses) instead of the raw, discretely-updated
      // _playerPos — otherwise the camera only moves in step with sparse
      // move samples while the dot glides continuously between them, which
      // reads as the camera jerking compared to the character.
      //
      // The zoom window is shaped to the PANEL's actual pixel aspect ratio
      // (canvas.width/canvas.height), not the full explored area's aspect
      // ratio. Previously halfW/halfH were each derived independently from
      // the full auto-fit box's own width/height — for a landscape-shaped
      // trail (wide, short) that locked the zoom window to the same
      // landscape shape no matter how the panel itself was sized, so
      // zooming in always revealed far less vertical territory than
      // horizontal, reading as the map being clipped top/bottom even
      // though more trail existed just past the edge. Total visible area
      // at zoom=1 is kept equal to the old full-fit area, just reshaped.
      const fullRangeX = target.maxX - target.minX;
      const fullRangeY = target.maxY - target.minY;
      const fullArea = Math.max(fullRangeX * fullRangeY, 1);
      const canvasEl = _mazeMapCanvasEl;
      const camAspect = (canvasEl && canvasEl.width && canvasEl.height)
        ? canvasEl.width / canvasEl.height
        : Math.max(fullRangeX / Math.max(fullRangeY, 1), 0.01);
      const halfH = Math.sqrt(fullArea / camAspect) / 2 / _mapZoom;
      const halfW = halfH * camAspect;
      target = {
        minX: _zoomAnchor.x - halfW, maxX: _zoomAnchor.x + halfW,
        minY: _zoomAnchor.y - halfH, maxY: _zoomAnchor.y + halfH,
      };
    }
    if (!_mapView) _mapView = { ...target };
    for (const k of ['minX', 'maxX', 'minY', 'maxY']) {
      _mapView[k] += (target[k] - _mapView[k]) * 0.1;
    }

    const now = performance.now();
    if (now - _lastMapRenderAt < 1000 / _minimapSettings.fps) return;
    _lastMapRenderAt = now;
    const _dbgRT0 = performance.now();
    renderMazeMap();
    const _dbgRDur = performance.now() - _dbgRT0;
    if (window.__roeDbgPerf && _dbgRDur > 8) console.warn(`[ROE perf] renderMazeMap: ${_dbgRDur.toFixed(1)}ms`);
  }
  requestAnimationFrame(mazeMapTick);

  // Shown when Auto mode has no real zone to track (player is somewhere
  // unmapped, e.g. Town) — clears the canvas but keeps the header/mode row
  // interactive so the player can still switch to Manual from here.
  function _renderMapPlaceholder() {
    if (_mazeMapTitleEl) _mazeMapTitleEl.textContent = '🗺️ Not in a mapped zone';
    if (_mazeMapDistEl) _mazeMapDistEl.textContent = '🚪 —';
    if (_mazeMapStairsDistEl) _mazeMapStairsDistEl.textContent = '🪜 —';
    if (_mazeMapCoordsEl) _mazeMapCoordsEl.textContent = '';
    if (_mazeMapRuneEl) _mazeMapRuneEl.style.display = 'none';
    const canvas = _mazeMapCanvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    _drawNoSignal(ctx, canvas.width, canvas.height, 'OUT OF RANGE', 'not in a tracked zone right now');
  }

  // Small retro "no signal" glitch for maps with nothing recorded yet —
  // scanlines + a flickery static texture behind the text, so an empty
  // map reads as "nothing here" rather than "something's broken".
  let _noSignalFlickerSeed = 0;
  let _noSignalNextGlitchAt = 0;
  let _noSignalGlitchUntil = 0;
  let _noSignalTextBuf = null;
  function _drawNoSignal(ctx, W, H, mainText = 'NO DATA', subText = '') {
    ctx.save();
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, W, H);

    // Sparse static speckle, reseeded each render for a subtle flicker.
    _noSignalFlickerSeed = (_noSignalFlickerSeed + 1) % 1000000;
    let _s = _noSignalFlickerSeed || 1;
    const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return (_s % 1000) / 1000; };
    ctx.fillStyle = 'rgba(90,255,120,0.10)';
    const speckleCount = Math.round((W * H) / 400);
    for (let i = 0; i < speckleCount; i++) {
      const x = rnd() * W, y = rnd() * H;
      ctx.fillRect(x, y, 1, 1);
    }

    // Thicker CRT-style scanlines — alternating dark bands instead of thin
    // hairlines, closer to an actual low-res tube than a subtle overlay.
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    for (let y = 0; y < H; y += 4) {
      ctx.fillRect(0, y, W, 2);
    }
    ctx.strokeStyle = 'rgba(90,255,120,0.05)';
    ctx.lineWidth = 1;
    for (let y = 1; y < H; y += 4) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
    }

    // Occasional glitch burst instead of continuous jitter — gated by a
    // real cooldown (wall-clock time), not a per-frame coin flip, so it
    // reads as a rare hiccup every few seconds rather than a constant
    // shimmer. Once triggered, the burst itself holds for a short window
    // so it's visible instead of a single-frame flash.
    const _nowMs = Date.now();
    if (_minimapSettings.glitchEffect && _nowMs >= _noSignalNextGlitchAt) {
      _noSignalGlitchUntil = _nowMs + 150; // burst holds for ~150ms
      _noSignalNextGlitchAt = _nowMs + 3000 + rnd() * 7000; // next one in 3–10s
    }
    const glitchActive = _minimapSettings.glitchEffect && _nowMs < _noSignalGlitchUntil;
    const cx = W / 2, cy = subText ? H / 2 - Math.round(H * 0.06) : H / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fontSize = Math.max(11, Math.round(H * 0.12));
    ctx.font = `bold ${fontSize}px monospace`;

    if (glitchActive) {
      // Render the text to an offscreen buffer first, then tear THAT apart —
      // slicing the already-shifted background (previous approach) left the
      // static text looking untouched on top of it. Cutting the glyphs
      // themselves into horizontal strips and offsetting each strip
      // independently is what actually reads as "letters ripping apart".
      if (!_noSignalTextBuf || _noSignalTextBuf.width !== W || _noSignalTextBuf.height !== H) {
        _noSignalTextBuf = document.createElement('canvas');
        _noSignalTextBuf.width = W;
        _noSignalTextBuf.height = H;
      }
      const bctx = _noSignalTextBuf.getContext('2d');
      bctx.clearRect(0, 0, W, H);
      bctx.textAlign = 'center';
      bctx.textBaseline = 'middle';
      bctx.font = `bold ${fontSize}px monospace`;
      // RGB-split baked into the buffer too, so torn strips carry the
      // chromatic-aberration look with them. Previously all three channels
      // used 'lighter' blending stacked almost on top of each other, which
      // sums back to near-white where they overlap — barely visible as
      // color. Bigger offset + base text drawn solid first (so there's a
      // real green core) with only the red/blue fringes additive fixes that.
      const splitX = 3 + Math.round(rnd() * 5);
      bctx.fillStyle = '#5aff78';
      bctx.fillText(mainText, cx, cy);
      bctx.globalCompositeOperation = 'lighter';
      bctx.fillStyle = 'rgba(255,20,40,0.9)';
      bctx.fillText(mainText, cx - splitX, cy);
      bctx.fillStyle = 'rgba(30,120,255,0.9)';
      bctx.fillText(mainText, cx + splitX, cy);
      bctx.globalCompositeOperation = 'source-over';

      // Text-height band around cy, cut into several thin strips, each
      // thrown sideways by its own random offset — this is what actually
      // tears the letterforms apart rather than just shifting a background.
      const bandTop = Math.max(0, Math.floor(cy - fontSize * 0.9));
      const bandH = Math.min(H - bandTop, Math.ceil(fontSize * 1.8));
      const stripCount = 5 + Math.floor(rnd() * 4);
      const stripH = Math.max(1, Math.floor(bandH / stripCount));
      for (let i = 0; i < stripCount; i++) {
        const sy = bandTop + i * stripH;
        const sh = Math.min(stripH, H - sy);
        if (sh <= 0) continue;
        const tearX = Math.round((rnd() - 0.5) * W * 0.16);
        ctx.drawImage(_noSignalTextBuf, 0, sy, W, sh, tearX, sy, W, sh);
      }
      // A couple of full-width background scan-tear bands elsewhere on the
      // canvas, independent of the text, for extra static-y chaos.
      const tearBands = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < tearBands; i++) {
        const sliceY = Math.floor(rnd() * H);
        const sliceH = Math.max(2, Math.floor(rnd() * H * 0.06));
        const shiftX = Math.round((rnd() - 0.5) * W * 0.1);
        try {
          const imgData = ctx.getImageData(0, Math.max(0, sliceY), W, Math.min(sliceH, H - sliceY));
          ctx.putImageData(imgData, shiftX, Math.max(0, sliceY));
        } catch (_) { /* canvas may be tainted in edge cases; skip */ }
      }
    } else {
      ctx.fillStyle = '#5aff78';
      ctx.shadowColor = '#5aff78';
      ctx.shadowBlur = 3;
      ctx.fillText(mainText, cx, cy);
      ctx.shadowBlur = 0;
    }
    if (subText) {
      ctx.font = `${Math.max(8, Math.round(fontSize * 0.4))}px monospace`;
      ctx.fillStyle = 'rgba(90,255,120,0.55)';
      ctx.fillText(subText, W / 2, cy + fontSize * 1.1);
    }

    // CRT tube overlay: dark radial vignette toward the corners (simulates
    // the glass curvature falling into shadow at the edges) plus a rounded
    // dark frame so the whole thing reads as a screen, not a flat rectangle.
    const vign = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.55);
    vign.addColorStop(0, 'rgba(0,0,0,0)');
    vign.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = vign;
    ctx.fillRect(0, 0, W, H);
    const frameR = Math.min(W, H) * 0.06;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = frameR;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(frameR / 2, frameR / 2, W - frameR, H - frameR, frameR * 1.5);
    } else {
      ctx.rect(frameR / 2, frameR / 2, W - frameR, H - frameR);
    }
    ctx.stroke();

    ctx.restore();
  }

  function renderMazeMap() {
    const group = _activeMapGroup();
    if (group !== _lastRenderedMapGroup) {
      _loadMapZoomFor(group);
      _lastRenderedMapGroup = group;
    }
    const viewingRealZone = _groupShowsRealZone(group);
    const { trail, entries, stairs, death, label } = _mapData(group);

    const titleEl = _mazeMapTitleEl;
    if (titleEl) titleEl.textContent = label;

    // Distance/direction readout to the nearest remembered entrance/exit
    // (exact values, not smoothed — it's just text)
    const distEl = _mazeMapDistEl;
    if (distEl) {
      let nearest = null, nearestDist = Infinity;
      if (viewingRealZone && _playerPos) {
        entries.forEach(p => {
          const d = Math.hypot(p.x - _playerPos.x, p.y - _playerPos.y);
          if (d < nearestDist) { nearestDist = d; nearest = p; }
        });
      }
      if (nearest) {
        const ddx = nearest.x - _playerPos.x, ddy = nearest.y - _playerPos.y;
        const angle = Math.atan2(ddy, ddx);
        const arrows = ['→','↗','↑','↖','←','↙','↓','↘'];
        const arrow = arrows[Math.round(((angle / Math.PI * 4) + 8)) % 8];
        distEl.textContent = `🚪${arrow} ${nearestDist.toFixed(1)}u`;
      } else {
        distEl.textContent = '🚪 —';
      }
    }

    // Debug readout: live distance to the nearest known staircase, so the
    // STAIRS_PREVIEW_TRIGGER/RELEASE thresholds can be tuned by eye instead
    // of guessed at from a screenshot.
    const stairsDistEl = _mazeMapStairsDistEl;
    if (stairsDistEl) {
      let nearestStairDist = Infinity;
      if (viewingRealZone && _playerPos) {
        stairs.forEach(p => {
          const d = Math.hypot(p.x - _playerPos.x, p.y - _playerPos.y);
          if (d < nearestStairDist) nearestStairDist = d;
        });
      }
      stairsDistEl.textContent = Number.isFinite(nearestStairDist)
        ? `🪜 ${nearestStairDist.toFixed(1)}u${_pendingSplitFlip ? ' (preview)' : ''}`
        : '🪜 —';
    }

    const coordsEl = _mazeMapCoordsEl;
    if (coordsEl) coordsEl.textContent = (viewingRealZone && _playerPos) ? `x:${_playerPos.x.toFixed(1)} y:${_playerPos.y.toFixed(1)}` : '';

    const runeEl = _mazeMapRuneEl;
    if (runeEl) {
      let closest = null, minDist = Infinity;
      if (viewingRealZone && _playerPos) {
        for (const drop of _worldDropRunes) {
          if (drop.zone !== _currentZone) continue;
          const dx = drop.pos.x - _playerPos.x, dy = drop.pos.y - _playerPos.y;
          const d = Math.hypot(dx, dy);
          if (d < minDist) { minDist = d; closest = { drop, dx, dy, d }; }
        }
      }
      if (closest) {
        const arrows = ['→','↗','↑','↖','←','↙','↓','↘'];
        const arrow = arrows[Math.round(((Math.atan2(closest.dy, closest.dx) / Math.PI * 4) + 8)) % 8];
        const qty = closest.drop.quantity.toLocaleString();
        runeEl.textContent = `ᚱ${qty} ${arrow} ${closest.d.toFixed(1)}u`;
        runeEl.style.display = '';
      } else {
        runeEl.style.display = 'none';
      }
    }

    const canvas = _mazeMapCanvasEl;
    if (!canvas || !_mapView) return;

    const view = _pannedView();
    const { minX, maxX, minY, maxY } = view;
    const rangeX = Math.max(maxX - minX, 1), rangeY = Math.max(maxY - minY, 1);

    // Canvas height follows the explored area's aspect ratio instead of always
    // being a fixed square — a wide, short trail (or a tall, narrow one) no
    // longer leaves a big dead margin inside the canvas. Clamped to the
    // canvas's own (resizable) width so a wider map can also get taller.
    // Skipped once the user has manually dragged the height (bottom/corner
    // handle) — their chosen height then sticks instead of being overwritten
    // every frame.
    if (!window._mazeMapManualHeight) {
      // Was previously capped at `canvas.width`, which forced the map to
      // never render taller than it is wide — for a portrait-oriented
      // explored area (rangeY > rangeX, e.g. a long vertical corridor) this
      // squeezed the view far more than the aspect ratio warranted, reading
      // as the map being clipped top/bottom after a resize. Cap is now a
      // fixed generous ceiling instead of being tied to the current width.
      const targetH = Math.round(Math.max(70, Math.min(900, canvas.width * (rangeY / rangeX))));
      if (canvas.height !== targetH) canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Reset the hover hit-test list for this frame — repopulated below as
    // each mob/resource marker is drawn, then used by the canvas mousemove
    // handler to show a name tooltip on hover.
    _mazeMapHoverMarkers.length = 0;
    _mazeMapOffscreenDropArrows = [];
    _edgeArrowCandidates = [];

    // Empty map easter egg — nothing recorded for this zone yet (fresh
    // custom map, or a built-in one never actually visited). Draw a little
    // "no signal" glitch instead of leaving the canvas plain black, then
    // bail before any of the (pointless, on empty data) marker/trail work
    // below.
    if (trail.length === 0 && entries.length === 0 && stairs.length === 0 && !death) {
      _drawNoSignal(ctx, W, H, 'NO DATA', 'walk around this zone to record a trail');
      return;
    }

    // Precomputed once per frame — _mapToScreen recalculated this same
    // scale/offset math from scratch on every single marker (entries,
    // stairs, tracked mobs, resources, drops…), which is wasted work when
    // called dozens of times per render at a high configured minimap FPS.
    const _screenScale = Math.min(W / rangeX, H / rangeY);
    const _screenOffX = (W - rangeX * _screenScale) / 2, _screenOffY = (H - rangeY * _screenScale) / 2;
    const toScreen = (p) => ({
      x: _screenOffX + (p.x - minX) * _screenScale,
      y: H - (_screenOffY + (p.y - minY) * _screenScale),
    });

    // Explored path — baked once per group into a world-space layer (see
    // _ensureTrailLayerFresh above) and cropped here with a single
    // drawImage call. This is O(1) regardless of trail size or camera
    // movement, unlike re-stroking every point in view-space every frame.
    const trailState = _ensureTrailLayerFresh(group);
    if (trailState.scale) {
      const sx = (minX - trailState.originX) * trailState.scale;
      const sy = (trailState.originY - maxY) * trailState.scale;
      const sw = rangeX * trailState.scale;
      const sh = rangeY * trailState.scale;
      // Destination must use the SAME uniform scale + letterbox offsets as
      // _mapToScreen (used for every other marker below) — stretching the
      // source rect to fill the full W×H canvas distorts the trail
      // whenever the canvas aspect ratio doesn't exactly match rangeX/rangeY
      // (e.g. a manually-resized map height), since X and Y would then be
      // scaled by different factors.
      const uScale = Math.min(W / rangeX, H / rangeY);
      const dx = (W - rangeX * uScale) / 2, dy = (H - rangeY * uScale) / 2;
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.imageSmoothingEnabled = _minimapSettings.smoothing;
      ctx.drawImage(trailState.canvas, sx, sy, sw, sh, dx, dy, rangeX * uScale, rangeY * uScale);
      ctx.restore();
    }

    // Entrance/exit markers — every distinct spot we've walked into the maze from outside
    ctx.fillStyle = '#22ff66';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    entries.forEach(p => {
      const s = toScreen(p);
      ctx.fillRect(s.x - 5, s.y - 5, 10, 10);
      ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
      _mazeMapHoverMarkers.push({ x: s.x, y: s.y, r: 7, label: '🚪 Entrance/exit', wx: p.x, wy: p.y });
    });

    // Staircase markers — every distinct Mines<->MinesLower transition point
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    stairs.forEach(p => {
      const s = toScreen(p);
      ctx.fillRect(s.x - 5, s.y - 5, 10, 10);
      ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
      _mazeMapHoverMarkers.push({ x: s.x, y: s.y, r: 7, label: '🪜 Staircase', wx: p.x, wy: p.y });
    });

    // 🪜➕ restore mode: blacklisted (previously deleted) spots are normally
    // invisible — show them as faint dashed outlines so there's something
    // to click on to bring one back.
    if (_mapAddStairsMode && (group === 'maze' || group === 'mines' || group === 'minesLower')) {
      ctx.save();
      ctx.strokeStyle = '#ff6666';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      _mazeStairsBlacklist.forEach(p => {
        const s = toScreen(p);
        ctx.strokeRect(s.x - 6, s.y - 6, 12, 12);
      });
      ctx.restore();
    }

    // Cut points (✂️ scissors tool) — only visible while Edit Mode is on,
    // so the map isn't cluttered with them during normal play. The cuts
    // themselves are always baked into the trail regardless of this — this
    // block is purely a visibility toggle for the markers, not the effect.
    if (_minimapSettings.editMode) {
      const cuts = _cutsFor(group);
      if (cuts.length) {
        ctx.save();
        cuts.forEach(p => {
          const s = toScreen(p);
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#ff3b3b';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          _mazeMapHoverMarkers.push({ x: s.x, y: s.y, r: 6, label: '✂️ Cut', wx: p.x, wy: p.y });
        });
        ctx.restore();
      }
    }

    // Death marker — where we last died in this maze (from the real
    // player_death event), drawn as a red X with a white outline (same
    // outline treatment as the other markers)
    if (death) {
      const s = toScreen(death);
      ctx.beginPath();
      ctx.moveTo(s.x - 5, s.y - 5); ctx.lineTo(s.x + 5, s.y + 5);
      ctx.moveTo(s.x + 5, s.y - 5); ctx.lineTo(s.x - 5, s.y + 5);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.stroke();
      _mazeMapHoverMarkers.push({ x: s.x, y: s.y, r: 7, label: '💀 Death spot', wx: death.x, wy: death.y });
      _edgeArrowCandidates.push({ pos: death, color: '#f87171', kind: 'death', meta: { label: '💀 Death spot' } });
    }

    // Player marker (drawn before enemies so enemy dots render on top)
    if (_mapDisplayPlayer) {
      const sp = toScreen(_mapDisplayPlayer);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#60a5fa';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Dead-marker alpha helper — a plain dim 0.4 for most of the respawn
    // wait, but blinks over the final 10 seconds before the timer AND keeps
    // blinking indefinitely past the timer if the server still hasn't
    // confirmed the mob alive ("probably up" state) — that post-timer
    // window is exactly where an estimated timer might be wrong, so it
    // stays attention-grabbing until an alive spawn_state clears it.
    const MOB_RESPAWN_BLINK_MS = 10000;
    const _deadMarkerAlpha = (alive, respawnAt) => {
      if (alive) return 1;
      if (respawnAt) {
        const remain = respawnAt - Date.now();
        if (remain <= MOB_RESPAWN_BLINK_MS) {
          // ~2.5 blinks/sec — fast enough to read as "about to happen" but
          // not so fast it looks glitchy. Square wave, not a smooth pulse,
          // so it's unambiguous even glanced at peripherally.
          const on = Math.floor(Date.now() / 200) % 2 === 0;
          return on ? 1 : 0.15;
        }
      }
      return 0.4;
    };

    // Enemy markers — all shown red with a white outline for visibility
    // against the dark map background. Tracked mobs are drawn a bit bigger
    // so they still stand out among the regular alive-mob markers.
    const _czForMobs = _customZoneFromGroup(group);
    const realZones = group === 'forest' ? Array.from(FOREST_ZONES)
      : group === 'mines' ? ['Mines']
      : group === 'minesLower' ? ['MinesLower']
      : _czForMobs ? [_czForMobs]
      : Array.from(MAZE_ZONES);
    ctx.strokeStyle = '#000';
    if (_mapShowAllMobs) {
      // Build the tracked-key set once per render instead of calling
      // isMobTracked() (which itself loops all trackedMobs) for every
      // single mob — turns an O(mobs × tracked) scan into O(mobs + tracked).
      const trackedKeys = new Set();
      trackedMobs.forEach(v => trackedKeys.add(`${v.zone}|${v.statsKey}`));
      ctx.fillStyle = '#ef4444';
      ctx.lineWidth = 2;
      realZones.forEach(zone => {
        (lastStateByZone[zone] || []).forEach(e => {
          if (!e.pos) return;
          if (_minimapSettings.hiddenMobs.includes(e.statsKey)) return;
          if (trackedKeys.has(`${zone}|${e.statsKey}`)) return; // drawn bigger below
          const s = toScreen(e.pos);
          const isPointed = _pointerTarget && _pointerTarget.zone === zone && _pointerKey(zone, e.pos) === _pointerTarget.key;
          const _respawnAtForE = enemyRespawnTimers.get(e.id) || e.respawnAt || null;
          ctx.globalAlpha = _deadMarkerAlpha(e.alive, _respawnAtForE);
          ctx.strokeStyle = isPointed ? '#fff' : '#000';
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          _mazeMapHoverMarkers.push({ x: s.x, y: s.y, r: 6, label: formatDisplayName(e.statsKey), sub: e.alive ? 'alive' : 'dead', wx: e.pos.x, wy: e.pos.y, wzone: zone, respawnAt: _respawnAtForE });
        });
      });
      ctx.globalAlpha = 1;
    }
    // Tracked mobs are always purple so they stand out from regular red
    // enemy dots. Dead ones are dimmed so alive vs dead stays distinguishable.
    ctx.lineWidth = 2;
    trackedMobs.forEach((v, id) => {
      if (!realZones.includes(v.zone)) return;
      if (_minimapSettings.hiddenMobs.includes(v.statsKey)) return;
      v.nodes.forEach(n => {
        if (!n.pos) return;
        const s = toScreen(n.pos);
        const isPointed = _pointerTarget && _pointerTarget.zone === v.zone && _pointerKey(v.zone, n.pos) === _pointerTarget.key;
        const _respawnAtForN = enemyRespawnTimers.get(n.id) || n.respawnAt || null;
        ctx.globalAlpha = _deadMarkerAlpha(n.alive, _respawnAtForN);
        ctx.fillStyle = '#a855f7';
        ctx.strokeStyle = isPointed ? '#fff' : '#000';
        ctx.beginPath();
        ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        _mazeMapHoverMarkers.push({ x: s.x, y: s.y, r: 8, label: formatDisplayName(v.statsKey), sub: n.alive ? 'alive · tracked' : 'dead · tracked', wx: n.pos.x, wy: n.pos.y, wzone: v.zone, respawnAt: _respawnAtForN });
        // Not registered as an edge-arrow candidate — tracked mobs move
        // around too much for a stable "walk toward this arrow" pointer to
        // stay meaningful, unlike the mostly-static drops/death-spot/pins.
      });
    });
    ctx.globalAlpha = 1;

    // Resource nodes — shown bright gold with a black outline, same
    // treatment as the other markers above.
    ctx.fillStyle = '#ffd700';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    realZones.forEach(zone => {
      (lastResourcesByZone[zone] || []).forEach(r => {
        if (!r.pos) return;
        if (_minimapSettings.hiddenResources.includes(r.resource)) return;
        const s = toScreen(r.pos);
        const isPointed = _pointerTarget && _pointerTarget.zone === zone && _pointerKey(zone, r.pos) === _pointerTarget.key;
        ctx.globalAlpha = r.active ? 1 : 0.4;
        ctx.strokeStyle = isPointed ? '#fff' : '#000';
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        _mazeMapHoverMarkers.push({ x: s.x, y: s.y, r: 6, label: formatResName(r.resource), sub: r.active ? 'active' : 'depleted', wx: r.pos.x, wy: r.pos.y, wzone: zone, respawnAt: r.active ? null : (getNodeMaxTimer(r.idx) || r.cooldownExpiresAt || null) });
      });
    });
    ctx.globalAlpha = 1;

    // World drops on the ground — runestones and other loose items (from a
    // player drop or mob kill), drawn as small diamonds so they read
    // distinctly from the round mob/resource dots. Filtered to only the
    // zone(s) actually shown by the current view — each drop is tagged
    // with the zone it was recorded in (see restore_world_drops/loot_drop
    // handlers), since without that a drop from a zone the player has since
    // left kept being drawn (and arrowed at) even while viewing an
    // unrelated zone.
    const _dropInView = (d) => realZones.includes(d.zone);
    const drawDropDiamond = (pos, color) => {
      const s = toScreen(pos);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 5);
      ctx.lineTo(s.x + 5, s.y);
      ctx.lineTo(s.x, s.y + 5);
      ctx.lineTo(s.x - 5, s.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };
    _worldDropRunes.filter(_dropInView).forEach(d => drawDropDiamond(d.pos, '#e0b3ff'));
    _worldDropItems.filter(_dropInView).forEach(d => drawDropDiamond(d.pos, '#ff8c42'));

    // World drops are also edge-arrow candidates, same as death spot /
    // tracked mobs / pins registered elsewhere — actual clustering and
    // drawing happens once, after every candidate for this frame has been
    // collected (see the end of this function).
    _worldDropRunes.filter(_dropInView).forEach(d => _edgeArrowCandidates.push({ pos: d.pos, color: '#e0b3ff', kind: 'drop', meta: { drop: d, isRune: true } }));
    _worldDropItems.filter(_dropInView).forEach(d => _edgeArrowCandidates.push({ pos: d.pos, color: '#ff8c42', kind: 'drop', meta: { drop: d, isRune: false } }));

    // Path to the current pointer-arrow target, routed through the explored
    // trail when possible (same zone-equivalence rule used elsewhere —
    // Mines and MinesLower share one coordinate space, so a target on the
    // other level is still valid from either split view).
    // Draws the dashed route + pin for one target. Reused for both the
    // manual pointer-arrow target and the death-drop marker so the two can
    // be shown at the same time — previously they shared one variable and
    // one path cache, so setting one silently discarded the other's route.
    const drawRouteToTarget = (target, cache, pendingGetSet, dropHysteresisRef, pinColor, pinPosRef) => {
      if (!target || !viewingRealZone || !_mapDisplayPlayer) { pinPosRef.value = null; return; }
      const _czPointer = _customZoneFromGroup(group);
      const pointerZoneOk = group === 'forest'
        ? target.zone === 'Forest'
        : _czPointer ? target.zone === _czPointer
        : MAZE_ZONES.has(target.zone);
      if (!pointerZoneOk) { pinPosRef.value = null; return; }
      _edgeArrowCandidates.push({ pos: { x: target.x, y: target.y }, color: pinColor, kind: 'pin', meta: { label: target.label || '📍 Waypoint' } });
      const route = _getPointerPath(group, target, cache, pendingGetSet); // { waypoints, endPoint } or null if no route found
      // _getPointerPath returns null for a couple of frames right after a
      // fresh target is set (the A* search is deferred via setTimeout so
      // it doesn't block this frame's render). Falling through to the plain
      // player->target straight line in that window drew one long diagonal
      // cutting across the corridor shape for those frames. Skip drawing
      // the line until the real route (with its intermediate waypoints) is
      // ready instead.
      if (!route && pendingGetSet.get()) { pinPosRef.value = null; return; }
      // Anchored to _mapDisplayPlayer (the same smoothed/lerped position
      // the blue player dot itself is drawn from), not the raw _playerPos.
      // The route data (waypoints/drift/stale checks in _getPointerPath)
      // still keys off the real position — only the drawn start point
      // changes here — so the line's start now glides in lockstep with
      // the dot instead of the line's near end snapping to the real
      // position a beat before the dot visually arrives there.
      let routeWaypoints = route ? (route.waypoints || []) : [];
      // The first few A* waypoints can all just be wherever
      // _nearestWalkableCell happened to snap the (off-grid) player
      // position onto the MAZE_TRAIL_MIN_STEP grid, plus one or two more
      // grid hops the search took before it reached a real corridor turn —
      // none of that is meaningful shape, just grid noise close to the
      // player. Drawing straight through those points produces a kink at
      // an odd angle (looks like a hard 90° even when the corridor itself
      // runs at 45°) right next to the marker. Repeatedly drop the
      // leading waypoint while it's within POINTER_DROP_RADIUS of the
      // player and there's still a further one to head toward instead —
      // this keeps going, so a cluster of several near-player grid nodes
      // collapses down to the first one that's actually far enough out to
      // represent real direction.
      //
      // _mapDisplayPlayer moves every frame (it's the interpolated dot
      // position), so a waypoint sitting right around dropRadius flips in
      // and out of range from one frame to the next — the drop count
      // jumps 2/1/2/1 as the dot glides past that distance, which reads
      // as the line's start end visibly jittering. A one-directional
      // hysteresis fixes this: once N waypoints have been dropped for the
      // *current* route (tracked per target via dropHysteresisRef),
      // that count only ever grows — it never drops back down just
      // because the dot momentarily reads a hair closer again — so a
      // frame right at the boundary keeps whatever it had last frame
      // instead of flip-flopping. It still climbs immediately if the dot
      // is clearly further out, and resets whenever the target changes.
      const POINTER_DROP_RADIUS_CELLS = 1.1; // multiples of MAZE_TRAIL_MIN_STEP; raise to drop more nodes near the player
      const POINTER_DROP_MAX_NODES = 3;      // safety cap so a short route can't get dropped down to nothing
      const dropRadius = MAZE_TRAIL_MIN_STEP * POINTER_DROP_RADIUS_CELLS;
      if (dropHysteresisRef.value.key !== target.key) {
        dropHysteresisRef.value = { key: target.key, count: 0 };
      }
      let wantedDrops = 0;
      {
        let probe = routeWaypoints;
        while (probe.length > 1 && wantedDrops < POINTER_DROP_MAX_NODES) {
          const d = Math.hypot(probe[0].x - _mapDisplayPlayer.x, probe[0].y - _mapDisplayPlayer.y);
          if (d > dropRadius) break;
          wantedDrops++;
          probe = probe.slice(1);
        }
      }
      // Cap to what the (possibly-shrinking, as the player actually walks
      // the route) waypoint list can still support, then only ever move
      // the sticky count upward.
      const maxSupportable = Math.max(0, routeWaypoints.length - 1);
      if (wantedDrops > dropHysteresisRef.value.count) dropHysteresisRef.value.count = wantedDrops;
      const dropCount = Math.min(dropHysteresisRef.value.count, maxSupportable, POINTER_DROP_MAX_NODES);
      const _dbgDroppedWaypoints = routeWaypoints.slice(0, dropCount);
      routeWaypoints = routeWaypoints.slice(dropCount);
      const worldPts = route
        ? [_mapDisplayPlayer, ...routeWaypoints, route.endPoint]
        : [_mapDisplayPlayer, target];
      const screenPts = worldPts.map(toScreen);
      const _dbgDashT0 = performance.now();
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      let _dbgPxLen = 0;
      if (screenPts.length >= 2) {
        // Drawn from the target end backward to the player, not the other
        // way round. setLineDash phases from the moveTo point, and the
        // player end moves every frame — starting there made the whole
        // dash pattern re-flow across the entire line on every step
        // instead of just the one partial dash next to the player
        // changing. The target is fixed, so anchoring the pattern there
        // keeps already-passed dashes visually still.
        const pts = screenPts.slice().reverse();
        ctx.moveTo(pts[0].x, pts[0].y);
        // Straight lineTo between every waypoint kinks sharply at each
        // turn (visible on the minimap as the dashed route "breaking" at
        // corners instead of curving). Using each interior point as a
        // quadraticCurveTo control point, ending at the midpoint of that
        // point and the next one, rounds the turn off while keeping the
        // curve anchored to the actual route (start/end points are exact;
        // only interior corners get smoothed).
        const last = pts.length - 1;
        for (let i = 1; i < last; i++) {
          const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mid.x, mid.y);
          _dbgPxLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        }
        _dbgPxLen += Math.hypot(pts[last].x - pts[last - 1].x, pts[last].y - pts[last - 1].y);
        ctx.lineTo(pts[last].x, pts[last].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      // Per-call cost of just this block — separate from the rest of
      // renderMazeMap — plus screen-space length, which is what the dash
      // count (and therefore, per the known Canvas dashed-stroke
      // performance issue, the rasterization cost) actually scales with.
      const _dbgDashDur = performance.now() - _dbgDashT0;
      _dbgFpsPointerFrames++;
      _dbgDashDrawCalls++;
      _dbgDashDrawTotalMs += _dbgDashDur;
      if (_dbgDashDur > _dbgDashDrawMaxMs) _dbgDashDrawMaxMs = _dbgDashDur;
      _dbgLastDashPts = screenPts.length;
      _dbgLastDashPxLen = _dbgPxLen;

      // A real pin marker at the target end, instead of letting the dashed
      // route just stop in empty space — gives the waypoint an actual
      // visual anchor to walk toward, and doubles as feedback that a
      // target is currently set (it disappears the moment the player
      // reaches it or toggles it off).
      const pinTip = screenPts[screenPts.length - 1];
      pinPosRef.value = { x: pinTip.x, y: pinTip.y };
      ctx.save();
      ctx.translate(pinTip.x, pinTip.y);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-7, -10, -7, -18, 0, -18);
      ctx.bezierCurveTo(7, -18, 7, -10, 0, 0);
      ctx.closePath();
      ctx.fillStyle = pinColor;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -12, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.restore();
    };

    drawRouteToTarget(
      _pointerTarget,
      _pointerPathCache,
      { get: () => _pointerPathPending, set: (v) => { _pointerPathPending = v; } },
      _pointerDropHysteresisRef,
      '#ff3b3b',
      { get value() { return _pointerPinScreenPos; }, set value(v) { _pointerPinScreenPos = v; } }
    );
    drawRouteToTarget(
      _deathDropTarget,
      _deathDropPathCache,
      { get: () => _deathDropPathPending, set: (v) => { _deathDropPathPending = v; } },
      _deathDropDropHysteresisRef,
      '#ff3b3b',
      { get value() { return _deathDropPinScreenPos; }, set value(v) { _deathDropPinScreenPos = v; } }
    );

    // Edge-of-map arrows for any tracked marker (world drops, death spot,
    // tracked mobs, the manual waypoint pin, the death-drop pin) that falls
    // outside the currently visible canvas area — easy to happen once
    // zoomed in. Points from the canvas center toward the marker's
    // direction, clamped to just inside the canvas border, with the
    // straight-line distance to the nearest one in that direction labeled.
    //
    // Candidates in the same general direction AND of the same marker
    // color (so different marker types never get merged into one
    // ambiguous arrow) are clustered into a single arrow instead of
    // stacking a separate overlapping arrow for each — shown as a small
    // count badge instead.
    {
      const EDGE_MARGIN = 16; // px kept clear of the canvas border
      const CLUSTER_ANGLE_DEG = 12; // candidates within this many degrees of each other (as seen from center, same color) share one arrow
      const offscreen = _edgeArrowCandidates.filter(c => {
        const s = toScreen(c.pos);
        return !(s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H);
      });
      // Group by color first — a purple tracked-mob arrow and an orange
      // item-drop arrow pointing the same direction must never merge into
      // one badge, since the click/hover behavior differs per kind.
      const byColor = new Map();
      for (const c of offscreen) {
        if (!byColor.has(c.color)) byColor.set(c.color, []);
        byColor.get(c.color).push(c);
      }
      const cx = W / 2, cy = H / 2;
      const halfW = W / 2 - EDGE_MARGIN, halfH = H / 2 - EDGE_MARGIN;
      const thresholdRad = CLUSTER_ANGLE_DEG * Math.PI / 180;

      byColor.forEach((items, color) => {
        const withAngle = items.map(c => {
          const s = toScreen(c.pos);
          return { c, angle: Math.atan2(s.y - cy, s.x - cx) };
        }).sort((a, b) => a.angle - b.angle);

        // Simple greedy clustering around the sorted angle list — a new
        // cluster starts whenever the gap to the previous item's angle
        // exceeds the threshold. Doesn't wrap the last cluster into the
        // first across the -180/180 seam, which just means a pile sitting
        // exactly on that seam could show as two arrows instead of one —
        // a cosmetic edge case, not worth the extra complexity to close.
        const clusters = [];
        for (const item of withAngle) {
          const last = clusters[clusters.length - 1];
          if (last && (item.angle - last.items[last.items.length - 1].angle) <= thresholdRad) {
            last.items.push(item);
          } else {
            clusters.push({ items: [item] });
          }
        }

        for (const cluster of clusters) {
          // Average angle (circular mean) across the cluster's members —
          // simple mean would be wrong near the -180/180 wrap, but since
          // clustering already only grouped nearby angles together this is
          // safe as a plain average.
          const avgAngle = cluster.items.reduce((sum, it) => sum + it.angle, 0) / cluster.items.length;
          const dx = Math.cos(avgAngle), dy = Math.sin(avgAngle);
          const tScaleX = dx !== 0 ? Math.abs(halfW / dx) : Infinity;
          const tScaleY = dy !== 0 ? Math.abs(halfH / dy) : Infinity;
          const t = Math.min(tScaleX, tScaleY);
          const tipX = cx + dx * t, tipY = cy + dy * t;

          // Nearest candidate in the cluster to the player determines the
          // labeled distance — most relevant one to show, and a stable
          // single number instead of an averaged/ranged distance.
          let nearest = cluster.items[0].c, nearestDist = Infinity;
          if (_playerPos) {
            for (const it of cluster.items) {
              const wd = Math.hypot(it.c.pos.x - _playerPos.x, it.c.pos.y - _playerPos.y);
              if (wd < nearestDist) { nearestDist = wd; nearest = it.c; }
            }
          }
          const worldDist = _playerPos ? nearestDist : null;

          ctx.save();
          ctx.translate(tipX, tipY);
          ctx.rotate(avgAngle);
          ctx.beginPath();
          ctx.moveTo(9, 0);
          ctx.lineTo(-6, -6);
          ctx.lineTo(-6, 6);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
          ctx.restore();

          _mazeMapOffscreenDropArrows.push({ x: tipX, y: tipY, r: 12, drop: nearest.meta && nearest.meta.drop, nearest, cluster: cluster.items.map(it => it.c), color, kind: nearest.kind });

          if (worldDist !== null) {
            ctx.save();
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const label = `${Math.round(worldDist)}m`;
            // Offset based on which canvas edge the arrow tip is actually
            // resting against (it's clamped to the inset rectangle border
            // above, via tScaleX/tScaleY) — always inward from that edge,
            // so the label sits beside the arrowhead rather than under/over
            // it. This only changes when the arrow tip genuinely crosses
            // from one edge/corner to another (e.g. sliding along the top
            // edge past a corner onto the side edge) — an infrequent,
            // discrete event — rather than every frame from small changes
            // in avgAngle, which is what made the old perpendicular-sign
            // approach jitter as the player walked.
            const labelOffset = 15;
            const onLeftEdge = tipX <= cx - halfW + 0.5;
            const onRightEdge = tipX >= cx + halfW - 0.5;
            const onTopEdge = tipY <= cy - halfH + 0.5;
            const onBottomEdge = tipY >= cy + halfH - 0.5;
            let labelX = tipX, labelY = tipY;
            if (onTopEdge) labelY = tipY + labelOffset;
            else if (onBottomEdge) labelY = tipY - labelOffset - 8;
            if (onLeftEdge) labelX = tipX + labelOffset + 4;
            else if (onRightEdge) labelX = tipX - labelOffset - 4;
            // A corner sets both X and Y above; a flat-edge case only sets
            // one axis, so give the other axis its natural (unshifted)
            // position — already true since labelX/labelY default to
            // tipX/tipY and only the relevant branch above overwrites one.
            // Clamp fully inside the canvas so the label itself never gets
            // cut off by the edge the arrow is sitting on.
            const textW = ctx.measureText(label).width;
            labelX = Math.max(textW / 2 + 2, Math.min(W - textW / 2 - 2, labelX));
            labelY = Math.max(2, Math.min(H - 12, labelY));
            ctx.fillStyle = '#000';
            ctx.fillText(label, labelX + 1, labelY + 1);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, labelX, labelY);
            ctx.restore();
          }
        }
      });
    }

    // "123%" zoom readout, shown briefly after each wheel tick then faded
    // back out (see _mapZoomIndicatorUntil / MAP_ZOOM_INDICATOR_MS) — gives
    // some on-map feedback for how zoomed in the current view is, since
    // otherwise scroll-to-zoom has no numeric indication at all.
    if (Date.now() < _mapZoomIndicatorUntil) {
      const fadeRemaining = _mapZoomIndicatorUntil - Date.now();
      const fadeInMs = 250; // matches the tail of MAP_ZOOM_INDICATOR_MS so it eases out instead of popping off
      const alpha = Math.max(0, Math.min(1, fadeRemaining / fadeInMs));
      const pct = Math.round(_mapZoom * 100);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      const label = `${pct}%`;
      const padX = 7, padY = 4, marginX = 6, marginY = 6;
      const textW = ctx.measureText(label).width;
      const boxW = textW + padX * 2, boxH = 13 + padY * 2;
      const boxX = canvas.width - marginX - boxW, boxY = marginY;
      ctx.fillStyle = 'rgba(10,10,14,0.72)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(boxX, boxY, boxW, boxH, 4) : ctx.rect(boxX, boxY, boxW, boxH);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, boxX + boxW - padX, boxY + padY - 1);
      ctx.restore();
    }
  }

  panel.appendChild(header);
  panel.appendChild(filterBar);
  panel.appendChild(resFilterBar);
  panel.appendChild(tabBar);
  panel.appendChild(content);
  panel.appendChild(resizeHandleSW);

  document.body.appendChild(panel);
  updateClaimTitle();

  // ─── Compact mode via ResizeObserver ─────────────────────────────────────────
  let _compactMode = 'full';
  let _savedFullHeight    = null;
  let _savedFullMaxHeight = null;
  let _savedFullWidth     = null;

  function applyCompactMode(mode) {
    const isCompactMode = mode !== 'full';
    tabBar.style.display  = 'flex';

    const wasCompact = _compactMode !== 'full';
    const changing   = mode !== _compactMode;
    _compactMode = mode;

    const isMicro   = mode === 'micro';
    const isCompact = mode === 'compact' || isMicro;

    if (!isCompact && wasCompact && changing) {
      // leaving compact — restore saved height
      panel.style.height    = _savedFullHeight    || '';
      panel.style.maxHeight = _savedFullMaxHeight || '90vh';
      _savedFullHeight    = null;
      _savedFullMaxHeight = null;
    }

    document.getElementById('roeTitle').textContent = _claimEmoji;
    document.getElementById('roeSpawnCount').style.display = 'none';

    const minBtn = document.getElementById('roeMinBtn');
    if (minBtn) minBtn.style.display = isCompact ? 'none' : '';

    tabBar.querySelectorAll('button').forEach(btn => {
      const icon  = btn.dataset.icon;
      const label = btn.dataset.label;
      if (!icon) return;
      btn.textContent = icon;
    });

    content.style.padding = isCompact ? '4px 2px 0' : '6px 6px 0';

    if (activeTab === 'state'  || _poppedOut.has('state'))  renderStatePane();
    if (activeTab === 'res'    || _poppedOut.has('res'))    renderResPane();
    if (activeTab === 'track'  || _poppedOut.has('track'))  renderTrackPane();
    if (activeTab === 'market' || _poppedOut.has('market')) renderMarketPane();
    if (activeTab === 'chest'  || _poppedOut.has('chest'))  renderChestPane();
    if (activeTab === 'log'    || _poppedOut.has('log'))    renderLogPane();
    if (activeTab === 'damage' || _poppedOut.has('damage')) renderDamagePane();
  }



  // ─── Panel position helpers ──────────────────────────────────────────────────
  function clampPanelPosition(left, top) {
    const maxLeft = Math.max(0, window.innerWidth  - panel.offsetWidth);
    const maxTop  = Math.max(0, window.innerHeight - panel.offsetHeight);
    return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) };
  }
  function movePanel(left, top) {
    const prevLeft = panel.offsetLeft;
    const prevTop  = panel.offsetTop;
    const pos = clampPanelPosition(left, top);
    panel.style.left  = pos.left + 'px';
    panel.style.top   = pos.top  + 'px';
    panel.style.right = 'auto';
    // ─── Sticky mode: shift all floating panels by the same delta ────────────
    if (_stickyPanels && dragging) {
      const dx = pos.left - prevLeft;
      const dy = pos.top  - prevTop;
      if (dx !== 0 || dy !== 0) {
        Object.values(_floatPanels).forEach(fp => {
          const fl = parseInt(fp.style.left)  || fp.offsetLeft;
          const ft = parseInt(fp.style.top)   || fp.offsetTop;
          const nl = Math.max(0, Math.min(window.innerWidth  - fp.offsetWidth,  fl + dx));
          const nt = Math.max(0, Math.min(window.innerHeight - fp.offsetHeight, ft + dy));
          fp.style.left = nl + 'px';
          fp.style.top  = nt + 'px';
        });
      }
    }
    if (_ovScrollRefresh) _ovScrollRefresh();
  }
  function getPanelPosition() { return { left: Math.round(panel.offsetLeft), top: Math.round(panel.offsetTop) }; }

  window.addEventListener('resize', () => { const p = getPanelPosition(); movePanel(p.left, p.top); });

  // ─── Custom overlay scrollbars: rendered as fixed-position bars ON TOP of the
  // content (zero layout width — native scrollbar is fully hidden). Fades in on
  // hover/scroll, fades out after inactivity, and supports drag-to-scroll. ───────
  (function initOverlayScrollbars() {
    const SELECTOR = '.roe-float-content, #roeContent, #roeMazeMapResList, #roeMazeMapMobList';
    const registry = new Map(); // el -> { track, thumb, fadeTimer, dragging }

    function ensureRec(el) {
      let rec = registry.get(el);
      if (rec) return rec;
      const track = document.createElement('div');
      track.className = 'roe-ov-scrollbar-track';
      const thumb = document.createElement('div');
      thumb.className = 'roe-ov-scrollbar-thumb';
      track.appendChild(thumb);
      document.body.appendChild(track);
      rec = { track, thumb, fadeTimer: null, dragging: false };
      registry.set(el, rec);

      thumb.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rec.dragging = true;
        track.classList.add('roe-ov-visible');
        const startY = e.clientY;
        const startScrollTop = el.scrollTop;
        const scrollableH = el.scrollHeight - el.clientHeight;
        const trackH = el.clientHeight;
        const thumbH = Math.max(24, (el.clientHeight / el.scrollHeight) * trackH);
        const dragRatio = scrollableH / Math.max(1, (trackH - thumbH));
        function onMove(ev) {
          const dy = ev.clientY - startY;
          el.scrollTop = startScrollTop + dy * dragRatio;
        }
        function onUp() {
          rec.dragging = false;
          scheduleFade(el);
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      return rec;
    }

    function updateRec(el) {
      const rec = registry.get(el);
      if (!rec) return;
      const rect = el.getBoundingClientRect();
      const scrollable = el.scrollHeight > el.clientHeight + 1;
      const hidden = rect.width === 0 && rect.height === 0;
      if (!scrollable || hidden) {
        rec.track.style.display = 'none';
        return;
      }
      rec.track.style.display = '';
      rec.track.style.left = (rect.right - 9) + 'px';
      rec.track.style.top = rect.top + 'px';
      rec.track.style.height = rect.height + 'px';
      const thumbH = Math.max(24, (el.clientHeight / el.scrollHeight) * rect.height);
      const maxThumbTop = rect.height - thumbH;
      const scrollRatio = el.scrollTop / (el.scrollHeight - el.clientHeight);
      const thumbTop = maxThumbTop * (isFinite(scrollRatio) ? scrollRatio : 0);
      rec.thumb.style.height = thumbH + 'px';
      rec.thumb.style.transform = `translateY(${thumbTop}px)`;
    }

    function scheduleFade(el, delay = 600) {
      const rec = registry.get(el);
      if (!rec) return;
      rec.track.classList.add('roe-ov-visible');
      clearTimeout(rec.fadeTimer);
      // While the cursor is resting over the element, don't arm the fade
      // timer at all — it'll be started fresh on mouseleave instead. This
      // is what keeps the scrollbar visible and non-flickering as long as
      // the mouse stays on the panel.
      if (rec.hovering) return;
      rec.fadeTimer = setTimeout(() => {
        if (!rec.dragging) rec.track.classList.remove('roe-ov-visible');
      }, delay);
    }

    function scanAll() {
      document.querySelectorAll(SELECTOR).forEach(el => {
        ensureRec(el);
        updateRec(el);
      });
    }

    // Delegated hover tracking via mouseover/mouseout (with relatedTarget
    // checks) rather than mouseenter/mouseleave, because mouseenter/leave
    // don't bubble and so can't be delegated from document — attaching them
    // directly to each scrollable element would miss elements created after
    // the listener was attached. mouseover/mouseout do bubble, and checking
    // relatedTarget against .contains() gives the same "entered/left the
    // element as a whole" semantics without re-firing on internal repaints
    // (a repaint doesn't change what the real mouse is over, so it doesn't
    // dispatch a new native mouseover/mouseout).
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest && e.target.closest(SELECTOR);
      if (!el) return;
      const rec0 = registry.get(el);
      // Moving within the panel's own DOM, or onto/within its scrollbar
      // track/thumb (which lives outside `el` in the DOM since it's a
      // fixed-position sibling appended to body), isn't a real "entry" —
      // don't re-toggle hovering state for it.
      if (el.contains(e.relatedTarget) || (rec0 && rec0.track.contains(e.relatedTarget))) return;
      ensureRec(el);
      updateRec(el);
      const rec = registry.get(el);
      rec.hovering = true;
      clearTimeout(rec.fadeTimer);
      rec.track.classList.add('roe-ov-visible');
    }, true);

    document.addEventListener('mouseout', (e) => {
      const el = e.target.closest && e.target.closest(SELECTOR);
      if (!el) return;
      const rec = registry.get(el);
      if (!rec) return;
      // Leaving into the element's own children, or onto/within its own
      // scrollbar track/thumb, isn't a real exit from the panel.
      if (el.contains(e.relatedTarget) || rec.track.contains(e.relatedTarget)) return;
      if (rec.dragging) return; // still actively dragging the thumb
      rec.hovering = false;
      scheduleFade(el, 0);
    }, true);

    // The track/thumb are fixed-position elements appended to <body>, sitting
    // outside `el` in the DOM. So when the cursor leaves the panel by moving
    // directly off the track/thumb (e.g. exiting the browser window through
    // the scrollbar itself), the mouseout above never fires — its target is
    // never inside `el`. This second listener catches exactly that case.
    document.addEventListener('mouseout', (e) => {
      for (const [el, rec] of registry) {
        if (!rec.track.contains(e.target)) continue;
        if (rec.track.contains(e.relatedTarget) || el.contains(e.relatedTarget)) continue;
        if (rec.dragging) continue;
        rec.hovering = false;
        scheduleFade(el, 0);
      }
    }, true);

    document.addEventListener('scroll', (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1 || !el.matches || !el.matches(SELECTOR)) return;
      ensureRec(el);
      updateRec(el);
      if (el._roeSuppressScrollFade) return;
      scheduleFade(el);
    }, true);

    // Use mousemove (not mouseover) to trigger the fade-in: mouseover fires
    // again whenever the DOM under the cursor is re-rendered (e.g. the
    // once-a-second panel repaint), even if the pointer never actually
    // moved. That was retriggering scheduleFade() on every repaint, causing
    // the track to flash: appear, vanish 600ms later, then immediately
    // reappear on the next repaint's spurious mouseover. mousemove only
    // fires on genuine pointer motion, so a stationary mouse just lets the
    // existing fade timer run out once, cleanly.
    let _lastMoveX = null, _lastMoveY = null;
    document.addEventListener('mousemove', (e) => {
      if (e.clientX === _lastMoveX && e.clientY === _lastMoveY) return;
      _lastMoveX = e.clientX;
      _lastMoveY = e.clientY;
      const el = e.target.closest && e.target.closest(SELECTOR);
      if (!el) return;
      ensureRec(el);
      updateRec(el);
      scheduleFade(el);
    }, true);

    window.addEventListener('resize', () => requestAnimationFrame(scanAll));
    // Light periodic refresh as a safety net; the real-time sync now happens
    // via _ovScrollRefresh (called directly from drag/resize mousemove
    // handlers), so this just catches anything that isn't hooked up yet.
    setInterval(scanAll, 400);
    scanAll();
    _ovScrollRefresh = scanAll;
  })();

  // ─── Pin / Unpin ─────────────────────────────────────────────────────────────
  let panelPinned = loadPanelPin();

  function applyPinState() {
    const pinBtn = document.getElementById('roePinBtn');
    if (!pinBtn) return;
    if (panelPinned) {
      pinBtn.textContent       = '🔒';
      pinBtn.title             = 'Unpinned — click to allow dragging';
      header.style.cursor      = 'default';
    } else {
      pinBtn.textContent       = '📌';
      pinBtn.title             = 'Pin panel in place';
      header.style.cursor      = 'grab';
    }
    savePanelPin(panelPinned);
    // Sync cursor on all currently open floating panels
    Object.values(_floatPanels).forEach(fp => {
      if (typeof fp._updateCursor === 'function') fp._updateCursor();
    });
  }

  if (!loadPanelPos()) {
    // default: top-right corner, already set via CSS
  }
  applyPinState();

  // ─── Drag ────────────────────────────────────────────────────────────────────
  let dragging      = false, dragX = 0, dragY = 0;

  header.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    if (panelPinned) return;

    dragging = true;
    dragX    = e.clientX - panel.offsetLeft;
    dragY    = e.clientY - panel.offsetTop;
    panel.style.right  = 'auto';
    header.style.cursor = 'grabbing';
    e.preventDefault();
  });

  const _onMouseMove = e => {
    if (dragging) {
      movePanel(e.clientX - dragX, e.clientY - dragY);
    }
  };
  const _onMouseUp = () => {
    if (dragging) {
      movePanel(panel.offsetLeft, panel.offsetTop);
      header.style.cursor = panelPinned ? 'default' : 'grab';
      savePanelPos();
      if (_stickyPanels) saveFloatPositions(); // persist shifted float positions
    }
    dragging = false;
  };

  document.addEventListener('mousemove', _onMouseMove);
  document.addEventListener('mouseup',   _onMouseUp);

  setTimeout(() => {
    const pinBtn = document.getElementById('roePinBtn');
    if (pinBtn) {
      pinBtn.onclick = () => {
        panelPinned = !panelPinned;
        applyPinState();
      };
    }
  }, 0);

  // ─── Pop-out: detach panel into a separate browser window ─────────────────────
  let _popupWin = null;
  let _panelOrigCssText = null;

  function popOutPanel() {
    if (_popupWin && !_popupWin.closed) { _popupWin.focus(); return; }

    const pw = Math.max(320, panel.offsetWidth  + 2);
    const ph = Math.max(300, panel.offsetHeight + 2);
    const w = window.open('', 'roeTrackerPanel',
      `width=${pw},height=${ph},resizable=yes,scrollbars=no,menubar=no,toolbar=no,location=no,status=no`);
    if (!w) { alert('[ROE] Popups are blocked — please allow popups for this site'); return; }

    _popupWin = w;
    w.document.open();
    w.document.write(`<!DOCTYPE html><html><head>
      <meta charset="utf-8"><title>ROE Tracker</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0;}
        html,body{background:#0a0a0a;width:100%;height:100%;overflow:hidden;}
        @keyframes roeBlink{0%,100%{opacity:1}50%{opacity:0}}
        .roe-float-content{scrollbar-width:thin;scrollbar-color:#2a3050 transparent;}
        ::-webkit-scrollbar{width:6px;background:transparent;}
        ::-webkit-scrollbar-thumb{background-color:#2a3050;border-radius:3px;transition:background-color 0.2s ease;}
        ::-webkit-scrollbar-thumb:hover{background:#3a4570;}
      </style>
    </head><body></body></html>`);
    w.document.close();

    // Save original styles and switch panel to fill-window mode
    _panelOrigCssText = panel.style.cssText;
    panel.style.position  = 'fixed';
    panel.style.top       = '0';
    panel.style.left      = '0';
    panel.style.right     = '0';
    panel.style.bottom    = '0';
    panel.style.width     = '100%';
    panel.style.maxHeight = '100vh';
    panel.style.height    = '100vh';
    panel.style.borderRadius = '0';
    panel.style.boxShadow = 'none';

    w.document.body.appendChild(panel);

    // Re-attach drag/resize listeners to the new window
    w.document.addEventListener('mousemove', _onMouseMove);
    w.document.addEventListener('mouseup',   _onMouseUp);


    // If the user closes the popup — automatically dock the panel back
    w.addEventListener('beforeunload', () => setTimeout(popInPanel, 50));
  }

  function popInPanel() {
    if (!_popupWin) return;
    const w = _popupWin;
    _popupWin = null;

    // Restore original styles
    if (_panelOrigCssText !== null) {
      panel.style.cssText = _panelOrigCssText;
      _panelOrigCssText = null;
    }
    document.body.appendChild(panel);

    // Restore saved position
    if (!loadPanelPos()) movePanel(window.innerWidth - panel.offsetWidth - 10, 10);

    try { if (!w.closed) w.close(); } catch (_) {}
  }


  // ─── Gear button: opens/closes 📌👁️ menu ──────────────────────────────────────
  setTimeout(() => {
    const gearBtn  = document.getElementById('roeGearBtn');
    const gearMenu = document.getElementById('roeGearMenu');
    if (!gearBtn || !gearMenu) return;

    // Reparent the menu straight onto <body> as position:fixed so it escapes
    // any ancestor with overflow:hidden (e.g. toolbar-only mode sets
    // panel.style.overflow = 'hidden', which was clipping this popover).
    // Being a body-level element, its position is now computed from the
    // gear button's live on-screen location each time it opens.
    document.body.appendChild(gearMenu);
    gearMenu.style.position = 'fixed';
    gearMenu.style.zIndex   = '2147483000';
    gearMenu.style.right    = 'auto';

    function positionGearMenu() {
      const r = gearBtn.getBoundingClientRect();
      gearMenu.style.display = 'flex'; // must be visible to measure its size
      const menuH = gearMenu.offsetHeight;
      const menuW = gearMenu.offsetWidth;
      // Flip above the button if there isn't room below the viewport.
      const spaceBelow = window.innerHeight - r.bottom;
      const top = spaceBelow >= menuH + 8 ? r.bottom + 4 : Math.max(4, r.top - menuH - 4);
      gearMenu.style.top = top + 'px';
      // Align the menu's right edge with the button's, clamped to viewport.
      let left = r.right - menuW;
      left = Math.min(Math.max(4, left), window.innerWidth - menuW - 4);
      gearMenu.style.left = left + 'px';
    }

    function toggleGearMenu(e) {
      e.stopPropagation();
      const isOpen = gearMenu.style.display === 'flex';
      if (isOpen) {
        gearMenu.style.display = 'none';
      } else {
        positionGearMenu();
      }
    }

    function closeGearMenu(e) {
      if (gearMenu.contains(e.target) || gearBtn.contains(e.target)) return;
      gearMenu.style.display = 'none';
    }

    gearBtn.onclick = toggleGearMenu;

    // Close when clicking outside the menu
    document.addEventListener('click', closeGearMenu, true);
    // Clicks on child buttons close the menu
    ['roePinBtn', 'roeEyeBtn', 'roeMagnetBtn', 'roeExperimentalBtn'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => {
        setTimeout(() => { gearMenu.style.display = 'none'; }, 50);
      });
    });

    // ─── Experimental button: gates Market/Chest/Log/QB tabs ───────────
    const experimentalBtn = document.getElementById('roeExperimentalBtn');
    function _applyExperimentalBtnState() {
      if (!experimentalBtn) return;
      experimentalBtn.style.opacity = _experimentalEnabled ? '1' : '0.55';
      experimentalBtn.textContent   = _experimentalEnabled ? '🧪 Experimental ✓' : '🧪 Experimental';
    }
    _applyExperimentalBtnState();
    if (experimentalBtn) {
      experimentalBtn.onclick = (e) => {
        e.stopPropagation();
        if (_experimentalEnabled) {
          _experimentalEnabled = false;
          _saveExperimentalEnabled();
          _applyExperimentalTabsVisibility();
          _applyExperimentalBtnState();
        } else {
          showConfirmWrap(
            experimentalBtn,
            'Warning: These features are experimental and may contain bugs or unexpected behavior. Enable them at your own risk.',
            () => {
              _experimentalEnabled = true;
              _saveExperimentalEnabled();
              _applyExperimentalTabsVisibility();
              _applyExperimentalBtnState();
            }
          );
        }
      };
    }

    // ─── Magnet button: toggle sticky mode ──────────────────────────────────
    const magnetBtn = document.getElementById('roeMagnetBtn');
    function applyMagnetState() {
      if (!magnetBtn) return;
      magnetBtn.style.opacity = _stickyPanels ? '1' : '0.4';
      magnetBtn.title = _stickyPanels
        ? 'Sticky ON — floating panels move with main panel (click to disable)'
        : 'Sticky OFF — click to move all floating panels together with main panel';
    }
    applyMagnetState();
    if (magnetBtn) {
      magnetBtn.onclick = (e) => {
        e.stopPropagation();
        _stickyPanels = !_stickyPanels;
        try { localStorage.setItem('roeStickyPanels', _stickyPanels ? '1' : '0'); } catch (_) {}
        applyMagnetState();
      };
    }

  }, 0);

  // ─── Ctrl+LClick: hide/show header and tab bar ────────────────────────────────
  let _chromeHidden = localStorage.getItem(CHROME_HIDDEN_KEY) === '1';

  function applyChrome() {
    header.style.display = _chromeHidden ? 'none' : 'flex';
    tabBar.style.display = _chromeHidden ? 'none' : 'flex';
  }

  applyChrome();

  panel.addEventListener('click', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    _chromeHidden = !_chromeHidden;
    localStorage.setItem(CHROME_HIDDEN_KEY, _chromeHidden ? '1' : '0');
    applyChrome();
  });

  // ─── Protect chat-style inputs from the game's global key handling ───────
  // The game listens for movement keys on document/window; once the character
  // has spawned it appears to capture keydown before our input ever sees it.
  // Registered once (not per-render) on the capture phase so we run first
  // regardless of where or when the game attaches its own listener.
  const _protectedInputIds = new Set(['roeChestSearch', 'roeMarketSearch', 'roeMarketEthUsd']);
  ['keydown', 'keyup', 'keypress'].forEach(evt => {
    window.addEventListener(evt, e => {
      if (e.target && _protectedInputIds.has(e.target.id)) e.stopImmediatePropagation();
    }, true);
  });

  // ─── Alt+Shift+R: reset panel position ────────────────────────────────────────
  let _resetHideTimer = null;
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyR') {
      localStorage.removeItem(PANEL_POS_STORAGE_KEY);
      _panelHidden = false;
      panel.style.display = 'flex';
      movePanel(window.innerWidth - panel.offsetWidth - 10, 10);
      savePanelPos();
      panel.style.opacity = '1';
      clearTimeout(_resetHideTimer);
      _resetHideTimer = setTimeout(() => { panel.style.opacity = '0'; }, 5000);
    }
  });

  // ─── Tab switching ───────────────────────────────────────────────────────────
  let activeTab = 'log';

  // ⚠️ READ BEFORE CHANGING PANEL SIZE/LAYOUT FOR A TAB ⚠️
  // This function controls the DOCKED panel (the `panel` element) — but the
  // tab buttons in the toolbar do NOT call this. They call toggleFloat(),
  // which pops out a separate FLOATING panel (`fp`, built in
  // makeFloatingPanel() near the top of the file) instead. In practice every
  // tab is used in floating mode, so docked mode is effectively dead code
  // that nobody sees — but it's still live and still gets exercised by
  // setTab() below (e.g. the initial setTab('log') on load, and the
  // popOutTab() restore loop also calls it indirectly through
  // applyCompactMode chains).
  // If you're trying to fix how a tab LOOKS or is SIZED (width/height,
  // scroll, resize handles) and the change "doesn't show up" in-game, you
  // almost certainly need makeFloatingPanel() / popOutTab() instead.
  // Confirmed twice by direct testing (2026-07): (1) editing
  // panel.style.width/height here had zero visible effect until the same
  // fix was applied to `fp` in makeFloatingPanel; (2) doing BOTH — pinning
  // panel.style.height here too — visibly broke the collapsed/compact docked
  // panel (it stretched to a large empty block under the toolbar) since this
  // function still runs even though nobody looks at its output. Net lesson:
  // don't touch panel.style.width/height in this function at all for
  // per-tab sizing — it's either invisible (floating mode) or actively
  // harmful (docked/compact mode).
  function setTab(tab) {
    activeTab = tab;
    const allPanes = { state: statePane, res: resPane, track: trackPane, market: marketPane, chest: chestPane, log: logPane, qb: qbPane, damage: damagePane };
    Object.entries(allPanes).forEach(([key, el]) => {
      el.style.display = (key === tab) ? 'block' : 'none';
    });

    // The QB tab explicitly pins panel.style.width to fit its own content
    // (see renderQBPaneCompactContent) since width:auto's native
    // shrink-to-fit can't be trusted to grow again once #roeContent's
    // overflow-x:hidden clips it. Switching to any other tab needs that
    // pin released, or every other tab would be stuck fitting inside
    // whatever width QB last settled on instead of sizing to its own
    // content.
    if (tab !== 'qb') panel.style.width = 'auto';

    document.getElementById('tabTrack').style.cssText = tabStyle(tab === 'track');
    document.getElementById('tabMarket').style.cssText = tabStyle(tab === 'market');
    document.getElementById('tabChest').style.cssText = tabStyle(tab === 'chest');
    document.getElementById('tabLog').style.cssText   = tabStyle(tab === 'log');
    document.getElementById('tabQB').style.cssText    = tabStyle(tab === 'qb');
    document.getElementById('tabDamage').style.cssText = tabStyle(tab === 'damage');

    TAB_DEFS.forEach(([id, icon, label]) => {
      const btn = document.getElementById(id);
      if (btn) { btn.dataset.icon = icon; btn.dataset.label = label; }
    });
    applyCompactMode(_compactMode === 'full' ? 'full' : _compactMode);
    updateTrackTab();
    updateMarketTab();
    if (tab === 'state') renderStatePane();
    if (tab === 'res')   renderResPane();
    if (tab === 'track') renderTrackPane();
    if (tab === 'market') renderMarketPane();
    if (tab === 'chest') renderChestPane();
    if (tab === 'log')   renderLogPane();
    if (tab === 'damage') renderDamagePane();
    if (tab === 'qb') {
      renderQBPane();
    }
  }

  // In toolbar-only mode, tab buttons directly toggle floating panels
  function toggleFloat(tabKey) {
    if (_poppedOut.has(tabKey)) dockTab(tabKey);
    else popOutTab(tabKey);
    // Update button highlight to reflect open/closed state
    _updateTabBtnHighlight(tabKey);
  }

  function _updateTabBtnHighlight(tabKey) {
    const id = TAB_KEY_TO_ID[tabKey];
    const btn = document.getElementById(id);
    if (!btn) return;
    const isOpen = _poppedOut.has(tabKey);
    btn.style.cssText = tabStyle(isOpen);
    btn.style.flex = '1';
    btn.textContent = btn.dataset.icon;
  }

  document.getElementById('tabTrack').onclick = (e) => { if (e.target.closest('[data-popbtn]')) return; toggleFloat('track'); };
  document.getElementById('tabMarket').onclick = (e) => { if (e.target.closest('[data-popbtn]')) return; toggleFloat('market'); };
  document.getElementById('tabChest').onclick = (e) => { if (e.target.closest('[data-popbtn]')) return; toggleFloat('chest'); };
  document.getElementById('tabLog').onclick   = (e) => { if (e.target.closest('[data-popbtn]')) return; toggleFloat('log'); };
  document.getElementById('tabQB').onclick    = (e) => { if (e.target.closest('[data-popbtn]')) return; toggleFloat('qb'); };
  document.getElementById('tabDamage').onclick = (e) => { if (e.target.closest('[data-popbtn]')) return; toggleFloat('damage'); };
  document.getElementById('tabMap').onclick   = (e) => { if (e.target.closest('[data-popbtn]')) return; toggleMinimapTab(); };

  // ─── Tab reorder ─────────────────────────────────────────────────────────────
  const TAB_IDS       = ['tabState', 'tabRes', 'tabTrack', 'tabMarket', 'tabChest', 'tabDamage', 'tabLog', 'tabQB', 'tabMap'];
  const TAB_ID_TO_KEY = { tabState: 'state', tabRes: 'res', tabTrack: 'track', tabMarket: 'market', tabChest: 'chest', tabDamage: 'damage', tabLog: 'log', tabQB: 'qb', tabMap: 'map' };
  let draggedTabId    = null;

  function getFirstTabKey() {
    const firstBtn = tabBar.querySelector('button');
    return TAB_ID_TO_KEY[firstBtn?.id] || 'state';
  }
  function saveTabOrder() {
    try {
      localStorage.setItem(TAB_ORDER_STORAGE_KEY,
        JSON.stringify(Array.from(tabBar.querySelectorAll('button')).map(b => b.id)));
    } catch (e) {}
  }
  function applySavedTabOrder() {
    try {
      const raw = localStorage.getItem(TAB_ORDER_STORAGE_KEY);
      const order = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(order)) return;
      order.forEach(id => { const btn = document.getElementById(id); if (btn?.parentElement) tabBar.appendChild(btn.parentElement); });
    } catch (e) {}
  }
  function clearTabDragState() {
    TAB_IDS.forEach(id => { const b = document.getElementById(id); if (b) { b.style.opacity = ''; b.style.boxShadow = ''; } });
  }
  function initTabReorder() {
    TAB_IDS.forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const wrap = btn.parentElement;
      btn.draggable   = true;
      btn.ondragstart = () => { draggedTabId = id; btn.style.opacity = '0.55'; };
      btn.ondragover  = e => {
        e.preventDefault();
        if (!draggedTabId || draggedTabId === id) return;
        const before = e.clientX < btn.getBoundingClientRect().left + btn.getBoundingClientRect().width / 2;
        btn.style.boxShadow = before ? 'inset 2px 0 0 #7b8fff' : 'inset -2px 0 0 #7b8fff';
      };
      btn.ondragleave = () => { btn.style.boxShadow = ''; };
      btn.ondrop = e => {
        e.preventDefault();
        if (!draggedTabId || draggedTabId === id) return;
        const draggedBtn  = document.getElementById(draggedTabId);
        const draggedWrap = draggedBtn?.parentElement;
        if (!draggedWrap) return;
        const targetWrap = btn.parentElement;
        const before = e.clientX < btn.getBoundingClientRect().left + btn.getBoundingClientRect().width / 2;
        tabBar.insertBefore(draggedWrap, before ? targetWrap : targetWrap.nextSibling);
        saveTabOrder(); clearTabDragState();
      };
      btn.ondragend = () => { draggedTabId = null; clearTabDragState(); };
    });
  }

  applySavedTabOrder();
  initTabReorder();

  // ─── Toolbar-only mode: hide content area, show only header + tabBar ─────────
  content.style.display        = 'none';
  resizeHandleSW.style.display = 'none';
  resizeHandleSE.style.display = 'none';
  panel.style.maxHeight = 'none';
  panel.style.minHeight = '0';
  panel.style.overflow  = 'hidden';
  tabBar.style.width    = '100%';
  // Also hide the minimize button — not needed in toolbar mode
  const _minBtnEl = document.getElementById('roeMinBtn');
  let _tabBarCollapsed = false;
  if (_minBtnEl) {
    _minBtnEl.textContent = '▼';
    _minBtnEl.title = 'Collapse tabs';
    _minBtnEl.onclick = () => {
      _tabBarCollapsed = !_tabBarCollapsed;
      tabBar.style.display = _tabBarCollapsed ? 'none' : 'flex';
      _minBtnEl.textContent = _tabBarCollapsed ? '▲' : '▼';
      _minBtnEl.title = _tabBarCollapsed ? 'Expand tabs' : 'Collapse tabs';
    };
  }

  // Keep setTab working for internal use but don't show main panel content
  setTab(getFirstTabKey());
  applyCompactMode('compact');

  // Highlight buttons for any already-open floating panels
  function _refreshAllTabHighlights() {
    Object.keys(TAB_KEY_TO_ID).forEach(k => _updateTabBtnHighlight(k));
  }

  // ─── Restore floating panels from previous session ────────────────────────────
  try {
    const openKeys = JSON.parse(localStorage.getItem(FLOAT_OPEN_STORAGE_KEY) || '[]');
    console.log('[ROE debug] restoring float tabs, openKeys=', openKeys);
    openKeys.forEach(k => {
      if (typeof k !== 'string') return;
      if (!_experimentalEnabled && EXPERIMENTAL_TAB_KEYS.includes(k)) return;
      try {
        popOutTab(k);
      } catch (e) {
        console.error('[ROE debug] popOutTab threw for', k, e);
      }
    });
    _refreshAllTabHighlights();
  } catch (e) { console.error('[ROE debug] restore floats outer catch', e); }
  _updateMapTabHighlight();

  // ─── Minimize (toolbar mode: tab collapse only via _minBtnEl.onclick above) ──────

  // ─── Filter handlers ─────────────────────────────────────────────────────────
  document.getElementById('roeZoneFilter').onchange   = e => { filterZone   = e.target.value; saveFilters(); applyFilters(); };
  document.getElementById('roeMobFilter').onchange    = e => { filterType   = e.target.value; saveFilters(); applyFilters(); };
  document.getElementById('roeStatusFilter').onchange = e => { filterStatus = e.target.value; saveFilters(); applyFilters(); };

  document.getElementById('roeResZoneFilter').onchange   = e => { resFilterZone   = e.target.value; saveFilters(); renderResPane(); };
  document.getElementById('roeResTypeFilter').onchange   = e => { resFilterType   = e.target.value; saveFilters(); renderResPane(); };
  document.getElementById('roeResNameFilter').onchange   = e => { resFilterName   = e.target.value; saveFilters(); renderResPane(); };
  document.getElementById('roeResStatusFilter').onchange = e => { resFilterStatus = e.target.value; saveFilters(); renderResPane(); };
  document.getElementById('roeResSearch').oninput        = ()  => { saveFilters(); renderResPane(); };

  // ─── applyFilters ────────────────────────────────────────────────────────────
  function applyFilters() {
    if (activeTab === 'state' || _poppedOut.has('state')) renderStatePane();
  }

  // ─── Refresh dropdowns ───────────────────────────────────────────────────────
  function refreshSelects() {
    const zs = document.getElementById('roeZoneFilter');
    const ms = document.getElementById('roeMobFilter');
    const prevZ = zs.value, prevM = ms.value;
    zs.innerHTML = '<option value="ALL">All zones</option>';
    knownZones.forEach(z => { zs.innerHTML += `<option value="${z}">${z}</option>`; });
    zs.value = prevZ !== 'ALL' ? prevZ : filterZone;
    ms.innerHTML = '<option value="ALL">All mobs</option>';
    knownTypes.forEach(t => { ms.innerHTML += `<option value="${t}">${t}</option>`; });
    ms.value = prevM !== 'ALL' ? prevM : filterType;
  }

  function refreshResSelects() {
    const zs = document.getElementById('roeResZoneFilter');
    const ns = document.getElementById('roeResNameFilter');
    const prevZ = zs.value, prevN = ns.value;
    zs.innerHTML = '<option value="ALL">All zones</option>';
    knownZones.forEach(z => { zs.innerHTML += `<option value="${z}">${z}</option>`; });
    zs.value = prevZ !== 'ALL' ? prevZ : resFilterZone;
    ns.innerHTML = '<option value="ALL">All resources</option>';
    knownResNames.forEach(n => { ns.innerHTML += `<option value="${n}">${n}</option>`; });
    ns.value = prevN !== 'ALL' ? prevN : resFilterName;
  }

  // ─── Color helpers ───────────────────────────────────────────────────────────
  function zoneColor(zone) {
    const map = { Forest: '#4caf50', Mines: '#9c7bb5', Town: '#5b9bd5', Desert: '#c49a3c', Dungeon: '#c44' };
    return map[zone] || '#888';
  }
  function resTypeColor(type) { return type === 'Ore' ? '#c49a3c' : type === 'Tree' ? '#6d9e4b' : '#5b9bd5'; }
  function resIcon(type)      { return type === 'Ore' ? '⛏' : type === 'Tree' ? '🪓' : '🌿'; }
  function mobIcon()          { return '🗡️'; }
  function rarityColor(rarity) {
    return { Common: '#aaa', Uncommon: '#4caf50', Rare: '#5b9bd5', Mystical: '#c678dd' }[rarity] || '#aaa';
  }
  function hpBar(hp, maxHp) {
    if (!maxHp) return '';
    const pct = Math.round((hp / maxHp) * 100);
    const col = pct > 60 ? '#4caf50' : pct > 30 ? '#f0a500' : '#e53935';
    return `<span style="display:inline-block;width:40px;height:5px;background:#333;border-radius:3px;vertical-align:middle;margin:0 3px"><span style="display:block;width:${pct}%;height:100%;background:${col};border-radius:3px"></span></span><span style="color:${col};font-size:10px">${hp}/${maxHp}</span>`;
  }

  function getTrackedResourceNodes(zone, resource) {
    return (lastResourcesByZone[zone] || []).map((r, i) => ({ ...r, idx: i })).filter(r => r.resource === resource);
  }
  function getTrackedMobNodes(zone, statsKey) {
    return (lastStateByZone[zone] || []).map((e, i) => ({ ...e, idx: i })).filter(e => e.statsKey === statsKey);
  }

  function appendLogNode(node) {}

  // ─── Render "Mobs" tab ───────────────────────────────────────────────────────
  // ─── Float-aware pane routing ────────────────────────────────────────────────
  // Returns the actual DOM element to render into.
  // If the tab is popped out: clears & returns the float panel content div,
  // and shows a stub in the original pane. Otherwise clears & returns the pane.
  function _paneFor(tabKey, paneEl) {
    // Don't re-render while a confirm dialog is open — it destroys the anchor element
    if (_activeConfirm) return null;
    // Don't re-render QB pane while slider is being dragged — avoids input freeze
    if (tabKey === 'qb' && _durSliderDragging) return null;
    // Don't re-render Log pane mid-click — high-frequency events (combat hits,
    // console lines) could otherwise wipe a button's innerHTML between
    // mousedown and click, making the click appear to silently fail.
    if (tabKey === 'log' && _logPointerDown) return null;
    if (_poppedOut.has(tabKey)) {
      paneEl.innerHTML = '';
      // Return float content
      const fp = _floatPanels[tabKey];
      if (!fp) return paneEl;
      const c = fp.querySelector('.roe-float-content');
      _resetPaneContent(c);
      return c;
    }
    _resetPaneContent(paneEl);
    return paneEl;
  }

  // Clears a pane's content for re-render while preserving its scroll offset.
  // Clearing innerHTML momentarily collapses scrollHeight, which clamps
  // scrollTop to 0 and fires a native 'scroll' event — without this, that
  // happened every ~1s render tick even with the mouse sitting still,
  // snapping lists back to the top and making the overlay scrollbar flash
  // on/off in sync with the render interval. We restore the offset next
  // frame (before paint, so no visible jump) and flag the element so the
  // overlay scrollbar's scroll listener treats that restore as internal
  // bookkeeping rather than a real user scroll worth fading in for.
  function _resetPaneContent(el) {
    const savedTop = el.scrollTop;
    el._roeSuppressScrollFade = true;
    el.innerHTML = '';
    if (savedTop) {
      requestAnimationFrame(() => {
        el.scrollTop = savedTop;
        // The restore above fires its own async 'scroll' event; give it a
        // tick to land before lifting suppression, so it doesn't slip
        // through and trigger a fade-in of its own.
        setTimeout(() => { el._roeSuppressScrollFade = false; }, 0);
      });
    } else {
      el._roeSuppressScrollFade = false;
    }
  }

  // ─── Export helpers ───────────────────────────────────────────────────────────
  function _copyToClipboard(text, label) {
    navigator.clipboard.writeText(text).then(() => {
      alert(`✅ ${label} copied to clipboard!`);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      alert(`✅ ${label} copied (fallback)`);
    });
  }

  function exportMobsData() {
    const result = {};
    Object.entries(lastStateByZone).forEach(([zone, enemies]) => {
      const groups = {};
      enemies.forEach(e => {
        if (!groups[e.statsKey]) groups[e.statsKey] = { statsKey: e.statsKey, type: e.type, count: 0, positions: [] };
        groups[e.statsKey].count++;
        groups[e.statsKey].positions.push({ x: Math.round(e.pos.x), y: Math.round(e.pos.y) });
      });
      result[zone] = Object.values(groups);
    });
    const total = Object.values(result).reduce((s, g) => s + g.length, 0);
    _copyToClipboard(JSON.stringify(result, null, 2),
      `Mobs (${Object.keys(result).length} zones, ${total} types)`);
  }

  function exportResData() {
    const result = {};
    Object.entries(lastResourcesByZone).forEach(([zone, resources]) => {
      const groups = {};
      resources.forEach(r => {
        const k = r.resource;
        if (!groups[k]) groups[k] = { resource: r.resource, type: r.type, rarity: r.rarity || null, count: 0, positions: [] };
        groups[k].count++;
        groups[k].positions.push({ x: Math.round(r.pos.x), y: Math.round(r.pos.y) });
      });
      result[zone] = Object.values(groups);
    });
    const total = Object.values(result).reduce((s, g) => s + g.length, 0);
    _copyToClipboard(JSON.stringify(result, null, 2),
      `Resources (${Object.keys(result).length} zones, ${total} types)`);
  }

  function _makeExportBtn(label, onclick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = 'display:block;width:calc(100% - 12px);margin:6px 6px 2px;padding:4px 8px;background:#1a2a1a;color:#81c784;border:1px solid #2a4a2a;border-radius:4px;cursor:pointer;font-size:11px;font-family:monospace;text-align:left;';
    btn.onmouseover = () => { btn.style.background = '#1e3e1e'; };
    btn.onmouseout  = () => { btn.style.background = '#1a2a1a'; };
    btn.onclick = onclick;
    return btn;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  function renderStatePane() {
    const searchEl = document.getElementById('roeSearch');
    const search = searchEl ? searchEl.value.toLowerCase() : '';
    const _fp_state = _paneFor('state', statePane);
    if (!_fp_state) return;
    if (_fp_state === statePane && _poppedOut.has('state')) return;

    _fp_state.appendChild(_makeExportBtn('📋 Export all mobs as JSON', exportMobsData));

    Object.entries(lastStateByZone).forEach(([zone, enemies]) => {
      if (filterZone !== 'ALL' && zone !== filterZone) return;
      const filtered = enemies.filter(e => {
        if (filterType   !== 'ALL' && e.statsKey !== filterType) return false;
        if (filterStatus !== 'ALL') {
          if (filterStatus === 'alive' && !e.alive) return false;
          if (filterStatus === 'dead'  &&  e.alive) return false;
        }
        if (search && !e.statsKey.toLowerCase().includes(search) && !e.type.toLowerCase().includes(search)) return false;
        return true;
      });
      if (!filtered.length) return;

      const zc = zoneColor(zone);
      const zh = document.createElement('div');
      zh.style.cssText = `color:${zc};font-weight:bold;padding:3px 6px;background:#111;border-left:3px solid ${zc};margin-bottom:2px;margin-top:6px;font-size:11px;`;
      zh.textContent = `${zone} — ${filtered.length}`;
      _fp_state.appendChild(zh);

      const groups = {};
      filtered.forEach(e => { (groups[e.statsKey] = groups[e.statsKey] || []).push(e); });

      Object.entries(groups).forEach(([key, mobs]) => {
        const alive   = mobs.filter(m => m.alive).length;
        const tracked = isMobTracked(zone, key);

        const row = document.createElement('div');
        row.style.cssText = `padding:3px 8px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:5px;cursor:pointer`;

        const addBtn = document.createElement('button');
        addBtn.title = tracked ? 'Already tracked' : 'Add to tracking';
        addBtn.style.cssText = `
          background:${tracked ? '#3a261a' : '#1a2e3a'};
          color:${tracked ? '#ffb74d' : '#5b9bd5'};
          border:1px solid ${tracked ? '#4a3626' : '#2a3e4a'};
          border-radius:4px;padding:1px 5px;cursor:pointer;
          font-size:12px;font-family:monospace;flex-shrink:0;transition:all 0.15s;
        `;
        addBtn.textContent = tracked ? '✓' : '+';
        if (!tracked) {
          addBtn.onmouseover = () => { addBtn.style.background = '#1e4060'; addBtn.style.color = '#7bbfff'; };
          addBtn.onmouseout  = () => { addBtn.style.background = '#1a2e3a'; addBtn.style.color = '#5b9bd5'; };
          addBtn.onclick = e => { e.stopPropagation(); addMobToTracking(zone, key, mobs[0].type); renderStatePane(); };
        }

        const _mobMaxHp  = mobs[0] ? mobs[0].maxHp : 0;
        const _mobRespDur = knownRespawnDurations.get(key);
        row.innerHTML = `
          <span style="color:#ddd;flex:1;font-size:11px">${formatDisplayName(key)}</span>
          ${_mobMaxHp > 0 ? `<span style="color:#e88;font-size:10px;margin-right:3px" title="Max HP">❤ ${_mobMaxHp}</span>` : ''}
          ${_mobRespDur ? `<span style="color:#ffd700;font-size:10px;margin-right:3px" title="Respawn duration">⏱ ${fmtDuration(_mobRespDur)}</span>` : ''}
          <span>
            <span style="color:#81c784">▲${alive}</span>
            <span style="color:#e57373;margin-left:4px">▼${mobs.length - alive}</span>
          </span>
        `;
        row.insertBefore(addBtn, row.firstChild);

        // Add expand arrow to mob row
        const _mobArrow = document.createElement('span');
        _mobArrow.style.cssText = 'font-size:9px;color:#555;margin-left:2px;';
        _mobArrow.textContent = _expandedMobGroups.has(`${zone}_${key}`) ? '▲' : '▼';
        row.appendChild(_mobArrow);
        row.onclick = () => {
          const mobGkey = `${zone}_${key}`;
          const detail = _fp_state.querySelector(`[data-group="${mobGkey}"]`);
          if (detail) {
            const open = detail.style.display === 'none';
            detail.style.display = open ? '' : 'none';
            _mobArrow.textContent = open ? '▲' : '▼';
            if (open) _expandedMobGroups.add(mobGkey); else _expandedMobGroups.delete(mobGkey);
            return;
          }
          const dl = document.createElement('div');
          dl.dataset.group = mobGkey;
          dl.style.cssText = `background:#0a0a0a;padding:3px 14px;margin-bottom:2px`;
          mobs.forEach(m => {
            const mr = document.createElement('div');
            mr.style.cssText = `padding:2px 0;font-size:11px;color:${m.alive ? '#81c784' : '#e57373'};border-bottom:1px solid #111`;
            let respawnStr = '';
            if (!m.alive) {
              const rt = enemyRespawnTimers.get(m.id) || (m.respawnAt || null);
              if (rt) {
                const mins = fmtMs(rt);
                respawnStr = ` <span style="color:${timerColor(rt)};font-size:10px;font-family:monospace;font-variant-numeric:tabular-nums">${mins}</span>`;
              }
            }
            mr.innerHTML = `<span style="color:#555">${m.id}</span> <span style="color:#888;font-size:10px">${m.type || m.statsKey || ''}</span>  x:${m.pos.x.toFixed(1)} y:${m.pos.y.toFixed(1)}  ${hpBar(m.hp, m.maxHp)}${respawnStr}`;
            dl.appendChild(mr);
          });
          _expandedMobGroups.add(`${zone}_${key}`);
          _mobArrow.textContent = '▲';
          row.parentNode.insertBefore(dl, row.nextSibling);
        };
        _fp_state.appendChild(row);
        // Restore expanded detail on re-render
        if (_expandedMobGroups.has(`${zone}_${key}`)) {
          const dl = document.createElement('div');
          dl.dataset.group = `${zone}_${key}`;
          dl.style.cssText = `background:#0a0a0a;padding:3px 14px;margin-bottom:2px`;
          mobs.forEach(m => {
            const mr = document.createElement('div');
            mr.style.cssText = `padding:2px 0;font-size:11px;color:${m.alive ? '#81c784' : '#e57373'};border-bottom:1px solid #111`;
            let respawnStr = '';
            if (!m.alive) {
              const rt = enemyRespawnTimers.get(m.id) || (m.respawnAt || null);
              if (rt) {
                const mins = fmtMs(rt);
                respawnStr = ` <span style="color:${timerColor(rt)};font-size:10px;font-family:monospace;font-variant-numeric:tabular-nums">${mins}</span>`;
              }
            }
            mr.innerHTML = `<span style="color:#555">${m.id}</span> <span style="color:#888;font-size:10px">${m.type || m.statsKey || ''}</span>  x:${m.pos.x.toFixed(1)} y:${m.pos.y.toFixed(1)}  ${hpBar(m.hp, m.maxHp)}${respawnStr}`;
            dl.appendChild(mr);
          });
          _fp_state.appendChild(dl);
        }
      });
    });

    if (!_fp_state.children.length)
      _fp_state.innerHTML = `<div style="color:#555;padding:20px;text-align:center">No data / filtered out</div>`;
  }

  // ─── Tracking helpers ────────────────────────────────────────────────────────
  function isTracked(zone, resource) {
    for (const [, v] of trackedResources) { if (v.zone === zone && v.resource === resource) return true; }
    return false;
  }
  function isMobTracked(zone, statsKey) {
    for (const [, v] of trackedMobs) { if (v.zone === zone && v.statsKey === statsKey) return true; }
    return false;
  }

  function addToTracking(zone, resource, type, rarity, weakness) {
    if (isTracked(zone, resource)) { notifyTrack(null, `[${zone}] ${resource} is already in tracking`); return; }
    const id = ++trackIdCounter;
    const nodes = getTrackedResourceNodes(zone, resource);
    trackedResources.set(id, { kind: 'resource', zone, resource, type, rarity, weakness, notifyOnSpawn: true, notifyOnlyWhenFull: false, nodes });
    const aC0 = nodes.filter(n => n.active).length;
    previousTrackedStates.set(id, { activeCount: aC0, readyCount: aC0 });
    saveTracked();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
    notifyTrack(null, `Added to tracking: [${zone}] ${resource}`);
    updateTrackTab();
  }

  function addMobToTracking(zone, statsKey, type) {
    if (isMobTracked(zone, statsKey)) { notifyTrack(null, `[${zone}] ${statsKey} is already in tracking`); return; }
    const id = ++trackIdCounter;
    const nodes = getTrackedMobNodes(zone, statsKey);
    trackedMobs.set(id, { kind: 'mob', zone, statsKey, type, notifyOnSpawn: true, notifyOnlyWhenFull: false, nodes });
    const alive0 = nodes.filter(n => n.alive).length;
    previousTrackedMobStates.set(id, { aliveCount: alive0, readyCount: alive0 });
    saveTracked();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
    notifyTrack(null, `Added to tracking: [${zone}] ${statsKey}`);
    updateTrackTab();
  }

  function removeFromTracking(id) {
    trackedResources.delete(id); previousTrackedStates.delete(id);
    _notifyCooldowns.delete(`res_${id}`);
    saveTracked(); saveNotifyCooldowns();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane(); updateTrackTab();
  }
  function removeMobFromTracking(id) {
    trackedMobs.delete(id); previousTrackedMobStates.delete(id);
    _notifyCooldowns.delete(`mob_${id}`);
    saveTracked(); saveNotifyCooldowns();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane(); updateTrackTab();
  }

  function updateTrackTab() {
    const btn = document.getElementById('tabTrack');
    const isOpen = _poppedOut.has('track');
    btn.style.cssText = tabStyle(isOpen);
    btn.dataset.icon  = '🔔';
    btn.dataset.label = 'Track';
    btn.textContent   = '🔔';
  }

  function updateMarketTab() {
    const btn = document.getElementById('tabMarket');
    if (!btn) return;
    const isOpen = _poppedOut.has('market');
    btn.style.cssText = tabStyle(isOpen);
    btn.dataset.icon  = '🛒';
    btn.dataset.label = 'Market';
    btn.textContent   = '🛒';
  }

  // ─── Variant group helpers for tracking tab ──────────────────────────────────
  // Groups tracked mob entries that share the same statsKey (e.g. the same mob
  // tracked separately in Mines and MinesLower) so they can be shown as one row.
  function groupTrackedMobEntries(mobEntries) {
    const byKey = new Map();
    mobEntries.forEach(([id, v]) => {
      if (!byKey.has(v.statsKey)) byKey.set(v.statsKey, []);
      byKey.get(v.statsKey).push([id, v]);
    });
    return Array.from(byKey.values()).map(entries =>
      entries.length > 1
        ? { kind: 'group', entries }
        : { kind: 'solo', id: entries[0][0], v: entries[0][1] }
    );
  }

  // ─── Render "Resources" tab ──────────────────────────────────────────────────
  function renderResPane() {
    const search = document.getElementById('roeResSearch').value.toLowerCase();
    const _fp_res = _paneFor('res', resPane);
    if (!_fp_res) return;
    if (_fp_res === resPane && _poppedOut.has('res')) return;
    let totalShown = 0;

    _fp_res.appendChild(_makeExportBtn('📋 Export all resources as JSON', exportResData));

    Object.entries(lastResourcesByZone).forEach(([zone, resources]) => {
      if (resFilterZone !== 'ALL' && zone !== resFilterZone) return;

      const filtered = resources.filter(r => {
        if (resFilterType   !== 'ALL' && r.type     !== resFilterType)   return false;
        if (resFilterName   !== 'ALL' && r.resource !== resFilterName)   return false;
        if (resFilterStatus !== 'ALL') {
          if (resFilterStatus === 'active'   && !r.active) return false;
          if (resFilterStatus === 'depleted' &&  r.active) return false;
        }
        if (search && !r.resource.toLowerCase().includes(search) && !r.type.toLowerCase().includes(search)) return false;
        return true;
      });
      if (!filtered.length) return;
      totalShown += filtered.length;

      const zc = zoneColor(zone);
      const activeCount = filtered.filter(r => r.active).length;

      const zh = document.createElement('div');
      zh.style.cssText = `color:${zc};font-weight:bold;padding:3px 6px;background:#111;border-left:3px solid ${zc};margin-bottom:2px;margin-top:6px;display:flex;justify-content:space-between;font-size:11px;`;
      zh.innerHTML = `
        <span>${zone}</span>
        <span style="font-weight:normal;font-size:10px">
          <span style="color:#4caf50">✦${activeCount}</span>
          <span style="color:#555;margin-left:4px">✧${filtered.length - activeCount}</span>
        </span>
      `;
      _fp_res.appendChild(zh);

      const byResource = {};
      filtered.forEach(r => { (byResource[r.resource] = byResource[r.resource] || []).push(r); });

      const displayItems = Object.keys(byResource).map(resName => ({ kind: 'solo', resName }));

      displayItems.forEach(item => {
        if (item.kind === 'solo') {
          const resName = item.resName;
          const nodes   = byResource[resName];
          const tc      = resTypeColor(nodes[0].type);
          const rc      = rarityColor(nodes[0].rarity);
          const activeN = nodes.filter(n => n.active).length;
          const tracked = isTracked(zone, resName);

          const row = document.createElement('div');
          row.style.cssText = `padding:3px 8px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:5px;cursor:pointer;`;

          const addBtn = document.createElement('button');
          addBtn.title = tracked ? 'Already tracked' : 'Add to tracking';
          addBtn.style.cssText = `
            background:${tracked ? '#1a3a1a' : '#1a2e3a'};
            color:${tracked ? '#4caf50' : '#5b9bd5'};
            border:1px solid ${tracked ? '#2a4a2a' : '#2a3e4a'};
            border-radius:4px;padding:1px 5px;cursor:pointer;
            font-size:12px;font-family:monospace;flex-shrink:0;transition:all 0.15s;
          `;
          addBtn.textContent = tracked ? '✓' : '+';
          if (!tracked) {
            addBtn.onmouseover = () => { addBtn.style.background = '#1e4060'; addBtn.style.color = '#7bbfff'; };
            addBtn.onmouseout  = () => { addBtn.style.background = '#1a2e3a'; addBtn.style.color = '#5b9bd5'; };
            addBtn.onclick = e => {
              e.stopPropagation();
              addToTracking(zone, resName, nodes[0].type, nodes[0].rarity, nodes[0].weakness);
              renderResPane();
            };
          }

          const _resCdDur   = knownResDurations.get(resName);
          const _resWeakness = nodes[0].weakness;
          row.innerHTML = `
            <span style="color:${tc};font-size:12px">${resIcon(nodes[0].type)}</span>
            <span style="color:#ddd;flex:1;font-size:11px">${formatResName(resName)}</span>
            <span style="color:${rc};font-size:10px">${nodes[0].rarity}</span>
            ${_resCdDur ? `<span style="color:#ffd700;font-size:10px" title="Respawn cooldown">⏱ ${fmtDuration(_resCdDur)}</span>` : ''}
            ${_resWeakness ? `<span style="color:#64b5f6;font-size:10px" title="Weakness">⚡ ${_resWeakness}</span>` : ''}
            <span>
              <span style="color:#4caf50">✦${activeN}</span>
              <span style="color:#555;margin-left:3px">✧${nodes.length - activeN}</span>
            </span>
          `;
          row.insertBefore(addBtn, row.firstChild);

          // Add expand arrow to solo row
          const _soloArrow = document.createElement('span');
          _soloArrow.style.cssText = 'font-size:9px;color:#555;margin-left:2px;';
          _soloArrow.textContent = '▼';
          row.appendChild(_soloArrow);
          row.onclick = e => {
            if (e.target === addBtn) return;
            const gkey   = `res_${zone}_${resName}`;
            const detail = _fp_res.querySelector(`[data-resgroup="${gkey}"]`);
            if (detail) {
              const open = detail.style.display === 'none';
              detail.style.display = open ? '' : 'none';
              _soloArrow.textContent = open ? '▲' : '▼';
              if (open) _expandedResGroups.add(gkey); else _expandedResGroups.delete(gkey);
              return;
            }
            const dl = document.createElement('div');
            dl.dataset.resgroup = gkey;
            dl.style.cssText = `background:#0a0a0a;padding:3px 14px;margin-bottom:2px`;
            nodes.forEach(n => {
              const nr = document.createElement('div');
              nr.style.cssText = `padding:2px 0;font-size:10px;color:${n.active ? '#4caf50' : '#555'};border-bottom:1px solid #111;display:flex;gap:6px;align-items:center`;
              const timerMs  = !n.active ? getNodeMaxTimer(n.idx) : null;
              const timeLeft = timerMs ? fmtMs(timerMs) : null;
              const timerStr = timeLeft !== null ? `<span style="color:${timerColor(timerMs)};font-size:10px;font-family:monospace;font-variant-numeric:tabular-nums">${`${timeLeft}`}</span>` : '';
              nr.innerHTML = `
                <span>${n.active ? '✦' : '✧'}</span>
                <span>x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}</span>
                ${hpBar(n.hp, n.maxHp)}
                ${timerStr}
              `;
              dl.appendChild(nr);
            });
            _expandedResGroups.add(gkey);
            _soloArrow.textContent = '▲';
            row.parentNode.insertBefore(dl, row.nextSibling);
          };
          _fp_res.appendChild(row);
          // Restore expanded detail on re-render
          if (_expandedResGroups.has(`res_${zone}_${resName}`)) {
            const dlRe = document.createElement('div');
            dlRe.dataset.resgroup = `res_${zone}_${resName}`;
            dlRe.style.cssText = `background:#0a0a0a;padding:3px 14px;margin-bottom:2px`;
            nodes.forEach(n => {
              const nr = document.createElement('div');
              nr.style.cssText = `padding:2px 0;font-size:10px;color:${n.active ? '#4caf50' : '#555'};border-bottom:1px solid #111;display:flex;gap:6px;align-items:center`;
              const timerMs  = !n.active ? getNodeMaxTimer(n.idx) : null;
              const timeLeft = timerMs ? fmtMs(timerMs) : null;
              const timerStr = timeLeft !== null ? `<span style="color:${timerColor(timerMs)};font-size:10px;font-family:monospace;font-variant-numeric:tabular-nums">${timeLeft}</span>` : '';
              nr.innerHTML = `<span>${n.active ? '✦' : '✧'}</span><span>x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}</span>${hpBar(n.hp, n.maxHp)}${timerStr}`;
              dlRe.appendChild(nr);
            });
            _fp_res.appendChild(dlRe);
          }

        }
      });
    });

    if (!totalShown)
      _fp_res.innerHTML = `<div style="color:#555;padding:20px;text-align:center">No resources / filtered out</div>`;
  }

  // ─── Render "Tracking" tab — compact version ─────────────────────────────────
  const TRACK_FULL_WIDTH  = 500;
  const TRACK_FULL_HEIGHT = 600;

  function applyTrackFullSize() {
    const fp = _floatPanels['track'];
    if (!fp) return;
    fp.style.width     = TRACK_FULL_WIDTH  + 'px';
    fp.style.height    = TRACK_FULL_HEIGHT + 'px';
    fp.style.maxHeight = TRACK_FULL_HEIGHT + 'px';
    if (fp._resizeHandle) fp._resizeHandle.style.display = 'none';
  }

  function restoreTrackCompactSize() {
    const fp = _floatPanels['track'];
    if (!fp) return;
    fp.style.width     = 'auto';
    fp.style.height    = '';
    fp.style.maxHeight = '95vh';
  }

  function setTrackCloseBtnMode(isFull) {
    const fp = _floatPanels['track'];
    if (!fp || !fp._closeBtn) return;
    const btn = fp._closeBtn;
    if (isFull) {
      btn.textContent = 'Back';
      btn.title = 'Back to compact Track view';
      btn.style.cssText = 'background:none;border:1px solid #444;color:#aaa;cursor:pointer;font-size:10px;padding:1px 7px;line-height:1.5;border-radius:3px;';
      btn.onclick = () => closeTrackFullView();
    } else {
      btn.textContent = '⚙️';
      btn.title = 'Open full Track view';
      btn.style.cssText = 'background:none;border:none;color:#7b8fff;cursor:pointer;font-size:12px;padding:0 2px;line-height:1;';
      btn.onclick = () => openTrackFullView();
    }
  }

  function openTrackFullView() {
    _trackFullOpen = true;
    if (!_poppedOut.has('track')) popOutTab('track');
    else renderTrackPane();
    applyTrackFullSize();
    setTrackCloseBtnMode(true);
  }

  function closeTrackFullView() {
    _trackFullOpen = false;
    restoreTrackCompactSize();
    setTrackCloseBtnMode(false);
    renderTrackPane();
  }

  function setQBCloseBtnMode(isFull) {
    const fp = _floatPanels['qb'];
    if (!fp || !fp._closeBtn) return;
    const btn = fp._closeBtn;
    if (isFull) {
      btn.textContent = 'Back';
      btn.title = 'Back to compact Durability view';
      btn.style.cssText = 'background:none;border:1px solid #444;color:#aaa;cursor:pointer;font-size:10px;padding:1px 7px;line-height:1.5;border-radius:3px;';
      btn.onclick = () => closeQBFullView();
    } else {
      btn.textContent = '⚙️';
      btn.title = 'Open full Durability view';
      btn.style.cssText = 'background:none;border:none;color:#7b8fff;cursor:pointer;font-size:12px;padding:0 2px;line-height:1;';
      btn.onclick = () => openQBFullView();
    }
  }

  function applyQBFullSize() {
    const fp = _floatPanels['qb'];
    if (!fp) return;
    const saved = loadQBFullSize();
    const w = saved ? saved.width  : QB_FULL_WIDTH;
    const h = saved ? saved.height : QB_FULL_HEIGHT;
    fp.style.width     = w + 'px';
    fp.style.height    = h + 'px';
    fp.style.maxHeight = h + 'px';
    // Full Durability view is resizable; user's chosen size is remembered.
    if (fp._resizeHandle) fp._resizeHandle.style.display = '';
  }

  function restoreQBCompactSize() {
    const fp = _floatPanels['qb'];
    if (!fp) return;
    if (fp._resizeHandle) fp._resizeHandle.style.display = 'none';
    fp.style.width     = 'auto';
    fp.style.height    = '';
    fp.style.maxHeight = '95vh';
  }

  function openQBFullView() {
    _qbFullOpen = true;
    try { localStorage.setItem('roeQBFullOpen', '1'); } catch (_) {}
    if (!_poppedOut.has('qb')) popOutTab('qb');
    else renderQBPane();
    applyQBFullSize();
    setQBCloseBtnMode(true);
  }

  function closeQBFullView() {
    _qbFullOpen = false;
    try { localStorage.setItem('roeQBFullOpen', '0'); } catch (_) {}
    restoreQBCompactSize();
    setQBCloseBtnMode(false);
    renderQBPane();
  }

  function makeTrackPanelsRow() {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;gap:6px;flex-wrap:wrap;`;

    const title = document.createElement('span');
    title.style.cssText = `color:#7b8fff;font-size:11px;font-weight:bold;width:75px;flex-shrink:0;`;
    title.textContent = '🎯 Targets:';
    row.appendChild(title);

    const mkBtn = (label, title, onClick, active) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = title;
      btn.style.cssText = `background:${active ? '#141c2e' : 'none'};color:${active ? '#7b8fff' : '#888'};border:1px solid #1e2535;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;`;
      btn.onclick = onClick;
      return btn;
    };

    row.appendChild(mkBtn('👾 Mobs', 'Open Mobs panel', () => { toggleFloat('state'); renderTrackPane(); }, _poppedOut.has('state')));
    row.appendChild(mkBtn('🌿 Resources', 'Open Resources panel', () => { toggleFloat('res'); renderTrackPane(); }, _poppedOut.has('res')));
    return row;
  }

  function makeTrackGearBar() {
    const bar = document.createElement('div');
    bar.style.cssText = `display:flex;justify-content:flex-end;padding:2px 4px 0;`;
    const gearBtn = document.createElement('button');
    gearBtn.textContent = '⚙️';
    gearBtn.title = 'Open full Track view (settings, manage)';
    gearBtn.style.cssText = `background:none;border:none;color:#7b8fff;cursor:pointer;font-size:12px;padding:0 2px;line-height:1;`;
    gearBtn.onclick = () => openTrackFullView();
    bar.appendChild(gearBtn);
    return bar;
  }

  function renderTrackPaneCompact() {
    if (!_poppedOut.has('track')) _fp_track.appendChild(makeTrackGearBar());

    const totalTracked = trackedResources.size + trackedMobs.size;
    if (totalTracked === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:#555;padding:14px 8px;text-align:center;font-size:10px;line-height:1.7;`;
      empty.innerHTML = `Tracking empty.<br><span style="color:#333">Click <span style="color:#5b9bd5">+</span> in 👾 or 🌿</span>`;
      _fp_track.appendChild(empty);
      return;
    }

    const zones = new Set();
    trackedResources.forEach(v => zones.add(_trackZoneGroup(v.zone)));
    trackedMobs.forEach(v => zones.add(_trackZoneGroup(v.zone)));

    Array.from(zones).sort().forEach(zone => {

      const realZones = _trackZoneGroupRealZones(zone);
      const mobEntries = [], resEntries = [];
      trackedMobs.forEach((v, k)      => { if (realZones.includes(v.zone)) mobEntries.push([k, v]); });
      trackedResources.forEach((v, k) => { if (realZones.includes(v.zone)) resEntries.push([k, v]); });
      mobEntries.sort((a, b) => (_trackDisplayOrder[a[0]] ?? 9999) - (_trackDisplayOrder[b[0]] ?? 9999));
      resEntries.sort((a, b) => (_trackDisplayOrder[a[0]] ?? 9999) - (_trackDisplayOrder[b[0]] ?? 9999));
      if (!mobEntries.length && !resEntries.length) return;

      const zc = zoneColor(realZones[0]);
      const zh = document.createElement('div');
      zh.style.cssText = `color:${zc};font-weight:bold;padding:3px 6px;background:#0e1018;border-left:3px solid ${zc};margin-top:4px;margin-bottom:1px;font-size:13px;`;
      zh.textContent = zone;
      _fp_track.appendChild(zh);

      if (mobEntries.length) {
        const sec = document.createElement('div');
        sec.style.cssText = `padding:1px 6px 1px;color:#ff9800;font-size:9px;text-transform:uppercase;letter-spacing:0.05em;`;
        sec.textContent = 'MOBS';
        _fp_track.appendChild(sec);

        groupTrackedMobEntries(mobEntries).forEach(item => {
          const groupEntries = item.kind === 'solo' ? [[item.id, item.v]] : item.entries;
          const v0 = groupEntries[0][1];
          const combined = [];
          groupEntries.forEach(([, v]) => v.nodes.forEach(n => combined.push({ n, v })));
          // Count nodes shown as orange ("probably up" — no confirmed-dead timer,
          // or an expired one) as alive too, so the header ratio (e.g. "8/13")
          // matches what the dots below actually show instead of only counting
          // confirmed-alive nodes (which stayed stuck at "2/13" until the zone
          // was visited and the server confirmed each node's live state).
          const aliveN = combined.filter(o => {
            if (o.n.alive) return true;
            let rtRaw = enemyRespawnTimers.get(o.n.id) || null;
            if (!rtRaw && o.n.pos) {
              const pk = _mobPosKey(o.v.zone, o.v.statsKey, o.n.pos);
              rtRaw = _stableMobTimers[pk] || null;
            }
            const expired = rtRaw && rtRaw <= Date.now();
            return (!rtRaw) || expired;
          }).length;
          const isLive = groupEntries.some(([, v]) => _seenZones.has(v.zone));
          const row = document.createElement('div');
          row.style.cssText = `padding:3px 6px 4px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid #2a2a35;`;

          const nameEl = document.createElement('span');
          nameEl.style.cssText = `color:#ddd;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
          nameEl.innerHTML = `<span style="font-size:11px;margin-right:3px;vertical-align:middle;">${mobIcon()}</span>${formatDisplayName(v0.statsKey)}`
            + (isLive && combined.length > 0 ? ` <span style="font-size:10px;">${aliveN}/${combined.length}</span>` : '');
          row.appendChild(nameEl);

          if (isLive && combined.length > 0) {
            const wrap = document.createElement('div');
            wrap.style.cssText = `display:flex;flex-direction:column;gap:3px;`;

            const bar = document.createElement('div');
            bar.style.cssText = `display:flex;align-items:center;gap:2px;flex-wrap:wrap;max-width:142px;`;
            const _mobReadyKeyC = ({ n, v }) => {
              if (n.alive) return 0;
              let rt = enemyRespawnTimers.get(n.id) || null;
              if (!rt && n.pos) {
                const pk = _mobPosKey(v.zone, v.statsKey, n.pos);
                const st = _stableMobTimers[pk];
                if (st && st > Date.now()) rt = st;
              }
              if (!rt || rt <= Date.now()) return 1; // probably-up / unknown — right after alive, before timed
              return rt;
            };
            combined.slice().sort((a, b) => _mobReadyKeyC(a) - _mobReadyKeyC(b)).forEach(({ n, v }) => {
              // Primary: in-memory timer (populated during session or reseeded at startup)
              // Fallback: stable position-based timer (survives reload even when entity ID changes)
              let rt        = !n.alive ? (enemyRespawnTimers.get(n.id) || null) : null;
              let rtRaw     = rt;
              if (!rt && !n.alive && n.pos) {
                const pk = _mobPosKey(v.zone, v.statsKey, n.pos);
                const st = _stableMobTimers[pk];
                if (st) { rtRaw = st; if (st > Date.now()) rt = st; }
              }
              const expired   = !n.alive && rtRaw && rtRaw <= Date.now();
              const mins      = rt ? fmtMs(rt) : null;
              const estimated = rt ? _estimatedEnemyTimers.has(n.id) : false;
              const probablyUp = (!n.alive && !rtRaw) || expired;

              const dot = document.createElement('span');
              if (n.alive) {
                dot.title = `x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`;
                dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:2px;background:#4caf50;border:1px solid #5dba6e;`;
              } else if (probablyUp) {
                dot.title = `x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)} · ${expired ? 'probably respawned' : 'visit zone to confirm status'}`;
                dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:2px;background:#ff9800;border:1px solid #ffb74d;`;
              } else {
                dot.title = `x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
                  + (mins !== null ? ` · respawn ${estimated ? '~' : ''}${mins}` : '');
                dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:2px;background:#2a2a2a;border:1px solid #333;`;
              }
              const pKey = _pointerKey(v.zone, n.pos);
              dot.style.cursor = 'pointer';
              if (_pointerTarget && _pointerTarget.key === pKey) {
                dot.style.boxShadow = '0 0 0 2px #7b8fff, 0 0 5px 1px #7b8fff';
              }
              dot.addEventListener('click', () => {
                _pointerTarget = (_pointerTarget && _pointerTarget.key === pKey)
                  ? null
                  : { zone: v.zone, x: n.pos.x, y: n.pos.y, label: formatDisplayName(v.statsKey), key: pKey };
                renderTrackPane();
              });
              bar.appendChild(dot);
            });
            wrap.appendChild(bar);

            const soonestMobC = combined
              .filter(o => !o.n.alive && o.n.id)
              .map(({ n, v }) => {
                let ms = enemyRespawnTimers.get(n.id);
                if (!ms && n.pos) { const pk = _mobPosKey(v.zone, v.statsKey, n.pos); const st = _stableMobTimers[pk]; if (st && st > Date.now()) ms = st; }
                return { ms, id: n.id };
              })
              .filter(x => x.ms && x.ms > Date.now())
              .sort((a, b) => a.ms - b.ms)[0];
            if (soonestMobC) {
              const minsC     = fmtMs(soonestMobC.ms);
              const estimated = _estimatedEnemyTimers.has(soonestMobC.id);
              const tEl = document.createElement('span');
              tEl.style.cssText = `font-size:11px;color:${timerColor(soonestMobC.ms, estimated)};font-family:monospace;font-variant-numeric:tabular-nums;`;
              tEl.title = estimated ? 'Estimated (based on known respawn duration)' : '';
              tEl.innerHTML = `${estimated ? '~' : ''}${minsC}`;
              wrap.appendChild(tEl);
            }

            row.appendChild(wrap);
          }

          _fp_track.appendChild(row);
        });
      }

      if (resEntries.length) {
        const sec = document.createElement('div');
        sec.style.cssText = `padding:1px 6px 1px;color:#4caf50;font-size:9px;text-transform:uppercase;letter-spacing:0.05em;`;
        sec.textContent = 'RESOURCES';
        _fp_track.appendChild(sec);

        realZones.forEach(realZone => {
        const zoneResEntries = resEntries.filter(([, v]) => v.zone === realZone);
        if (!zoneResEntries.length) return;
        zoneResEntries.forEach(([id, v0]) => {
          const allNodes = v0.nodes;

          // Same fix as mobs above: count orange ("probably active, unconfirmed
          // timer") nodes toward the ratio too, matching the dots below.
          const activeN = allNodes.filter(n => {
            if (n.active) return true;
            const t = getNodeMaxTimer(n.idx);
            const expired = t && t <= Date.now();
            return (!t) || expired;
          }).length;
          const isLive  = _seenZones.has(realZone);
          const tc      = resTypeColor(v0.type);

          const row = document.createElement('div');
          row.style.cssText = `padding:3px 6px 4px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid #2a2a35;`;

          const nameRow = document.createElement('div');
          nameRow.style.cssText = `display:flex;align-items:center;gap:4px;`;
          nameRow.innerHTML = `<span style="color:${tc};font-size:11px;flex-shrink:0;">${resIcon(v0.type)}</span>`;
          const nameEl = document.createElement('span');
          nameEl.style.cssText = `color:#ddd;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
          nameEl.innerHTML = formatResName(v0.resource)
            + (isLive && allNodes.length > 0 ? ` <span style="font-size:10px;">${activeN}/${allNodes.length}</span>` : '');
          nameRow.appendChild(nameEl);
          row.appendChild(nameRow);

          if (isLive && allNodes.length > 0) {
            const wrap = document.createElement('div');
            wrap.style.cssText = `display:flex;flex-direction:column;gap:3px;`;

            const bar = document.createElement('div');
            bar.style.cssText = `display:flex;align-items:center;gap:2px;flex-wrap:wrap;max-width:142px;`;
            const _nodeReadyKey = n => {
              if (n.active) return 0;
              const t = getNodeMaxTimer(n.idx);
              if (!t || t <= Date.now()) return 1;
              return t;
            };
            allNodes.slice().sort((a, b) => _nodeReadyKey(a) - _nodeReadyKey(b)).forEach(n => {
              const timerRaw  = !n.active ? getNodeMaxTimer(n.idx) : null;
              const expired   = !n.active && timerRaw && timerRaw <= Date.now();
              const timerMsC  = timerRaw && timerRaw > Date.now() ? timerRaw : null;
              const timeLeftC = timerMsC ? fmtMs(timerMsC) : null;
              const probablyUp = (!n.active && !timerRaw) || expired;

              const dot = document.createElement('span');
              if (n.active) {
                dot.title = `x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`;
                dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:2px;background:#4caf50;border:1px solid #5dba6e;`;
              } else if (probablyUp) {
                dot.title = `x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)} · ${expired ? 'probably respawned' : 'visit zone to confirm status'}`;
                dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:2px;background:#ff9800;border:1px solid #ffb74d;`;
              } else {
                dot.title = `x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
                  + (timeLeftC !== null ? ` · respawn ${timeLeftC}` : '');
                dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:2px;background:#2a2a2a;border:1px solid #333;`;
              }
              const pKey = _pointerKey(realZone, n.pos);
              dot.style.cursor = 'pointer';
              if (_pointerTarget && _pointerTarget.key === pKey) {
                dot.style.boxShadow = '0 0 0 2px #7b8fff, 0 0 5px 1px #7b8fff';
              }
              dot.addEventListener('click', () => {
                _pointerTarget = (_pointerTarget && _pointerTarget.key === pKey)
                  ? null
                  : { zone: realZone, x: n.pos.x, y: n.pos.y, label: formatResName(v0.resource), key: pKey };
                renderTrackPane();
              });
              bar.appendChild(dot);
            });
            wrap.appendChild(bar);

            const soonestNode = allNodes
              .filter(n => !n.active)
              .map(n => ({ ms: getNodeMaxTimer(n.idx), pos: n.pos }))
              .filter(x => x.ms && x.ms > Date.now())
              .sort((a, b) => a.ms - b.ms)[0];
            if (soonestNode) {
              const minsRC    = fmtMs(soonestNode.ms);
              const tEl = document.createElement('span');
              tEl.style.cssText = `font-size:11px;color:${timerColor(soonestNode.ms)};font-family:monospace;font-variant-numeric:tabular-nums;`;
              tEl.innerHTML = minsRC;
              wrap.appendChild(tEl);
            }

            row.appendChild(wrap);
          }

          _fp_track.appendChild(row);
        });
        });
      }


    });
  }

  // ─── Render "Tracking" tab ───────────────────────────────────────────────────
  function getDesktopNotifyStatus() { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }
  function getDesktopNotifyLabel()  {
    const s = getDesktopNotifyStatus();
    return s === 'granted' ? 'enabled' : s === 'denied' ? 'blocked' : s === 'default' ? 'need permission' : 'unsupported';
  }

  function renderTrackSettings() {
    const wrap = document.createElement('div');
    wrap.style.cssText = `padding:8px 10px;margin-bottom:6px;background:#0d1117;border:1px solid #1e2535;border-radius:6px;display:flex;flex-direction:column;gap:8px;`;

    // ── Row 1: Alerts section ────────────────────────────────────────────────
    const alertsRow = document.createElement('div');
    alertsRow.style.cssText = `display:flex;align-items:center;gap:6px;flex-wrap:wrap;`;

    const alertsTitle = document.createElement('span');
    alertsTitle.style.cssText = `color:#7b8fff;font-size:11px;font-weight:bold;width:75px;flex-shrink:0;`;
    alertsTitle.textContent = '🔔 Alerts:';
    alertsRow.appendChild(alertsTitle);

    const makeToggle = (label, icon, checked, onChange) => {
      const lbl = document.createElement('label');
      lbl.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:4px;border:1px solid #1e2535;background:${checked ? '#141c2e' : '#0d1117'};transition:background 0.15s;user-select:none;`;
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = checked; cb.style.cssText = `cursor:pointer;accent-color:#7b8fff;width:13px;height:13px;`;
      const txt = document.createElement('span');
      txt.style.cssText = `font-size:12px;color:${checked ? '#cdd' : '#666'};white-space:nowrap;`;
      txt.textContent = icon + ' ' + label;
      cb.onchange = () => {
        const c = cb.checked;
        lbl.style.background = c ? '#141c2e' : '#0d1117';
        txt.style.color = c ? '#cdd' : '#666';
        onChange(c, cb);
      };
      lbl.appendChild(cb);
      lbl.appendChild(txt);
      return lbl;
    };

    alertsRow.appendChild(makeToggle('Toast', '💬', notificationPrefs.toastEnabled, (c) => {
      notificationPrefs.toastEnabled = c; saveNotifyPrefs();
    }));
    alertsRow.appendChild(makeToggle('Sound', '🔊', notificationPrefs.soundEnabled, (c) => {
      notificationPrefs.soundEnabled = c; saveNotifyPrefs();
      if (c) playTrackNotificationSound({ kind: 'mob', nodes: [], zone: '' });
    }));

    const desktopToggle = makeToggle('Desktop', '🖥️', notificationPrefs.desktopEnabled, async (c, cb) => {
      if (!c) {
        notificationPrefs.desktopEnabled = false; saveNotifyPrefs();
        notifyTrack(null, 'Desktop notifications disabled'); renderTrackPane(); return;
      }
      const permission = await requestDesktopNotificationPermission();
      if (permission !== 'granted') {
        notificationPrefs.desktopEnabled = false; saveNotifyPrefs();
        cb.checked = false;
        notifyTrack(null, permission === 'denied' ? 'Browser blocked desktop notifications' : 'Permission not granted');
        renderTrackPane(); return;
      }
      notificationPrefs.desktopEnabled = true; saveNotifyPrefs();
      notifyTrack(null, 'Desktop notifications enabled'); renderTrackPane();
    });
    if (typeof Notification === 'undefined') desktopToggle.querySelector('input').disabled = true;
    alertsRow.appendChild(desktopToggle);

    const statusBadge = document.createElement('span');
    const sl = getDesktopNotifyLabel();
    statusBadge.style.cssText = `font-size:10px;color:#555;margin-left:2px;`;
    statusBadge.textContent = sl;
    alertsRow.appendChild(statusBadge);

    wrap.appendChild(alertsRow);

    // ── Row 1.5: Panels (Mobs / Res) ─────────────────────────────────────────
    wrap.appendChild(makeTrackPanelsRow());

    // ── Row 2: Export / Import ────────────────────────────────────────────────
    const ioRow = document.createElement('div');
    ioRow.style.cssText = `display:flex;align-items:center;gap:6px;`;

    const ioTitle = document.createElement('span');
    ioTitle.style.cssText = `color:#7b8fff;font-size:11px;font-weight:bold;width:75px;flex-shrink:0;`;
    ioTitle.textContent = '💾 Config:';
    ioRow.appendChild(ioTitle);

    const exportBtn = document.createElement('button');
    exportBtn.title = 'Save your tracking list to a file';
    exportBtn.style.cssText = `background:#132213;color:#7bc67e;border:1px solid #2a4a2a;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px;`;
    exportBtn.innerHTML = '⬇ Export';
    exportBtn.onmouseover = () => { exportBtn.style.background = '#1a3318'; };
    exportBtn.onmouseout  = () => { exportBtn.style.background = '#132213'; };
    exportBtn.onclick = () => {
      const resources = [], mobs = [];
      trackedResources.forEach((v) => resources.push({
        zone: v.zone, resource: v.resource, type: v.type,
        rarity: v.rarity, weakness: v.weakness,
        notifyOnSpawn: v.notifyOnSpawn, notifyOnlyWhenFull: v.notifyOnlyWhenFull === true
      }));
      trackedMobs.forEach((v) => mobs.push({
        zone: v.zone, statsKey: v.statsKey, type: v.type,
        notifyOnSpawn: v.notifyOnSpawn, notifyOnlyWhenFull: v.notifyOnlyWhenFull === true
      }));
      const json = JSON.stringify({ version: 1, resources, mobs }, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), { href: url, download: 'roe-tracking.json' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    ioRow.appendChild(exportBtn);

    const importBtn = document.createElement('button');
    importBtn.title = 'Load a previously exported tracking list';
    importBtn.style.cssText = `background:#131322;color:#7b8fff;border:1px solid #2a2a4a;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px;`;
    importBtn.innerHTML = '⬆ Import';
    importBtn.onmouseover = () => { importBtn.style.background = '#1a1a38'; };
    importBtn.onmouseout  = () => { importBtn.style.background = '#131322'; };
    importBtn.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
          try {
            const p = JSON.parse(e.target.result);
            const resources = Array.isArray(p.resources) ? p.resources : [];
            const mobs      = Array.isArray(p.mobs)      ? p.mobs      : [];
            let added = 0;
            resources.forEach(item => {
              if (!item.zone || !item.resource) return;
              if (isTracked(item.zone, item.resource)) return;
              const id = ++trackIdCounter;
              const nodes = getTrackedResourceNodes(item.zone, item.resource);
              trackedResources.set(id, {
                kind: 'resource', zone: item.zone, resource: item.resource,
                type: item.type || '', rarity: item.rarity || '', weakness: item.weakness || '',
                notifyOnSpawn: item.notifyOnSpawn !== false,
                notifyOnlyWhenFull: item.notifyOnlyWhenFull === true, nodes
              });
              const aC = nodes.filter(n => n.active).length;
              previousTrackedStates.set(id, { activeCount: aC, readyCount: aC });
              added++;
            });
            mobs.forEach(item => {
              if (!item.zone || !item.statsKey) return;
              if (isMobTracked(item.zone, item.statsKey)) return;
              const id = ++trackIdCounter;
              const nodes = getTrackedMobNodes(item.zone, item.statsKey);
              trackedMobs.set(id, {
                kind: 'mob', zone: item.zone, statsKey: item.statsKey,
                type: item.type || '',
                notifyOnSpawn: item.notifyOnSpawn !== false,
                notifyOnlyWhenFull: item.notifyOnlyWhenFull === true, nodes
              });
              const aliveC = nodes.filter(n => n.alive).length;
              previousTrackedMobStates.set(id, { aliveCount: aliveC, readyCount: aliveC });
              added++;
            });
            saveTracked();
            renderTrackPane();
            updateTrackTab();
            notifyTrack(null, `Imported ${added} entries`);
          } catch (err) {
            notifyTrack(null, `Import failed: ${err.message}`);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    };
    ioRow.appendChild(importBtn);

    wrap.appendChild(ioRow);
    return wrap;
  }

  function makeTrackSection(title, color) {
    const s = document.createElement('div');
    s.style.cssText = `padding:5px 10px 4px;color:${color};font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.08em;background:rgba(0,0,0,0.2);border-left:2px solid ${color};margin:2px 0 1px;`;
    s.textContent = title;
    return s;
  }

  function renderTrackedResourceRow(id, v) {
    const tc = resTypeColor(v.type);
    const activeN = v.nodes.filter(n => n.active).length, totalN = v.nodes.length;
    const isLive = _seenZones.has(v.zone);

    const row = document.createElement('div');
    row.style.cssText = `padding:7px 10px 6px;border-bottom:1px solid #1a1a24;display:flex;flex-direction:column;gap:5px;${!isLive ? 'opacity:0.5;' : ''}background:#0c0d14;`;

    // ── Top line: icon + name ────────────────────────────────────────────────
    const top = document.createElement('div');
    top.style.cssText = `display:flex;align-items:center;gap:7px;`;

    const iconEl = document.createElement('span');
    iconEl.style.cssText = `font-size:16px;line-height:1;flex-shrink:0;`;
    iconEl.textContent = resIcon(v.type);
    top.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.style.cssText = `color:#e0e0e0;flex:1;font-weight:bold;font-size:13px;`;
    nameEl.innerHTML = formatResName(v.resource) + (isLive && totalN > 0 ? ` <span style="font-weight:normal;font-size:11px;">${activeN}/${totalN}</span>` : '');
    top.appendChild(nameEl);

    if (!isLive) {
      const wait = document.createElement('span');
      wait.style.cssText = `font-size:11px;color:#555;background:#111;border:1px solid #222;border-radius:4px;padding:2px 6px;`;
      wait.title = 'Waiting for zone visit to get live data';
      wait.textContent = '⏳ Not visited yet';
      top.appendChild(wait);
    }

    row.appendChild(top);

    // ── Node dots + soonest respawn timer ────────────────────────────────────
    if (isLive && totalN > 0) {
      const wrap = document.createElement('div');
      wrap.style.cssText = `padding-left:23px;display:flex;flex-direction:column;gap:4px;`;

      const bar = document.createElement('div');
      bar.style.cssText = `display:flex;align-items:center;gap:2px;flex-wrap:wrap;max-width:145px;`;

      const _nodeReadyKey2 = n => {
        if (n.active) return 0;
        const t = getNodeMaxTimer(n.idx);
        if (!t || t <= Date.now()) return 1;
        return t;
      };
      v.nodes.slice().sort((a, b) => _nodeReadyKey2(a) - _nodeReadyKey2(b)).forEach(n => {
        const dot = document.createElement('span');
        const timerMs = !n.active ? getNodeMaxTimer(n.idx) : null;
        const timeLeft = timerMs ? fmtMs(timerMs) : null;
        dot.title = `Node at x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
          + (timeLeft !== null ? `\nRespawns in ${timeLeft}` : n.active ? '\nActive' : '\nOn cooldown');
        dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:3px;cursor:default;background:${n.active ? '#2a5e2a' : '#2a2a2a'};border:1px solid ${n.active ? '#4caf50' : '#3a3a3a'};`;
        bar.appendChild(dot);
      });
      wrap.appendChild(bar);

      const soonest = v.nodes
        .filter(n => !n.active)
        .map(n => getNodeMaxTimer(n.idx))
        .filter(ms => ms && ms > Date.now())
        .sort((a, b) => a - b)[0];

      if (soonest) {
        const timerEl = document.createElement('span');
        timerEl.style.cssText = `font-size:12px;color:${timerColor(soonest)};font-family:monospace;font-variant-numeric:tabular-nums;background:#111;border:1px solid #222;border-radius:4px;padding:1px 6px;`;
        timerEl.title = 'Next node becomes active in';
        timerEl.innerHTML = `⏱ ${fmtMs(soonest)}`;
        wrap.appendChild(timerEl);
      }

      row.appendChild(wrap);
    }

    // ── Alert toggle row ─────────────────────────────────────────────────────
    const alertRow = document.createElement('div');
    alertRow.style.cssText = `display:flex;align-items:center;gap:6px;padding-left:23px;`;

    const notifyLbl = document.createElement('label');
    notifyLbl.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:5px;font-size:11px;color:#888;user-select:none;`;
    const notifyCb = document.createElement('input');
    notifyCb.type = 'checkbox'; notifyCb.checked = v.notifyOnSpawn; notifyCb.style.cssText = `cursor:pointer;accent-color:#4caf50;`;
    notifyCb.onchange = e => { v.notifyOnSpawn = e.target.checked; saveTracked(); };
    notifyLbl.appendChild(notifyCb);
    notifyLbl.appendChild(document.createTextNode('Alert on respawn'));
    alertRow.appendChild(notifyLbl);

    const fullLbl = document.createElement('label');
    fullLbl.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:5px;font-size:11px;color:#666;user-select:none;margin-left:10px;`;
    const fullCb = document.createElement('input');
    fullCb.type = 'checkbox'; fullCb.checked = v.notifyOnlyWhenFull === true; fullCb.style.cssText = `cursor:pointer;accent-color:#4caf50;`;
    fullCb.onchange = e => { v.notifyOnlyWhenFull = e.target.checked; saveTracked(); };
    fullLbl.appendChild(fullCb);
    fullLbl.appendChild(document.createTextNode(`Only when all ${totalN > 0 ? totalN : '?'} active`));
    alertRow.appendChild(fullLbl);

    const delBtn = document.createElement('button');
    delBtn.title = 'Remove from tracking';
    delBtn.style.cssText = `margin-left:auto;background:#2a1010;color:#c96;border:1px solid #5a2a2a;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;`;
    delBtn.textContent = '✕ Remove';
    delBtn.onmouseover = () => { delBtn.style.background = '#3a1515'; };
    delBtn.onmouseout  = () => { delBtn.style.background = '#2a1010'; };
    delBtn.onclick = e => { e.stopPropagation(); showConfirm(delBtn, 'Remove from tracking?', () => removeFromTracking(id)); };
    alertRow.appendChild(delBtn);

    row.appendChild(alertRow);
    _attachTrackDrag(row, id, 'res', v.zone);
    return row;
  }

  function renderTrackedMobRow(id, v) {
    const aliveN = v.nodes.filter(n => n.alive).length, totalN = v.nodes.length;
    const isLive = _seenZones.has(v.zone);

    const row = document.createElement('div');
    row.style.cssText = `padding:7px 10px 6px;border-bottom:1px solid #1a1a24;display:flex;flex-direction:column;gap:5px;${!isLive ? 'opacity:0.5;' : ''}background:#0c0d14;`;

    // ── Top line: icon + name + status badge ────────────────────────────────
    const top = document.createElement('div');
    top.style.cssText = `display:flex;align-items:center;gap:7px;`;

    const iconEl = document.createElement('span');
    iconEl.style.cssText = `font-size:16px;line-height:1;flex-shrink:0;`;
    iconEl.textContent = '👾';
    top.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.style.cssText = `color:#e0e0e0;flex:1;font-weight:bold;font-size:13px;letter-spacing:0.01em;`;
    nameEl.innerHTML = formatDisplayName(v.statsKey) + (isLive && totalN > 0 ? ` <span style="font-weight:normal;font-size:11px;">${aliveN}/${totalN}</span>` : '');
    top.appendChild(nameEl);

    // Status: waiting badge only
    if (!isLive) {
      const wait = document.createElement('span');
      wait.style.cssText = `font-size:11px;color:#555;background:#111;border:1px solid #222;border-radius:4px;padding:2px 6px;`;
      wait.title = 'Waiting for zone visit to get live data';
      wait.textContent = '⏳ Not visited yet';
      top.appendChild(wait);
    }

    row.appendChild(top);

    // ── Spawn dots + soonest respawn timer ──────────────────────────────────
    if (isLive && totalN > 0) {
      const wrap = document.createElement('div');
      wrap.style.cssText = `padding-left:23px;display:flex;flex-direction:column;gap:4px;`;

      const bar = document.createElement('div');
      bar.style.cssText = `display:flex;align-items:center;gap:2px;flex-wrap:wrap;max-width:145px;`;

      const _mobReadyKey = n => {
        if (n.alive) return 0;
        let rt = enemyRespawnTimers.get(n.id) || null;
        if (!rt && n.pos) {
          const pk = _mobPosKey(v.zone, v.statsKey, n.pos);
          const st = _stableMobTimers[pk];
          if (st && st > Date.now()) rt = st;
        }
        if (!rt || rt <= Date.now()) return 1;
        return rt;
      };
      v.nodes.slice().sort((a, b) => _mobReadyKey(a) - _mobReadyKey(b)).forEach(n => {
        const dot = document.createElement('span');
        let rt = !n.alive ? (enemyRespawnTimers.get(n.id) || null) : null;
        if (!rt && !n.alive && n.pos) {
          const pk = _mobPosKey(v.zone, v.statsKey, n.pos);
          const st = _stableMobTimers[pk];
          if (st && st > Date.now()) rt = st;
        }
        const mins = rt ? fmtMs(rt) : null;
        dot.title = `Spawn at x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
          + (mins !== null ? `\nRespawns in ${mins}` : n.alive ? '\nAlive' : '\nDead (timer unknown)');
        dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:3px;cursor:default;background:${n.alive ? '#2a5e2a' : '#2a2a2a'};border:1px solid ${n.alive ? '#4caf50' : '#3a3a3a'};`;
        bar.appendChild(dot);
      });
      wrap.appendChild(bar);

      const soonestMob = v.nodes
        .filter(n => !n.alive && n.id)
        .map(n => {
          let ms = enemyRespawnTimers.get(n.id);
          if (!ms && n.pos) { const pk = _mobPosKey(v.zone, v.statsKey, n.pos); const st = _stableMobTimers[pk]; if (st && st > Date.now()) ms = st; }
          return ms;
        })
        .filter(ms => ms && ms > Date.now())
        .sort((a, b) => a - b)[0];

      if (soonestMob) {
        const timerEl = document.createElement('span');
        timerEl.style.cssText = `font-size:12px;color:${timerColor(soonestMob)};font-family:monospace;font-variant-numeric:tabular-nums;background:#111;border:1px solid #222;border-radius:4px;padding:1px 6px;`;
        timerEl.title = 'Next respawn in';
        timerEl.innerHTML = `⏱ ${fmtMs(soonestMob)}`;
        wrap.appendChild(timerEl);
      }

      row.appendChild(wrap);
    }

    // ── Alert toggle row ─────────────────────────────────────────────────────
    const alertRow = document.createElement('div');
    alertRow.style.cssText = `display:flex;align-items:center;gap:6px;padding-left:23px;`;

    const notifyLbl = document.createElement('label');
    notifyLbl.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:5px;font-size:11px;color:#888;user-select:none;`;
    const notifyCb = document.createElement('input');
    notifyCb.type = 'checkbox'; notifyCb.checked = v.notifyOnSpawn; notifyCb.style.cssText = `cursor:pointer;accent-color:#ff9800;`;
    notifyCb.onchange = e => { v.notifyOnSpawn = e.target.checked; saveTracked(); };
    notifyLbl.appendChild(notifyCb);
    notifyLbl.appendChild(document.createTextNode('Alert on respawn'));
    alertRow.appendChild(notifyLbl);

    // "Only when all alive" toggle - inline text toggle
    const fullLbl = document.createElement('label');
    fullLbl.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:5px;font-size:11px;color:#666;user-select:none;margin-left:10px;`;
    const fullCb = document.createElement('input');
    fullCb.type = 'checkbox'; fullCb.checked = v.notifyOnlyWhenFull === true; fullCb.style.cssText = `cursor:pointer;accent-color:#ff9800;`;
    fullCb.onchange = e => { v.notifyOnlyWhenFull = e.target.checked; saveTracked(); };
    fullLbl.appendChild(fullCb);
    fullLbl.appendChild(document.createTextNode(`Only when all ${totalN > 0 ? totalN : '?'} alive`));
    alertRow.appendChild(fullLbl);

    // Remove button - right side
    const delBtn = document.createElement('button');
    delBtn.title = 'Remove from tracking';
    delBtn.style.cssText = `margin-left:auto;background:#2a1010;color:#c96;border:1px solid #5a2a2a;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;`;
    delBtn.textContent = '✕ Remove';
    delBtn.onmouseover = () => { delBtn.style.background = '#3a1515'; };
    delBtn.onmouseout  = () => { delBtn.style.background = '#2a1010'; };
    delBtn.onclick = e => { e.stopPropagation(); showConfirm(delBtn, 'Remove from tracking?', () => removeMobFromTracking(id)); };
    alertRow.appendChild(delBtn);

    row.appendChild(alertRow);
    _attachTrackDrag(row, id, 'mob', v.zone);
    return row;
  }

  // Same as renderTrackedMobRow but merges multiple entries (same statsKey,
  // different real zones — e.g. Mines + MinesLower) into a single row.
  function renderTrackedMobGroupRow(entries) {
    const v0 = entries[0][1];
    const combined = [];
    entries.forEach(([, v]) => v.nodes.forEach(n => combined.push({ n, v })));
    const aliveN = combined.filter(o => o.n.alive).length, totalN = combined.length;
    const isLive = entries.some(([, v]) => _seenZones.has(v.zone));

    const row = document.createElement('div');
    row.style.cssText = `padding:7px 10px 6px;border-bottom:1px solid #1a1a24;display:flex;flex-direction:column;gap:5px;${!isLive ? 'opacity:0.5;' : ''}background:#0c0d14;`;

    const top = document.createElement('div');
    top.style.cssText = `display:flex;align-items:center;gap:7px;`;

    const iconEl = document.createElement('span');
    iconEl.style.cssText = `font-size:16px;line-height:1;flex-shrink:0;`;
    iconEl.textContent = '👾';
    top.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.style.cssText = `color:#e0e0e0;flex:1;font-weight:bold;font-size:13px;letter-spacing:0.01em;`;
    nameEl.innerHTML = formatDisplayName(v0.statsKey) + (isLive && totalN > 0 ? ` <span style="font-weight:normal;font-size:11px;">${aliveN}/${totalN}</span>` : '');
    top.appendChild(nameEl);

    if (!isLive) {
      const wait = document.createElement('span');
      wait.style.cssText = `font-size:11px;color:#555;background:#111;border:1px solid #222;border-radius:4px;padding:2px 6px;`;
      wait.title = 'Waiting for zone visit to get live data';
      wait.textContent = '⏳ Not visited yet';
      top.appendChild(wait);
    }

    row.appendChild(top);

    if (isLive && totalN > 0) {
      const wrap = document.createElement('div');
      wrap.style.cssText = `padding-left:23px;display:flex;flex-direction:column;gap:4px;`;

      const bar = document.createElement('div');
      bar.style.cssText = `display:flex;align-items:center;gap:2px;flex-wrap:wrap;max-width:145px;`;

      const _mobReadyKeyG = ({ n, v }) => {
        if (n.alive) return 0;
        let rt = enemyRespawnTimers.get(n.id) || null;
        if (!rt && n.pos) {
          const pk = _mobPosKey(v.zone, v.statsKey, n.pos);
          const st = _stableMobTimers[pk];
          if (st && st > Date.now()) rt = st;
        }
        if (!rt || rt <= Date.now()) return 1;
        return rt;
      };
      combined.slice().sort((a, b) => _mobReadyKeyG(a) - _mobReadyKeyG(b)).forEach(({ n, v }) => {
        const dot = document.createElement('span');
        let rt = !n.alive ? (enemyRespawnTimers.get(n.id) || null) : null;
        if (!rt && !n.alive && n.pos) {
          const pk = _mobPosKey(v.zone, v.statsKey, n.pos);
          const st = _stableMobTimers[pk];
          if (st && st > Date.now()) rt = st;
        }
        const mins = rt ? fmtMs(rt) : null;
        dot.title = `Spawn at x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
          + (mins !== null ? `\nRespawns in ${mins}` : n.alive ? '\nAlive' : '\nDead (timer unknown)');
        dot.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:3px;cursor:default;background:${n.alive ? '#2a5e2a' : '#2a2a2a'};border:1px solid ${n.alive ? '#4caf50' : '#3a3a3a'};`;
        bar.appendChild(dot);
      });
      wrap.appendChild(bar);

      const soonestMob = combined
        .filter(o => !o.n.alive && o.n.id)
        .map(({ n, v }) => {
          let ms = enemyRespawnTimers.get(n.id);
          if (!ms && n.pos) { const pk = _mobPosKey(v.zone, v.statsKey, n.pos); const st = _stableMobTimers[pk]; if (st && st > Date.now()) ms = st; }
          return ms;
        })
        .filter(ms => ms && ms > Date.now())
        .sort((a, b) => a - b)[0];

      if (soonestMob) {
        const timerEl = document.createElement('span');
        timerEl.style.cssText = `font-size:12px;color:${timerColor(soonestMob)};font-family:monospace;font-variant-numeric:tabular-nums;background:#111;border:1px solid #222;border-radius:4px;padding:1px 6px;`;
        timerEl.title = 'Next respawn in';
        timerEl.innerHTML = `⏱ ${fmtMs(soonestMob)}`;
        wrap.appendChild(timerEl);
      }

      row.appendChild(wrap);
    }

    const alertRow = document.createElement('div');
    alertRow.style.cssText = `display:flex;align-items:center;gap:6px;padding-left:23px;`;

    const notifyLbl = document.createElement('label');
    notifyLbl.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:5px;font-size:11px;color:#888;user-select:none;`;
    const notifyCb = document.createElement('input');
    notifyCb.type = 'checkbox'; notifyCb.checked = entries.every(([, v]) => v.notifyOnSpawn); notifyCb.style.cssText = `cursor:pointer;accent-color:#ff9800;`;
    notifyCb.onchange = e => { entries.forEach(([, v]) => { v.notifyOnSpawn = e.target.checked; }); saveTracked(); };
    notifyLbl.appendChild(notifyCb);
    notifyLbl.appendChild(document.createTextNode('Alert on respawn'));
    alertRow.appendChild(notifyLbl);

    const fullLbl = document.createElement('label');
    fullLbl.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:5px;font-size:11px;color:#666;user-select:none;margin-left:10px;`;
    const fullCb = document.createElement('input');
    fullCb.type = 'checkbox'; fullCb.checked = entries.every(([, v]) => v.notifyOnlyWhenFull === true); fullCb.style.cssText = `cursor:pointer;accent-color:#ff9800;`;
    fullCb.onchange = e => { entries.forEach(([, v]) => { v.notifyOnlyWhenFull = e.target.checked; }); saveTracked(); };
    fullLbl.appendChild(fullCb);
    fullLbl.appendChild(document.createTextNode(`Only when all ${totalN > 0 ? totalN : '?'} alive`));
    alertRow.appendChild(fullLbl);

    const delBtn = document.createElement('button');
    delBtn.title = 'Remove from tracking';
    delBtn.style.cssText = `margin-left:auto;background:#2a1010;color:#c96;border:1px solid #5a2a2a;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;`;
    delBtn.textContent = '✕ Remove';
    delBtn.onmouseover = () => { delBtn.style.background = '#3a1515'; };
    delBtn.onmouseout  = () => { delBtn.style.background = '#2a1010'; };
    delBtn.onclick = e => {
      e.stopPropagation();
      showConfirm(delBtn, 'Remove from tracking?', () => entries.forEach(([id]) => removeMobFromTracking(id)));
    };
    alertRow.appendChild(delBtn);

    row.appendChild(alertRow);
    return row;
  }

  // Renders only the user-selected slots / in-hand item, nothing else (no bag, no log, no dur slider).
  // ─── Compact Durability view: stable name-column width ───────────────────────
  // The floating panel in compact mode auto-sizes its width to its content
  // (see makeFloatingPanel: startW is null for tabKey==='qb' && !_qbFullOpen).
  // With the item-name span set to flex:1, the panel's shrink-to-fit width was
  // being recomputed from whichever weapon/name happened to be shown — so the
  // whole window (and the durability numbers pinned to its right edge) visibly
  // resized/jumped every time the equipped weapon or a quickbar slot changed.
  // Fix: measure the longest name label across every item the player owns
  // (not just what's currently displayed) and give the name column a fixed
  // width based on that, so the row width — and therefore the durability
  // column's position — no longer depends on which item is currently shown.
  // The remembered max only grows (never shrinks) within a session, so it
  // won't jump back down if a long-named item briefly leaves the quickbar.
  // NOTE: these must be `var`, not `let`/`const`. This code runs inside one big
  // top-to-bottom IIFE, and the floating-panel restore logic earlier in the file
  // can call popOutTab('qb') -> ... -> _qbMeasureTextWidth() *before* execution
  // reaches this line. `let`/`const` would still be in the temporal dead zone at
  // that point (hoisted but uninitialized), causing:
  //   ReferenceError: Cannot access '_qbNameMeasureCanvas' before initialization
  // `var` is hoisted AND initialized (to undefined) before any code in this
  // scope runs, so early calls no longer throw.
  function _qbMeasureTextWidth(text) {
    if (!_qbNameMeasureCanvas) _qbNameMeasureCanvas = document.createElement('canvas');
    const ctx = _qbNameMeasureCanvas.getContext('2d');
    ctx.font = QB_NAME_COL_FONT;
    return ctx.measureText(text).width;
  }

  // Scans every item currently in the player's inventory (equipped or not)
  // and updates the remembered max name-column width if a longer label shows up.
  function updateQBCompactNameColWidth() {
    let grew = false;
    for (const instanceId in _inventoryByInstance) {
      const itemData = _inventoryByInstance[instanceId];
      if (!itemData || !itemData.itemId) continue;
      let label = formatItemId(itemData.itemId);
      if (itemData.Level > 0) label += ` Lv${itemData.Level}`;
      const w = _qbMeasureTextWidth(label);
      if (w > _qbCompactNameColWidth) { _qbCompactNameColWidth = w; grew = true; }
    }
    if (grew) {
      try { localStorage.setItem('roeQBCompactNameColWidth', String(_qbCompactNameColWidth)); } catch (_) {}
    }
    return _qbCompactNameColWidth + QB_NAME_COL_BUFFER;
  }

  function renderQBPaneCompactContent(_fp_qb) {
    const _qbNameColW = updateQBCompactNameColWidth();
    if (_qbCompactShowHand && _equippedWeaponInstanceId) {
      const eqData = _inventoryByInstance[_equippedWeaponInstanceId];
      const inHand = document.createElement('div');
      const eqName = eqData ? formatItemId(eqData.itemId) : _equippedWeaponInstanceId;
      const eqLv   = eqData && eqData.Level > 0 ? ` Lv${eqData.Level}` : '';
      const eqDur  = eqData && eqData.MaxDurability > 0
        ? ` <span style="color:${eqData.Durability/eqData.MaxDurability > 0.5 ? '#6b9' : eqData.Durability/eqData.MaxDurability > 0.25 ? '#ca6' : '#e55'}">${Math.ceil(eqData.Durability/5)}/${Math.ceil(eqData.MaxDurability/5)}</span>`
        : '';
      inHand.style.cssText = `margin:0 6px 3px 6px;padding:2px 4px;border-radius:3px;border:1px solid #e8c84a;background:#1a1600;font-size:11px;`;
      inHand.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
          <span style="color:#e8c84a;flex-shrink:0;font-size:13px;line-height:1;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;">✋</span>
          <div style="display:flex;flex-direction:column;min-width:0;width:${_qbNameColW}px;flex:0 0 auto;overflow:hidden;">
            <span style="color:#f0d060;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;">${eqName}${eqLv}</span>
            ${_showInvId ? `<span style="font-size:11px;color:#ccc;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_equippedWeaponInstanceId}</span>` : ''}
          </div>
          ${eqDur ? `<span style="flex-shrink:0;min-width:32px;text-align:right;white-space:nowrap;">${eqDur}</span>` : ''}
        </div>
      `;
      inHand.title = _equippedWeaponInstanceId;
      _fp_qb.appendChild(inHand);
    }

    if (_qbCompactSlots.size > 0) {
      const grid = document.createElement('div');
      grid.style.cssText = `display:flex;flex-direction:column;gap:1px;padding:0 6px 3px;`;

      const orderedSlots = [..._qbCompactSlots].sort((a, b) => a - b);
      for (const i of orderedSlots) {
        const slotLabel = i === 9 ? 0 : i + 1;
        const refInstance = _quickbarRefs.get(i);
        const itemData = refInstance ? _inventoryByInstance[refInstance] : null;
        const itemId   = itemData ? itemData.itemId : null;
        const isTool   = itemId ? isToolItem(itemId) : false;
        const isActive = refInstance != null && refInstance === _equippedWeaponInstanceId;

        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:5px;padding:2px 4px;border-radius:3px;border:1px solid ${isActive ? '#e8c84a' : itemId ? (isTool ? '#1e3020' : '#1e2030') : '#151520'};background:${isActive ? '#1a1600' : itemId ? (isTool ? '#0e1a0e' : '#0d0e1a') : 'transparent'};`;
        if (refInstance) row.title = refInstance;

        const badge = document.createElement('span');
        badge.style.cssText = `min-width:16px;height:16px;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:bold;flex-shrink:0;background:${isActive ? '#3a2e00' : itemId ? (isTool ? '#1e3a1e' : '#1a1e3a') : '#111'};color:${isActive ? '#e8c84a' : itemId ? (isTool ? '#5dba6e' : '#6b8cff') : '#333'};border:1px solid ${isActive ? '#c8a430' : itemId ? (isTool ? '#3d8a4e' : '#3a4ea0') : '#222'};`;
        badge.textContent = slotLabel;
        const invInstance = _quickBarInstancesFromInv[i] ?? null;
        if (_inventoryReady && refInstance && invInstance !== refInstance) {
          const invItemId = invInstance ? ((_inventoryByInstance[invInstance] || {}).itemId ?? '?') : 'empty';
          badge.title = `qs=${itemId ?? '?'} ≠ inv=${invItemId}`;
          badge.style.border = '1px solid #ff8844';
          badge.style.color = '#ff8844';
          badge.style.background = '#2a1000';
        }
        row.appendChild(badge);

        if (itemId) {
          const nameWrap = document.createElement('div');
          nameWrap.style.cssText = `display:flex;flex-direction:column;width:${_qbNameColW}px;flex:0 0 auto;min-width:0;overflow:hidden;`;
          const nameEl = document.createElement('span');
          nameEl.style.cssText = `font-size:13px;color:${isActive ? '#f0d060' : isTool ? '#9de6ab' : '#aabeff'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
          nameEl.textContent = formatItemId(itemId) + (isActive ? ' ✋' : '') + (itemData.Level > 0 ? ` Lv${itemData.Level}` : '');
          nameWrap.appendChild(nameEl);
          const refEl = document.createElement('span');
          refEl.style.cssText = `font-size:9px;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;`;
          refEl.textContent = refInstance;
          if (_showInvId) nameWrap.appendChild(refEl);
          row.appendChild(nameWrap);
          if (itemData.MaxDurability > 0) {
            const pct = itemData.Durability / itemData.MaxDurability;
            const meta = document.createElement('span');
            meta.style.cssText = `flex-shrink:0;font-size:12px;color:${pct > 0.5 ? '#6b9' : pct > 0.25 ? '#ca6' : '#e55'};`;
            meta.textContent = `${Math.ceil(itemData.Durability/5)}/${Math.ceil(itemData.MaxDurability/5)}`;
            row.appendChild(meta);
          } else if (itemData.Quantity > 1) {
            const meta = document.createElement('span');
            meta.style.cssText = `flex-shrink:0;font-size:12px;color:#888;`;
            meta.textContent = `x${itemData.Quantity}`;
            row.appendChild(meta);
          }
        } else {
          const emptyEl = document.createElement('span');
          emptyEl.style.cssText = `font-size:13px;color:#2a2a3a;flex:1;`;
          emptyEl.textContent = '—';
          row.appendChild(emptyEl);
        }

        grid.appendChild(row);
      }

      _fp_qb.appendChild(grid);
    } else if (!_qbCompactShowHand) {
      // Empty state should only show when the user hasn't opted to show the
      // hand slot at all AND has no quickbar slots selected. Previously this
      // checked `!(_qbCompactShowHand && _equippedWeaponInstanceId)`, which
      // also fired whenever the hand slot was temporarily empty (e.g. right
      // after dropping/unequipping the in-hand item) even though the hand
      // toggle itself was still on — showing a misleading "Nothing selected"
      // message.
      const empty = document.createElement('div');
      const _qbEmptyRowW1 = 12 + 2 + 8 + 16 + 4 + _qbNameColW + 32;
      empty.style.cssText = `color:#444;padding:10px 12px;text-align:center;font-size:11px;min-width:${_qbEmptyRowW1}px;box-sizing:border-box;`;
      empty.textContent = 'Nothing selected — click ⚙️ in the title bar to choose slots';
      _fp_qb.appendChild(empty);
    } else if (_qbCompactShowHand && !_inventoryReady) {
      const empty = document.createElement('div');
      const _qbEmptyRowW2 = 12 + 2 + 8 + 16 + 4 + _qbNameColW + 32;
      empty.style.cssText = `color:#444;padding:10px 12px;text-align:center;font-size:11px;min-width:${_qbEmptyRowW2}px;box-sizing:border-box;`;
      empty.textContent = 'Loading...';
      _fp_qb.appendChild(empty);
    } else if (_qbCompactShowHand && !_equippedWeaponInstanceId) {
      // Hand toggle is on and inventory is ready, but nothing is currently
      // equipped (e.g. just dropped/unequipped) and no quickbar slots are
      // selected either — show a message reflecting that, instead of the
      // "Nothing selected" (settings) message or a silently blank panel.
      //
      // This message is much shorter than a typical item name, and unlike
      // the item rows above it wasn't reserving any width for itself — so
      // showing it let the panel's shrink-to-fit width collapse down to
      // just this text, undoing the whole point of _qbNameColW (keeping the
      // panel stable-width based on the longest item name the player owns,
      // even for items not currently displayed). Reserve the exact same
      // total box width as the real in-hand row above (margin + border +
      // padding + icon + gap + name column + durability column) — using
      // min-width alone on a bare div doesn't add up to the same rendered
      // width as that row's fuller box model (border, padding, margins all
      // stack on top of content width), so the panel still narrowed by a
      // few px even after reserving just the name-column width.
      const empty = document.createElement('div');
      const _qbEmptyRowW = 12 /* inHand margin 6+6 */ + 2 /* border 1+1 */ + 8 /* padding 4+4 */
        + 16 /* icon */ + 4 /* gap */ + _qbNameColW + 32 /* durability col */;
      empty.style.cssText = `color:#444;padding:10px 12px;text-align:center;font-size:11px;min-width:${_qbEmptyRowW}px;box-sizing:border-box;`;
      empty.textContent = 'Nothing in hand right now';
      _fp_qb.appendChild(empty);
    }

    // Explicitly (re)fit the panel's width to its content instead of relying
    // on `width:auto` CSS shrink-to-fit. That native auto-sizing only runs
    // once at the layout pass where the box first gets its width — the
    // scrollable content container has overflow-x:hidden (see
    // makeFloatingPanel's contentDiv, and #roeContent's shared scrollbar
    // rule), so once a panel settles at some width, wider content added on
    // a *later* render (e.g. _qbNameColW growing after spotting a longer
    // item name once more of the inventory has loaded in, or an
    // empty-state message replacing a wide item row) just gets clipped
    // instead of the panel ever growing to fit it again. This affects both
    // the floating QB panel and the docked main panel identically — both
    // use width:auto over an overflow-x:hidden content area — so fit
    // whichever one is actually showing this content right now.
    //
    // Skip this fit entirely until _inventoryReady — the very first render
    // after a page load/reload can fire before any inventory data (from the
    // localStorage snapshot restore or the live sync event) has actually
    // landed, so _qbNameColW is still 0/too-small at that point. Fitting to
    // that would commit the panel to a too-narrow width for one frame, then
    // visibly grow once the real item names arrive a moment later. Waiting
    // for _inventoryReady means the very first fit the user sees is already
    // the correct, final width.
    if (_inventoryReady) {
      const _qbFp = _floatPanels['qb'];
      const isDocked = _fp_qb === qbPane && !_qbFp;
      const target = isDocked ? panel : (!_qbFullOpen ? _qbFp : null);
      if (target) {
        // Measure the natural content width without first releasing the
        // panel's fixed width to 'auto'. Temporarily switching to
        // width:auto forces a reflow at the smaller natural width, then
        // another reflow back to the fixed px value — even when the two
        // are equal, that's a visible one-frame narrow/wide flicker on
        // every render (inventory update, hit, equip change, etc., which
        // happen very frequently). Cloning the content off-screen to
        // measure its intrinsic width avoids touching the visible panel's
        // layout at all unless the width actually needs to change.
        const probe = _fp_qb.cloneNode(true);
        probe.style.cssText = 'position:fixed;visibility:hidden;left:-9999px;top:-9999px;width:auto;height:auto;';
        document.body.appendChild(probe);
        const neededW = probe.scrollWidth;
        probe.remove();
        if (neededW > 0) {
          const curW = target.style.width ? parseInt(target.style.width) : 0;
          if (curW !== neededW) target.style.width = neededW + 'px';
        }
      }
    }
  }

  function renderQBPane() {
    const _fp_qb = _paneFor('qb', qbPane);
    if (!_fp_qb) return;
    if (_fp_qb === qbPane && _poppedOut.has('qb')) return;
    _fp_qb.style.paddingTop = '4px';

    // ─ Settings (shown at top of the full Durability view, opened via ⚙️ in the title bar) ─
    if (_qbFullOpen) {
      const settingsBox = document.createElement('div');
      settingsBox.style.cssText = `margin:0 6px 4px 6px;padding:6px 7px;background:#0d0d16;border:1px solid #23233a;border-radius:4px;display:flex;flex-direction:column;gap:6px;`;

      const hint = document.createElement('div');
      hint.style.cssText = `color:#555;font-size:10px;`;
      hint.textContent = 'Show only selected slots in compact view:';
      settingsBox.appendChild(hint);

      const handLbl = document.createElement('label');
      handLbl.style.cssText = `display:flex;align-items:center;gap:5px;cursor:pointer;color:#e8c84a;font-size:11px;user-select:none;`;
      const handCb = document.createElement('input');
      handCb.type = 'checkbox';
      handCb.checked = _qbCompactShowHand;
      handCb.style.cssText = `cursor:pointer;accent-color:#e8c84a;`;
      handCb.onchange = () => {
        _qbCompactShowHand = handCb.checked;
        localStorage.setItem('roe_qbCompactShowHand', String(_qbCompactShowHand));
        renderQBPane();
      };
      handLbl.appendChild(handCb);
      handLbl.appendChild(document.createTextNode('✋ In-hand item'));
      settingsBox.appendChild(handLbl);

      const slotsGrid = document.createElement('div');
      slotsGrid.style.cssText = `display:flex;flex-wrap:wrap;gap:5px;`;
      for (let i = 0; i < 10; i++) {
        const slotLabel = i === 9 ? 0 : i + 1;
        const lbl = document.createElement('label');
        lbl.style.cssText = `display:flex;align-items:center;gap:3px;cursor:pointer;color:#aabeff;font-size:11px;user-select:none;`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = _qbCompactSlots.has(i);
        cb.style.cssText = `cursor:pointer;accent-color:#7b8fff;`;
        cb.onchange = () => {
          if (cb.checked) _qbCompactSlots.add(i); else _qbCompactSlots.delete(i);
          _saveQBCompactSlots();
          renderQBPane();
        };
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(`Slot ${slotLabel}`));
        slotsGrid.appendChild(lbl);
      }
      settingsBox.appendChild(slotsGrid);
      _fp_qb.appendChild(settingsBox);
    }

    if (!_qbFullOpen) {
      renderQBPaneCompactContent(_fp_qb);
      return;
    }


    // ─ In-hand weapon (only when we have an actual instance id) ─
    if (_equippedWeaponInstanceId) {
      const eqData = _inventoryByInstance[_equippedWeaponInstanceId];
      const inHand = document.createElement('div');
      inHand.style.cssText = `margin:2px 6px;padding:2px 6px;border-radius:3px;border:1px solid #e8c84a;background:#1a1600;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
      const eqName = eqData ? formatItemId(eqData.itemId) : _equippedWeaponInstanceId;
      const eqLv   = eqData && eqData.Level > 0 ? ` Lv${eqData.Level}` : '';
      const eqDur  = eqData && eqData.MaxDurability > 0
        ? ` <span style="color:${eqData.Durability/eqData.MaxDurability > 0.5 ? '#6b9' : eqData.Durability/eqData.MaxDurability > 0.25 ? '#ca6' : '#e55'}">${Math.ceil(eqData.Durability/5)}/${Math.ceil(eqData.MaxDurability/5)}</span>`
        : '';
      inHand.style.cssText = `margin:0 6px 1px 6px;padding:2px 4px;border-radius:3px;border:1px solid #e8c84a;background:#1a1600;font-size:11px;`;
      inHand.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
          <span style="color:#e8c84a;flex-shrink:0;font-size:13px;line-height:1;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;">✋</span>
          <div style="display:flex;flex-direction:column;min-width:0;flex:1;overflow:hidden;">
            <span style="color:#f0d060;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;">${eqName}${eqLv}</span>
            ${_showInvId ? `<span style="font-size:11px;color:#ccc;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_equippedWeaponInstanceId}</span>` : ''}
          </div>
          ${eqDur ? `<span style="flex-shrink:0;min-width:32px;text-align:right;white-space:nowrap;">${eqDur}</span>` : ''}
        </div>
      `;
      inHand.title = _equippedWeaponInstanceId;
      _fp_qb.appendChild(inHand);
    }

    // ─ Slots grid ─
    const grid = document.createElement('div');
    grid.style.cssText = `display:flex;flex-direction:column;gap:1px;padding:3px 6px;`;

    for (let i = 0; i < 10; i++) {
      const slotLabel = i === 9 ? 0 : i + 1;
      const refInstance = _quickbarRefs.get(i);
      const itemData = refInstance ? _inventoryByInstance[refInstance] : null;
      const itemId   = itemData ? itemData.itemId : null;
      const isTool   = itemId ? isToolItem(itemId) : false;
      const isActive = refInstance != null && refInstance === _equippedWeaponInstanceId;

      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:5px;padding:2px 4px;border-radius:3px;border:1px solid ${isActive ? '#e8c84a' : itemId ? (isTool ? '#1e3020' : '#1e2030') : '#151520'};background:${isActive ? '#1a1600' : itemId ? (isTool ? '#0e1a0e' : '#0d0e1a') : 'transparent'};`;
      if (refInstance) row.title = refInstance;

      const badge = document.createElement('span');
      badge.style.cssText = `min-width:16px;height:16px;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:bold;flex-shrink:0;background:${isActive ? '#3a2e00' : itemId ? (isTool ? '#1e3a1e' : '#1a1e3a') : '#111'};color:${isActive ? '#e8c84a' : itemId ? (isTool ? '#5dba6e' : '#6b8cff') : '#333'};border:1px solid ${isActive ? '#c8a430' : itemId ? (isTool ? '#3d8a4e' : '#3a4ea0') : '#222'};`;
      badge.textContent = slotLabel;
      // Show desync indicator under badge number
      const invInstance = _quickBarInstancesFromInv[i] ?? null;
      if (_inventoryReady && refInstance && invInstance !== refInstance) {
        const invItemId = invInstance ? ((_inventoryByInstance[invInstance] || {}).itemId ?? '?') : 'empty';
        badge.title = `qs=${itemId ?? '?'} ≠ inv=${invItemId}`;
        badge.style.border = '1px solid #ff8844';
        badge.style.color = '#ff8844';
        badge.style.background = '#2a1000';
      }
      row.appendChild(badge);

      if (itemId) {
        const nameWrap = document.createElement('div');
        nameWrap.style.cssText = `display:flex;flex-direction:column;flex:1;min-width:0;overflow:hidden;`;
        const nameEl = document.createElement('span');
        nameEl.style.cssText = `font-size:13px;color:${isActive ? '#f0d060' : isTool ? '#9de6ab' : '#aabeff'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
        nameEl.textContent = formatItemId(itemId) + (isActive ? ' ✋' : '') + (itemData.Level > 0 ? ` Lv${itemData.Level}` : '');
        nameWrap.appendChild(nameEl);
        const refEl = document.createElement('span');
        refEl.style.cssText = `font-size:9px;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;`;
        refEl.textContent = refInstance;
        if (_showInvId) nameWrap.appendChild(refEl);
        row.appendChild(nameWrap);
        if (itemData.MaxDurability > 0) {
          const pct = itemData.Durability / itemData.MaxDurability;
          const meta = document.createElement('span');
          meta.style.cssText = `flex-shrink:0;font-size:12px;color:${pct > 0.5 ? '#6b9' : pct > 0.25 ? '#ca6' : '#e55'};`;
          meta.textContent = `${Math.ceil(itemData.Durability/5)}/${Math.ceil(itemData.MaxDurability/5)}`;
          row.appendChild(meta);
        } else if (itemData.Quantity > 1) {
          const meta = document.createElement('span');
          meta.style.cssText = `flex-shrink:0;font-size:12px;color:#888;`;
          meta.textContent = `x${itemData.Quantity}`;
          row.appendChild(meta);
        }
      } else {
        const emptyEl = document.createElement('span');
        emptyEl.style.cssText = `font-size:13px;color:#2a2a3a;flex:1;`;
        emptyEl.textContent = '—';
        row.appendChild(emptyEl);
      }

      grid.appendChild(row);
    }

    _fp_qb.appendChild(grid);

    // ─ Missing tools warning ─
    const missing = getToolsNotInQuickbar();
    if (missing.length > 0) {
      const warn = document.createElement('div');
      warn.style.cssText = `margin:2px 6px;padding:2px 6px;background:#1a0e0e;border:1px solid #5a2a2a;border-radius:3px;font-size:11px;color:#ff8888;`;
      const counts = {};
      missing.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
      const parts = Object.entries(counts).map(([id, n]) => n > 1 ? `${formatItemId(id)} x${n}` : formatItemId(id));
      warn.textContent = '⚠️ not in QB: ' + parts.join(', ');
      _fp_qb.appendChild(warn);
    }

    // ─ Bag inventory section ─
    {
      const bagSection = document.createElement('div');
      bagSection.style.cssText = `margin:4px 6px 2px 6px;`;

      const bagHdr = document.createElement('div');
      bagHdr.style.cssText = `display:flex;align-items:center;justify-content:space-between;font-size:10px;color:#6677aa;font-weight:bold;padding:3px 0 3px 0;border-top:1px solid #1a1a2a;letter-spacing:0.04em;`;
      const bagTitle = document.createElement('span');
      bagTitle.textContent = '🎒 BAG';
      const bagCount = document.createElement('span');
      bagCount.style.cssText = `color:#444;font-weight:normal;`;
      const allItems = Object.values(_inventoryByInstance);
      bagCount.textContent = `${allItems.length} items`;
      bagHdr.appendChild(bagTitle);
      bagHdr.appendChild(bagCount);
      bagSection.appendChild(bagHdr);

      // Only tools/weapons are shown here now; materials moved to the Chest tab
      const toolItems = allItems.filter(item => isToolItem(item.itemId));
      toolItems.sort((a, b) => a.itemId.localeCompare(b.itemId));

      function renderBagRow(item) {
        const isQB = Array.from(_quickbarRefs.values()).includes(item.instanceId);
        const isEq = item.instanceId === _equippedWeaponInstanceId;
        const isTool = isToolItem(item.itemId);
        const hasDur = item.MaxDurability > 0;

        let rowBg = 'transparent';
        let rowBorder = '#1a1a2a';
        let nameColor = '#aabeff';
        if (isEq)        { rowBg = '#1a1600'; rowBorder = '#e8c84a'; nameColor = '#f0d060'; }
        else if (isQB)   { rowBg = '#0e1a0e'; rowBorder = '#2d5a2d'; nameColor = '#9de6ab'; }
        else if (isTool) { rowBg = '#1a0e0e'; rowBorder = '#5a2d1a'; nameColor = '#ff9966'; }

        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:4px;padding:1px 4px;border-radius:3px;border:1px solid ${rowBorder};background:${rowBg};margin-bottom:1px;min-height:18px;`;
        if (item.instanceId) row.title = item.instanceId;

        // Status dot
        const dot = document.createElement('span');
        dot.style.cssText = `width:6px;height:6px;border-radius:50%;flex-shrink:0;background:${isEq ? '#e8c84a' : isQB ? '#5dba6e' : isTool ? '#e87744' : '#333'};`;
        row.appendChild(dot);

        // Name + ids
        const nameWrap = document.createElement('div');
        nameWrap.style.cssText = `display:flex;flex-direction:column;flex:1;min-width:0;overflow:hidden;`;
        const nameEl = document.createElement('span');
        nameEl.style.cssText = `font-size:12px;color:${nameColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
        let label = formatItemId(item.itemId);
        if (item.Level > 0) label += ` Lv${item.Level}`;
        if (isEq)  label += ' ✋';
        else if (isQB) label += ' ↑';
        nameEl.textContent = label;
        nameWrap.appendChild(nameEl);
        const itemIdEl = document.createElement('span');
        itemIdEl.style.cssText = `font-size:9px;color:#7b8fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;`;
        itemIdEl.textContent = item.itemId;
        nameWrap.appendChild(itemIdEl);
        if (item.instanceId) {
          const instEl = document.createElement('span');
          instEl.style.cssText = `font-size:9px;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;`;
          instEl.textContent = item.instanceId;
          nameWrap.appendChild(instEl);
        }
        row.appendChild(nameWrap);

        // Right side: durability or quantity
        if (hasDur) {
          const pct = item.Durability / item.MaxDurability;
          const col = pct > 0.5 ? '#6b9' : pct > 0.25 ? '#ca6' : '#e55';
          const meta = document.createElement('span');
          meta.style.cssText = `flex-shrink:0;font-size:11px;color:${col};`;
          meta.textContent = `${Math.ceil(item.Durability/5)}/${Math.ceil(item.MaxDurability/5)}`;
          row.appendChild(meta);
        } else if (item.Quantity > 1) {
          const meta = document.createElement('span');
          meta.style.cssText = `flex-shrink:0;font-size:11px;color:#667;`;
          meta.textContent = `×${item.Quantity.toLocaleString()}`;
          row.appendChild(meta);
        }

        return row;
      }

      if (toolItems.length > 0) {
        const toolHdr = document.createElement('div');
        toolHdr.style.cssText = `font-size:9px;color:#445566;padding:1px 0;letter-spacing:0.05em;`;
        toolHdr.textContent = 'TOOLS & WEAPONS';
        bagSection.appendChild(toolHdr);
        toolItems.forEach(item => bagSection.appendChild(renderBagRow(item)));
      }
      if (allItems.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = `font-size:11px;color:#333;padding:4px 0;`;
        empty.textContent = 'No items';
        bagSection.appendChild(empty);
      }

      _fp_qb.appendChild(bagSection);
    }

    // ─ Durability warning threshold (persistent element — not recreated on every render) ─
    {
      if (!_durSliderRow) {
        // Create once
        const durSliderStyle = document.createElement('style');
        durSliderStyle.textContent = `
          #roeDurSlider{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;background:#2a2a4a;outline:none;cursor:pointer;}
          #roeDurSlider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#f0c040;cursor:pointer;}
          #roeDurSlider::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#f0c040;border:none;cursor:pointer;}
        `;
        document.head.appendChild(durSliderStyle);
        _durSliderRow = document.createElement('div');
        _durSliderRow.style.cssText = `display:flex;flex-direction:column;gap:3px;padding:4px 8px;border-top:1px solid #1a1a2a;font-size:11px;color:#ccc;`;
        const durTopLine = document.createElement('div');
        durTopLine.style.cssText = `display:flex;align-items:center;justify-content:space-between;`;
        const durLabel = document.createElement('span');
        durLabel.textContent = '⚠️ Dur warn at:';
        durLabel.style.flexShrink = '0';
        // "show inv id" checkbox
        const invIdLbl = document.createElement('label');
        invIdLbl.style.cssText = `display:flex;align-items:center;gap:3px;cursor:pointer;color:#aaa;font-size:10px;margin-left:8px;`;
        const invIdCb = document.createElement('input');
        invIdCb.type = 'checkbox';
        invIdCb.id = 'roeShowInvIdCb';
        invIdCb.checked = _showInvId;
        invIdCb.onchange = () => {
          _showInvId = invIdCb.checked;
          localStorage.setItem('roe_showInvId', String(_showInvId));
          renderQBPane();
        };
        invIdLbl.appendChild(invIdCb);
        invIdLbl.appendChild(document.createTextNode('inv id'));
        const durLabelWrap = document.createElement('div');
        durLabelWrap.style.cssText = 'display:flex;align-items:center;flex-shrink:0;';
        durLabelWrap.appendChild(durLabel);
        durLabelWrap.appendChild(invIdLbl);
        const durVal = document.createElement('span');
        durVal.id = 'roeDurVal';
        durVal.style.cssText = `color:#f0c040;font-weight:bold;min-width:28px;text-align:right;`;
        durVal.textContent = `${_durWarnThreshold} hits`;
        durTopLine.appendChild(durLabelWrap);
        durTopLine.appendChild(durVal);
        const statusBadge = document.createElement('span');
        statusBadge.id = 'roeQBStatus';
        statusBadge.style.cssText = `font-size:10px;font-weight:bold;margin-left:6px;flex-shrink:0;`;
        if (!_inventoryReady || !_quickbarReady) { statusBadge.style.color = '#888'; statusBadge.textContent = '⏳'; }
        else { statusBadge.style.color = '#6b9'; statusBadge.textContent = '✓ sync'; }
        durTopLine.appendChild(statusBadge);
        const durInput = document.createElement('input');
        durInput.type = 'range';
        durInput.id = 'roeDurSlider';
        durInput.min = '1';
        durInput.max = '40';
        durInput.value = String(_durWarnThreshold);
        durInput.addEventListener('pointerdown', () => { _durSliderDragging = true; });
        durInput.addEventListener('pointerup',   () => { _durSliderDragging = false; });
        durInput.addEventListener('pointercancel',()=> { _durSliderDragging = false; });
        durInput.oninput = () => {
          const v = parseInt(durInput.value, 10);
          durVal.textContent = `${v} hits`;
          _durWarnThreshold = v;
          localStorage.setItem('roe_durWarnThreshold', String(v));
        };
        _durSliderRow.appendChild(durTopLine);
        _durSliderRow.appendChild(durInput);
        // keyword filter checkboxes
        const durFilterRow = document.createElement('div');
        durFilterRow.id = 'roeDurFilter';
        durFilterRow.style.cssText = `display:flex;gap:8px;flex-wrap:wrap;padding-top:3px;`;
        for (const kw of _DUR_WARN_KEYWORDS) {
          const lbl = document.createElement('label');
          lbl.style.cssText = `display:flex;align-items:center;gap:3px;cursor:pointer;color:#aaa;font-size:10px;`;
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = _durWarnKeywords.includes(kw);
          cb.onchange = () => {
            if (cb.checked) { if (!_durWarnKeywords.includes(kw)) _durWarnKeywords.push(kw); }
            else { _durWarnKeywords = _durWarnKeywords.filter(k => k !== kw); }
            localStorage.setItem('roe_durWarnKeywords', JSON.stringify(_durWarnKeywords));
          };
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(kw));
          durFilterRow.appendChild(lbl);
        }
        _durSliderRow.appendChild(durFilterRow);
      } else {
        // Already exists — just sync display value in case threshold changed externally
        const durVal = document.getElementById('roeDurVal');
        const durInput = document.getElementById('roeDurSlider');
        if (durVal) durVal.textContent = `${_durWarnThreshold} hits`;
        if (durInput) durInput.value = String(_durWarnThreshold);
        const invIdCbExisting = document.getElementById('roeShowInvIdCb');
        if (invIdCbExisting) invIdCbExisting.checked = _showInvId;
        const statusBadgeEx = document.getElementById('roeQBStatus');
        if (statusBadgeEx) {
          if (!_inventoryReady || !_quickbarReady) { statusBadgeEx.style.color = '#888'; statusBadgeEx.textContent = '⏳'; }
          else { statusBadgeEx.style.color = '#6b9'; statusBadgeEx.textContent = '✓ sync'; }
        }
        // Add filter checkboxes if missing (e.g. after script update)
        if (!_durSliderRow.querySelector('#roeDurFilter')) {
          const durFilterRow = document.createElement('div');
          durFilterRow.id = 'roeDurFilter';
          durFilterRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;padding-top:3px;';
          for (const kw of _DUR_WARN_KEYWORDS) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex;align-items:center;gap:3px;cursor:pointer;color:#aaa;font-size:10px;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = _durWarnKeywords.includes(kw);
            cb.onchange = () => {
              if (cb.checked) { if (!_durWarnKeywords.includes(kw)) _durWarnKeywords.push(kw); }
              else { _durWarnKeywords = _durWarnKeywords.filter(k => k !== kw); }
              localStorage.setItem('roe_durWarnKeywords', JSON.stringify(_durWarnKeywords));
            };
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(kw));
            durFilterRow.appendChild(lbl);
          }
          _durSliderRow.appendChild(durFilterRow);
        }
      }
      _fp_qb.appendChild(_durSliderRow);
    }

    // ─ Sync log ─
    {
      const logHdr = document.createElement('div');
      logHdr.style.cssText = `display:flex;align-items:center;justify-content:space-between;color:#7b8fff;font-size:11px;font-weight:bold;padding:3px 8px;border-top:1px solid #1a1a2a;border-bottom:1px solid #1a1a2a;margin-top:2px;`;

      const logTitle = document.createElement('span');
      logTitle.textContent = `Sync log (${_qbEventLog.length})`;

      const btnRow = document.createElement('div');
      btnRow.style.cssText = `display:flex;gap:3px;`;

      const copyBtn = document.createElement('button');
      copyBtn.textContent = '⎘';
      copyBtn.title = 'Copy log';
      copyBtn.style.cssText = `background:#1a1a2a;border:1px solid #2a2a3a;color:#7b8fff;font-size:10px;padding:1px 5px;border-radius:3px;cursor:pointer;`;
      copyBtn.onclick = () => {
        const lines = _qbEventLog.map(ev => {
          const d = new Date(ev.ts);
          const t = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
          const label = { desync:'⚠ desync', snap:'📸 snap', restore:'⟳ restore', sync:'✓ sync' }[ev.type] || ev.type;
          return `${t}  ${label.padEnd(12)}  ${ev.detail}`;
        });
        navigator.clipboard.writeText(lines.join('\n')).then(() => {
          copyBtn.textContent = '✓'; setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
        });
      };

      const clearBtn = document.createElement('button');
      clearBtn.textContent = '✕';
      clearBtn.title = 'Clear log';
      clearBtn.style.cssText = `background:#1a1a2a;border:1px solid #2a2a3a;color:#555;font-size:10px;padding:1px 5px;border-radius:3px;cursor:pointer;`;
      clearBtn.onclick = () => { _qbEventLog.length = 0; renderQBPane(); };

      btnRow.appendChild(copyBtn);
      btnRow.appendChild(clearBtn);
      logHdr.appendChild(logTitle);
      logHdr.appendChild(btnRow);
      _fp_qb.appendChild(logHdr);

      const logWrap = document.createElement('div');
      logWrap.style.cssText = `display:flex;flex-direction:column;padding:2px 6px 3px;font-size:10px;font-family:monospace;`;

      const entries = _qbEventLog.slice(-8);
      if (_qbEventLog.length > 8) {
        const moreEl = document.createElement('div');
        moreEl.style.cssText = `color:#333;padding:0;`;
        moreEl.textContent = `… ${_qbEventLog.length - 8} earlier`;
        logWrap.appendChild(moreEl);
      }

      entries.forEach(ev => {
        const row = document.createElement('div');
        row.style.cssText = `display:flex;gap:5px;align-items:baseline;line-height:1.4;`;

        const d = new Date(ev.ts);
        const timeEl = document.createElement('span');
        timeEl.style.cssText = `color:#444;flex-shrink:0;`;
        timeEl.textContent = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;

        const typeColor = { desync:'#ff8844', snap:'#f0c040', restore:'#4caf50', sync:'#6b9', desired_set:'#7ab', desired_clear:'#a88', restore_noop:'#888', restore_skip:'#f0c040' }[ev.type] || '#888';
        const typeLabel = { desync:'⚠ desync', snap:'📸 snap', restore:'⟳ restore', sync:'✓ sync', desired_set:'📌 desired', desired_clear:'✕ cleared', restore_noop:'○ noop', restore_skip:'⚡ skip' }[ev.type] || ev.type;
        const typeEl = document.createElement('span');
        typeEl.style.cssText = `flex-shrink:0;font-weight:bold;color:${typeColor};min-width:64px;`;
        typeEl.textContent = typeLabel;

        const detailEl = document.createElement('span');
        detailEl.style.cssText = `color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;`;
        detailEl.title = ev.detail;
        detailEl.textContent = ev.detail;

        row.appendChild(timeEl);
        row.appendChild(typeEl);
        row.appendChild(detailEl);
        logWrap.appendChild(row);
      });

      if (_qbEventLog.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = `color:#333;padding:1px 0;`;
        empty.textContent = 'no events yet';
        logWrap.appendChild(empty);
      }

      _fp_qb.appendChild(logWrap);
    }

  }

    function renderTrackPane() {
    _fp_track = _paneFor('track', trackPane);
    if (!_fp_track) return;
    if (_fp_track === trackPane && _poppedOut.has('track')) return;

    if (!_trackFullOpen) {
      renderTrackPaneCompact();
      return;
    }

    _fp_track.appendChild(renderTrackSettings());

    const totalTracked = trackedResources.size + trackedMobs.size;
    if (totalTracked === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:#555;padding:28px 16px;text-align:center;line-height:2;font-size:13px;`;
      empty.innerHTML = `<div style="font-size:28px;margin-bottom:8px;">📋</div>Nothing tracked yet.<br><span style="font-size:12px;color:#444;">Open 👾 Mobs or 🌿 Res above<br>and click <span style="color:#7b8fff;font-weight:bold">+ Track</span> on anything you want to monitor.</span>`;
      _fp_track.appendChild(empty);
      return;
    }

    const hdr = document.createElement('div');
    hdr.style.cssText = `padding:6px 10px;background:#0d1117;border-bottom:1px solid #1e2535;display:flex;justify-content:space-between;align-items:center;gap:6px;`;
    hdr.innerHTML = `
      <span style="color:#7b8fff;font-size:12px;font-weight:bold;">📋 Tracked: <span style="color:#aac">${totalTracked}</span></span>
      <span style="color:#555;font-size:11px;">👾 ${trackedMobs.size} mobs &nbsp;·&nbsp; 🌿 ${trackedResources.size} resources</span>
    `;


    const clearBtn = document.createElement('button');
    clearBtn.id = 'roeTrackClearAll';
    clearBtn.textContent = '🗑 Clear all';
    clearBtn.title = 'Remove everything from the tracking list';
    clearBtn.style.cssText = `background:#2a1010;color:#e07070;border:1px solid #5a2a2a;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;`;
    clearBtn.onmouseover = () => { clearBtn.style.background = '#3a1515'; };
    clearBtn.onmouseout  = () => { clearBtn.style.background = '#2a1010'; };
    clearBtn.onclick = () => {
      showConfirm(clearBtn, 'Clear all tracked?', () => {
        trackedResources.clear(); trackedMobs.clear();
        previousTrackedStates.clear(); previousTrackedMobStates.clear();
        _notifyCooldowns.clear(); saveNotifyCooldowns();
        saveTracked(); renderTrackPane(); updateTrackTab();
      });
    };
    hdr.appendChild(clearBtn);
    _fp_track.appendChild(hdr);

    const zones = new Set();
    trackedResources.forEach(v => zones.add(_trackZoneGroup(v.zone)));
    trackedMobs.forEach(v => zones.add(_trackZoneGroup(v.zone)));

    Array.from(zones).sort().forEach(zone => {

      const realZones = _trackZoneGroupRealZones(zone);
      const mobEntries = [], resEntries = [];
      trackedMobs.forEach((v, k)      => { if (realZones.includes(v.zone)) mobEntries.push([k, v]); });
      trackedResources.forEach((v, k) => { if (realZones.includes(v.zone)) resEntries.push([k, v]); });
      mobEntries.sort((a, b) => (_trackDisplayOrder[a[0]] ?? 9999) - (_trackDisplayOrder[b[0]] ?? 9999));
      resEntries.sort((a, b) => (_trackDisplayOrder[a[0]] ?? 9999) - (_trackDisplayOrder[b[0]] ?? 9999));
      if (!mobEntries.length && !resEntries.length) return;

      const zc = zoneColor(realZones[0]);
      const isLive = realZones.some(z => _seenZones.has(z));
      const zh = document.createElement('div');
      zh.style.cssText = `color:${zc};font-weight:bold;padding:6px 10px;background:#0a0d12;border-left:3px solid ${zc};margin-top:6px;margin-bottom:0;font-size:14px;display:flex;align-items:center;gap:8px;letter-spacing:0.02em;`;
      zh.innerHTML = `<span>📍 ${zone}</span>${!isLive ? '<span style="color:#444;font-size:11px;font-weight:normal;background:#111;border:1px solid #222;border-radius:3px;padding:1px 6px;">⏳ Not visited yet</span>' : ''}`;
      _fp_track.appendChild(zh);

      if (mobEntries.length) {
        _fp_track.appendChild(makeTrackSection('Mobs', '#ff9800'));
        groupTrackedMobEntries(mobEntries).forEach(item => {
          if (item.kind === 'solo') {
            _fp_track.appendChild(renderTrackedMobRow(item.id, item.v));
          } else {
            _fp_track.appendChild(renderTrackedMobGroupRow(item.entries));
          }
        });
      }

      if (resEntries.length) {
        _fp_track.appendChild(makeTrackSection('Resources', '#4caf50'));
        realZones.forEach(realZone => {
          const zoneResEntries = resEntries.filter(([, v]) => v.zone === realZone);
          if (!zoneResEntries.length) return;
          zoneResEntries.forEach(([id, v]) => {
            _fp_track.appendChild(renderTrackedResourceRow(id, v));
          });
        });
      }


    });
  }

  // ─── Chest / Inventory handler ───────────────────────────────────────────────
  function handleChestEvent(data) {
    const items = data?.data?.InventoryItems;
    if (!Array.isArray(items)) return;

    // Merge stacks of same itemId
    const merged = {};
    items.forEach(item => {
      const id = String(item.itemId || '').toLowerCase();
      if (!id) return;
      if (!merged[id]) merged[id] = { itemId: id, quantity: 0, slots: 0, durability: 0, maxDurability: 0, level: 0 };
      merged[id].quantity += Number(item.Quantity) || 0;
      merged[id].slots += 1;
      if ((item.Durability || 0) > 0) {
        merged[id].durability = item.Durability;
        merged[id].maxDurability = item.MaxDurability;
        merged[id].level = item.Level;
      }
    });

    _chestItems = Object.values(merged);
    _chestLastAt = Date.now();
    _saveQBInventoryState();
    addSysLog('chest', { uniqueItems: _chestItems.length, totalSlots: items.length });
    if (activeTab === 'chest' || _poppedOut.has('chest')) renderChestPane();
  }

  function handleItemPickupAck(payload) {
    if (!payload?.success) return;
    const d = payload.data;
    if (!d) return;
    const qty = d.quantity || 1;
    // Keep the local inventory cache in sync — this ack carries the item's new
    // total quantity/instance, but a full 'inventory' snapshot doesn't arrive on
    // every pickup, so without this the Backpack/Durability views go stale until
    // something else (e.g. a weapon swap) forces a snapshot.
    if (d.instanceId) {
      _inventoryByInstance[d.instanceId] = {
        instanceId: d.instanceId,
        itemId: d.itemId,
        Level: d.level ?? 0,
        Durability: d.durability ?? 0,
        MaxDurability: d.maxDurability ?? 0,
        Quantity: d.totalQuantity ?? qty,
      };
      if (d.slot != null) {
        _inventoryBySlot[d.slot] = d.itemId;
        _inventorySlotByInstance[d.instanceId] = d.slot;
      }
      _knownItemIdByInstance.set(d.instanceId, d.itemId);
      if (activeTab === 'qb' || _poppedOut.has('qb')) renderQBPane();
      if (activeTab === 'chest' || _poppedOut.has('chest')) renderChestPane();
    }
  }



  function getCheapestMarketListing(itemId) {
    const key = normalizeMarketItemId(itemId);
    let cheapest = null;
    for (const listing of marketListings.values()) {
      if (!listing.isActive || listing.itemId !== key) continue;
      if (!cheapest || compareWei(listing.priceWei, cheapest.priceWei) < 0) cheapest = listing;
    }
    return cheapest;
  }

  function getBagMaterialItems() {
    const merged = {};
    Object.values(_inventoryByInstance).forEach(item => {
      if (isToolItem(item.itemId)) return; // tools/weapons shown in Durability tab instead
      const id = String(item.itemId || '').toLowerCase();
      if (!id) return;
      if (!merged[id]) merged[id] = { itemId: id, quantity: 0, slots: 0, durability: 0, maxDurability: 0, level: 0 };
      merged[id].quantity += Number(item.Quantity) || 0;
      merged[id].slots += 1;
    });
    return Object.values(merged);
  }

  function getChestDisplayItems(sourceItems, sortBy, search) {
    sourceItems = sourceItems || _chestItems;
    sortBy = sortBy || _chestSortBy;
    const q = (search != null ? search : _chestSearch).trim().toLowerCase();
    let items = sourceItems.filter(item => !q || item.itemId.includes(q));
    items = items.map(item => {
      const shop     = getMarketShopPrice(item.itemId);
      const listing  = getCheapestMarketListing(item.itemId);
      const sellPrice    = shop?.sellPrice || 0;
      const totalValue   = sellPrice * item.quantity;
      const marketWei    = listing ? BigInt(listing.priceWei) : 0n;
      const marketEth    = listing ? weiToEthNumber(listing.priceWei) : 0;
      const marketUsd    = marketEth > 0 && marketEthUsd > 0 ? marketEth * marketEthUsd : 0;
      const totalMarketEth = marketEth * item.quantity;
      const totalMarketUsd = marketUsd * item.quantity;
      return {
        ...item,
        sellPrice, totalValue,
        marketWei, marketEth, marketUsd,
        totalMarketEth, totalMarketUsd,
        hasPrice: sellPrice > 0 || marketEth > 0
      };
    });
    if (sortBy === 'value_desc') {
      items.sort((a, b) => {
        // Rune-priced items and ETH-only-priced items aren't in the same unit,
        // so they can't be compared by magnitude — previously a rough eth->rune
        // conversion (*1e12) wildly overweighted small ETH amounts, pushing them
        // above high-value rune items. Rank all rune-priced items first, then
        // ETH-only items, each sorted by their own value.
        if (a.totalValue > 0 && b.totalValue > 0) return b.totalValue - a.totalValue || a.itemId.localeCompare(b.itemId);
        if (a.totalValue > 0) return -1;
        if (b.totalValue > 0) return 1;
        return b.totalMarketEth - a.totalMarketEth || a.itemId.localeCompare(b.itemId);
      });
    } else if (sortBy === 'qty_desc') {
      items.sort((a, b) => b.quantity - a.quantity || a.itemId.localeCompare(b.itemId));
    } else if (sortBy === 'market_asc') {
      items.sort((a, b) => {
        // items without market price go to the bottom
        if (a.marketEth > 0 && b.marketEth > 0) return a.marketEth - b.marketEth || a.itemId.localeCompare(b.itemId);
        if (a.marketEth > 0) return -1;
        if (b.marketEth > 0) return 1;
        return a.itemId.localeCompare(b.itemId);
      });
    } else if (sortBy === 'market_desc') {
      items.sort((a, b) => {
        if (a.marketEth > 0 && b.marketEth > 0) return b.marketEth - a.marketEth || a.itemId.localeCompare(b.itemId);
        if (a.marketEth > 0) return -1;
        if (b.marketEth > 0) return 1;
        return a.itemId.localeCompare(b.itemId);
      });
    } else if (sortBy === 'runes_desc') {
      items.sort((a, b) => {
        if (a.sellPrice > 0 && b.sellPrice > 0) return b.sellPrice - a.sellPrice || a.itemId.localeCompare(b.itemId);
        if (a.sellPrice > 0) return -1;
        if (b.sellPrice > 0) return 1;
        return a.itemId.localeCompare(b.itemId);
      });
    } else if (sortBy === 'runes_asc') {
      items.sort((a, b) => {
        if (a.sellPrice > 0 && b.sellPrice > 0) return a.sellPrice - b.sellPrice || a.itemId.localeCompare(b.itemId);
        if (a.sellPrice > 0) return -1;
        if (b.sellPrice > 0) return 1;
        return a.itemId.localeCompare(b.itemId);
      });
    } else {
      items.sort((a, b) => a.itemId.localeCompare(b.itemId));
    }
    return items;
  }

  // ─── Render "Chest" tab ──────────────────────────────────────────────────────
  function renderChestPane() {
    const _fp_chest = _paneFor('chest', chestPane);
    if (!_fp_chest) return;
    if (_fp_chest === chestPane && _poppedOut.has('chest')) return;

    const ctrl = document.createElement('div');
    ctrl.style.cssText = `
      position:sticky;top:0;z-index:2;background:#0d0d16;border-bottom:1px solid #23233a;
      padding:6px 10px;margin:-6px -6px 6px -6px;display:flex;flex-direction:column;gap:5px;
    `;

    const hasChestData = _chestItems.length > 0;

    const allItems       = hasChestData ? getChestDisplayItems() : [];
    const priced         = allItems.filter(i => i.hasPrice);
    const unpriced        = allItems.filter(i => !i.hasPrice);
    const totalShopValue = allItems.reduce((s, i) => s + i.totalValue, 0);
    const totalMarketEth = allItems.reduce((s, i) => s + i.totalMarketEth, 0);
    const totalMarketUsd = allItems.reduce((s, i) => s + i.totalMarketUsd, 0);
    const totalQty       = allItems.reduce((s, i) => s + i.quantity, 0);
    const lastTime       = _chestLastAt ? new Date(_chestLastAt).toLocaleTimeString([], { hour12: false }) : 'never';

    const bagRaw       = getBagMaterialItems();
    const bagAllItems  = getChestDisplayItems(bagRaw, _chestSortBy, _chestSearch);
    const bagItems       = bagAllItems.filter(i => i.itemId !== 'runestone');
    const bagTotalQty    = bagItems.reduce((s, i) => s + i.quantity, 0);
    const bagTotalValue  = bagItems.reduce((s, i) => s + i.totalValue, 0);
    const bagTotalEth    = bagItems.reduce((s, i) => s + i.totalMarketEth, 0);

    function chestCard(label, value, color) {
      const el = document.createElement('div');
      el.style.cssText = `background:#0a0d12;border:1px solid #23233a;border-radius:5px;padding:5px 7px;min-width:0;`;
      el.innerHTML = `<div style="color:#555;font-size:10px;margin-bottom:1px">${label}</div><div style="color:${color || '#ddd'};font-weight:bold;font-size:12px">${value}</div>`;
      return el;
    }

    const stats = document.createElement('div');
    stats.style.cssText = `display:grid;grid-template-columns:repeat(6,1fr);gap:5px;`;
    stats.appendChild(chestCard('Items', String(allItems.length), '#f0c36a'));
    stats.appendChild(chestCard('Qty', formatNumber(totalQty, 0), '#f0c36a'));
    const marketEthCard = chestCard('Market ETH', totalMarketEth > 0 ? weiToEthString(totalMarketEth * 1e18, 4) : '—', '#7ee787');
    marketEthCard.style.gridColumn = '3';
    stats.appendChild(marketEthCard);
    const marketUsdCard = chestCard('Market USD', totalMarketUsd > 0 ? formatUsd(totalMarketUsd) : '—', '#7ee787');
    marketUsdCard.style.gridColumn = '4';
    stats.appendChild(marketUsdCard);
    const chestRuneCard = chestCard('ᚱ Chest', totalShopValue > 0 ? formatNumber(totalShopValue, 0) : '—', '#7bbfff');
    chestRuneCard.style.gridColumn = '5';
    stats.appendChild(chestRuneCard);
    if (_runestoneQty !== null) {
      const balanceCard = chestCard('ᚱ Balance', formatNumber(_runestoneQty, 0), '#7bbfff');
      balanceCard.style.gridColumn = '6';
      stats.appendChild(balanceCard);
    }
    ctrl.appendChild(stats);

    // Filters row — shares the same 6-col grid as stats so search aligns under
    // the first 4 cards and the sort dropdown aligns under Market ETH/USD.
    const filters = document.createElement('div');
    filters.style.cssText = `display:grid;grid-template-columns:repeat(6,1fr);gap:5px;align-items:center;`;

    const searchEl = document.createElement('input');
    searchEl.id = 'roeChestSearch';
    searchEl.type = 'text';
    searchEl.placeholder = 'Search item…';
    searchEl.value = _chestSearch;
    searchEl.style.cssText = `${selStyle()}grid-column:1 / span 4;min-width:0;padding:4px 6px;`;
    searchEl.onmousedown = e => e.stopPropagation();
    searchEl.onclick = e => e.stopPropagation();
    searchEl.oninput = () => {
      _chestSearch = searchEl.value;
      const caret = searchEl.selectionStart;
      renderChestPane();
      const newSearchEl = document.getElementById('roeChestSearch');
      if (newSearchEl) {
        newSearchEl.focus();
        newSearchEl.setSelectionRange(caret, caret);
      }
    };
    filters.appendChild(searchEl);

    const sortSel = document.createElement('select');
    sortSel.style.cssText = `${selStyle()}padding:4px 5px;grid-column:5 / span 2;min-width:0;`;
    sortSel.innerHTML = `
      <option value="value_desc">By total value ↓</option>
      <option value="market_desc">Market price/ea ↓</option>
      <option value="market_asc">Market price/ea ↑</option>
      <option value="runes_desc">Runes/ea ↓</option>
      <option value="runes_asc">Runes/ea ↑</option>
      <option value="qty_desc">By qty ↓</option>
      <option value="name_asc">By name A-Z</option>
    `;
    sortSel.value = _chestSortBy;
    sortSel.onchange = () => { _chestSortBy = sortSel.value; renderChestPane(); };
    filters.appendChild(sortSel);
    ctrl.appendChild(filters);

    const meta = document.createElement('div');
    meta.style.cssText = `color:#555;font-size:10px;`;
    meta.textContent = hasChestData
      ? ''
      : 'Chest: not opened yet — open your chest or storage in-game once.';
    if (meta.textContent) ctrl.appendChild(meta);

    _fp_chest.appendChild(ctrl);

    function renderSection(items, label, labelColor) {
      if (!items.length) return;
      const hdr = document.createElement('div');
      hdr.style.cssText = `color:${labelColor};font-weight:bold;padding:6px 10px;background:#0a0d12;border-left:3px solid ${labelColor};margin-top:6px;margin-bottom:0;font-size:14px;letter-spacing:0.02em;`;
      hdr.textContent = label;
      _fp_chest.appendChild(hdr);

      const colHdr = document.createElement('div');
      colHdr.style.cssText = `
        display:grid;grid-template-columns:minmax(0,180px) 60px 80px 90px 100px 80px;
        gap:10px;padding:2px 10px 3px;align-items:end;
        border-bottom:1px solid #1e2535;font-size:9px;text-transform:uppercase;letter-spacing:0.04em;
      `;
      colHdr.innerHTML = `<span style="color:#c9d1d9;">Name</span><span style="text-align:right;color:#f0c36a;">Qty</span><span style="text-align:right;color:#7ee787;">ETH Unit Price</span><span style="text-align:right;color:#7ee787;">ETH TOTAL</span><span style="text-align:right;color:#7bbfff;">ᚱ Unit Price</span><span style="text-align:right;color:#7bbfff;">ᚱ TOTAL</span>`;
      _fp_chest.appendChild(colHdr);

      items.forEach(item => {
        const row = document.createElement('div');
        row.style.cssText = `
          display:grid;grid-template-columns:minmax(0,180px) 60px 80px 90px 100px 80px;
          gap:10px;align-items:center;padding:4px 10px;
          border-bottom:1px solid #1e2535;font-size:12px;cursor:default;
        `;
        row.onmouseover = () => { row.style.background = '#0d1117'; };
        row.onmouseout  = () => { row.style.background = ''; };

        const nameEl = document.createElement('span');
        nameEl.style.cssText = `color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;`;
        const prettyName = item.itemId.replace(/([a-z])([0-9])/g, '$1 $2').replace(/([a-z])([A-Z])/g, '$1 $2');
        nameEl.textContent = prettyName.charAt(0).toUpperCase() + prettyName.slice(1);
        nameEl.title = item.itemId
          + (item.slots > 1 ? ` (${item.slots} slots)` : '')
          + (item.maxDurability > 0 ? ` · dur ${item.durability}/${item.maxDurability}` : '')
          + (item.level > 0 ? ` · lvl ${item.level}` : '')
          + (item.marketEth > 0 ? ` · market: ${weiToEthString(item.marketWei, 6)} ETH` : '');
        row.appendChild(nameEl);

        // Quantity
        const qtyEl = document.createElement('span');
        qtyEl.style.cssText = `color:#f0c36a;text-align:right;white-space:nowrap;`;
        qtyEl.textContent = `×${formatNumber(item.quantity, 0)}`;
        row.appendChild(qtyEl);

        // ETH Unit Price
        const ethUnitEl = document.createElement('span');
        ethUnitEl.style.cssText = `text-align:right;white-space:nowrap;font-size:12px;min-width:52px;color:${item.marketEth > 0 ? '#7ee787' : '#333'};`;
        ethUnitEl.textContent = item.marketEth > 0 ? weiToEthString(item.marketWei, 6) : '—';
        row.appendChild(ethUnitEl);

        // Total value — ETH and rune each get their own labeled column
        const ethEl = document.createElement('span');
        ethEl.style.cssText = `text-align:right;white-space:nowrap;font-weight:bold;font-size:12px;color:${item.totalMarketEth > 0 ? '#7ee787' : '#333'};`;
        ethEl.textContent = item.totalMarketEth > 0 ? weiToEthString(item.totalMarketEth * 1e18, 6) : '—';
        row.appendChild(ethEl);

        // ᚱ Unit Price
        const priceEl = document.createElement('span');
        priceEl.style.cssText = `text-align:right;white-space:nowrap;font-size:12px;min-width:52px;color:${item.sellPrice > 0 ? '#7bbfff' : '#333'};`;
        priceEl.textContent = item.sellPrice > 0 ? `${formatNumber(item.sellPrice, 0)}` : '—';
        row.appendChild(priceEl);

        const valEl = document.createElement('span');
        valEl.style.cssText = `text-align:right;white-space:nowrap;font-weight:bold;font-size:12px;color:${item.totalValue > 0 ? '#7bbfff' : '#333'};`;
        valEl.textContent = item.totalValue > 0 ? formatNumber(item.totalValue, 0) : '—';
        row.appendChild(valEl);

        _fp_chest.appendChild(row);
      });
    }

    function renderTotalRow(totalQty, totalValueRune, totalEth) {
      const row = document.createElement('div');
      row.style.cssText = `
        display:grid;grid-template-columns:minmax(0,180px) 60px 80px 90px 100px 80px;
        gap:10px;align-items:center;padding:5px 10px;font-size:12px;font-weight:bold;
        border-bottom:1px solid #1e2535;background:#0a0d12;
      `;
      const labelEl = document.createElement('span');
      labelEl.style.cssText = `color:#555;font-weight:normal;`;
      labelEl.textContent = 'Total:';
      row.appendChild(labelEl);

      const qtyEl = document.createElement('span');
      qtyEl.style.cssText = `color:#f0c36a;text-align:right;white-space:nowrap;`;
      qtyEl.textContent = `${formatNumber(totalQty, 0)}`;
      row.appendChild(qtyEl);

      // empty ETH unit price column
      row.appendChild(document.createElement('span'));

      const ethEl = document.createElement('span');
      ethEl.style.cssText = `text-align:right;white-space:nowrap;color:${totalEth > 0 ? '#7ee787' : '#333'};`;
      ethEl.textContent = totalEth > 0 ? weiToEthString(totalEth * 1e18, 4) : '—';
      row.appendChild(ethEl);

      // empty ᚱ unit price column
      row.appendChild(document.createElement('span'));

      const valEl = document.createElement('span');
      valEl.style.cssText = `text-align:right;white-space:nowrap;color:${totalValueRune > 0 ? '#7bbfff' : '#333'};`;
      valEl.textContent = totalValueRune > 0 ? formatNumber(totalValueRune, 0) : '—';
      row.appendChild(valEl);

      return row;
    }

    renderSection(bagItems, `Bag (${bagItems.length})`, '#aabeff');
    if (bagItems.length) {
      _fp_chest.appendChild(renderTotalRow(bagTotalQty, bagTotalValue, bagTotalEth));
    }

    renderSection(priced,   `Chest (${priced.length})`, '#7ee787');
    if (priced.length) {
      const chestTotalQty = priced.reduce((s, i) => s + i.quantity, 0);
      _fp_chest.appendChild(renderTotalRow(chestTotalQty, totalShopValue, totalMarketEth));
    }
    renderSection(unpriced, `No price (${unpriced.length})`, '#52606d');

    if (!bagAllItems.length && !allItems.length) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:#555;padding:28px 16px;text-align:center;line-height:2;font-size:13px;`;
      empty.innerHTML = `<div style="font-size:28px;margin-bottom:8px;">📦</div>No items yet.`;
      _fp_chest.appendChild(empty);
    }
  }

  // ─── Render "Log" tab ────────────────────────────────────────────────────────
  function getFilteredMarketListings() {
    const q = marketSearch.trim().toLowerCase();
    return Array.from(marketListings.values()).filter(l => {
      if (!l.isActive) return false;
      if (marketTypeFilter !== 'ALL' && l.itemTypeName !== marketTypeFilter) return false;
      if (q) {
        const hay = `${l.itemName} ${l.itemId} ${l.itemTypeName} ${l.seller}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function buildMarketGroups(listings) {
    const groups = new Map();
    listings.forEach(l => {
      const key = `${l.itemId}|${l.itemName}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          itemName: l.itemName,
          itemId: l.itemId,
          itemTypeName: l.itemTypeName,
          listings: [],
          qty: 0,
          sellers: new Set(),
          minPriceWei: l.priceWei,
          newest: 0
        });
      }
      const g = groups.get(key);
      g.listings.push(l);
      g.qty += Number(l.qtyRemaining) || 0;
      g.sellers.add(l.seller);
      const mm = getMerchantMetrics(l);
      l._merchant = mm;
      g.runes = (g.runes || 0) + mm.runes;
      g.usd = (g.usd || 0) + mm.usd;
      if (!g.bestMerchant || mm.runesPerEth > g.bestMerchant.runesPerEth) g.bestMerchant = mm;
      if (compareWei(l.priceWei, g.minPriceWei) < 0) g.minPriceWei = l.priceWei;
      g.newest = Math.max(g.newest, Date.parse(l.createdAt || '') || 0, l.firstSeenAt || 0);
    });
    const arr = Array.from(groups.values());
    arr.forEach(g => g.listings.sort((a, b) => compareWei(a.priceWei, b.priceWei) || (Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))));
    arr.sort((a, b) => {
      if (marketSort === 'item_asc') return a.itemName.localeCompare(b.itemName);
      if (marketSort === 'qty_desc') return b.qty - a.qty;
      if (marketSort === 'merchant_desc') return (b.bestMerchant?.runesPerEth || 0) - (a.bestMerchant?.runesPerEth || 0);
      if (marketSort === 'runes_usd_desc') return (b.bestMerchant?.runesPerUsd || 0) - (a.bestMerchant?.runesPerUsd || 0);
      if (marketSort === 'usdc_asc') {
        const av = a.bestMerchant?.usdPer1000Runes > 0 ? a.bestMerchant.usdPer1000Runes : Number.POSITIVE_INFINITY;
        const bv = b.bestMerchant?.usdPer1000Runes > 0 ? b.bestMerchant.usdPer1000Runes : Number.POSITIVE_INFINITY;
        if (av === bv) return a.itemName.localeCompare(b.itemName);
        return av - bv;
      }
      if (marketSort === 'newest') return b.newest - a.newest;
      if (marketSort === 'listings_desc') return b.listings.length - a.listings.length;
      return compareWei(a.minPriceWei, b.minPriceWei) || a.itemName.localeCompare(b.itemName);
    });
    return arr;
  }

  function marketStatCard(label, value, color) {
    const el = document.createElement('div');
    el.style.cssText = `background:#0a0d12;border:1px solid #23233a;border-radius:5px;padding:5px 7px;min-width:0;`;
    el.innerHTML = `<div style="color:#555;font-size:10px;margin-bottom:1px">${label}</div><div style="color:${color || '#ddd'};font-weight:bold;font-size:12px">${value}</div>`;
    return el;
  }

  function renderMarketPane() {
    const _fp_market = _paneFor('market', marketPane);
    if (!_fp_market) return;
    if (_fp_market === marketPane && _poppedOut.has('market')) return;

    const listings = getFilteredMarketListings();
    const allActive = Array.from(marketListings.values()).filter(l => l.isActive);
    const groups = buildMarketGroups(listings);
    const typeOptions = Array.from(new Set(allActive.map(l => l.itemTypeName).filter(Boolean))).sort();
    const totalQty = listings.reduce((sum, l) => sum + (Number(l.qtyRemaining) || 0), 0);
    const sellers = new Set(listings.map(l => l.seller).filter(Boolean)).size;
    const knownMerchant = listings.filter(l => getMerchantMetrics(l).known).length;
    const last = marketLastListingsAt ? new Date(marketLastListingsAt).toLocaleTimeString([], { hour12: false }) : 'never';
    const lastPrices = marketLastPricesAt ? new Date(marketLastPricesAt).toLocaleTimeString([], { hour12: false }) : 'none';
    const ethUsdAge = marketEthUsdUpdatedAt ? relativeAge(marketEthUsdUpdatedAt) : '';

    const ctrl = document.createElement('div');
    ctrl.style.cssText = `
      position:sticky;top:0;z-index:2;background:#0d0d16;border-bottom:1px solid #23233a;
      padding:6px 10px;margin:-6px -6px 6px -6px;display:flex;flex-direction:column;gap:5px;
    `;

    const stats = document.createElement('div');
    stats.style.cssText = `display:grid;grid-template-columns:repeat(5,1fr);gap:5px;`;
    stats.appendChild(marketStatCard('Listings', String(listings.length), '#7bbfff'));
    stats.appendChild(marketStatCard('Items', String(groups.length), '#9fd68b'));
    stats.appendChild(marketStatCard('Qty', String(totalQty), '#f0c36a'));
    stats.appendChild(marketStatCard('Sellers', String(sellers), '#c79bff'));
    stats.appendChild(marketStatCard('Priced', `${knownMerchant}/${listings.length}`, '#7ee787'));
    ctrl.appendChild(stats);

    // Filters row — shares the same 5-col grid as stats so search/type/sort
    // line up under the stat cards, matching the Bag & Chest tab layout.
    const filters = document.createElement('div');
    filters.style.cssText = `display:grid;grid-template-columns:repeat(5,1fr);gap:5px;align-items:center;`;

    const search = document.createElement('input');
    search.id = 'roeMarketSearch';
    search.type = 'text';
    search.placeholder = 'Search item, id, seller';
    search.value = marketSearch;
    search.style.cssText = `${selStyle()}grid-column:1 / span 2;min-width:0;padding:4px 6px;`;
    search.onmousedown = e => e.stopPropagation();
    search.onclick = e => e.stopPropagation();
    search.oninput = () => {
      marketSearch = search.value;
      saveFilters();
      const caret = search.selectionStart;
      renderMarketPane();
      const newSearchEl = document.getElementById('roeMarketSearch');
      if (newSearchEl) {
        newSearchEl.focus();
        newSearchEl.setSelectionRange(caret, caret);
      }
    };
    filters.appendChild(search);

    const typeSel = document.createElement('select');
    typeSel.style.cssText = `${selStyle()}padding:4px 5px;grid-column:3;min-width:0;`;
    typeSel.innerHTML = `<option value="ALL">All types</option>${typeOptions.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}`;
    typeSel.value = marketTypeFilter;
    typeSel.onchange = () => { marketTypeFilter = typeSel.value; saveFilters(); renderMarketPane(); };
    filters.appendChild(typeSel);

    const sortSel = document.createElement('select');
    sortSel.style.cssText = `${selStyle()}padding:4px 5px;grid-column:4 / span 2;min-width:0;`;
    sortSel.innerHTML = `
      <option value="unit_asc">Cheapest each</option>
      <option value="merchant_desc">Best runes/ETH</option>
      <option value="runes_usd_desc">Best runes/$</option>
      <option value="usdc_asc">Cheapest runes USDC</option>
      <option value="newest">Newest</option>
      <option value="qty_desc">Most qty</option>
      <option value="listings_desc">Most listings</option>
      <option value="item_asc">Item A-Z</option>
    `;
    sortSel.value = marketSort;
    sortSel.onchange = () => { marketSort = sortSel.value; saveFilters(); renderMarketPane(); };
    filters.appendChild(sortSel);
    ctrl.appendChild(filters);

    // Second filter row — ETH/USD manual input + actions, same 5-col grid.
    const filters2 = document.createElement('div');
    filters2.style.cssText = `display:grid;grid-template-columns:repeat(5,1fr);gap:5px;align-items:center;`;

    const usdInput = document.createElement('input');
    usdInput.id = 'roeMarketEthUsd';
    usdInput.type = 'number';
    usdInput.min = '0';
    usdInput.step = '1';
    usdInput.placeholder = 'ETH USD';
    usdInput.value = marketEthUsd > 0 ? String(marketEthUsd) : '';
    usdInput.title = 'Manual ETH/USD rate for USDC estimates';
    usdInput.style.cssText = `${selStyle()}padding:4px 5px;grid-column:1;min-width:0;`;
    usdInput.onmousedown = e => e.stopPropagation();
    usdInput.onclick = e => e.stopPropagation();
    const commitUsd = () => {
      marketEthUsd = Math.max(0, Number(usdInput.value) || 0);
      saveMarketSnapshot();
      saveFilters();
      const caret = usdInput.selectionStart;
      renderMarketPane();
      const newUsdEl = document.getElementById('roeMarketEthUsd');
      if (newUsdEl) {
        newUsdEl.focus();
        newUsdEl.setSelectionRange(caret, caret);
      }
    };
    usdInput.oninput = commitUsd;
    filters2.appendChild(usdInput);

    const cmcBtn = document.createElement('button');
    cmcBtn.textContent = marketEthUsdLoading ? 'CMC...' : 'CMC';
    cmcBtn.title = 'Fetch ETH/USD from CoinMarketCap';
    cmcBtn.disabled = marketEthUsdLoading;
    cmcBtn.style.cssText = `${btnStyle(marketEthUsdLoading ? '#181818' : '#101a24')}padding:4px 7px;color:${marketEthUsdLoading ? '#666' : '#7bbfff'};grid-column:2;`;
    cmcBtn.onclick = e => { e.stopPropagation(); fetchEthUsdFromCoinMarketCap(); };
    filters2.appendChild(cmcBtn);

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Reset';
    clearBtn.style.cssText = `${btnStyle('#111820')}padding:4px 7px;grid-column:3;`;
    clearBtn.onclick = () => { marketSearch = ''; marketTypeFilter = 'ALL'; marketSort = 'unit_asc'; saveFilters(); renderMarketPane(); };
    filters2.appendChild(clearBtn);
    ctrl.appendChild(filters2);

    const meta = document.createElement('div');
    meta.style.cssText = `color:#555;font-size:10px;display:flex;gap:8px;flex-wrap:wrap;`;
    meta.innerHTML = `<span>Last listings: ${escapeHtml(last)}</span><span>ETH/USD: ${marketEthUsd > 0 ? formatUsd(marketEthUsd) : '-'}${ethUsdAge ? ` (${escapeHtml(ethUsdAge)} ago)` : ''}</span>${marketEthUsdError ? `<span style="color:#e57373">${escapeHtml(marketEthUsdError)}</span>` : ''}<span>Shop prices: ${marketShopPrices.size} (${escapeHtml(lastPrices)})</span><span>Pages seen: ${marketPagesLoaded}</span><span>Recent sales: ${marketSales.length}</span>`;
    ctrl.appendChild(meta);
    _fp_market.appendChild(ctrl);

    if (!marketListings.size) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:#555;padding:28px 16px;text-align:center;line-height:2;font-size:13px;`;
      empty.innerHTML = `<div style="font-size:28px;margin-bottom:8px;">$</div>Open the in-game market once.<br>The tracker will catch every <span style="color:#7bbfff">marketplace:getAllListings</span> page automatically.`;
      _fp_market.appendChild(empty);
      return;
    }

    if (!groups.length) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:#555;padding:28px 16px;text-align:center;line-height:2;font-size:13px;`;
      empty.textContent = 'No listings match the current filters.';
      _fp_market.appendChild(empty);
      return;
    }

    groups.forEach(group => {
      const expanded = marketExpandedGroups.has(group.key);
      const isNew = group.listings.some(l => Date.now() - (l.firstSeenAt || 0) < 5 * 60 * 1000);
      const bestMerchant = group.bestMerchant || { known: false, runes: 0, runesPerEth: 0, runesPerUsd: 0, usdPer1000Runes: 0 };
      const merchantColor = bestMerchant.known ? '#7ee787' : '#52606d';
      const row = document.createElement('div');
      row.style.cssText = `border:1px solid #23233a;background:#0a0d12;border-radius:5px;margin-bottom:5px;overflow:hidden;box-shadow:0 1px 0 rgba(255,255,255,0.02);`;

      const head = document.createElement('div');
      head.style.cssText = `padding:6px 7px;display:flex;align-items:center;gap:7px;cursor:pointer;`;
      head.onclick = () => {
        if (marketExpandedGroups.has(group.key)) marketExpandedGroups.delete(group.key);
        else marketExpandedGroups.add(group.key);
        renderMarketPane();
      };
      head.innerHTML = `
        <span style="color:#52606d;width:10px;flex-shrink:0">${expanded ? 'v' : '>'}</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:5px;align-items:center;min-width:0">
            <span style="color:#e6edf3;font-weight:bold;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(group.itemName)}</span>
            ${isNew ? '<span style="color:#7ee787;border:1px solid #245a32;border-radius:3px;padding:0 3px;font-size:9px">NEW</span>' : ''}
          </div>
          <div style="color:#52606d;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(group.itemTypeName)} - ${escapeHtml(group.itemId)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="color:#7bbfff;font-weight:bold;font-size:12px">${weiToEthString(group.minPriceWei, 6)} ETH</div>
          <div style="color:#65717d;font-size:10px">${marketEthUsd > 0 ? formatUsd(weiToEthNumber(group.minPriceWei) * marketEthUsd) : 'each best'}</div>
        </div>
        <div style="text-align:right;min-width:70px;flex-shrink:0">
          <div style="color:${merchantColor};font-weight:bold;font-size:11px">${bestMerchant.known ? formatNumber(bestMerchant.runesPerEth, 0) : '-'}</div>
          <div style="color:#65717d;font-size:10px">${bestMerchant.runesPerUsd ? `${formatNumber(bestMerchant.runesPerUsd, 0)} r/$` : 'runes/ETH'}</div>
        </div>
        <div style="text-align:right;min-width:48px;flex-shrink:0">
          <div style="color:#f0c36a;font-size:11px">x${group.qty}</div>
          <div style="color:#65717d;font-size:10px">${group.listings.length} lots</div>
        </div>
      `;
      row.appendChild(head);

      if (expanded) {
        const details = document.createElement('div');
        details.style.cssText = `border-top:1px solid #23233a;background:#080a10;`;
        group.listings.forEach(l => {
          const mm = l._merchant || getMerchantMetrics(l);
          const total = weiToEthString(l.totalWei, 6);
          const each = weiToEthString(l.priceWei, 6);
          const age = relativeAge(l.createdAt || l.updatedAt);
          const line = document.createElement('div');
          line.style.cssText = `padding:5px 7px;border-bottom:1px solid #111922;display:grid;grid-template-columns:1fr auto;gap:6px;font-size:10px;`;
          line.innerHTML = `
            <div style="min-width:0">
              <div style="color:#c9d1d9;display:flex;gap:6px;flex-wrap:wrap">
                <span>qty <b style="color:#f0c36a">${l.qtyRemaining}</b></span>
                ${l.level ? `<span>lvl <b style="color:#c79bff">${l.level}</b></span>` : ''}
                ${l.durabilityMax ? `<span>dur <b style="color:#9fd68b">${l.durability}/${l.durabilityMax}</b></span>` : ''}
                ${mm.known ? `<span>merchant <b style="color:#7ee787">${formatNumber(mm.runes, 0)} runes</b></span>` : '<span style="color:#52606d">merchant ?</span>'}
                <span title="${escapeHtml(l.seller)}">seller <b style="color:#7bbfff">${escapeHtml(shortAddress(l.seller))}</b></span>
                ${age ? `<span style="color:#65717d">${age} ago</span>` : ''}
              </div>
              <div style="color:#384450;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(l.tx || l.id)}">${escapeHtml(l.id)}</div>
            </div>
            <div style="text-align:right;white-space:nowrap">
              <div style="color:#e6edf3">${total} ETH</div>
              <div style="color:#65717d">${each} each</div>
              ${mm.known ? `<div style="color:#7ee787">${formatNumber(mm.runesPerEth, 0)} r/ETH</div>` : ''}
              ${mm.runesPerUsd ? `<div style="color:#7bbfff">${formatNumber(mm.runesPerUsd, 0)} r/$</div>` : ''}
              ${mm.usdPer1000Runes ? `<div style="color:#f0c36a">${formatUsd(mm.usdPer1000Runes)}/1k</div>` : ''}
            </div>
          `;
          details.appendChild(line);
        });
        row.appendChild(details);
      }
      _fp_market.appendChild(row);
    });

    const sales = marketSales.slice(0, 5);
    if (sales.length) {
      const sh = document.createElement('div');
      sh.style.cssText = `color:#65717d;font-size:10px;margin:8px 0 4px;padding-top:4px;border-top:1px solid #23233a;`;
      sh.textContent = 'Recent sales';
      _fp_market.appendChild(sh);
      sales.forEach(s => {
        const sr = document.createElement('div');
        sr.style.cssText = `display:flex;gap:6px;align-items:center;padding:3px 2px;color:#65717d;font-size:10px;border-bottom:1px solid #101820;`;
        sr.innerHTML = `<span style="color:#c9d1d9;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.itemName)}</span><span>x${s.qty}</span><span style="color:#7bbfff">${weiToEthString(s.totalWei, 6)} ETH</span>`;
        _fp_market.appendChild(sr);
      });
    }
  }

  let _logFilter = 'ALL';
  let _logAutoScroll = true;

  function renderLogPane() {
    const _fp_log = _paneFor('log', logPane);
    if (!_fp_log) return;
    if (_fp_log === logPane && _poppedOut.has('log')) return;

    const ctrl = document.createElement('div');
    ctrl.style.cssText = `
      padding:4px 6px;background:#0e1018;border-bottom:1px solid #1e2030;
      display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0;
      position:sticky;top:0;z-index:1;
    `;

    // Suppress log re-renders for the brief window between mousedown and
    // click so a burst of incoming events can't destroy a button the user
    // is actively clicking. Released on mouseup/click either way, with a
    // catch-up render afterwards in case events were queued meanwhile.
    ctrl.addEventListener('mousedown', () => { _logPointerDown = true; });
    const _releaseLogPointer = () => {
      if (!_logPointerDown) return;
      _logPointerDown = false;
      _scheduleLogRender();
    };
    ctrl.addEventListener('mouseup', _releaseLogPointer);
    ctrl.addEventListener('mouseleave', _releaseLogPointer);

    ['ALL', 'IN', 'OUT', 'SYS', 'CON'].forEach(f => {
      const b = document.createElement('button');
      b.textContent = f;
      const active = _logFilter === f;
      b.style.cssText = `
        background:${active ? '#1a2e3a' : '#111'};
        color:${active ? '#7bbfff' : '#555'};
        border:1px solid ${active ? '#3a5e7a' : '#222'};
        border-radius:3px;padding:1px 7px;cursor:pointer;
        font-size:10px;font-family:monospace;
      `;
      b.onclick = () => { _logFilter = f; renderLogPane(); };
      ctrl.appendChild(b);
    });

    const counter = document.createElement('span');
    counter.style.cssText = `color:#3a3a3a;font-size:10px;margin-left:2px;`;
    counter.textContent = `${wsLog.length} events (UI cap: ${MAX_UI_EVENTS})`;
    ctrl.appendChild(counter);

    if (wsLogSkippedCount > 0) {
      const skipped = document.createElement('span');
      skipped.style.cssText = `color:#333;font-size:10px;margin-left:2px;`;
      skipped.title = `Filtered: stats, inventory, ack events, heartbeat, resource_cooldown`;
      skipped.textContent = `+${wsLogSkippedCount} filtered`;
      ctrl.appendChild(skipped);
    }

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    ctrl.appendChild(spacer);

    const asLabel = document.createElement('label');
    asLabel.style.cssText = `display:flex;align-items:center;gap:3px;font-size:10px;color:#555;cursor:pointer;`;
    const asCb = document.createElement('input');
    asCb.type = 'checkbox'; asCb.checked = _logAutoScroll; asCb.style.cursor = 'pointer';
    asCb.onchange = () => { _logAutoScroll = asCb.checked; };
    asLabel.appendChild(asCb);
    asLabel.appendChild(document.createTextNode('Auto'));
    ctrl.appendChild(asLabel);

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾 All logs';
    saveBtn.title = 'Download all accumulated logs (all sessions, all events) — up to ~100MB stored, oldest rotated out';
    saveBtn.style.cssText = `${btnStyle('#0e1a12')}font-size:11px;padding:1px 5px;color:#7ee787;border-color:#245a32;`;
    saveBtn.onclick = () => exportLogs();
    ctrl.appendChild(saveBtn);

    // ── 30-min log save button ──────────────────────────────────────────────
    const save30Btn = document.createElement('button');
    save30Btn.textContent = '⬇30m';
    save30Btn.title = 'Save last 30 minutes of logs (WS + console) as NDJSON';
    save30Btn.style.cssText = `${btnStyle('#0e1220')}font-size:10px;padding:1px 5px;color:#7bbfff;border-color:#2a3a5a;`;
    save30Btn.onclick = () => {
      const cutoff = Date.now() - 30 * 60 * 1000;
      const entries = wsRingBuffer.filter(e => e.ts >= cutoff);
      const blob = new Blob([entries.map(e => JSON.stringify(e)).join('\n')], { type: 'application/x-ndjson' });
      const a = document.createElement('a');
      const d = new Date(); const pad = n => String(n).padStart(2,'0');
      a.download = `roe-log-30m-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}.ndjson`;
      a.href = URL.createObjectURL(blob);
      a.click(); URL.revokeObjectURL(a.href);
    };
    ctrl.appendChild(save30Btn);


    // ── Persist-write toggle ─────────────────────────────────────────────────
    // Disables OPFS/IDB saving while keeping UI log and ring buffer fully intact.
    const persistBtn = document.createElement('button');
    const _updatePersistBtn = () => {
      persistBtn.textContent = _persistLogEnabled ? '🔴 REC' : '⬛ REC';
      persistBtn.title = _persistLogEnabled
        ? 'Persistent write ENABLED — click to stop saving to disk'
        : 'Persistent write DISABLED — click to resume saving to disk';
      persistBtn.style.cssText = `${btnStyle(_persistLogEnabled ? '#2a0a0a' : '#111')}` +
        `font-size:10px;padding:1px 6px;` +
        `color:${_persistLogEnabled ? '#ff6b6b' : '#555'};` +
        `border-color:${_persistLogEnabled ? '#c44' : '#333'};`;
    };
    _updatePersistBtn();
    persistBtn.onclick = () => {
      _persistLogEnabled = !_persistLogEnabled;
      try { localStorage.setItem('roe_persistLogEnabled', _persistLogEnabled ? '1' : '0'); } catch (_) {}
      // Leave a breadcrumb in the UI log so the operator can see when recording was toggled
      wsLog.push({
        ts: Date.now(), dir: 'SYS', event: 'persist_log_toggle',
        data: { enabled: _persistLogEnabled, note: _persistLogEnabled
          ? 'Persistent OPFS/IDB write RESUMED'
          : 'Persistent OPFS/IDB write PAUSED — UI log and ring buffer still active' }
      });
      if (wsLog.length > MAX_UI_EVENTS) wsLog.splice(0, wsLog.length - MAX_UI_EVENTS);
      _updatePersistBtn();
      renderLogPane();
    };
    ctrl.appendChild(persistBtn);

    // ── Full stop toggle — halts ALL logging (UI + ring buffer + persistent write) ──
    const stopAllBtn = document.createElement('button');
    const _updateStopAllBtn = () => {
      stopAllBtn.textContent = _allLogsStopped ? '⏹ STOPPED' : '⏹ Stop all';
      stopAllBtn.title = _allLogsStopped
        ? 'ALL logging is fully stopped (survives reload) — click to resume'
        : 'Fully stop ALL logging: UI log, ring buffer, console capture and persistent write — click to stop';
      stopAllBtn.style.cssText = `${btnStyle(_allLogsStopped ? '#3a0a0a' : '#111')}` +
        `font-size:10px;padding:1px 6px;font-weight:${_allLogsStopped ? 'bold' : 'normal'};` +
        `color:${_allLogsStopped ? '#ff6b6b' : '#555'};` +
        `border-color:${_allLogsStopped ? '#c44' : '#333'};`;
    };
    _updateStopAllBtn();
    stopAllBtn.onclick = () => {
      const enabling = !_allLogsStopped;
      const doToggle = () => {
        _allLogsStopped = !_allLogsStopped;
        try { localStorage.setItem('roe_allLogsStopped', _allLogsStopped ? '1' : '0'); } catch (_) {}
        _updateStopAllBtn();
        renderLogPane();
      };
      if (enabling) {
        showConfirm(stopAllBtn, 'Stop ALL logging (persists across reload)?', doToggle);
      } else {
        doToggle();
      }
    };
    ctrl.appendChild(stopAllBtn);

    // OPFS status badge — shows current log file size
    const opfsBadge = document.createElement('span');
    opfsBadge.style.cssText = `font-size:9px;color:#2a4a30;font-family:monospace;`;
    const opfsSt = persistentLogger._st;
    if (opfsSt.ready) {
      const mb = (opfsSt.fileSize / 1024 / 1024).toFixed(1);
      const backend = opfsSt.useIDB ? 'IDB' : 'OPFS';
      opfsBadge.textContent = `${backend} ${mb}MB`;
      opfsBadge.style.color = opfsSt.useIDB ? '#4a3a1a' : '#2a4a30';
      opfsBadge.title = opfsSt.useIDB
        ? 'Using IndexedDB fallback (OPFS unavailable)'
        : `OPFS log: wslog.ndjson  ${mb} MB written this session`;
    } else {
      opfsBadge.textContent = 'logger…';
    }
    ctrl.appendChild(opfsBadge);

    // Ring buffer download — exports ALL events (incl. filtered) for last 5 min
    const ringBtn = document.createElement('button');
    ringBtn.title = `Download ALL WebSocket events from the last 5 minutes (incl. filtered events like move, ping, stats…)`;
    ringBtn.style.cssText = `${btnStyle('#0e1a2a')}font-size:10px;padding:1px 6px;color:#7bbfff;border-color:#1e3a5a;`;
    const updateRingBtnLabel = () => {
      ringBtn.textContent = `⏺ 5m (${wsRingBuffer.length})`;
    };
    updateRingBtnLabel();
    ringBtn.onclick = () => {
      trimRingBuffer();
      if (!wsRingBuffer.length) { ringBtn.title = 'Ring buffer is empty — no events yet'; return; }
      const cutoff5m = Date.now() - 5 * 60 * 1000;
      const entries5m = wsRingBuffer.filter(e => e.ts >= cutoff5m);
      const blob = new Blob([entries5m.map(e => JSON.stringify(e)).join('\n')], { type: 'application/x-ndjson' });
      const a = document.createElement('a');
      const d = new Date(); const pad = n => String(n).padStart(2,'0');
      a.download = `roe-log-5m-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}.ndjson`;
      a.href = URL.createObjectURL(blob);
      a.click(); URL.revokeObjectURL(a.href);
      updateRingBtnLabel();
    };
    // Keep count live while log tab is open
    const ringCountInterval = setInterval(updateRingBtnLabel, 2000);
    // Clean up interval when the log pane is next re-rendered (innerHTML cleared)
    const ringObserver = new MutationObserver(() => {
      clearInterval(ringCountInterval);
      ringObserver.disconnect();
    });
    ringObserver.observe(logPane, { childList: true });
    ctrl.appendChild(ringBtn);

    const capBtn = document.createElement('button');
    capBtn.textContent = _captureAll ? '🔴 All' : '⚫ All';
    capBtn.title = _captureAll ? 'Capture ALL events (click to disable)' : 'Enable capture of ALL events incl. filtered';
    capBtn.style.cssText = `${btnStyle(_captureAll ? '#3a1a1a' : '#111')}font-size:10px;padding:1px 6px;color:${_captureAll ? '#ff6b6b' : '#555'};border-color:${_captureAll ? '#c44' : '#222'};`;
    capBtn.onclick = () => {
      _captureAll = !_captureAll;
      if (_captureAll) {
        wsLog.push({ ts: Date.now(), dir: 'SYS', event: 'capture_all', data: { enabled: true, note: 'All WS events are now logged including filtered ones' } });
      } else {
        wsLog.push({ ts: Date.now(), dir: 'SYS', event: 'capture_all', data: { enabled: false } });
      }
      renderLogPane();
    };
    ctrl.appendChild(capBtn);

    const clrBtn = document.createElement('button');
    clrBtn.textContent = 'Clear';
    clrBtn.title = 'Clear UI log buffer (does not delete persistent OPFS/IDB files)';
    clrBtn.style.cssText = `${btnStyle('#1a1410')}font-size:10px;padding:1px 6px;`;
    clrBtn.onclick = () => { wsLog.length = 0; wsLogSkippedCount = 0; renderLogPane(); };
    ctrl.appendChild(clrBtn);

    const clrAllBtn = document.createElement('button');
    clrAllBtn.textContent = '🗑 All';
    clrAllBtn.title = 'Delete ALL logs: UI buffer + persistent OPFS/IDB files (irreversible!)';
    clrAllBtn.style.cssText = `${btnStyle('#1a0a0a')}font-size:10px;padding:1px 6px;color:#ff6b6b;border-color:#7a2020;`;
    clrAllBtn.onclick = () => {
      showConfirm(clrAllBtn, 'Delete ALL logs (OPFS + UI)?', async () => {
        clrAllBtn.textContent = '⏳';
        clrAllBtn.disabled = true;
        await clearAllLogs();
        clrAllBtn.textContent = '🗑 All';
        clrAllBtn.disabled = false;
        renderLogPane();
      });
    };
    ctrl.appendChild(clrAllBtn);

    _fp_log.appendChild(ctrl);

    if (wsLog.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:#333;padding:20px;text-align:center;font-size:11px;`;
      empty.textContent = 'Waiting for WebSocket events…';
      _fp_log.appendChild(empty);
      return;
    }

    const list = document.createElement('div');

    const entries = _logFilter === 'ALL'
      ? wsLog
      : wsLog.filter(e => e.dir === _logFilter);

    entries.forEach(entry => {
      const row = document.createElement('div');
      const isSys = entry.dir === 'SYS';
      const isIn  = entry.dir === 'IN';
      const isCon = entry.dir === 'CON';
      const accent = isSys ? '#9b7fff' : isIn ? '#4caf50' : isCon ? '#f0c040' : '#ff9800';
      row.style.cssText = `
        padding:3px 6px;border-bottom:1px solid #111;
        display:flex;align-items:baseline;gap:5px;font-size:10px;
        background:${isSys ? 'rgba(155,127,255,0.04)' : isIn ? 'rgba(76,175,80,0.03)' : isCon ? 'rgba(240,192,64,0.04)' : 'rgba(255,152,0,0.03)'};
      `;

      const ts = new Date(entry.ts).toLocaleTimeString([], { hour12: false });
      row.innerHTML = `
        <span style="color:#333;flex-shrink:0">${ts}</span>
        <span style="color:${accent};font-weight:bold;flex-shrink:0;width:22px">${entry.dir}</span>
        <span style="color:#7b8fff;flex-shrink:0">${entry.event}</span>
      `;

      if (entry.data !== undefined) {
        let preview = '';
        try {
          preview = JSON.stringify(entry.data);
          if (preview.length > 80) preview = preview.slice(0, 80) + '…';
        } catch (e) { preview = String(entry.data); }

        const dataEl = document.createElement('span');
        dataEl.style.cssText = `color:#444;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;cursor:pointer;`;
        dataEl.textContent = preview;
        dataEl.title = 'Click to expand';

        let expanded = false;
        dataEl.onclick = e => {
          e.stopPropagation();
          expanded = !expanded;
          if (expanded) {
            try { dataEl.textContent = JSON.stringify(entry.data, null, 2); }
            catch (_) { dataEl.textContent = String(entry.data); }
            dataEl.style.whiteSpace = 'pre-wrap';
            dataEl.style.color = '#666';
            dataEl.style.wordBreak = 'break-all';
          } else {
            dataEl.textContent = preview;
            dataEl.style.whiteSpace = 'nowrap';
            dataEl.style.color = '#444';
            dataEl.style.wordBreak = '';
          }
        };
        row.appendChild(dataEl);
      }

      list.appendChild(row);
    });

    _fp_log.appendChild(list);

    if (_logAutoScroll) content.scrollTop = content.scrollHeight;
  }

  // ─── Damage Log pane (Feed / Stats sub-tabs inside one panel) ──────────────
  function fmtDmg(n) {
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(n));
  }

  function _renderDamageFeedSection(container) {
    // ─ Feed filter row ─
    const ctrl = document.createElement('div');
    ctrl.style.cssText = `padding:4px 6px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #1e2030;`;
    [['ALL', 'All'], ['dealt', 'Dealt'], ['incoming', 'Taken'], ['death', 'Deaths']].forEach(([key, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      const active = _damageFeedFilter === key;
      b.style.cssText = `
        background:${active ? '#1a2e3a' : '#111'};
        color:${active ? '#7bbfff' : '#555'};
        border:1px solid ${active ? '#3a5e7a' : '#222'};
        border-radius:3px;padding:1px 7px;cursor:pointer;font-size:10px;font-family:monospace;
      `;
      b.onclick = () => { _damageFeedFilter = key; renderDamagePane(); };
      ctrl.appendChild(b);
    });
    container.appendChild(ctrl);

    // ─ Feed ─
    if (_damageFeed.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:#333;padding:20px;text-align:center;font-size:11px;`;
      empty.textContent = 'No combat events yet this session…';
      container.appendChild(empty);
      return;
    }

    const filtered = _damageFeedFilter === 'ALL' ? _damageFeed
      : _damageFeedFilter === 'dealt' ? _damageFeed.filter(e => e.kind === 'hit' || e.kind === 'kill')
      : _damageFeed.filter(e => e.kind === _damageFeedFilter);

    const list = document.createElement('div');
    filtered.forEach(e => {
      const row = document.createElement('div');
      row.style.cssText = `
        display:flex;justify-content:space-between;align-items:center;gap:6px;
        padding:3px 8px;border-bottom:1px solid #161822;font-size:11px;font-family:monospace;
      `;
      const time = new Date(e.ts).toLocaleTimeString();
      let left, right;
      if (e.kind === 'kill' || e.kind === 'hit') {
        left = `<span style="color:#555;">${time}</span> <span style="color:#ccc;">${escapeHtml(formatDisplayName(e.enemyType || '?'))}</span>`;
        right = `<span style="color:#81c784;">${e.kind === 'kill' ? '⚔ kill · ' : ''}${e.isCritical ? '💥' : ''}${fmtDmg(e.damage)}</span>`;
      } else if (e.kind === 'incoming') {
        left = `<span style="color:#555;">${time}</span> <span style="color:#ccc;">${escapeHtml(e.enemyType ? formatDisplayName(e.enemyType) : '?')}</span>`;
        right = e.blocked
          ? `<span style="color:#7bbfff;">🛡 blocked</span>`
          : `<span style="color:#e57373;">${fmtDmg(e.damage)}</span>`;
      } else { // death
        left = `<span style="color:#555;">${time}</span> <span style="color:#e57373;">💀 Died</span>`;
        right = e.enemyType ? `<span style="color:#888;">killed by ${escapeHtml(e.enemyType)}</span>` : '';
      }
      row.innerHTML = `<span>${left}</span><span>${right}</span>`;
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  function _renderDamageStatsSection(container) {
    const s = _damageStats;
    const blockRate = (s.blockedCount + s.unblockedCount) > 0
      ? Math.round(100 * s.blockedCount / (s.blockedCount + s.unblockedCount)) : null;
    const critRate = s.hits > 0 ? Math.round(100 * s.crits / s.hits) : null;
    const kd = s.deaths > 0 ? (s.kills / s.deaths).toFixed(1) : (s.kills > 0 ? '∞' : '0');

    const summary = document.createElement('div');
    summary.style.cssText = `
      display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;
      padding:8px 8px 6px;font-size:11px;
    `;
    const stat = (label, value, color) => `
      <div style="display:flex;justify-content:space-between;">
        <span style="color:#555;">${label}</span>
        <span style="color:${color || '#ccc'};font-family:monospace;font-weight:bold;">${value}</span>
      </div>`;
    summary.innerHTML =
        stat('Dmg dealt', fmtDmg(s.dmgDealt), '#81c784')
      + stat('Dmg taken', fmtDmg(s.dmgTaken), '#e57373')
      + stat('Kills', s.kills, '#81c784')
      + stat('Deaths', s.deaths, '#e57373')
      + stat('Blocked', blockRate !== null ? `${blockRate}%` : '—', '#7bbfff')
      + stat('Crit rate', critRate !== null ? `${critRate}%` : '—', '#ffb74d')
      + stat('K/D', kd, '#ccc')
      + stat('Hits', s.hits, '#ccc');

    // Per-enemy breakdown (top 5 by damage dealt, only if we have any)
    const enemyRows = Object.entries(s.byEnemy)
      .sort((a, b) => (b[1].dmgDealt + b[1].dmgTaken) - (a[1].dmgDealt + a[1].dmgTaken))
      .slice(0, 5);
    if (enemyRows.length) {
      const brk = document.createElement('div');
      brk.style.cssText = `grid-column:1 / -1;margin-top:4px;border-top:1px solid #1e2030;padding-top:4px;`;
      brk.innerHTML = enemyRows.map(([name, st]) => `
        <div style="display:flex;justify-content:space-between;color:#888;font-size:10px;padding:1px 0;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;">${escapeHtml(formatDisplayName(name))}</span>
          <span style="font-family:monospace;">
            <span style="color:#81c784;">${fmtDmg(st.dmgDealt)}</span> /
            <span style="color:#e57373;">${fmtDmg(st.dmgTaken)}</span>
            ${st.kills ? ` · ⚔${st.kills}` : ''}${st.timesKilledBy ? ` · 💀${st.timesKilledBy}` : ''}
          </span>
        </div>`).join('');
      summary.appendChild(brk);
    }

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset stats';
    resetBtn.title = 'Clear all-time totals (does not affect the persistent WS log)';
    resetBtn.style.cssText = `${btnStyle('#1a0a0a')}font-size:10px;padding:1px 6px;color:#ff6b6b;border-color:#7a2020;margin-top:6px;grid-column:1 / -1;width:fit-content;`;
    resetBtn.onclick = () => {
      showConfirm(resetBtn, 'Reset all-time stats?', () => {
        _damageStats = _emptyDamageStats();
        try { localStorage.setItem(DAMAGE_LOG_STORAGE_KEY, JSON.stringify({ stats: _damageStats })); } catch (_) {}
        renderDamagePane();
      });
    };
    summary.appendChild(resetBtn);

    container.appendChild(summary);
  }

  function renderDamagePane() {
    const _fp_damage = _paneFor('damage', damagePane);
    if (!_fp_damage) return;
    if (_fp_damage === damagePane && _poppedOut.has('damage')) return;

    // ─ Sub-tab switcher (Feed / Stats) ─
    const subTabs = document.createElement('div');
    subTabs.style.cssText = `display:flex;border-bottom:1px solid #1e2030;position:sticky;top:0;z-index:1;background:#0e1018;`;
    [['feed', '📜 Feed'], ['stats', '⚡ Stats']].forEach(([key, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      const active = _damageSubTab === key;
      b.style.cssText = `
        flex:1;padding:5px 0;cursor:pointer;font-size:11px;font-family:inherit;
        background:${active ? '#161c2c' : 'transparent'};
        color:${active ? '#7bbfff' : '#666'};
        border:none;border-bottom:2px solid ${active ? '#4a8fd6' : 'transparent'};
      `;
      b.onclick = () => { _damageSubTab = key; renderDamagePane(); };
      subTabs.appendChild(b);
    });
    _fp_damage.appendChild(subTabs);

    if (_damageSubTab === 'stats') _renderDamageStatsSection(_fp_damage);
    else _renderDamageFeedSection(_fp_damage);
  }

  // ─── Counter ─────────────────────────────────────────────────────────────────
  function updateCount() {
    const zoneCount = Object.keys(lastStateByZone).length;
    const el = document.getElementById('roeSpawnCount');
    if (el) el.textContent = _compactMode === 'micro' ? zoneCount : `${zoneCount} zones`;
  }

  // ─── Toast (tracking) ────────────────────────────────────────────────────────
  let _trackToastOffset = 0;

  // ─── Batch notification queue ─────────────────────────────────────────────────
  // Collects notifyTrack calls fired within NOTIFY_BATCH_MS of each other
  // and collapses them into a single summary toast.
  const NOTIFY_BATCH_MS = 600;
  let _notifyBatchTimer  = null;
  let _notifyBatchItems  = []; // { trackEntry, msg }
  let trackAudioCtx     = null;

  function ensureTrackAudioContext() {
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return null;
    if (!trackAudioCtx) trackAudioCtx = new A();
    return trackAudioCtx;
  }
  function unlockTrackAudio() {
    const ctx = ensureTrackAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  function playTrackNotificationSound(trackEntry) {
    if (!notificationPrefs.soundEnabled) return;
    const ctx = ensureTrackAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); if (ctx.state === 'suspended') return; }
    const tones = trackEntry?.kind === 'mob' ? [880, 660] : [740, 988];
    const startAt = ctx.currentTime;
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      const start = startAt + i * 0.16, stop = start + 0.14;
      osc.type = 'sine'; osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.055, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, stop);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(start); osc.stop(stop);
    });
  }
  async function requestDesktopNotificationPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied')  return 'denied';
    try { return await Notification.requestPermission(); } catch (e) { return 'denied'; }
  }
  function pushTrackDesktopNotification(trackEntry) {
    if (!notificationPrefs.desktopEnabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // Count nodes with no confirmed-dead timer (or an expired one) as alive/
    // active too — matches the orange "probably up" dots in the in-app Track
    // panel, instead of only counting server-confirmed state (which stays at
    // e.g. "0/10 alive" until the zone is actually visited).
    const honestAliveCount = trackEntry.kind === 'mob'
      ? trackEntry.nodes.filter(n => n.alive).length
      : trackEntry.nodes.filter(n => n.active).length;
    const count = trackEntry.kind === 'mob'
      ? `${trackEntry.nodes.filter(n => {
          if (n.alive) return true;
          let rtRaw = enemyRespawnTimers.get(n.id) || null;
          if (!rtRaw && n.pos) {
            const pk = _mobPosKey(trackEntry.zone, trackEntry.statsKey, n.pos);
            rtRaw = _stableMobTimers[pk] || null;
          }
          return (!rtRaw) || rtRaw <= Date.now();
        }).length}/${trackEntry.nodes.length} alive`
      : `${trackEntry.nodes.filter(n => {
          if (n.active) return true;
          const t = getNodeMaxTimer(n.idx);
          return (!t) || t <= Date.now();
        }).length}/${trackEntry.nodes.length} active`;
    const name = trackEntry.kind === 'mob' ? trackEntry.statsKey : trackEntry.resource;
    addSysLog('notify_debug_desktop', {
      kind: trackEntry.kind, name, zone: trackEntry.zone,
      honestAliveCount, bodyCountText: count, totalNodes: trackEntry.nodes.length,
      ts: Date.now()
    });
    const note = new Notification('ROE Spawn Tracker', {
      body: `[${trackEntry.zone}] ${name}\n${count}`,
      tag:  `roe-track-${trackEntry.kind}-${trackEntry.zone}-${name}`
    });
    note.onclick = () => { window.focus(); note.close(); };
    setTimeout(() => note.close(), 8000);
  }

  window.addEventListener('pointerdown', unlockTrackAudio, { passive: true });
  window.addEventListener('keydown',     unlockTrackAudio);

  function _flushNotifyBatch() {
    _notifyBatchTimer = null;
    const items = _notifyBatchItems.splice(0);
    if (!items.length) return;

    // Separate system messages (trackEntry=null) from spawn alerts
    const sysItems    = items.filter(it => !it.trackEntry);
    const spawnItems  = items.filter(it =>  it.trackEntry);

    // System messages each get their own plain toast (unchanged behaviour)
    sysItems.forEach(it => _showToast(null, it.msg));

    if (!spawnItems.length) return;

    if (spawnItems.length === 1) {
      // Single spawn — original detailed toast
      _showToast(spawnItems[0].trackEntry, null);
      return;
    }

    // ── Batch summary toast ───────────────────────────────────────────────────
    // Play sound once for the highest-priority entry (mob > res)
    const mobItem = spawnItems.find(it => it.trackEntry.kind === 'mob');
    const repItem = mobItem || spawnItems[0];
    playTrackNotificationSound(repItem.trackEntry);

    // Single summary desktop notification for the whole batch
    if (notificationPrefs.desktopEnabled &&
        typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const lines = spawnItems.map(it => {
        const te = it.trackEntry;
        const name = te.kind === 'mob' ? te.statsKey : te.resource;
        return `[${te.zone}] ${name}`;
      });
      const note = new Notification('ROE Spawn Tracker', {
        body: `🔔 ${spawnItems.length} объектов готово:\n${lines.join('\n')}`,
        tag:  'roe-track-batch'
      });
      note.onclick = () => { window.focus(); note.close(); };
      setTimeout(() => note.close(), 8000);
    }

    // Build compact list: "🗡 Mob [Zone]  🌿 Res [Zone] ..."
    const lines = spawnItems.map(it => {
      const te = it.trackEntry;
      if (te.kind === 'mob') {
        return `${mobIcon()} <b style="color:#ffb74d">${formatDisplayName(te.statsKey)}</b> <span style="color:#666">[${te.zone}]</span>`;
      } else {
        const tc = resTypeColor(te.type);
        return `${resIcon(te.type)} <b style="color:${tc}">${formatResName(te.resource)}</b> <span style="color:#666">[${te.zone}]</span>`;
      }
    });

    const warnIds = ['roeClaimWarn', 'roeRunestoneWarn', 'roeToolWarn', 'roeDurWarn'];
    const warnBottom = warnIds.reduce((acc, id) => {
      const el = document.getElementById(id);
      if (!el || el.style.display === 'none') return acc;
      return Math.max(acc, el.offsetTop + el.offsetHeight + 8);
    }, 15);

    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed;top:${warnBottom + _trackToastOffset}px;left:50%;transform:translateX(-50%);z-index:9999999;
      background:rgba(8,12,28,0.95);border:2px solid #7b8fff;border-radius:10px;
      padding:10px 28px 10px 18px;color:#fff;font-family:'Consolas',monospace;font-size:14px;font-weight:bold;
      box-shadow:0 0 10px rgba(123,143,255,0.8),0 0 30px rgba(123,143,255,0.4),0 4px 16px rgba(0,0,0,0.8);
      transition:opacity 0.5s;pointer-events:none;line-height:1.7;
    `;
    toast.innerHTML =
      `<div style="color:#9cf;font-size:11px;margin-bottom:4px">🔔 ${spawnItems.length} объектов готово:</div>` +
      lines.join('<br>');
    _trackToastOffset += Math.min(200, 30 + spawnItems.length * 22);
    document.body.appendChild(toast);
    const toastH = _trackToastOffset;
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { toast.remove(); _trackToastOffset = Math.max(0, _trackToastOffset - toastH); }, 500);
    }, 4500);
  }

  function _showToast(trackEntry, msg) {
    // Calculate top offset accounting for visible warnings
    const warnIds = ['roeClaimWarn', 'roeRunestoneWarn', 'roeToolWarn', 'roeDurWarn'];
    const warnBottom = warnIds.reduce((acc, id) => {
      const el = document.getElementById(id);
      if (!el || el.style.display === 'none') return acc;
      return Math.max(acc, el.offsetTop + el.offsetHeight + 8);
    }, 15);
    const offset     = _trackToastOffset;
    _trackToastOffset += 80;
    const isMob   = !!trackEntry && trackEntry.kind === 'mob';
    const accent  = isMob ? '#ff9800' : '#4caf50';
    const shadow  = isMob ? 'rgba(255,152,0,0.8)' : 'rgba(76,175,80,0.8)';
    const shadow2 = isMob ? 'rgba(255,152,0,0.4)' : 'rgba(76,175,80,0.4)';

    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed;top:${warnBottom + offset}px;left:50%;transform:translateX(-50%);z-index:9999999;
      background:rgba(8,12,28,0.95);border:2px solid ${accent};border-radius:10px;
      padding:9px 26px 9px 18px;color:#fff;font-family:'Consolas',monospace;font-size:18px;font-weight:bold;
      box-shadow:0 0 10px ${shadow},0 0 30px ${shadow2},0 4px 16px rgba(0,0,0,0.8);
      transition:opacity 0.5s;pointer-events:none;white-space:nowrap;
    `;

    if (trackEntry) {
      playTrackNotificationSound(trackEntry);
      pushTrackDesktopNotification(trackEntry);
      if (isMob) {
        toast.innerHTML = `${mobIcon()} <b style="color:#ffb74d">${formatDisplayName(trackEntry.statsKey)}</b> [${trackEntry.zone}]<br>
          <span style="color:#888;font-size:10px">${trackEntry.nodes.filter(n => n.alive).length}/${trackEntry.nodes.length} alive</span>`;
      } else {
        const tc = resTypeColor(trackEntry.type);
        toast.innerHTML = `${resIcon(trackEntry.type)} <b style="color:${tc}">${formatResName(trackEntry.resource)}</b> [${trackEntry.zone}]<br>
          <span style="color:#888;font-size:10px">${trackEntry.nodes.filter(n => n.active).length}/${trackEntry.nodes.length} active</span>`;
      }
    } else {
      toast.innerHTML = `<span style="color:#9cf">${msg}</span>`;
    }

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { toast.remove(); _trackToastOffset = Math.max(0, _trackToastOffset - 80); }, 500);
    }, 3500);
  }

  function notifyTrack(trackEntry, msg) {
    if (!notificationPrefs.toastEnabled) {
      if (trackEntry) { playTrackNotificationSound(trackEntry); pushTrackDesktopNotification(trackEntry); }
      return;
    }
    // System messages (no trackEntry) bypass batching — show immediately
    if (!trackEntry) {
      _showToast(null, msg);
      return;
    }
    // Queue spawn notification for batch flush
    _notifyBatchItems.push({ trackEntry, msg });
    if (_notifyBatchTimer) clearTimeout(_notifyBatchTimer);
    _notifyBatchTimer = setTimeout(_flushNotifyBatch, NOTIFY_BATCH_MS);
  }

  // ─── Check tracked on new data ───────────────────────────────────────────────
  function checkTrackedResources(zone, resources, silent) {
    const playerInZone = _currentZone === zone;
    let changed = false;
    trackedResources.forEach((v, id) => {
      if (v.zone !== zone) return;
      changed = true;
      const newNodes    = resources.map((r, i) => ({ ...r, idx: typeof r.idx === 'number' ? r.idx : i })).filter(r => r.resource === v.resource);
      v.nodes           = newNodes;
      const activeCount = newNodes.filter(n => n.active).length;
      // Per-node "ready" for notification purposes — same in-zone/away-zone
      // split as checkTrackedMobs: in-zone, only trust a server-confirmed
      // active node; away from the zone, fall back to the timer since
      // nothing will ever confirm active for us while we're not there.
      const nodeReady = n => {
        if (n.active) return true;
        if (playerInZone) return false;
        return !getNodeMaxTimer(n.idx);
      };
      const readyCount = newNodes.filter(nodeReady).length;

      if (v.notifyOnSpawn) {
        const totalN = newNodes.length;
        const fullSlots = !v.notifyOnlyWhenFull || totalN === 0 || readyCount === totalN;
        newNodes.forEach(n => {
          const nodeKey = `${id}:${n.idx}`;
          const wasReady = previousNodeReadyState.get(nodeKey);
          const isReady = nodeReady(n);
          if (!silent && fullSlots && wasReady === false && isReady) {
            addSysLog('notify_debug_res', {
              source: 'live', trackId: id, resource: v.resource, zone, nodeIdx: n.idx,
              playerInZone, active: n.active, pos: n.pos || null,
              wasReady, isReady, notifyOnlyWhenFull: !!v.notifyOnlyWhenFull,
              readyCount, totalN, ts: Date.now()
            });
            notifyTrack(v, n.pos
              ? `[${zone}] ${formatResName(v.resource)} spawned at x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
              : null);
          }
          previousNodeReadyState.set(nodeKey, isReady);
        });
      }

      previousTrackedStates.set(id, { activeCount, readyCount });
    });
    if (changed) saveTracked();
  }

  function checkTrackedMobs(zone, enemies, silent) {
    const playerInZone = _currentZone === zone;
    let changed = false;
    trackedMobs.forEach((v, id) => {
      if (v.zone !== zone) return;
      changed = true;
      const newNodes   = enemies.map((e, i) => ({ ...e, idx: i })).filter(e => e.statsKey === v.statsKey);
      v.nodes          = newNodes;
      const aliveCount = newNodes.filter(n => n.alive).length;
      // Per-node "ready" for notification purposes:
      //  - player IS in this zone: only trust a server-confirmed alive node —
      //    we can see it appear, so there's no reason to fire early on a
      //    possibly-wrong estimated timer.
      //  - player NOT in this zone: dead-without-timer counts as ready too,
      //    since nothing will ever confirm alive for us while we're away.
      const mobReady = n => {
        if (n.alive) return true;
        if (playerInZone) return false;
        let rt = enemyRespawnTimers.get(n.id);
        if (!rt && n.pos) { const pk = _mobPosKey(zone, v.statsKey, n.pos); rt = _stableMobTimers[pk]; }
        return !rt;
      };
      const readyCount = newNodes.filter(mobReady).length;

      if (v.notifyOnSpawn) {
        const totalN = newNodes.length;
        const fullSlots = !v.notifyOnlyWhenFull || totalN === 0 || readyCount === totalN;
        newNodes.forEach(n => {
          const nodeKey = `${id}:${n.id}`;
          const wasReady = previousNodeReadyState.get(nodeKey);
          const isReady = mobReady(n);
          if (!silent && fullSlots && wasReady === false && isReady) {
            addSysLog('notify_debug_mob', {
              source: 'live', trackId: id, statsKey: v.statsKey, zone, nodeId: n.id,
              playerInZone, alive: n.alive, pos: n.pos || null,
              wasReady, isReady, notifyOnlyWhenFull: !!v.notifyOnlyWhenFull,
              readyCount, totalN, ts: Date.now()
            });
            notifyTrack(v, n.pos
              ? `[${zone}] ${formatDisplayName(v.statsKey)} spawned at x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
              : null);
          }
          previousNodeReadyState.set(nodeKey, isReady);
        });
      }

      previousTrackedMobStates.set(id, { aliveCount, readyCount });
    });
    if (changed) saveTracked();
  }

  // ─── Main data handler ───────────────────────────────────────────────────────
  function handleSpawnState(data) {
    const zone      = data.zone;
    const enemies   = Array.isArray(data.enemies)   ? data.enemies   : [];
    const resources = Array.isArray(data.resources) ? data.resources : [];

    const prevZone = _currentZone;
    _currentZone = zone;

    if (prevZone !== zone) {
      _pendingSplitFlip = null; // real zone confirmed — preview flip no longer needed
      _stairsPreviewDwellStart = null;
      const wasRestricted = prevZone && ZONE_RESTRICTED.has(prevZone);
      const nowRestricted = ZONE_RESTRICTED.has(zone);
      if (wasRestricted || nowRestricted) {
        addSysLog('zone_tracking_filter', {
          from: prevZone,
          to: zone,
          hidden: Array.from(ZONE_RESTRICTED).filter(z => z !== zone),
          visible: nowRestricted ? [zone] : [],
          note: `Restricted zones (${Array.from(ZONE_RESTRICTED).join(', ')}) only shown in tracking while inside them`
        });
      }
      // Freshly walked into the maze from Town/Forest/House (incl. after a death
      // respawn) → remember this spot as "a way out". Nothing is cleared —
      // old trail points and previously-recorded entrances stick around; only
      // the 🗑️ button wipes them. Different doors get their own point instead
      // of overwriting each other (see _addUniqueGate).
      if (MAZE_ZONES.has(zone) && !MAZE_ZONES.has(prevZone) && _playerPos) {
        if (_addUniqueGate(_mazeEntries, _playerPos)) saveMazeEntries();
        _mapView = null; _mapDisplayPlayer = null; _mapInterp = null; // snap to the current area instead of panning across
        _mapZoneEnterT = Date.now();
        _mapPanX = 0; _mapPanY = 0;
        _saveMapPan();
        _mazeMoveHist = [];
        _mazeLastPushedKey = null;
        _mazeLastRawPos = null;
        _stairsPreviewArmed = false; // must walk away from any known stair before a preview flip can trigger
        _stairsPreviewDwellStart = null;
      }
      // Mines<->MinesLower (either direction) is an internal transition, not a
      // fresh entry from Town — the coordinate space carries over, so
      // _playerPos at the moment of the flip is exactly the staircase spot.
      if (MAZE_ZONES.has(prevZone) && MAZE_ZONES.has(zone) && prevZone !== zone && _playerPos) {
        if (!_isBlacklistedStair(_playerPos) && _addUniqueGate(_mazeStairs, _playerPos, STAIRS_DEDUP_DIST)) saveMazeStairs();
        _stairsPreviewArmed = false; // just arrived at this exact stair — don't immediately preview-flip back
        _stairsPreviewDwellStart = null;
      }
      // Walked out of the maze back to Town/Forest/House — the last point pushed
      // during this visit may just be the exit-adjacent move whose position
      // update lands right as the zone flips, landing a stray dot outside where
      // we actually walked. Undo only that one point (never older trail data).
      if (MAZE_ZONES.has(prevZone) && !MAZE_ZONES.has(zone) && _mazeLastPushedKey) {
        const last = _mazeTrail[_mazeTrail.length - 1];
        if (last && _trailCellKey(last) === _mazeLastPushedKey) {
          _mazeTrail.pop();
          _mazeTrailSeen.delete(_mazeLastPushedKey);
          saveMazeTrail();
        }
        _mazeLastPushedKey = null;
      }
      // Same stray-point cleanup, but for whichever per-zone split trail
      // (Mines/MinesLower) was active just before this transition — covers
      // both leaving the maze entirely and crossing the internal staircase.
      if (prevZone === 'Mines' && zone !== 'Mines' && _minesLastPushedKey) {
        const last = _minesTrail[_minesTrail.length - 1];
        if (last && _trailCellKey(last) === _minesLastPushedKey) {
          _minesTrail.pop();
          _minesTrailSeen.delete(_minesLastPushedKey);
          saveMinesTrail();
        }
        _minesLastPushedKey = null;
      }
      if (prevZone === 'MinesLower' && zone !== 'MinesLower' && _minesLowerLastPushedKey) {
        const last = _minesLowerTrail[_minesLowerTrail.length - 1];
        if (last && _trailCellKey(last) === _minesLowerLastPushedKey) {
          _minesLowerTrail.pop();
          _minesLowerTrailSeen.delete(_minesLowerLastPushedKey);
          saveMinesLowerTrail();
        }
        _minesLowerLastPushedKey = null;
      }
      // Same idea as above, for Forest (its own single zone, not a shared space).
      // Runs on ANY entry into Forest, including from Mines — the map view
      // and interpolation state are per-widget (not per-zone-pair), so
      // skipping this reset when prevZone is Mines left the old Mines-space
      // _mapDisplayPlayer/_mapInterp in place; the next tick would then lerp
      // from wherever the dot sat in Mines all the way to the new Forest
      // position, reading as the marker flying across a huge distance.
      if (FOREST_ZONES.has(zone) && !FOREST_ZONES.has(prevZone) && _playerPos) {
        // Only Town↔Forest crossings mark the green exit square — entering
        // Forest from Mines (a direct connection, no Town in between) must
        // not move it, or the marker drifts onto whatever spot the maze
        // happened to spit the player out at.
        if (prevZone === 'Town') {
          _forestEntry = { x: _playerPos.x, y: _playerPos.y };
          saveForestEntry();
        }
        _mapView = null; _mapDisplayPlayer = null; _mapInterp = null;
        _mapZoneEnterT = Date.now();
        _mapPanX = 0; _mapPanY = 0;
        _saveMapPan();
        _forestMoveHist = [];
        _forestLastPushedKey = null;
        _forestLastRawPos = null;
      }
      // Walked from Forest straight into the maze (no Town in between) — record
      // where that door sits on the FOREST map. The transitional move event's
      // position is already in the new zone's coordinate space (see the
      // stray-trail-point fix below), so the true Forest-side spot is the
      // *previous* sample, not _playerPos.
      if (FOREST_ZONES.has(prevZone) && MAZE_ZONES.has(zone)) {
        const forestSidePoint = _forestMoveHist.length >= 2 ? _forestMoveHist[0] : _playerPos;
        if (forestSidePoint && _addUniqueGate(_forestDungeonEntries, forestSidePoint)) saveForestDungeonEntries();
      }
      if (FOREST_ZONES.has(prevZone) && !FOREST_ZONES.has(zone) && _forestLastPushedKey) {
        const last = _forestTrail[_forestTrail.length - 1];
        if (last && _trailCellKey(last) === _forestLastPushedKey) {
          _forestTrail.pop();
          _forestTrailSeen.delete(_forestLastPushedKey);
          saveForestTrail();
        }
        _forestLastPushedKey = null;
      }
      // Same idea as Forest/Mines above, generalized for any user-added
      // custom minimap zone (see _addCustomMinimapForCurrentZone).
      if (_isCustomMapZone(zone) && zone !== prevZone) {
        const entry = _customMapEntry(zone);
        entry.moveHist = [];
        entry.lastPushedKey = null;
        entry.lastRawPos = null;
        _mapView = null; _mapDisplayPlayer = null; _mapInterp = null;
        _mapZoneEnterT = Date.now();
        _mapPanX = 0; _mapPanY = 0;
        _saveMapPan();
      }
      if (_isCustomMapZone(prevZone) && prevZone !== zone) {
        const entry = _customMapEntry(prevZone);
        if (entry.lastPushedKey) {
          const last = entry.trail[entry.trail.length - 1];
          if (last && _trailCellKey(last) === entry.lastPushedKey) {
            entry.trail.pop();
            entry.seen.delete(entry.lastPushedKey);
            _saveCustomTrail(prevZone);
          }
          entry.lastPushedKey = null;
        }
      }
    }

    const isFirstSeen = !_seenZones.has(zone);
    _seenZones.add(zone);
    saveSeenZones();
    addSysLog('spawn_state', { zone, enemies: enemies.length, resources: resources.length, first: isFirstSeen });

    knownZones.add(zone);
    lastStateByZone[zone] = enemies;
    enemies.forEach(e => knownTypes.add(e.statsKey));

    const now = Date.now();
    let _stableDirty = false;
    enemies.forEach(e => {
      if (!e.alive && typeof e.respawnAt === 'number' && e.respawnAt > now) {
        enemyRespawnTimers.set(e.id, e.respawnAt);
        // Also persist with position-based key so it survives session ID changes on reload
        if (e.pos) {
          const pk = _mobPosKey(zone, e.statsKey, e.pos);
          _stableMobTimers[pk] = e.respawnAt;
          _stableDirty = true;
        }
        // If we recorded a kill time for this entity, compute actual duration
        // and store it so future kills show the timer immediately.
        const killTime = _recentKillTimes.get(e.id);
        if (killTime) {
          const duration = e.respawnAt - killTime;
          // Guard: respawnAt that predates (or lands implausibly soon after)
          // our own kill almost certainly belongs to a PREVIOUS death cycle
          // of this entity slot, not the kill we just recorded — training on
          // it silently drags knownRespawnDurations short, which is exactly
          // what made the orange "probably up" timer fire early. Require at
          // least 5s of daylight between kill and respawnAt before trusting it.
          const MIN_PLAUSIBLE_DURATION_MS = 5000;
          const plausible = duration >= MIN_PLAUSIBLE_DURATION_MS && duration < 24 * 3600 * 1000;
          if (plausible) {
            const prevDur = knownRespawnDurations.get(e.statsKey);
            knownRespawnDurations.set(e.statsKey, duration);
            saveRespawnDurations();
            addSysLog('respawn_duration_learned', {
              statsKey: e.statsKey, entityId: e.id, zone,
              killTime, respawnAt: e.respawnAt, duration,
              prevDuration: prevDur ?? null
            });
          } else {
            addSysLog('respawn_duration_rejected', {
              statsKey: e.statsKey, entityId: e.id, zone,
              killTime, respawnAt: e.respawnAt, duration,
              reason: duration < 0 ? 'respawnAt_before_kill' : 'duration_too_small'
            });
          }
          _recentKillTimes.delete(e.id);
        }
      } else if (!e.alive) {
        // Server didn't send respawnAt — try stable map, then estimate from known duration
        if (!enemyRespawnTimers.has(e.id)) {
          const pk     = e.pos ? _mobPosKey(zone, e.statsKey, e.pos) : null;
          const saved  = pk ? _stableMobTimers[pk] : null;
          if (saved && saved > now) {
            enemyRespawnTimers.set(e.id, saved);
          } else {
            const knownDur = knownRespawnDurations.get(e.statsKey);
            if (knownDur) {
              const estimated = now + knownDur;
              enemyRespawnTimers.set(e.id, estimated);
              _estimatedEnemyTimers.add(e.id);
              addSysLog('respawn_timer_estimated', {
                statsKey: e.statsKey, entityId: e.id, zone,
                estimatedAt: estimated, knownDur
              });
            }
          }
        }
      } else if (e.alive) {
        // Mob confirmed alive again — if we had an estimated (not server-confirmed)
        // timer for it, log how far off the estimate was from this actual
        // observation so accuracy can be checked from the logs later.
        if (_estimatedEnemyTimers.has(e.id)) {
          const est = enemyRespawnTimers.get(e.id) || null;
          addSysLog('respawn_estimate_resolved', {
            statsKey: e.statsKey, entityId: e.id, zone,
            estimatedAt: est, observedAliveAt: now,
            errorMs: est ? (now - est) : null // positive = estimate fired early (orange before real spawn)
          });
        }
        enemyRespawnTimers.delete(e.id);
        _estimatedEnemyTimers.delete(e.id);
        _recentKillTimes.delete(e.id);
        // Mob respawned — clear stable timer
        if (e.pos) {
          const pk = _mobPosKey(zone, e.statsKey, e.pos);
          if (_stableMobTimers[pk]) { delete _stableMobTimers[pk]; _stableDirty = true; }
        }
      }
    });

    checkTrackedMobs(zone, enemies, isFirstSeen);

    if (!prevEnemies.__zones) prevEnemies.__zones = {};
    prevEnemies.__zones[zone] = true;
    enemies.forEach(e => { prevEnemies[e.id] = { ...e }; });

    lastResourcesByZone[zone] = resources;
    resources.forEach(r => knownResNames.add(r.resource));

    resources.forEach(r => {
      // spawn_state resource entries never carry resourceNodeId (only the
      // resource_cooldown packet does, and that id isn't always 0 — see
      // getNodeMaxTimer). Use the prefix-aware getNodeMaxTimer for "do we
      // already have a timer" checks and delete-by-prefix for cleanup, so
      // this code doesn't create/miss a parallel `${idx}:0` entry that's
      // out of sync with the real `${idx}:${resourceNodeId}` key.
      const existingTimer = getNodeMaxTimer(r.idx);
      const pk  = r.pos ? _resPosKey(zone, r.pos) : null;

      if (!r.active && typeof r.cooldownExpiresAt === 'number' && r.cooldownExpiresAt > now) {
        if (!existingTimer) resourceRespawnTimers.set(`${r.idx}:0`, r.cooldownExpiresAt);
        if (pk) {
          // Learn duration: if we tracked when this slot died, compute actual duration
          const slot = _slotDeathTimes[pk];
          if (slot && slot.resource === r.resource) {
            const duration = r.cooldownExpiresAt - slot.deathTime;
            if (duration > 60_000 && duration < 48 * 3600_000) {
              knownResDurations.set(r.resource, duration);
              saveResDurations();
            }
          }
          // Store stable timer with diedResource
          _stableResTimers[pk] = { expiresAt: r.cooldownExpiresAt, diedResource: r.resource };
          _stableDirty = true;
        }
      } else if (!r.active && pk) {
        // No cooldownExpiresAt from server — try stable map first, then estimate
        if (!existingTimer) {
          const saved = _stableResTimers[pk];
          if (saved && saved.expiresAt > now) {
            resourceRespawnTimers.set(`${r.idx}:0`, saved.expiresAt);
          } else {
            // Estimate from slot death time + this resource's known respawn duration
            const slot = _slotDeathTimes[pk];
            if (slot) {
              const dur = knownResDurations.get(slot.resource || r.resource);
              if (dur) {
                const estimatedExpiry = slot.deathTime + dur;
                if (estimatedExpiry > now) {
                  resourceRespawnTimers.set(`${r.idx}:0`, estimatedExpiry);
                  if (pk) {
                    _stableResTimers[pk] = { expiresAt: estimatedExpiry, diedResource: slot.resource || null };
                    _stableDirty = true;
                  }
                }
              }
            }
          }
        }
      } else if (r.active) {
        const prefix = `${r.idx}:`;
        for (const key of Array.from(resourceRespawnTimers.keys())) {
          if (key.startsWith(prefix)) resourceRespawnTimers.delete(key);
        }
        if (pk) {
          if (_stableResTimers[pk]) { delete _stableResTimers[pk]; _stableDirty = true; }
          delete _slotDeathTimes[pk];
        }
      }

      // Track active→inactive transitions to know death time
      if (pk && !r.active) {
        if (!_slotDeathTimes[pk]) {
          _slotDeathTimes[pk] = { deathTime: now, resource: r.resource };
        }
      }
    });

    if (_stableDirty) { _saveStableMobTimers(); _saveStableResTimers(); }

    saveWorldSnapshot();
    refreshResSelects();
    checkTrackedResources(zone, resources, isFirstSeen);
    if (activeTab === 'res')   renderResPane();

    refreshSelects();
    updateCount();
    applyFilters();
    if (activeTab === 'state' || _poppedOut.has('state')) renderStatePane();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
  }

  // ─── enemy_respawn handler ───────────────────────────────────────────────────
  function findZoneForEntityId(entityId) {
    for (const [zone, enemies] of Object.entries(lastStateByZone)) {
      if (enemies.some(e => e.id === entityId)) return zone;
    }
    return null;
  }

  function handleEnemyRespawn(data) {
    const zone = findZoneForEntityId(data.id);
    if (!zone) {
      addSysLog('enemy_respawn', { warn: 'zone not found', id: data.id, statsKey: data.statsKey });
      return;
    }
    addSysLog('enemy_respawn', { zone, id: data.id, statsKey: data.statsKey });

    const enemies = lastStateByZone[zone];
    if (enemies) {
      const idx = enemies.findIndex(e => e.id === data.id);
      if (idx !== -1) {
        enemies[idx] = {
          ...enemies[idx],
          alive: true,
          hp:    data.hp,
          maxHp: data.maxHp,
          pos:   data.pos || enemies[idx].pos,
        };
      }
    }

    enemyRespawnTimers.delete(data.id);

    if (_seenZones.has(zone)) {
      checkTrackedMobs(zone, lastStateByZone[zone] || [], false);
    }

    if (activeTab === 'state' || _poppedOut.has('state')) renderStatePane();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
  }

  // ─── resource_respawn handler ────────────────────────────────────────────────
  function findZoneForResourceIdx(idx) {
    for (const [zone, resources] of Object.entries(lastResourcesByZone)) {
      if (resources.some(r => r.idx === idx)) return zone;
    }
    return null;
  }

  function handleResourceRespawn(data) {
    const zone = findZoneForResourceIdx(data.idx);
    if (!zone) {
      addSysLog('resource_respawn', { warn: 'zone not found', idx: data.idx, resource: data.resource });
      return;
    }
    addSysLog('resource_respawn', { zone, idx: data.idx, resource: data.resource, rarity: data.rarity });

    const resources = lastResourcesByZone[zone];
    if (resources) {
      const r = resources.find(r => r.idx === data.idx);
      if (r) {
        r.active    = true;
        r.resource  = data.resource || r.resource;
        r.rarity    = data.rarity   || r.rarity;
        r.hp        = data.hp;
        r.maxHp     = data.maxHp;
        r.pos       = data.pos || r.pos;
        r.cooldownExpiresAt = null;
      }
    }

    const prefix = `${data.idx}:`;
    for (const key of resourceRespawnTimers.keys()) {
      if (key.startsWith(prefix)) resourceRespawnTimers.delete(key);
    }

    if (_seenZones.has(zone)) {
      checkTrackedResources(zone, lastResourcesByZone[zone] || [], false);
    }

    if (activeTab === 'res')   renderResPane();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
  }

  // ─── resource_cooldown handler ───────────────────────────────────────────────
  function handleResourceCooldown(data) {
    const spawnIndex = data.spawnIndex;

    let zone     = null;
    let resource = null;

    // spawnIndex matches resource.idx (a server-assigned global id), not the
    // position within the per-zone array — indexing zoneResources[spawnIndex]
    // directly picked the wrong resource (and even the wrong zone via the
    // fallback below) whenever spawnIndex didn't happen to equal its own
    // array position, e.g. any zone whose resources don't start at idx 0.
    if (_currentZone && lastResourcesByZone[_currentZone]) {
      resource = lastResourcesByZone[_currentZone].find(r => r.idx === spawnIndex);
      if (resource) zone = _currentZone;
    }

    if (!zone) {
      for (const [z, resources] of Object.entries(lastResourcesByZone)) {
        const found = resources.find(r => r.idx === spawnIndex);
        if (found) {
          zone     = z;
          resource = found;
          break;
        }
      }
    }

    if (!zone || !resource) {
      addSysLog('resource_cooldown', { warn: 'resource not found', spawnIndex, nodeType: data.nodeType, currentZone: _currentZone });
      return;
    }

    const globalIdx = resource.idx;

    resource.active = false;
    resource.hp     = 0;

    // Persist the gathered state immediately so a page reload before the next
    // spawn_state still shows the resource as inactive (not orange/active).
    saveWorldSnapshot();

    if (data.cooldownSeconds > 0) {
      const key     = `${globalIdx}:${data.resourceNodeId ?? 0}`;
      const expires = Date.now() + data.cooldownSeconds * 1000;
      resourceRespawnTimers.set(key, expires);
      // Also persist to stable map so the timer survives reload.
      if (resource.pos) {
        const pk = _resPosKey(zone, resource.pos);
        _stableResTimers[pk] = { expiresAt: expires, diedResource: resource.resource };
        _saveStableResTimers();
      }
      addSysLog('resource_cooldown', {
        zone, spawnIndex, globalIdx, nodeType: data.nodeType, resource: resource.resource,
        key, cooldownSeconds: data.cooldownSeconds,
        expiresAt: new Date(expires).toLocaleTimeString([], { hour12: false })
      });
    }

    checkTrackedResources(zone, lastResourcesByZone[zone], false);

    if (activeTab === 'res')   renderResPane();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
  }

  function getNodeMaxTimer(idx) {
    if (idx == null) return null;
    const prefix = `${idx}:`;
    let max = 0;
    for (const [key, exp] of resourceRespawnTimers) {
      if (key.startsWith(prefix) && exp > max) max = exp;
    }
    return max > 0 ? max : null;
  }

  // ─── resource_cooldowns / cooldowns handlers ─────────────────────────────────
  function handleResourceCooldownsState(cooldownsList) {
    if (!cooldownsList?.length) return;
    addSysLog('resource_cooldowns', { count: cooldownsList.length, items: cooldownsList });
    console.warn('[spawn-tracker] resource_cooldowns non-empty — implement restore:', JSON.stringify(cooldownsList));
  }

  // ─── combat_hit_ack handler ──────────────────────────────────────────────────
  // ─── player_death handler ────────────────────────────────────────────────────
  // Real death position straight from the server — only meaningful while we're
  // in the maze (that's the only place this map tracks).
  // Damage Log: record incoming damage (or a successful block at 0 damage).
  // `source` is the game's display name for the attacker (e.g. "CrystalBat"),
  // not the raw enemyType key used elsewhere (e.g. "CrystalBatAI") — shown
  // as-is in the feed since there's no reliable mapping between the two here.
  function handlePlayerDamageTaken(d) {
    const dmg = typeof d.damageAmount === 'number' ? d.damageAmount : 0;
    _damageStats.dmgTaken += dmg;
    if (dmg === 0) _damageStats.blockedCount += 1; else _damageStats.unblockedCount += 1;
    if (d.source) {
      const st = _damageStatsForEnemy(d.source);
      st.dmgTaken += dmg;
    }
    _damageFeedPush({
      ts: Date.now(), kind: 'incoming', enemyType: d.source || null,
      damage: dmg, blocked: dmg === 0,
    });
  }

  function handlePlayerDeath(d) {
    // Damage Log: record the death. The killing blow's enemyType comes from
    // whatever the most recent incoming-damage feed entry was (player:damage:taken
    // only gives `source`, a display name, not the raw enemyType key — close
    // enough to show in the feed either way).
    _damageStats.deaths += 1;
    const lastHit = _damageFeed.find(e => e.kind === 'incoming');
    const killerLabel = lastHit ? lastHit.enemyType : null;
    if (killerLabel) _damageStatsForEnemy(killerLabel).timesKilledBy += 1;
    _damageFeedPush({ ts: Date.now(), kind: 'death', enemyType: killerLabel });

    const pos = { x: d.position.x, y: d.position.y };
    if (MAZE_ZONES.has(_currentZone)) {
      _mazeDeathPoint = pos;
      saveMazeDeathPoint();
    }
    // Point a dedicated overlay arrow at our own death spot so we can walk
    // back and reclaim the dropped runes — kept separate from _pointerTarget
    // so it survives the player also setting a manual waypoint afterward.
    _deathDropTarget = { zone: _currentZone, x: pos.x, y: pos.y, label: 'Death drop', key: _pointerKey(_currentZone, pos), isDeathDrop: true };
    renderTrackPane();
    // Track this specific death drop for the "Pick up your Runes!" banner —
    // it stays up exactly as long as this dropId remains unclaimed, and is
    // keyed to the dropId returned here so we clear only when the matching
    // pickup_death_drop_ack comes back, not on unrelated inventory changes.
    if (d.dropId) {
      _pendingDeathDrop = { dropId: d.dropId, quantity: d.droppedRunes || 0 };
      _saveQBInventoryState();
      updateRunestoneWarning();
    }
  }

  // Live durability tracking — the server reports this directly on every
  // combat/gather hit via combat_hit_ack / gather_hit_ack
  // (weaponDurability/durabilityLoss/weaponBroke), not via console.log text
  // (the old [DAMAGE-OUT-ACK]/"Hit Left:" tracker further up no longer
  // matches anything the game prints).
  function _trackLiveDurability(d) {
    if (!d || typeof d.weaponDurability !== 'number' || !_equippedWeaponInstanceId) return;
    // Server sends weaponDurability: -1 as a "not applicable" sentinel — e.g.
    // gather_hit_ack for flower/herb nodes doesn't wear down the equipped
    // tool at all, so it reports -1 rather than a real value. Treat any
    // negative value as "no update" instead of blindly assigning it, or the
    // in-hand item's durability gets stomped to -1 (shown/treated as 0).
    if (d.weaponDurability < 0) return;
    const item = _inventoryByInstance[_equippedWeaponInstanceId];
    if (!item || item.MaxDurability <= 0) return;
    const prevDur = item.Durability;
    item.Durability = d.weaponDurability;
    if (activeTab === 'qb' || _poppedOut.has('qb')) renderQBPane();
    if (activeTab === 'chest' || _poppedOut.has('chest')) renderChestPane();
    const _durEl = document.getElementById('roeDurWarn');
    if (!_durEl || !_durItemMatches(item.itemId)) return;
    if (item.Durability === 0 && prevDur > 0) {
      // Just broke this tick — show the BROKEN toast and skip the
      // warn/hide branch entirely so it can't flash off in the same update.
      const _brokenMsg = `🔴 ${formatItemId(item.itemId)} BROKEN!`;
      _lastBrokenToastInstanceId = item.instanceId;
      _showDurBrokenMsg(_durEl, _brokenMsg);
      setTimeout(() => notifyTrack(null, _brokenMsg), 0);
    } else if (item.Durability > 0 && item.Durability <= _durWarnThreshold * 5) {
      _durEl.textContent = `⚠️ ${formatItemId(item.itemId)} ${Math.ceil(item.Durability/5)}/${Math.ceil(item.MaxDurability/5)} hits left!`;
      _durEl.style.animation = 'roeBlink 1s step-start infinite';
      _durEl.style.display = 'block';
      if (prevDur > _durWarnThreshold * 5) {
        const _warnMsg = `⚠️ ${formatItemId(item.itemId)} ${Math.ceil(item.Durability/5)}/${Math.ceil(item.MaxDurability/5)} hits left!`;
        setTimeout(() => notifyTrack(null, _warnMsg), 0);
      }
    } else if (Date.now() >= _durBrokenUntil) {
      _durEl.style.display = 'none';
    }
  }

  function handleGatherHitAck(ack) {
    if (!ack?.success) return;
    _trackLiveDurability(ack.data);

    // ack.data.nodeIndex matches resource.idx (same id space as spawn_state
    // resources) and reliably identifies which node was just depleted. The
    // separate `resource_cooldown` event's spawnIndex is a different counter
    // that doesn't correspond to resource.idx, and matching against it can
    // pick the wrong resource (even in the wrong zone) — see
    // handleResourceCooldown's own idx-based lookup for the same fix.
    if (ack.data?.isGathered && _currentZone && lastResourcesByZone[_currentZone]) {
      const resource = lastResourcesByZone[_currentZone].find(r => r.idx === ack.data.nodeIndex);
      if (resource) {
        resource.active = false;
        resource.hp     = 0;
        saveWorldSnapshot();
        // Without this, trackedResources[].nodes keeps stale `active:true`
        // for the gathered node until the next spawn_state refresh (e.g. a
        // zone revisit), so the Track tab square stays green even though
        // the node was just depleted.
        checkTrackedResources(_currentZone, lastResourcesByZone[_currentZone], true);
        if (activeTab === 'res')   renderResPane();
        if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
      }
    }
  }

  function handleCombatHitAck(ack) {
    if (!ack?.success) return;
    const d = ack.data;
    _trackLiveDurability(d);

    // Damage Log: record every outgoing hit (not just kills) — damage dealt,
    // crit, and per-enemy-type breakdown.
    if (d && typeof d.damage === 'number') {
      const st = _damageStatsForEnemy(d.enemyType);
      _damageStats.dmgDealt += d.damage;
      _damageStats.hits += 1;
      st.dmgDealt += d.damage;
      st.hits += 1;
      if (d.isCritical) _damageStats.crits += 1;
      if (d.isDead) { _damageStats.kills += 1; st.kills += 1; }
      _damageFeedPush({
        ts: Date.now(), kind: d.isDead ? 'kill' : 'hit',
        enemyType: d.enemyType, entityIndex: d.entityIndex,
        damage: d.damage, isCritical: !!d.isCritical,
      });
    }

    if (!d?.isDead) return;
    const zone = _currentZone;
    if (!zone || !lastStateByZone[zone]) return;

    const enemies = lastStateByZone[zone];
    const enemy   = enemies.find(e => e.entityIndex === d.entityIndex);
    if (!enemy) return;

    enemy.alive = false;
    enemy.hp    = 0;

    // Persist the killed state immediately so a page reload before the next
    // spawn_state still shows the mob as dead (not orange/alive).
    saveWorldSnapshot();

    // Record kill time so handleSpawnState can learn the respawn duration for
    // this statsKey.  If we already know the duration, set the timer right now
    // so the Track tab shows ⏱ without waiting for the next spawn_state poll.
    const killTime = Date.now();
    _recentKillTimes.set(enemy.id, killTime);
    const knownDuration = knownRespawnDurations.get(enemy.statsKey);
    if (knownDuration) {
      const respawnAt = killTime + knownDuration;
      enemyRespawnTimers.set(enemy.id, respawnAt);
      // Also persist to stable map so the timer survives reload (session IDs change).
      if (enemy.pos) {
        const pk = _mobPosKey(zone, enemy.statsKey, enemy.pos);
        _stableMobTimers[pk] = respawnAt;
        _saveStableMobTimers();
      }
    }

    addSysLog('combat_hit_ack:kill', {
      zone, entityIndex: d.entityIndex, enemyType: d.enemyType,
      timerEstimated: knownDuration != null, durationMs: knownDuration ?? null,
    });
    checkTrackedMobs(zone, enemies, false);

    if (activeTab === 'state' || _poppedOut.has('state')) renderStatePane();
    if (activeTab === 'track' || _poppedOut.has('track')) renderTrackPane();
  }

  // ─── Hook socket.io ──────────────────────────────────────────────────────────
  function attachToSocket(socket) {
    if (socket._roeHooked) return;
    socket._roeHooked = true;
    _hooked_socket = socket;

    socket.onAny((event, ...data) => {
      if (!_socketReady) {
        _socketReady = true;
        if (_claimAuthToken) checkClaim();
      }
      const payload = data.length === 1 ? data[0] : data.length > 1 ? data : undefined;
      addWsLog('IN', event, payload);
      if (event === 'spawn_state'         && data[0]) handleSpawnState(data[0]);
      // Forge repair claim: items just returned to the player's inventory.
      // No full `inventory` packet necessarily follows, so register these
      // instances directly or the tool-warning check won't see them until
      // the next unrelated inventory refresh.
      if (event === 'craft:claim:completed' && Array.isArray(data[0]?.inventory?.main_items)) {
        data[0].inventory.main_items.forEach(item => {
          _inventoryByInstance[item.instanceId] = {
            instanceId: item.instanceId,
            itemId: item.itemId,
            Level: item.level ?? 0,
            Durability: item.durability ?? 0,
            MaxDurability: item.maxDurability ?? 0,
            Quantity: item.quantity ?? 1,
          };
          _knownItemIdByInstance.set(item.instanceId, item.itemId);
        });
        updateToolWarning();
      }
      if (event === 'player_death'        && data[0]?.position) handlePlayerDeath(data[0]);
      if (event === 'player:damage:taken' && data[0]) handlePlayerDamageTaken(data[0]);
      if (event === 'pickup_death_drop_ack' && data[0]?.success) {
        // Picked up our own death-drop loot — the marker on the map has served
        // its purpose, clear it.
        _mazeDeathPoint = null;
        saveMazeDeathPoint();
        if (_deathDropTarget) {
          _deathDropTarget = null;
          renderTrackPane();
        }
        // Only clear the "Pick up your Runes!" banner if the picked-up drop
        // is the exact one we're tracking — a stale/duplicate ack for a
        // different dropId (or one from before a reload) must not clear it.
        const ackDropId = data[0]?.data?.dropId;
        if (_pendingDeathDrop && ackDropId && ackDropId === _pendingDeathDrop.dropId) {
          _pendingDeathDrop = null;
          _saveQBInventoryState();
          updateRunestoneWarning();
        }
        // This path (pickup_death_drop_ack) never went through the generic
        // item_pickup handler, so the minimap rune diamond for this dropId
        // was left drawn forever even after the runes were claimed.
        if (ackDropId && _worldDropRunes.some(d => d.dropId === ackDropId)) {
          _worldDropRunes = _worldDropRunes.filter(d => d.dropId !== ackDropId);
        }
      }
      if (event === 'enemy_respawn'       && data[0]) handleEnemyRespawn(data[0]);
      if (event === 'resource_respawn'    && data[0]) handleResourceRespawn(data[0]);
      if (event === 'combat_hit_ack'      && data[0]) handleCombatHitAck(data[0]);
      if (event === 'gather_hit_ack'      && data[0]) handleGatherHitAck(data[0]);
      if (event === 'resource_cooldowns'  && data[0]) handleResourceCooldownsState(data[0].cooldowns);
      if (event === 'cooldowns'           && data[0]) handleResourceCooldownsState(data[0].resourceCooldowns);
      if (event === 'marketplace:getAllListings' && data[0]) handleMarketplaceListingsResponse(data[0]);
      if (event === 'marketplace:getGlobalSales' && data[0]) handleMarketplaceSalesResponse(data[0]);
      if (event === 'restore_world_drops' && data[0]) {
        const drops = Array.isArray(data[0].drops) ? data[0].drops : [];
        // This is a snapshot for whichever zone the player is in right now
        // (the event only fires on zone entry) — tag every entry with that
        // zone so stale drops from a previously-visited zone don't keep
        // getting drawn/arrowed after the player has since moved elsewhere
        // without that zone ever sending its own (now-empty) snapshot.
        const zoneNow = _currentZone;
        _worldDropRunes = _worldDropRunes.filter(d => d.zone !== zoneNow).concat(
          drops.filter(d => d.itemId === 'runestone' && d.position)
            .map(d => ({ dropId: d.dropId, quantity: d.quantity || 0, pos: { x: d.position.x, y: d.position.y }, zone: zoneNow }))
        );
        _worldDropItems = _worldDropItems.filter(d => d.zone !== zoneNow).concat(
          drops.filter(d => d.itemId !== 'runestone' && d.position)
            .map(d => ({ dropId: d.dropId, itemId: d.itemId, quantity: d.quantity || 0, pos: { x: d.position.x, y: d.position.y }, zone: zoneNow }))
        );
      }
      // Live drop as it happens (player drops an item, or a mob dies and
      // drops loot) — restore_world_drops only gives us a snapshot at zone
      // entry, so without this new drops never show up until the next one.
      if (event === 'loot_drop' && data[0]?.position) {
        const d = data[0];
        const entry = { dropId: d.dropId, itemId: d.itemId, quantity: d.quantity || 0, pos: { x: d.position.x, y: d.position.y }, zone: _currentZone };
        if (d.itemId === 'runestone') {
          if (!_worldDropRunes.some(x => x.dropId === entry.dropId)) _worldDropRunes.push(entry);
        } else {
          if (!_worldDropItems.some(x => x.dropId === entry.dropId)) _worldDropItems.push(entry);
        }
      }
      if (event === 'shop_prices_ack' && data[0]) handleShopPricesAck(data[0]);
      if (event === 'chest'           && data[0]) handleChestEvent(data[0]);
      if (event === 'item_pickup_ack'      && data[0]) handleItemPickupAck(data[0]);
      if (event === 'inventory'    && data[0]?.data?.InventoryItems) {
        _inventoryBySlot = {};
        _inventoryByInstance = {};
        _inventorySlotByInstance = {};
        const items = data[0].data.InventoryItems;
        items.forEach(item => {
          _inventoryBySlot[item.slot] = item.itemId;
          _inventorySlotByInstance[item.instanceId] = item.slot;
          _inventoryByInstance[item.instanceId] = {
            instanceId: item.instanceId,
            itemId: item.itemId,
            Level: item.Level ?? 0,
            Durability: item.Durability ?? 0,
            MaxDurability: item.MaxDurability ?? 0,
            Quantity: item.Quantity ?? 1,
          };
          _knownItemIdByInstance.set(item.instanceId, item.itemId);
        });
        // Prune cache entries the server no longer reports and that aren't
        // currently referenced by quickbar/equipped — these are gone for
        // real (e.g. sent to the forge for repair), not just missing from
        // a snapshot the game hasn't caught up on yet.
        const stillReferenced = new Set(_quickbarRefs.values());
        if (_equippedWeaponInstanceId) stillReferenced.add(_equippedWeaponInstanceId);
        Array.from(_knownItemIdByInstance.keys()).forEach(instanceId => {
          if (!_inventoryByInstance[instanceId] && !stillReferenced.has(instanceId)) {
            _knownItemIdByInstance.delete(instanceId);
          }
        });
        _equippedWeaponInstanceId = data[0].data.InventoryDetails?.equippedWeaponInstanceId ?? null;
        const newQB = data[0].data.QuickBarInstances ?? [];
        if (newQB.some(v => v !== null)) _quickBarInstancesFromInv = newQB;

        const rs = items.find(item => item.itemId === 'runestone');
        _runestoneQty = rs ? (rs.Quantity ?? 0) : 0;
        _inventoryReady = true;
        _lastInventoryAt = Date.now();
        // If quickselect already arrived before inventory, updateToolWarning was skipped
        // (inventoryReady was false at that point) — call it now to catch up.
        updateToolWarning();
        updateRunestoneWarning();
        // Durability warning on inventory update (reliable fallback regardless of console hook)
        {
          const _durEl = document.getElementById('roeDurWarn');
          if (_durEl) {
            // Only check the equipped (in-hand) weapon, not all QB items
            let _durWarnText = null;
            if (_equippedWeaponInstanceId) {
              const it = _inventoryByInstance[_equippedWeaponInstanceId];
              if (it && it.MaxDurability > 0 && it.Durability > 0 && it.Durability <= _durWarnThreshold * 5 && _durItemMatches(it.itemId)) {
                _durWarnText = `⚠️ ${formatItemId(it.itemId)} ${Math.ceil(it.Durability/5)}/${Math.ceil(it.MaxDurability/5)} hits left!`;
              }
            }
            if (_durWarnText) {
              _durEl.textContent = _durWarnText;
              _durEl.style.animation = 'roeBlink 1s step-start infinite';
              _durEl.style.display = 'block';
            } else if (Date.now() >= _durBrokenUntil) {
              _durEl.style.display = 'none';
            }
          }
        }
        checkQBDesync();
        _saveQBInventoryState();
        if (activeTab === 'qb' || _poppedOut.has('qb')) renderQBPane();
        if (activeTab === 'chest' || _poppedOut.has('chest')) renderChestPane();
      }

      // Track equip time — server sends updated quickselect shortly after, avoid false desync
      if (event === 'inventory_equip_ack' && data?.success !== false) {
        _lastEquipAt = Date.now();
      }

      if (event === 'quickselect'  && Array.isArray(data[0]?.data)) {
        _quickbarRefs = new Map(
          data[0].data
            .filter(s => s.isEquipped && s.RefInstanceId)
            .map(s => [s.SlotId, s.RefInstanceId])
        );
        _quickbarReady = true;
        // If this quickselect wasn't triggered by our own quickbar_set (i.e. it's a zone load
        // or server-initiated update), reset inv QB data so restore waits for fresh inventory.
        // Reset the flag only if this quickselect wasn't preceded shortly by
        // our own quickbar_set OR our own inventory_equip (switching the
        // in-hand item also triggers a server-pushed quickselect a few dozen
        // ms later). Previously only quickbar_set was tracked here, so every
        // weapon switch via inventory_equip looked like an external/zone-load
        // update and wrongly flipped _inventoryReady back to false — causing
        // the compact panel to flash "Loading..." right after an equip swap,
        // even though a fresh `inventory` packet with the new item had
        // already arrived and rendered.
        const sinceOurAction = Math.min(Date.now() - _qbActionAt, Date.now() - _lastEquipAt, Date.now() - _lastInventoryAt);
        if (sinceOurAction > 3000) {
          _quickBarInstancesFromInv = [];
          _inventoryReady = false;
        }
        // quickselect is the authoritative QB state — update our reference
        updateToolWarning();
        checkQBDesync();
        _saveQBInventoryState();
        // Re-render now — nothing else was forcing a repaint after this
        // event, so any state change made above (e.g. _inventoryReady
        // toggling, or _quickbarRefs updating) could sit invisible on
        // screen ("Loading..." stuck) until some unrelated event happened
        // to trigger the next render.
        if (activeTab === 'qb' || _poppedOut.has('qb')) renderQBPane();
        if (activeTab === 'chest' || _poppedOut.has('chest')) renderChestPane();
      }
    });

    const originalEmit = socket.emit.bind(socket);
    socket.emit = function (event, ...args) {
      addWsLog('OUT', event, args.length === 1 ? args[0] : args.length > 1 ? args : undefined);
      noteMarketplaceRequest(event, args.length === 1 ? args[0] : args.length > 1 ? args[0] : undefined);
      if (event === 'resource_cooldown' && args[0]) handleResourceCooldown(args[0]);
      // Items sent to the forge for repair vanish from the player's inventory
      // immediately, but the next `inventory`/`quickselect` snapshots can lag
      // behind this event, so the tool-warning cache would otherwise keep
      // flagging them as "missing from quickbar" while they're in the forge.
      if (event === 'repair:start' && Array.isArray(args[0]?.items)) {
        args[0].items.forEach(({ instanceId }) => {
          _knownItemIdByInstance.delete(instanceId);
          delete _inventoryByInstance[instanceId];
          for (const [slotId, refId] of _quickbarRefs) {
            if (refId === instanceId) _quickbarRefs.delete(slotId);
          }
        });
        updateToolWarning();
      }
      if (event === 'combat_hit') {
        _lastCombatActionT = Date.now();
      }
      if (event === 'move' && args[0]?.position) {
        const _prevPlayerPos = _playerPos;
        _playerPos = { x: args[0].position.x, y: args[0].position.y };
        // The outgoing move packet already carries the game's own
        // locationName for where this position actually is — but it fires
        // to the server, and `spawn_state` (which updates _currentZone)
        // doesn't come back for ~100-200ms. Right after a teleport (e.g.
        // Mines exit → Forest), this first move already has the NEW zone's
        // coordinates while _currentZone still holds the OLD zone, so the
        // maze/forest trail code below would otherwise draw a bogus line
        // from wherever the player last stood in the old zone straight to
        // the new zone's spawn point, and briefly frame the camera on that
        // stale zone's (now-irrelevant) bounds — reading as the map
        // flashing black until spawn_state lands and a couple of real
        // steps rebuild the new zone's trail. Detect the mismatch here and
        // skip trail bookkeeping for this one packet; handleSpawnState's
        // zone-entry reset (which runs moments later) takes it from there.
        const _moveZoneMismatch = args[0].locationName && args[0].locationName !== _currentZone;
        // Walk-and-cut: drop cuts along the player's path as they walk, so
        // tracing a whole narrow passage is "turn this on and walk it"
        // instead of clicking every few steps. Interpolates between move
        // samples with _stepPoints (same as the real trail) so fast/laggy
        // movement doesn't skip cells, and dedupes by grid cell (_cutCellKey)
        // so re-walking the same passage doesn't restack points or leave
        // gaps on turns.
        if (_mapCutWalkMode && !_moveZoneMismatch) {
          const _walkCutGroup = _activeMapGroup();
          if (_walkCutGroup) {
            const _walkCutSeen = _walkCutSeenFor(_walkCutGroup);
            const _walkCutPts = _stepPoints(_mapCutWalkLastRawPos, _playerPos);
            let _walkCutAny = false;
            _walkCutPts.forEach(p => {
              const key = _cutCellKey(p);
              if (_walkCutSeen.has(key)) return;
              _walkCutSeen.add(key);
              _walkCutAny = true;
              _cutsFor(_walkCutGroup).push({ x: p.x, y: p.y });
              // Also cut the same spot in the combined 'maze' trail — walking
              // with this on should sever the passage everywhere it's drawn,
              // not just in whichever split view happens to be active.
              if (_walkCutGroup === 'mines' || _walkCutGroup === 'minesLower') {
                _walkCutSeenFor('maze').add(_cutCellKey(p));
                _cutsFor('maze').push({ x: p.x, y: p.y });
              }
            });
            if (_walkCutAny) {
              _saveCutsFor(_walkCutGroup);
              _forceTrailRebake(_walkCutGroup);
              if (_walkCutGroup === 'mines' || _walkCutGroup === 'minesLower') {
                _saveCutsFor('maze');
                _forceTrailRebake('maze');
              }
            }
          }
          _mapCutWalkLastRawPos = { x: _playerPos.x, y: _playerPos.y };
        }
        // combat_hit echoes a zero-distance move packet at the same position —
        // pushing it into moveHist creates a [samePos, samePos] pair that freezes
        // the interpolated map dot, then snaps it once the next real move lands.
        const _isDupMovePos = _prevPlayerPos && _prevPlayerPos.x === _playerPos.x && _prevPlayerPos.y === _playerPos.y;
        if (!_isDupMovePos) {
          _playerMoveHist.push({ x: _playerPos.x, y: _playerPos.y, t: Date.now() });
          if (_playerMoveHist.length > 2) _playerMoveHist.shift();
        }
        if (!_moveZoneMismatch && MAZE_ZONES.has(_currentZone)) {
          _updateStairPreviewFlip();
          if (!_isDupMovePos) {
            _mazeMoveHist.push({ x: _playerPos.x, y: _playerPos.y, t: Date.now() });
            if (_mazeMoveHist.length > 2) _mazeMoveHist.shift();
          }

          const stepPts = _stepPoints(_mazeLastRawPos, _playerPos);
          // Whichever sub-zone we're actually in right now — its own trail
          // gets the same points, in parallel with the combined one below.
          const inLower   = _currentZone === 'MinesLower';
          const zoneTrail = inLower ? _minesLowerTrail     : _minesTrail;
          const zoneSeen  = inLower ? _minesLowerTrailSeen : _minesTrailSeen;

          let pushedAny = false, pushedZoneAny = false;
          stepPts.forEach(p => {
            const key = _trailCellKey(p);
            if (!_mazeTrailSeen.has(key)) {
              _mazeTrailSeen.add(key);
              _mazeTrail.push({ x: p.x, y: p.y });
              _mazeTrailBounds = _extendBounds(_mazeTrailBounds, p);
              _mazeLastPushedKey = key;
              pushedAny = true;
            }
            if (!zoneSeen.has(key)) {
              zoneSeen.add(key);
              zoneTrail.push({ x: p.x, y: p.y });
              if (inLower) {
                _minesLowerTrailBounds = _extendBounds(_minesLowerTrailBounds, p);
                _minesLowerLastPushedKey = key;
              } else {
                _minesTrailBounds = _extendBounds(_minesTrailBounds, p);
                _minesLastPushedKey = key;
              }
              pushedZoneAny = true;
            }
          });
          _mazeLastRawPos = { x: _playerPos.x, y: _playerPos.y };
          if (pushedAny) saveMazeTrail();
          if (pushedZoneAny) { inLower ? saveMinesLowerTrail() : saveMinesTrail(); }
        }
        if (!_moveZoneMismatch && FOREST_ZONES.has(_currentZone)) {
          if (!_isDupMovePos) {
            _forestMoveHist.push({ x: _playerPos.x, y: _playerPos.y, t: Date.now() });
            if (_forestMoveHist.length > 2) _forestMoveHist.shift();
          }
          let pushedAny = false;
          _stepPoints(_forestLastRawPos, _playerPos).forEach(p => {
            const key = _trailCellKey(p);
            if (!_forestTrailSeen.has(key)) {
              _forestTrailSeen.add(key);
              _forestTrail.push({ x: p.x, y: p.y });
              _forestTrailBounds = _extendBounds(_forestTrailBounds, p);
              _forestLastPushedKey = key;
              pushedAny = true;
            }
          });
          _forestLastRawPos = { x: _playerPos.x, y: _playerPos.y };
          if (pushedAny) saveForestTrail();
        }
        if (!_moveZoneMismatch && _isCustomMapZone(_currentZone)) {
          const entry = _customMapEntry(_currentZone);
          if (!_isDupMovePos) {
            entry.moveHist.push({ x: _playerPos.x, y: _playerPos.y, t: Date.now() });
            if (entry.moveHist.length > 2) entry.moveHist.shift();
          }
          let pushedAny = false;
          _stepPoints(entry.lastRawPos, _playerPos).forEach(p => {
            const key = _trailCellKey(p);
            if (!entry.seen.has(key)) {
              entry.seen.add(key);
              entry.trail.push({ x: p.x, y: p.y });
              entry.bounds = _extendBounds(entry.bounds, p);
              entry.lastPushedKey = key;
              pushedAny = true;
            }
          });
          entry.lastRawPos = { x: _playerPos.x, y: _playerPos.y };
          if (pushedAny) _saveCustomTrail(_currentZone);
        }
      }
      if (event === 'item_pickup' && args[0]) {
        // Remove picked-up drops from the map display
        const pickedDropId = args[0].dropId;
        if (pickedDropId && _worldDropRunes.some(d => d.dropId === pickedDropId)) {
          _worldDropRunes = _worldDropRunes.filter(d => d.dropId !== pickedDropId);
        }
        if (pickedDropId && _worldDropItems.some(d => d.dropId === pickedDropId)) {
          _worldDropItems = _worldDropItems.filter(d => d.dropId !== pickedDropId);
        }
        // Safety net: if our tracked death drop gets claimed via this generic
        // pickup path instead of pickup_death_drop_ack, clear the banner too.
        if (pickedDropId && _pendingDeathDrop && pickedDropId === _pendingDeathDrop.dropId) {
          _pendingDeathDrop = null;
          _saveQBInventoryState();
          updateRunestoneWarning();
        }
      }
      if (event === 'quickbar_set') {
        _qbActionAt = Date.now();
        const p = args[0];
        if (p && p.quickBarSlot != null && p.instanceId) {
          _qbDesired.set(p.quickBarSlot, p.instanceId);
          const display = p.quickBarSlot === 9 ? 0 : p.quickBarSlot + 1;
          _qbEventLog.push({ ts: Date.now(), type: 'desired_set', detail: `slot${display}→${p.itemId ?? p.instanceId}` });
          if (_qbEventLog.length > QB_EVENT_LOG_MAX) _qbEventLog.shift();
        } else if (p && p.quickBarSlot != null && !p.instanceId) {
          _qbDesired.delete(p.quickBarSlot);
          const display = p.quickBarSlot === 9 ? 0 : p.quickBarSlot + 1;
          _qbEventLog.push({ ts: Date.now(), type: 'desired_clear', detail: `slot${display} cleared` });
          if (_qbEventLog.length > QB_EVENT_LOG_MAX) _qbEventLog.shift();
        }
      }
      return originalEmit(event, ...args);
    };

    addStatus(`✅ Attached to socket (passive mode)`);
  }



  function hookSocket() {
    if (!pageWindow.io) { setTimeout(hookSocket, 500); return; }

    const managers = pageWindow.io.managers || {};
    Object.values(managers).forEach(manager => {
      Object.values(manager.nsps || {}).forEach(socket => attachToSocket(socket));
    });

    const originalIo = pageWindow.io;
    pageWindow.io = function (...args) {
      const socket = originalIo.apply(this, args);
      attachToSocket(socket);
      return socket;
    };
    Object.keys(originalIo).forEach(k => { try { pageWindow.io[k] = originalIo[k]; } catch (_) {} });

    addStatus('✅ Socket.io hooked (passive mode)');
  }

  function addStatus(msg) {
    console.log(`[ROE] ${msg}`);
  }

  // ─── Claim status ─────────────────────────────────────────────────────────────
  function updateClaimTitle() {
    const el = document.getElementById('roeTitle');
    if (!el || !_domReady) return;
    el.textContent = _claimEmoji;
    el.title = {
      '…': 'Waiting for authorization...',
      '✓': 'Already claimed today',
      '!': 'Not claimed — click to refresh',
    }[_claimEmoji] || '';

    const warn = document.getElementById('roeClaimWarn');
    if (warn) {
      if (_claimEmoji === '!') {
        warn.textContent = '⚠️ RP not claimed!';
        warn.style.display = 'block';
      } else {
        warn.textContent = '';
        warn.style.display = 'none';
      }
    }
    repositionWarnings();
    updateToolWarning();
  }

  async function _fetchClaimStatus() {
    if (!_claimAuthToken) return;
    try {
      const res  = await fetch(CLAIM_API_URL, {
        headers: { 'Authorization': _claimAuthToken, 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      console.log('[ROE claim] claimable:', data.summary?.claimable, '| full summary:', data.summary);
      _claimEmoji  = data.summary.claimable === 0 ? '✓' : '!';
      _nextClaimAt = data.summary.nextClaimAt ? new Date(data.summary.nextClaimAt) : null;
      try {
        if (_nextClaimAt) localStorage.setItem('roeNextClaimAt', _nextClaimAt.toISOString());
        localStorage.setItem('roeClaimEmoji', _claimEmoji);
      } catch (_) {}
    } catch (e) {
      console.log('[ROE claim] fetch error:', e);
      _claimEmoji = '!';
    }
    updateClaimTitle();
  }

  // Automatic check — skip if nextClaimAt is still in the future
  function checkClaim() {
    console.log('[ROE claim] checkClaim() called — nextClaimAt:', _nextClaimAt, '| now:', new Date(), '| will fetch:', !(_nextClaimAt && _nextClaimAt > new Date()));
    if (_nextClaimAt && _nextClaimAt > new Date()) { updateClaimTitle(); return; }
    _fetchClaimStatus();
  }

  // ─── Hardcoded world data (pre-fills tabs before server sends spawn_state) ────
  // Generated from in-game export. Server data always overrides these on receipt.
  const _HARDCODED_MOBS = {"Forest":[{"statsKey":"ForestSlime","type":"SlimeAI","positions":[{"x":367,"y":28},{"x":365,"y":24},{"x":358,"y":25},{"x":361,"y":45},{"x":356,"y":42},{"x":385,"y":13},{"x":388,"y":9},{"x":374,"y":12},{"x":402,"y":56},{"x":397,"y":53},{"x":370,"y":57},{"x":375,"y":63},{"x":392,"y":69},{"x":392,"y":76},{"x":382,"y":76},{"x":371,"y":79},{"x":362,"y":72},{"x":359,"y":75},{"x":334,"y":75},{"x":328,"y":69},{"x":314,"y":74},{"x":332,"y":27},{"x":334,"y":24},{"x":339,"y":26},{"x":340,"y":24},{"x":342,"y":17},{"x":374,"y":-20},{"x":361,"y":-26},{"x":354,"y":-33},{"x":350,"y":-27},{"x":317,"y":-21},{"x":313,"y":-23},{"x":332,"y":-35},{"x":332,"y":-38},{"x":329,"y":-55},{"x":336,"y":-57},{"x":344,"y":-59},{"x":358,"y":-56},{"x":370,"y":-44},{"x":374,"y":-63},{"x":381,"y":-63},{"x":380,"y":-67},{"x":386,"y":-65},{"x":405,"y":-57},{"x":410,"y":-55},{"x":415,"y":-57},{"x":419,"y":-54},{"x":336,"y":-64},{"x":293,"y":-25},{"x":275,"y":-57},{"x":271,"y":-53},{"x":226,"y":-18},{"x":302,"y":-70},{"x":281,"y":5},{"x":284,"y":9},{"x":238,"y":7},{"x":203,"y":10},{"x":193,"y":17},{"x":290,"y":82},{"x":292,"y":84},{"x":271,"y":78},{"x":232,"y":49},{"x":236,"y":49},{"x":210,"y":56},{"x":214,"y":59},{"x":197,"y":73},{"x":200,"y":84},{"x":204,"y":87},{"x":354,"y":64},{"x":362,"y":61},{"x":186,"y":-55},{"x":182,"y":-52},{"x":177,"y":-47},{"x":132,"y":-54},{"x":125,"y":-53},{"x":123,"y":-57},{"x":124,"y":-48},{"x":126,"y":-38},{"x":130,"y":-40},{"x":173,"y":-26},{"x":97,"y":-22},{"x":99,"y":-19},{"x":112,"y":-16},{"x":117,"y":-15},{"x":138,"y":-13},{"x":161,"y":-13},{"x":173,"y":12},{"x":177,"y":13},{"x":146,"y":11},{"x":144,"y":8},{"x":129,"y":2},{"x":115,"y":15},{"x":114,"y":10},{"x":107,"y":13},{"x":100,"y":12},{"x":97,"y":22},{"x":111,"y":30},{"x":184,"y":31},{"x":179,"y":51},{"x":185,"y":62},{"x":160,"y":63},{"x":142,"y":55},{"x":152,"y":71},{"x":127,"y":51},{"x":117,"y":53},{"x":130,"y":60},{"x":111,"y":61},{"x":107,"y":68},{"x":104,"y":71},{"x":239,"y":-39},{"x":314,"y":-26}]},{"statsKey":"MushroomSprite","type":"MushroomAI","positions":[{"x":389,"y":37},{"x":403,"y":30},{"x":404,"y":23},{"x":419,"y":23},{"x":430,"y":46},{"x":334,"y":12},{"x":339,"y":9},{"x":322,"y":-5},{"x":349,"y":-16},{"x":406,"y":-64},{"x":402,"y":-59},{"x":298,"y":-27},{"x":302,"y":-32},{"x":237,"y":-25},{"x":227,"y":-33},{"x":216,"y":16},{"x":217,"y":12},{"x":221,"y":10},{"x":199,"y":8},{"x":204,"y":-2},{"x":307,"y":37},{"x":269,"y":75},{"x":274,"y":82},{"x":200,"y":63},{"x":202,"y":-37},{"x":138,"y":-71},{"x":144,"y":-23},{"x":98,"y":-30},{"x":191,"y":-10},{"x":177,"y":8},{"x":134,"y":0},{"x":89,"y":24},{"x":86,"y":30},{"x":87,"y":35},{"x":182,"y":28},{"x":188,"y":30},{"x":167,"y":78},{"x":176,"y":79},{"x":167,"y":84},{"x":123,"y":48},{"x":121,"y":56},{"x":123,"y":63},{"x":119,"y":64},{"x":289,"y":4},{"x":288,"y":7},{"x":273,"y":-67},{"x":252,"y":-58},{"x":246,"y":-58},{"x":242,"y":-40},{"x":232,"y":-30},{"x":163,"y":-29},{"x":149,"y":-40},{"x":209,"y":-33},{"x":207,"y":-7},{"x":161,"y":81},{"x":92,"y":33},{"x":289,"y":-24},{"x":388,"y":-38},{"x":427,"y":27},{"x":425,"y":23},{"x":371,"y":47},{"x":358,"y":41},{"x":297,"y":91},{"x":301,"y":86},{"x":307,"y":86},{"x":251,"y":61}]},{"statsKey":"ShadowWolf","type":"ShadowWolfAI","positions":[{"x":388,"y":75},{"x":384,"y":81},{"x":359,"y":88},{"x":366,"y":88},{"x":347,"y":71},{"x":341,"y":78},{"x":277,"y":-53},{"x":261,"y":0},{"x":274,"y":33},{"x":247,"y":49},{"x":241,"y":44},{"x":198,"y":-35},{"x":190,"y":-55},{"x":170,"y":-53},{"x":162,"y":-50},{"x":166,"y":-45},{"x":150,"y":-69},{"x":161,"y":-71},{"x":155,"y":-68},{"x":170,"y":-67},{"x":109,"y":-64},{"x":104,"y":-61},{"x":167,"y":-36},{"x":172,"y":-37},{"x":125,"y":26},{"x":115,"y":28},{"x":121,"y":30},{"x":132,"y":19},{"x":147,"y":52},{"x":119,"y":59}]},{"statsKey":"WoodenGolem","type":"WoodenGolemAI","positions":[{"x":342,"y":74},{"x":159,"y":-67},{"x":163,"y":-67},{"x":169,"y":-39},{"x":99,"y":-4}]}],"Mines":[{"statsKey":"CrystalBat","type":"CrystalBatAI","positions":[{"x":103,"y":113},{"x":118,"y":121},{"x":77,"y":113},{"x":68,"y":112}]},{"statsKey":"RockMuncher","type":"RockMuncherAI","positions":[{"x":112,"y":122},{"x":112,"y":137},{"x":140,"y":132},{"x":111,"y":146}]},{"statsKey":"CaveCrawler","type":"CaveCrawlerAI","positions":[{"x":141,"y":137},{"x":149,"y":134},{"x":112,"y":150}]},{"statsKey":"OreElemental","type":"OreElementalAI","positions":[{"x":150,"y":140}]}]};

  const _HARDCODED_RES = {"Forest":[{"resource":"ironwoodtree","type":"Tree","rarity":"Common","positions":[{"x":409,"y":-59},{"x":349,"y":-59},{"x":355,"y":59},{"x":335,"y":28},{"x":325,"y":-5},{"x":286,"y":-23},{"x":211,"y":61},{"x":218,"y":76},{"x":268,"y":70},{"x":119,"y":-56},{"x":143,"y":12},{"x":179,"y":52},{"x":130,"y":51},{"x":113,"y":85}]},{"resource":"blackoaktree","type":"Tree","rarity":"Common","positions":[{"x":412,"y":-54},{"x":376,"y":-70},{"x":334,"y":-62},{"x":343,"y":-66},{"x":355,"y":-29},{"x":345,"y":-14},{"x":368,"y":21},{"x":375,"y":58},{"x":290,"y":85},{"x":238,"y":24},{"x":248,"y":46},{"x":175,"y":-45},{"x":94,"y":-20},{"x":103,"y":13},{"x":127,"y":1},{"x":175,"y":-26},{"x":82,"y":27},{"x":118,"y":66},{"x":104,"y":73}]},{"resource":"bronzewoodtree","type":"Tree","rarity":"Common","positions":[{"x":358,"y":46},{"x":400,"y":53},{"x":280,"y":7},{"x":241,"y":15},{"x":221,"y":-23},{"x":166,"y":-51},{"x":185,"y":-74},{"x":164,"y":-14},{"x":152,"y":73}]},{"resource":"goldleaftree","type":"Tree","rarity":"Rare","positions":[{"x":362,"y":89},{"x":164,"y":-40},{"x":115,"y":31}]},{"resource":"cinderhearttree","type":"Tree","rarity":"Uncommon","positions":[{"x":341,"y":72},{"x":266,"y":6},{"x":237,"y":52},{"x":185,"y":-53},{"x":142,"y":51},{"x":91,"y":27}]},{"resource":"dreadwoodtree","type":"Tree","rarity":"Uncommon","positions":[{"x":190,"y":76},{"x":195,"y":6},{"x":200,"y":-8},{"x":226,"y":-38},{"x":181,"y":9},{"x":169,"y":82}]},{"resource":"godwoodtree","type":"Tree","rarity":"Mystical","positions":[{"x":158,"y":-66}]},{"resource":"silverleafflower","type":"Bush","rarity":"Common","positions":[{"x":428,"y":-25},{"x":425,"y":-46},{"x":407,"y":-38},{"x":398,"y":-30},{"x":396,"y":-14},{"x":378,"y":-43},{"x":382,"y":-58},{"x":391,"y":-63},{"x":378,"y":-78},{"x":401,"y":-70},{"x":430,"y":-69},{"x":365,"y":-67},{"x":334,"y":-72},{"x":336,"y":-48},{"x":341,"y":-52},{"x":346,"y":-32},{"x":338,"y":-22},{"x":359,"y":-24},{"x":324,"y":-36},{"x":310,"y":-50},{"x":307,"y":-27},{"x":310,"y":-39},{"x":317,"y":-31},{"x":271,"y":-30},{"x":286,"y":2},{"x":323,"y":5},{"x":328,"y":4},{"x":343,"y":3},{"x":333,"y":16},{"x":321,"y":26},{"x":364,"y":6},{"x":366,"y":11},{"x":369,"y":2},{"x":371,"y":10},{"x":329,"y":34},{"x":358,"y":47},{"x":380,"y":53},{"x":385,"y":-10},{"x":405,"y":27},{"x":402,"y":19},{"x":427,"y":14},{"x":426,"y":35},{"x":421,"y":30},{"x":308,"y":-9},{"x":319,"y":-16},{"x":331,"y":-12},{"x":395,"y":58},{"x":411,"y":51},{"x":422,"y":59},{"x":358,"y":60},{"x":332,"y":63},{"x":304,"y":75},{"x":302,"y":88},{"x":296,"y":80},{"x":296,"y":92},{"x":290,"y":61},{"x":277,"y":75},{"x":263,"y":72},{"x":269,"y":87},{"x":196,"y":3},{"x":199,"y":13},{"x":203,"y":21},{"x":225,"y":-42},{"x":233,"y":-41},{"x":252,"y":-46},{"x":278,"y":-60},{"x":219,"y":-69},{"x":191,"y":-68},{"x":125,"y":-69},{"x":100,"y":-73},{"x":159,"y":-35},{"x":155,"y":-24},{"x":208,"y":-43},{"x":141,"y":5},{"x":137,"y":5},{"x":167,"y":-13},{"x":159,"y":-9},{"x":176,"y":17},{"x":122,"y":-28},{"x":96,"y":-15},{"x":103,"y":-12},{"x":113,"y":-23},{"x":122,"y":-20},{"x":122,"y":-4},{"x":122,"y":-1},{"x":115,"y":-3},{"x":113,"y":16},{"x":81,"y":28},{"x":126,"y":17},{"x":143,"y":27},{"x":143,"y":20},{"x":159,"y":27},{"x":167,"y":32},{"x":169,"y":36},{"x":177,"y":30},{"x":140,"y":51},{"x":145,"y":56},{"x":147,"y":54},{"x":161,"y":85},{"x":177,"y":76},{"x":116,"y":67},{"x":89,"y":58},{"x":122,"y":87},{"x":129,"y":84}]},{"resource":"mistweedflower","type":"Bush","rarity":"Common","positions":[{"x":418,"y":-28},{"x":431,"y":-43},{"x":404,"y":-34},{"x":395,"y":-34},{"x":391,"y":-20},{"x":383,"y":-36},{"x":374,"y":-41},{"x":371,"y":-28},{"x":379,"y":-54},{"x":383,"y":-69},{"x":384,"y":-76},{"x":402,"y":-75},{"x":406,"y":-71},{"x":361,"y":-66},{"x":332,"y":-52},{"x":346,"y":-43},{"x":356,"y":-47},{"x":357,"y":-52},{"x":320,"y":-37},{"x":308,"y":-46},{"x":304,"y":-57},{"x":303,"y":-28},{"x":280,"y":-25},{"x":295,"y":-36},{"x":281,"y":-12},{"x":281,"y":1},{"x":276,"y":4},{"x":302,"y":-1},{"x":314,"y":-3},{"x":335,"y":2},{"x":282,"y":12},{"x":350,"y":4},{"x":354,"y":19},{"x":353,"y":35},{"x":342,"y":35},{"x":335,"y":43},{"x":347,"y":40},{"x":357,"y":40},{"x":356,"y":51},{"x":342,"y":54},{"x":376,"y":52},{"x":370,"y":44},{"x":393,"y":13},{"x":379,"y":-5},{"x":402,"y":-4},{"x":398,"y":37},{"x":422,"y":36},{"x":313,"y":-13},{"x":314,"y":-18},{"x":359,"y":-8},{"x":415,"y":47},{"x":434,"y":54},{"x":433,"y":49},{"x":396,"y":89},{"x":366,"y":74},{"x":328,"y":61},{"x":304,"y":82},{"x":285,"y":88},{"x":288,"y":81},{"x":289,"y":69},{"x":259,"y":69},{"x":249,"y":82},{"x":242,"y":89},{"x":218,"y":15},{"x":221,"y":12},{"x":201,"y":0},{"x":194,"y":20},{"x":201,"y":-10},{"x":236,"y":-36},{"x":257,"y":-48},{"x":262,"y":-57},{"x":266,"y":-56},{"x":273,"y":-58},{"x":208,"y":-68},{"x":185,"y":-65},{"x":173,"y":-78},{"x":167,"y":-74},{"x":152,"y":-63},{"x":143,"y":-58},{"x":105,"y":-71},{"x":106,"y":-46},{"x":113,"y":-39},{"x":159,"y":-41},{"x":158,"y":-32},{"x":162,"y":-27},{"x":160,"y":-22},{"x":166,"y":-23},{"x":165,"y":-21},{"x":167,"y":-27},{"x":184,"y":-22},{"x":188,"y":-15},{"x":205,"y":-29},{"x":139,"y":-12},{"x":172,"y":-2},{"x":168,"y":11},{"x":184,"y":-7},{"x":93,"y":-15},{"x":123,"y":-16},{"x":121,"y":-11},{"x":127,"y":-13},{"x":132,"y":-15},{"x":116,"y":4},{"x":119,"y":12},{"x":125,"y":5},{"x":95,"y":18},{"x":101,"y":21},{"x":109,"y":36},{"x":134,"y":24},{"x":154,"y":34},{"x":150,"y":24},{"x":163,"y":24},{"x":168,"y":41},{"x":173,"y":36},{"x":176,"y":39},{"x":179,"y":36},{"x":182,"y":35},{"x":177,"y":30},{"x":161,"y":34},{"x":162,"y":31},{"x":151,"y":50},{"x":173,"y":80},{"x":139,"y":70},{"x":133,"y":52},{"x":128,"y":54},{"x":112,"y":65},{"x":94,"y":63},{"x":91,"y":43},{"x":111,"y":89}]},{"resource":"bloodrootvineflower","type":"Bush","rarity":"Common","positions":[{"x":421,"y":-38},{"x":433,"y":-42},{"x":410,"y":-43},{"x":395,"y":-27},{"x":388,"y":-24},{"x":398,"y":-20},{"x":380,"y":-48},{"x":373,"y":-58},{"x":367,"y":-54},{"x":381,"y":-75},{"x":392,"y":-74},{"x":399,"y":-73},{"x":410,"y":-74},{"x":415,"y":-70},{"x":418,"y":-65},{"x":356,"y":-69},{"x":347,"y":-76},{"x":358,"y":-40},{"x":339,"y":-30},{"x":334,"y":-30},{"x":320,"y":-45},{"x":305,"y":-66},{"x":311,"y":-29},{"x":302,"y":-22},{"x":287,"y":-45},{"x":276,"y":-47},{"x":269,"y":-41},{"x":266,"y":-29},{"x":269,"y":-25},{"x":289,"y":-32},{"x":278,"y":-6},{"x":288,"y":5},{"x":297,"y":24},{"x":350,"y":17},{"x":356,"y":5},{"x":339,"y":40},{"x":349,"y":54},{"x":379,"y":26},{"x":387,"y":25},{"x":394,"y":18},{"x":386,"y":-5},{"x":374,"y":4},{"x":408,"y":32},{"x":416,"y":30},{"x":425,"y":21},{"x":421,"y":12},{"x":428,"y":11},{"x":430,"y":32},{"x":308,"y":-14},{"x":318,"y":-12},{"x":338,"y":-14},{"x":335,"y":-9},{"x":354,"y":-6},{"x":413,"y":54},{"x":395,"y":74},{"x":396,"y":79},{"x":383,"y":58},{"x":355,"y":72},{"x":331,"y":89},{"x":300,"y":66},{"x":268,"y":68},{"x":201,"y":0},{"x":265,"y":-49},{"x":224,"y":-76},{"x":167,"y":-66},{"x":170,"y":-61},{"x":134,"y":-69},{"x":148,"y":-37},{"x":154,"y":-41},{"x":167,"y":-20},{"x":175,"y":-16},{"x":179,"y":-18},{"x":198,"y":-20},{"x":209,"y":-33},{"x":212,"y":-31},{"x":146,"y":-16},{"x":141,"y":0},{"x":175,"y":0},{"x":180,"y":4},{"x":170,"y":20},{"x":104,"y":-29},{"x":95,"y":-17},{"x":102,"y":6},{"x":94,"y":13},{"x":89,"y":14},{"x":101,"y":26},{"x":104,"y":18},{"x":97,"y":30},{"x":101,"y":35},{"x":129,"y":37},{"x":131,"y":39},{"x":133,"y":42},{"x":139,"y":25},{"x":155,"y":38},{"x":165,"y":40},{"x":157,"y":30},{"x":174,"y":66},{"x":166,"y":59},{"x":157,"y":62},{"x":160,"y":75},{"x":155,"y":87},{"x":164,"y":88},{"x":170,"y":74},{"x":98,"y":67}]},{"resource":"moonpetalflower","type":"Bush","rarity":"Uncommon","positions":[{"x":367,"y":89},{"x":347,"y":89},{"x":96,"y":-48},{"x":170,"y":-33},{"x":126,"y":32},{"x":147,"y":31},{"x":150,"y":38}]},{"resource":"mourninglilyflower","type":"Bush","rarity":"Uncommon","positions":[{"x":364,"y":84},{"x":266,"y":8},{"x":199,"y":-64},{"x":203,"y":-62},{"x":163,"y":-67},{"x":147,"y":-66},{"x":101,"y":-54},{"x":174,"y":-38},{"x":106,"y":0},{"x":120,"y":35},{"x":161,"y":40}]},{"resource":"shadowleafflower","type":"Bush","rarity":"Rare","positions":[{"x":202,"y":-74},{"x":176,"y":-61},{"x":86,"y":-9},{"x":90,"y":-7},{"x":130,"y":27}]},{"resource":"witchbaneflower","type":"Bush","rarity":"Mystical","positions":[{"x":101,"y":-8}]}],"Town":[{"resource":"silverleafflower","type":"Bush","rarity":"Common","positions":[{"x":-66,"y":46},{"x":-27,"y":34},{"x":27,"y":60},{"x":16,"y":31},{"x":-61,"y":-28},{"x":-16,"y":19},{"x":12,"y":-32}]},{"resource":"mistweedflower","type":"Bush","rarity":"Common","positions":[{"x":-53,"y":44},{"x":-41,"y":38},{"x":9,"y":54},{"x":9,"y":44},{"x":22,"y":10},{"x":11,"y":-5},{"x":-9,"y":-11},{"x":-10,"y":-4},{"x":-26,"y":-21},{"x":-67,"y":-19},{"x":-29,"y":-37},{"x":-4,"y":-30}]},{"resource":"bloodrootvineflower","type":"Bush","rarity":"Common","positions":[{"x":-19,"y":42},{"x":-13,"y":44},{"x":0,"y":60},{"x":-1,"y":46},{"x":24,"y":38},{"x":-15,"y":19},{"x":-57,"y":8},{"x":-25,"y":-2},{"x":-44,"y":-30},{"x":-38,"y":-33},{"x":1,"y":-37},{"x":1,"y":-32},{"x":-2,"y":-25},{"x":17,"y":-24}]}],"Mines":[{"resource":"copperorenode","type":"Ore","rarity":"Common","positions":[{"x":60,"y":111},{"x":80,"y":112}]},{"resource":"ironorenode","type":"Ore","rarity":"Common","positions":[{"x":65,"y":115},{"x":106,"y":123}]},{"resource":"dinobonesnode","type":"Ore","rarity":"Mystical","positions":[{"x":135,"y":133},{"x":154,"y":144},{"x":140,"y":135}]},{"resource":"crystalrocknode","type":"Ore","rarity":"Mystical","positions":[{"x":148,"y":144}]},{"resource":"goldorenode","type":"Ore","rarity":"Uncommon","positions":[{"x":109,"y":139},{"x":116,"y":151}]},{"resource":"titaniumorenode","type":"Ore","rarity":"Rare","positions":[{"x":107,"y":148}]}]};

  (function _seedHardcodedData() {
    let idCounter = -1; // negative IDs to avoid colliding with real server IDs
    Object.entries(_HARDCODED_MOBS).forEach(([zone, groups]) => {
      if (lastStateByZone[zone] && lastStateByZone[zone].length) return; // server data takes priority
      const enemies = [];
      groups.forEach(({ statsKey, type, positions }) => {
        knownTypes.add(statsKey);
        positions.forEach(pos => {
          enemies.push({ id: idCounter--, entityIndex: null, statsKey, type, alive: true, hp: 0, maxHp: 0, respawnAt: null, pos: { x: pos.x, y: pos.y } });
        });
      });
      lastStateByZone[zone] = enemies;
      knownZones.add(zone);
    });

    let ridCounter = -1;
    Object.entries(_HARDCODED_RES).forEach(([zone, groups]) => {
      if (lastResourcesByZone[zone] && lastResourcesByZone[zone].length) return;
      const resources = [];
      groups.forEach(({ resource, type, rarity, positions }) => {
        knownResNames.add(resource);
        positions.forEach((pos, i) => {
          resources.push({ idx: resources.length, id: ridCounter--, resource, type, rarity, weakness: '', active: true, hp: 0, maxHp: 0, cooldownExpiresAt: null, pos: { x: pos.x, y: pos.y } });
        });
      });
      lastResourcesByZone[zone] = resources;
      knownZones.add(zone);
    });

    // Trigger UI updates now that data is seeded
    refreshSelects();
    refreshResSelects();
  })();

  // ─── Init ────────────────────────────────────────────────────────────────────
  updateTrackTab();
  updateMarketTab();
  hookSocket();
  addStatus('🟡 Waiting for socket.io...');

  // ─── WS Ring buffer trimmer ───────────────────────────────────────────────────
  // Runs every 30 s to drop entries older than WS_RING_WINDOW_MS.
  // Using splice-from-front once per interval is far cheaper than shifting on
  // every single event, and 30 s latency in the window edge is fine for debugging.
  function trimRingBuffer() {
    const cutoff = Date.now() - WS_RING_WINDOW_MS;
    let i = 0;
    while (i < wsRingBuffer.length && wsRingBuffer[i].ts < cutoff) i++;
    if (i > 0) wsRingBuffer.splice(0, i);
  }
  setInterval(trimRingBuffer, 30_000);

  // ─── Claim countdown ticker ───────────────────────────────────────────────────
  function tickClaimCountdown() {
    const el = document.getElementById('roeClaimCountdown');
    if (!el) return;
    if (!_nextClaimAt || _claimEmoji !== '✓') { el.style.display = 'none'; return; }
    const diff = _nextClaimAt - Date.now();
    if (diff <= 0) {
      el.style.display = 'none';
      _claimEmoji = '!';
      updateClaimTitle();
      return;
    }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    const timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    el.textContent = `Next RR Claim: ${timeStr}`;
    el.style.display = '';
  }
  setInterval(tickClaimCountdown, 1000);
  tickClaimCountdown(); // show immediately on load instead of waiting up to 1s for the first tick

  // ─── Intercept fetch for claim token ───────────────────────────────────────────
  const _origFetch = pageWindow.fetch;
  let _claimCheckTimer = null;
  pageWindow.fetch = async function (...args) {
    const res = await _origFetch(...args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';

    // Grab token directly from login-wallet response — most reliable source
    if (url.includes('/api/auth/login-wallet')) {
      try {
        const clone = res.clone();
        const body = await clone.json();
        const token = body.authToken || body.token;
        if (token && token.length > 10) {
          _claimAuthToken = `Bearer ${token}`;
          try { localStorage.setItem('roeClaimAuthToken', _claimAuthToken); } catch (_) {}
          clearTimeout(_claimCheckTimer);
          _claimCheckTimer = setTimeout(() => {
            if (_socketReady) checkClaim();
          }, 2000);
        }
      } catch (e) { /* ignore */ }
    }

    // Read claim result directly — no extra request needed
    if (url.includes('/api/ruyui-nfts/claim-rr')) {
      try {
        const clone = res.clone();
        const body = await clone.json();
        if (body.ok) {
          _claimEmoji = '✓';
          if (body.nextClaimAt) {
            _nextClaimAt = new Date(body.nextClaimAt);
          } else {
            _nextClaimAt = new Date(Date.now() + 86400000);
          }
          try { localStorage.setItem('roeNextClaimAt', _nextClaimAt.toISOString()); localStorage.setItem('roeClaimEmoji', '✓'); } catch (_) {}
          updateClaimTitle();
          // Schedule next check for nextClaimAt (+ 10s buffer)
          clearTimeout(_claimCheckTimer);
          _claimCheckTimer = setTimeout(() => checkClaim(), _nextClaimAt - Date.now() + 10000);
        }
      } catch (e) { /* ignore */ }
    }

    return res;
  };

  // ─── Click on roeTitle — manual claim refresh ──────────────────────────────────
  document.getElementById('roeTitle').style.cursor = 'pointer';
  document.getElementById('roeTitle').addEventListener('click', e => {
    e.stopPropagation();
    _fetchClaimStatus();
  });

  // ─── Alt+H: fully hide / show panel ───────────────────────────────────────────
  let _panelHidden = false;
  document.addEventListener('keydown', e => {
    if (e.altKey && e.key === 'h') {
      _panelHidden = !_panelHidden;
      panel.style.display = _panelHidden ? 'none' : 'flex';
    }
  });

  // ─── Auto-fade: transparent when mouse is not over the panel ──────────────────
  let _autoHide = false;
  panel.style.transition = 'opacity 0.3s';
  panel.style.opacity    = '1';
  panel.addEventListener('mouseenter', () => { panel.style.opacity = '1'; });
  panel.addEventListener('mouseleave', () => { if (_autoHide) panel.style.opacity = '0'; });

  setTimeout(() => {
    const eyeBtn = document.getElementById('roeEyeBtn');
    if (eyeBtn) {
      eyeBtn.onclick = () => {
        _autoHide = !_autoHide;
        eyeBtn.style.opacity = _autoHide ? '0.4' : '1';
        panel.style.opacity  = _autoHide ? '0' : '1';
      };
    }
  }, 0);

  // ─── Timer-based notifications (fires when respawn timer expires) ────────────
  // Called every second. Checks all tracked entries against their local timers
  // so notifications work even when the player is in a different zone
  // (server only sends spawn events for the current zone).
  function tickTrackedNotifications() {
    const now = Date.now();

    trackedMobs.forEach((v, id) => {
      if (!v.notifyOnSpawn) return;
      const playerInZone = _currentZone === v.zone;
      const mobReady = n => {
        if (n.alive) return true;
        if (playerInZone) return false; // in-zone: never trust the estimated timer, only a confirmed alive
        let rt = enemyRespawnTimers.get(n.id);
        if (!rt && n.pos) { const pk = _mobPosKey(v.zone, v.statsKey, n.pos); rt = _stableMobTimers[pk]; }
        return !rt || rt <= now;
      };
      const totalN = v.nodes.length;
      const readyCount = v.nodes.filter(mobReady).length;
      const fullSlots = !v.notifyOnlyWhenFull || totalN === 0 || readyCount === totalN;
      if (fullSlots) {
        v.nodes.forEach(n => {
          const nodeKey = `${id}:${n.id}`;
          const wasReady = previousNodeReadyState.get(nodeKey);
          const isReady = mobReady(n);
          if (wasReady === false && isReady) {
            addSysLog('notify_debug_mob', {
              source: 'tick', trackId: id, statsKey: v.statsKey, zone: v.zone, nodeId: n.id,
              playerInZone, alive: n.alive, pos: n.pos || null,
              wasReady, isReady, notifyOnlyWhenFull: !!v.notifyOnlyWhenFull,
              readyCount, totalN, ts: now
            });
            notifyTrack(v, n.pos
              ? `[${v.zone}] ${formatDisplayName(v.statsKey)} spawned at x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
              : null);
          }
          previousNodeReadyState.set(nodeKey, isReady);
        });
      } else {
        v.nodes.forEach(n => {
          previousNodeReadyState.set(`${id}:${n.id}`, mobReady(n));
        });
      }
      previousTrackedMobStates.set(id, { aliveCount: v.nodes.filter(n => n.alive).length, readyCount });
    });

    trackedResources.forEach((v, id) => {
      if (!v.notifyOnSpawn) return;
      const playerInZone = _currentZone === v.zone;
      const nodeReady = n => {
        if (n.active) return true;
        if (playerInZone) return false; // in-zone: never trust the estimated timer, only confirmed active
        const timerRaw = getNodeMaxTimer(n.idx);
        return (!timerRaw) || (timerRaw <= now);
      };
      const totalN = v.nodes.length;
      const readyCount = v.nodes.filter(nodeReady).length;
      const fullSlots = !v.notifyOnlyWhenFull || totalN === 0 || readyCount === totalN;
      if (fullSlots) {
        v.nodes.forEach(n => {
          const nodeKey = `${id}:${n.idx}`;
          const wasReady = previousNodeReadyState.get(nodeKey);
          const isReady = nodeReady(n);
          if (wasReady === false && isReady) {
            addSysLog('notify_debug_res', {
              source: 'tick', trackId: id, resource: v.resource, zone: v.zone, nodeIdx: n.idx,
              playerInZone, active: n.active, pos: n.pos || null,
              wasReady, isReady, notifyOnlyWhenFull: !!v.notifyOnlyWhenFull,
              readyCount, totalN, ts: now
            });
            notifyTrack(v, n.pos
              ? `[${v.zone}] ${formatResName(v.resource)} spawned at x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}`
              : null);
          }
          previousNodeReadyState.set(nodeKey, isReady);
        });
      } else {
        v.nodes.forEach(n => {
          previousNodeReadyState.set(`${id}:${n.idx}`, nodeReady(n));
        });
      }
      previousTrackedStates.set(id, { activeCount: v.nodes.filter(n => n.active).length, readyCount });
    });
  }

  // ─── Tick every second to update countdown timers ────────────────────────────
  setInterval(() => {
    tickTrackedNotifications();
    if (activeTab === 'state')  renderStatePane();
    if (activeTab === 'res')    renderResPane();
    if (activeTab === 'track')  renderTrackPane();
    if (activeTab === 'qb')     renderQBPane();
    // Also tick floating panels
    ['state','res','track','qb'].forEach(k => { if (_poppedOut.has(k)) renderTabContent(k); });
  }, 1000);

})();
