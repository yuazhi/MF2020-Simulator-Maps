(function () {
  const STREAM_URL = "/api/stream";
  const PLAN_SYNC_URL = "/api/plan";
  const PLAN_LOAD_MSFS_URL = "/api/plan/load-msfs";
  const PLAN_STORAGE_KEY = "msfs_imported_plan_v1";
  const AUTO_LOAD_MSFS_KEY = "msfs_auto_load_msfs_v1";
  const BASE_LAYER_STORAGE_KEY = "msfs_base_layer_v1";
  const statusEl = document.getElementById("status");
  const planinfoEl = document.getElementById("planinfo");
  const plnFile = document.getElementById("plnFile");
  const btnImport = document.getElementById("btnImport");
  const btnLoadMsfs = document.getElementById("btnLoadMsfs");
  const chkAutoLoadMsfs = document.getElementById("chkAutoLoadMsfs");
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
  const mapInitOpts = {
    zoomControl: false,
    maxBounds: MAP_WORLD_BOUNDS,
    maxBoundsViscosity: 1.0,
    worldCopyJump: false
  };
  if (document.documentElement.classList.contains("mobile-adapt")) {
    mapInitOpts.preferCanvas = true;
  }
  const map = L.map("map", mapInitOpts).setView([39.9, 116.4], 5);

  if (map.createPane) {
    map.createPane("tcasSuppressPane");
    const tcPane = map.getPane("tcasSuppressPane");
    if (tcPane) {
      tcPane.style.zIndex = "480";
      tcPane.style.pointerEvents = "none";
    }
    map.createPane("trafficTrackPane");
    const trkPane = map.getPane("trafficTrackPane");
    if (trkPane) {
      trkPane.style.zIndex = "490";
      trkPane.style.pointerEvents = "none";
    }
  }

  const baseLayerDefs = {
    chart_light: {
      menuLabel: "航图底图 ★",
      create: function () {
        const grayBase = L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 16,
            attribution: "Tiles © Esri",
            noWrap: true
          }
        );
        const grayLabels = L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 16,
            attribution: "Labels © Esri",
            noWrap: true
          }
        );
        return L.layerGroup([grayBase, grayLabels]);
      }
    },
    chart_dark: {
      menuLabel: "航图底图 深色",
      create: function () {
        const darkBase = L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 16,
            attribution: "Tiles © Esri",
            noWrap: true
          }
        );
        const darkLabels = L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 16,
            attribution: "Labels © Esri",
            noWrap: true
          }
        );
        return L.layerGroup([darkBase, darkLabels]);
      }
    },
    carto_light: {
      menuLabel: "Carto 浅色",
      create: function () {
        return L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
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
    "chart_light",
    "chart_dark",
    "carto_light",
    "osm",
    "esri_img"
  ];
  const BASE_LAYER_LEGACY_FALLBACK = {
    carto_voyager: "chart_light",
    esri_street: "chart_light",
    opentopo: "chart_light"
  };
  const baseLayersById = {};
  for (var bi = 0; bi < baseLayerOrder.length; bi++) {
    var bid = baseLayerOrder[bi];
    baseLayersById[bid] = baseLayerDefs[bid].create();
  }

  function syncMapChartBaseTheme(baseId) {
    const mapEl = document.getElementById("map");
    if (mapEl) {
      mapEl.classList.toggle("map-chart-dark-base", baseId === "chart_dark");
    }
  }

  var currentBaseId = "chart_dark";
  try {
    var savedBase = localStorage.getItem(BASE_LAYER_STORAGE_KEY);
    if (savedBase && BASE_LAYER_LEGACY_FALLBACK[savedBase]) {
      savedBase = BASE_LAYER_LEGACY_FALLBACK[savedBase];
    }
    if (savedBase && baseLayerDefs[savedBase]) currentBaseId = savedBase;
  } catch (eBase) {}
  var currentBaseLayer = baseLayersById[currentBaseId];
  currentBaseLayer.addTo(map);
  syncMapChartBaseTheme(currentBaseId);

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
      syncMapChartBaseTheme(currentBaseId);
      navIconCacheClear();
      scheduleNavCnRefresh(true);
      try {
        localStorage.setItem(BASE_LAYER_STORAGE_KEY, currentBaseId);
      } catch (eStore) {}
    });
  }

  /** 机标应对准的容器像素点（与 map.getSize / project 同一坐标系） */
  function mapFollowAimPointPx() {
    const size = map.getSize();
    if (!size.x || !size.y) return L.point(0, 0);
    const panel = document.getElementById("pfdPanel");
    if (!panel) return L.point(size.x / 2, size.y / 2);
    const mapEl = map.getContainer();
    const mapRect = mapEl.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    let overlap = mapRect.bottom - panelRect.top;
    if (!Number.isFinite(overlap) || overlap < 0) overlap = 0;
    if (overlap > size.y * 0.9) overlap = size.y * 0.9;
    const visibleH = Math.max(40, size.y - overlap);
    return L.point(size.x / 2, visibleH * 0.5);
  }

  /** 地图机标：直接用最新遥测包，不做 rAF 积分/预测外推 */
  function mapAcState() {
    if (!lastTelemetry || !lastTelemetry.ok) return null;
    const lat =
      tgtLat != null && Number.isFinite(tgtLat) ? tgtLat : lastTelemetry.lat;
    const lon = wrapLng180(
      tgtLon != null && Number.isFinite(tgtLon) ? tgtLon : lastTelemetry.lon
    );
    const hdg =
      tgtHdg != null && Number.isFinite(tgtHdg)
        ? tgtHdg
        : lastTelemetry.heading_deg != null && Number.isFinite(lastTelemetry.heading_deg)
          ? lastTelemetry.heading_deg
          : 0;
    const alt =
      tgtAlt != null && Number.isFinite(tgtAlt) ? tgtAlt : lastTelemetry.alt_ft;
    return { lat: lat, lon: lon, hdg: hdg, alt: alt };
  }

  /** ND / 侧栏 VNAV / 航线推进：与地图相同，仅用包数据 */
  function navAcState() {
    return mapAcState();
  }

  /** 仪表缩放就绪后再跑地图/航图/数据流，避免与 PFD 布局争抢导致闪屏 */
  var whenPfdScaleReady = function (cb) {
    var q = whenPfdScaleReady._pending;
    if (!q) whenPfdScaleReady._pending = q = [];
    if (typeof cb === "function") q.push(cb);
  };

  let mapLayoutRefreshT = null;
  function scheduleMapLayoutRefresh(refollow) {
    if (mapLayoutRefreshT) clearTimeout(mapLayoutRefreshT);
    mapLayoutRefreshT = setTimeout(function () {
      mapLayoutRefreshT = null;
      map.invalidateSize({ animate: false, pan: false });
      if (refollow && followPlane) refollowMapCenter();
    }, 160);
  }

  let ndResizeTimer = 0;
  function scheduleResizeNd() {
    if (ndResizeTimer) clearTimeout(ndResizeTimer);
    ndResizeTimer = setTimeout(function () {
      ndResizeTimer = 0;
      resizeNd();
    }, 160);
  }

  function mapFollowPlaneLatLng() {
    const ac = mapAcState();
    if (
      ac &&
      ac.lat != null &&
      Number.isFinite(ac.lat) &&
      ac.lon != null &&
      Number.isFinite(ac.lon)
    ) {
      return L.latLng(ac.lat, ac.lon);
    }
    return marker ? marker.getLatLng() : null;
  }

  /** 给定缩放级别，使机标落在可见区中心（避开底部 PFD）时的地图中心经纬度 */
  function mapViewCenterForPlaneAtZoom(ll, zoom) {
    const aim = mapFollowAimPointPx();
    const size = map.getSize();
    const z = zoom != null && Number.isFinite(zoom) ? zoom : map.getZoom();
    const centerPx = map.project(ll, z).subtract(aim).add(size.divideBy(2));
    return map.unproject(centerPx, z);
  }

  /** 跟随模式：一次性设置缩放，并保持机标在可见区中心 */
  function setMapFollowView(zoom) {
    const ll = mapFollowPlaneLatLng();
    if (!ll) return false;
    const z =
      zoom != null && Number.isFinite(zoom) ? map._limitZoom(zoom) : map.getZoom();
    const next = mapViewCenterForPlaneAtZoom(ll, z);
    if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return false;
    map.setView(next, z, { animate: false });
    return true;
  }

  /** 跟随模式下缩放/布局变化后，把机标重新对准可见区中心 */
  function refollowMapCenter() {
    if (!followPlane) return;
    setMapFollowView(null);
  }

  /** 地图以飞机为中心：机标对准可见区域几何中心（避开底部 PFD 遮挡） */
  function panMapFollowPlane(latLng, forceSnap) {
    const ll =
      latLng instanceof L.LatLng
        ? latLng
        : L.latLng(latLng[0], latLng[1]);
    if (
      ll.lat == null ||
      !Number.isFinite(ll.lat) ||
      ll.lng == null ||
      !Number.isFinite(ll.lng)
    ) {
      return;
    }
    if (forceSnap) {
      if (followPlane && setMapFollowView(null)) return;
      const next = mapViewCenterForPlaneAtZoom(ll, map.getZoom());
      if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return;
      map.setView(next, map.getZoom(), { animate: false });
      return;
    }
    const aim = mapFollowAimPointPx();
    const next = mapViewCenterForPlaneAtZoom(ll, map.getZoom());
    if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return;
    const pt = map.latLngToContainerPoint(ll);
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    const dx = aim.x - pt.x;
    const dy = aim.y - pt.y;
    if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4) {
      map.panTo(next, { animate: false, noMoveStart: true });
    }
  }

  function patchMapHandlerAroundPlane(handler, afterOrig) {
    if (!handler) return;
    const names = ["_onWheelScroll", "_onTouchMove", "_onDoubleClick"];
    for (let i = 0; i < names.length; i++) {
      const key = names[i];
      if (typeof handler[key] !== "function") continue;
      const orig = handler[key].bind(handler);
      handler[key] = function (e) {
        if (!followPlane || !mapFollowPlaneLatLng()) return orig(e);
        const zoomBefore = map.getZoom();
        orig(e);
        if (afterOrig) afterOrig(e, zoomBefore);
        else refollowMapCenter();
      };
    }
  }

  /** 跟随开启时：滚轮/捏合/双击缩放均以飞机为锚点并保持居中 */
  function installMapFollowZoomHandlers() {
    const swz = map.scrollWheelZoom;
    if (swz && typeof swz._onWheelScroll === "function") {
      const origWheel = swz._onWheelScroll.bind(swz);
      swz._onWheelScroll = function (e) {
        if (!followPlane) return origWheel(e);
        const ll = mapFollowPlaneLatLng();
        if (!ll) return origWheel(e);
        const delta = L.DomEvent.getWheelDelta(e);
        const zoom = map.getZoom();
        const newZoom = map._limitZoom(zoom - delta);
        if (newZoom === zoom) return;
        if (!setMapFollowView(newZoom)) return origWheel(e);
        L.DomEvent.preventDefault(e);
      };
    }
    patchMapHandlerAroundPlane(map.touchZoom, function () {
      setMapFollowView(map.getZoom());
    });
    patchMapHandlerAroundPlane(map.doubleClickZoom, function (_e, zoomBefore) {
      const z = map.getZoom();
      if (z !== zoomBefore) setMapFollowView(z);
      else refollowMapCenter();
    });
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

  const trafficIcon = L.divIcon({
    className: "traffic-marker",
    html:
      '<div class="traffic-hdg" style="width:12px;height:18px;transform-origin:6px 12px;will-change:transform">' +
      '<div style="position:absolute;left:50%;bottom:1px;width:0;height:0;margin-left:-6px;' +
      "border-left:6px solid transparent;border-right:6px solid transparent;" +
      'border-bottom:15px solid #ff9f0a;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))"></div></div>',
    iconSize: [12, 18],
    iconAnchor: [6, 12],
    tooltipAnchor: [0, 0]
  });

  let marker = null;
  let trailLayer = null;
  let trafficLayer = L.layerGroup().addTo(map);
  let trafficTracksLayer = L.layerGroup().addTo(map);
  const trafficTrackHistory = Object.create(null);
  const TRAFFIC_TRACK_MAX_POINTS = 56;
  const TRAFFIC_TRACK_MIN_NM = 0.035;
  const TRAFFIC_PROJ_AHEAD_MIN = 12;
  let tcasSuppressLayer = L.layerGroup().addTo(map);
  let tcasSuppressOverlayKey = null;
  let trafficMarkers = Object.create(null);
  let trafficHdgById = Object.create(null);
  let trafficPinnedId = null;
  let lastTrafficList = [];
  const trafficStabilizeState = Object.create(null);
  let trafficLastScanToken = null;
  /** 连续 2 次交通扫描命中才显示，过滤 SimConnect 单帧脏数据 */
  const TRAFFIC_CLIENT_CONFIRM = 2;
  const TRAFFIC_CLIENT_MISS_GRACE = 2;
  const TRAFFIC_CLIENT_SKIP_SELF_NM = 80 / 1852;
  const TRAFFIC_CLIENT_MAX_JUMP_NM = 1.6;
  let lastCollisionThreats = [];
  let collisionThreatById = Object.create(null);
  let tcasAudioCtx = null;
  let tcasAudioReady = false;
  let tcasSoundTimer = null;
  let tcasActiveSoundLevel = null;
  let tcasSoundStopTimer = null;
  let tcasAlertHoldUntil = 0;
  let tcasAlertHoldSnapshot = [];
  const TCAS_ALERT_HOLD_MS = 2600;
  const TCAS_SOUND_STOP_DELAY_MS = 400;

  /** TCAS 风格冲突阈值（示意，非认证 TCAS） */
  const TCAS_RA_H_NM = 2.0;
  const TCAS_RA_V_FT = 800;
  const TCAS_RA_H_NM_CLOSE = 1.2;
  const TCAS_RA_V_FT_CLOSE = 500;
  const TCAS_RA_TCPA_MIN = 1.8;
  const TCAS_RA_CPA_NM = 0.55;
  const TCAS_TA_H_NM = 5.0;
  const TCAS_TA_V_FT = 1200;
  const TCAS_SCAN_H_NM = 12.0;
  const TCAS_SCAN_V_FT = 2500;
  /** 近场机场区（场面图等） */
  const AIRPORT_ZONE_NM = 5.4;
  const AIRPORT_ZONE_MAX_AGL_FT = 3500;
  const AIRPORT_ZONE_MAX_GS_KT = 250;
  /** 终端区：防撞/TCAS 全关（仅在本机位于地图红区多边形内，12000 ft 以下） */
  const TCAS_SUPPRESS_MAX_AGL_FT = 12000;
  let tcasSuppressHoldUntil = 0;
  const TCAS_SUPPRESS_HOLD_MS = 4000;
  /** 仅停机/滑行：地速与相对地形高度均须满足，避免进近/飞越误标粉色 */
  const TRAFFIC_GROUND_MAX_GS_KT = 38;
  const TRAFFIC_GROUND_MAX_AGL_FT = 120;
  const TRAFFIC_GROUND_PARKED_GS_KT = 14;
  const TRAFFIC_ALT_HIGH_FT = 3000;
  const TRAFFIC_ALT_ABOVE_FT = 800;
  const TRAFFIC_ALT_BELOW_FT = -800;
  const TRAFFIC_ALT_LOW_FT = -3000;
  const TRAFFIC_ALT_CLASS_NAMES = [
    "traffic-alt-high",
    "traffic-alt-above",
    "traffic-alt-level",
    "traffic-alt-below",
    "traffic-alt-low",
    "traffic-alt-unknown"
  ];
  const USER_GROUND_MAX_AGL_FT = 1800;
  const USER_GROUND_MAX_GS_KT = 55;
  let followPlane = true;
  /** 地图/ND 周围交通机标与 ND 雷达符号 */
  let showTraffic = true;
  /** 碰撞横幅、TCAS 音与交通标高亮威胁色 */
  let showCollisionAlerts = true;
  const NAV_CN_URL = "/nav_cn_compact.json";
  const NAV_CN_STORAGE_KEY = "msfs_nav_cn_layer_v1";
  const NAV_CN_TYPES_KEY = "msfs_nav_cn_types_v1";
  const NAV_CHART_OPACITY = 0.48;
  const NAV_CHART_COLORS = {
    airway: {
      line: "#38bdf8",
      halo: "rgba(255,255,255,0.28)",
      label: "#0284c7",
      labelBg: "rgba(255,255,255,0.72)",
      labelBorder: "rgba(56,189,248,0.65)"
    },
    fir: {
      line: "#f472b6",
      halo: "rgba(244,114,182,0.22)"
    },
    fix: {
      fill: "#f59e0b",
      stroke: "#b45309",
      text: "#92400e"
    },
    fixDark: {
      fill: "#fbbf24",
      stroke: "#d97706",
      text: "#fde68a"
    },
    vor: {
      stroke: "#e879f9",
      fill: "rgba(255,255,255,0.5)",
      symFill: "rgba(255,255,255,0.42)",
      text: "#86198f",
      boxBg: "rgba(255,255,255,0.48)",
      boxBorder: "rgba(192,38,211,0.5)",
      subText: "#475569"
    },
    ndb: {
      stroke: "#a78bfa",
      fill: "rgba(255,255,255,0.5)",
      symFill: "rgba(255,255,255,0.42)",
      text: "#5b21b6",
      boxBg: "rgba(255,255,255,0.45)",
      boxBorder: "rgba(124,58,237,0.45)",
      subText: "#475569"
    },
    ndbDark: {
      stroke: "#ede9fe",
      fill: "rgba(255,255,255,0.58)",
      symFill: "rgba(255,255,255,0.56)",
      text: "#4c1d95",
      boxBg: "rgba(255,255,255,0.72)",
      boxBorder: "rgba(196,181,253,0.95)",
      subText: "#64748b"
    },
    vorDark: {
      stroke: "#f5d0fe",
      fill: "rgba(255,255,255,0.58)",
      symFill: "rgba(255,255,255,0.56)",
      text: "#86198f",
      boxBg: "rgba(255,255,255,0.72)",
      boxBorder: "rgba(244,114,182,0.9)",
      subText: "#64748b"
    },
    apt: { text: "#1d4ed8" }
  };

  function isNavChartDarkBase() {
    return currentBaseId === "chart_dark";
  }

  function navChartNavaidColorSet(isNdb) {
    if (!isNavChartDarkBase()) {
      return isNdb ? NAV_CHART_COLORS.ndb : NAV_CHART_COLORS.vor;
    }
    return isNdb ? NAV_CHART_COLORS.ndbDark : NAV_CHART_COLORS.vorDark;
  }

  function navChartFixColorSet() {
    return isNavChartDarkBase()
      ? NAV_CHART_COLORS.fixDark
      : NAV_CHART_COLORS.fix;
  }
  let navCnEnabled = true;
  let navCnShow = { fir: true, airway: true, fix: true, navaid: true, airport: true };
  let navCnData = null;
  let navCnLayer = L.layerGroup();
  let navCnRefreshTimer = 0;
  let navCnLastRefreshKey = "";
  const navIconCache = new Map();
  const NAV_ICON_CACHE_MAX = 480;

  function navChartPerfTier() {
    const h = document.documentElement;
    if (h.classList.contains("mobile-adapt") && !h.classList.contains("tablet-adapt")) {
      return "phone";
    }
    if (h.classList.contains("tablet-adapt")) return "tablet";
    return "desktop";
  }

  function navCnRefreshDelayMs() {
    const t = navChartPerfTier();
    if (t === "phone") return 300;
    if (t === "tablet") return 140;
    return 80;
  }

  function navCnMaxSegments() {
    const t = navChartPerfTier();
    if (t === "phone") return 900;
    if (t === "tablet") return 1800;
    return 3200;
  }

  function navIconCacheClear() {
    navIconCache.clear();
    navCnLastRefreshKey = "";
  }

  function navIconCacheGet(key, factory) {
    let hit = navIconCache.get(key);
    if (hit) return hit;
    hit = factory();
    if (navIconCache.size >= NAV_ICON_CACHE_MAX) {
      const k0 = navIconCache.keys().next().value;
      if (k0 != null) navIconCache.delete(k0);
    }
    navIconCache.set(key, hit);
    return hit;
  }

  function navCnComputeRefreshKey() {
    const b = map.getBounds();
    const z = map.getZoom();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    function q(v) {
      return Math.round(v * 100) / 100;
    }
    return (
      z +
      "|" +
      q(sw.lat) +
      "," +
      q(sw.lng) +
      "|" +
      q(ne.lat) +
      "," +
      q(ne.lng) +
      "|" +
      (navCnEnabled ? 1 : 0) +
      "|" +
      currentBaseId +
      "|" +
      JSON.stringify(navCnShow)
    );
  }
  if (map.createPane) {
    map.createPane("navCnPaneFir");
    map.createPane("navCnPane");
    map.createPane("navCnPaneAwyLbl");
    map.createPane("navCnPaneFix");
    map.createPane("navCnPaneNav");
    const navPaneFir = map.getPane("navCnPaneFir");
    const navPane = map.getPane("navCnPane");
    const navAwyLbl = map.getPane("navCnPaneAwyLbl");
    const navPaneFix = map.getPane("navCnPaneFix");
    const navPaneNav = map.getPane("navCnPaneNav");
    if (navPaneFir) {
      navPaneFir.style.zIndex = "408";
      navPaneFir.style.opacity = String(NAV_CHART_OPACITY);
      navPaneFir.style.pointerEvents = "none";
    }
    if (navPane) {
      navPane.style.zIndex = "410";
      navPane.style.opacity = String(NAV_CHART_OPACITY);
    }
    if (navAwyLbl) {
      navAwyLbl.style.zIndex = "411";
      navAwyLbl.style.opacity = String(NAV_CHART_OPACITY);
      navAwyLbl.style.pointerEvents = "none";
    }
    if (navPaneFix) {
      navPaneFix.style.zIndex = "412";
      navPaneFix.style.opacity = "1";
    }
    if (navPaneNav) {
      navPaneNav.style.zIndex = "413";
      navPaneNav.style.opacity = "1";
    }
  }
  navCnLayer.addTo(map);
  try {
    const savedNav = localStorage.getItem(NAV_CN_STORAGE_KEY);
    if (savedNav === "0") navCnEnabled = false;
    const savedTypes = localStorage.getItem(NAV_CN_TYPES_KEY);
    if (savedTypes) {
      const parsed = JSON.parse(savedTypes);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.fir === "boolean") navCnShow.fir = parsed.fir;
        if (typeof parsed.airway === "boolean") navCnShow.airway = parsed.airway;
        if (typeof parsed.fix === "boolean") navCnShow.fix = parsed.fix;
        if (typeof parsed.navaid === "boolean") navCnShow.navaid = parsed.navaid;
        if (typeof parsed.airport === "boolean") navCnShow.airport = parsed.airport;
      }
    }
  } catch (eNavStore) {}

  function saveNavCnTypePrefs() {
    try {
      localStorage.setItem(NAV_CN_TYPES_KEY, JSON.stringify(navCnShow));
    } catch (eNavType) {}
  }

  function syncNavCnLayersUi() {
    const box = document.getElementById("navCnLayers");
    const disabled = !navCnEnabled;
    if (box) box.classList.toggle("is-disabled", disabled);
    const ids = [
      ["chkNavFir", "fir"],
      ["chkNavAwy", "airway"],
      ["chkNavFix", "fix"],
      ["chkNavNav", "navaid"],
      ["chkNavApt", "airport"]
    ];
    for (let i = 0; i < ids.length; i++) {
      const el = document.getElementById(ids[i][0]);
      if (!el) continue;
      el.checked = navCnShow[ids[i][1]];
      el.disabled = disabled;
    }
  }

  function scheduleNavCnRefresh(force) {
    if (navCnRefreshTimer) clearTimeout(navCnRefreshTimer);
    navCnRefreshTimer = window.setTimeout(function () {
      navCnRefreshTimer = 0;
      if (!navCnEnabled || !navCnData) {
        navCnLayer.clearLayers();
        navCnLastRefreshKey = "";
        return;
      }
      const key = navCnComputeRefreshKey();
      if (!force && key === navCnLastRefreshKey) return;
      navCnLastRefreshKey = key;
      const run = function () {
        refreshNavCnOnMap();
      };
      if (navChartPerfTier() === "phone" && typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 480 });
      } else {
        run();
      }
    }, navCnRefreshDelayMs());
  }

  const NAV_CHART_MAX_SEGMENTS = 3200;

  function navChartSegments(data) {
    if (data.segments && data.segments.length) return data.segments;
    if (!data.routes) return [];
    const out = [];
    for (let r = 0; r < data.routes.length; r++) {
      const route = data.routes[r];
      const pts = route[2];
      if (!pts || pts.length < 2) continue;
      for (let i = 1; i < pts.length; i++) {
        out.push([
          route[0],
          route[1] || "?",
          pts[i - 1][0],
          pts[i - 1][1],
          pts[i][0],
          pts[i][1]
        ]);
      }
    }
    return out;
  }

  let navChartOpenPopup = null;

  function bindNavChartDetail(marker, html, kind) {
    marker.bindPopup(html, {
      closeButton: false,
      autoPan: false,
      offset: L.point(0, 0),
      className: "nav-chart-pop nav-chart-pop--" + kind
    });
    marker.on("click", function (ev) {
      if (ev) L.DomEvent.stopPropagation(ev);
      if (navChartOpenPopup && navChartOpenPopup !== marker) {
        navChartOpenPopup.closePopup();
      }
      marker.openPopup();
      navChartOpenPopup = marker;
    });
  }

  /** 航路点：倒三角底尖 = 经纬度（iconAnchor 在三角框底边中点） */
  function navChartWpIcon(ident, styleKey, showLabel) {
    const c = navChartFixColorSet();
    const symW = 12;
    const symH = 10;
    const tipY = 9;
    const labelHtml = showLabel
      ? '<span class="nav-chart-wp-id" style="color:' +
        c.text +
        '">' +
        escapeHtml(ident) +
        "</span>"
      : "";
    const dark = isNavChartDarkBase() ? 1 : 0;
    const cacheKey = "wp|" + styleKey + "|" + (showLabel ? 1 : 0) + "|" + dark + "|" + ident;
    return navIconCacheGet(cacheKey, function () {
      return L.divIcon({
        className: "nav-chart-wp nav-chart-wp--" + styleKey,
        html:
          '<div class="nav-chart-wp-pin">' +
          '<svg class="nav-chart-wp-tri" viewBox="0 0 12 10" aria-hidden="true">' +
          '<polygon points="6,' +
          tipY +
          " 1,1 11,1\" fill=\"" +
          c.fill +
          '" stroke="' +
          c.stroke +
          '" stroke-width="1" stroke-linejoin="miter"/></svg>' +
          labelHtml +
          "</div>",
        iconSize: [symW, symH],
        iconAnchor: [symW / 2, symH],
        popupAnchor: [0, -symH - 6]
      });
    });
  }

  /** 0=仅符号 1=代号 2=代号+频率 3=完整(含地名) */
  function navChartLabelModeForZoom(z) {
    if (z < 9) return 0;
    if (z < 11) return 1;
    if (z < 13) return 2;
    return 3;
  }

  function navChartDeclutterMinPx(z) {
    if (z >= 13) return 38;
    if (z >= 11) return 46;
    return 54;
  }

  /** 密集区：优先 VOR，过近的台站只画符号；返回与 navaids 下标对应的 labelMode */
  function navChartDeclutterModes(navaidRows, z, inViewFn) {
    const base = navChartLabelModeForZoom(z);
    const modes = new Array(navaidRows.length);
    for (let i = 0; i < modes.length; i++) modes[i] = 0;
    if (base === 0) return modes;

    const minPx = navChartDeclutterMinPx(z);
    const minPx2 = minPx * minPx;
    const slots = [];
    const order = [];
    for (let i = 0; i < navaidRows.length; i++) {
      const n = navaidRows[i];
      const lat = n[1];
      const lon = n[2];
      if (!inViewFn(lat, lon)) continue;
      const typ = n[3] || "NAV";
      const isVor =
        String(typ).indexOf("VOR") >= 0 || String(typ).indexOf("TAC") >= 0;
      const isNdb = !isVor;
      if (isNdb && z < 9) continue;
      if (isVor && z < 7) continue;
      order.push({
        idx: i,
        pri: isVor ? 2 : 1,
        ident: n[0],
        pt: map.latLngToContainerPoint(L.latLng(lat, wrapLng180(lon)))
      });
    }
    order.sort(function (a, b) {
      if (b.pri !== a.pri) return b.pri - a.pri;
      return String(a.ident).localeCompare(String(b.ident));
    });

    for (let oi = 0; oi < order.length; oi++) {
      const item = order[oi];
      let ok = true;
      for (let s = 0; s < slots.length; s++) {
        const dx = item.pt.x - slots[s].x;
        const dy = item.pt.y - slots[s].y;
        if (dx * dx + dy * dy < minPx2) {
          ok = false;
          break;
        }
      }
      if (ok) {
        slots.push(item.pt);
        modes[item.idx] = base;
      }
    }
    return modes;
  }

  /** 手机/平板：跳过屏幕去重（大量 latLngToContainerPoint），按缩放封顶标签等级 */
  function navChartLabelModesForRefresh(navaidRows, z, inViewFn) {
    const tier = navChartPerfTier();
    if (tier === "desktop") {
      return navChartDeclutterModes(navaidRows, z, inViewFn);
    }
    const base = navChartLabelModeForZoom(z);
    const cap = tier === "phone" && z < 11 ? Math.min(base, 1) : base;
    const modes = new Array(navaidRows.length);
    for (let i = 0; i < modes.length; i++) {
      modes[i] = 0;
      const n = navaidRows[i];
      if (!inViewFn(n[1], n[2])) continue;
      if (cap > 0) modes[i] = cap;
    }
    return modes;
  }

  /** 导航台：方菱形中心 = 经纬度；标签按 labelMode 分级显示 */
  function navChartVorIcon(ident, freqMhz, name, isNdb, labelMode) {
    const c = navChartNavaidColorSet(isNdb);
    const symFill = c.symFill || c.fill;
    const symStrokeW = isNavChartDarkBase() ? 1.55 : 1.35;
    const freq =
      freqMhz != null && Number.isFinite(freqMhz)
        ? Number(freqMhz).toFixed(freqMhz % 1 === 0 ? 1 : 2)
        : "";
    const sub = name && name !== ident ? escapeHtml(name) : "";
    const symW = 22;
    const symH = 22;
    const ax = symW / 2;
    const ay = symH / 2;
    const mode = labelMode || 0;
    let boxHtml = "";
    if (mode >= 1) {
      boxHtml =
        '<div class="nav-chart-vor-box nav-chart-vor-box--m' +
        mode +
        '" style="background:' +
        c.boxBg +
        ";border-color:" +
        c.boxBorder +
        ";color:" +
        c.text +
        '"><b>' +
        escapeHtml(ident) +
        "</b>";
      if (mode >= 2 && freq) boxHtml += "<i>" + freq + "</i>";
      if (mode >= 3 && sub)
        boxHtml += '<small style="color:' + c.subText + '">' + sub + "</small>";
      boxHtml += "</div>";
    }
    const dark = isNavChartDarkBase() ? 1 : 0;
    const cacheKey =
      "vor|" +
      (isNdb ? "n" : "v") +
      "|" +
      mode +
      "|" +
      dark +
      "|" +
      ident +
      "|" +
      freq +
      "|" +
      (mode >= 3 ? sub : "");
    return navIconCacheGet(cacheKey, function () {
      return L.divIcon({
        className:
          "nav-chart-vor nav-chart-vor--" +
          (isNdb ? "ndb" : "vor") +
          (mode ? " nav-chart-vor--lbl" : " nav-chart-vor--sym"),
        html:
          '<div class="nav-chart-vor-pin">' +
          '<div class="nav-chart-vor-sym" aria-hidden="true">' +
          '<svg viewBox="0 0 28 28"><rect x="4" y="4" width="20" height="20" fill="' +
          symFill +
          '" stroke="' +
          c.stroke +
          '" stroke-width="' +
          symStrokeW +
          '"/>' +
          '<polygon points="14,7 22,14 14,21 6,14" fill="none" stroke="' +
          c.stroke +
          '" stroke-width="' +
          (symStrokeW - 0.1) +
          '"/></svg></div>' +
          boxHtml +
          "</div>",
        iconSize: [symW, symH],
        iconAnchor: [ax, ay],
        popupAnchor: [0, -ay - 8]
      });
    });
  }

  function navChartSegmentMidLatLng(la, lo, lb, lob) {
    return L.latLng((la + lb) * 0.5, wrapLng180((lo + lob) * 0.5));
  }

  /** 航段在屏幕上的方位角（度），用于标签沿航线方向 */
  function navChartSegmentBearingDeg(la, lo, lb, lob) {
    const p1 = map.latLngToContainerPoint(L.latLng(la, wrapLng180(lo)));
    const p2 = map.latLngToContainerPoint(L.latLng(lb, wrapLng180(lob)));
    let deg = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
    if (deg > 90) deg -= 180;
    if (deg < -90) deg += 180;
    return deg;
  }

  function navChartAwyLabel(aw, distNm, bearingDeg) {
    const c = NAV_CHART_COLORS.airway;
    const dist =
      distNm != null && Number.isFinite(distNm)
        ? '<em>' + String(Math.round(distNm)) + "</em>"
        : "";
    const rot =
      bearingDeg != null && Number.isFinite(bearingDeg)
        ? "transform:translate(-50%,-50%) rotate(" +
          bearingDeg.toFixed(1) +
          "deg);"
        : "transform:translate(-50%,-50%);";
    const br = bearingDeg != null && Number.isFinite(bearingDeg) ? bearingDeg.toFixed(0) : "";
    const cacheKey = "awy|" + aw + "|" + (distNm != null ? distNm : "") + "|" + br;
    return navIconCacheGet(cacheKey, function () {
      return L.divIcon({
        className: "nav-chart-awy",
        html:
          '<div class="nav-chart-awy-pin">' +
          '<span class="nav-chart-awy-box" style="color:' +
          c.label +
          ";background:" +
          c.labelBg +
          ";border-color:" +
          c.labelBorder +
          ";" +
          rot +
          '">' +
          escapeHtml(aw) +
          dist +
          "</span></div>",
        iconSize: [1, 1],
        iconAnchor: [0, 0]
      });
    });
  }

  function navChartAptIcon(ident) {
    return navIconCacheGet("apt|" + ident, function () {
      return L.divIcon({
        className: "nav-chart-apt",
        html: '<span class="nav-chart-apt-id">' + escapeHtml(ident) + "</span>",
        iconSize: [48, 14],
        iconAnchor: [0, 7]
      });
    });
  }

  function firRingInView(ring, bounds) {
    for (let i = 0; i < ring.length; i++) {
      if (bounds.contains([ring[i][0], wrapLng180(ring[i][1])])) return true;
    }
    return false;
  }

  function refreshNavCnOnMap() {
    navCnLayer.clearLayers();
    if (!navCnEnabled || !navCnData) return;
    const z = map.getZoom();
    if (z < 5) return;

    const tier = navChartPerfTier();
    const maxSeg = navCnMaxSegments();
    const useLineHalo = tier === "desktop";
    const bounds = map.getBounds();
    function inView(lat, lon) {
      return bounds.contains([lat, wrapLng180(lon)]);
    }

    if (navCnShow.fir && z >= 5 && navCnData.firs && navCnData.firs.length) {
      const firC = NAV_CHART_COLORS.fir;
      const firLw = z >= 8 ? 1.8 : 1.4;
      const firLbl = tier === "desktop" && z >= 7;
      for (let fi = 0; fi < navCnData.firs.length; fi++) {
        const fir = navCnData.firs[fi];
        const rings = fir[2];
        if (!rings || !rings.length) continue;
        for (let ri = 0; ri < rings.length; ri++) {
          const ring = rings[ri];
          if (!ring || ring.length < 2 || !firRingInView(ring, bounds)) continue;
          const latlngs = [];
          for (let pi = 0; pi < ring.length; pi++) {
            latlngs.push([ring[pi][0], wrapLng180(ring[pi][1])]);
          }
          if (useLineHalo) {
            navCnLayer.addLayer(
              L.polyline(latlngs, {
                pane: "navCnPaneFir",
                color: firC.halo,
                weight: firLw + 1.2,
                opacity: 0.55,
                interactive: false
              })
            );
          }
          navCnLayer.addLayer(
            L.polyline(latlngs, {
              pane: "navCnPaneFir",
              color: useLineHalo ? firC.line : firC.halo,
              weight: firLw,
              opacity: useLineHalo ? 0.62 : 0.58,
              dashArray: "9 7",
              interactive: false
            })
          );
        }
        if (firLbl && rings[0] && rings[0].length) {
          let sx = 0;
          let sy = 0;
          let n = 0;
          for (let pi = 0; pi < rings[0].length; pi++) {
            const p = rings[0][pi];
            if (!inView(p[0], p[1])) continue;
            sx += p[0];
            sy += p[1];
            n++;
          }
          if (n > 0) {
            const label = fir[1] || fir[0];
            navCnLayer.addLayer(
              L.marker([sx / n, wrapLng180(sy / n)], {
                pane: "navCnPaneFir",
                interactive: false,
                icon: L.divIcon({
                  className: "nav-chart-fir-lbl",
                  html: "<span>" + escapeHtml(label) + "</span>",
                  iconSize: [1, 1],
                  iconAnchor: [0, 0]
                })
              })
            );
          }
        }
      }
    }

    const awC = NAV_CHART_COLORS.airway;
    const segments = navChartSegments(navCnData);
    if (navCnShow.airway && z >= 6 && segments.length) {
      let drawn = 0;
      const showAwyLbl =
        tier === "phone" ? z >= 11 : tier === "tablet" ? z >= 10 : z >= 9;
      const showDist =
        tier === "phone" ? z >= 12 : tier === "tablet" ? z >= 11 : z >= 11;
      const maxAwyLbl = tier === "phone" ? 100 : tier === "tablet" ? 220 : 999999;
      const lw = z >= 10 ? 2.4 : 1.8;
      const hw = lw + 1.4;
      const awyLabelQueue = [];
      for (let s = 0; s < segments.length && drawn < maxSeg; s++) {
        const seg = segments[s];
        const la = seg[2];
        const lo = seg[3];
        const lb = seg[4];
        const lob = seg[5];
        if (!inView(la, lo) && !inView(lb, lob)) continue;
        const latlngs = [
          [la, wrapLng180(lo)],
          [lb, wrapLng180(lob)]
        ];
        if (useLineHalo) {
          navCnLayer.addLayer(
            L.polyline(latlngs, {
              pane: "navCnPane",
              color: awC.halo,
              weight: hw,
              opacity: 0.85,
              interactive: false
            })
          );
        }
        navCnLayer.addLayer(
          L.polyline(latlngs, {
            pane: "navCnPane",
            color: awC.line,
            weight: lw,
            opacity: 0.9,
            interactive: false
          })
        );
        if (showAwyLbl && seg[0] && awyLabelQueue.length < maxAwyLbl) {
          awyLabelQueue.push({
            mid: navChartSegmentMidLatLng(la, lo, lb, lob),
            aw: seg[0],
            dist: showDist && seg.length > 6 ? seg[6] : null,
            bearing:
              tier === "phone"
                ? null
                : navChartSegmentBearingDeg(la, lo, lb, lob)
          });
        }
        drawn++;
      }
      for (let li = 0; li < awyLabelQueue.length; li++) {
        const item = awyLabelQueue[li];
        navCnLayer.addLayer(
          L.marker(item.mid, {
            pane: "navCnPaneAwyLbl",
            interactive: false,
            icon: navChartAwyLabel(item.aw, item.dist, item.bearing),
            zIndexOffset: 1000 + li
          })
        );
      }
    }

    if (navCnShow.fix && z >= 7 && navCnData.fixes) {
      const allWp = z >= 9;
      const fixSkip = tier === "phone" ? 4 : tier === "tablet" ? 3 : 3;
      for (let f = 0; f < navCnData.fixes.length; f++) {
        const fx = navCnData.fixes[f];
        const lat = fx[1];
        const lon = fx[2];
        if (!inView(lat, lon)) continue;
        if (!allWp && f % fixSkip !== 0) continue;
        const ident = fx[0];
        const m = L.marker([lat, wrapLng180(lon)], {
          pane: "navCnPaneFix",
          interactive: true,
          icon: navChartWpIcon(ident, "fix", allWp)
        });
        const tip = ident + (fx[3] ? "<br>" + escapeHtml(fx[3]) : "");
        bindNavChartDetail(m, tip, "wp");
        navCnLayer.addLayer(m);
      }
    }

    if (navCnShow.navaid && z >= 7 && navCnData.navaids) {
      const navLblModes = navChartLabelModesForRefresh(
        navCnData.navaids,
        z,
        inView
      );
      const navMax =
        tier === "phone" ? 110 : tier === "tablet" ? 200 : 999999;
      let navDrawn = 0;
      for (let i = 0; i < navCnData.navaids.length; i++) {
        const n = navCnData.navaids[i];
        const lat = n[1];
        const lon = n[2];
        if (!inView(lat, lon)) continue;
        if (navDrawn >= navMax) break;
        const ident = n[0];
        const typ = n[3] || "NAV";
        const freq = n[4];
        const name = n[5] || ident;
        const isVor =
          String(typ).indexOf("VOR") >= 0 || String(typ).indexOf("TAC") >= 0;
        const lblMode = navLblModes[i] || 0;
        if (isVor && z >= 7) {
          const m = L.marker([lat, wrapLng180(lon)], {
            pane: "navCnPaneNav",
            interactive: true,
            icon: navChartVorIcon(ident, freq, name, false, lblMode),
            zIndexOffset: 200 + (lblMode > 0 ? 20 : 0)
          });
          let tip = ident + " · " + typ;
          if (freq != null) tip += " " + freq + " MHz";
          if (name && name !== ident) tip += "<br>" + escapeHtml(name);
          bindNavChartDetail(m, tip, "vor");
          navCnLayer.addLayer(m);
          navDrawn++;
        } else if (z >= 8) {
          const m = L.marker([lat, wrapLng180(lon)], {
            pane: "navCnPaneNav",
            interactive: true,
            icon: navChartVorIcon(ident, freq, name, true, lblMode),
            zIndexOffset: 180 + (lblMode > 0 ? 15 : 0)
          });
          bindNavChartDetail(m, ident + " · " + typ, "ndb");
          navCnLayer.addLayer(m);
          navDrawn++;
        }
      }
    }

    if (navCnShow.airport && z >= 8 && navCnData.airports) {
      const aptMax = tier === "phone" ? 70 : tier === "tablet" ? 120 : 999999;
      let aptDrawn = 0;
      for (let a = 0; a < navCnData.airports.length; a++) {
        if (aptDrawn >= aptMax) break;
        const ap = navCnData.airports[a];
        const lat = ap[1];
        const lon = ap[2];
        if (!inView(lat, lon)) continue;
        const m = L.marker([lat, wrapLng180(lon)], {
          pane: "navCnPane",
          interactive: true,
          icon: navChartAptIcon(ap[0]),
          zIndexOffset: 150
        });
        const tip = ap[0] + (ap[3] ? "<br>" + escapeHtml(ap[3]) : "");
        bindNavChartDetail(m, tip, "apt");
        navCnLayer.addLayer(m);
        aptDrawn++;
      }
    }
  }

  function loadNavCnData() {
    fetch(NAV_CN_URL, { cache: "default" })
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(function (data) {
        if (!data || typeof data !== "object") return;
        navCnData = data;
        navIconCacheClear();
        whenPfdScaleReady(function () {
          scheduleNavCnRefresh(true);
        });
      })
      .catch(function () {
        navCnData = null;
      });
  }

  map.on("zoomend moveend", scheduleNavCnRefresh);
  map.on("click", function () {
    if (navChartOpenPopup) {
      navChartOpenPopup.closePopup();
      navChartOpenPopup = null;
    }
  });
  loadNavCnData();

  const chkNavCn = document.getElementById("chkNavCn");
  if (chkNavCn) {
    chkNavCn.checked = navCnEnabled;
    chkNavCn.addEventListener("change", function () {
      navCnEnabled = !!chkNavCn.checked;
      try {
        localStorage.setItem(NAV_CN_STORAGE_KEY, navCnEnabled ? "1" : "0");
      } catch (eNavChk) {}
      syncNavCnLayersUi();
      scheduleNavCnRefresh(true);
    });
  }
  const navTypeChk = [
    ["chkNavFir", "fir"],
    ["chkNavAwy", "airway"],
    ["chkNavFix", "fix"],
    ["chkNavNav", "navaid"],
    ["chkNavApt", "airport"]
  ];
  for (let ti = 0; ti < navTypeChk.length; ti++) {
    const el = document.getElementById(navTypeChk[ti][0]);
    const key = navTypeChk[ti][1];
    if (!el) continue;
    el.addEventListener("change", function () {
      navCnShow[key] = !!el.checked;
      saveNavCnTypePrefs();
      scheduleNavCnRefresh(true);
    });
  }
  syncNavCnLayersUi();

  let planGroup = L.layerGroup().addTo(map);
  let planLine = null;
  let planWaypoints = [];
  let planTitle = "";
  let planPlnXml = "";
  let nextWpSeq = 0;
  /** 距当前目标航路点小于此值（海里）视为到达；略加大以符合「飞到附近即算」 */
  const PASS_NM = 2.8;
  /** 沿计划航线累积距离已超过该点此后（海里）亦视为飞过，避免侧偏时永远卡在同一航点 */
  const PASS_ALONG_NM = 0.32;
  let lastTelemetry = null;
  /** 高频 SSE 时限制 ND/航迹等重绘；地图机位仅随遥测包更新，不做平滑外推 */
  let lastPayloadUiT = 0;
  let lastPayloadTrailT = 0;
  let lastPayloadTrailLen = -1;
  const PAYLOAD_UI_MIN_MS = 90;
  const PAYLOAD_TRAIL_MIN_MS = 220;
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
  let dispTrkShow = null;
  let tgtGroundElevFt = null,
    dispGroundElevFt = null,
    tgtRadioHeightFt = null,
    dispRadioHeightFt = null,
    tgtAglGameFt = null,
    dispAglGameFt = null,
    tgtAglBaroFt = null,
    dispAglBaroFt = null;
  let smoothReady = false;
  /** 空速/高度：与上游一致，仅向最新遥测缓跟，不做包间积分预判 */
  const SMOOTH_TAU_MAIN_MS = 245;
  const SMOOTH_K_MAIN_CAP = 0.34;
  let tapeDispReady = false;
  /** PFD 上下滚动：空速/高度带 + 俯仰平移，rAF 指数缓跟（数据源仍为 SimConnect 包） */
  const PFD_VERT_TAU_MS = 130;
  const PFD_VERT_K_CAP = 0.42;
  let pfdVertReady = false;
  let lastPfdVertT = 0;
  /** 遥测包仅作观测；积分外推 + 残差分帧消化（包到达不瞬时硬拉） */
  const MOTION_MAX_STEP_MS = 100;
  const OBS_VEL_BLEND = 0.52;
  const OBS_AUX_BLEND = 0.22;
  const OBS_VS_BLEND = 0.34;
  const OBS_TRACK_BLEND = 0.12;
  const TRK_SHOW_TAU_MS = 380;
  const TRK_MOTION_BLEND = 0.16;
  const TRK_GS_USE_HDG_KT = 8;
  /** 修正尽量无感：包上只入库部分误差，帧间慢消化 + 单帧步长上限 */
  const CORRECT_PKT_KEEP = 0.16;
  const CORRECT_RESID_MERGE = 0.68;
  /** 位置残差消化：遥测已提至 ~60Hz，地图/ND 可更贴机 */
  const RESID_TAU_POS_S = 0.08;
  const RESID_TAU_HDG_S = 0.1;
  const RESID_TAU_SCALAR_S = 0.14;
  const RESID_STEP_MAX_LAT = 4e-6;
  const RESID_STEP_MAX_LON = 4e-6;
  const RESID_STEP_MAX_ALT_FT = 1.2;
  const RESID_STEP_MAX_HDG_DEG = 0.22;
  const RESID_STEP_MAX_IAS_KT = 0.08;
  const RESID_STEP_MAX_GS_KT = 0.08;
  const RESID_STEP_MAX_VS_FPM = 2.5;
  const RESID_STEP_MAX_PITCH_DEG = 0.32;
  const RESID_STEP_MAX_BANK_DEG = 0.38;
  const OBS_PKT_DT_MIN_MS = 16;
  const OBS_PKT_DT_MAX_MS = 8000;
  /** 换机位/传送：位置突变则硬重置运动状态，避免积分把仪表甩飞 */
  const MOTION_RESET_JUMP_NM = 1.8;
  let motion = null;
  let motionResidual = null;
  let lastObs = null;
  let lastSmoothT = 0;

  function queueCorrection(prev, fresh, keep, merge) {
    if (!Number.isFinite(fresh)) return prev;
    if (prev == null || !Number.isFinite(prev)) return fresh * keep;
    return prev * merge + fresh * keep;
  }

  function bleedResidualStep(residual, k, maxStep) {
    let step = residual * k;
    if (
      maxStep != null &&
      Number.isFinite(maxStep) &&
      Number.isFinite(step) &&
      Math.abs(step) > maxStep
    ) {
      step = step > 0 ? maxStep : -maxStep;
    }
    return { step: step, left: residual - step };
  }

  function deltaAngleDeg(from, to) {
    if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to)) return 0;
    let d = to - from;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  function telemetryToAnchor(data) {
    const hdg = data.heading_deg != null && Number.isFinite(data.heading_deg) ? data.heading_deg : 0;
    const track =
      data.ground_track_deg != null && Number.isFinite(data.ground_track_deg)
        ? data.ground_track_deg
        : null;
    return {
      lat: data.lat,
      lon: wrapLng180(data.lon),
      pitch: data.pitch_deg != null ? data.pitch_deg : 0,
      bank: data.bank_deg != null ? data.bank_deg : 0,
      ias: data.ias_knots,
      alt: data.alt_ft,
      hdg: hdg,
      gs: data.groundspeed_knots,
      vs: data.vertical_speed_fpm,
      track: track,
      groundElevFt: data.ground_elev_ft,
      radioHeightFt: data.radio_height_ft,
      aglGameFt: data.agl_game_ft,
      aglBaroFt: data.agl_baro_ft
    };
  }

  function syncTgtFromAnchor(a) {
    tgtLat = a.lat;
    tgtLon = a.lon;
    tgtPitch = a.pitch;
    tgtBank = a.bank;
    tgtIas = a.ias;
    tgtAlt = a.alt;
    tgtHdg = a.hdg;
    tgtGs = a.gs;
    tgtVs = a.vs;
    tgtTrack = a.track;
    tgtGroundElevFt = a.groundElevFt;
    tgtRadioHeightFt = a.radioHeightFt;
    tgtAglGameFt = a.aglGameFt;
    tgtAglBaroFt = a.aglBaroFt;
  }

  function motionCourseDeg(m) {
    const gs = m.gs != null && Number.isFinite(m.gs) ? m.gs : 0;
    if (gs < TRK_GS_USE_HDG_KT) return m.hdg;
    return m.track != null && Number.isFinite(m.track) ? m.track : m.hdg;
  }

  function stepDispTrkShow(obs, dtMs) {
    if (obs == null || !Number.isFinite(obs)) return;
    if (dispTrkShow == null || !Number.isFinite(dispTrkShow)) {
      dispTrkShow = normHdg(obs);
      return;
    }
    const k = Math.min(0.22, 1 - Math.exp(-dtMs / TRK_SHOW_TAU_MS));
    dispTrkShow = normHdg(dispTrkShow + deltaAngleDeg(dispTrkShow, obs) * k);
  }

  function trkObsFromAnchor(z, gsKt) {
    if (gsKt != null && Number.isFinite(gsKt) && gsKt < TRK_GS_USE_HDG_KT) {
      return z.hdg != null && Number.isFinite(z.hdg) ? z.hdg : null;
    }
    if (z.track != null && Number.isFinite(z.track)) return z.track;
    if (z.hdg != null && Number.isFinite(z.hdg)) return z.hdg;
    return null;
  }

  function motionFromObservation(z) {
    const track =
      z.track != null && Number.isFinite(z.track) ? z.track : z.hdg;
    return {
      lat: z.lat,
      lon: z.lon,
      pitch: z.pitch,
      bank: z.bank,
      ias: z.ias,
      alt: z.alt,
      hdg: z.hdg,
      gs: z.gs,
      vs: z.vs,
      track: track,
      groundElevFt: z.groundElevFt,
      radioHeightFt: z.radioHeightFt,
      aglGameFt: z.aglGameFt,
      aglBaroFt: z.aglBaroFt,
      hdgDps: 0,
      pitchDps: 0,
      bankDps: 0,
      iasKtPerS: 0,
      gsKtPerS: 0
    };
  }

  function applyMotionToDisp(m) {
    dispLat = m.lat;
    dispLon = m.lon;
    dispIas = m.ias;
    dispAlt = m.alt;
    dispHdg = m.hdg;
    dispGs = m.gs;
    dispVs = m.vs;
    dispTrack = m.track;
    dispGroundElevFt = m.groundElevFt;
    dispRadioHeightFt = m.radioHeightFt;
    dispAglGameFt = m.aglGameFt;
    dispAglBaroFt = m.aglBaroFt;
  }

  function measureVelocitiesFromObs(a, b, dtMs) {
    const dtS = dtMs / 1000;
    const dtMin = dtMs / 60000;
    const out = {
      hdgDps: deltaAngleDeg(a.hdg, b.hdg) / dtS,
      pitchDps: ((b.pitch || 0) - (a.pitch || 0)) / dtS,
      bankDps: deltaAngleDeg(a.bank, b.bank) / dtS,
      iasKtPerS: 0,
      gsKtPerS: 0,
      vsFpm: null,
      track: null
    };
    if (
      a.ias != null &&
      b.ias != null &&
      Number.isFinite(a.ias) &&
      Number.isFinite(b.ias)
    ) {
      out.iasKtPerS = (b.ias - a.ias) / dtS;
    }
    if (a.gs != null && b.gs != null && Number.isFinite(a.gs) && Number.isFinite(b.gs)) {
      out.gsKtPerS = (b.gs - a.gs) / dtS;
    }
    if (
      a.alt != null &&
      b.alt != null &&
      Number.isFinite(a.alt) &&
      Number.isFinite(b.alt) &&
      dtMin > 0
    ) {
      out.vsFpm = (b.alt - a.alt) / dtMin;
    } else if (b.vs != null && Number.isFinite(b.vs)) {
      out.vsFpm = b.vs;
    }
    const latMid = (a.lat + b.lat) * 0.5;
    const northNmPerMin = ((b.lat - a.lat) * 60) / dtMin;
    let dLon = b.lon - a.lon;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    const eastNmPerMin = (dLon * 60 * Math.cos((latMid * Math.PI) / 180)) / dtMin;
    const gsFromPos = Math.hypot(northNmPerMin, eastNmPerMin) * 60;
    if (b.track != null && Number.isFinite(b.track)) {
      out.track = normHdg(b.track);
    } else if (gsFromPos > 2) {
      out.track = normHdg((Math.atan2(eastNmPerMin, northNmPerMin) * 180) / Math.PI);
      if (
        (out.gsKtPerS === 0 || !Number.isFinite(out.gsKtPerS)) &&
        a.gs != null &&
        Number.isFinite(a.gs)
      ) {
        out.gsKtPerS = (gsFromPos - a.gs) / dtS;
      }
    } else if (b.hdg != null && Number.isFinite(b.hdg)) {
      out.track = normHdg(b.hdg);
    }
    return out;
  }

  function blendMotionVelocities(m, v, k) {
    m.hdgDps += (v.hdgDps - m.hdgDps) * k;
    if (v.pitchDps != null && Number.isFinite(v.pitchDps)) {
      m.pitchDps += (v.pitchDps - m.pitchDps) * k;
    }
    if (v.bankDps != null && Number.isFinite(v.bankDps)) {
      m.bankDps += (v.bankDps - m.bankDps) * k;
    }
    m.iasKtPerS += (v.iasKtPerS - m.iasKtPerS) * k;
    m.gsKtPerS += (v.gsKtPerS - m.gsKtPerS) * k;
    if (v.vsFpm != null && Number.isFinite(v.vsFpm)) {
      if (m.vs != null && Number.isFinite(m.vs)) {
        m.vs += (v.vsFpm - m.vs) * OBS_VS_BLEND;
      } else {
        m.vs = v.vsFpm;
      }
    }
    if (v.track != null && Number.isFinite(v.track)) {
      if (m.track == null || !Number.isFinite(m.track)) {
        m.track = v.track;
      } else {
        m.track = normHdg(m.track + deltaAngleDeg(m.track, v.track) * OBS_TRACK_BLEND);
      }
    }
  }

  function blendMotionAuxFromObs(m, z, k) {
    function blendScalar(disp, obs) {
      if (obs == null || !Number.isFinite(obs)) return disp;
      if (disp == null || !Number.isFinite(disp)) return obs;
      return disp + (obs - disp) * k;
    }
    m.groundElevFt = blendScalar(m.groundElevFt, z.groundElevFt);
    m.radioHeightFt = blendScalar(m.radioHeightFt, z.radioHeightFt);
    m.aglGameFt = blendScalar(m.aglGameFt, z.aglGameFt);
    m.aglBaroFt = blendScalar(m.aglBaroFt, z.aglBaroFt);
  }

  function emptyMotionResidual() {
    return {
      lat: 0,
      dLon: 0,
      alt: 0,
      hdg: 0,
      pitch: 0,
      bank: 0,
      ias: 0,
      gs: 0,
      vs: 0,
      dTrack: 0,
      hasTrack: false
    };
  }

  /** 记录观测与积分状态的差值，由每帧 bleed 平滑消化（避免包到达时抽一下） */
  function setMotionResidualFromObs(m, z) {
    if (!motionResidual) motionResidual = emptyMotionResidual();
    const r = motionResidual;
    const freshLat = z.lat - m.lat;
    let dLon = z.lon - m.lon;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    r.lat = queueCorrection(r.lat, freshLat, CORRECT_PKT_KEEP, CORRECT_RESID_MERGE);
    r.dLon = queueCorrection(r.dLon, dLon, CORRECT_PKT_KEEP, CORRECT_RESID_MERGE);
    const freshAlt =
      z.alt != null &&
      m.alt != null &&
      Number.isFinite(z.alt) &&
      Number.isFinite(m.alt)
        ? z.alt - m.alt
        : 0;
    r.alt = queueCorrection(r.alt, freshAlt, CORRECT_PKT_KEEP, CORRECT_RESID_MERGE);
    r.hdg = queueCorrection(
      r.hdg,
      deltaAngleDeg(m.hdg, z.hdg),
      CORRECT_PKT_KEEP,
      CORRECT_RESID_MERGE
    );
    r.pitch = queueCorrection(
      r.pitch,
      (z.pitch != null && Number.isFinite(z.pitch) ? z.pitch : 0) -
        (m.pitch != null && Number.isFinite(m.pitch) ? m.pitch : 0),
      CORRECT_PKT_KEEP,
      CORRECT_RESID_MERGE
    );
    r.bank = queueCorrection(
      r.bank,
      deltaAngleDeg(m.bank, z.bank),
      CORRECT_PKT_KEEP,
      CORRECT_RESID_MERGE
    );
    const freshIas =
      z.ias != null &&
      m.ias != null &&
      Number.isFinite(z.ias) &&
      Number.isFinite(m.ias)
        ? z.ias - m.ias
        : 0;
    r.ias = queueCorrection(r.ias, freshIas, CORRECT_PKT_KEEP, CORRECT_RESID_MERGE);
    const freshGs =
      z.gs != null && m.gs != null && Number.isFinite(z.gs) && Number.isFinite(m.gs)
        ? z.gs - m.gs
        : 0;
    r.gs = queueCorrection(r.gs, freshGs, CORRECT_PKT_KEEP, CORRECT_RESID_MERGE);
    const freshVs =
      z.vs != null && m.vs != null && Number.isFinite(z.vs) && Number.isFinite(m.vs)
        ? z.vs - m.vs
        : 0;
    r.vs = queueCorrection(r.vs, freshVs, CORRECT_PKT_KEEP, CORRECT_RESID_MERGE);
    if (z.track != null && Number.isFinite(z.track)) {
      r.hasTrack = true;
      const freshTr =
        m.track != null && Number.isFinite(m.track)
          ? deltaAngleDeg(m.track, z.track)
          : 0;
      r.dTrack = queueCorrection(r.dTrack, freshTr, CORRECT_PKT_KEEP, CORRECT_RESID_MERGE);
    } else {
      r.hasTrack = false;
      r.dTrack = queueCorrection(r.dTrack, 0, CORRECT_PKT_KEEP, CORRECT_RESID_MERGE);
    }
  }

  function bleedMotionResidual(m, dtS) {
    if (!motionResidual || dtS <= 0) return;
    const r = motionResidual;
    const kPos = 1 - Math.exp(-dtS / RESID_TAU_POS_S);
    const kHdg = 1 - Math.exp(-dtS / RESID_TAU_HDG_S);
    const kSc = 1 - Math.exp(-dtS / RESID_TAU_SCALAR_S);

    const bl = bleedResidualStep(r.lat, kPos, RESID_STEP_MAX_LAT);
    m.lat += bl.step;
    r.lat = bl.left;
    const blo = bleedResidualStep(r.dLon, kPos, RESID_STEP_MAX_LON);
    m.lon = wrapLng180(m.lon + blo.step);
    r.dLon = blo.left;

    if (m.alt != null && Number.isFinite(m.alt)) {
      const ba = bleedResidualStep(r.alt, kPos, RESID_STEP_MAX_ALT_FT);
      m.alt += ba.step;
      r.alt = ba.left;
    }

    const bh = bleedResidualStep(r.hdg, kHdg, RESID_STEP_MAX_HDG_DEG);
    m.hdg = normHdg(m.hdg + bh.step);
    r.hdg = bh.left;

    if (m.pitch != null && Number.isFinite(m.pitch)) {
      const bp = bleedResidualStep(r.pitch, kSc, RESID_STEP_MAX_PITCH_DEG);
      m.pitch += bp.step;
      r.pitch = bp.left;
    }
    if (m.bank != null && Number.isFinite(m.bank)) {
      const bb = bleedResidualStep(r.bank, kSc, RESID_STEP_MAX_BANK_DEG);
      m.bank += bb.step;
      r.bank = bb.left;
    }

    if (m.ias != null && Number.isFinite(m.ias)) {
      const bi = bleedResidualStep(r.ias, kSc, RESID_STEP_MAX_IAS_KT);
      m.ias += bi.step;
      r.ias = bi.left;
    }
    if (m.gs != null && Number.isFinite(m.gs)) {
      const bg = bleedResidualStep(r.gs, kSc, RESID_STEP_MAX_GS_KT);
      m.gs += bg.step;
      r.gs = bg.left;
    }
    if (m.vs != null && Number.isFinite(m.vs)) {
      const bv = bleedResidualStep(r.vs, kSc, RESID_STEP_MAX_VS_FPM);
      m.vs += bv.step;
      r.vs = bv.left;
    }
    if (r.hasTrack && m.track != null && Number.isFinite(m.track)) {
      const bt = bleedResidualStep(r.dTrack, kHdg, RESID_STEP_MAX_HDG_DEG);
      m.track = normHdg(m.track + bt.step);
      r.dTrack = bt.left;
    }
  }

  function integrateMotionStep(m, dtS) {
    if (dtS <= 0) return;
    const cours = motionCourseDeg(m);
    const gs0 = m.gs != null && Number.isFinite(m.gs) ? m.gs : 0;
    const gsUse = gs0 + m.gsKtPerS * dtS;
    m.gs = gsUse;
    const vel = velEnuNmPerMin(gsUse, cours);
    const northNm = vel.north * (dtS / 60);
    const eastNm = vel.east * (dtS / 60);
    const cosLat = Math.cos((m.lat * Math.PI) / 180);
    m.lat += northNm / 60;
    m.lon = wrapLng180(m.lon + (Math.abs(cosLat) > 1e-6 ? eastNm / (60 * cosLat) : 0));
    if (m.alt != null && Number.isFinite(m.alt) && m.vs != null && Number.isFinite(m.vs)) {
      m.alt += (m.vs / 60) * dtS;
    }
    if (m.ias != null && Number.isFinite(m.ias)) {
      m.ias += m.iasKtPerS * dtS;
    }
    m.hdg = normHdg(m.hdg + m.hdgDps * dtS);
    if (m.pitch != null && Number.isFinite(m.pitch) && Number.isFinite(m.pitchDps)) {
      m.pitch += m.pitchDps * dtS;
    }
    if (m.bank != null && Number.isFinite(m.bank) && Number.isFinite(m.bankDps)) {
      m.bank += m.bankDps * dtS;
    }
  }

  function resetMotion() {
    motion = null;
    motionResidual = null;
    lastObs = null;
    dispTrkShow = null;
  }

  function observationNeedsMotionReset(prevZ, z) {
    if (!prevZ || !z) return false;
    return haversineNm(prevZ.lat, prevZ.lon, z.lat, z.lon) > MOTION_RESET_JUMP_NM;
  }

  function hardResetMotionFromObs(z, tNow) {
    motion = motionFromObservation(z);
    motionResidual = emptyMotionResidual();
    motion.pitchDps = 0;
    motion.bankDps = 0;
    motion.hdgDps = 0;
    motion.iasKtPerS = 0;
    motion.gsKtPerS = 0;
    applyMotionToDisp(motion);
    dispPitch = motion.pitch;
    dispBank = motion.bank;
    const trk0 = trkObsFromAnchor(z, z.gs);
    dispTrkShow = trk0 != null ? normHdg(trk0) : null;
    dispIas = z.ias;
    dispAlt = z.alt;
    tapeDispReady = true;
    smoothReady = true;
    lastObs = { t: tNow, z: z };
  }

  function ingestMotionObservation(data, tNow) {
    const z = telemetryToAnchor(data);
    syncTgtFromAnchor(z);

    if (!motion) {
      hardResetMotionFromObs(z, tNow);
      return;
    }

    const dtMs = tNow - lastObs.t;
    if (observationNeedsMotionReset(lastObs.z, z)) {
      hardResetMotionFromObs(z, tNow);
      return;
    }

    if (dtMs >= OBS_PKT_DT_MIN_MS && dtMs <= OBS_PKT_DT_MAX_MS) {
      blendMotionVelocities(motion, measureVelocitiesFromObs(lastObs.z, z, dtMs), OBS_VEL_BLEND);
    } else {
      motion.pitch = z.pitch;
      motion.bank = z.bank;
      motion.pitchDps = 0;
      motion.bankDps = 0;
      if (z.vs != null && Number.isFinite(z.vs)) {
        if (motion.vs != null && Number.isFinite(motion.vs)) {
          motion.vs += (z.vs - motion.vs) * OBS_VS_BLEND;
        } else {
          motion.vs = z.vs;
        }
      }
    }
    blendMotionAuxFromObs(motion, z, OBS_AUX_BLEND);
    const trkObs = trkObsFromAnchor(z, z.gs);
    if (trkObs != null) {
      if (motion.track == null || !Number.isFinite(motion.track)) {
        motion.track = trkObs;
      } else {
        motion.track = normHdg(
          motion.track + deltaAngleDeg(motion.track, trkObs) * TRK_MOTION_BLEND
        );
      }
    }
    setMotionResidualFromObs(motion, z);
    lastObs = { t: tNow, z: z };
  }

  function tickSmooth(now) {
    requestAnimationFrame(tickSmooth);
    const t = typeof now === "number" ? now : performance.now();

    if (!lastTelemetry || !lastTelemetry.ok || !motion) {
      lastSmoothT = 0;
      tapeDispReady = false;
      return;
    }

    const dtMs =
      lastSmoothT <= 0 ? 1000 / 60 : Math.min(MOTION_MAX_STEP_MS, Math.max(0, t - lastSmoothT));
    lastSmoothT = t;
    const dtS = dtMs / 1000;
    integrateMotionStep(motion, dtS);
    bleedMotionResidual(motion, dtS);
    applyMotionToDisp(motion);
    dispPitch = motion.pitch;
    dispBank = motion.bank;
    const trkUiObs =
      tgtTrack != null && Number.isFinite(tgtTrack)
        ? tgtTrack
        : lastTelemetry && lastTelemetry.ground_track_deg != null
          ? lastTelemetry.ground_track_deg
          : trkObsFromAnchor(
              {
                track: tgtTrack,
                hdg: dispHdg,
                gs: dispGs != null ? dispGs : tgtGs
              },
              dispGs != null && Number.isFinite(dispGs) ? dispGs : tgtGs
            );
    stepDispTrkShow(trkUiObs, dtMs);
    smoothReady = true;
    const kMain = Math.min(SMOOTH_K_MAIN_CAP, 1 - Math.exp(-dtMs / SMOOTH_TAU_MAIN_MS));
    if (!tapeDispReady) {
      dispIas = tgtIas;
      dispAlt = tgtAlt;
      tapeDispReady = true;
    } else {
      if (tgtIas != null && Number.isFinite(tgtIas)) {
        const d0 = dispIas != null && Number.isFinite(dispIas) ? dispIas : tgtIas;
        dispIas = d0 + (tgtIas - d0) * kMain;
      }
      if (tgtAlt != null && Number.isFinite(tgtAlt)) {
        const d0 = dispAlt != null && Number.isFinite(dispAlt) ? dispAlt : tgtAlt;
        dispAlt = d0 + (tgtAlt - d0) * kMain;
      }
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
      dispHdg,
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
    const navRw = navAcState();
    updateAdiRunwayOverlay(
      lastTelemetry,
      dispPitch,
      dispBank,
      dispAlt,
      navRw ? navRw.hdg : dispHdg,
      navRw ? navRw.lat : dispLat,
      navRw ? navRw.lon : dispLon
    );
    updatePfdNdToolbarStats(lastTelemetry);
    redrawAdiVnavProfile();
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
    const topPad = 22,
      botPad = 4;
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
    const topPad = 22,
      botPad = 4;
    const innerH = 218 - topPad - botPad;
    const cx = innerH / 2;
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

  /** PFD：SimConnect 仪表 SimVar（INDICATED ALTITUDE / HEADING INDICATOR 等，与 G1000/G3000 同源）；Events 仅用于按键 */
  function updatePfdInstruments(data) {
    if (!data || !data.ok) {
      resetPfdVertSmooth();
      updateSpeedTape(null);
      updateAltTape(null);
      updateAttitude(0, 0);
      updateAdiHud(null, null, null, null, null, null, null, null, null);
      updateAdiTerrain(null, null, null, null, null, null, null);
      updateAdiRunwayOverlay(null, 0, 0, null, null);
      updatePfdNdToolbarStats(null);
      redrawAdiVnavProfile();
      return;
    }
    if (!pfdVertReady) {
      snapPfdVertDispFromTargets();
    } else {
      const tpNow =
        data.pitch_deg != null && Number.isFinite(data.pitch_deg) ? data.pitch_deg : 0;
      if (
        (dispAlt != null &&
          tgtAlt != null &&
          Number.isFinite(dispAlt) &&
          Number.isFinite(tgtAlt) &&
          Math.abs(tgtAlt - dispAlt) > 12000) ||
        Math.abs(tpNow - dispPitch) > 50
      ) {
        snapPfdVertDispFromTargets();
      }
    }
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
    updateAdiRunwayOverlay(
      data,
      data.pitch_deg,
      data.bank_deg,
      data.alt_ft,
      data.heading_deg,
      data.lat,
      data.lon
    );
    updatePfdNdToolbarStats(data);
    redrawAdiVnavProfile();
  }

  function resetPfdVertSmooth() {
    pfdVertReady = false;
    lastPfdVertT = 0;
  }

  function snapPfdVertDispFromTargets() {
    dispPitch = tgtPitch != null && Number.isFinite(tgtPitch) ? tgtPitch : 0;
    dispIas = tgtIas;
    dispAlt = tgtAlt;
    pfdVertReady = true;
    lastPfdVertT = 0;
  }

  /** 仅驱动 PFD 垂直向动画：俯仰平移 + 空速/高度带滚动 */
  function tickPfdVerticalSmooth(now) {
    requestAnimationFrame(tickPfdVerticalSmooth);
    if (!lastTelemetry || !lastTelemetry.ok || !pfdVertReady) {
      lastPfdVertT = 0;
      return;
    }
    const t = typeof now === "number" ? now : performance.now();
    const dtMs =
      lastPfdVertT <= 0 ? 1000 / 60 : Math.min(48, Math.max(0, t - lastPfdVertT));
    lastPfdVertT = t;
    const k = Math.min(PFD_VERT_K_CAP, 1 - Math.exp(-dtMs / PFD_VERT_TAU_MS));
    const tp = tgtPitch != null && Number.isFinite(tgtPitch) ? tgtPitch : 0;
    dispPitch = dispPitch + (tp - dispPitch) * k;
    if (tgtIas != null && Number.isFinite(tgtIas)) {
      const d0 = dispIas != null && Number.isFinite(dispIas) ? dispIas : tgtIas;
      dispIas = d0 + (tgtIas - d0) * k;
    }
    if (tgtAlt != null && Number.isFinite(tgtAlt)) {
      const d0 = dispAlt != null && Number.isFinite(dispAlt) ? dispAlt : tgtAlt;
      dispAlt = d0 + (tgtAlt - d0) * k;
    }
    const bankNow = tgtBank != null && Number.isFinite(tgtBank) ? tgtBank : 0;
    updateAttitude(dispPitch, bankNow);
    updateSpeedTape(dispIas);
    updateAltTape(dispAlt);
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
    let html = ok ? title : '<span class="err">' + title + "</span>";
    if (detail && !ok) {
      html +=
        '<div class="planline" style="margin-top:5px;font-size:10px;opacity:0.9">' +
        detail +
        "</div>";
    }
    statusEl.innerHTML = html;
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

  function updateMapAircraftMarker() {
    const mapAc = mapAcState();
    if (!mapAc || !marker) return;
    const mapLon = mapAc.lon;
    marker.setLatLng([mapAc.lat, mapLon]);
    const el = marker.getElement();
    const wrap = el && el.querySelector(".plane-hdg");
    if (wrap) wrap.style.transform = "rotate(" + normHdg(mapAc.hdg) + "deg)";
    const posTip =
      fmtNum(mapAc.lat, 5) +
      "°, " +
      fmtNum(mapLon, 5) +
      "°" +
      (mapAc.alt != null && Number.isFinite(mapAc.alt)
        ? " · " + Math.round(mapAc.alt) + " ft"
        : "");
    const planeTip = marker.getTooltip();
    if (planeTip) {
      marker.setTooltipContent(posTip);
      const off = [-6, -10];
      if (!planeTip.options.offset || planeTip.options.offset[0] !== off[0]) {
        planeTip.options.offset = off;
        planeTip.update();
      }
    } else {
      marker.bindTooltip(posTip, {
        permanent: true,
        direction: "top",
        offset: [-6, -10],
        className: "plane-pos-tip",
        sticky: false
      });
    }
    if (followPlane) panMapFollowPlane(L.latLng(mapAc.lat, mapLon));
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

  function trafficListFingerprint(list) {
    if (!Array.isArray(list) || !list.length) return "";
    const parts = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t || t.id == null) continue;
      const lat = Number(t.lat);
      const lon = Number(t.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      parts.push(String(t.id) + ":" + lat.toFixed(4) + ":" + lon.toFixed(4));
    }
    parts.sort();
    return parts.join("|");
  }

  function trafficIsGhostEntry(ac, userLat, userLon) {
    if (!ac || ac.lat == null || ac.lon == null) return true;
    const lat = Number(ac.lat);
    const lon = Number(ac.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return true;
    if (Math.abs(lat) < 1e-5 && Math.abs(lon) < 1e-5) return true;
    const alt = ac.alt_ft != null ? Number(ac.alt_ft) : null;
    if (Math.abs(lat) < 0.12 && Math.abs(lon) < 0.12) {
      if (alt == null || !Number.isFinite(alt) || Math.abs(alt) < 200) return true;
    }
    if (
      alt != null &&
      Number.isFinite(alt) &&
      Math.abs(lat) < 0.04 &&
      Math.abs(lon) < 0.04 &&
      Math.abs(alt) < 120
    ) {
      return true;
    }
    if (alt != null && Number.isFinite(alt) && (alt < -800 || alt > 65000)) return true;
    if (userLat != null && userLon != null && Number.isFinite(userLat) && Number.isFinite(userLon)) {
      if (haversineNm(userLat, userLon, lat, lon) < TRAFFIC_CLIENT_SKIP_SELF_NM) return true;
    }
    return false;
  }

  function stabilizeTrafficList(rawList, userLat, userLon, scanToken) {
    if (!Array.isArray(rawList)) return [];
    if (!rawList.length) {
      Object.keys(trafficStabilizeState).forEach(function (id) {
        delete trafficStabilizeState[id];
      });
      trafficLastScanToken = null;
      return [];
    }
    const token =
      scanToken != null && scanToken !== ""
        ? String(scanToken)
        : trafficListFingerprint(rawList);
    const scanAdvanced = token !== trafficLastScanToken;
    if (scanAdvanced) trafficLastScanToken = token;

    const seen = Object.create(null);
    const out = [];
    rawList.forEach(function (ac) {
      if (!ac || ac.id == null || ac.lat == null || ac.lon == null) return;
      if (trafficIsGhostEntry(ac, userLat, userLon)) {
        delete trafficStabilizeState[String(ac.id)];
        return;
      }
      const id = String(ac.id);
      seen[id] = true;
      let st = trafficStabilizeState[id];
      if (!st) {
        st = trafficStabilizeState[id] = { hits: 0, miss: 0, lat: ac.lat, lon: ac.lon, ac: ac };
      }
      if (scanAdvanced) {
        const jump = haversineNm(st.lat, st.lon, ac.lat, ac.lon);
        if (st.hits > 0 && jump > TRAFFIC_CLIENT_MAX_JUMP_NM) st.hits = 0;
        st.lat = ac.lat;
        st.lon = ac.lon;
        st.ac = ac;
        st.miss = 0;
        st.hits = Math.min(st.hits + 1, TRAFFIC_CLIENT_CONFIRM + 2);
      } else {
        st.ac = ac;
        st.lat = ac.lat;
        st.lon = ac.lon;
      }
      if (st.hits >= TRAFFIC_CLIENT_CONFIRM) out.push(st.ac);
    });

    if (scanAdvanced) {
      Object.keys(trafficStabilizeState).forEach(function (id) {
        if (seen[id]) return;
        const st = trafficStabilizeState[id];
        st.miss = (st.miss || 0) + 1;
        if (st.miss >= TRAFFIC_CLIENT_MISS_GRACE) delete trafficStabilizeState[id];
      });
    }
    return out;
  }

  let ndGndSnapshot = null;
  let ndGndSnapshotAt = 0;
  let ndGroundHoldUntil = 0;
  const ND_GND_SURF_HOLD_MS = 15000;
  const ND_GROUND_HOLD_MS = 2800;
  const CN_MAINLAND_ICAO2 = "BGHJLMPSUWY";

  function isMainlandChinaIcao(icao) {
    if (!icao || String(icao).length !== 4) return false;
    const c = String(icao).trim().toUpperCase();
    return c.charAt(0) === "Z" && CN_MAINLAND_ICAO2.indexOf(c.charAt(1)) >= 0;
  }

  function gndSurfHasFeatures(gnd) {
    if (!gnd) return false;
    const tw = gnd.taxiways;
    const ap = gnd.aprons;
    return (
      (Array.isArray(tw) && tw.length >= 3) || (Array.isArray(ap) && ap.length >= 1)
    );
  }

  function gndLayerCount(arr) {
    return Array.isArray(arr) ? arr.length : 0;
  }

  /** 遥测场面若缺机坪/停机位，沿用同机场快照中更完整的一层 */
  function mergeNdGndLayers(g, snap) {
    if (!g || !snap || !g.icao || g.icao !== snap.icao) return g;
    const out = Object.assign({}, g);
    if (gndLayerCount(out.taxiways) < gndLayerCount(snap.taxiways)) {
      out.taxiways = snap.taxiways;
    }
    if (gndLayerCount(out.aprons) < gndLayerCount(snap.aprons)) {
      out.aprons = snap.aprons;
    }
    if (gndLayerCount(out.buildings) < gndLayerCount(snap.buildings)) {
      out.buildings = snap.buildings;
    }
    if (gndLayerCount(out.grass) < gndLayerCount(snap.grass)) {
      out.grass = snap.grass;
    }
    if (gndLayerCount(out.stands) < gndLayerCount(snap.stands)) {
      out.stands = snap.stands;
    }
    return out;
  }

  function isUserOnGroundRaw(tel) {
    if (!tel || !tel.ok) return false;
    const agl =
      tel.agl_game_ft != null && Number.isFinite(tel.agl_game_ft)
        ? tel.agl_game_ft
        : tel.agl_baro_ft;
    const gs = tel.groundspeed_knots;
    if (agl != null && agl <= USER_GROUND_MAX_AGL_FT) {
      if (gs == null || !Number.isFinite(gs) || gs <= USER_GROUND_MAX_GS_KT) return true;
    }
    if (gs != null && Number.isFinite(gs) && gs <= 22 && agl != null && agl <= 3500) return true;
    return false;
  }

  function isUserOnGround(tel) {
    const now = performance.now();
    if (isUserOnGroundRaw(tel)) {
      ndGroundHoldUntil = now + ND_GROUND_HOLD_MS;
      return true;
    }
    return now < ndGroundHoldUntil;
  }

  /** 滑行道/机坪短时缺失时沿用上一帧完整场面，避免只显示跑道 */
  function resolveNdAirportGnd(tel) {
    if (!tel || !tel.ok) {
      if (ndGndSnapshot && performance.now() - ndGndSnapshotAt < ND_GND_SURF_HOLD_MS) {
        return ndGndSnapshot;
      }
      return null;
    }
    const g = tel.airport_gnd;
    if (g && g.icao && !isMainlandChinaIcao(g.icao)) return null;
    let resolved = g;
    if (
      g &&
      g.icao &&
      isMainlandChinaIcao(g.icao) &&
      ndGndSnapshot &&
      ndGndSnapshot.icao === g.icao
    ) {
      resolved = mergeNdGndLayers(g, ndGndSnapshot);
    }
    if (resolved && gndSurfHasFeatures(resolved)) {
      ndGndSnapshot = resolved;
      ndGndSnapshotAt = performance.now();
      return resolved;
    }
    if (
      g &&
      g.icao &&
      isMainlandChinaIcao(g.icao) &&
      ndGndSnapshot &&
      ndGndSnapshot.icao === g.icao &&
      gndSurfHasFeatures(ndGndSnapshot)
    ) {
      return mergeNdGndLayers(
        Object.assign({}, g, {
          runways: g.runways || ndGndSnapshot.runways
        }),
        ndGndSnapshot
      );
    }
    if (ndGndSnapshot && performance.now() - ndGndSnapshotAt < ND_GND_SURF_HOLD_MS && isUserOnGroundRaw(tel)) {
      return ndGndSnapshot;
    }
    return g || null;
  }

  function isTrafficOnGround(t, tel) {
    if (!t) return false;
    const gs = t.groundspeed_knots;
    if (gs != null && Number.isFinite(gs)) {
      if (gs >= 55) return false;
      if (gs <= TRAFFIC_GROUND_PARKED_GS_KT) {
        const ge =
          tel && tel.ground_elev_ft != null && Number.isFinite(tel.ground_elev_ft)
            ? tel.ground_elev_ft
            : null;
        const tAlt = t.alt_ft != null && Number.isFinite(t.alt_ft) ? t.alt_ft : null;
        if (ge != null && tAlt != null) {
          const tAgl = tAlt - ge;
          if (tAgl > 280) return false;
          if (tAgl <= TRAFFIC_GROUND_MAX_AGL_FT + 40) return true;
        }
        return true;
      }
    }
    const tAlt = t.alt_ft != null && Number.isFinite(t.alt_ft) ? t.alt_ft : null;
    const ge =
      tel && tel.ground_elev_ft != null && Number.isFinite(tel.ground_elev_ft)
        ? tel.ground_elev_ft
        : null;
    if (ge == null || tAlt == null) return false;
    const tAgl = tAlt - ge;
    if (tAgl > TRAFFIC_GROUND_MAX_AGL_FT || tAgl < -80) return false;
    if (gs != null && Number.isFinite(gs)) {
      if (gs > TRAFFIC_GROUND_MAX_GS_KT) return false;
      return true;
    }
    return tAgl <= 55;
  }

  function trafficRelAltFt(ac, tel) {
    if (!ac || ac.alt_ft == null || !Number.isFinite(ac.alt_ft)) return null;
    if (!tel || tel.alt_ft == null || !Number.isFinite(tel.alt_ft)) return null;
    return ac.alt_ft - tel.alt_ft;
  }

  function trafficAltBand(ac, tel) {
    if (isTrafficOnGround(ac, tel)) return "ground";
    const d = trafficRelAltFt(ac, tel);
    if (d == null) return "unknown";
    if (d >= TRAFFIC_ALT_HIGH_FT) return "high";
    if (d >= TRAFFIC_ALT_ABOVE_FT) return "above";
    if (d > TRAFFIC_ALT_BELOW_FT) return "level";
    if (d > TRAFFIC_ALT_LOW_FT) return "below";
    return "low";
  }

  function trafficAltBandColor(band) {
    switch (band) {
      case "ground":
        return "#ff6eb4";
      case "high":
        return "#5ac8fa";
      case "above":
        return "#34c759";
      case "level":
        return "#ff9f0a";
      case "below":
        return "#ffd60a";
      case "low":
        return "#bf5af2";
      default:
        return "#8b949e";
    }
  }

  function trafficAltBandLabel(band, relFt) {
    if (band === "ground") return "地面";
    if (relFt != null && Number.isFinite(relFt)) {
      const s = (relFt >= 0 ? "+" : "") + Math.round(relFt) + " ft";
      if (band === "high") return "明显高于我 " + s;
      if (band === "above") return "高于我 " + s;
      if (band === "level") return "同高度 " + s;
      if (band === "below") return "低于我 " + s;
      if (band === "low") return "明显低于我 " + s;
    }
    switch (band) {
      case "high":
        return "明显高于我";
      case "above":
        return "高于我";
      case "level":
        return "同高度";
      case "below":
        return "低于我";
      case "low":
        return "明显低于我";
      default:
        return "高度未知";
    }
  }

  function trafficDisplayStyle(ac, tel) {
    if (isTrafficOnGround(ac, tel)) return "ground";
    const id = ac.id != null ? String(ac.id) : null;
    const th = id ? collisionThreatById[id] : null;
    if (th) return th.level;
    return trafficAltBand(ac, tel);
  }

  function applyTrafficMarkerStyle(rootEl, style) {
    if (!rootEl) return;
    rootEl.classList.remove(
      "traffic-threat-ta",
      "traffic-threat-ra",
      "traffic-ground"
    );
    for (let i = 0; i < TRAFFIC_ALT_CLASS_NAMES.length; i++) {
      rootEl.classList.remove(TRAFFIC_ALT_CLASS_NAMES[i]);
    }
    if (style === "ground") rootEl.classList.add("traffic-ground");
    else if (style === "ra" || style === "ta") rootEl.classList.add("traffic-threat-" + style);
    else rootEl.classList.add("traffic-alt-" + style);
  }

  function trafficCanPinTrack(ac, tel) {
    return ac && !isTrafficOnGround(ac, tel || lastTelemetry);
  }

  function trafficTooltipLine(ac, tel) {
    const telUse = tel || lastTelemetry;
    if (isTrafficOnGround(ac, telUse)) return "";
    const band = trafficAltBand(ac, telUse);
    const relFt = trafficRelAltFt(ac, telUse);
    const label = trafficAltBandLabel(band, relFt);
    const th = ac.id != null ? collisionThreatById[String(ac.id)] : null;
    if (th) {
      const tag = th.level === "ra" ? "碰撞警告" : "交通警戒";
      return tag + " · " + fmtNum(th.distNm, 1) + " NM";
    }
    const parts = [label];
    if (ac.alt_ft != null && Number.isFinite(ac.alt_ft)) {
      parts.push(Math.round(ac.alt_ft) + " ft");
    }
    if (ac.groundspeed_knots != null && Number.isFinite(ac.groundspeed_knots)) {
      parts.push(Math.round(ac.groundspeed_knots) + " kt");
    }
    return parts.join(" · ");
  }

  function trafficAcById(list, id) {
    if (!Array.isArray(list)) return null;
    const sid = String(id);
    for (let i = 0; i < list.length; i++) {
      const ac = list[i];
      if (ac && ac.id != null && String(ac.id) === sid) return ac;
    }
    return null;
  }

  function recordTrafficHistoryPoint(ac) {
    if (!ac || ac.id == null || ac.lat == null || ac.lon == null) return;
    if (isTrafficOnGround(ac, lastTelemetry)) return;
    const id = String(ac.id);
    const lat = Number(ac.lat);
    const lon = wrapLng180(Number(ac.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    let hist = trafficTrackHistory[id];
    if (!hist) hist = trafficTrackHistory[id] = [];
    const last = hist[hist.length - 1];
    if (last && haversineNm(last[0], last[1], lat, lon) < TRAFFIC_TRACK_MIN_NM) return;
    hist.push([lat, lon]);
    if (hist.length > TRAFFIC_TRACK_MAX_POINTS) hist.shift();
  }

  function dropTrafficHistory(id) {
    delete trafficTrackHistory[String(id)];
  }

  function trafficTrackStrokeColor(ac) {
    if (!ac) return "#8b949e";
    return trafficAltBandColor(trafficDisplayStyle(ac, lastTelemetry)) || "#8b949e";
  }

  function buildTrafficProjectionLatLngs(ac, aheadMin) {
    if (!ac || ac.lat == null || ac.lon == null) return [];
    const lat0 = Number(ac.lat);
    const lon0 = wrapLng180(Number(ac.lon));
    const gs = ac.groundspeed_knots;
    const hdg = ac.heading_deg;
    if (
      !Number.isFinite(lat0) ||
      !Number.isFinite(lon0) ||
      gs == null ||
      !Number.isFinite(gs) ||
      gs < 15 ||
      hdg == null ||
      !Number.isFinite(hdg)
    ) {
      return [[lat0, lon0]];
    }
    const totalNm = gs * (aheadMin / 60);
    if (totalNm < 0.4) return [[lat0, lon0]];
    const out = [[lat0, lon0]];
    let lat = lat0;
    let lon = lon0;
    const stepNm = Math.min(3, Math.max(1, totalNm / 8));
    let left = totalNm;
    while (left > stepNm * 0.35) {
      const step = Math.min(stepNm, left);
      const p = pointAtNm(lat, lon, normHdg(hdg), step);
      out.push([p.lat, wrapLng180(p.lon)]);
      lat = p.lat;
      lon = p.lon;
      left -= step;
    }
    return out;
  }

  function unwrapTrackForMap(pts) {
    if (!pts || pts.length < 2) return pts;
    let fixed = unwrapLatLngsForPolyline(pts);
    if (lastTelemetry && lastTelemetry.ok) {
      fixed = shiftLngStripToRef(fixed, lastTelemetry.lon);
    }
    return fixed;
  }

  function redrawPinnedTrafficTrack() {
    trafficTracksLayer.clearLayers();
    if (!showTraffic || !trafficPinnedId) return;
    const ac = trafficAcById(lastTrafficList, trafficPinnedId);
    if (!ac || !trafficCanPinTrack(ac, lastTelemetry)) {
      if (ac && !trafficCanPinTrack(ac, lastTelemetry)) trafficPinnedId = null;
      return;
    }
    const color = trafficTrackStrokeColor(ac);
    const pane = map.getPane && map.getPane("trafficTrackPane") ? "trafficTrackPane" : undefined;
    const hist = trafficTrackHistory[trafficPinnedId];
    if (hist && hist.length >= 2) {
      L.polyline(unwrapTrackForMap(hist), {
        pane: pane,
        color: color,
        weight: 3,
        opacity: 0.85,
        lineJoin: "round"
      }).addTo(trafficTracksLayer);
    }
    const proj = buildTrafficProjectionLatLngs(ac, TRAFFIC_PROJ_AHEAD_MIN);
    if (proj.length >= 2) {
      const projPts = unwrapTrackForMap(proj);
      L.polyline(projPts, {
        pane: pane,
        color: color,
        weight: 2,
        opacity: 0.48,
        dashArray: "7 9",
        lineJoin: "round"
      }).addTo(trafficTracksLayer);
      const end = projPts[projPts.length - 1];
      L.circleMarker(end, {
        pane: pane,
        radius: 4,
        color: color,
        fillColor: color,
        fillOpacity: 0.75,
        weight: 1,
        opacity: 0.9
      }).addTo(trafficTracksLayer);
    }
  }

  function bindTrafficMarkerClick(m, id) {
    if (!m || m._mfTrafficClickBound) return;
    m._mfTrafficClickBound = true;
    m.on("click", function (ev) {
      L.DomEvent.stopPropagation(ev);
      const sid = String(id);
      const ac = trafficAcById(lastTrafficList, sid);
      if (!trafficCanPinTrack(ac, lastTelemetry)) return;
      trafficPinnedId = trafficPinnedId === sid ? null : sid;
      refreshTrafficTooltips();
      redrawPinnedTrafficTrack();
    });
  }

  function trafficTooltipOffsetPx(hdgIn) {
    const hdg = normalizeTrafficHeadingDeg(hdgIn);
    const h = ((hdg != null ? hdg : 0) * Math.PI) / 180;
    const left = 5;
    const aftR = 4;
    const lift = 15;
    return [-Math.sin(h) * aftR - left, Math.cos(h) * aftR - lift];
  }

  function syncTrafficTooltipPosition(m, ac) {
    if (!m) return;
    const tip = m.getTooltip && m.getTooltip();
    if (!tip) return;
    const off = trafficTooltipOffsetPx(ac && ac.heading_deg);
    const prev = tip.options.offset || [0, 0];
    if (prev[0] === off[0] && prev[1] === off[1]) return;
    tip.options.offset = off;
    if (m.isTooltipOpen && m.isTooltipOpen()) tip.update();
  }

  function ensureTrafficTooltip(m, id, ac) {
    if (!m || !ac) return;
    const sid = String(id);
    const canPin = trafficCanPinTrack(ac, lastTelemetry);
    const pinned = canPin && trafficPinnedId === sid;
    const text = trafficTooltipLine(ac, lastTelemetry);
    if (!text) {
      if (m.getTooltip()) m.unbindTooltip();
      m._mfTooltipPinned = false;
      return;
    }
    const needRebind = m._mfTooltipPinned !== pinned || !m.getTooltip();
    if (needRebind) {
      if (m.getTooltip()) m.unbindTooltip();
      m.bindTooltip(text, {
        direction: "top",
        offset: trafficTooltipOffsetPx(ac.heading_deg),
        opacity: 0.92,
        className: "traffic-tip" + (pinned ? " traffic-tip--pinned" : ""),
        permanent: pinned,
        sticky: false,
        interactive: pinned
      });
      m._mfTooltipPinned = pinned;
    } else {
      m.setTooltipContent(text);
      syncTrafficTooltipPosition(m, ac);
    }
    if (pinned) {
      if (!m.isTooltipOpen()) m.openTooltip();
    } else if (m.isTooltipOpen()) {
      m.closeTooltip();
    }
  }

  function refreshTrafficTooltips() {
    Object.keys(trafficMarkers).forEach(function (id) {
      const ac = trafficAcById(lastTrafficList, id);
      if (ac) ensureTrafficTooltip(trafficMarkers[id], id, ac);
    });
  }

  function clearTrafficMarkers() {
    Object.keys(trafficMarkers).forEach(function (id) {
      trafficLayer.removeLayer(trafficMarkers[id]);
      delete trafficMarkers[id];
      delete trafficHdgById[id];
    });
    trafficPinnedId = null;
    trafficTracksLayer.clearLayers();
    Object.keys(trafficTrackHistory).forEach(function (id) {
      dropTrafficHistory(id);
    });
  }

  function refreshTrafficMarkerStyles() {
    Object.keys(trafficMarkers).forEach(function (id) {
      const m = trafficMarkers[id];
      const ac = trafficAcById(lastTrafficList, id);
      if (!m || !ac) return;
      const rootEl = m.getElement();
      applyTrafficMarkerStyle(rootEl, trafficDisplayStyle(ac, lastTelemetry));
    });
  }

  function updateTraffic(list) {
    if (!Array.isArray(list)) {
      lastTrafficList = [];
      if (!showTraffic) clearTrafficMarkers();
      return;
    }
    lastTrafficList = list;
    if (!showTraffic) {
      clearTrafficMarkers();
      return;
    }
    const seen = Object.create(null);
    list.forEach(function (ac) {
      if (!ac || ac.id == null || ac.lat == null || ac.lon == null) return;
      const id = String(ac.id);
      seen[id] = true;
      recordTrafficHistoryPoint(ac);
      const ll = [ac.lat, wrapLng180(ac.lon)];
      let m = trafficMarkers[id];
      if (!m) {
        m = L.marker(ll, { icon: trafficIcon, zIndexOffset: -100 });
        trafficLayer.addLayer(m);
        trafficMarkers[id] = m;
        bindTrafficMarkerClick(m, id);
      } else {
        m.setLatLng(ll);
      }
      const el = m.getElement();
      const wrap = el && el.querySelector(".traffic-hdg");
      if (wrap && ac.heading_deg != null && Number.isFinite(ac.heading_deg)) {
        applyTrafficMarkerHeading(wrap, id, ac.heading_deg);
      }
      syncTrafficTooltipPosition(m, ac);
      const rootEl = m.getElement();
      applyTrafficMarkerStyle(rootEl, trafficDisplayStyle(ac, lastTelemetry));
      ensureTrafficTooltip(m, id, ac);
    });
    Object.keys(trafficMarkers).forEach(function (id) {
      if (!seen[id]) {
        if (trafficPinnedId === id) trafficPinnedId = null;
        trafficLayer.removeLayer(trafficMarkers[id]);
        delete trafficMarkers[id];
        delete trafficHdgById[id];
        dropTrafficHistory(id);
      }
    });
    redrawPinnedTrafficTrack();
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

  function velEnuNmPerMin(gsKnots, hdgDeg) {
    const gs = gsKnots != null && Number.isFinite(gsKnots) ? Math.max(0, gsKnots) : 0;
    const h = (normHdg(hdgDeg != null && Number.isFinite(hdgDeg) ? hdgDeg : 0) * Math.PI) / 180;
    const speed = gs / 60;
    return { north: speed * Math.cos(h), east: speed * Math.sin(h) };
  }

  function enuDeltaNm(refLat, refLon, lat, lon) {
    const north = (lat - refLat) * 60;
    let dLon = lon - refLon;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    const east = dLon * 60 * Math.cos((refLat * Math.PI) / 180);
    return { north: north, east: east };
  }

  function estimateTcpaCpaMin(acLat, acLon, acGs, acHdg, tLat, tLon, tGs, tHdg) {
    const pos = enuDeltaNm(acLat, acLon, tLat, tLon);
    const vSelf = velEnuNmPerMin(acGs, acHdg);
    const vT = velEnuNmPerMin(tGs, tHdg);
    const vRelN = vT.north - vSelf.north;
    const vRelE = vT.east - vSelf.east;
    const vRelSq = vRelN * vRelN + vRelE * vRelE;
    if (vRelSq < 1e-10) return { tcpaMin: null, cpaNm: null };
    const rDotV = pos.north * vRelN + pos.east * vRelE;
    const tcpaMin = -rDotV / vRelSq;
    if (tcpaMin < 0 || tcpaMin > 30) return { tcpaMin: null, cpaNm: null };
    const cN = pos.north + vRelN * tcpaMin;
    const cE = pos.east + vRelE * tcpaMin;
    return { tcpaMin: tcpaMin, cpaNm: Math.hypot(cN, cE) };
  }

  function fmtRelBearingDeg(relDeg) {
    let r = relDeg;
    while (r > 180) r -= 360;
    while (r < -180) r += 360;
    const side = r < -12 ? "左" : r > 12 ? "右" : "正前";
    return side + " " + Math.abs(Math.round(r)) + "°";
  }

  function runwayListMinDistM(tel) {
    if (!tel) return null;
    const rwList =
      tel.runways && tel.runways.length
        ? tel.runways
        : tel.runway
          ? [tel.runway]
          : [];
    let minM = null;
    for (let i = 0; i < rwList.length; i++) {
      const d = rwList[i] && rwList[i].dist_m;
      if (d != null && Number.isFinite(d)) {
        minM = minM == null ? d : Math.min(minM, d);
      }
    }
    return minM;
  }

  function isAirportZone(tel) {
    if (!tel || !tel.ok) return false;
    if (tel.airport_zone === true) return true;
    if (tel.airport_zone === false) return false;
    const minM = runwayListMinDistM(tel);
    if (minM == null || minM > AIRPORT_ZONE_NM * 1852) return false;
    const agl =
      tel.agl_game_ft != null && Number.isFinite(tel.agl_game_ft)
        ? tel.agl_game_ft
        : tel.agl_baro_ft;
    if (agl != null && Number.isFinite(agl) && agl > AIRPORT_ZONE_MAX_AGL_FT) return false;
    const gs = tel.groundspeed_knots;
    if (gs != null && Number.isFinite(gs) && gs > AIRPORT_ZONE_MAX_GS_KT) return false;
    return true;
  }

  function pointInPolygonLatLon(lat, lon, pts) {
    if (!pts || pts.length < 3 || lat == null || lon == null) return false;
    const la = Number(lat);
    const lo = wrapLng180(Number(lon));
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const pi = pts[i];
      const pj = pts[j];
      if (!pi || !pj || pi.length < 2 || pj.length < 2) continue;
      const yi = Number(pi[0]);
      const xi = wrapLng180(Number(pi[1]));
      const yj = Number(pj[0]);
      const xj = wrapLng180(Number(pj[1]));
      if (!Number.isFinite(yi) || !Number.isFinite(xi) || !Number.isFinite(yj) || !Number.isFinite(xj)) {
        continue;
      }
      if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi + 1e-15) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function isTcasSuppressZoneRaw(tel) {
    if (!tel || !tel.ok) return false;
    if (tel.tcas_suppress === true) return true;
    if (tel.tcas_suppress === false) return false;
    const agl =
      tel.agl_game_ft != null && Number.isFinite(tel.agl_game_ft)
        ? tel.agl_game_ft
        : tel.agl_baro_ft;
    if (agl != null && Number.isFinite(agl) && agl > TCAS_SUPPRESS_MAX_AGL_FT) return false;
    if (tel.lat == null || tel.lon == null) return false;
    const zones = tcasSuppressMapZones(tel);
    for (let i = 0; i < zones.length; i++) {
      if (pointInPolygonLatLon(tel.lat, tel.lon, zones[i].pts)) return true;
    }
    return false;
  }

  function isTcasSuppressZone(tel) {
    const now = performance.now();
    if (isTcasSuppressZoneRaw(tel)) {
      tcasSuppressHoldUntil = now + TCAS_SUPPRESS_HOLD_MS;
      return true;
    }
    return now < tcasSuppressHoldUntil;
  }

  function collectTelemetryRunways(tel) {
    if (!tel) return [];
    if (tel.runways && tel.runways.length) return tel.runways;
    if (tel.runway) return [tel.runway];
    return [];
  }

  function runwayCenterLatLon(rw) {
    if (!rw) return null;
    const lat1 = rw.lat_thr;
    const lon1 = rw.lon_thr;
    const lat2 = rw.lat_end;
    const lon2 = rw.lon_end;
    if (
      lat1 == null ||
      lon1 == null ||
      lat2 == null ||
      lon2 == null ||
      !Number.isFinite(lat1) ||
      !Number.isFinite(lon1) ||
      !Number.isFinite(lat2) ||
      !Number.isFinite(lon2)
    ) {
      return null;
    }
    return { lat: (lat1 + lat2) / 2, lon: (lon1 + lon2) / 2 };
  }

  const TCAS_MAP_CORRIDOR_EXTEND_NM = 5.0;
  const TCAS_MAP_CORRIDOR_HALF_WIDTH_NM = 0.75;
  const TCAS_MAP_CENTER_RING_NM = 1.6;

  function convexHullLatLon(points) {
    const uniq = [];
    const seen = {};
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p || p.length < 2) continue;
      const la = Math.round(Number(p[0]) * 1e6) / 1e6;
      const lo = Math.round(Number(p[1]) * 1e6) / 1e6;
      const key = la + "," + lo;
      if (seen[key]) continue;
      seen[key] = 1;
      uniq.push([la, lo]);
    }
    if (uniq.length < 3) return uniq;
    const pts = uniq.slice().sort(function (a, b) {
      return a[1] === b[1] ? a[0] - b[0] : a[1] - b[1];
    });
    function cross(o, a, b) {
      return (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
    }
    const lower = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop();
      }
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop();
      }
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  function pointAtNm(lat, lon, bearingDeg, distNm) {
    const rNm = 3440.065;
    const p1 = (lat * Math.PI) / 180;
    const l1 = (lon * Math.PI) / 180;
    const br = (bearingDeg * Math.PI) / 180;
    const d = distNm / rNm;
    const p2 = Math.asin(
      Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br)
    );
    const l2 =
      l1 +
      Math.atan2(
        Math.sin(br) * Math.sin(d) * Math.cos(p1),
        Math.cos(d) - Math.sin(p1) * Math.sin(p2)
      );
    return { lat: (p2 * 180) / Math.PI, lon: wrapLng180((l2 * 180) / Math.PI) };
  }

  function runwayCorridorPolygon(rw, extendNm, halfWidthNm) {
    if (
      !rw ||
      rw.lat_thr == null ||
      rw.lon_thr == null ||
      rw.lat_end == null ||
      rw.lon_end == null
    ) {
      return null;
    }
    const brg = bearingDeg(rw.lat_thr, rw.lon_thr, rw.lat_end, rw.lon_end);
    const rev = normHdg(brg + 180);
    const left = normHdg(brg - 90);
    const right = normHdg(brg + 90);
    const s = pointAtNm(rw.lat_thr, rw.lon_thr, rev, extendNm);
    const e = pointAtNm(rw.lat_end, rw.lon_end, brg, extendNm);
    return [
      pointAtNm(s.lat, s.lon, left, halfWidthNm),
      pointAtNm(s.lat, s.lon, right, halfWidthNm),
      pointAtNm(e.lat, e.lon, right, halfWidthNm),
      pointAtNm(e.lat, e.lon, left, halfWidthNm)
    ].map(function (p) {
      return [p.lat, p.lon];
    });
  }

  /** 地图 TCAS 关闭区：每机场一块合并禁飞区（禁飞区样式多边形） */
  function tcasSuppressMapZones(tel) {
    if (!tel || !tel.ok) return [];
    const fromBridge = tel.tcas_suppress_zones;
    if (Array.isArray(fromBridge) && fromBridge.length) {
      const out = [];
      for (let i = 0; i < fromBridge.length; i++) {
        const z = fromBridge[i];
        if (!z || !Array.isArray(z.pts) || z.pts.length < 3) continue;
        const pts = [];
        for (let j = 0; j < z.pts.length; j++) {
          const p = z.pts[j];
          if (!p || p.length < 2) continue;
          const la = Number(p[0]);
          const lo = Number(p[1]);
          if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
          pts.push([la, wrapLng180(lo)]);
        }
        if (pts.length < 3) continue;
        out.push({
          icao: String(z.icao || "APT").trim().toUpperCase() || "APT",
          rw: z.rw != null ? String(z.rw) : "",
          pts: pts
        });
      }
      if (out.length) return out;
    }
    const byIcao = {};
    collectTelemetryRunways(tel).forEach(function (rw) {
      const corners = runwayCorridorPolygon(
        rw,
        TCAS_MAP_CORRIDOR_EXTEND_NM,
        TCAS_MAP_CORRIDOR_HALF_WIDTH_NM
      );
      if (!corners) return;
      const icao = String(rw.icao || "APT").trim().toUpperCase() || "APT";
      const g = byIcao[icao] || (byIcao[icao] = { pts: [], clat: 0, clon: 0, n: 0 });
      for (let k = 0; k < corners.length; k++) g.pts.push(corners[k]);
      const mid = runwayCenterLatLon(rw);
      if (mid) {
        g.clat += mid.lat;
        g.clon += mid.lon;
        g.n += 1;
      }
    });
    const out = [];
    Object.keys(byIcao).forEach(function (icao) {
      const g = byIcao[icao];
      if (g.n > 0) {
        const clat = g.clat / g.n;
        const clon = g.clon / g.n;
        for (let deg = 0; deg < 360; deg += 36) {
          const p = pointAtNm(clat, clon, deg, TCAS_MAP_CENTER_RING_NM);
          g.pts.push([p.lat, p.lon]);
        }
      }
      const hull = convexHullLatLon(g.pts);
      if (hull.length < 3) return;
      out.push({ icao: icao, rw: "", pts: hull });
    });
    return out;
  }

  function updateTcassSuppressMapOverlay(tel) {
    if (!tcasSuppressLayer) return;
    const zones = tcasSuppressMapZones(tel);
    const inSuppress = !!(tel && tel.ok && isTcasSuppressZone(tel));
    const key =
      !tel || !tel.ok
        ? ""
        : (inSuppress ? "1" : "0") +
          "|" +
          zones
            .map(function (z) {
              return (
                z.icao +
                "/" +
                z.rw +
                ":" +
                z.pts
                  .map(function (p) {
                    return p[0].toFixed(5) + "," + p[1].toFixed(5);
                  })
                  .join(";")
              );
            })
            .sort()
            .join("|");
    if (key === tcasSuppressOverlayKey) return;
    tcasSuppressOverlayKey = key;
    tcasSuppressLayer.clearLayers();
    if (!zones.length) return;
    const pane = map.getPane && map.getPane("tcasSuppressPane") ? "tcasSuppressPane" : undefined;
    zones.forEach(function (z) {
      const poly = L.polygon(z.pts, {
        pane: pane,
        className:
          "tcas-suppress-nfz" + (inSuppress ? " tcas-suppress-nfz--active" : ""),
        color: inSuppress ? "#c62828" : "#e53935",
        weight: 2,
        opacity: 0.92,
        fillColor: "#ef5350",
        fillOpacity: inSuppress ? 0.38 : 0.28,
        interactive: false
      });
      tcasSuppressLayer.addLayer(poly);
    });
    if (tcasSuppressLayer.bringToFront) tcasSuppressLayer.bringToFront();
  }

  function classifyCollisionThreat(distNm, vertFt, tcpaMin, cpaNm) {
    if (distNm > TCAS_SCAN_H_NM || vertFt > TCAS_SCAN_V_FT) return null;
    const closeNow =
      (distNm <= TCAS_RA_H_NM_CLOSE && vertFt <= TCAS_RA_V_FT_CLOSE) ||
      (distNm <= TCAS_RA_H_NM && vertFt <= TCAS_RA_V_FT);
    const closingSoon =
      tcpaMin != null &&
      cpaNm != null &&
      tcpaMin <= TCAS_RA_TCPA_MIN &&
      cpaNm <= TCAS_RA_CPA_NM &&
      vertFt <= TCAS_TA_V_FT;
    if (closeNow || closingSoon) return "ra";
    if (distNm <= TCAS_TA_H_NM && vertFt <= TCAS_TA_V_FT) return "ta";
    return null;
  }

  function computeCollisionThreats(tel) {
    if (!tel || !tel.ok || isTcasSuppressZone(tel) || isUserOnGround(tel)) return [];
    if (!Array.isArray(tel.traffic) || tel.lat == null || tel.lon == null) return [];
    const acLat = tel.lat;
    const acLon = tel.lon;
    const acAlt = tel.alt_ft != null && Number.isFinite(tel.alt_ft) ? tel.alt_ft : null;
    const acGs = tel.groundspeed_knots;
    const acHdg = tel.heading_deg != null && Number.isFinite(tel.heading_deg) ? tel.heading_deg : 0;
    const acTrk =
      tel.ground_track_deg != null && Number.isFinite(tel.ground_track_deg)
        ? tel.ground_track_deg
        : acHdg;
    const threats = [];
    tel.traffic.forEach(function (t) {
      if (!t || t.lat == null || t.lon == null) return;
      if (isTrafficOnGround(t, tel)) return;
      const distNm = haversineNm(acLat, acLon, t.lat, t.lon);
      const tGs = t.groundspeed_knots;
      const acGsUse = acGs != null && Number.isFinite(acGs) ? acGs : 0;
      const tGsUse = tGs != null && Number.isFinite(tGs) ? tGs : 0;
      if (tGsUse < 70 && acGsUse < 70 && distNm > 0.35) return;
      let vertFt = TCAS_SCAN_V_FT + 1;
      if (acAlt != null && t.alt_ft != null && Number.isFinite(t.alt_ft)) {
        vertFt = Math.abs(t.alt_ft - acAlt);
      }
      const brg = bearingDeg(acLat, acLon, t.lat, t.lon);
      let relBrg = normHdg(brg - acHdg);
      if (relBrg > 180) relBrg -= 360;
      const tHdg = t.heading_deg;
      const motion = estimateTcpaCpaMin(acLat, acLon, acGs, acTrk, t.lat, t.lon, tGs, tHdg);
      const level = classifyCollisionThreat(distNm, vertFt, motion.tcpaMin, motion.cpaNm);
      if (!level) return;
      threats.push({
        id: t.id,
        level: level,
        distNm: distNm,
        vertFt: vertFt,
        relBrg: relBrg,
        brg: brg,
        tcpaMin: motion.tcpaMin,
        cpaNm: motion.cpaNm,
        altFt: t.alt_ft
      });
    });
    threats.sort(function (a, b) {
      if (a.level !== b.level) return a.level === "ra" ? -1 : 1;
      if (a.distNm !== b.distNm) return a.distNm - b.distNm;
      return a.vertFt - b.vertFt;
    });
    return threats;
  }

  function ensureTcassAudio() {
    try {
      if (!tcasAudioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        tcasAudioCtx = new AC();
      }
      if (tcasAudioCtx.state === "suspended") {
        tcasAudioCtx.resume().then(function () {
          tcasAudioReady = tcasAudioCtx && tcasAudioCtx.state === "running";
        }).catch(function () {});
        return false;
      }
      tcasAudioReady = tcasAudioCtx.state === "running";
      return tcasAudioReady;
    } catch (e) {
      return false;
    }
  }

  function unlockTcassAudio() {
    if (!tcasAudioCtx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) tcasAudioCtx = new AC();
      } catch (e) {
        return;
      }
    }
    if (!tcasAudioCtx) return;
    if (tcasAudioCtx.state === "suspended") {
      tcasAudioCtx.resume().then(function () {
        tcasAudioReady = true;
      }).catch(function () {});
    } else {
      tcasAudioReady = true;
    }
  }

  function playTcassBeep(freqHz, durationSec, gain) {
    if (!ensureTcassAudio() || !tcasAudioCtx) return;
    var t0 = tcasAudioCtx.currentTime;
    var osc = tcasAudioCtx.createOscillator();
    var amp = tcasAudioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freqHz, t0);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.001, t0 + durationSec);
    osc.connect(amp);
    amp.connect(tcasAudioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.02);
  }

  function playCollisionAlertSound(level) {
    if (!ensureTcassAudio()) return;
    if (level === "ra") {
      playTcassBeep(880, 0.11, 0.16);
      window.setTimeout(function () { playTcassBeep(660, 0.11, 0.16); }, 130);
      window.setTimeout(function () { playTcassBeep(880, 0.11, 0.16); }, 260);
      window.setTimeout(function () { playTcassBeep(660, 0.11, 0.16); }, 390);
    } else {
      playTcassBeep(523, 0.18, 0.11);
      window.setTimeout(function () { playTcassBeep(659, 0.22, 0.09); }, 200);
    }
  }

  function stopTcassAlertSound() {
    if (tcasSoundStopTimer) {
      clearTimeout(tcasSoundStopTimer);
      tcasSoundStopTimer = null;
    }
    if (tcasSoundTimer) {
      clearInterval(tcasSoundTimer);
      tcasSoundTimer = null;
    }
    tcasActiveSoundLevel = null;
  }

  function scheduleStopTcassAlertSound() {
    if (tcasSoundStopTimer) return;
    tcasSoundStopTimer = window.setTimeout(function () {
      tcasSoundStopTimer = null;
      stopTcassAlertSound();
    }, TCAS_SOUND_STOP_DELAY_MS);
  }

  function cancelScheduledStopTcassAlertSound() {
    if (tcasSoundStopTimer) {
      clearTimeout(tcasSoundStopTimer);
      tcasSoundStopTimer = null;
    }
  }

  function resetTcassAlertHold() {
    tcasAlertHoldUntil = 0;
    tcasAlertHoldSnapshot = [];
  }

  function collisionThreatsWithHold(tel) {
    if (isTcasSuppressZone(tel) || isUserOnGround(tel)) {
      resetTcassAlertHold();
      return [];
    }
    const raw = computeCollisionThreats(tel);
    const now = Date.now();
    if (raw.length) {
      tcasAlertHoldSnapshot = raw;
      tcasAlertHoldUntil = now + TCAS_ALERT_HOLD_MS;
      return raw;
    }
    if (now < tcasAlertHoldUntil && tcasAlertHoldSnapshot.length) {
      return tcasAlertHoldSnapshot;
    }
    tcasAlertHoldSnapshot = [];
    return [];
  }

  function syncTcassAlertSound(level) {
    if (!level) {
      scheduleStopTcassAlertSound();
      return;
    }
    cancelScheduledStopTcassAlertSound();
    if (tcasActiveSoundLevel === level && tcasSoundTimer) return;
    if (tcasSoundTimer) {
      clearInterval(tcasSoundTimer);
      tcasSoundTimer = null;
    }
    tcasActiveSoundLevel = level;
    playCollisionAlertSound(level);
    var intervalMs = level === "ra" ? 1100 : 3200;
    tcasSoundTimer = window.setInterval(function () {
      if (!ensureTcassAudio()) return;
      playCollisionAlertSound(level);
    }, intervalMs);
  }

  function updateCollisionWarnings(tel) {
    if (!showCollisionAlerts) {
      resetTcassAlertHold();
      lastCollisionThreats = [];
      collisionThreatById = Object.create(null);
      const elOff = document.getElementById("collisionAlert");
      const badgeOff = document.getElementById("collisionAlertBadge");
      const textOff = document.getElementById("collisionAlertText");
      if (elOff) {
        elOff.hidden = true;
        elOff.className = "collision-alert";
      }
      if (badgeOff) badgeOff.textContent = "";
      if (textOff) textOff.textContent = "";
      scheduleStopTcassAlertSound();
      refreshTrafficMarkerStyles();
      return;
    }
    let threats;
    if (!tel || !tel.ok) {
      resetTcassAlertHold();
      threats = [];
    } else {
      threats = collisionThreatsWithHold(tel);
    }
    lastCollisionThreats = threats;
    collisionThreatById = Object.create(null);
    threats.forEach(function (th) {
      if (th.id != null) collisionThreatById[String(th.id)] = th;
    });
    const el = document.getElementById("collisionAlert");
    const badgeEl = document.getElementById("collisionAlertBadge");
    const textEl = document.getElementById("collisionAlertText");
    if (!el) return;
    if (!threats.length) {
      el.hidden = true;
      el.className = "collision-alert";
      if (badgeEl) badgeEl.textContent = "";
      if (textEl) textEl.textContent = "";
      scheduleStopTcassAlertSound();
      return;
    }
    const top = threats[0];
    el.hidden = false;
    el.className = "collision-alert collision-alert--" + top.level;
    if (badgeEl) badgeEl.textContent = top.level === "ra" ? "RA" : "TA";
    const vertStr =
      top.vertFt <= TCAS_SCAN_V_FT ? "Δ" + Math.round(top.vertFt) + " ft" : "高度未知";
    let line =
      fmtNum(top.distNm, 1) +
      " NM · " +
      vertStr +
      " · " +
      fmtRelBearingDeg(top.relBrg);
    if (top.tcpaMin != null && top.tcpaMin <= TCAS_RA_TCPA_MIN) {
      line += " · TCPA " + fmtNum(top.tcpaMin, 1) + " min";
    }
    if (threats.length > 1) line += " · 另有 " + (threats.length - 1) + " 架";
    if (textEl) textEl.textContent = line;
    syncTcassAlertSound(top.level);
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
  const ND_CSS_H = 218;
  const ND_CSS_W_MIN = 236;
  let ndCssW = ND_CSS_W_MIN;
  let ndCssH = ND_CSS_H;
  let ndDpr = 1;
  /** true：PLAN 模式（真北向上、地图缩放到前方航线） */
  let ndPlanMode = false;
  /** PLAN 地图缩放系数（>1 更「放大」航线） */
  let ndPlanZoom = 1;
  const ND_PLAN_ZOOM_MIN = 0.55;
  const ND_PLAN_ZOOM_MAX = 3.2;
  const ND_PLAN_ZOOM_STEP = 1.18;
  let ndGndBasePxPerM = 0.045;
  let ndGndLayoutIcao = null;
  let ndGndLayoutFitKey = null;
  let ndGndWasOnGround = false;
  let ndGndUserOverrodeZoom = false;
  /** ND 弧模式：地形 / 气象雷达叠层 */
  let ndTerrOn = true;
  let ndWxOn = false;
  /** WX 每次打开时扇形扫描一次（0–1），完成后保持全显直至关闭 */
  let ndWxSweepPos = 1;
  let ndWxSweepRaf = 0;
  let ndWxSweepT0 = 0;
  let ndWxSweepDone = true;
  const ND_WX_SWEEP_ONCE_MS = 2400;
  /** 界面显示 ×1～×5（仅 UI；原 ×7～×10 对应同一底图缩放） */
  const ND_GND_ZOOM_DISP_MIN = 1;
  const ND_GND_ZOOM_DISP_MAX = 5;
  const ND_GND_ZOOM_DISP_DEFAULT = 1;
  const ND_GND_ZOOM_DISP_STEP = 1;
  /** 底图缩放仍按内部档 5～10 计算（×1→5，×5→10） */
  const ND_GND_SCALE_INTERNAL_MIN = 5;
  const ND_GND_SCALE_INTERNAL_MAX = 10;
  const ND_GND_SCALE_INTERNAL_DEFAULT = 5;

  /** 显示倍率映射到底图缩放系数：×1 用 SCALE_MIN，×5 用 SCALE_MAX */
  const ND_GND_SCALE_MIN = 0.82;
  const ND_GND_SCALE_MAX = 2.85;

  /** 整体尺寸增强：控制基础大小，不建议超过 4.5 */
  const ND_GND_SIZE_BOOST = 4.2;

  let ndGndZoomDisp = ND_GND_ZOOM_DISP_DEFAULT;

  function ndGndClamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  /** UI ×1～×5 → 内部缩放档 5～10（×1 默认更小，×5 最大不变） */
  function ndGndUiToScaleInternal(uiDisp) {
    const d = ndGndClamp(uiDisp, ND_GND_ZOOM_DISP_MIN, ND_GND_ZOOM_DISP_MAX);
    const uiSpan = ND_GND_ZOOM_DISP_MAX - ND_GND_ZOOM_DISP_MIN;
    const t = uiSpan > 0 ? (d - ND_GND_ZOOM_DISP_MIN) / uiSpan : 0;
    return (
      ND_GND_SCALE_INTERNAL_DEFAULT +
      t * (ND_GND_SCALE_INTERNAL_MAX - ND_GND_SCALE_INTERNAL_DEFAULT)
    );
  }

  function ndGndDisplayToScale(dispZoom) {
    const z = ndGndUiToScaleInternal(dispZoom);
    const dSpan = ND_GND_SCALE_INTERNAL_MAX - ND_GND_SCALE_INTERNAL_MIN;
    const t =
      dSpan > 0 ? (z - ND_GND_SCALE_INTERNAL_MIN) / dSpan : 1;

    return ND_GND_SCALE_MIN + t * (ND_GND_SCALE_MAX - ND_GND_SCALE_MIN);
  }

  function getNdGndMapScale() {
    return ndGndDisplayToScale(ndGndZoomDisp) * ND_GND_SIZE_BOOST;
  }

  function formatNdGndZoomLabel() {
    return String(
      Math.round(
        ndGndClamp(
          ndGndZoomDisp,
          ND_GND_ZOOM_DISP_MIN,
          ND_GND_ZOOM_DISP_MAX
        )
      )
    );
  }
  /** 地面 ND：顶栏高度、左侧缩放列、机腹留白 */
  const ND_GND_HDR_H = 50;
  const ND_GND_BOT_PAD = 14;

  /** 仅在本机地面且已有场面数据时显示 ND 机场底图（离地自动隐藏） */
  function ndArcGndUnderlayVisible(tel) {
    if (!tel || !tel.ok || ndPlanMode) return false;
    if (!resolveNdAirportGnd(tel)) return false;
    return isUserOnGround(tel);
  }

  function gndEnuMeters(refLat, refLon, lat, lon) {
    const north = (lat - refLat) * 111320;
    let dLon = lon - refLon;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    const east = dLon * 111320 * Math.cos((refLat * Math.PI) / 180);
    return { east: east, north: north };
  }

  /** 场面自动适配锚点：跑道端点质心，与飞机位置/航向无关 */
  function gndAirportRefLatLon(gnd, acLat, acLon) {
    const rw = gnd && gnd.runways;
    if (!Array.isArray(rw) || !rw.length) {
      return { lat: acLat, lon: acLon };
    }
    let slat = 0;
    let slon = 0;
    let n = 0;
    for (let i = 0; i < rw.length; i++) {
      const r = rw[i];
      if (r && r.lat_thr != null && r.lon_thr != null) {
        slat += r.lat_thr;
        slon += r.lon_thr;
        n++;
      }
      if (r && r.lat_end != null && r.lon_end != null) {
        slat += r.lat_end;
        slon += r.lon_end;
        n++;
      }
    }
    if (n < 1) return { lat: acLat, lon: acLon };
    return { lat: slat / n, lon: slon / n };
  }

  /** 本机至 ND 画布四边最远像素距离（场面图/交通裁剪用） */
  function ndGndScreenFitRadiusPx(cx, cy, w, h, padTop) {
    const l = 4;
    const r = w - 4;
    const t = (padTop != null ? padTop : 0) + 2;
    const b = h - 4;
    return Math.max(
      Math.hypot(cx - l, cy - t),
      Math.hypot(r - cx, cy - t),
      Math.hypot(cx - l, b - cy),
      Math.hypot(r - cx, b - cy)
    );
  }

  function gndPolyPts(item) {
    if (Array.isArray(item)) return item;
    if (item && Array.isArray(item.pts)) return item.pts;
    return null;
  }

  function walkGndPolys(arr, sampleFn) {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const pts = gndPolyPts(arr[i]);
      if (!pts) continue;
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        if (!p || p.length < 2) continue;
        sampleFn(p[0], p[1]);
      }
    }
  }

  function drawGndPolygons(ctx, items, toScreen, fillStyle, strokeStyle, lineW, minPts) {
    const need = minPts != null ? minPts : 3;
    if (!Array.isArray(items)) return;
    for (let i = 0; i < items.length; i++) {
      const pts = gndPolyPts(items[i]);
      if (!pts || pts.length < need) continue;
      ctx.beginPath();
      for (let j = 0; j < pts.length; j++) {
        const p = toScreen(pts[j][0], pts[j][1]);
        if (j === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      if (need >= 3) ctx.closePath();
      if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
      }
      if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineW != null ? lineW : 1;
        ctx.stroke();
      }
    }
  }

  function parseRunwayDesignators(rwStr) {
    const s = String(rwStr || "").trim().toUpperCase();
    const parts = s.split("/");
    if (parts.length >= 2) {
      return [parts[0].trim(), parts[1].trim()];
    }
    return s ? [s, ""] : ["", ""];
  }

  function gndFeatureRef(obj) {
    if (!obj || Array.isArray(obj)) return "";
    if (obj.ref != null) {
      const r = String(obj.ref).trim();
      if (r) return r;
    }
    if (obj.name != null) {
      const n = String(obj.name).trim();
      if (n) return n;
    }
    return "";
  }

  /** 停机位编号：去掉 Gate/机位 等前缀，保留 12 / 228L 等短编号 */
  function formatGndStandRef(st) {
    const raw = gndFeatureRef(st);
    if (!raw) return "";
    let s = String(raw).trim();
    if (!s) return "";
    s = s.replace(
      /^(gate|stand|parking(?:\s*position|\s*space)?|机位|停机位|车位|泊位)\s*[#:：\-]?\s*/gi,
      ""
    );
    s = s.replace(/^([A-Z]{1,2})[\s\-]?(\d{1,3}[A-Z]?)$/, "$1$2");
    s = s.trim();
    if (s.length > 12) {
      const m = s.match(/\b(\d{1,3}[A-Z]?|[A-Z]\d{1,3}[A-Z]?)\b/);
      if (m) s = m[1];
      else if (!/\d/.test(s)) return "";
    }
    if (!s || s.length > 10) return "";
    if (/^(terminal|apron|hangar|taxiway|remote|domestic|international)/i.test(s)) return "";
    return s;
  }

  function gndStandDistM(lat1, lon1, lat2, lon2) {
    const enu = gndEnuMeters(lat1, lon1, lat2, lon2);
    return Math.hypot(enu.east, enu.north);
  }

  /** 点到跑道中心线距离（米） */
  function gndDistPointToRunwayM(lat, lon, rw) {
    if (!rw || rw.lat_thr == null || rw.lon_thr == null || rw.lat_end == null || rw.lon_end == null) {
      return Infinity;
    }
    const o = gndEnuMeters(rw.lat_thr, rw.lon_thr, lat, lon);
    const seg = gndEnuMeters(rw.lat_thr, rw.lon_thr, rw.lat_end, rw.lon_end);
    const len2 = seg.east * seg.east + seg.north * seg.north;
    if (len2 < 0.5) return Math.hypot(o.east, o.north);
    let t = (o.east * seg.east + o.north * seg.north) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = seg.east * t;
    const py = seg.north * t;
    return Math.hypot(o.east - px, o.north - py);
  }

  function gndStandOnRunway(st, runways) {
    if (!st || !Array.isArray(runways)) return false;
    for (let ri = 0; ri < runways.length; ri++) {
      const rw = runways[ri];
      const widM = rw && rw.width_m != null && Number.isFinite(rw.width_m) ? rw.width_m : 45;
      const marginM = Math.max(20, widM * 0.36);
      if (gndDistPointToRunwayM(st.lat, st.lon, rw) < marginM) return true;
    }
    return false;
  }

  /**
   * 合并 OSM/补充数据里同号或极近重复的停机位；去掉落在跑道上的误点。
   */
  function prepareGndStandsForLabel(stands, runways) {
    if (!Array.isArray(stands)) return [];
    const MERGE_ANY_M = 16;
    const MERGE_SAME_REF_M = 52;
    const raw = [];
    for (let si = 0; si < stands.length; si++) {
      const st = stands[si];
      if (!st || st.lat == null || st.lon == null) continue;
      const ref = formatGndStandRef(st);
      if (!ref) continue;
      if (gndStandOnRunway(st, runways)) continue;
      raw.push({ lat: st.lat, lon: st.lon, ref: ref, w: 1 });
    }
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      let merged = false;
      for (let oi = 0; oi < out.length; oi++) {
        const o = out[oi];
        const d = gndStandDistM(item.lat, item.lon, o.lat, o.lon);
        if (d >= MERGE_ANY_M && (item.ref !== o.ref || d >= MERGE_SAME_REF_M)) continue;
        const wSum = o.w + item.w;
        o.lat = (o.lat * o.w + item.lat * item.w) / wSum;
        o.lon = (o.lon * o.w + item.lon * item.w) / wSum;
        o.w = wSum;
        merged = true;
        break;
      }
      if (!merged) out.push(item);
    }
    return out;
  }

  function drawGndMapLabel(ctx, x, y, text, fontPx) {
    if (!text) return;
    const fp = Math.max(7, Math.min(12, fontPx));
    ctx.font = "600 " + fp + "px Consolas, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const pad = 2;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(8, 12, 18, 0.8)";
    ctx.fillRect(x - tw / 2 - pad, y - fp / 2 - pad, tw + pad * 2, fp + pad * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(6, 8, 12, 0.88)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "rgba(248, 252, 255, 0.98)";
    ctx.fillText(text, x, y);
  }

  /** 停机位编号：绿色数字，无描边 */
  function drawGndStandLabel(ctx, x, y, text, fontPx) {
    if (!text) return;
    const fp = Math.max(5, Math.min(8, fontPx));
    ctx.font = "600 " + fp + "px Consolas, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(95, 219, 140, 0.92)";
    ctx.fillText(text, x, y);
  }

  function drawRunwayMarkLabel(ctx, x, y, angRad, text, fontPx) {
    if (!text) return;
    ctx.save();
    ctx.translate(x, y);
    let a = angRad;
    while (a > Math.PI / 2) a -= Math.PI;
    while (a < -Math.PI / 2) a += Math.PI;
    ctx.rotate(a);
    ctx.font = "bold " + fontPx + "px Consolas, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, fontPx * 0.2);
    ctx.strokeStyle = "rgba(6, 8, 12, 0.88)";
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = "rgba(248, 252, 255, 0.97)";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function drawGndRunways(ctx, runways, toScreen, pxPerM) {
    if (!Array.isArray(runways)) return;
    for (let ri = 0; ri < runways.length; ri++) {
      const rw = runways[ri];
      if (!rw || rw.lat_thr == null || rw.lon_thr == null || rw.lat_end == null || rw.lon_end == null) {
        continue;
      }
      const p1 = toScreen(rw.lat_thr, rw.lon_thr);
      const p2 = toScreen(rw.lat_end, rw.lon_end);
      const widM = rw.width_m != null && Number.isFinite(rw.width_m) ? rw.width_m : 45;
      const halfW = Math.max(8, Math.min(150, (widM * pxPerM) * 0.82));
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * halfW;
      const ny = (dx / len) * halfW;

      ctx.beginPath();
      ctx.moveTo(p1.x + nx, p1.y + ny);
      ctx.lineTo(p2.x + nx, p2.y + ny);
      ctx.lineTo(p2.x - nx, p2.y - ny);
      ctx.lineTo(p1.x - nx, p1.y - ny);
      ctx.closePath();
      ctx.fillStyle = "rgba(88, 94, 102, 0.96)";
      ctx.fill();
      ctx.strokeStyle = "rgba(168, 176, 188, 0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.strokeStyle = "rgba(245, 248, 252, 0.88)";
      ctx.lineWidth = Math.max(1.2, halfW * 0.07);
      const dashOn = Math.max(10, halfW * 0.55);
      const dashOff = Math.max(8, halfW * 0.4);
      ctx.setLineDash([dashOn, dashOff]);
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.setLineDash([]);

      const ux = dx / len;
      const uy = dy / len;
      const along = Math.min(len * 0.12, Math.max(halfW * 1.8, 14));
      const rwAng = Math.atan2(dy, dx);
      const lblPx = Math.max(10, Math.min(26, halfW * 1.05));
      const ends = parseRunwayDesignators(rw.rw);
      if (ends[0]) {
        drawRunwayMarkLabel(
          ctx,
          p1.x + ux * along,
          p1.y + uy * along,
          rwAng,
          ends[0],
          lblPx
        );
      }
      if (ends[1]) {
        drawRunwayMarkLabel(
          ctx,
          p2.x - ux * along,
          p2.y - uy * along,
          rwAng + Math.PI,
          ends[1],
          lblPx
        );
      } else if (ends[0] && !ends[1]) {
        drawRunwayMarkLabel(
          ctx,
          p2.x - ux * along,
          p2.y - uy * along,
          rwAng + Math.PI,
          ends[0],
          lblPx
        );
      }
    }
  }

  function drawGndTaxiways(ctx, taxiways, toScreen, pxPerM) {
    if (!Array.isArray(taxiways)) return;
    const paveW = Math.max(3.5, Math.min(16, 11 * pxPerM));
    const dashLen = Math.max(5, paveW * 0.55);
    for (let ti = 0; ti < taxiways.length; ti++) {
      const pts = gndPolyPts(taxiways[ti]);
      if (!pts || pts.length < 2) continue;
      ctx.beginPath();
      for (let j = 0; j < pts.length; j++) {
        const p = toScreen(pts[j][0], pts[j][1]);
        if (j === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = "rgba(118, 128, 140, 0.92)";
      ctx.lineWidth = paveW;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.strokeStyle = "rgba(232, 204, 72, 0.92)";
      ctx.lineWidth = Math.max(1.1, paveW * 0.14);
      ctx.setLineDash([dashLen, dashLen * 0.72]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawGndTaxiwayLabels(ctx, taxiways, toScreen, pxPerM) {
    if (!Array.isArray(taxiways) || pxPerM < 0.004) return;
    const labeled = Object.create(null);
    const fontPx = 7 + pxPerM * 14;
    for (let ti = 0; ti < taxiways.length; ti++) {
      const item = taxiways[ti];
      const ref = gndFeatureRef(item);
      if (!ref || labeled[ref]) continue;
      const pts = gndPolyPts(item);
      if (!pts || pts.length < 2) continue;
      const mid = Math.max(1, Math.floor(pts.length / 2));
      const pA = toScreen(pts[mid - 1][0], pts[mid - 1][1]);
      const pB = toScreen(pts[mid][0], pts[mid][1]);
      if (Math.hypot(pB.x - pA.x, pB.y - pA.y) < 12) continue;
      drawGndMapLabel(ctx, (pA.x + pB.x) * 0.5, (pA.y + pB.y) * 0.5, ref.slice(0, 10), fontPx);
      labeled[ref] = true;
    }
  }

  function drawGndStands(ctx, stands, runways, toScreen, pxPerM, prioX, prioY) {
    if (!Array.isArray(stands) || pxPerM < 0.004) return;
    const prepared = prepareGndStandsForLabel(stands, runways);
    if (!prepared.length) return;
    const fontPx = Math.max(5, Math.min(8, 4 + pxPerM * 6));
    const minGapPx = Math.max(7, fontPx * 0.95);
    const sameRefGapPx = Math.max(9, fontPx * 1.35);
    const cand = [];
    for (let si = 0; si < prepared.length; si++) {
      const st = prepared[si];
      const p = toScreen(st.lat, st.lon);
      cand.push({
        ref: st.ref,
        x: p.x,
        y: p.y
      });
    }
    const placed = [];
    for (let ci = 0; ci < cand.length; ci++) {
      const c = cand[ci];
      let ok = true;
      for (let pi = 0; pi < placed.length; pi++) {
        const pl = placed[pi];
        const gap = pl.ref === c.ref ? sameRefGapPx : minGapPx;
        if (Math.hypot(pl.x - c.x, pl.y - c.y) < gap) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      placed.push(c);
      drawGndStandLabel(ctx, c.x, c.y, c.ref, fontPx);
    }
  }

  /** 按本机位置 ENU 包围盒适配（与航向无关，避免转向时缩放漂移） */
  function computeNdGndBasePxPerM(
    gnd,
    acLat,
    acLon,
    centerX,
    centerY,
    w,
    h,
    padTop,
    fillFrac,
    preferFillWidth
  ) {
    const fill = fillFrac != null && Number.isFinite(fillFrac) ? fillFrac : 0.72;
    const ref = gndAirportRefLatLon(gnd, acLat, acLon);
    const refLat = ref.lat;
    const refLon = ref.lon;
    let maxAbsNorth = 60;
    let maxAbsEast = 60;
    function sampleEnu(enu) {
      maxAbsNorth = Math.max(maxAbsNorth, Math.abs(enu.north));
      maxAbsEast = Math.max(maxAbsEast, Math.abs(enu.east));
    }
    function sample(lat, lon) {
      sampleEnu(gndEnuMeters(refLat, refLon, lat, lon));
    }
    function walkLines(lines) {
      if (!Array.isArray(lines)) return;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (!Array.isArray(ln)) continue;
        for (let j = 0; j < ln.length; j++) {
          const p = ln[j];
          if (!p || p.length < 2) continue;
          sample(p[0], p[1]);
        }
      }
    }
    walkGndPolys(gnd.taxiways, sample);
    walkGndPolys(gnd.aprons, sample);
    walkGndPolys(gnd.buildings, sample);
    walkGndPolys(gnd.grass, sample);
    if (Array.isArray(gnd.stands)) {
      for (let si = 0; si < gnd.stands.length; si++) {
        const st = gnd.stands[si];
        if (st && st.lat != null && st.lon != null) sample(st.lat, st.lon);
      }
    }
    const rw = gnd.runways;
    if (Array.isArray(rw)) {
      for (let ri = 0; ri < rw.length; ri++) {
        const r = rw[ri];
        if (!r) continue;
        if (r.lat_thr != null && r.lon_thr != null) sample(r.lat_thr, r.lon_thr);
        if (r.lat_end != null && r.lon_end != null) sample(r.lat_end, r.lon_end);
      }
    }
    const mx = 4;
    const leftPad = padTop >= ND_GND_HDR_H - 2 ? 6 : 0;
    const availW = Math.max(80, w - mx * 2 - leftPad);
    const availUp = Math.max(36, centerY - (padTop + 4));
    const availDown = Math.max(28, h - centerY - 6);
    const maxAbsRight = Math.max(maxAbsEast, maxAbsNorth);
    const maxAbsFwd = Math.max(maxAbsEast, maxAbsNorth);
    const pxW = (availW * 0.5 * fill) / maxAbsRight;
    const pxH = (Math.min(availUp, availDown) * fill) / maxAbsFwd;
    if (preferFillWidth) return Math.max(pxW, pxH * 0.75);
    return Math.min(pxW, pxH);
  }

  function ndGndPxPerM() {
    return ndGndBasePxPerM * getNdGndMapScale();
  }

  /** 按场面几何自动适配底图基准；用户倍率由 getNdGndMapScale 单独施加 */
  function applyNdGndAutoFit(
    gnd,
    acLat,
    acLon,
    centerX,
    centerY,
    w,
    h,
    padTop,
    fillFrac,
    preferFillWidth
  ) {
    const fitBase = computeNdGndBasePxPerM(
      gnd,
      acLat,
      acLon,
      centerX,
      centerY,
      w,
      h,
      padTop,
      fillFrac,
      preferFillWidth
    );
    ndGndBasePxPerM = fitBase;
    return fitBase;
  }

  /** ARC 模式底层：航向向上滑行道/跑道/停机坪（以本机位置为屏幕中心，机头朝屏上） */
  function drawNdAirportGndUnderlay(
    ctx,
    acLat,
    acLon,
    centerX,
    centerY,
    w,
    h,
    padTop,
    tel,
    hdgDeg,
    fillFrac,
    preferFillWidth
  ) {
    const gnd = resolveNdAirportGnd(tel);
    if (!gnd) return false;
    const fitKey = Math.round(w / 4) * 4 + "x" + Math.round(h / 4) * 4;
    const icao =
      gnd.icao != null ? String(gnd.icao).trim().toUpperCase() : "";
    const prevIcao =
      ndGndLayoutIcao != null ? String(ndGndLayoutIcao).trim().toUpperCase() : "";
    const fitChg = ndGndLayoutFitKey !== fitKey;
    ndGndWasOnGround = true;

    /** 首次显示、确认换机场、或未手动缩放时画布变大/变小；同一 ICAO 锁定后不因航向重算 */
    const firstFit = !prevIcao && !!icao;
    const airportChange = !!prevIcao && !!icao && icao !== prevIcao;
    const shouldAutoFit =
      firstFit ||
      airportChange ||
      (fitChg && !ndGndUserOverrodeZoom);
    if (shouldAutoFit) {
      ndGndLayoutIcao = icao || gnd.icao;
      ndGndLayoutFitKey = fitKey;
      applyNdGndAutoFit(
        gnd,
        acLat,
        acLon,
        centerX,
        centerY,
        w,
        h,
        padTop,
        fillFrac,
        preferFillWidth
      );
      syncNdGndZoomChrome();
    }
    const pxPerM = ndGndPxPerM();
    const hdg = normHdg(hdgDeg != null && Number.isFinite(hdgDeg) ? hdgDeg : 0);
    const hdgRad = (hdg * Math.PI) / 180;
    const sinH = Math.sin(hdgRad);
    const cosH = Math.cos(hdgRad);

    function toScreen(lat, lon) {
      const enu = gndEnuMeters(acLat, acLon, lat, lon);
      const fwd = enu.east * sinH + enu.north * cosH;
      const right = enu.east * cosH - enu.north * sinH;
      return { x: centerX + right * pxPerM, y: centerY - fwd * pxPerM };
    }

    drawGndPolygons(
      ctx,
      gnd.buildings,
      toScreen,
      "rgba(48, 118, 198, 0.82)",
      "rgba(28, 72, 138, 0.55)",
      1,
      3
    );
    drawGndPolygons(
      ctx,
      gnd.aprons,
      toScreen,
      "rgba(118, 128, 140, 0.94)",
      "rgba(168, 178, 190, 0.55)",
      1.2,
      3
    );
    drawGndRunways(ctx, gnd.runways, toScreen, pxPerM);
    drawGndTaxiways(ctx, gnd.taxiways, toScreen, pxPerM);
    drawGndTaxiwayLabels(ctx, gnd.taxiways, toScreen, pxPerM);
    drawGndStands(ctx, gnd.stands, gnd.runways, toScreen, pxPerM, centerX, centerY);
    return true;
  }

  /** 地面机场图：交通机与滑行道同一套航向向上投影 */
  function drawNdTrafficGndMap(
    ctx,
    traffic,
    acLat,
    acLon,
    centerX,
    centerY,
    w,
    h,
    padTop,
    hdgDeg,
    tel
  ) {
    if (!traffic || !traffic.length || !ndGndBasePxPerM) return;
    const pxPerM = ndGndPxPerM();
    const hdg = normHdg(hdgDeg != null && Number.isFinite(hdgDeg) ? hdgDeg : 0);
    const hdgRad = (hdg * Math.PI) / 180;
    const sinH = Math.sin(hdgRad);
    const cosH = Math.cos(hdgRad);
    const maxPx = ndGndScreenFitRadiusPx(centerX, centerY, w, h, padTop) * 1.06;

    for (let ti = 0; ti < traffic.length; ti++) {
      const t = traffic[ti];
      if (!t || t.lat == null || t.lon == null) continue;
      const enu = gndEnuMeters(acLat, acLon, t.lat, t.lon);
      const fwd = enu.east * sinH + enu.north * cosH;
      const right = enu.east * cosH - enu.north * sinH;
      const sx = centerX + right * pxPerM;
      const sy = centerY - fwd * pxPerM;
      if (Math.hypot(sx - centerX, sy - centerY) > maxPx) continue;
      if (sx < -16 || sy < padTop - 4 || sx > w + 16 || sy > h + 16) continue;
      drawNdTrafficSymbol(
        ctx,
        sx,
        sy,
        t.heading_deg,
        hdg,
        trafficDisplayStyle(t, tel)
      );
    }
  }

  /** 地面模式：顶栏渐变遮罩 + 航向刻度（缩放键在 HTML 工具栏，不在画布左侧） */
  function drawNdGndGroundChrome(ctx, w, cx, compassRef, trkN, hdgN, tel) {
    const hdrH = ND_GND_HDR_H;
    const maskFeather = 24;
    const maskH = hdrH + maskFeather;
    const grad = ctx.createLinearGradient(0, 0, 0, maskH);
    grad.addColorStop(0, "rgba(6, 8, 14, 0.96)");
    grad.addColorStop(0.38, "rgba(6, 8, 14, 0.78)");
    grad.addColorStop(0.58, "rgba(6, 8, 14, 0.45)");
    grad.addColorStop(0.76, "rgba(6, 8, 14, 0.18)");
    grad.addColorStop(0.9, "rgba(6, 8, 14, 0.05)");
    grad.addColorStop(1, "rgba(6, 8, 14, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, maskH);

    const gs = tel && tel.groundspeed_knots;
    const tasDisp = tasKnotsFromTelemetry(tel);
    const tx = 6;
    ctx.textAlign = "left";
    ctx.font = "600 9px Consolas, ui-monospace, monospace";
    ctx.fillStyle = "#5fdb8c";
    ctx.fillText(
      "GS " + (gs != null && Number.isFinite(gs) ? Math.round(gs) : "—") +
        "  TAS " + (tasDisp != null ? tasDisp : "—"),
      tx,
      9
    );
    const windLine2 = (function () {
      if (!tel || !tel.ok) return "— / —";
      var d = tel.wind_direction_deg;
      var s = tel.wind_speed_knots;
      if (d == null || !Number.isFinite(d) || s == null || !Number.isFinite(s)) return "— / —";
      return String(Math.round(normHdg(d))).padStart(3, "0") + " / " + String(Math.round(s));
    })();
    ctx.fillText(windLine2, tx, 21);
    if (tel && tel.wind_direction_deg != null && Number.isFinite(tel.wind_direction_deg)) {
      drawNdWindArrow(ctx, tx + ctx.measureText(windLine2).width + 5, 18, tel.wind_direction_deg, hdgN);
    }

    const yLine = hdrH + 2;
    const halfW = Math.min(cx - 12, w - cx - 12) * 0.86;
    const hhStr = fmtNum(trkN != null ? trkN : hdgN, 1);
    const topTitle = trkN != null ? "TRK" : "HDG";
    const topStr = topTitle + " " + hhStr + " MAG";
    ctx.font = "600 11px Consolas, ui-monospace, monospace";
    const trkTw = ctx.measureText(topStr).width;
    const trkLabelY = yLine - 16;
    const trkClear = trkTw / 2 + 14;
    const trkPadX = 8;
    const trkPadTop = 4;
    const trkBoxH = 13;
    const trkBoxY = trkLabelY - trkBoxH - trkPadTop;
    ctx.fillStyle = "rgba(6, 8, 14, 0.58)";
    ctx.fillRect(cx - trkTw / 2 - trkPadX, trkBoxY, trkTw + trkPadX * 2, trkBoxH + trkPadTop + 3);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 0.85;
    ctx.strokeRect(cx - trkTw / 2 - trkPadX, trkBoxY, trkTw + trkPadX * 2, trkBoxH + trkPadTop + 3);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(210,220,218,0.92)";
    ctx.fillText(topStr, cx, trkLabelY);
    ctx.textBaseline = "alphabetic";
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(cx - halfW, yLine);
    ctx.lineTo(cx + halfW, yLine);
    ctx.stroke();
    for (let delta = -90; delta <= 90; delta += 10) {
      const x = cx + (delta / 90) * halfW;
      const isMajor = delta % 30 === 0;
      const tickH = isMajor ? 5 : 2.5;
      ctx.strokeStyle = isMajor ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.32)";
      ctx.lineWidth = isMajor ? 0.9 : 0.55;
      ctx.beginPath();
      ctx.moveTo(x, yLine);
      ctx.lineTo(x, yLine - tickH);
      ctx.stroke();
      if (!isMajor) continue;
      if (Math.abs(x - cx) < trkClear) continue;
      const brg = normHdg(compassRef + delta);
      const tens = Math.floor(brg / 10) % 36;
      ctx.fillStyle = "rgba(210,220,218,0.9)";
      ctx.font = "600 10px Consolas, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(String(tens), x, yLine - tickH - 2);
      ctx.textBaseline = "alphabetic";
    }
    ctx.strokeStyle = "rgba(232,208,80,0.9)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, yLine);
    ctx.lineTo(cx, yLine - 6);
    ctx.stroke();

    const gnd = resolveNdAirportGnd(tel);
    if (gnd && gnd.icao) {
      ctx.textAlign = "right";
      ctx.font = "700 11px Consolas, ui-monospace, monospace";
      ctx.fillStyle = "rgba(200, 230, 255, 0.92)";
      ctx.fillText(String(gnd.icao), w - 8, 14);
    }
  }

  function syncNdPlanChrome() {
    const bar = document.getElementById("ndPlanZoomBar");
    const lbl = document.getElementById("ndPlanZoomLbl");
    if (!bar || !lbl) return;
    const show = ndPlanMode && planWaypoints.length >= 1;
    bar.hidden = !show;
    lbl.textContent = "×" + ndPlanZoom.toFixed(ndPlanZoom >= 10 ? 0 : 1);
  }

  function syncNdGndZoomChrome() {
    const bar = document.getElementById("ndGndZoomBar");
    const lbl = document.getElementById("ndGndZoomLbl");
    if (!bar || !lbl) return;
    const show = ndArcGndUnderlayVisible(lastTelemetry);
    bar.hidden = !show;
    lbl.textContent = "×" + formatNdGndZoomLabel();
  }

  function syncNdRadarChrome() {
    const terrBtn = document.getElementById("ndTerrToggle");
    const wxBtn = document.getElementById("ndWxToggle");
    const show =
      !ndPlanMode &&
      lastTelemetry &&
      lastTelemetry.ok &&
      !ndArcGndUnderlayVisible(lastTelemetry);
    if (terrBtn) {
      terrBtn.hidden = !show;
      terrBtn.classList.toggle("is-active", ndTerrOn);
      terrBtn.setAttribute("aria-pressed", ndTerrOn ? "true" : "false");
    }
    if (wxBtn) {
      wxBtn.hidden = !show;
      wxBtn.classList.toggle("is-active", ndWxOn);
      wxBtn.setAttribute("aria-pressed", ndWxOn ? "true" : "false");
    }
  }

  function ndLatLonFromNm(acLat, acLon, hdgDeg, fwdNm, crossNm) {
    const h = (normHdg(hdgDeg) * Math.PI) / 180;
    const northNm = fwdNm * Math.cos(h) - crossNm * Math.sin(h);
    const eastNm = fwdNm * Math.sin(h) + crossNm * Math.cos(h);
    const lat = acLat + northNm / 60;
    const cosLat = Math.cos((acLat * Math.PI) / 180);
    const lon = acLon + (Math.abs(cosLat) > 1e-6 ? eastNm / (60 * cosLat) : 0);
    return { lat: lat, lon: lon };
  }

  function ndFwdCrossNm(lat, lon, acLat, acLon, compassRefDeg) {
    const h = (normHdg(compassRefDeg) * Math.PI) / 180;
    const northNm = (lat - acLat) * 60;
    let dLon = lon - acLon;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    const eastNm = dLon * 60 * Math.cos((acLat * Math.PI) / 180);
    return {
      fwd: northNm * Math.cos(h) + eastNm * Math.sin(h),
      cross: -northNm * Math.sin(h) + eastNm * Math.cos(h)
    };
  }

  /** 前方地形 MSL（示意）：沿航向前缘山脊 + 缓丘，近场贴合 SimConnect 标高 */
  function ndTerrainElevFt(lat, lon, acLat, acLon, baseGroundFt, compassRefDeg) {
    const g0 = baseGroundFt != null && Number.isFinite(baseGroundFt) ? baseGroundFt : 0;
    const fc = ndFwdCrossNm(lat, lon, acLat, acLon, compassRefDeg);
    const fwd = fc.fwd;
    const cross = fc.cross;
    const dist = Math.hypot(fwd, cross);
    const fade = Math.min(1, Math.max(0, 1 - dist / 34));
    const phase = g0 * 1.2e-4 + acLat * 0.11 + acLon * 0.07;
    const ridgeA =
      1050 *
      Math.exp(-Math.pow(cross / 9.5, 2)) *
      (0.55 + 0.45 * Math.sin(fwd * 0.11 + phase));
    const ridgeB =
      720 * Math.exp(-Math.pow((fwd - 16) / 11, 2) - Math.pow(cross / 14, 2));
    const ridgeC =
      480 * Math.exp(-Math.pow((fwd - 28) / 9, 2) - Math.pow((cross - 6) / 7, 2));
    const rolling =
      320 * Math.sin(fwd * 0.07 + phase) * Math.cos(cross * 0.09 + 0.35) +
      190 * Math.sin(fwd * 0.19 - cross * 0.14 + phase * 2);
    const fine = adiTerrainRidgeNoise(Math.min(1, Math.max(0, fwd / 32)), lat, lon, g0) * 4.2;
    return g0 + (ridgeA + ridgeB + ridgeC + rolling + fine) * fade;
  }

  /** 地形警戒色（栅格填色，与原风格一致，分段更细） */
  function ndTerrColorForClearance(ft) {
    if (!Number.isFinite(ft)) return null;
    if (ft >= 2200) return null;
    if (ft >= 1800) return "rgba(18, 72, 40, 0.22)";
    if (ft >= 1500) return "rgba(22, 88, 44, 0.36)";
    if (ft >= 1200) return "rgba(28, 105, 48, 0.44)";
    if (ft >= 1000) return "rgba(20, 95, 42, 0.52)";
    if (ft >= 800) return "rgba(180, 155, 32, 0.54)";
    if (ft >= 500) return "rgba(210, 175, 35, 0.58)";
    if (ft >= 300) return "rgba(235, 130, 28, 0.6)";
    if (ft >= 150) return "rgba(220, 55, 38, 0.62)";
    if (ft >= 0) return "rgba(255, 40, 120, 0.68)";
    return "rgba(255, 0, 255, 0.72)";
  }

  function ndWxColorForReflectivity(r) {
    if (!Number.isFinite(r) || r < 0.14) return null;
    if (r < 0.22) return "rgba(30, 120, 45, 0.36)";
    if (r < 0.3) return "rgba(40, 200, 70, 0.42)";
    if (r < 0.38) return "rgba(55, 215, 85, 0.48)";
    if (r < 0.46) return "rgba(60, 220, 90, 0.5)";
    if (r < 0.54) return "rgba(200, 210, 45, 0.52)";
    if (r < 0.62) return "rgba(240, 220, 50, 0.55)";
    if (r < 0.7) return "rgba(255, 160, 35, 0.58)";
    if (r < 0.78) return "rgba(255, 140, 30, 0.58)";
    if (r < 0.86) return "rgba(240, 50, 40, 0.6)";
    if (r < 0.93) return "rgba(255, 30, 30, 0.62)";
    return "rgba(255, 50, 200, 0.62)";
  }

  function ndClipArcPath(ctx, o) {
    ctx.beginPath();
    ctx.arc(o.cx, o.acY, o.Rmax, Math.PI + o.arcTrim, 2 * Math.PI - o.arcTrim, false);
    ctx.lineTo(o.cx, o.acY);
    ctx.closePath();
    ctx.clip();
  }

  function ndWxSweepShouldRun() {
    return !!(
      ndWxOn &&
      !ndPlanMode &&
      lastTelemetry &&
      lastTelemetry.ok &&
      !isUserOnGround(lastTelemetry)
    );
  }

  function resetNdWxSweepAnim() {
    if (ndWxSweepRaf) {
      cancelAnimationFrame(ndWxSweepRaf);
      ndWxSweepRaf = 0;
    }
    ndWxSweepT0 = 0;
  }

  function beginNdWxSweepOnce() {
    resetNdWxSweepAnim();
    if (!ndWxSweepShouldRun()) {
      ndWxSweepPos = 1;
      ndWxSweepDone = true;
      return;
    }
    if (navChartPerfTier() === "phone") {
      ndWxSweepPos = 1;
      ndWxSweepDone = true;
      redrawNd();
      return;
    }
    ndWxSweepDone = false;
    ndWxSweepPos = 0;
    ndWxSweepT0 = performance.now();
    function frame(now) {
      ndWxSweepRaf = 0;
      if (!ndWxSweepShouldRun()) {
        ndWxSweepT0 = 0;
        ndWxSweepPos = 1;
        ndWxSweepDone = true;
        redrawNd();
        return;
      }
      const t = typeof now === "number" ? now : performance.now();
      const elapsed = t - ndWxSweepT0;
      ndWxSweepPos = Math.min(1, elapsed / ND_WX_SWEEP_ONCE_MS);
      redrawNd();
      if (ndWxSweepPos < 1) {
        ndWxSweepRaf = requestAnimationFrame(frame);
      } else {
        ndWxSweepT0 = 0;
        ndWxSweepDone = true;
      }
    }
    ndWxSweepRaf = requestAnimationFrame(frame);
  }

  function drawNdWxSweepBeam(ctx, o, sweep01) {
    if (sweep01 == null || !Number.isFinite(sweep01) || sweep01 <= 0.01 || sweep01 >= 0.995) {
      return;
    }
    const relBrgDeg = -90 + sweep01 * 180;
    const rad = (relBrgDeg * Math.PI) / 180;
    const r = o.Rmax * 1.02;
    const x2 = o.cx + r * Math.sin(rad);
    const y2 = o.acY - r * Math.cos(rad);
    ctx.save();
    ndClipArcPath(ctx, o);
    const g = ctx.createLinearGradient(o.cx, o.acY, x2, y2);
    g.addColorStop(0, "rgba(120, 255, 170, 0.15)");
    g.addColorStop(0.72, "rgba(200, 255, 220, 0.55)");
    g.addColorStop(1, "rgba(235, 255, 245, 0.88)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(o.cx, o.acY);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(245, 255, 250, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.cx, o.acY);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  /** 方块栅格雷达（沿用原 fillRect 风格，密度更高） */
  function drawNdRadarCellGrid(ctx, o, cols, rows, sampleFn, colorFn, sweepFrac, sectorSweep) {
    const maxFwd = o.Rmax / o.pxPerNm;
    const span = maxFwd * 0.96;
    const cellW = Math.max(2, (o.Rmax * 2.06) / cols);
    const cellH = Math.max(2, (span * o.pxPerNm) / rows);
    const sweep =
      sweepFrac != null && Number.isFinite(sweepFrac)
        ? Math.min(1, Math.max(0, sweepFrac))
        : 1;
    const fan = !!sectorSweep;

    ctx.save();
    ndClipArcPath(ctx, o);
    for (let row = 1; row < rows; row++) {
      const fwdNm = (row / rows) * span;
      for (let col = 0; col < cols; col++) {
        const crossNm = ((col + 0.5) / cols - 0.5) * 2 * span;
        const relBrg = (Math.atan2(crossNm, fwdNm) * 180) / Math.PI;
        if (relBrg < -89 || relBrg > 89) continue;
        if (sweep < 1 && fan && relBrg > -90 + sweep * 180) continue;
        const val = sampleFn(fwdNm, crossNm, o);
        const color = colorFn(val);
        if (!color) continue;
        const x = o.cx + crossNm * o.pxPerNm;
        const y = o.acY - fwdNm * o.pxPerNm;
        ctx.fillStyle = color;
        ctx.fillRect(x - cellW * 0.5, y - cellH * 0.5, cellW + 0.6, cellH + 0.6);
      }
    }
    ctx.restore();
  }

  function drawNdTerrainRadar(ctx, o) {
    const altFt = o.altFt;
    if (altFt == null || !Number.isFinite(altFt)) return;
    const cols = Math.max(72, Math.round(o.Rmax / 2.2));
    const rows = Math.max(34, Math.round((o.Rmax / o.pxPerNm) * 1.15));
    drawNdRadarCellGrid(ctx, o, cols, rows, function (fwdNm, crossNm, opt) {
      const ll = ndLatLonFromNm(opt.acLat, opt.acLon, opt.compassRef, fwdNm, crossNm);
      const terr = ndTerrainElevFt(
        ll.lat,
        ll.lon,
        opt.acLat,
        opt.acLon,
        opt.groundElevFt,
        opt.compassRef
      );
      return altFt - terr;
    }, ndTerrColorForClearance);
  }

  function ndWxReflectivity(lat, lon, tel, acLat, acLon) {
    const la = lat * 0.29;
    const lo = lon * 0.19;
    let r =
      0.2 +
      0.26 * (Math.sin(la * 1.3 + lo * 0.9) * 0.5 + 0.5) +
      0.2 * (Math.cos(la * 2.7 - lo * 1.6) * 0.5 + 0.5) +
      0.12 * (Math.sin(la * 4.2 + lo * 3.1) * 0.5 + 0.5);
    if (!tel || !tel.ok) return Math.min(1, r * 0.62);
    const dNm = haversineNm(acLat, acLon, lat, lon);
    if (tel.in_cloud === true && dNm < 30) {
      r = Math.min(1, r + 0.42 * Math.exp(-dNm / 8));
    }
    const precip = tel.precip_rate;
    if (precip != null && Number.isFinite(precip) && precip > 0) {
      const p = Math.min(1, precip / 80);
      r = Math.min(1, r + p * Math.exp(-dNm / 13));
    }
    const vis = tel.visibility_m;
    if (vis != null && Number.isFinite(vis) && vis < 4800 && dNm < 22) {
      r = Math.min(1, r + 0.28 * (1 - vis / 4800));
    }
    return Math.min(1, Math.max(0, r));
  }

  function drawNdWeatherRadar(ctx, o) {
    const cols = Math.max(68, Math.round(o.Rmax / 2.35));
    const rows = Math.max(32, Math.round((o.Rmax / o.pxPerNm) * 1.08));
    const sweeping = ndWxOn && !ndWxSweepDone && ndWxSweepShouldRun();
    const sweep = sweeping ? ndWxSweepPos : 1;
    drawNdRadarCellGrid(
      ctx,
      o,
      cols,
      rows,
      function (fwdNm, crossNm, opt) {
        const ll = ndLatLonFromNm(opt.acLat, opt.acLon, opt.compassRef, fwdNm, crossNm);
        let r = ndWxReflectivity(ll.lat, ll.lon, opt.tel, opt.acLat, opt.acLon);
        const dist = Math.hypot(fwdNm, crossNm);
        const maxR = (opt.Rmax / opt.pxPerNm) * 0.96;
        r *= 1 - 0.22 * Math.min(1, dist / maxR);
        return r;
      },
      ndWxColorForReflectivity,
      sweep,
      true
    );
    if (sweeping) drawNdWxSweepBeam(ctx, o, sweep);
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

    const nav = navAcState();
    const acLat = nav ? nav.lat : lastTelemetry.lat;
    const acLon = nav ? nav.lon : lastTelemetry.lon;
    const acAlt =
      nav && nav.alt != null && Number.isFinite(nav.alt)
        ? nav.alt
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
    ctx.fillText("VNAV", padL + 1, 9);
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
    ctx.fillText("AHEAD " + nmA.toFixed(0) + " NM", padL + 1, h - 2);

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

  /** 与 msfs_bridge _heading_simconnect_to_deg 一致，避免弧度/角度混用导致机头猛转 */
  function normalizeTrafficHeadingDeg(h) {
    if (h == null || !Number.isFinite(h)) return null;
    const ax = Math.abs(h);
    const deg = ax <= 2 * Math.PI + 0.05 ? (h * 180) / Math.PI : h;
    return normHdg(deg);
  }

  function applyTrafficMarkerHeading(wrap, id, hdgIn) {
    if (!wrap || id == null) return;
    const hdg = normalizeTrafficHeadingDeg(hdgIn);
    if (hdg == null) return;
    const key = String(id);
    let st = trafficHdgById[key];
    if (!st) {
      trafficHdgById[key] = { deg: hdg };
      wrap.style.transition = "none";
      wrap.style.transform = "rotate(" + hdg + "deg)";
      return;
    }
    let delta = hdg - st.deg;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    if (Math.abs(delta) > 95) {
      st.deg = hdg;
    } else {
      st.deg = normHdg(st.deg + delta);
    }
    wrap.style.transition = "none";
    wrap.style.transform = "rotate(" + st.deg + "deg)";
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

  /** ND 交通：按相对我机高度着色，粉=地面，冲突时红/黄框 */
  function drawNdTrafficSymbol(ctx, x, y, hdgMag, compassRefDeg, style) {
    ctx.save();
    ctx.translate(x, y);
    if (hdgMag != null && Number.isFinite(hdgMag) && compassRefDeg != null && Number.isFinite(compassRefDeg)) {
      ctx.rotate((normHdg(hdgMag - compassRefDeg) * Math.PI) / 180);
    }
    var fill = trafficAltBandColor(style);
    if (style === "ra") fill = "#ff453a";
    else if (style === "ta") fill = "#ffd60a";
    if (style === "ra") {
      ctx.strokeStyle = "#ff453a";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-5.5, -6, 11, 12);
    } else if (style === "ta") {
      ctx.strokeStyle = "#ffd60a";
      ctx.lineWidth = 1;
      ctx.strokeRect(-5, -5.5, 10, 11);
    }
    ctx.fillStyle = fill;
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(4, 4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function ndTrafficFromTelemetry() {
    if (!showTraffic || !lastTelemetry || !Array.isArray(lastTelemetry.traffic)) return [];
    return lastTelemetry.traffic;
  }

  function updatePfdNdToolbarStats(tel) {
    const gsEl = document.getElementById("ndStatGs");
    const tasEl = document.getElementById("ndStatTas");
    const trkEl = document.getElementById("ndStatTrk");
    const windEl = document.getElementById("ndStatWind");
    const acEl = document.getElementById("ndStatAc");
    const t = tel && tel.ok ? tel : lastTelemetry && lastTelemetry.ok ? lastTelemetry : null;
    const gs =
      t && t.groundspeed_knots != null && Number.isFinite(t.groundspeed_knots)
        ? t.groundspeed_knots
        : null;
    if (gsEl) gsEl.textContent = fmtNum(gs, 0);
    if (tasEl) {
      const tas = t ? tasKnotsFromTelemetry(t) : null;
      tasEl.textContent = tas != null ? String(tas) : "—";
    }
    let trk = null;
    if (t) {
      if (t.ground_track_deg != null && Number.isFinite(t.ground_track_deg)) trk = normHdg(t.ground_track_deg);
      else if (t.heading_deg != null && Number.isFinite(t.heading_deg)) trk = normHdg(t.heading_deg);
    }
    if (trkEl) trkEl.textContent = trk != null ? fmtNum(trk, 0) : "—";
    const windStr = t ? formatWindDisplay(t) : null;
    if (windEl) windEl.textContent = windStr || "—";
    let acN = 0;
    if (t && Array.isArray(t.traffic) && showTraffic) acN = t.traffic.length;
    if (acEl) acEl.textContent = String(acN);
  }

  function syncNdTrafficChrome() {
    const trfBtn = document.getElementById("ndTrafficToggle");
    const altBtn = document.getElementById("ndAlertToggle");
    if (trfBtn) {
      trfBtn.classList.toggle("is-active", showTraffic);
      trfBtn.setAttribute("aria-pressed", showTraffic ? "true" : "false");
      trfBtn.title = showTraffic
        ? "TRF on: click to hide traffic"
        : "TRF off: click to show traffic";
    }
    if (altBtn) {
      altBtn.classList.toggle("is-active", showCollisionAlerts);
      altBtn.setAttribute("aria-pressed", showCollisionAlerts ? "true" : "false");
      altBtn.title = showCollisionAlerts
        ? "TCAS on: click to disable alerts"
        : "TCAS off: click to enable alerts";
    }
  }

  function syncNdToolbarChrome() {
    syncNdRadarChrome();
    syncNdTrafficChrome();
    updatePfdNdToolbarStats(lastTelemetry);
  }

  function drawNdTrafficArc(ctx, traffic, projectPt, compassRefDeg, maxNm) {
    if (!traffic.length) return;
    const lim = maxNm != null && Number.isFinite(maxNm) ? maxNm : ND_RANGE_NM;
    for (let ti = 0; ti < traffic.length; ti++) {
      const t = traffic[ti];
      if (!t || t.lat == null || t.lon == null) continue;
      const p = projectPt(t.lat, t.lon);
      if (Math.hypot(p.cross, p.fwd) > lim) continue;
      drawNdTrafficSymbol(
        ctx,
        p.x,
        p.y,
        t.heading_deg,
        compassRefDeg,
        trafficDisplayStyle(t, lastTelemetry)
      );
    }
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
    syncNdGndZoomChrome();
    syncNdToolbarChrome();

    const ndArcGndHudEarly =
      !ndPlanMode &&
      lastTelemetry &&
      lastTelemetry.ok &&
      isUserOnGround(lastTelemetry);
    const TOP_H = ndArcGndHudEarly ? ND_GND_HDR_H : 18;
    const BOT_H = 4;
    const acY = ndArcGndHudEarly ? h - ND_GND_BOT_PAD - 8 : h - BOT_H - 6;
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
      const nav = navAcState();
      acLat = nav ? nav.lat : lastTelemetry.lat;
      acLon = nav ? nav.lon : lastTelemetry.lon;
      hdgN = normHdg(
        nav && nav.hdg != null && Number.isFinite(nav.hdg)
          ? nav.hdg
          : lastTelemetry.heading_deg != null
            ? lastTelemetry.heading_deg
            : 0
      );
      trkN = null;
      if (dispTrkShow != null && Number.isFinite(dispTrkShow)) {
        trkN = normHdg(dispTrkShow);
      } else {
        const trkUse =
          tgtTrack != null && Number.isFinite(tgtTrack)
            ? tgtTrack
            : lastTelemetry.ground_track_deg;
        if (trkUse != null && Number.isFinite(trkUse)) trkN = normHdg(trkUse);
      }
      compassRef = hdgN;
      if (planWaypoints.length) advanceWaypoints(acLat, acLon);
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
        ctx.fillText("PLAN: import .pln first", cx, h / 2);
      else
        ctx.fillText("No data · import .pln", cx, acY - Rmax * 0.35);
      drawNdAircraftSymbol(ctx, cx, acY);
      return;
    }

    if (ndPlanMode) {
      if (planWaypoints.length < 1) {
        ctx.fillStyle = "#5a6560";
        ctx.font = "10px Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("PLAN: import .pln first", cx, h / 2 - 6);
        ctx.fillStyle = "rgba(150,170,160,0.85)";
        ctx.font = "9px Segoe UI, sans-serif";
        ctx.fillText("North up · route ahead", cx, h / 2 + 10);
        return;
      }
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

      const ndTrafficPlan = ndTrafficFromTelemetry();
      if (ndTrafficPlan.length && !ndPreviewMode) {
        for (let ti = 0; ti < ndTrafficPlan.length; ti++) {
          const t = ndTrafficPlan[ti];
          if (!t || t.lat == null || t.lon == null) continue;
          const q = planEnuNm(acLat, acLon, t.lat, t.lon);
          if (Math.hypot(q.east, q.north) > ringOuter * 1.08) continue;
          const tp = projPlan(t.lat, t.lon);
          drawNdTrafficSymbol(
            ctx,
            tp.x,
            tp.y,
            t.heading_deg,
            0,
            trafficDisplayStyle(t, lastTelemetry)
          );
        }
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
        ctx.fillText("PLAN · preview", 6, 14);
        ctx.fillText("North up", 6, 27);
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
    /** 地面滑行：弱化罗盘环/距离圈/航线与导航针，突出机场图 */
    const ndArcGndHud =
      !ndPreviewMode && ndArcGndHudEarly;

    const ndRadarArc =
      !ndPreviewMode && !ndArcGndHud && lastTelemetry && lastTelemetry.ok;
    if (ndRadarArc) {
      const altRadar =
        lastTelemetry.alt_ft != null && Number.isFinite(lastTelemetry.alt_ft)
          ? lastTelemetry.alt_ft
          : dispAlt;
      const radarOpt = {
        cx: cx,
        acY: acY,
        Rmax: Rmax,
        arcTrim: arcTrim,
        pxPerNm: pxPerNm,
        acLat: acLat,
        acLon: acLon,
        compassRef: compassRef
      };
      if (ndTerrOn) {
        drawNdTerrainRadar(ctx, {
          altFt: altRadar,
          groundElevFt: lastTelemetry.ground_elev_ft,
          cx: radarOpt.cx,
          acY: radarOpt.acY,
          Rmax: radarOpt.Rmax,
          arcTrim: radarOpt.arcTrim,
          pxPerNm: radarOpt.pxPerNm,
          acLat: radarOpt.acLat,
          acLon: radarOpt.acLon,
          compassRef: radarOpt.compassRef
        });
      }
      if (ndWxOn) {
        drawNdWeatherRadar(ctx, {
          tel: lastTelemetry,
          cx: radarOpt.cx,
          acY: radarOpt.acY,
          Rmax: radarOpt.Rmax,
          arcTrim: radarOpt.arcTrim,
          pxPerNm: radarOpt.pxPerNm,
          acLat: radarOpt.acLat,
          acLon: radarOpt.acLon,
          compassRef: radarOpt.compassRef
        });
      }
    }

    const ndShowAirportMap = ndArcGndUnderlayVisible(lastTelemetry);
    if (!ndShowAirportMap) {
      ndGndWasOnGround = false;
    }
    if (ndShowAirportMap) {
      drawNdAirportGndUnderlay(
        ctx,
        acLat,
        acLon,
        cx,
        acY,
        w,
        h,
        TOP_H,
        lastTelemetry,
        compassRef,
        ndArcGndHud ? 0.88 : 0.72,
        true
      );
      drawNdTrafficGndMap(
        ctx,
        ndTrafficFromTelemetry(),
        acLat,
        acLon,
        cx,
        acY,
        w,
        h,
        TOP_H,
        compassRef,
        lastTelemetry
      );
    }

    if (!ndArcGndHud) {
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
    }

    if (!ndArcGndHud && planWaypoints.length >= 2) {
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

    if (!ndArcGndHud && !ndPreviewMode) {
      const trailRaw = lastTelemetry.trail || [];
      const trailSlice = trailRaw.length > 180 ? trailRaw.slice(-180) : trailRaw;
      if (trailSlice.length >= 2) {
        const asWp = trailSlice.map(function (p) { return { lat: p[0], lon: p[1] }; });
        drawRoute(asWp, "rgba(55, 200, 100, 0.38)", 1.45);
      }
    }

    const routeAhead = ndRemainingPlanPoints();
    if (!ndArcGndHud && !ndPreviewMode && routeAhead.length >= 2) {
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

    if (!ndShowAirportMap) {
      drawNdTrafficArc(ctx, ndTrafficFromTelemetry(), projectPt, compassRef, ND_RANGE_NM * 1.05);
    }

    if (!ndArcGndHud) {
      drawNdTrackCaret(ctx, cx, acY - Rmax);
      ctx.strokeStyle = COL_WHITE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, acY);
      ctx.lineTo(cx, acY - Rmax);
      ctx.stroke();
    }

    if (!ndArcGndHud && planWaypoints.length && nextWpSeq < planWaypoints.length) {
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
      ctx.fillText("Route loaded", 6, 14);
      ctx.fillText("Connect for live pos", 6, 26);
    } else if (ndArcGndHud) {
      drawNdGndGroundChrome(ctx, w, cx, compassRef, trkN, hdgN, lastTelemetry);
    } else {
      const gs = lastTelemetry.groundspeed_knots;
      const tasDisp = tasKnotsFromTelemetry(lastTelemetry);
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

      if (ndTerrOn || ndWxOn) {
        ctx.font = "600 7px Consolas, ui-monospace, monospace";
        ctx.textAlign = "right";
        let legY = h - 5;
        if (ndWxOn) {
          ctx.fillStyle = "rgba(255, 180, 90, 0.9)";
          ctx.fillText("WX", w - 5, legY);
          legY -= 9;
        }
        if (ndTerrOn) {
          ctx.fillStyle = "rgba(110, 190, 255, 0.9)";
          ctx.fillText("TERR", w - 5, legY);
        }
      }

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

      /* 航路块：左下（GS/风之下）；空中恢复 */
      const ndNavL = 6;
      const ndNavY0 = 42;
      const ndNavDy = 10;
      ctx.textAlign = "left";
      ctx.font = "600 10px Consolas, ui-monospace, monospace";
      if (!ndArcGndHud && planWaypoints.length && nextWpSeq < planWaypoints.length) {
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
      } else if (!ndArcGndHud) {
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

    if (!ndShowAirportMap) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, acY + 7, w, h - acY - 7);
    }
  }

  function measureNdCssSize() {
    const wrap = document.getElementById("ndPanel");
    if (!wrap) return { w: ND_CSS_W_MIN, h: ND_CSS_H };
    const w = Math.max(ND_CSS_W_MIN, Math.floor(wrap.clientWidth) || ND_CSS_W_MIN);
    const h = Math.max(ND_CSS_H, Math.floor(wrap.clientHeight) || ND_CSS_H);
    return { w: w, h: h };
  }

  function resizeNd() {
    const c = document.getElementById("ndCanvas");
    if (!c) return;
    const sz = measureNdCssSize();
    ndCssW = sz.w;
    ndCssH = sz.h;
    ndDpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(ndCssW * ndDpr);
    c.height = Math.round(ndCssH * ndDpr);
    c.style.width = "100%";
    c.style.height = ndCssH + "px";
    redrawNd();
    updateCollisionWarnings(lastTelemetry);
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
    const pts = planWaypoints.map(function (w) {
      return [w.lat, wrapLng180(w.lon)];
    });
    if (marker) {
      const m = marker.getLatLng();
      pts.push([m.lat, m.lng]);
    }
    if (pts.length === 0) return;
    let latlngs = unwrapLatLngsForPolyline(pts);
    if (latlngs.length) {
      latlngs = shiftLngStripToRef(latlngs, latlngs[0][1]);
    }
    const b = L.latLngBounds(latlngs);
    if (!b.isValid()) return;
    map.fitBounds(b, { padding: [48, 48], maxZoom: 12 });
    scheduleMapLayoutRefresh(followPlane);
  }

  function syncPlanToServer() {
    var payload = { clear: true };
    if (planWaypoints.length) {
      payload = { title: planTitle, waypoints: planWaypoints };
      if (planPlnXml) payload.plnXml = planPlnXml;
    }
    return fetch(PLAN_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && typeof j.rev === "number") lastServerPlanRev = j.rev;
      })
      .catch(function () {});
  }

  function loadPlanToMsfs(options) {
    var silent = options && options.silent;
    if (!planWaypoints.length && !planPlnXml) {
      if (!silent) alert("请先导入 .pln 航线");
      return Promise.resolve(false);
    }
    var body = { use_shared: true };
    if (planPlnXml) {
      body = { pln_xml: planPlnXml, title: planTitle || "msfs_map_route" };
    }
    if (btnLoadMsfs) {
      btnLoadMsfs.disabled = true;
      btnLoadMsfs.classList.add("is-busy");
    }
    return fetch(PLAN_LOAD_MSFS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        var j = res.j || {};
        if (j.ok) {
          var msg = "已载入模拟飞行飞行计划";
          if (j.hint) msg += " · " + j.hint;
          planinfoEl.textContent =
            (planTitle ? planTitle + " · " : "") + msg;
          if (!silent) {
            setStatus(true, "<strong>飞行计划已载入</strong>", "");
          }
          return true;
        }
        var err = j.error || "载入失败";
        if (!silent) alert(err);
        else setStatus(false, "载入 MSFS 失败", err);
        return false;
      })
      .catch(function (e) {
        if (!silent) alert("无法连接桥接服务：" + String(e));
        return false;
      })
      .finally(function () {
        if (btnLoadMsfs) {
          btnLoadMsfs.disabled = false;
          btnLoadMsfs.classList.remove("is-busy");
        }
      });
  }

  function maybeAutoLoadMsfs() {
    if (!chkAutoLoadMsfs || !chkAutoLoadMsfs.checked) return;
    loadPlanToMsfs({ silent: true });
  }

  function applyServerPlan(plan) {
    if (!plan || !plan.waypoints || !plan.waypoints.length) {
      clearPlan({ skipRemote: true });
      return;
    }
    planTitle = plan.title || "";
    planWaypoints = plan.waypoints;
    planPlnXml = typeof plan.plnXml === "string" ? plan.plnXml : "";
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
        JSON.stringify({ title: planTitle, waypoints: planWaypoints, plnXml: planPlnXml || undefined })
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
      planPlnXml = typeof data.plnXml === "string" ? data.plnXml : "";
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
    planPlnXml = "";
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
    if (!data.ok) {
      lastTelemetry = data;
      const reconnecting =
        data.error && String(data.error).indexOf("重连") >= 0;
      if (!reconnecting) {
        smoothReady = false;
        tapeDispReady = false;
        resetPfdVertSmooth();
        resetMotion();
        lastSmoothT = 0;
        dispPitch = 0;
        dispBank = 0;
        stabilizeTrafficList([], null, null, null);
        updateTraffic([]);
        updateCollisionWarnings(null);
        updateTcassSuppressMapOverlay(null);
      }
      /* 短时断流仍带航迹：有 trail 则保留绿线，无字段或空数组才清空，避免飞一半整段消失 */
      if (Array.isArray(data.trail)) {
        if (data.trail.length >= 2) {
          updateTrail(data.trail.map(function (p) { return [p[0], p[1]]; }));
        } else if (data.trail.length === 0) updateTrail([]);
      }
      updatePfdInstruments(null);
      resetNdWxSweepAnim();
      ndWxSweepPos = 1;
      ndWxSweepDone = true;
      if (!reconnecting) {
        redrawNd();
        redrawAdiVnavProfile();
      }
      syncNdToolbarChrome();
      setStatus(
        reconnecting,
        reconnecting ? "SimConnect 重连中…" : data.error || "未知错误",
        reconnecting
          ? "连接曾短暂中断，约 1 秒内自动恢复；请保持模拟飞行运行。"
          : "请确认已运行 启动.bat 且模拟飞行已进入驾驶舱。"
      );
      return;
    }
    const lat = data.lat;
    const lon = data.lon;
    const hdg = data.heading_deg;
    const ll = [lat, wrapLng180(lon)];

    syncTgtFromAnchor(telemetryToAnchor(data));

    if (!marker) {
      marker = L.marker(L.latLng(ll[0], ll[1]), { icon: planeIcon }).addTo(map);
      const z0 = Math.max(map.getZoom(), 11);
      map.setZoom(z0);
      followPlane = true;
      scheduleMapLayoutRefresh(true);
    }

    const uiNow = performance.now();
    const doUi = uiNow - lastPayloadUiT >= PAYLOAD_UI_MIN_MS;
    const trail = (data.trail || []).map(function (p) { return [p[0], p[1]]; });
    const trailChanged =
      trail.length !== lastPayloadTrailLen ||
      uiNow - lastPayloadTrailT >= PAYLOAD_TRAIL_MIN_MS;
    if (doUi) lastPayloadUiT = uiNow;
    if (trailChanged) {
      lastPayloadTrailT = uiNow;
      lastPayloadTrailLen = trail.length;
      updateTrail(trail);
    }
    data.traffic = stabilizeTrafficList(
      data.traffic || [],
      lat,
      lon,
      data.traffic_scan
    );
    if (
      data.airport_gnd &&
      data.airport_gnd.icao &&
      ndGndSnapshot &&
      ndGndSnapshot.icao &&
      ndGndSnapshot.icao !== data.airport_gnd.icao
    ) {
      ndGndSnapshot = null;
      ndGndSnapshotAt = 0;
    }
    lastTelemetry = data;
    updateMapAircraftMarker();
    updatePfdInstruments(data);
    if (doUi) {
      updateTcassSuppressMapOverlay(data);
      redrawNd();
      redrawAdiVnavProfile();
      updateCollisionWarnings(data);
      updateTraffic(data.traffic);
      syncNdToolbarChrome();
      planHudLine(lat, lon);
      let statusTitle =
        "<strong>已连接</strong> · " + fmtNum(lat, 5) + "°, " + fmtNum(lon, 5) + "°";
      if (isUserOnGround(data)) statusTitle += " · 地面";
      else if (isTcasSuppressZone(data)) statusTitle += " · TCAS 关";
      setStatus(true, statusTitle, "");
    }
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
        const data = JSON.parse(ev.data);
        applyPayload(data);
        if (data && !data.ok && data.error) {
          setStatus(
            false,
            data.error,
            "请确认微软模拟飞行已运行并进入驾驶舱，然后重启 msfs_bridge.py。"
          );
        }
      } catch (e) {
        setStatus(false, "JSON 解析失败", String(e));
      }
    };
    es.onerror = function () {
      lastTelemetry = { ok: false };
      smoothReady = false;
      tapeDispReady = false;
      resetPfdVertSmooth();
      resetMotion();
      lastSmoothT = 0;
      dispPitch = 0;
      dispBank = 0;
      /* 不重清航迹：EventSource 重连前常会触发 onerror，误删整条绿线 */
      updatePfdInstruments(null);
      redrawAdiVnavProfile();
      redrawNd();
      setStatus(false, "数据流中断", "请保持 msfs_bridge.py 运行；浏览器会自动重连。");
    };
  }

  btnImport.addEventListener("click", function () { plnFile.click(); });
  plnFile.addEventListener("change", function () {
    const f = plnFile.files && plnFile.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = function () {
      try {
        const raw = String(r.result || "");
        const parsed = parsePlnXml(raw);
        planTitle = parsed.title || f.name.replace(/\.pln$/i, "");
        planWaypoints = parsed.waypoints;
        planPlnXml = raw;
        nextWpSeq = 0;
        redrawPlanOnMap();
        fitPlanBounds();
        planinfoEl.textContent =
          "已加载 " + planWaypoints.length + " 个航点（本机已保存，已同步到局域网）" + (planTitle ? " · " + planTitle : "");
        savePlanToStorage({ skipRemote: true });
        if (lastTelemetry && lastTelemetry.ok)
          planHudLine(lastTelemetry.lat, lastTelemetry.lon);
        redrawNd();
        redrawAdiVnavProfile();
        syncPlanToServer().then(function () { maybeAutoLoadMsfs(); });
      } catch (e) {
        alert(e.message || String(e));
      }
      plnFile.value = "";
    };
    r.readAsText(f, "UTF-8");
  });

  if (btnLoadMsfs) {
    btnLoadMsfs.addEventListener("click", function () {
      syncPlanToServer().then(function () { loadPlanToMsfs(); });
    });
  }
  if (chkAutoLoadMsfs) {
    try {
      chkAutoLoadMsfs.checked = localStorage.getItem(AUTO_LOAD_MSFS_KEY) === "1";
    } catch (eChk) {}
    chkAutoLoadMsfs.addEventListener("change", function () {
      try {
        localStorage.setItem(AUTO_LOAD_MSFS_KEY, chkAutoLoadMsfs.checked ? "1" : "0");
      } catch (eStore2) {}
    });
  }

  btnFit.addEventListener("click", fitPlanBounds);
  btnClear.addEventListener("click", function () { clearPlan(); });
  btnFollow.addEventListener("click", function () {
    followPlane = true;
    scheduleMapLayoutRefresh(true);
    refollowMapCenter();
  });

  const ndTrafficToggle = document.getElementById("ndTrafficToggle");
  if (ndTrafficToggle) {
    ndTrafficToggle.addEventListener("click", function () {
      showTraffic = !showTraffic;
      syncNdTrafficChrome();
      updateTraffic(lastTrafficList);
      updatePfdNdToolbarStats(lastTelemetry);
      redrawNd();
    });
  }
  const ndAlertToggle = document.getElementById("ndAlertToggle");
  if (ndAlertToggle) {
    ndAlertToggle.addEventListener("click", function () {
      showCollisionAlerts = !showCollisionAlerts;
      syncNdTrafficChrome();
      updateCollisionWarnings(lastTelemetry);
      refreshTrafficMarkerStyles();
      redrawNd();
    });
  }

  const ndTerrToggle = document.getElementById("ndTerrToggle");
  if (ndTerrToggle) {
    ndTerrToggle.addEventListener("click", function () {
      ndTerrOn = !ndTerrOn;
      syncNdToolbarChrome();
      redrawNd();
    });
  }
  const ndWxToggle = document.getElementById("ndWxToggle");
  if (ndWxToggle) {
    ndWxToggle.addEventListener("click", function () {
      ndWxOn = !ndWxOn;
      if (ndWxOn) beginNdWxSweepOnce();
      else {
        resetNdWxSweepAnim();
        ndWxSweepPos = 1;
        ndWxSweepDone = true;
      }
      syncNdToolbarChrome();
      redrawNd();
    });
  }

  const ndPlanToggle = document.getElementById("ndPlanToggle");
  if (ndPlanToggle) {
    ndPlanToggle.addEventListener("click", function () {
      ndPlanMode = !ndPlanMode;
      if (ndPlanMode) {
        resetNdWxSweepAnim();
        ndWxSweepPos = 1;
        ndGndLayoutIcao = null;
        ndGndLayoutFitKey = null;
        ndGndWasOnGround = false;
      }
      ndPlanToggle.classList.toggle("is-active", ndPlanMode);
      ndPlanToggle.setAttribute("aria-pressed", ndPlanMode ? "true" : "false");
      ndPlanToggle.title = ndPlanMode
        ? "PLAN on: tap for ARC"
        : "PLAN: north up, route ahead";
      if (!ndPlanMode) ndPlanZoom = 1;
      syncNdPlanChrome();
      syncNdToolbarChrome();
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
  const ndGndZoomIn = document.getElementById("ndGndZoomIn");
  const ndGndZoomOut = document.getElementById("ndGndZoomOut");
  if (ndGndZoomIn) {
    ndGndZoomIn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!ndArcGndUnderlayVisible(lastTelemetry)) return;
      ndGndZoomDisp = ndGndClamp(
        ndGndZoomDisp + ND_GND_ZOOM_DISP_STEP,
        ND_GND_ZOOM_DISP_MIN,
        ND_GND_ZOOM_DISP_MAX
      );
      ndGndUserOverrodeZoom = true;
      syncNdGndZoomChrome();
      redrawNd();
    });
  }
  if (ndGndZoomOut) {
    ndGndZoomOut.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!ndArcGndUnderlayVisible(lastTelemetry)) return;
      ndGndZoomDisp = ndGndClamp(
        ndGndZoomDisp - ND_GND_ZOOM_DISP_STEP,
        ND_GND_ZOOM_DISP_MIN,
        ND_GND_ZOOM_DISP_MAX
      );
      ndGndUserOverrodeZoom = true;
      syncNdGndZoomChrome();
      redrawNd();
    });
  }

  map.on("dragstart", function () { followPlane = false; });
  map.on("click", function () {
    if (!trafficPinnedId) return;
    trafficPinnedId = null;
    refreshTrafficTooltips();
    redrawPinnedTrafficTrack();
  });

  installMapFollowZoomHandlers();
  let mapFollowZoomReflowT = 0;
  map.on("zoom", function () {
    if (!followPlane) return;
    if (mapFollowZoomReflowT) return;
    mapFollowZoomReflowT = requestAnimationFrame(function () {
      mapFollowZoomReflowT = 0;
      setMapFollowView(map.getZoom());
    });
  });
  map.on("zoomend", function () {
    if (mapFollowZoomReflowT) {
      cancelAnimationFrame(mapFollowZoomReflowT);
      mapFollowZoomReflowT = 0;
    }
    refollowMapCenter();
  });

  buildPitchLadder();
  resizeNd();
  resizeAdiVnav();
  (function watchNdPanelWidth() {
    const panel = document.getElementById("ndPanel");
    if (!panel || !window.ResizeObserver) return;
    try {
      new ResizeObserver(function () {
        scheduleResizeNd();
      }).observe(panel);
    } catch (eNdRo) {
      /* ignore */
    }
  })();
  window.addEventListener("resize", function () {
    scheduleResizeNd();
    resizeAdiVnav();
    scheduleMapLayoutRefresh(followPlane);
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
      btn.title = collapsed ? "Expand PFD" : "Collapse PFD";
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
      scheduleMapLayoutRefresh(followPlane);
    });
  })();

  /**
   * 仪表整卡等比例缩放：「可用宽度 ÷ 未缩放面板外宽」；不测缩放后的 offsetWidth，避免 zoom/transform 与
   * ResizeObserver 反馈。手机浏览器另：视口宽度 > 920px 时不缩放（与大屏横屏一致）。
   * 电脑端：全屏时也略缩小（少挡地图），窄窗仍优先 min(舒适上限, 可用比例) 以免裁切。
   */
  whenPfdScaleReady = (function initMobilePfdScale() {
    var panel = document.getElementById("pfdPanel");
    var wrap = document.querySelector(".cockpit-deck-wrap");
    var readyCbs = [];
    var scalePaintPending = false;
    if (!panel || !wrap) {
      return function (cb) {
        if (typeof cb === "function") cb();
      };
    }
    var BP = 920;
    var DESIGN_MIN = 740;
    var DESKTOP_COMFORT_MAX = 0.88;
    var naturalOuterW = null;
    var lastAvailW = -1;
    var lastAppliedScale = null;
    var scaleRaf = 0;
    var scaleTimer = 0;
    var initialMeasureDone = false;

    function availWidthPx() {
      var st = window.getComputedStyle(wrap);
      var pl = parseFloat(st.paddingLeft) || 0;
      var pr = parseFloat(st.paddingRight) || 0;
      return Math.max(0, wrap.clientWidth - pl - pr);
    }

    function invalidateNaturalW() {
      naturalOuterW = null;
      lastAvailW = -1;
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

    /** 已缩放时反推自然宽，避免 clearScale 造成闪屏 */
    function measureNaturalOuterW() {
      if (
        initialMeasureDone &&
        lastAppliedScale != null &&
        lastAppliedScale > 0 &&
        lastAppliedScale < 0.995
      ) {
        var rw = panel.getBoundingClientRect().width;
        if (rw > 0) {
          naturalOuterW = Math.max(DESIGN_MIN, rw / lastAppliedScale);
          return naturalOuterW;
        }
      }
      var hide = !panel.classList.contains("is-scale-ready");
      if (hide) panel.classList.remove("is-scale-ready");
      clearScale();
      naturalOuterW = Math.max(DESIGN_MIN, panel.offsetWidth || DESIGN_MIN);
      initialMeasureDone = true;
      return naturalOuterW;
    }

    function fireScaleReady() {
      if (panel.classList.contains("is-scale-ready")) return;
      if (scalePaintPending) return;
      scalePaintPending = true;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          scalePaintPending = false;
          panel.classList.add("is-scale-ready");
          var cbs = readyCbs.slice();
          readyCbs.length = 0;
          for (var i = 0; i < cbs.length; i++) {
            try {
              cbs[i]();
            } catch (eCb) {
              /* ignore */
            }
          }
        });
      });
    }

    function applyZoomScale(sUse) {
      if (zoomOk) {
        panel.style.transform = "";
        panel.style.transformOrigin = "";
        panel.style.marginBottom = "";
        panel.style.zoom = String(sUse);
        return;
      }
      panel.style.zoom = "";
      var h = panel.offsetHeight;
      panel.style.transformOrigin = "bottom center";
      panel.style.transform = "scale(" + sUse + ")";
      panel.style.marginBottom = h > 0 ? h * (sUse - 1) + "px" : "";
    }

    /** @returns {boolean} 缩放因子是否相对上次有实质变化 */
    function applyScale(forceRemeasure) {
      var isMobileAdapt = document.documentElement.classList.contains("mobile-adapt");
      if (isMobileAdapt && window.innerWidth > BP) {
        if (lastAppliedScale !== 1) {
          clearScale();
          lastAppliedScale = 1;
          fireScaleReady();
        }
        return false;
      }

      var avail = availWidthPx() - 0.5;
      var needMeasure =
        forceRemeasure ||
        naturalOuterW == null ||
        lastAvailW < 0 ||
        Math.abs(avail - lastAvailW) > 48;
      if (needMeasure) {
        measureNaturalOuterW();
        lastAvailW = avail;
      }

      var wBlk = naturalOuterW;
      var raw = avail > 0 && wBlk > 0 ? avail / wBlk : 0;
      var s = isMobileAdapt
        ? Math.min(1, raw)
        : Math.min(DESKTOP_COMFORT_MAX, raw);
      var sUse = s >= 0.995 ? 1 : s;

      if (
        !forceRemeasure &&
        lastAppliedScale != null &&
        Math.abs(sUse - lastAppliedScale) < 0.015
      ) {
        fireScaleReady();
        return false;
      }

      lastAppliedScale = sUse;
      if (sUse >= 0.995) {
        if (panel.style.zoom || panel.style.transform) clearScale();
        fireScaleReady();
        return true;
      }

      applyZoomScale(sUse);
      fireScaleReady();
      return true;
    }

    function runScale(forceRemeasure, refollowMap) {
      var changed = applyScale(forceRemeasure);
      if (changed && refollowMap) scheduleMapLayoutRefresh(followPlane);
    }

    function scheduleScale(forceRemeasure, refollowMap) {
      if (scaleTimer) clearTimeout(scaleTimer);
      scaleTimer = setTimeout(function () {
        scaleTimer = 0;
        if (scaleRaf) cancelAnimationFrame(scaleRaf);
        scaleRaf = requestAnimationFrame(function () {
          scaleRaf = 0;
          runScale(forceRemeasure, refollowMap);
        });
      }, 120);
    }

    window.addEventListener("resize", function () {
      scheduleScale(false, false);
    });
    window.addEventListener("orientationchange", function () {
      invalidateNaturalW();
      scheduleScale(true, true);
    });
    var btn = document.getElementById("pfdCollapseBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        invalidateNaturalW();
        scheduleScale(true, true);
      });
    }

    scheduleScale(true, false);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        scheduleScale(false, false);
      });
    }

    function whenReady(cb) {
      if (typeof cb !== "function") return;
      if (panel.classList.contains("is-scale-ready")) cb();
      else readyCbs.push(cb);
    }
    var pending = whenPfdScaleReady._pending;
    if (pending && pending.length) {
      whenPfdScaleReady._pending = [];
      for (var pi = 0; pi < pending.length; pi++) whenReady(pending[pi]);
    }
    return whenReady;
  })();

  (function initTcassAudioUnlock() {
    function onUnlock() {
      unlockTcassAudio();
    }
    document.addEventListener("click", onUnlock, { capture: true });
    document.addEventListener("keydown", onUnlock, { capture: true });
    document.addEventListener("touchstart", onUnlock, { capture: true, passive: true });
  })();

  syncNdToolbarChrome();
  whenPfdScaleReady(function () {
    ndGndLayoutIcao = null;
    ndGndLayoutFitKey = null;
    ndGndWasOnGround = false;
    ndGndUserOverrodeZoom = false;
    ndGndZoomDisp = ND_GND_ZOOM_DISP_DEFAULT;
    scheduleResizeNd();
    scheduleMapLayoutRefresh(false);
    connectStream();
  });
  requestAnimationFrame(tickPfdVerticalSmooth);
})();
