(function () {
  const STREAM_URL = "/api/stream";
  const PLAN_SYNC_URL = "/api/plan";
  const PLAN_STORAGE_KEY = "msfs_imported_plan_v1";
  const BASE_LAYER_STORAGE_KEY = "msfs_base_layer_v1";
  const statusEl = document.getElementById("status");
  const detailEl = document.getElementById("detail");
  const planinfoEl = document.getElementById("planinfo");
  const plnFile = document.getElementById("plnFile");
  const btnImport = document.getElementById("btnImport");
  const btnFit = document.getElementById("btnFit");
  const btnClear = document.getElementById("btnClear");
  const btnFollow = document.getElementById("btnFollow");

  /** 经度归入 (-180,180]，与 noWrap 单世界地图一致，避免机标与航迹落在相邻「复制地球」上 */
  function wrapLng180(lon) {
    if (lon == null || !Number.isFinite(lon)) return lon;
    let w = ((lon + 180) % 360 + 360) % 360 - 180;
    return w === -180 ? 180 : w;
  }

  const MAP_WORLD_BOUNDS = L.latLngBounds([-85, -180], [85, 180]);
  const map = L.map("map", {
    zoomControl: false,
    maxBounds: MAP_WORLD_BOUNDS,
    maxBoundsViscosity: 1.0,
    worldCopyJump: false
  }).setView([39.9, 116.4], 5);

  const baseLayerDefs = {
    osm: {
      menuLabel: "OSM 街道",
      create: function () {
        return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          noWrap: true
        });
      }
    },
    carto_voyager: {
      menuLabel: "Carto Voyager",
      create: function () {
        return L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
          {
            maxZoom: 20,
            attribution:
              '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © ' +
              '<a href="https://carto.com/attributions">CARTO</a>',
            noWrap: true,
            subdomains: "abcd"
          }
        );
      }
    },
    esri_street: {
      menuLabel: "Esri 街道",
      create: function () {
        return L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 20,
            attribution: "Tiles © Esri",
            noWrap: true
          }
        );
      }
    },
    opentopo: {
      menuLabel: "OpenTopo 地形",
      create: function () {
        return L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
          maxZoom: 17,
          attribution:
            '© <a href="https://opentopomap.org">OpenTopoMap</a> · ' +
            '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          noWrap: true,
          subdomains: "abc"
        });
      }
    },
    esri_img: {
      menuLabel: "Esri 卫星",
      create: function () {
        return L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 20,
            attribution: "Tiles © Esri",
            noWrap: true
          }
        );
      }
    }
  };

  const baseLayerOrder = [
    "osm",
    "carto_voyager",
    "esri_street",
    "opentopo",
    "esri_img"
  ];
  const baseLayersById = {};
  for (var bi = 0; bi < baseLayerOrder.length; bi++) {
    var bid = baseLayerOrder[bi];
    baseLayersById[bid] = baseLayerDefs[bid].create();
  }

  var currentBaseId = "osm";
  try {
    var savedBase = localStorage.getItem(BASE_LAYER_STORAGE_KEY);
    if (savedBase && baseLayerDefs[savedBase]) currentBaseId = savedBase;
  } catch (eBase) {}
  var currentBaseLayer = baseLayersById[currentBaseId];
  currentBaseLayer.addTo(map);

  const baseLayerSelect = document.getElementById("baseLayerSelect");
  if (baseLayerSelect) {
    for (var oi = 0; oi < baseLayerOrder.length; oi++) {
      var oid = baseLayerOrder[oi];
      var opt = document.createElement("option");
      opt.value = oid;
      opt.textContent = baseLayerDefs[oid].menuLabel;
      baseLayerSelect.appendChild(opt);
    }
    baseLayerSelect.value = currentBaseId;
    baseLayerSelect.addEventListener("change", function () {
      var nid = baseLayerSelect.value;
      if (!baseLayerDefs[nid] || nid === currentBaseId) return;
      map.removeLayer(currentBaseLayer);
      currentBaseId = nid;
      currentBaseLayer = baseLayersById[currentBaseId];
      currentBaseLayer.addTo(map);
      try {
        localStorage.setItem(BASE_LAYER_STORAGE_KEY, currentBaseId);
      } catch (eStore) {}
    });
  }

  /**
   * 跟随时机标垂直对齐：在「地图顶 → 仪表顶（含收起后的细条）」可见带内取比例（0.5=几何中心）。
   * 纯手机仅在仪表展开时用 0.4；手机收起、电脑端仍整图 panTo。平板展开/收起均用可见带 + 0.5。
   */
  const FOLLOW_EXPANDED_VISIBLE_Y_FRAC = 0.5;
  const FOLLOW_EXPANDED_VISIBLE_Y_FRAC_PHONE = 0.4;
  function panMapFollowPlane(latLng) {
    const panel = document.getElementById("pfdPanel");
    const deckExpanded = panel && !panel.classList.contains("is-collapsed");
    const zoom = map.getZoom();
    const ll = latLng instanceof L.LatLng ? latLng : L.latLng(latLng[0], latLng[1]);
    var root = document.documentElement;
    var shortSide = Math.min(window.innerWidth, window.innerHeight);
    var isTablet =
      root.classList.contains("tablet-adapt") ||
      (root.classList.contains("mobile-adapt") && shortSide >= 600);
    var phoneOnly =
      root.classList.contains("mobile-adapt") && !isTablet;
    /* 纯手机收起、或电脑端收起：保持整图对准机位（与原先一致） */
    if (
      !deckExpanded &&
      (phoneOnly || !root.classList.contains("mobile-adapt"))
    ) {
      map.panTo(ll, { animate: false });
      return;
    }
    if (!panel) {
      map.panTo(ll, { animate: false });
      return;
    }
    const mapEl = map.getContainer();
    const mapRect = mapEl.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const visibleTop = mapRect.top;
    const visibleBottom = Math.min(mapRect.bottom, panelRect.top);
    const bandH = Math.max(0, visibleBottom - visibleTop);
    var yFrac =
      phoneOnly && deckExpanded
        ? FOLLOW_EXPANDED_VISIBLE_Y_FRAC_PHONE
        : FOLLOW_EXPANDED_VISIBLE_Y_FRAC;
    const visibleTargetY = visibleTop + bandH * yFrac;
    const mapMidY = mapRect.top + mapRect.height / 2;
    let py = Math.round(mapMidY - visibleTargetY);
    if (py < 0) py = 0;
    /* 理论最大约为半屏，略放宽避免舍入导致压不到正中心 */
    var pyMax = mapRect.height > 40 ? Math.round(mapRect.height * 0.5) + 2 : py;
    if (py > pyMax) py = pyMax;
    const target = map.project(ll, zoom);
    const shifted = target.add(L.point(0, py));
    map.panTo(map.unproject(shifted, zoom), { animate: false });
  }

  const planeIcon = L.divIcon({
    className: "plane-marker",
    html:
      '<div class="plane-hdg" style="width:16px;height:24px;transform-origin:8px 12px;will-change:transform">' +
      '<div style="position:absolute;left:50%;bottom:2px;width:0;height:0;margin-left:-8px;' +
      "border-left:8px solid transparent;border-right:8px solid transparent;" +
      'border-bottom:20px solid #58a6ff;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))"></div></div>',
    iconSize: [16, 24],
    iconAnchor: [8, 12]
  });

  let marker = null;
  let trailLayer = null;
  let followPlane = true;
  let planGroup = L.layerGroup().addTo(map);
  let planLine = null;
  let planWaypoints = [];
  let planTitle = "";
  let nextWpSeq = 0;
  /** 距当前目标航路点小于此值（海里）视为到达；略加大以符合「飞到附近即算」 */
  const PASS_NM = 2.8;
  /** 沿计划航线累积距离已超过该点此后（海里）亦视为飞过，避免侧偏时永远卡在同一航点 */
  const PASS_ALONG_NM = 0.32;
  let lastTelemetry = null;
  /** 与 msfs_bridge 上航线版本对齐：电脑/手机同一局域网下共用一条导入的 .pln */
  let planSyncInitialized = false;
  let lastServerPlanRev = null;
  const PITCH_PX_PER_DEG = 6.2;
  /** 与 .att-pitch / SVS SVG viewBox 宽度一致（加宽防横滚黑角） */
  const ADI_VB_W = 400, ADI_VB_H = 720, ADI_HZ = 360;

  let tgtLat = 0, tgtLon = 0;
  let tgtPitch = 0, tgtBank = 0, tgtIas, tgtAlt, tgtHdg = 0, tgtGs, tgtVs, tgtTrack;
  let dispLat = 0, dispLon = 0;
  let dispPitch = 0, dispBank = 0, dispIas, dispAlt, dispHdg = 0, dispGs, dispVs, dispTrack;
  let tgtGroundElevFt = null,
    dispGroundElevFt = null,
    tgtRadioHeightFt = null,
    dispRadioHeightFt = null,
    tgtAglGameFt = null,
    dispAglGameFt = null,
    tgtAglBaroFt = null,
    dispAglBaroFt = null;
  let smoothReady = false;
  /** 时间常数略大 + 单帧 k 上限，抹平遥测台阶、长帧后不大跳 */
  const SMOOTH_TAU_ATT_MS = 190;
  const SMOOTH_TAU_MAIN_MS = 245;
  const SMOOTH_TAU_VS_MS = 210;
  const SMOOTH_K_ATT_CAP = 0.38;
  const SMOOTH_K_MAIN_CAP = 0.34;
  const SMOOTH_K_VS_CAP = 0.3;
  /** 航向/航迹：快跟遥测，减小与模拟器仪表的固定滞后（其它量仍用 kMain） */
  const SMOOTH_TAU_HDG_MS = 18;
  const SMOOTH_K_HDG_CAP = 0.985;
  let lastSmoothT = 0;

  function smoothTowardDisp(tgt, disp, k) {
    if (tgt == null || !Number.isFinite(tgt)) return disp;
    if (disp == null || !Number.isFinite(disp)) return tgt;
    return disp + (tgt - disp) * k;
  }

  function tickSmooth(now) {
    requestAnimationFrame(tickSmooth);
    const t = typeof now === "number" ? now : performance.now();

    if (!lastTelemetry || !lastTelemetry.ok) {
      lastSmoothT = 0;
      return;
    }

    const dtRaw = lastSmoothT <= 0 ? 1000 / 60 : t - lastSmoothT;
    const dt = Math.min(100, Math.max(0, dtRaw));
    lastSmoothT = t;
    const kAtt = Math.min(SMOOTH_K_ATT_CAP, 1 - Math.exp(-dt / SMOOTH_TAU_ATT_MS));
    const kMain = Math.min(SMOOTH_K_MAIN_CAP, 1 - Math.exp(-dt / SMOOTH_TAU_MAIN_MS));
    const kVs = Math.min(SMOOTH_K_VS_CAP, 1 - Math.exp(-dt / SMOOTH_TAU_VS_MS));
    const kHdg = Math.min(SMOOTH_K_HDG_CAP, 1 - Math.exp(-dt / SMOOTH_TAU_HDG_MS));

    if (!smoothReady) {
      dispLat = tgtLat;
      dispLon = tgtLon;
      dispPitch = tgtPitch;
      dispBank = tgtBank;
      dispIas = tgtIas;
      dispAlt = tgtAlt;
      dispHdg = tgtHdg;
      dispGs = tgtGs;
      dispVs = tgtVs;
      dispTrack = tgtTrack != null && Number.isFinite(tgtTrack) ? tgtTrack : null;
      dispGroundElevFt = tgtGroundElevFt;
      dispRadioHeightFt = tgtRadioHeightFt;
      dispAglGameFt = tgtAglGameFt;
      dispAglBaroFt = tgtAglBaroFt;
      smoothReady = true;
    } else {
      dispLat += (tgtLat - dispLat) * kMain;
      let dLon = tgtLon - dispLon;
      while (dLon > 180) dLon -= 360;
      while (dLon < -180) dLon += 360;
      dispLon += dLon * kMain;
      if (tgtPitch != null && Number.isFinite(tgtPitch)) {
        dispPitch += (tgtPitch - dispPitch) * kAtt;
      }
      if (tgtBank != null && Number.isFinite(tgtBank)) {
        let db = tgtBank - dispBank;
        while (db > 180) db -= 360;
        while (db < -180) db += 360;
        dispBank += db * kAtt;
      }
      if (tgtIas != null && Number.isFinite(tgtIas)) {
        const d0 = dispIas != null && Number.isFinite(dispIas) ? dispIas : tgtIas;
        dispIas = d0 + (tgtIas - d0) * kMain;
      }
      if (tgtAlt != null && Number.isFinite(tgtAlt)) {
        const d0 = dispAlt != null && Number.isFinite(dispAlt) ? dispAlt : tgtAlt;
        dispAlt = d0 + (tgtAlt - d0) * kMain;
      }
      if (tgtHdg != null && Number.isFinite(tgtHdg)) {
        let dh = tgtHdg - dispHdg;
        while (dh > 180) dh -= 360;
        while (dh < -180) dh += 360;
        dispHdg += dh * kHdg;
      }
      if (tgtGs != null && Number.isFinite(tgtGs)) {
        const d0 = dispGs != null && Number.isFinite(dispGs) ? dispGs : tgtGs;
        dispGs = d0 + (tgtGs - d0) * kMain;
      }
      if (tgtVs != null && Number.isFinite(tgtVs)) {
        const d0 = dispVs != null && Number.isFinite(dispVs) ? dispVs : tgtVs;
        dispVs = d0 + (tgtVs - d0) * kVs;
      }
      if (tgtTrack != null && Number.isFinite(tgtTrack)) {
        if (dispTrack == null || !Number.isFinite(dispTrack)) {
          dispTrack = tgtTrack;
        } else {
          let dtr = tgtTrack - dispTrack;
          while (dtr > 180) dtr -= 360;
          while (dtr < -180) dtr += 360;
          dispTrack += dtr * kHdg;
        }
      }
      dispGroundElevFt = smoothTowardDisp(tgtGroundElevFt, dispGroundElevFt, kMain);
      dispRadioHeightFt = smoothTowardDisp(tgtRadioHeightFt, dispRadioHeightFt, kMain);
      dispAglGameFt = smoothTowardDisp(tgtAglGameFt, dispAglGameFt, kMain);
      dispAglBaroFt = smoothTowardDisp(tgtAglBaroFt, dispAglBaroFt, kMain);
    }
    /* 有气压高与标高时用插值后差值，与高度带一致，避免 TERR/AGL 数字脱节 */
    let dispAglBaroUse = dispAglBaroFt;
    if (
      dispAlt != null &&
      dispGroundElevFt != null &&
      Number.isFinite(dispAlt) &&
      Number.isFinite(dispGroundElevFt)
    ) {
      dispAglBaroUse = dispAlt - dispGroundElevFt;
    }
    updateAttitude(dispPitch, dispBank);
    updateSpeedTape(dispIas);
    updateAltTape(dispAlt);
    updateAdiHud(
      dispIas,
      dispAlt,
      dispVs,
      tgtHdg,
      dispBank,
      dispGroundElevFt,
      dispRadioHeightFt,
      dispAglBaroUse,
      dispAglGameFt
    );
    updateAdiTerrain(
      dispRadioHeightFt,
      dispAglBaroUse,
      dispAglGameFt,
      dispAlt,
      dispGroundElevFt,
      dispLat,
      dispLon
    );
    updateAdiRunwayOverlay(lastTelemetry, dispPitch, dispBank, dispAlt, dispHdg, dispLat, dispLon);
    const hEl = document.getElementById("pfdHdg");
    const vEl = document.getElementById("pfdVs");
    const gsEl = document.getElementById("pfdGs");
    if (hEl) hEl.textContent = fmtNum(normHdg(tgtHdg), 1);
    if (vEl) vEl.textContent =
      dispVs != null && Number.isFinite(dispVs) ? String(Math.round(dispVs)) : "—";
    if (gsEl) gsEl.textContent = fmtNum(dispGs, 0);
    if (marker) {
      const mapLon = wrapLng180(dispLon);
      marker.setLatLng([dispLat, mapLon]);
      const el = marker.getElement();
      const wrap = el && el.querySelector(".plane-hdg");
      const hdgMap =
        lastTelemetry && lastTelemetry.ok &&
        lastTelemetry.heading_deg != null &&
        Number.isFinite(lastTelemetry.heading_deg)
          ? normHdg(lastTelemetry.heading_deg)
          : dispHdg;
      if (wrap && hdgMap != null && Number.isFinite(hdgMap)) {
        wrap.style.transform = "rotate(" + hdgMap + "deg)";
      }
      if (followPlane) panMapFollowPlane(L.latLng(dispLat, mapLon));
    }
    redrawNd();
    redrawAdiVnavProfile();
    if (planWaypoints.length) planHudLine(dispLat, dispLon);
  }

  function buildPitchLadder() {
    const el = document.getElementById("pitchLadder");
    if (!el) return;
    const px = PITCH_PX_PER_DEG;
    const h = 720;
    var html = "";
    function addFineLine(deg, widthPct) {
      const yPx = h / 2 - deg * px;
      const pct = (yPx / h) * 100;
      const w = widthPct != null ? widthPct : 62;
      html += '<div class="att-pitch-line pitch-fine" style="top:' + pct + "%;width:" + w + '%"></div>';
    }
    function addMajorLine(deg, widthPct) {
      const yPx = h / 2 - deg * px;
      const pct = (yPx / h) * 100;
      const w = widthPct != null ? widthPct : 62;
      const lbl = Math.abs(deg);
      html += '<div class="att-pitch-row pitch-major" style="top:' + pct + '%">';
      html += '<span class="att-pitch-lbl l">' + lbl + "</span>";
      html += '<div class="att-pitch-line-track" style="width:' + w + '%"></div>';
      html += '<span class="att-pitch-lbl r">' + lbl + "</span>";
      html += "</div>";
    }
    function fineW(d) {
      var base = Math.floor(d / 10) * 10;
      var nearUp = 10 - (d - base);
      if (nearUp < 0 || nearUp > 10) nearUp = 5;
      /* 细划比主刻度明显更短（约 0.65×） */
      return Math.round((26 + (nearUp / 10) * 28) * 0.65);
    }
    /* 2.5° 一档至 ±60°；10/20/30… 为主刻度（与常见 ADI 一致），±20° 以外上下对称延伸 */
    const pitchStepsUp = [];
    for (let v = 60; v >= 2.5; v -= 2.5) {
      pitchStepsUp.push(v);
    }
    pitchStepsUp.forEach(function (d) {
      var isMajor = d % 10 === 0 && d >= 10;
      /* 主刻度：10/30/50 与 20/40/60 交替宽窄（与原来仅 ±20° 时一致），细划仍按每 10° 内 2.5° 渐变 */
      var w = isMajor ? ((d / 10) % 2 === 1 ? 41 : 51) : fineW(d);
      if (isMajor) {
        addMajorLine(d, w);
        addMajorLine(-d, w);
      } else {
        addFineLine(d, w);
        addFineLine(-d, w);
      }
    });
    el.innerHTML = html;
  }

  /** 高度：千位及以上大数 + 后三位小字（固定三位） */
  function altSplitLast3Ft(altFt) {
    const a = Math.round(altFt);
    if (!Number.isFinite(a)) return { lg: "0", sm: "000" };
    const aa = Math.max(0, a);
    const hi = Math.floor(aa / 1000);
    const lo = aa % 1000;
    return { lg: String(hi), sm: ("00" + lo).slice(-3) };
  }

  /** 滚筒数字：部分手机 GPU/字体下会花屏，仅手机端关闭；平板与桌面保持滚筒 */
  function rollOdometerUseDrum() {
    var h = document.documentElement;
    if (!h.classList.contains("mobile-adapt")) return true;
    if (h.classList.contains("tablet-adapt")) return true;
    return false;
  }

  function rollOdMakeColumn() {
    const col = document.createElement("span");
    col.className = "roll-od-col";
    const strip = document.createElement("span");
    strip.className = "roll-od-strip";
    for (var d = 0; d <= 9; d++) {
      var s = document.createElement("span");
      s.className = "roll-od-ch";
      s.textContent = String(d);
      strip.appendChild(s);
    }
    col.appendChild(strip);
    col._strip = strip;
    return col;
  }

  function rollOdSetDigit(col, ch, instant) {
    var strip = col._strip;
    if (!strip) return;
    var code = ch.charCodeAt(0) - 48;
    if (code < 0 || code > 9) return;
    if (!instant && col._lastD === code) return;
    col._lastD = code;
    if (instant) {
      strip.classList.add("roll-od-strip--instant");
      strip.style.transform = "translateY(-" + code + "em)";
      void strip.offsetWidth;
      strip.classList.remove("roll-od-strip--instant");
    } else {
      strip.style.transform = "translateY(-" + code + "em)";
    }
  }

  /** 单行滚筒（ADI 高度等） */
  function rollOdSyncHostRow(host, digitStr, forceInstant) {
    var row = host.querySelector(":scope > .roll-od-row");
    if (!row) {
      host.textContent = "";
      row = document.createElement("span");
      row.className = "roll-od-row";
      host.appendChild(row);
    }
    var need = digitStr.length;
    var lenChg = row.children.length !== need;
    while (row.children.length < need) {
      row.appendChild(rollOdMakeColumn());
    }
    while (row.children.length > need) {
      row.removeChild(row.lastChild);
    }
    var instant = forceInstant || lenChg;
    for (var i = 0; i < need; i++) {
      rollOdSetDigit(row.children[i], digitStr.charAt(i), instant);
    }
  }

  /** 高度窗：大千位滚筒 + 后三位滚筒 */
  function updateAltBugRoller(bug, lgStr, smStr) {
    bug.className = "tape-window tape-window-alt";
    if (!rollOdometerUseDrum()) {
      bug.innerHTML =
        '<span class="tape-bug-lg">' +
        lgStr +
        '</span><span class="tape-bug-sm">' +
        smStr +
        "</span>";
      return;
    }
    var wrapLg = bug.querySelector(".tape-bug-roll-lg");
    var wrapSm = bug.querySelector(".tape-bug-roll-sm");
    var lgLen = lgStr.length;
    var needRebuild = !wrapLg || !wrapSm || wrapLg.children.length !== lgLen || wrapSm.children.length !== 3;
    if (needRebuild) {
      bug.textContent = "";
      wrapLg = document.createElement("span");
      wrapLg.className = "tape-bug-roll-lg tape-bug-roll-wrap";
      wrapSm = document.createElement("span");
      wrapSm.className = "tape-bug-roll-sm tape-bug-roll-wrap";
      var i;
      for (i = 0; i < lgLen; i++) {
        wrapLg.appendChild(rollOdMakeColumn());
      }
      for (i = 0; i < 3; i++) {
        wrapSm.appendChild(rollOdMakeColumn());
      }
      bug.appendChild(wrapLg);
      bug.appendChild(wrapSm);
      for (i = 0; i < lgLen; i++) {
        rollOdSetDigit(wrapLg.children[i], lgStr.charAt(i), true);
      }
      for (i = 0; i < 3; i++) {
        rollOdSetDigit(wrapSm.children[i], smStr.charAt(i), true);
      }
      return;
    }
    for (var j = 0; j < lgLen; j++) {
      rollOdSetDigit(wrapLg.children[j], lgStr.charAt(j), false);
    }
    for (j = 0; j < 3; j++) {
      rollOdSetDigit(wrapSm.children[j], smStr.charAt(j), false);
    }
  }

  function updateSpeedTape(ias) {
    const inner = document.getElementById("speedTapeInner");
    const bug = document.getElementById("speedBug");
    if (!inner || !bug) return;
    if (ias == null || !Number.isFinite(ias) || ias < 0) {
      inner.innerHTML = "";
      bug.className = "tape-window";
      bug.textContent = "—";
      return;
    }
    const topPad = 22, botPad = 4;
    const innerH = 218 - topPad - botPad;
    const cx = innerH / 2;
    const pxPerKt = 2.5 * (innerH / 160);
    let html = "";
    const center = Math.round(ias / 10) * 10;
    for (let v = center - 95; v <= center + 95; v += 5) {
      if (v < 0) continue;
      const y = cx + (ias - v) * pxPerKt;
      if (y < -10 || y > innerH + 10) continue;
      const major = v % 20 === 0;
      const mid = !major && v % 10 === 0;
      const cls = major ? " major" : mid ? " mid" : " minor";
      html += '<div class="tape-slide tape-slide-speed' + cls + '" style="top:' + y + 'px">';
      html += '<span class="tape-val-num">' + (major ? v : "") + "</span>";
      html += '<span class="tape-line"></span></div>';
    }
    inner.innerHTML = html;
    bug.className = "tape-window";
    if (rollOdometerUseDrum()) {
      rollOdSyncHostRow(bug, String(Math.round(ias)), false);
    } else {
      bug.textContent = String(Math.round(ias));
    }
  }

  function updateAltTape(altFt) {
    const inner = document.getElementById("altTapeInner");
    const bug = document.getElementById("altBug");
    if (!inner || !bug) return;
    if (altFt == null || !Number.isFinite(altFt)) {
      inner.innerHTML = "";
      bug.className = "tape-window tape-window-alt";
      bug.textContent = "—";
      return;
    }
    const topPad = 22, botPad = 4;
    const innerH = 218 - topPad - botPad;
    const cx = innerH / 2;
    /* 与空速带相同 px 密度：5kt 与 100ft 对应同一垂直位移 */
    const pxPerKt = 2.5 * (innerH / 160);
    const pxPer100ft = (5 * pxPerKt) / 100;
    let html = "";
    const center = Math.round(altFt / 100) * 100;
    for (let k = -19; k <= 19; k++) {
      const v = center + k * 100;
      if (v < 0) continue;
      const y = cx + (altFt - v) * pxPer100ft;
      if (y < -10 || y > innerH + 10) continue;
      const major = v % 500 === 0;
      const mid = !major && v % 200 === 0;
      const cls = major ? " major" : mid ? " mid" : " minor";
      html += '<div class="tape-slide tape-slide-alt' + cls + '" style="top:' + y + 'px">';
      html += '<span class="tape-val-num">';
      if (major) {
        const lp = altSplitLast3Ft(v);
        html +=
          '<span class="tape-alt-lg">' +
          lp.lg +
          '</span><span class="tape-alt-sm">' +
          lp.sm +
          "</span>";
      }
      html += "</span>";
      html += '<span class="tape-line"></span></div>';
    }
    inner.innerHTML = html;
    const bp = altSplitLast3Ft(altFt);
    updateAltBugRoller(bug, bp.lg, bp.sm);
  }

  function updateAttitude(pitch, bank) {
    const bEl = document.getElementById("attBank");
    const pEl = document.getElementById("attPitch");
    if (!bEl || !pEl) return;
    const p = pitch != null && Number.isFinite(pitch) ? pitch : 0;
    const b = bank != null && Number.isFinite(bank) ? bank : 0;
    /* 俯仰与 SimConnect 符号相反需取反平移；横滚左右与 CSS 约定一致用正值=顺时针坡度 */
    bEl.style.transform = "translateZ(0) rotate(" + b + "deg)";
    pEl.style.transform = "translateZ(0) translateY(" + -p * PITCH_PX_PER_DEG + "px)";
  }

  /** 地形/AGL：低空优先无线电，否则用模拟器几何 AGL（与游戏一致），再退回气压近似 */
  function pickAdiAglFt(radioFt, aglGameFt, aglBaroFt) {
    if (radioFt != null && Number.isFinite(radioFt) && radioFt >= 0 && radioFt < 5500) {
      return radioFt;
    }
    if (aglGameFt != null && Number.isFinite(aglGameFt)) {
      return aglGameFt;
    }
    return aglBaroFt;
  }

  function updateAdiHud(ias, altFt, vs, hdg, bank, groundElevFt, radioFt, aglBaroFt, aglGameFt) {
    const elI = document.getElementById("adiIas");
    const elA = document.getElementById("adiAlt");
    const elV = document.getElementById("adiVs");
    const elH = document.getElementById("adiHdg");
    const elG = document.getElementById("adiGelev");
    const elAg = document.getElementById("adiAgl");
    const elRs = document.getElementById("adiRadSub");
    const elB = document.getElementById("adiBank");
    /* 姿态仪角窗仅静态数字：滚筒纵列在部分设备上会叠成灰条，空速/高度带仍可用滚筒 */
    if (elI) elI.textContent = ias != null && Number.isFinite(ias) ? String(Math.round(ias)) : "—";
    if (elA) elA.textContent = altFt != null && Number.isFinite(altFt) ? String(Math.round(altFt)) : "—";
    if (elV) elV.textContent = vs != null && Number.isFinite(vs) ? String(Math.round(vs)) : "—";
    if (elH) elH.textContent = hdg != null && Number.isFinite(hdg) ? fmtNum(normHdg(hdg), 1) : "—";
    if (elG) elG.textContent = groundElevFt != null && Number.isFinite(groundElevFt) ? String(Math.round(groundElevFt)) : "—";
    const aglMain = pickAdiAglFt(radioFt, aglGameFt, aglBaroFt);
    if (elAg) elAg.textContent = aglMain != null && Number.isFinite(aglMain) ? String(Math.round(aglMain)) : "—";
    if (elRs) {
      const partsUi = [];
      if (radioFt != null && Number.isFinite(radioFt) && radioFt >= 0 && radioFt < 9000) {
        partsUi.push("RAD " + String(Math.round(radioFt)));
      }
      if (aglGameFt != null && Number.isFinite(aglGameFt)) {
        partsUi.push("SIM " + String(Math.round(aglGameFt)));
      }
      if (aglBaroFt != null && Number.isFinite(aglBaroFt)) {
        partsUi.push("baroΔ " + String(Math.round(aglBaroFt)));
      }
      elRs.textContent = partsUi.join(" · ");
    }
    if (elB) elB.textContent = bank != null && Number.isFinite(bank) ? fmtNum(bank, 0) + "°" : "—";
  }

  function adiTerrainRidgeNoise(t01, lat, lon, groundElevFt) {
    const g = groundElevFt != null && Number.isFinite(groundElevFt) ? groundElevFt : 0;
    const rough = 0.52 + Math.min(2.15, Math.max(0, g) / 4200);
    const la = lat != null && Number.isFinite(lat) ? lat : 0;
    const lo = lon != null && Number.isFinite(lon) ? lon : 0;
    const gPhase = g * 2.1e-5;
    const n1 = Math.sin(t01 * Math.PI * 5.1 + la * 0.14 + lo * 0.11 + gPhase) * 10 * rough;
    const n2 = Math.cos(t01 * Math.PI * 8.4 - lo * 0.09 + la * 0.07 - gPhase * 0.5) * 8 * rough;
    const n3 = Math.sin(t01 * 38 + la + lo * 0.4) * 5.5 * rough;
    const n4 = Math.cos(t01 * 17.3 + g * 0.0012) * 3.5 * Math.min(1, rough);
    return n1 + n2 + n3 + n4;
  }

  function buildAdiTerrainPath(groundElevFt, lat, lon) {
    const W = ADI_VB_W, yBot = ADI_VB_H, hz = ADI_HZ;
    const segs = 28;
    const ridge = hz + 82;
    let dFill = "M0," + yBot + " L0," + ridge.toFixed(1);
    let dStroke = "M0," + ridge.toFixed(1);
    for (let i = 1; i <= segs; i++) {
      const t01 = i / segs;
      const x = t01 * W;
      const dy = adiTerrainRidgeNoise(t01, lat, lon, groundElevFt);
      const y = ridge + dy;
      const xs = x.toFixed(1);
      const ys = Math.max(255, Math.min(595, y)).toFixed(1);
      dFill += " L" + xs + "," + ys;
      dStroke += " L" + xs + "," + ys;
    }
    dFill += " L" + W + "," + yBot + " Z";
    return { dFill: dFill, dStroke: dStroke };
  }

  function updateAdiTerrain(radioFt, aglBaroFt, aglGameFt, altMsl, groundElevFt, lat, lon) {
    const el = document.getElementById("attTerrain");
    const pFill = document.getElementById("attTerrainFill");
    const pStr = document.getElementById("attTerrainStroke");
    if (!el || !pFill || !pStr) return;
    const o = buildAdiTerrainPath(groundElevFt, lat, lon);
    pFill.setAttribute("d", o.dFill);
    pStr.setAttribute("d", o.dStroke);
  }

  const NED_R_FT = 20902231;
  function _svgTxtSafe(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function nedFeetFromWgs84(plat, plon, pAltFt, tlat, tlon, tAltFt) {
    const r = NED_R_FT, d2r = Math.PI / 180;
    const clat = Math.cos(plat * d2r);
    const n = (tlat - plat) * d2r * r;
    const e = (tlon - plon) * d2r * r * clat;
    const d = pAltFt - tAltFt;
    return { n: n, e: e, d: d };
  }
  function nedToBodyFrd(n, e, d, hDeg, pDeg, rDeg) {
    const H = hDeg * Math.PI / 180, P = pDeg * Math.PI / 180, R = rDeg * Math.PI / 180;
    const cH = Math.cos(H), sH = Math.sin(H), cP = Math.cos(P), sP = Math.sin(P), cR = Math.cos(R), sR = Math.sin(R);
    let x = n * cH + e * sH;
    let y = -n * sH + e * cH;
    let z = d;
    const x2 = x * cP - z * sP, y2 = y, z2 = x * sP + z * cP;
    return { x: x2, y: y2 * cR + z2 * sR, z: -y2 * sR + z2 * cR };
  }
  function runwayProjectPt(ned, hdgDeg, pitchDeg, bankDeg, projK) {
    const b = nedToBodyFrd(ned.n, ned.e, ned.d, hdgDeg, pitchDeg, bankDeg);
    const horiz = Math.sqrt(b.x * b.x + b.y * b.y);
    if (horiz < 0.2 || b.x <= 0) return null;
    const az = Math.atan2(b.y, b.x);
    const el = Math.atan2(b.z, horiz);
    return {
      x: ADI_VB_W / 2 + projK * Math.tan(az),
      y: ADI_HZ + projK * Math.tan(el)
    };
  }
  function runwayBearingDeg(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
    const ey = Math.sin(dl) * Math.cos(p2);
    const ex = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(ey, ex) * 180 / Math.PI + 360) % 360;
  }
  function runwayOffsetLL(lat, lon, brgDeg, distM) {
    const R = 6371000, th = brgDeg * Math.PI / 180;
    const dlat = (distM * Math.cos(th)) / R * (180 / Math.PI);
    const dlon = (distM * Math.sin(th)) / (R * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);
    return { lat: lat + dlat, lon: lon + dlon };
  }
  /** 单条跑道 SVG 片段；primary=false 时略淡，便于多条叠绘 */
  function buildAdiOneRunwaySvgFragment(rw, plat, plon, altUse, hdg, p, r, projK, groundElevFt, primary) {
    const elv = rw.elev_ft != null && Number.isFinite(rw.elev_ft) ? rw.elev_ft : (groundElevFt || 0);
    const halfW = (rw.width_m != null && Number.isFinite(rw.width_m) ? rw.width_m : 45) / 2;
    const brgTrk = runwayBearingDeg(rw.lat_thr, rw.lon_thr, rw.lat_end, rw.lon_end);
    const leftBrg = brgTrk - 90;
    const tL = runwayOffsetLL(rw.lat_thr, rw.lon_thr, leftBrg, halfW);
    const tR = runwayOffsetLL(rw.lat_thr, rw.lon_thr, leftBrg + 180, halfW);
    const fL = runwayOffsetLL(rw.lat_end, rw.lon_end, leftBrg, halfW);
    const fR = runwayOffsetLL(rw.lat_end, rw.lon_end, leftBrg + 180, halfW);
    function projLL(lat, lon) {
      const ned = nedFeetFromWgs84(plat, plon, altUse, lat, lon, elv);
      return runwayProjectPt(ned, hdg, p, r, projK);
    }
    const corners = [tL, tR, fR, fL].map(function (ll) {
      return projLL(ll.lat, ll.lon);
    });
    if (corners.some(function (c) { return c == null; })) return "";
    var maxy = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
    if (maxy < ADI_HZ - 25) return "";
    const dim = primary ? 1 : 0.55;
    const poly =
      "M" +
      corners[0].x.toFixed(1) +
      "," +
      corners[0].y.toFixed(1) +
      " L" +
      corners[1].x.toFixed(1) +
      "," +
      corners[1].y.toFixed(1) +
      " L" +
      corners[2].x.toFixed(1) +
      "," +
      corners[2].y.toFixed(1) +
      " L" +
      corners[3].x.toFixed(1) +
      "," +
      corners[3].y.toFixed(1) +
      " Z";
    let dPath = "";
    const nSeg = 12;
    for (let i = 0; i <= nSeg; i++) {
      const t = i / nSeg;
      const lat = rw.lat_thr + (rw.lat_end - rw.lat_thr) * t;
      const lon = rw.lon_thr + (rw.lon_end - rw.lon_thr) * t;
      const pt = projLL(lat, lon);
      if (!pt || pt.x < -70 || pt.x > ADI_VB_W + 70 || pt.y < -30 || pt.y > ADI_VB_H + 40) continue;
      dPath += (dPath ? " L" : "M") + pt.x.toFixed(1) + "," + pt.y.toFixed(1);
    }
    let lights = "";
    const dotOp = (primary ? 0.82 : 0.45) * dim + 0.18;
    function edgeDots(a, b) {
      const step = primary ? 0.11 : 0.14;
      for (let t = 0.12; t <= 0.88; t += step) {
        const lat = a.lat + (b.lat - a.lat) * t;
        const lon = a.lon + (b.lon - a.lon) * t;
        const pt = projLL(lat, lon);
        if (pt && pt.x >= -40 && pt.x <= ADI_VB_W + 40 && pt.y >= ADI_HZ - 30 && pt.y <= ADI_VB_H + 20) {
          lights +=
            '<circle cx="' +
            pt.x.toFixed(1) +
            '" cy="' +
            pt.y.toFixed(1) +
            '" r="1.2" fill="rgba(255,255,255,' +
            dotOp.toFixed(2) +
            ')"/>';
        }
      }
    }
    edgeDots(tL, fL);
    edgeDots(tR, fR);
    const thrC = projLL(rw.lat_thr, rw.lon_thr);
    const fillA = (0.08 * dim).toFixed(3);
    const strA = (0.72 * dim).toFixed(3);
    const dashA = (0.74 * dim).toFixed(3);
    const sw = primary ? 1.15 : 0.95;
    let html =
      '<path fill="rgba(65,210,130,' + (parseFloat(fillA) * 0.85).toFixed(3) + ')" stroke="none" d="' + poly + '"/>' +
      '<path fill="none" stroke="rgba(110,255,175,' + strA + ')" stroke-width="' +
      sw +
      '" d="' +
      poly +
      '"/>';
    if (dPath.length > 8) {
      html +=
        '<path fill="none" stroke="rgba(238,255,248,' +
        dashA +
        ')" stroke-width="' +
        (primary ? 0.85 : 0.72) +
        '" stroke-dasharray="8 6" d="' +
        dPath +
        '"/>';
    }
    html += lights;
    if (thrC && (rw.rw || rw.icao)) {
      var idStr = (rw.icao && rw.rw) ? rw.icao + " " + rw.rw : (rw.rw || rw.icao || "");
      html +=
        '<text text-anchor="middle" fill="rgba(215,255,235,' +
        (0.85 * dim + 0.11).toFixed(2) +
        ')" font-size="' +
        (primary ? 12 : 10) +
        '" font-weight="700" font-family="ui-monospace,\'Consolas\',monospace" x="' +
        thrC.x.toFixed(1) +
        '" y="' +
        (thrC.y - 8).toFixed(1) +
        '">' +
        _svgTxtSafe(idStr) +
        "</text>";
    }
    if (thrC && rw.dist_nm != null && Number.isFinite(rw.dist_nm)) {
      html +=
        '<text text-anchor="middle" fill="rgba(175,245,215,' +
        (0.78 * dim + 0.12).toFixed(2) +
        ')" font-size="' +
        (primary ? 9 : 8) +
        '" font-family="ui-monospace,\'Consolas\',monospace" x="' +
        thrC.x.toFixed(1) +
        '" y="' +
        (thrC.y + 58).toFixed(1) +
        '">' +
        _svgTxtSafe(String(rw.dist_nm) + " NM") +
        "</text>";
    }
    return html;
  }
  /**
   * platSm/plonSm：与姿态/高度带一致的插值经纬度；与 rAF 同步，避免跑道相对天地线 60Hz 抖跳。
   */
  function updateAdiRunwayOverlay(tele, pitchDeg, bankDeg, altFt, hdgDeg, platSm, plonSm) {
    const g = document.getElementById("adiRunwayOverlay");
    if (!g) return;
    const altUse =
      altFt != null && Number.isFinite(altFt)
        ? altFt
        : tele && tele.alt_ft != null && Number.isFinite(tele.alt_ft)
          ? tele.alt_ft
          : null;
    const list =
      tele && tele.ok && Array.isArray(tele.runways) && tele.runways.length
        ? tele.runways
        : tele && tele.ok && tele.runway
          ? [tele.runway]
          : [];
    if (!tele || !tele.ok || altUse == null || !Number.isFinite(altUse) || !list.length) {
      g.innerHTML = "";
      return;
    }
    let plat =
      platSm != null && Number.isFinite(platSm) ? platSm : tele.lat;
    let plon =
      plonSm != null && Number.isFinite(plonSm) ? plonSm : tele.lon;
    if (plat == null || plon == null || !Number.isFinite(plat) || !Number.isFinite(plon)) {
      g.innerHTML = "";
      return;
    }
    const hdg =
      hdgDeg != null && Number.isFinite(hdgDeg)
        ? hdgDeg
        : tele.heading_deg != null && Number.isFinite(tele.heading_deg)
          ? tele.heading_deg
          : 0;
    const p = pitchDeg != null && Number.isFinite(pitchDeg) ? pitchDeg : 0;
    const r = bankDeg != null && Number.isFinite(bankDeg) ? bankDeg : 0;
    const projK = PITCH_PX_PER_DEG * (180 / Math.PI);
    const ge = tele.ground_elev_ft;
    const ordered = list
      .map(function (rw, i) {
        return { rw: rw, primary: i === 0 };
      })
      .sort(function (a, b) {
        return (b.rw.dist_m || 0) - (a.rw.dist_m || 0);
      });
    let html = "";
    for (let i = 0; i < ordered.length; i++) {
      html += buildAdiOneRunwaySvgFragment(
        ordered[i].rw,
        plat,
        plon,
        altUse,
        hdg,
        p,
        r,
        projK,
        ge,
        ordered[i].primary
      );
    }
    g.innerHTML = html;
  }

  function updatePfdInstruments(data) {
    const h = document.getElementById("pfdHdg");
    const v = document.getElementById("pfdVs");
    const gsEl = document.getElementById("pfdGs");
    if (!data || !data.ok) {
      updateSpeedTape(null);
      updateAltTape(null);
      updateAttitude(0, 0);
      updateAdiHud(null, null, null, null, null, null, null, null, null);
      updateAdiTerrain(null, null, null, null, null, null, null);
      updateAdiRunwayOverlay(null, 0, 0, null, null);
      redrawAdiVnavProfile();
      if (h) h.textContent = "—";
      if (v) v.textContent = "—";
      if (gsEl) gsEl.textContent = "—";
      return;
    }
    updateSpeedTape(data.ias_knots);
    updateAltTape(data.alt_ft);
    updateAttitude(data.pitch_deg, data.bank_deg);
    updateAdiHud(
      data.ias_knots,
      data.alt_ft,
      data.vertical_speed_fpm,
      data.heading_deg,
      data.bank_deg,
      data.ground_elev_ft,
      data.radio_height_ft,
      data.agl_baro_ft,
      data.agl_game_ft
    );
    updateAdiTerrain(
      data.radio_height_ft,
      data.agl_baro_ft,
      data.agl_game_ft,
      data.alt_ft,
      data.ground_elev_ft,
      data.lat,
      data.lon
    );
    if (h) h.textContent = fmtNum(data.heading_deg, 1);
    if (v) {
      const vs = data.vertical_speed_fpm;
      v.textContent = vs != null && Number.isFinite(vs) ? String(Math.round(vs)) : "—";
    }
    if (gsEl) gsEl.textContent = fmtNum(data.groundspeed_knots, 0);
  }

  function fmtNum(n, d) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toFixed(d);
  }

  /** SimConnect：气象风来向（真向）+ 节；无数据返回 null */
  function formatWindDisplay(t) {
    if (!t || !t.ok) return null;
    var d = t.wind_direction_deg;
    var s = t.wind_speed_knots;
    if (d == null || !Number.isFinite(d) || s == null || !Number.isFinite(s)) return null;
    var dd = Math.round(normHdg(d));
    var ds = dd < 10 ? "00" + dd : dd < 100 ? "0" + dd : String(dd);
    return ds + "° / " + Math.round(s);
  }

  function tasKnotsFromTelemetry(t) {
    if (!t || !t.ok) return null;
    if (t.tas_knots != null && Number.isFinite(t.tas_knots) && t.tas_knots > 0)
      return Math.round(t.tas_knots);
    if (t.ias_knots != null && Number.isFinite(t.ias_knots)) return Math.round(t.ias_knots);
    return null;
  }

  function setStatus(ok, title, detail) {
    statusEl.innerHTML = ok
      ? title
      : '<span class="err">' + title + "</span>";
    detailEl.textContent = detail || "";
  }

  /** 相邻点经度差压到 ≤180°，跨 ±180° 时 Leaflet 才会画连续线而非横穿整图 */
  function unwrapLatLngsForPolyline(latlngs) {
    if (!latlngs || latlngs.length < 2) return latlngs;
    const out = [[latlngs[0][0], latlngs[0][1]]];
    let prevLon = latlngs[0][1];
    for (let i = 1; i < latlngs.length; i++) {
      const lat = latlngs[i][0];
      let lonAdj = latlngs[i][1];
      while (lonAdj - prevLon > 180) lonAdj -= 360;
      while (prevLon - lonAdj > 180) lonAdj += 360;
      out.push([lat, lonAdj]);
      prevLon = lonAdj;
    }
    return out;
  }

  /** 整条折线平移 k·360°，使末端与 ref 经度落在同一显示窗口（配 noWrap + 机标 wrapLng） */
  function shiftLngStripToRef(latlngs, refLon) {
    if (!latlngs || !latlngs.length || refLon == null || !Number.isFinite(refLon)) return latlngs;
    const r = wrapLng180(refLon);
    const lastL = latlngs[latlngs.length - 1][1];
    const k = Math.round((r - lastL) / 360);
    if (k === 0) return latlngs;
    return latlngs.map(function (p) { return [p[0], p[1] + k * 360]; });
  }

  function updateTrail(latlngs) {
    if (!latlngs || latlngs.length === 0) {
      if (trailLayer) {
        map.removeLayer(trailLayer);
        trailLayer = null;
      }
      return;
    }
    let pts = latlngs;
    if (pts.length === 1 && pts[0] && pts[0].length >= 2) {
      const a = pts[0][0],
        b = pts[0][1];
      pts = [[a, b], [a + 1e-5, b]];
    }
    if (pts.length < 2) return;
    if (trailLayer) map.removeLayer(trailLayer);
    let fixed = unwrapLatLngsForPolyline(pts);
    if (lastTelemetry && lastTelemetry.ok) {
      fixed = shiftLngStripToRef(fixed, lastTelemetry.lon);
    }
    trailLayer = L.polyline(fixed, { color: "#3fb950", weight: 3, opacity: 0.85 }).addTo(map);
  }

  function haversineNm(lat1, lon1, lat2, lon2) {
    const r = 3440.065; // 地球半径海里近似
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dq = p2 - p1;
    let dlDeg = lon2 - lon1;
    while (dlDeg > 180) dlDeg -= 360;
    while (dlDeg < -180) dlDeg += 360;
    const dl = dlDeg * Math.PI / 180;
    const a = Math.sin(dq / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** ND ARC：10/20/30 NM 三环 + 外缘与刻度内侧一档，四段等距（各 10 NM 在像素上等宽） */
  const ND_RING_MAX_NM = 30;
  /** 主刻度自外弧向内延伸（与 drawNd 中 rTickOuter−tickIn 一致） */
  const ND_COMPASS_TICK_INWARD_PX = 12;
  /** 10+10+10+10：三环间距 + 30 与刻度内缘间距 与前三档一致 */
  const ND_RING_SPAN_NM = 40;
  /** 航点/航线裁剪（NM），略大于外弧对应距离 */
  const ND_RANGE_NM = 48;
  /* 高度与 .tape / .att-wrap 内可视区一致：218px 外框 − 上下各 1px 边框 */
  const ndCssW = 236, ndCssH = 218;
  let ndDpr = 1;
  /** true：PLAN 模式（真北向上、地图缩放到前方航线） */
  let ndPlanMode = false;
  /** PLAN 地图缩放系数（>1 更「放大」航线） */
  let ndPlanZoom = 1;
  const ND_PLAN_ZOOM_MIN = 0.55;
  const ND_PLAN_ZOOM_MAX = 3.2;
  const ND_PLAN_ZOOM_STEP = 1.18;

  function syncNdPlanChrome() {
    const bar = document.getElementById("ndPlanZoomBar");
    const lbl = document.getElementById("ndPlanZoomLbl");
    if (!bar || !lbl) return;
    const show = ndPlanMode && planWaypoints.length >= 1;
    bar.hidden = !show;
    lbl.textContent = "×" + ndPlanZoom.toFixed(ndPlanZoom >= 10 ? 0 : 1);
  }
  const adiVnavCssW = 248, adiVnavCssH = 56;
  let adiVnavDpr = 1;

  function parseAltitudeFeet(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().replace(/,/g, "");
    if (!s) return null;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  }

  function getWaypointAltFt(el) {
    const tags = ["Altitude", "WorldAltitude", "AltitudeRestriction", "ATCAirspaceAltitude"];
    for (let ti = 0; ti < tags.length; ti++) {
      const txt = getTextEl(el, tags[ti]);
      const ft = parseAltitudeFeet(txt);
      if (ft != null) return ft;
    }
    return null;
  }

  function planCumulativeNm(wps) {
    const c = [0];
    for (let i = 1; i < wps.length; i++) {
      c.push(c[i - 1] + haversineNm(wps[i - 1].lat, wps[i - 1].lon, wps[i].lat, wps[i].lon));
    }
    return c;
  }

  function closestOnSegmentLatLon(lat0, lon0, lat1, lon1, plat, plon) {
    const cosM = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
    const x1 = (lon1 - lon0) * 60 * cosM;
    const y1 = (lat1 - lat0) * 60;
    const xp = (plon - lon0) * 60 * cosM;
    const yp = (plat - lat0) * 60;
    const dx = x1;
    const dy = y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-10 ? (xp * dx + yp * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return {
      t: t,
      lat: lat0 + (lat1 - lat0) * t,
      lon: lon0 + (lon1 - lon0) * t
    };
  }

  function closestAlongTrackNm(plat, plon, wps) {
    const cum = planCumulativeNm(wps);
    let bestAlong = 0;
    let bestCross = Infinity;
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i];
      const b = wps[i + 1];
      const proj = closestOnSegmentLatLon(a.lat, a.lon, b.lat, b.lon, plat, plon);
      const dPt = haversineNm(plat, plon, proj.lat, proj.lon);
      if (dPt < bestCross) {
        bestCross = dPt;
        const segLen = haversineNm(a.lat, a.lon, b.lat, b.lon);
        bestAlong = cum[i] + proj.t * segLen;
      }
    }
    return { alongNm: bestAlong, crossTrackNm: bestCross };
  }

  function latLonAtAlongNm(wps, alongNm) {
    const cum = planCumulativeNm(wps);
    if (alongNm <= cum[0]) return { lat: wps[0].lat, lon: wps[0].lon };
    for (let i = 0; i < wps.length - 1; i++) {
      if (alongNm <= cum[i + 1] + 1e-9) {
        const seg = cum[i + 1] - cum[i];
        const t = seg > 1e-9 ? (alongNm - cum[i]) / seg : 0;
        return {
          lat: wps[i].lat + (wps[i + 1].lat - wps[i].lat) * t,
          lon: wps[i].lon + (wps[i + 1].lon - wps[i].lon) * t
        };
      }
    }
    const last = wps[wps.length - 1];
    return { lat: last.lat, lon: last.lon };
  }

  function altAtAlongNm(wps, altsFt, alongNm) {
    const cum = planCumulativeNm(wps);
    const n = wps.length;
    if (alongNm <= cum[0]) return altsFt[0];
    for (let i = 0; i < n - 1; i++) {
      if (alongNm <= cum[i + 1] + 1e-9) {
        const seg = cum[i + 1] - cum[i];
        const t = seg > 1e-9 ? (alongNm - cum[i]) / seg : 0;
        return altsFt[i] + (altsFt[i + 1] - altsFt[i]) * t;
      }
    }
    return altsFt[n - 1];
  }

  function resolvePlanAltitudesFeet(wps, acAltFt) {
    const n = wps.length;
    const known = wps.map(function (w) {
      return w.altFt != null && Number.isFinite(w.altFt) ? w.altFt : null;
    });
    if (!known.some(function (x) { return x != null; })) {
      const b = acAltFt != null && Number.isFinite(acAltFt) ? acAltFt : 8000;
      return new Array(n).fill(b);
    }
    const out = known.slice();
    for (let i = 0; i < n; i++) {
      if (out[i] != null) continue;
      let prev = null;
      let prevI = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (out[j] != null) {
          prev = out[j];
          prevI = j;
          break;
        }
      }
      let next = null;
      let nextI = n;
      for (let j = i + 1; j < n; j++) {
        if (out[j] != null) {
          next = out[j];
          nextI = j;
          break;
        }
      }
      if (prev != null && next != null)
        out[i] = prev + (next - prev) * (i - prevI) / (nextI - prevI);
      else if (prev != null) out[i] = prev;
      else if (next != null) out[i] = next;
      else out[i] = acAltFt != null && Number.isFinite(acAltFt) ? acAltFt : 5000;
    }
    return out;
  }

  function sizeAdiVnavCanvas() {
    const c = document.getElementById("adiVnavCanvas");
    if (!c) return;
    adiVnavDpr = Math.min(2, window.devicePixelRatio || 1);
    const strip = document.getElementById("attVnavStrip");
    let wPx = strip && strip.clientWidth >= 40 ? strip.clientWidth : 0;
    if (wPx < 40) {
      const body = document.getElementById("pfdPanelBody");
      if (body && body.clientWidth) wPx = Math.max(adiVnavCssW, body.clientWidth - 24);
      else wPx = adiVnavCssW;
    }
    c.width = Math.round(wPx * adiVnavDpr);
    c.height = Math.round(adiVnavCssH * adiVnavDpr);
    c.style.height = adiVnavCssH + "px";
    c.style.width = "100%";
  }

  function resizeAdiVnav() {
    sizeAdiVnavCanvas();
    redrawAdiVnavProfile();
  }

  function redrawAdiVnavProfile() {
    const c = document.getElementById("adiVnavCanvas");
    const strip = document.getElementById("attVnavStrip");
    const outer = document.getElementById("pfdVnavOuter");
    if (!c || !strip) return;
    const ctx = c.getContext("2d");
    let w = c.width / adiVnavDpr;
    let h = c.height / adiVnavDpr;
    ctx.setTransform(adiVnavDpr, 0, 0, adiVnavDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (
      !planWaypoints ||
      planWaypoints.length < 2 ||
      !lastTelemetry ||
      !lastTelemetry.ok
    ) {
      if (outer) outer.hidden = true;
      strip.setAttribute("aria-hidden", "true");
      return;
    }
    if (outer) outer.hidden = false;
    strip.setAttribute("aria-hidden", "false");
    sizeAdiVnavCanvas();
    w = c.width / adiVnavDpr;
    h = c.height / adiVnavDpr;
    ctx.setTransform(adiVnavDpr, 0, 0, adiVnavDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const useSm = smoothReady;
    const acLat = useSm ? dispLat : lastTelemetry.lat;
    const acLon = useSm ? dispLon : lastTelemetry.lon;
    const acAlt =
      useSm && dispAlt != null && Number.isFinite(dispAlt)
        ? dispAlt
        : lastTelemetry.alt_ft;

    const wps = planWaypoints;
    const altsPlan = resolvePlanAltitudesFeet(wps, acAlt);
    const track = closestAlongTrackNm(acLat, acLon, wps);
    const alongAc = track.alongNm;
    const cum = planCumulativeNm(wps);
    const total = cum[cum.length - 1];
    const dBack = 6;
    const dFwd = Math.min(40, Math.max(12, total - alongAc + 2));
    let dMin = Math.max(0, alongAc - dBack);
    let dMax = Math.min(total, alongAc + dFwd);
    if (dMax - dMin < 4) {
      dMin = Math.max(0, alongAc - 8);
      dMax = Math.min(total, alongAc + 8);
    }
    const span = dMax - dMin || 1;

    let aMin = acAlt != null && Number.isFinite(acAlt) ? acAlt : altsPlan[0];
    let aMax = aMin;
    const step = Math.max(0.35, span / 90);
    for (let d = dMin; d <= dMax + 1e-6; d += step) {
      const a = altAtAlongNm(wps, altsPlan, d);
      if (a < aMin) aMin = a;
      if (a > aMax) aMax = a;
    }
    if (acAlt != null && Number.isFinite(acAlt)) {
      aMin = Math.min(aMin, acAlt);
      aMax = Math.max(aMax, acAlt);
    }
    const padA = Math.max(400, (aMax - aMin) * 0.12);
    aMin -= padA;
    aMax += padA;
    if (aMax - aMin < 800) {
      const mid = (aMin + aMax) / 2;
      aMin = mid - 400;
      aMax = mid + 400;
    }

    const padL = 4;
    const padR = 4;
    const padT = 12;
    const padB = 5;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    function xForDist(d) {
      return padL + ((d - dMin) / span) * plotW;
    }
    function yForAlt(altFt, persp) {
      const p = persp != null && Number.isFinite(persp) ? persp : 1;
      const t = (altFt - aMin) / (aMax - aMin);
      return padT + (1 - t) * plotH * p;
    }

    const samples = [];
    for (let d = dMin; d <= dMax + 1e-6; d += step) {
      const rel = d - alongAc;
      const persp = 1 / (1 + Math.max(0, rel + 2) * 0.028);
      const altP = altAtAlongNm(wps, altsPlan, d);
      samples.push({
        d: d,
        alt: altP,
        x: xForDist(d),
        y: yForAlt(altP, persp),
        persp: persp
      });
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(samples[0].x, h - padB + 1);
    for (let si = 0; si < samples.length; si++) {
      ctx.lineTo(samples[si].x, samples[si].y);
    }
    ctx.lineTo(samples[samples.length - 1].x, h - padB + 1);
    ctx.closePath();
    const grd = ctx.createLinearGradient(0, padT, 0, h);
    grd.addColorStop(0, "rgba(100, 240, 170, 0.22)");
    grd.addColorStop(1, "rgba(40, 120, 90, 0.04)");
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "rgba(140, 255, 195, 0.88)";
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    for (let si = 0; si < samples.length; si++) {
      const s = samples[si];
      if (si === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();

    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1.2;
    ctx.translate(2.2, 1.6);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    for (let si = 0; si < samples.length; si++) {
      const s = samples[si];
      if (si === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    ctx.restore();

    const acPersp = 1 / (1 + 2 * 0.028);
    const xAc = xForDist(alongAc);
    const yAc = yForAlt(acAlt != null && Number.isFinite(acAlt) ? acAlt : altAtAlongNm(wps, altsPlan, alongAc), acPersp);

    ctx.strokeStyle = "rgba(255, 230, 120, 0.9)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xAc, padT - 1);
    ctx.lineTo(xAc, h - padB + 1);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#ffba44";
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(xAc, yAc - 6);
    ctx.lineTo(xAc + 6.5, yAc + 5);
    ctx.lineTo(xAc - 6.5, yAc + 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(195, 220, 235, 0.82)";
    ctx.font = "600 8px ui-monospace, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.fillText("VNAV 剖面", padL + 1, 9);
    const altTxt =
      acAlt != null && Number.isFinite(acAlt)
        ? Math.round(acAlt)
        : "—";
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(160, 255, 195, 0.85)";
    ctx.fillText(altTxt + " ft", w - padR - 1, 9);

    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(140, 160, 180, 0.75)";
    ctx.font = "7px Segoe UI, sans-serif";
    const nmA = Math.max(0, total - alongAc);
    ctx.fillText("前方 " + nmA.toFixed(0) + " NM", padL + 1, h - 2);

    for (let wi = 0; wi < wps.length; wi++) {
      const dWp = cum[wi];
      if (dWp < dMin - 0.5 || dWp > dMax + 0.5) continue;
      const perspW = 1 / (1 + Math.max(0, dWp - alongAc + 2) * 0.028);
      const xx = xForDist(dWp);
      const ya = yForAlt(altsPlan[wi], perspW);
      ctx.fillStyle = "rgba(255, 180, 90, 0.95)";
      ctx.beginPath();
      ctx.arc(xx, ya, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function normHdg(h) {
    if (h == null || !Number.isFinite(h)) return 0;
    return ((h % 360) + 360) % 360;
  }

  /**
   * 自动统一真/磁航向与磁差：有 MAGVAR 时强制 真航向 = 磁航向 + 磁差（东偏为正）；
   * 无 MAGVAR 时用 真航向−磁航向 反推磁差并写回，消除 SimConnect 三源不同步的余差（与桥接一致，旧包也可自修）。
   */
  function normalizeTelemetryHeadingMag(data) {
    if (!data || !data.ok) return data;
    const mh = data.heading_deg;
    const mvIn = data.mag_var_deg;
    const thIn = data.heading_true_deg;
    if (mh == null || !Number.isFinite(mh)) return data;
    if (mvIn != null && Number.isFinite(mvIn)) {
      data.heading_true_deg = normHdg(mh + mvIn);
      return data;
    }
    if (thIn != null && Number.isFinite(thIn)) {
      let d = normHdg(thIn) - normHdg(mh);
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      data.mag_var_deg = d;
      data.heading_true_deg = normHdg(mh + d);
    }
    return data;
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    let dlDeg = lon2 - lon1;
    while (dlDeg > 180) dlDeg -= 360;
    while (dlDeg < -180) dlDeg += 360;
    const dl = dlDeg * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return normHdg(Math.atan2(y, x) * 180 / Math.PI);
  }

  /**
   * 扁航/局部 ENU 平面上的航线角（度），与 ND 上「直线连接航点」的视觉走向一致；
   * 共线航点相邻两段读数相同。指针类仍用 bearingDeg（大圆）。
   */
  function enuBearingDeg(lat1, lon1, lat2, lon2) {
    const north = (lat2 - lat1) * 60;
    let dLon = lon2 - lon1;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    const clat = ((lat1 + lat2) / 2) * Math.PI / 180;
    const east = dLon * 60 * Math.cos(clat);
    return normHdg(Math.atan2(east, north) * 180 / Math.PI);
  }

  /** 真航线角 → 磁航线角（与 MSFS MAGVAR 一致：东偏为正，磁向 = 真向 − 磁差）。无磁差时返回原值。 */
  function courseTrueToMagDeg(courseTrue, magVarDeg) {
    if (courseTrue == null || !Number.isFinite(courseTrue)) return null;
    if (magVarDeg == null || !Number.isFinite(magVarDeg)) return courseTrue;
    return normHdg(courseTrue - magVarDeg);
  }

  /**
   * ND 航线磁差：优先桥接下发的 MAGVAR（与磁/真航向在服务端已按「真=磁+差」对齐）。
   * 仅当无 MAGVAR 时，用 真−磁航向 反推（兼容旧包）；勿与 MAGVAR 混用以免重复校正。
   */
  function ndCourseMagVarDegFromTelemetry() {
    const t = lastTelemetry;
    if (!t || !t.ok) return null;
    if (t.mag_var_deg != null && Number.isFinite(t.mag_var_deg)) return t.mag_var_deg;
    if (
      t.heading_true_deg != null &&
      Number.isFinite(t.heading_true_deg) &&
      t.heading_deg != null &&
      Number.isFinite(t.heading_deg)
    ) {
      let d = normHdg(t.heading_true_deg) - normHdg(t.heading_deg);
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    }
    return null;
  }

  /**
   * 当前航段航线角：首段为本机 → 目标航点；后续段为上一航点 → 当前航点（ENU，与航路段一致）。
   */
  function nextLegCourseDeg(plat, plon) {
    if (!planWaypoints.length || nextWpSeq >= planWaypoints.length) return null;
    const next = planWaypoints[nextWpSeq];
    if (nextWpSeq === 0) {
      return enuBearingDeg(plat, plon, next.lat, next.lon);
    }
    const prev = planWaypoints[nextWpSeq - 1];
    return enuBearingDeg(prev.lat, prev.lon, next.lat, next.lon);
  }

  /**
   * 下一航段：当前目标航点 → 再下一航点（ENU，与航路段一致）。
   */
  function nextLegOutboundFromNextWpDeg() {
    if (!planWaypoints.length || nextWpSeq + 1 >= planWaypoints.length) return null;
    const cur = planWaypoints[nextWpSeq];
    const nxt = planWaypoints[nextWpSeq + 1];
    return enuBearingDeg(cur.lat, cur.lon, nxt.lat, nxt.lon);
  }

  /** ND 顶栏 NXT 行：标明下一航段终点航点名 + 磁航向（当前目标航点 → 其下一航点） */
  function formatNdNxtLegLabel() {
    if (!planWaypoints.length || nextWpSeq + 1 >= planWaypoints.length) return "NXT —°";
    const wpn = planWaypoints[nextWpSeq + 1];
    const d = courseTrueToMagDeg(nextLegOutboundFromNextWpDeg(), ndCourseMagVarDegFromTelemetry());
    const nm = String(wpn.name || "WPT").slice(0, 6);
    if (d == null) return "NXT→" + nm + " —°";
    return "NXT→" + nm + " " + String(Math.round(d)).padStart(3, "0") + "°";
  }

  function projectNm(acLat, acLon, hdgDeg, pLat, pLon) {
    const north = (pLat - acLat) * 60;
    let dLon = pLon - acLon;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    const east = dLon * 60 * Math.cos(acLat * Math.PI / 180);
    const r = normHdg(hdgDeg) * Math.PI / 180;
    const fwd = north * Math.cos(r) + east * Math.sin(r);
    const cross = east * Math.cos(r) - north * Math.sin(r);
    return { fwd: fwd, cross: cross };
  }

  /** ND 机标：实心白三角（空客/现代 ND 风格） */
  function drawNdAircraftSymbol(ctx, cx, cy) {
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx + 7, cy + 6.5);
    ctx.lineTo(cx - 7, cy + 6.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** ND 右上角：下一航点 ETA（Zulu，HHMMz） */
  function formatNdEtaZuluFromNm(dnm, gsKnots) {
    if (dnm == null || !Number.isFinite(dnm) || gsKnots == null || !Number.isFinite(gsKnots) || gsKnots < 12)
      return "— —";
    const mins = (dnm / gsKnots) * 60;
    const eta = new Date(Date.now() + mins * 60 * 1000);
    const h = eta.getUTCHours();
    const m = eta.getUTCMinutes();
    return String(h).padStart(2, "0") + String(m).padStart(2, "0") + "z";
  }

  /** ND 右上角：ETA 本地时间 HH:MM */
  function formatNdEtaLocalFromNm(dnm, gsKnots) {
    if (dnm == null || !Number.isFinite(dnm) || gsKnots == null || !Number.isFinite(gsKnots) || gsKnots < 12)
      return "—:—";
    const mins = (dnm / gsKnots) * 60;
    const eta = new Date(Date.now() + mins * 60 * 1000);
    const h = eta.getHours();
    const m = eta.getMinutes();
    return String(h) + ":" + String(m).padStart(2, "0");
  }

  /** ND 顶部：风矢（相对机头向上，指向风吹向） */
  function drawNdWindArrow(ctx, cx, cy, windDirMag, hdgMag) {
    if (windDirMag == null || !Number.isFinite(windDirMag) || hdgMag == null || !Number.isFinite(hdgMag)) return;
    const toRel = normHdg(windDirMag + 180 - hdgMag);
    const rad = (toRel * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rad + Math.PI / 2);
    ctx.strokeStyle = "#5fdb8c";
    ctx.fillStyle = "#5fdb8c";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(3.2, 3);
    ctx.lineTo(0, 1.2);
    ctx.lineTo(-3.2, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** ND 罗盘弧顶：空心航迹/航向三角（橙黄，尖端向下） */
  function drawNdTrackCaret(ctx, cx, topY) {
    ctx.save();
    ctx.strokeStyle = "#e8a040";
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    ctx.moveTo(cx, topY + 7);
    ctx.lineTo(cx - 4.5, topY);
    ctx.lineTo(cx + 4.5, topY);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function redrawNd() {
    const c = document.getElementById("ndCanvas");
    if (!c) return;
    const ctx = c.getContext("2d");
    const w = ndCssW, h = ndCssH;
    ctx.setTransform(ndDpr, 0, 0, ndDpr, 0, 0);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
    syncNdPlanChrome();

    const TOP_H = 18;
    const BOT_H = 4;
    const acY = h - BOT_H - 6;
    const cx = w / 2;
    const Rmax = Math.min(acY - TOP_H - 2, w / 2 - 2);
    const usableR = Math.max(16, Rmax - ND_COMPASS_TICK_INWARD_PX);
    const pxPerNm = usableR / ND_RING_SPAN_NM;

    const COL_GREEN = "#5fdb8c";
    const COL_CYAN = "#6ee8f0";
    const COL_PINK = "#f2a8c8";
    const COL_WHITE = "#f2f5f7";
    const COL_MAGENTA = "#ff2fd8";
    const COL_MAGENTA_SOFT = "rgba(255, 45, 220, 0.88)";
    const ndMagVarDeg = ndCourseMagVarDegFromTelemetry();

    let acLat, acLon, hdgN, trkN, compassRef;
    let ndPreviewMode = false;

    if (lastTelemetry && lastTelemetry.ok) {
      /* 位置与航向同一包：避免「真航向 + 插值位置」在转弯时产生细微方位误差 */
      acLat = lastTelemetry.lat;
      acLon = lastTelemetry.lon;
      /* 与 SimConnect 包一致：原始航向/航迹 */
      hdgN = normHdg(lastTelemetry.heading_deg != null ? lastTelemetry.heading_deg : 0);
      trkN = null;
      if (lastTelemetry.ground_track_deg != null && Number.isFinite(lastTelemetry.ground_track_deg)) {
        trkN = normHdg(lastTelemetry.ground_track_deg);
      }
      compassRef = hdgN;
      if (planWaypoints.length) advanceWaypoints(lastTelemetry.lat, lastTelemetry.lon);
    } else if (planWaypoints.length >= 2) {
      ndPreviewMode = true;
      let sl = 0, sn = 0;
      for (let pi = 0; pi < planWaypoints.length; pi++) {
        sl += planWaypoints[pi].lat;
        sn += planWaypoints[pi].lon;
      }
      acLat = sl / planWaypoints.length;
      acLon = sn / planWaypoints.length;
      hdgN = 0;
      trkN = null;
      compassRef = 0;
    } else {
      ctx.fillStyle = "#5a6560";
      ctx.font = "10px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      if (ndPlanMode)
        ctx.fillText("PLAN：请先导入航线 (.pln)", cx, h / 2);
      else
        ctx.fillText("无飞行数据 · 可导入 .pln", cx, acY - Rmax * 0.35);
      drawNdAircraftSymbol(ctx, cx, acY);
      return;
    }

    if (ndPlanMode && planWaypoints.length >= 1) {
      function planEnuNm(refLat, refLon, lat, lon) {
        const north = (lat - refLat) * 60;
        let dLon = lon - refLon;
        while (dLon > 180) dLon -= 360;
        while (dLon < -180) dLon += 360;
        const east = dLon * 60 * Math.cos(refLat * Math.PI / 180);
        return { east: east, north: north };
      }

      const mapTop = TOP_H + 2;
      const mapBot = h - BOT_H - 2;
      const mcx = w / 2;
      const mcy = (mapTop + mapBot) / 2;
      const pad = 8;
      const mapW = w - pad * 2 - 50;
      const mapH = mapBot - mapTop - 6;

      const navPts = [];
      navPts.push({ lat: acLat, lon: acLon });
      if (!ndPreviewMode && lastTelemetry && lastTelemetry.ok) {
        for (let ii = nextWpSeq; ii < planWaypoints.length; ii++)
          navPts.push(planWaypoints[ii]);
      } else {
        for (let ii = 0; ii < planWaypoints.length; ii++)
          navPts.push(planWaypoints[ii]);
      }

      /* 投影原点 = 本机 (acLat,acLon)：缩放围绕「所在位置」，航线相对本机展开，不再绕包围盒中心 */
      let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
      let maxRn = 2;
      for (let pi = 0; pi < navPts.length; pi++) {
        const q = planEnuNm(acLat, acLon, navPts[pi].lat, navPts[pi].lon);
        minE = Math.min(minE, q.east);
        maxE = Math.max(maxE, q.east);
        minN = Math.min(minN, q.north);
        maxN = Math.max(maxN, q.north);
        const d = Math.hypot(q.east, q.north);
        if (d > maxRn) maxRn = d;
      }
      const spanE = Math.max(maxE - minE, 1.25);
      const spanN = Math.max(maxN - minN, 1.25);
      const scale =
        Math.min(mapW / spanE, mapH / spanN) * 0.9 * ndPlanZoom;
      function projPlan(la, lo) {
        const q = planEnuNm(acLat, acLon, la, lo);
        return { x: mcx + q.east * scale, y: mcy - q.north * scale };
      }

      function niceNm(x) {
        if (!Number.isFinite(x) || x <= 0) return 5;
        const p = Math.pow(10, Math.floor(Math.log10(x)));
        const n = x / p;
        const u = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
        return u * p;
      }
      const ringOuter = niceNm(maxRn * 1.08);
      const ringIn = Math.max(ringOuter * 0.5, niceNm(maxRn * 0.42));
      const rOutPx = ringOuter * scale;
      const rInPx = ringIn * scale;

      /* 固定屏幕半径的内圈虚线（不随 PLAN 缩放变海里比例），始终套在本机为中心的 HUD 上 */
      const planHudRingPx = Math.min(
        52,
        Math.max(
          32,
          Math.min(mcx - 6, mcy - mapTop - 8, mapBot - mcy - 14, w - mcx - 6) | 0
        )
      );
      ctx.strokeStyle = "rgba(255,255,255,0.34)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(mcx, mcy, planHudRingPx, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255,255,255,0.52)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.arc(mcx, mcy, rInPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = COL_WHITE;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.arc(mcx, mcy, rOutPx, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = COL_CYAN;
      ctx.font = "9px Consolas, ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(String(Math.round(ringIn)), mcx - rInPx * 0.72, mcy + rInPx * 0.62);
      ctx.fillText(String(Math.round(ringOuter)), mcx - rOutPx * 0.68, mcy + rOutPx * 0.68);

      [{ b: 0, t: "N" }, { b: 90, t: "E" }, { b: 180, t: "S" }, { b: 270, t: "W" }].forEach(function (crd) {
        const rad = (-Math.PI / 2) + crd.b * Math.PI / 180;
        const tr = rOutPx - 11;
        ctx.fillStyle = COL_WHITE;
        ctx.font = "bold 11px Consolas, ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(crd.t, mcx + tr * Math.cos(rad), mcy + tr * Math.sin(rad) + 4);
      });

      ctx.fillStyle = "#e8d050";
      ctx.fillRect(mcx - 1.5, mcy - rOutPx - 1, 3, 9);

      ctx.strokeStyle = COL_GREEN;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let ri = 0; ri < navPts.length; ri++) {
        const p = projPlan(navPts[ri].lat, navPts[ri].lon);
        if (ri === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      const wpsDraw = !ndPreviewMode && lastTelemetry && lastTelemetry.ok
        ? planWaypoints.slice(nextWpSeq)
        : planWaypoints.slice();
      for (let wi = 0; wi < wpsDraw.length; wi++) {
        const wp = wpsDraw[wi];
        const p = projPlan(wp.lat, wp.lon);
        const nm = String(wp.name || "").slice(0, 6);
        ctx.strokeStyle = COL_GREEN;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - 4, p.y);
        ctx.lineTo(p.x + 4, p.y);
        ctx.moveTo(p.x, p.y - 4);
        ctx.lineTo(p.x, p.y + 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = COL_GREEN;
        ctx.font = "8px Consolas, ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillText(nm, p.x + 6, p.y + 3);
      }

      const pa = projPlan(acLat, acLon);
      ctx.save();
      ctx.translate(pa.x, pa.y);
      ctx.rotate((hdgN * Math.PI) / 180);
      ctx.fillStyle = "#e8d050";
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(6, 6);
      ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (!ndPreviewMode) {
        const gs = lastTelemetry.groundspeed_knots;
        const tasDisp = tasKnotsFromTelemetry(lastTelemetry);
        const windStr = formatWindDisplay(lastTelemetry);
        ctx.textAlign = "left";
        ctx.font = "600 10px Consolas, ui-monospace, monospace";
        ctx.fillStyle = COL_GREEN;
        ctx.fillText("GS " + (gs != null && Number.isFinite(gs) ? Math.round(gs) : "—"), 6, 12);
        ctx.fillText("TAS " + (tasDisp != null ? tasDisp : "—"), 6, 23);
        ctx.font = "9px Consolas, ui-monospace, monospace";
        ctx.fillText("PLAN", 6, 34);
        ctx.fillStyle = "rgba(200,230,210,0.95)";
        ctx.fillText("↘ " + (windStr || "—° / —"), 36, 34);

        /* 航路块放左侧 GS/风下方，避免遮挡中央航迹线与右侧航线/航点标注 */
        const ndNavL = 6;
        const ndNavY0 = 46;
        const ndNavDy = 10;
        ctx.textAlign = "left";
        if (planWaypoints.length && nextWpSeq < planWaypoints.length) {
          const nxw = planWaypoints[nextWpSeq];
          const dtk = courseTrueToMagDeg(nextLegCourseDeg(acLat, acLon), ndMagVarDeg);
          const dtkNxt = courseTrueToMagDeg(nextLegOutboundFromNextWpDeg(), ndMagVarDeg);
          const dnm = haversineNm(acLat, acLon, nxw.lat, nxw.lon);
          let y = ndNavY0;
          ctx.fillStyle = COL_MAGENTA;
          ctx.font = "600 10px Consolas, ui-monospace, monospace";
          ctx.fillText(String(nxw.name || "").slice(0, 7), ndNavL, y);
          y += ndNavDy;
          ctx.fillStyle = COL_WHITE;
          ctx.font = "600 9px Consolas, ui-monospace, monospace";
          const dtkPre = nextWpSeq === 0 ? "BRG" : "DTK";
          ctx.fillText(
            dtkPre + " " + (dtk != null ? String(Math.round(dtk)).padStart(3, "0") : "—") + "°",
            ndNavL,
            y
          );
          y += ndNavDy;
          ctx.fillStyle = dtkNxt != null ? COL_WHITE : "rgba(160,175,185,0.85)";
          ctx.fillText(formatNdNxtLegLabel(), ndNavL, y);
          y += ndNavDy;
          ctx.fillStyle = COL_CYAN;
          ctx.font = "600 10px Consolas, ui-monospace, monospace";
          ctx.fillText(fmtNum(dnm, 0) + " NM", ndNavL, y);
          y += ndNavDy;
          let etaStr = "—:—";
          if (gs != null && Number.isFinite(gs) && gs > 15 && dnm > 0) {
            const mtot = Math.round((dnm / gs) * 60);
            const hh = Math.floor(mtot / 60);
            const mm = mtot % 60;
            etaStr = hh + ":" + (mm < 10 ? "0" : "") + mm;
          }
          ctx.fillStyle = COL_GREEN;
          ctx.font = "600 10px Consolas, ui-monospace, monospace";
          ctx.fillText(etaStr, ndNavL, y);
        }
      } else {
        ctx.textAlign = "left";
        ctx.fillStyle = COL_GREEN;
        ctx.font = "10px Segoe UI, sans-serif";
        ctx.fillText("PLAN · 航线预览", 6, 14);
        ctx.fillText("真北向上", 6, 27);
      }

      ctx.fillStyle = "rgba(232,208,80,0.9)";
      ctx.font = "700 7px Consolas, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("N↑", mcx, mapTop + 10);

      return;
    }

    function bearingRelToScreenRad(targetBrg) {
      let rel = normHdg(targetBrg) - compassRef;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      if (rel < -90 || rel > 90) return null;
      return (-Math.PI / 2) + rel * Math.PI / 180;
    }

    function projectPt(la, lo) {
      const q = projectNm(acLat, acLon, hdgN, la, lo);
      return {
        x: cx + q.cross * pxPerNm,
        y: acY - q.fwd * pxPerNm,
        fwd: q.fwd,
        cross: q.cross
      };
    }

    function drawRoute(pts, stroke, lineW, dash) {
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineW;
      if (dash && dash.length) ctx.setLineDash(dash);
      else ctx.setLineDash([]);
      ctx.beginPath();
      let moved = false;
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        const la = pt.lat != null ? pt.lat : pt[0];
        const lo = pt.lon != null ? pt.lon : pt[1];
        const p = projectPt(la, lo);
        if (!moved) {
          ctx.moveTo(p.x, p.y);
          moved = true;
        } else ctx.lineTo(p.x, p.y);
      }
      if (moved) ctx.stroke();
      ctx.setLineDash([]);
    }

    function ndRemainingPlanPoints() {
      const pts = [];
      if (!planWaypoints.length) return pts;
      pts.push({ lat: acLat, lon: acLon });
      for (let i = nextWpSeq; i < planWaypoints.length; i++) {
        pts.push(planWaypoints[i]);
      }
      return pts;
    }

    function drawNdBoeingNeedle(brgDeg, mode) {
      const rad = bearingRelToScreenRad(normHdg(brgDeg));
      if (rad == null) return;
      const r = Rmax - 8;
      const x = cx + r * Math.cos(rad);
      const y = acY + r * Math.sin(rad);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rad + Math.PI / 2);
      const drawDouble = mode !== "single";
      if (drawDouble) {
        ctx.strokeStyle = "rgba(90, 0, 70, 0.95)";
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.lineTo(6.5, 5.5);
        ctx.lineTo(-6.5, 5.5);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.strokeStyle = COL_MAGENTA;
      ctx.lineWidth = drawDouble ? 1.25 : 1.1;
      ctx.beginPath();
      ctx.moveTo(0, drawDouble ? -7 : -7.5);
      ctx.lineTo(drawDouble ? 5.5 : 5, drawDouble ? 4.5 : 5);
      ctx.lineTo(drawDouble ? -5.5 : -5, drawDouble ? 4.5 : 5);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    const arcTrim = 0.14;
    ctx.strokeStyle = "rgba(255,255,255,0.52)";
    ctx.lineWidth = 1;
    ctx.lineCap = "butt";
    ctx.setLineDash([4, 5]);
    [10, 20, 30].forEach(function (nm) {
      const rr = nm * pxPerNm;
      ctx.beginPath();
      ctx.arc(cx, acY, rr, Math.PI + arcTrim, 2 * Math.PI - arcTrim, false);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    [10, 20, 30].forEach(function (nm) {
      const rr = nm * pxPerNm;
      const ly = acY - Math.min(rr * 0.42, Rmax * 0.38);
      const out = 7;
      ctx.fillStyle = COL_CYAN;
      ctx.font = "600 10px Consolas, ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.fillText(String(nm), cx - rr - out, ly);
      ctx.textAlign = "left";
      ctx.fillText(String(nm), cx + rr + out, ly);
    });

    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, acY, Rmax, Math.PI + arcTrim, 2 * Math.PI - arcTrim, false);
    ctx.stroke();

    const rTickOuter = Rmax;
    const compassLabelR = Rmax + 13;
    for (let delta = -90; delta <= 90; delta += 5) {
      if (delta === -90 || delta === 90) continue;
      const rad = (-Math.PI / 2) + delta * Math.PI / 180;
      const isMajor = delta % 10 === 0;
      const tickIn = isMajor ? (delta === 0 ? 11 : 12) : 7;
      const rInner = rTickOuter - tickIn;
      ctx.strokeStyle = isMajor ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.42)";
      ctx.lineWidth = isMajor ? 1.15 : 0.65;
      ctx.beginPath();
      ctx.moveTo(cx + rTickOuter * Math.cos(rad), acY + rTickOuter * Math.sin(rad));
      ctx.lineTo(cx + rInner * Math.cos(rad), acY + rInner * Math.sin(rad));
      ctx.stroke();
      if (!isMajor) continue;
      const brg = normHdg(compassRef + delta);
      const tens = Math.floor(brg / 10) % 36;
      const txt = String(tens);
      ctx.fillStyle = delta === 0 || Math.abs(delta) % 30 === 0 ? COL_WHITE : "rgba(210,220,218,0.92)";
      ctx.font = delta === 0 || Math.abs(delta) % 30 === 0 ? "bold 13px Consolas, ui-monospace, monospace" : "10px Consolas, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, cx + compassLabelR * Math.cos(rad), acY + compassLabelR * Math.sin(rad));
      ctx.textBaseline = "alphabetic";
    }

    if (planWaypoints.length >= 2) {
      drawRoute(planWaypoints, "rgba(95, 219, 140, 0.48)", 1.15, [5, 6]);
      ctx.fillStyle = "rgba(95, 219, 140, 0.42)";
      for (let wi = 0; wi < planWaypoints.length; wi++) {
        const wp = planWaypoints[wi];
        const p = projectPt(wp.lat, wp.lon);
        if (Math.hypot(p.cross, p.fwd) > ND_RANGE_NM * 1.3) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (!ndPreviewMode) {
      const trailRaw = lastTelemetry.trail || [];
      const trailSlice = trailRaw.length > 180 ? trailRaw.slice(-180) : trailRaw;
      if (trailSlice.length >= 2) {
        const asWp = trailSlice.map(function (p) { return { lat: p[0], lon: p[1] }; });
        drawRoute(asWp, "rgba(55, 200, 100, 0.38)", 1.45);
      }
    }

    const routeAhead = ndRemainingPlanPoints();
    if (!ndPreviewMode && routeAhead.length >= 2) {
      drawRoute(routeAhead, COL_MAGENTA_SOFT, 2.45, null);
      ctx.fillStyle = COL_MAGENTA;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 0.8;
      for (let ri = 1; ri < routeAhead.length; ri++) {
        const wp = routeAhead[ri];
        const p = projectPt(wp.lat, wp.lon);
        if (Math.hypot(p.cross, p.fwd) > ND_RANGE_NM * 1.25) continue;
        const s = ri === 1 ? 3.6 : 2.8;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.rect(-s, -s, s * 2, s * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        if (ri === 1 && wp.name) {
          ctx.fillStyle = COL_MAGENTA;
          ctx.font = "600 8px Consolas, ui-monospace, monospace";
          ctx.textAlign = "left";
          ctx.fillText(String(wp.name).slice(0, 7), p.x + 6, p.y - 2);
        }
      }
    }

    drawNdTrackCaret(ctx, cx, acY - Rmax);

    ctx.strokeStyle = COL_WHITE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, acY);
    ctx.lineTo(cx, acY - Rmax);
    ctx.stroke();

    if (planWaypoints.length && nextWpSeq < planWaypoints.length) {
      const nx = planWaypoints[nextWpSeq];
      drawNdBoeingNeedle(bearingDeg(acLat, acLon, nx.lat, nx.lon), "double");
      if (nextWpSeq + 1 < planWaypoints.length) {
        const n2 = planWaypoints[nextWpSeq + 1];
        drawNdBoeingNeedle(bearingDeg(acLat, acLon, n2.lat, n2.lon), "single");
      }
    }

    drawNdAircraftSymbol(ctx, cx, acY);

    if (ndPreviewMode) {
      ctx.fillStyle = "#8fbc8f";
      ctx.font = "10px Segoe UI, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("航线已载入", 6, 14);
      ctx.fillText("连接后对齐本机", 6, 26);
    } else {
      const gs = lastTelemetry.groundspeed_knots;
      const tasDisp = tasKnotsFromTelemetry(lastTelemetry);
      const windStr = formatWindDisplay(lastTelemetry);
      const windLine2 = (function () {
        if (!lastTelemetry || !lastTelemetry.ok) return null;
        var d = lastTelemetry.wind_direction_deg;
        var s = lastTelemetry.wind_speed_knots;
        if (d == null || !Number.isFinite(d) || s == null || !Number.isFinite(s)) return null;
        var dd = Math.round(normHdg(d));
        return String(dd).padStart(3, "0") + " / " + String(Math.round(s)).padStart(2, "0");
      })();

      ctx.textAlign = "left";
      ctx.font = "600 10px Consolas, ui-monospace, monospace";
      ctx.fillStyle = COL_GREEN;
      ctx.fillText(
        "GS " + (gs != null && Number.isFinite(gs) ? Math.round(gs) : "—") + "  TAS " + (tasDisp != null ? tasDisp : "—"),
        6,
        12
      );
      ctx.font = "600 9px Consolas, ui-monospace, monospace";
      const w2 = windLine2 || "— / —";
      ctx.fillText(w2, 6, 24);
      if (lastTelemetry && lastTelemetry.wind_direction_deg != null && Number.isFinite(lastTelemetry.wind_direction_deg))
        drawNdWindArrow(ctx, 6 + ctx.measureText(w2).width + 6, 21, lastTelemetry.wind_direction_deg, hdgN);

      const hhStr = fmtNum(trkN != null ? trkN : hdgN, 1);
      const topTitle = trkN != null ? "TRK" : "HDG";
      const topStr = topTitle + " " + hhStr + " MAG";
      ctx.textAlign = "center";
      ctx.font = "700 11px Consolas, ui-monospace, monospace";
      const tw = ctx.measureText(topStr).width;
      const hdgBoxY = 20;
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(cx - tw / 2 - 7, hdgBoxY, tw + 14, 19);
      ctx.strokeStyle = COL_WHITE;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - tw / 2 - 7, hdgBoxY, tw + 14, 19);
      ctx.fillStyle = COL_WHITE;
      ctx.fillText(topStr, cx, hdgBoxY + 13);

      /* 航路块：左下（GS/风之下），避免盖住中央 TRK 框与右侧航线 */
      const ndNavL = 6;
      const ndNavY0 = 42;
      const ndNavDy = 10;
      ctx.textAlign = "left";
      ctx.font = "600 10px Consolas, ui-monospace, monospace";
      if (planWaypoints.length && nextWpSeq < planWaypoints.length) {
        const nxw = planWaypoints[nextWpSeq];
        const dnm = haversineNm(acLat, acLon, nxw.lat, nxw.lon);
        const etaLocal = formatNdEtaLocalFromNm(dnm, gs);
        const nmStr = fmtNum(dnm, 1) + " NM";
        const dtkN = courseTrueToMagDeg(nextLegCourseDeg(acLat, acLon), ndMagVarDeg);
        const dtkNxt = courseTrueToMagDeg(nextLegOutboundFromNextWpDeg(), ndMagVarDeg);
        let y = ndNavY0;
        ctx.fillStyle = COL_MAGENTA;
        ctx.fillText(String(nxw.name || "WPT").slice(0, 7), ndNavL, y);
        y += ndNavDy;
        ctx.fillStyle = dtkN != null ? COL_WHITE : "rgba(160,175,185,0.85)";
        ctx.font = "600 9px Consolas, ui-monospace, monospace";
        const dtkPre = nextWpSeq === 0 ? "BRG" : "DTK";
        ctx.fillText(
          dtkN != null ? dtkPre + " " + String(Math.round(dtkN)).padStart(3, "0") + "°" : dtkPre + " —°",
          ndNavL,
          y
        );
        y += ndNavDy;
        ctx.fillStyle = dtkNxt != null ? COL_WHITE : "rgba(160,175,185,0.85)";
        ctx.fillText(formatNdNxtLegLabel(), ndNavL, y);
        y += ndNavDy;
        ctx.font = "600 10px Consolas, ui-monospace, monospace";
        ctx.fillStyle = COL_CYAN;
        ctx.fillText(nmStr, ndNavL, y);
        y += ndNavDy;
        ctx.fillStyle = COL_GREEN;
        ctx.fillText(etaLocal, ndNavL, y);
      } else {
        ctx.fillStyle = "rgba(160,175,185,0.85)";
        let y = ndNavY0;
        ctx.fillText("—", ndNavL, y);
        y += ndNavDy;
        ctx.font = "600 9px Consolas, ui-monospace, monospace";
        ctx.fillText("DTK —°", ndNavL, y);
        y += ndNavDy;
        ctx.fillText("NXT —°", ndNavL, y);
        y += ndNavDy;
        ctx.font = "600 10px Consolas, ui-monospace, monospace";
        ctx.fillStyle = COL_CYAN;
        ctx.fillText("— NM", ndNavL, y);
        y += ndNavDy;
        ctx.fillStyle = COL_GREEN;
        ctx.fillText("—:—", ndNavL, y);
      }
    }

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, acY + 7, w, h - acY - 7);
  }

  function resizeNd() {
    const c = document.getElementById("ndCanvas");
    if (!c) return;
    ndDpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(ndCssW * ndDpr);
    c.height = Math.round(ndCssH * ndDpr);
    c.style.width = ndCssW + "px";
    c.style.height = ndCssH + "px";
    redrawNd();
  }

  /** 解析 FS / MSFS WorldPosition：十进制度 或 Nxx° xx' xx" 形式 */
  function parseWorldPosition(raw) {
    if (!raw || typeof raw !== "string") return null;
    const s = raw.replace(/\s+/g, " ").trim();
    const dec = s.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (dec) {
      const lat = parseFloat(dec[1]);
      const lon = parseFloat(dec[2]);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        return { lat: lat, lon: lon };
    }
    const parts = s.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length < 2) return null;
    function parseDmsChunk(chunk) {
      const t = chunk.trim();
      const m = t.match(/^([NSEW])\s*(\d+(?:\.\d+)?)\s*°(?:\s*(\d+(?:\.\d+)?)\s*['′])?(?:\s*(\d+(?:\.\d+)?)\s*[″"])?/i);
      if (!m) return null;
      const hemi = m[1].toUpperCase();
      let deg = parseFloat(m[2]);
      const min = m[3] != null ? parseFloat(m[3]) : 0;
      const sec = m[4] != null ? parseFloat(m[4]) : 0;
      let v = deg + min / 60 + sec / 3600;
      if (hemi === "S" || hemi === "W") v = -v;
      return v;
    }
    const la = parseDmsChunk(parts[0]);
    const lo = parseDmsChunk(parts[1]);
    if (la == null || lo == null) return null;
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    return { lat: la, lon: lo };
  }

  function getTextEl(parent, localName) {
    const nodes = parent.getElementsByTagName("*");
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].localName === localName || nodes[i].nodeName === localName)
        return nodes[i].textContent;
      if (nodes[i].nodeName.endsWith(":" + localName))
        return nodes[i].textContent;
    }
    return null;
  }

  function parsePlnXml(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("XML 解析失败（不是合法的 .pln / AceXML？）");
    }
    const wps = [];
    const nodes = doc.getElementsByTagName("ATCWaypoint");
    let list = [];
    for (let i = 0; i < nodes.length; i++) list.push(nodes[i]);
    if (list.length === 0) {
      const all = doc.getElementsByTagName("*");
      for (let i = 0; i < all.length; i++) {
        if (all[i].localName === "ATCWaypoint" || all[i].nodeName === "ATCWaypoint" || all[i].tagName === "ATCWaypoint")
          list.push(all[i]);
      }
    }
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      let wpPos = null;
      const children = el.getElementsByTagName("*");
      for (let j = 0; j < children.length; j++) {
        const ch = children[j];
        if (ch.localName === "WorldPosition" || ch.nodeName === "WorldPosition") {
          wpPos = parseWorldPosition(ch.textContent || "");
          break;
        }
      }
      if (!wpPos) continue;
      let name = el.getAttribute("id") || el.getAttribute("Name") || el.getAttribute("name") || "";
      if (!name) {
        const icao = getTextEl(el, "ICAO");
        if (icao) name = icao.trim();
      }
      if (!name) name = "WP" + (wps.length + 1);
      const altFt = getWaypointAltFt(el);
      wps.push({ lat: wpPos.lat, lon: wpPos.lon, name: name, altFt: altFt });
    }
    if (wps.length === 0) {
      throw new Error("未找到带 WorldPosition 的 ATCWaypoint（请用模拟飞行内建计划或兼容格式另存 .pln）");
    }
    let title = "";
    const titleNodes = doc.getElementsByTagName("*");
    for (let i = 0; i < titleNodes.length; i++) {
      if (titleNodes[i].localName === "Title" && titleNodes[i].textContent) {
        title = titleNodes[i].textContent.trim();
        break;
      }
    }
    return { title: title, waypoints: wps };
  }

  function redrawPlanOnMap() {
    planGroup.clearLayers();
    planLine = null;
    if (planWaypoints.length < 2) {
      if (planWaypoints.length === 1) {
        const w = planWaypoints[0];
        const dot = L.divIcon({
          className: "plan-wp",
          html: '<div style="position:relative"><div class="plan-dot-inner"></div><span class="plan-dot-label">' + escapeHtml(w.name) + "</span></div>",
          iconSize: [20, 20],
          iconAnchor: [5, 5]
        });
        L.marker([w.lat, wrapLng180(w.lon)], { icon: dot }).addTo(planGroup);
      }
      return;
    }
    const rawPlan = planWaypoints.map(function (w) { return [w.lat, w.lon]; });
    let latlngs = unwrapLatLngsForPolyline(rawPlan);
    if (latlngs.length) {
      latlngs = shiftLngStripToRef(latlngs, planWaypoints[0].lon);
    }
    planLine = L.polyline(latlngs, {
      color: "#ff9500", weight: 4, opacity: 0.9, dashArray: "10 8", lineJoin: "round"
    }).addTo(planGroup);
    for (let i = 0; i < planWaypoints.length; i++) {
      const w = planWaypoints[i];
      const dot = L.divIcon({
        className: "plan-wp",
        html: '<div style="position:relative"><div class="plan-dot-inner"></div><span class="plan-dot-label">' + (i + 1) + " " + escapeHtml(w.name) + "</span></div>",
        iconSize: [24, 20],
        iconAnchor: [5, 5]
      });
      L.marker([w.lat, wrapLng180(w.lon)], { icon: dot }).addTo(planGroup);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  function fitPlanBounds() {
    const pts = planWaypoints.map(function (w) { return [w.lat, w.lon]; });
    if (marker) pts.push(marker.getLatLng());
    if (pts.length === 0) return;
    const b = L.latLngBounds(pts);
    map.fitBounds(b, { padding: [48, 48], maxZoom: 12 });
  }

  function syncPlanToServer() {
    var body = planWaypoints.length
      ? JSON.stringify({ title: planTitle, waypoints: planWaypoints })
      : JSON.stringify({ clear: true });
    return fetch(PLAN_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: body
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && typeof j.rev === "number") lastServerPlanRev = j.rev;
      })
      .catch(function () {});
  }

  function applyServerPlan(plan) {
    if (!plan || !plan.waypoints || !plan.waypoints.length) {
      clearPlan({ skipRemote: true });
      return;
    }
    planTitle = plan.title || "";
    planWaypoints = plan.waypoints;
    nextWpSeq = 0;
    redrawPlanOnMap();
    fitPlanBounds();
    planinfoEl.textContent =
      "已从局域网同步 " + planWaypoints.length + " 个航点" + (planTitle ? " · " + planTitle : "");
    savePlanToStorage({ skipRemote: true });
    if (lastTelemetry && lastTelemetry.ok)
      planHudLine(lastTelemetry.lat, lastTelemetry.lon);
    redrawNd();
    redrawAdiVnavProfile();
  }

  function maybeHandlePlanRev(data) {
    if (typeof data.plan_rev !== "number") return;
    if (!planSyncInitialized) {
      planSyncInitialized = true;
      var initialRev = data.plan_rev;
      fetch(PLAN_SYNC_URL)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (typeof j.rev !== "number") return;
          if (j.plan && j.plan.waypoints && j.plan.waypoints.length) {
            applyServerPlan(j.plan);
            lastServerPlanRev = j.rev;
          } else if (planWaypoints.length) {
            return syncPlanToServer();
          } else {
            lastServerPlanRev = j.rev;
          }
        })
        .catch(function () {
          lastServerPlanRev = initialRev;
        });
      return;
    }
    if (lastServerPlanRev === null) return;
    if (data.plan_rev === lastServerPlanRev) return;
    fetch(PLAN_SYNC_URL)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (typeof j.rev !== "number" || j.rev !== data.plan_rev) return;
        lastServerPlanRev = j.rev;
        applyServerPlan(j.plan);
      })
      .catch(function () {});
  }

  function savePlanToStorage(options) {
    var skipRemote = options && options.skipRemote;
    try {
      if (!planWaypoints.length) {
        localStorage.removeItem(PLAN_STORAGE_KEY);
        if (!skipRemote) syncPlanToServer();
        return;
      }
      localStorage.setItem(
        PLAN_STORAGE_KEY,
        JSON.stringify({ title: planTitle, waypoints: planWaypoints })
      );
    } catch (e) {
      /* 存储满或禁用 localStorage */
    }
    if (!skipRemote) syncPlanToServer();
  }

  function loadPlanFromStorage() {
    try {
      const raw = localStorage.getItem(PLAN_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data.waypoints || !data.waypoints.length) return;
      planTitle = data.title || "";
      planWaypoints = data.waypoints;
      nextWpSeq = 0;
      redrawPlanOnMap();
      fitPlanBounds();
      planinfoEl.textContent =
        "已从本机恢复 " + planWaypoints.length + " 个航点" + (planTitle ? " · " + planTitle : "");
      redrawNd();
      redrawAdiVnavProfile();
    } catch (e) {
      try {
        localStorage.removeItem(PLAN_STORAGE_KEY);
      } catch (e2) {}
    }
  }

  function clearPlan(options) {
    var skipRemote = options && options.skipRemote;
    planWaypoints = [];
    planTitle = "";
    nextWpSeq = 0;
    planGroup.clearLayers();
    planLine = null;
    planinfoEl.textContent = "";
    try {
      localStorage.removeItem(PLAN_STORAGE_KEY);
    } catch (e) {}
    redrawNd();
    redrawAdiVnavProfile();
    if (!skipRemote) syncPlanToServer();
  }

  function advanceWaypoints(plat, plon) {
    if (!planWaypoints.length) return;
    const n = planWaypoints.length;
    if (n < 2) return;
    const cum = planCumulativeNm(planWaypoints);
    const along = closestAlongTrackNm(plat, plon, planWaypoints).alongNm;
    while (nextWpSeq < n - 1) {
      const w = planWaypoints[nextWpSeq];
      const d = haversineNm(plat, plon, w.lat, w.lon);
      const near = d < PASS_NM;
      const pastAlong = along >= cum[nextWpSeq] + PASS_ALONG_NM;
      if (near || pastAlong) nextWpSeq++;
      else break;
    }
  }

  function planHudLine(plat, plon) {
    if (!planWaypoints.length) {
      planinfoEl.textContent = "";
      return;
    }
    advanceWaypoints(plat, plon);
    const next = planWaypoints[nextWpSeq];
    const nm = next ? haversineNm(plat, plon, next.lat, next.lon) : null;
    const seg = (nextWpSeq + 1) + " / " + planWaypoints.length;
    let line = planTitle ? "「" + escapeHtml(planTitle) + "」· " : "";
    line += "航点 " + seg;
    if (next && nm != null)
      line += " · 下一航点 <strong style=color:#ff9500>" + escapeHtml(next.name) + "</strong> 约 " + fmtNum(nm, 1) + " NM";
    planinfoEl.innerHTML = line;
  }

  function applyPayload(data) {
    maybeHandlePlanRev(data);
    if (data && data.ok) normalizeTelemetryHeadingMag(data);
    lastTelemetry = data;
    if (!data.ok) {
      smoothReady = false;
      lastSmoothT = 0;
      /* 短时断流仍带航迹：有 trail 则保留绿线，无字段或空数组才清空，避免飞一半整段消失 */
      if (Array.isArray(data.trail)) {
        if (data.trail.length >= 2) {
          updateTrail(data.trail.map(function (p) { return [p[0], p[1]]; }));
        } else if (data.trail.length === 0) updateTrail([]);
      }
      updatePfdInstruments(null);
      redrawNd();
      redrawAdiVnavProfile();
      setStatus(false, data.error || "未知错误", "请确认已运行 启动.bat 且模拟飞行已进入驾驶舱。");
      return;
    }
    const lat = data.lat;
    const lon = data.lon;
    const hdg = data.heading_deg;
    const ll = [lat, wrapLng180(lon)];

    tgtLat = lat;
    tgtLon = lon;
    tgtPitch = data.pitch_deg != null ? data.pitch_deg : 0;
    tgtBank = data.bank_deg != null ? data.bank_deg : 0;
    tgtIas = data.ias_knots;
    tgtAlt = data.alt_ft;
    tgtHdg = data.heading_deg != null ? data.heading_deg : 0;
    tgtGs = data.groundspeed_knots;
    tgtVs = data.vertical_speed_fpm;
    tgtTrack = data.ground_track_deg;
    tgtGroundElevFt = data.ground_elev_ft;
    tgtRadioHeightFt = data.radio_height_ft;
    tgtAglGameFt = data.agl_game_ft;
    tgtAglBaroFt = data.agl_baro_ft;

    if (!marker) {
      marker = L.marker(L.latLng(ll[0], ll[1]), { icon: planeIcon }).addTo(map);
      map.setView(L.latLng(ll[0], ll[1]), Math.max(map.getZoom(), 11));
      dispLat = lat;
      dispLon = lon;
      dispHdg = tgtHdg;
    }

    const trail = (data.trail || []).map(function (p) { return [p[0], p[1]]; });
    updateTrail(trail);

    planHudLine(lat, lon);

    setStatus(true,
      "<strong>已连接</strong> · " + fmtNum(lat, 5) + "°, " + fmtNum(lon, 5) + "°",
      "地图航迹与计划 · 空速/高度/姿态见下方仪表"
    );
  }

  function connectStream() {
    let es;
    try {
      es = new EventSource(STREAM_URL);
    } catch (e) {
      setStatus(false, "无法创建 EventSource", String(e));
      return;
    }
    es.onopen = function () {
      setStatus(true, "数据流已连接，等待 SimConnect 数据…", "");
    };
    es.onmessage = function (ev) {
      try {
        applyPayload(JSON.parse(ev.data));
      } catch (e) {
        setStatus(false, "JSON 解析失败", String(e));
      }
    };
    es.onerror = function () {
      lastTelemetry = { ok: false };
      smoothReady = false;
      lastSmoothT = 0;
      /* 不重清航迹：EventSource 重连前常会触发 onerror，误删整条绿线 */
      updatePfdInstruments(null);
      redrawAdiVnavProfile();
      redrawNd();
      setStatus(false, "数据流中断", "请保持 msfs_bridge.py 运行；浏览器会自动重连。");
    };
  }

  (function initToolbarMobileHints() {
    var btn = document.getElementById("toolbarMoreBtn");
    var block = document.getElementById("toolbarHintsBlock");
    if (!btn || !block) return;
    btn.addEventListener("click", function () {
      var open = !block.classList.contains("show-mobile-hints");
      block.classList.toggle("show-mobile-hints", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  })();

  btnImport.addEventListener("click", function () { plnFile.click(); });
  plnFile.addEventListener("change", function () {
    const f = plnFile.files && plnFile.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = function () {
      try {
        const parsed = parsePlnXml(String(r.result || ""));
        planTitle = parsed.title || f.name.replace(/\.pln$/i, "");
        planWaypoints = parsed.waypoints;
        nextWpSeq = 0;
        redrawPlanOnMap();
        fitPlanBounds();
        planinfoEl.textContent =
          "已加载 " + planWaypoints.length + " 个航点（本机已保存，已同步到局域网）" + (planTitle ? " · " + planTitle : "");
        savePlanToStorage();
        if (lastTelemetry && lastTelemetry.ok)
          planHudLine(lastTelemetry.lat, lastTelemetry.lon);
        redrawNd();
        redrawAdiVnavProfile();
      } catch (e) {
        alert(e.message || String(e));
      }
      plnFile.value = "";
    };
    r.readAsText(f, "UTF-8");
  });

  btnFit.addEventListener("click", fitPlanBounds);
  btnClear.addEventListener("click", function () { clearPlan(); });
  btnFollow.addEventListener("click", function () {
    followPlane = true;
    if (marker) panMapFollowPlane(marker.getLatLng());
  });

  const ndPlanToggle = document.getElementById("ndPlanToggle");
  if (ndPlanToggle) {
    ndPlanToggle.addEventListener("click", function () {
      ndPlanMode = !ndPlanMode;
      ndPlanToggle.classList.toggle("is-active", ndPlanMode);
      ndPlanToggle.setAttribute("aria-pressed", ndPlanMode ? "true" : "false");
      if (!ndPlanMode) ndPlanZoom = 1;
      syncNdPlanChrome();
      redrawNd();
    });
  }
  const ndPlanZoomIn = document.getElementById("ndPlanZoomIn");
  const ndPlanZoomOut = document.getElementById("ndPlanZoomOut");
  if (ndPlanZoomIn) {
    ndPlanZoomIn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!ndPlanMode || !planWaypoints.length) return;
      ndPlanZoom = Math.min(ND_PLAN_ZOOM_MAX, ndPlanZoom * ND_PLAN_ZOOM_STEP);
      syncNdPlanChrome();
      redrawNd();
    });
  }
  if (ndPlanZoomOut) {
    ndPlanZoomOut.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!ndPlanMode || !planWaypoints.length) return;
      ndPlanZoom = Math.max(ND_PLAN_ZOOM_MIN, ndPlanZoom / ND_PLAN_ZOOM_STEP);
      syncNdPlanChrome();
      redrawNd();
    });
  }

  map.on("dragstart", function () { followPlane = false; });

  buildPitchLadder();
  resizeNd();
  resizeAdiVnav();
  window.addEventListener("resize", function () {
    resizeNd();
    resizeAdiVnav();
  });
  loadPlanFromStorage();

  (function initPfdPanelCollapse() {
    const panel = document.getElementById("pfdPanel");
    const btn = document.getElementById("pfdCollapseBtn");
    const key = "msfs_pfd_panel_collapsed_v1";
    if (!panel || !btn) return;
    function apply(collapsed) {
      panel.classList.toggle("is-collapsed", collapsed);
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.title = collapsed ? "展开综合显示" : "收起综合显示";
    }
    try {
      if (localStorage.getItem(key) === "1") apply(true);
    } catch (e) {
      /* ignore */
    }
    btn.addEventListener("click", function () {
      const next = !panel.classList.contains("is-collapsed");
      apply(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch (e2) {
        /* ignore */
      }
      if (followPlane && marker) panMapFollowPlane(marker.getLatLng());
    });
  })();

  (function initLanHint() {
    var el = document.getElementById("pageAccessHint");
    if (!el) return;
    var o = window.location.origin || "";
    var isLocal =
      o.indexOf("127.0.0.1") >= 0 || o.indexOf("localhost") >= 0 || o === "file:";
    el.textContent = isLocal
      ? "局域网：手机请用运行桥接时黑窗口里显示的「局域网访问」IP（与电脑同 Wi-Fi），不要用本机专用地址。"
      : "当前访问 " + o + " · 其他设备可用同一地址（须同网络）。";
  })();

  /**
   * 仪表整卡等比例缩放：「可用宽度 ÷ 未缩放面板外宽」；不测缩放后的 offsetWidth，避免 zoom/transform 与
   * ResizeObserver 反馈。手机浏览器另：视口宽度 > 920px 时不缩放（与大屏横屏一致）。
   * 电脑端：全屏时也略缩小（少挡地图），窄窗仍优先 min(舒适上限, 可用比例) 以免裁切。
   */
  (function initMobilePfdScale() {
    var panel = document.getElementById("pfdPanel");
    var wrap = document.querySelector(".cockpit-deck-wrap");
    if (!panel || !wrap) return;
    var BP = 920;
    var DESIGN_MIN = 740;
    /** 电脑端最大缩放（相对未缩放面板），宽屏时也保持略小，露出更多地图 */
    var DESKTOP_COMFORT_MAX = 0.88;
    /** 未应用 zoom/transform 时测一次的面板外宽，折叠/横竖屏后需作废重测 */
    var naturalOuterW = null;

    function availWidthPx() {
      var st = window.getComputedStyle(wrap);
      var pl = parseFloat(st.paddingLeft) || 0;
      var pr = parseFloat(st.paddingRight) || 0;
      return Math.max(0, wrap.clientWidth - pl - pr);
    }

    function invalidateNaturalW() {
      naturalOuterW = null;
    }

    function measureNaturalOuterW() {
      clearScale();
      naturalOuterW = Math.max(DESIGN_MIN, panel.offsetWidth || DESIGN_MIN);
      return naturalOuterW;
    }

    var zoomOk = (function () {
      var t = document.createElement("div");
      t.style.cssText = "zoom:0.75";
      return t.style.zoom === "0.75";
    })();

    function clearScale() {
      panel.style.zoom = "";
      panel.style.transform = "";
      panel.style.transformOrigin = "";
      panel.style.marginBottom = "";
    }

    function apply() {
      var isMobileAdapt = document.documentElement.classList.contains("mobile-adapt");
      if (isMobileAdapt && window.innerWidth > BP) {
        clearScale();
        invalidateNaturalW();
        return;
      }
      if (naturalOuterW == null) measureNaturalOuterW();
      var wBlk = naturalOuterW;
      var avail = availWidthPx() - 0.5;
      var raw = avail > 0 && wBlk > 0 ? avail / wBlk : 0;
      var s = isMobileAdapt
        ? Math.min(1, raw)
        : Math.min(DESKTOP_COMFORT_MAX, raw);
      if (s >= 0.998) {
        clearScale();
        return;
      }
      if (zoomOk) {
        clearScale();
        panel.style.zoom = s;
      } else {
        panel.style.zoom = "";
        var h = panel.offsetHeight;
        panel.style.transformOrigin = "bottom center";
        panel.style.transform = "scale(" + s + ")";
        panel.style.marginBottom = h > 0 ? h * (s - 1) + "px" : "";
      }
    }

    var tCollapse = null;
    function schedule() {
      if (tCollapse) clearTimeout(tCollapse);
      tCollapse = setTimeout(function () {
        tCollapse = null;
        /* 电脑端 width: min(1120px,100%) 随窗口变，每次重测自然宽；手机端保持缓存减少抖动 */
        if (!document.documentElement.classList.contains("mobile-adapt"))
          invalidateNaturalW();
        apply();
      }, 60);
    }

    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", function () {
      invalidateNaturalW();
      setTimeout(apply, 250);
    });
    var btn = document.getElementById("pfdCollapseBtn");
    if (btn)
      btn.addEventListener("click", function () {
        invalidateNaturalW();
        setTimeout(apply, 450);
      });
    if (window.ResizeObserver) {
      try {
        new ResizeObserver(schedule).observe(wrap);
      } catch (e2) {
        /* ignore */
      }
    }
    setTimeout(apply, 0);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        invalidateNaturalW();
        setTimeout(apply, 0);
      });
    }
  })();

  connectStream();
  requestAnimationFrame(tickSmooth);
})();
