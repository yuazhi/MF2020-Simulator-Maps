# -*- coding: utf-8 -*-
"""
MSFS / SimConnect → HTTP + SSE：把飞机位置等数据推送给网页地图。
仅需标准库 HTTP 与 SimConnect，无需安装 websockets。
需已安装并运行微软模拟飞行，且本机为 64 位 Python。
HTTP 监听 0.0.0.0，同局域网手机/平板可用 http://电脑IP:8764/index.html 打开同一航路图（数据仍由本机 SimConnect 提供）。
"""
from __future__ import annotations

import json
import math
import socket
import subprocess
import sys
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import TCPServer, ThreadingMixIn
from pathlib import Path
from urllib.parse import urlparse

DIR = Path(__file__).resolve().parent
HTTP_PORT = 8764
TICK_HZ = 90  # SSE 推送约 90/s；略低于 SimConnect 请求间隔，减少同一包重复
# 航迹点间距：略增大可减少点数，便于保留更长距离（如 5000+ km）
TRAIL_MIN_MOVE_M = 35.0
# 内存中保留的最大航迹点数（约 35m×18万 ≈ 6300 km 量级，视实际间距而定）
TRAIL_MAX_POINTS = 180000
# 每次 SSE 下发的最大点数（均匀抽样），避免 JSON 过大拖慢浏览器
TRAIL_JSON_MAX_POINTS = 10000
# 相邻采样超过此距离（米）视为异常跳变；连续达到 TRAIL_RESET_SPIKE_FRAMES 次才清空航迹（单帧坏数据不再抹掉全程）
TRAIL_RESET_JUMP_M = 400_000.0
TRAIL_RESET_SPIKE_FRAMES = 4
# 前方跑道：自 runways_compact.json 读取；机头 ±85°、约 40 NM 内取多条（ADI 叠绘），runway 仍为最近一条
RUNWAY_JSON = DIR / "runways_compact.json"
RUNWAY_MAX_M = 74_000.0  # 约 40 NM，稍远仍能选出前方跑道以便 SVS 示意
RUNWAYS_CACHE: list[dict] | None = None
_RUNWAY_JSON_MTIME: float | None = None

_sim = None
_aq = None
_trail: list[tuple[float, float]] = []
_last_ll: tuple[float, float] | None = None
_trail_spike_count = 0
_state_lock = threading.Lock()

# 局域网多设备共用航线：由 POST /api/plan 更新，SSE 携带 plan_rev，客户端据此拉取 GET /api/plan
_plan_lock = threading.Lock()
_shared_plan: dict | None = None  # {"title": str, "waypoints": list[dict]}
_plan_rev: int = 0
_PLAN_BODY_MAX = 2_000_000
_PLAN_WP_MAX = 800


def _normalize_shared_plan(data: dict) -> dict | None:
    """校验并规范化航线 JSON；无效则返回 None。"""
    wps = data.get("waypoints")
    if not isinstance(wps, list) or len(wps) == 0:
        return None
    if len(wps) > _PLAN_WP_MAX:
        raise ValueError(f"航点数量超过上限 {_PLAN_WP_MAX}")
    title = data.get("title")
    if title is None:
        title = ""
    elif not isinstance(title, str):
        title = str(title)
    out_wp: list[dict] = []
    for i, w in enumerate(wps):
        if not isinstance(w, dict):
            continue
        try:
            lat = float(w["lat"])
            lon = float(w["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if abs(lat) > 90 or abs(lon) > 180:
            continue
        name = w.get("name", f"WP{i + 1}")
        if name is None:
            name = ""
        elif not isinstance(name, str):
            name = str(name)
        one: dict = {"lat": lat, "lon": lon, "name": name}
        if "altFt" in w:
            try:
                one["altFt"] = float(w["altFt"])
            except (TypeError, ValueError):
                pass
        out_wp.append(one)
    if len(out_wp) < 1:
        return None
    return {"title": title, "waypoints": out_wp}


def _get_plan_payload() -> dict:
    with _plan_lock:
        rev = _plan_rev
        pl = _shared_plan
    return {"rev": rev, "plan": pl}


def _clear_trail() -> None:
    global _trail, _last_ll, _trail_spike_count
    _trail.clear()
    _last_ll = None
    _trail_spike_count = 0


def _error_response(message: str) -> dict:
    """读数失败/暂无数时仍下发已记录的航迹，避免前端因短时抖动整段绿线消失。"""
    out: dict = {"ok": False, "error": message}
    if _last_ll is not None:
        lf, lo = float(_last_ll[0]), float(_last_ll[1])
        out["lat"] = lf
        out["lon"] = lo
        out["trail"] = _trail_payload_for_client(lf, lo)
    else:
        out["trail"] = []
    return out


def _trail_for_json() -> list[list[float]]:
    """将内存中航迹抽样后下发，兼顾长距离与单次传输体积。"""
    n = len(_trail)
    if n == 0:
        return []
    if n <= TRAIL_JSON_MAX_POINTS:
        return [[a, b] for a, b in _trail]
    out: list[list[float]] = []
    denom = max(1, TRAIL_JSON_MAX_POINTS - 1)
    for j in range(TRAIL_JSON_MAX_POINTS):
        idx = int(round(j * (n - 1) / denom))
        if idx >= n:
            idx = n - 1
        p = _trail[idx]
        out.append([p[0], p[1]])
    return out


def _trail_payload_for_client(lat_f: float, lon_f: float) -> list[list[float]]:
    """抽样航迹 + 当前机位末端。保证至少 2 个顶点；否则 Leaflet 不画线，前端会像「航迹突然没了」。"""
    rows: list[list[float]] = [[float(a), float(b)] for a, b in _trail_for_json()]
    # ~1.1 m 纬度偏移，仅在几何退化为单点时用于凑成双点
    dlat_eps = 1.0 / 90_000.0
    if not rows:
        return [[lat_f, lon_f], [lat_f + dlat_eps, lon_f]]
    if _haversine_m(rows[-1][0], rows[-1][1], lat_f, lon_f) > 0.15:
        rows.append([lat_f, lon_f])
    if len(rows) < 2:
        rows.append([lat_f + dlat_eps, lon_f])
    return rows


def _load_runways() -> list[dict]:
    global RUNWAYS_CACHE, _RUNWAY_JSON_MTIME
    try:
        _mt = RUNWAY_JSON.stat().st_mtime
    except OSError:
        _mt = None
    if RUNWAYS_CACHE is not None and _mt == _RUNWAY_JSON_MTIME:
        return RUNWAYS_CACHE
    _RUNWAY_JSON_MTIME = _mt
    RUNWAYS_CACHE = []
    if not RUNWAY_JSON.is_file():
        return RUNWAYS_CACHE
    try:
        raw = json.loads(RUNWAY_JSON.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            rw = raw.get("runways") or raw.get("data")
        else:
            rw = raw
        if isinstance(rw, list):
            RUNWAYS_CACHE = [x for x in rw if isinstance(x, dict)]
    except (json.JSONDecodeError, OSError, TypeError):
        RUNWAYS_CACHE = []
    for item in RUNWAYS_CACHE:
        try:
            la1 = float(item["lat_thr"])
            lo1 = float(item["lon_thr"])
            la2 = float(item["lat_end"])
            lo2 = float(item["lon_end"])
            item["_mid_lat"] = (la1 + la2) / 2.0
            item["_mid_lon"] = (lo1 + lo2) / 2.0
        except (KeyError, TypeError, ValueError):
            item["_mid_lat"] = None
            item["_mid_lon"] = None
    return RUNWAYS_CACHE


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """真方位角 0–360°，起点 → 终点。"""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl_deg = lon2 - lon1
    while dl_deg > 180.0:
        dl_deg -= 360.0
    while dl_deg < -180.0:
        dl_deg += 360.0
    dl = math.radians(dl_deg)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _norm_rel_deg(delta: float) -> float:
    d = delta % 360.0
    if d > 180.0:
        d -= 360.0
    return d


def _nearest_on_runway_centerline_m(
    lat: float, lon: float, la1: float, lo1: float, la2: float, lo2: float
) -> tuple[float, float, float]:
    """跑道中心线上距 (lat,lon) 最近点（平直插值近似）及距离米。"""
    best_d = 1e30
    best_la, best_lo = la1, lo1
    for i in range(33):
        t = i / 32.0
        tla = la1 + (la2 - la1) * t
        tlo = lo1 + (lo2 - lo1) * t
        d = _haversine_m(lat, lon, tla, tlo)
        if d < best_d:
            best_d = d
            best_la, best_lo = tla, tlo
    return best_la, best_lo, best_d


def _runway_bbox_coarse(plat: float, plon: float, rw: dict, max_deg: float = 4.2) -> bool:
    """粗略球面 bbox，全国几千条跑道时避免每帧全量 Haversine。"""
    mla = rw.get("_mid_lat")
    mlo = rw.get("_mid_lon")
    if mla is None or mlo is None:
        return True
    try:
        mlat = float(mla)
        mlon = float(mlo)
    except (TypeError, ValueError):
        return True
    if abs(plat - mlat) > max_deg:
        return False
    dl = abs(plon - mlon) * math.cos(math.radians((plat + mlat) / 2.0))
    return dl <= max_deg


# 姿态仪 SVS：同一前方扇区内最多下发的跑道条数（多跑道平行/交叉时全部叠绘）
ADI_RUNWAY_MAX = 14


def _pick_forward_runways(
    lat: float,
    lon: float,
    heading_deg: float | None,
    alt_ft: float | None,
    max_n: int = ADI_RUNWAY_MAX,
) -> list[dict]:
    """航向前方 ±85°、RUNWAY_MAX_M 内所有跑道，按 score 升序（越前越优先）。"""
    runways = _load_runways()
    if not runways:
        return []
    h = float(heading_deg) if heading_deg is not None and math.isfinite(heading_deg) else 0.0
    scored: list[tuple[float, dict]] = []
    for rw in runways:
        if not _runway_bbox_coarse(lat, lon, rw):
            continue
        try:
            la1 = float(rw["lat_thr"])
            lo1 = float(rw["lon_thr"])
            la2 = float(rw["lat_end"])
            lo2 = float(rw["lon_end"])
            wid = float(rw.get("width_m", 45))
            elv = float(rw.get("elev_ft", 0))
        except (KeyError, TypeError, ValueError):
            continue
        cls_la, cls_lo, d_m = _nearest_on_runway_centerline_m(lat, lon, la1, lo1, la2, lo2)
        if d_m > RUNWAY_MAX_M:
            continue
        brg = _bearing_deg(lat, lon, cls_la, cls_lo)
        rel = _norm_rel_deg(brg - h)
        if abs(rel) > 85.0:
            continue
        score = d_m + abs(rel) * 350.0
        item = {
            "icao": str(rw.get("icao", "")),
            "rw": str(rw.get("rw", "")),
            "lat_thr": la1,
            "lon_thr": lo1,
            "lat_end": la2,
            "lon_end": lo2,
            "width_m": wid,
            "elev_ft": elv,
            "dist_m": round(d_m, 1),
            "brg_deg": round(brg, 1),
            "dist_nm": round(d_m / 1852.0, 2),
        }
        scored.append((score, item))
    scored.sort(key=lambda t: t[0])
    return [t[1] for t in scored[:max_n]]


def _pick_forward_runway(
    lat: float, lon: float, heading_deg: float | None, alt_ft: float | None
) -> dict | None:
    """兼容：仅返回最近一条前方跑道。"""
    xs = _pick_forward_runways(lat, lon, heading_deg, alt_ft, max_n=1)
    return xs[0] if xs else None


def _try_gps_runway_hint(_aq) -> dict | None:
    """若 SimConnect 提供下一航点经纬度，用于与跑道入口对齐（可选）。"""
    for lk, ln in (
        ("GPS WP NEXT LAT", "GPS WP NEXT LON"),
        ("GPS_WP_NEXT_LAT", "GPS_WP_NEXT_LON"),
    ):
        try:
            nlat = _aq.get(lk)
            nlon = _aq.get(ln)
        except Exception:
            continue
        if nlat is None or nlon is None:
            continue
        try:
            return {"lat": float(nlat), "lon": float(nlon)}
        except (TypeError, ValueError):
            continue
    return None


def _merge_gps_threshold(rw: dict | None, _aq) -> dict | None:
    if rw is None:
        return None
    hint = _try_gps_runway_hint(_aq)
    if hint is None:
        return rw
    d = _haversine_m(hint["lat"], hint["lon"], rw["lat_thr"], rw["lon_thr"])
    if d > 1200.0:
        return rw
    out = dict(rw)
    out["lat_thr"] = hint["lat"]
    out["lon_thr"] = hint["lon"]
    return out


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    # 经度差取 [-180,180]，否则跨太平洋/日界线时会被当成绕地球大半圈，误触航迹清空
    dl_deg = lon2 - lon1
    while dl_deg > 180.0:
        dl_deg -= 360.0
    while dl_deg < -180.0:
        dl_deg += 360.0
    dl = math.radians(dl_deg)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _ensure_simconnect():
    global _sim, _aq
    if _sim is not None:
        return True
    try:
        from SimConnect import AircraftRequests, SimConnect  # type: ignore

        _sim = SimConnect()
        # _time：请求间隔 ms，约 11ms ≈ 90Hz，跑道/姿态与浏览器 rAF 插值更合拍
        _aq = AircraftRequests(_sim, _time=11)
        return True
    except Exception:
        _sim = None
        _aq = None
        return False


def _read_state() -> dict:
    with _state_lock:
        return _read_state_unlocked()


def _read_state_unlocked() -> dict:
    global _last_ll, _trail, _trail_spike_count
    if not _ensure_simconnect() or _aq is None:
        return _error_response("无法连接 SimConnect（请启动微软模拟飞行后再试）")

    try:
        lat = _aq.get("PLANE_LATITUDE")
        lon = _aq.get("PLANE_LONGITUDE")
        alt = _aq.get("PLANE_ALTITUDE")
        hdg_mag = _aq.get("PLANE_HEADING_DEGREES_MAGNETIC")
        hdg_true = _aq.get("PLANE_HEADING_DEGREES_TRUE")
        hdg = hdg_mag if hdg_mag is not None else hdg_true
        pitch_raw = _aq.get("PLANE_PITCH_DEGREES")
        bank_raw = _aq.get("PLANE_BANK_DEGREES")
        vert_raw = _aq.get("VERTICAL_SPEED")
        gs_raw = _aq.get("GROUND_VELOCITY")
        ias = _aq.get("AIRSPEED_INDICATED")
        # 风、真速：单独变量缺失不阻断主包
        wind_dir_raw = _aq.get("AMBIENT WIND DIRECTION")
        if wind_dir_raw is None:
            wind_dir_raw = _aq.get("AMBIENT_WIND_DIRECTION")
        wind_vel_raw = _aq.get("AMBIENT WIND VELOCITY")
        if wind_vel_raw is None:
            wind_vel_raw = _aq.get("AMBIENT_WIND_VELOCITY")
        tas_raw = _aq.get("AIRSPEED TRUE")
        if tas_raw is None:
            tas_raw = _aq.get("AIRSPEED_TRUE")
    except Exception as e:
        return _error_response(f"SimConnect 读数失败: {e}")

    if lat is None or lon is None:
        return _error_response("暂无有效经纬度（是否在主菜单或未加载飞行？）")

    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return _error_response("经纬度格式异常")

    if abs(lat_f) > 90 or abs(lon_f) > 180:
        return _error_response("经纬度超出有效范围")

    should_add = False
    spike_skip = False
    if _last_ll is None:
        _trail_spike_count = 0
        should_add = True
    else:
        d = _haversine_m(_last_ll[0], _last_ll[1], lat_f, lon_f)
        if d > TRAIL_RESET_JUMP_M:
            _trail_spike_count += 1
            if _trail_spike_count >= TRAIL_RESET_SPIKE_FRAMES:
                _clear_trail()
                should_add = True
            else:
                spike_skip = True
        else:
            _trail_spike_count = 0
            if d >= TRAIL_MIN_MOVE_M:
                should_add = True

    if should_add:
        _trail.append((lat_f, lon_f))
        _last_ll = (lat_f, lon_f)
        while len(_trail) > TRAIL_MAX_POINTS:
            _trail.pop(0)

    rep_lat, rep_lon = lat_f, lon_f
    if spike_skip and _last_ll is not None:
        rep_lat, rep_lon = float(_last_ll[0]), float(_last_ll[1])

    def _f(name, v):
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    gs_f = _f("gs", gs_raw)
    gs_knots = (gs_f * 0.592484) if gs_f is not None else None

    def _norm360(x: float) -> float:
        x = x % 360.0
        return x + 360.0 if x < 0 else x

    def _heading_track_simconnect_to_deg(x: float) -> float:
        """航向/航迹在 SimConnect 中几乎总是弧度且可取满 0～2π。旧逻辑用 |x|≤π 才按弧度换算，
        会把 π～2π（约 180°～360°）误当成已经是「度」，数值锁在几度～百度内，地图/罗盘像转死。"""
        ax = abs(x)
        if ax <= 2 * math.pi + 0.05:
            return _norm360(math.degrees(x))
        return _norm360(x)

    # 优先磁航向（与 PFD/ND MAG 一致）；变量名虽含 DEGREES，SimConnect 实际多为弧度
    hdg_raw = _f("hdg", hdg)
    if hdg_raw is None:
        heading_deg = None
    else:
        heading_deg = _heading_track_simconnect_to_deg(hdg_raw)

    heading_true_deg = None
    htr = _f("hdg_true", hdg_true)
    if htr is not None:
        heading_true_deg = _heading_track_simconnect_to_deg(htr)

    # 磁差（度，东偏为正）：用于真航迹→磁航迹、网页侧航线角换算
    magvar_raw = _aq.get("MAGVAR")
    mag_var_deg = _f("magvar", magvar_raw)

    # 磁航向偶发缺失时勿改用真航向（会差一整段磁差）；用 真航向−磁差 合成磁航向
    if heading_deg is None and heading_true_deg is not None and mag_var_deg is not None and math.isfinite(mag_var_deg):
        heading_deg = _norm360(heading_true_deg - mag_var_deg)

    # 单一真–磁关系：以 MAGVAR 为准，真航向 = 磁航向 + 磁差（东偏为正）。
    # 否则 PLANE_HEADING_MAGNETIC / TRUE 与 MAGVAR 三源不同步时会出现约数度偏差。
    if mag_var_deg is not None and math.isfinite(mag_var_deg) and heading_deg is not None and math.isfinite(heading_deg):
        heading_true_deg = _norm360(heading_deg + mag_var_deg)

    # 对地航迹：优先磁航迹；否则由真航迹减磁差得到磁航迹（与 ND TRK MAG 一致）
    trk_mag_raw = _aq.get("GPS_GROUND_MAGNETIC_TRACK")
    if trk_mag_raw is not None:
        tm = _f("trk_mag", trk_mag_raw)
        ground_track_deg = _heading_track_simconnect_to_deg(tm) if tm is not None else None
    else:
        trk_raw = _aq.get("GPS_GROUND_TRACK")
        gt = _f("trk", trk_raw)
        if gt is None:
            ground_track_deg = None
        else:
            trk_true = _heading_track_simconnect_to_deg(gt)
            if mag_var_deg is not None and math.isfinite(mag_var_deg):
                ground_track_deg = _norm360(trk_true - mag_var_deg)
            else:
                ground_track_deg = trk_true

    # PLANE PITCH：正常在 ±π/2 弧度内；明显更大时按已是度处理（避免把「度」误当弧度）
    p_raw = _f("pitch", pitch_raw)
    b_raw = _f("bank", bank_raw)
    if p_raw is None:
        pitch_deg = None
    elif abs(p_raw) <= math.pi / 2 + 0.15:
        pitch_deg = math.degrees(p_raw)
    else:
        pitch_deg = p_raw
    # BANK：可能接近 ±π；用满圈弧度上界，避免 |x|>π 时被错当成度
    if b_raw is None:
        bank_deg = None
    elif abs(b_raw) <= 2 * math.pi + 0.05:
        bank_deg = math.degrees(b_raw)
    else:
        bank_deg = b_raw
    # VERTICAL_SPEED：一般为英尺/分钟；若绝对值很小可能是 ft/s，这里略放大启发式（多数情况直接用）
    vs_f = _f("vs", vert_raw)
    vertical_speed_fpm = vs_f

    alt_ft = _f("alt", alt)

    # 地形标高（SimConnect GROUND_ALTITUDE 多为米）· 无线电高度（多为英尺）
    ground_raw = _aq.get("GROUND_ALTITUDE")
    if ground_raw is None:
        ground_raw = _aq.get("GROUND ALTITUDE")
    radio_raw = _aq.get("RADIO_HEIGHT")
    if radio_raw is None:
        radio_raw = _aq.get("RADIO HEIGHT")
    # 与游戏内几何离地高一致（相对地形，非简单 baro−地面标高）
    agl_sim_raw = _aq.get("PLANE_ALT_ABOVE_GROUND")
    if agl_sim_raw is None:
        agl_sim_raw = _aq.get("PLANE ALT ABOVE GROUND")
    if agl_sim_raw is None:
        agl_sim_raw = _aq.get("PLANE_ALT_ABOVE_GROUND_MINUS_CG")
    gelev_m = _f("gelev", ground_raw)
    radio_ft = _f("radio", radio_raw)
    agl_sim_n = _f("agl_sim", agl_sim_raw)
    ground_elev_ft: float | None = None
    if gelev_m is not None:
        if abs(gelev_m) < 45000:
            ground_elev_ft = gelev_m * 3.28084
        else:
            ground_elev_ft = gelev_m
    agl_baro_ft: float | None = None
    if alt_ft is not None and ground_elev_ft is not None:
        agl_baro_ft = alt_ft - ground_elev_ft
    agl_game_ft: float | None = None
    if agl_sim_n is not None and math.isfinite(agl_sim_n):
        # MSFS SDK：几何离地高，与模拟器地形一致（单位：英尺）
        agl_game_ft = max(0.0, float(agl_sim_n))
    radio_height_ft: float | None = None
    if radio_ft is not None and 0 <= radio_ft < 12000:
        radio_height_ft = radio_ft

    rw_list = _pick_forward_runways(rep_lat, rep_lon, heading_deg, alt_ft, max_n=ADI_RUNWAY_MAX)
    rw_live = _merge_gps_threshold(rw_list[0] if rw_list else None, _aq)
    if rw_live and rw_list:
        rw_list = [rw_live] + rw_list[1:]
    elif rw_live:
        rw_list = [rw_live]

    # 气象风：SimConnect 来向为真向；下转为磁向后与 ND 磁航向同系。VELOCITY 在 MSFS 中多为 m/s
    wind_dir_deg: float | None = None
    wdf = _f("wind_dir", wind_dir_raw)
    if wdf is not None:
        wind_dir_deg = _heading_track_simconnect_to_deg(wdf)
    # ND 风矢相对机头：MAG = TRUE − VAR（东偏为正）
    if wind_dir_deg is not None and mag_var_deg is not None and math.isfinite(mag_var_deg):
        wind_dir_deg = _norm360(wind_dir_deg - mag_var_deg)
    wind_vel_knots: float | None = None
    wvf = _f("wind_vel", wind_vel_raw)
    if wvf is not None and wvf >= 0:
        if wvf <= 85:
            wind_vel_knots = float(wvf) * 1.943844
        else:
            wind_vel_knots = float(wvf)
    tas_knots_out: float | None = _f("tas", tas_raw)
    if tas_knots_out is not None and not (1 <= tas_knots_out <= 1200):
        tas_knots_out = None

    baro_hpa: float | None = _f("mbar", _aq.get("KOHLSMAN SETTING MBAR"))
    if baro_hpa is not None and (baro_hpa < 200 or baro_hpa > 1100):
        baro_hpa = None
    if baro_hpa is None:
        inh = _f("inh", _aq.get("KOHLSMAN SETTING HG"))
        if inh is not None and math.isfinite(inh):
            baro_hpa = float(inh) * 33.8638866667

    oat_c: float | None = None
    oat_raw = _aq.get("AMBIENT TEMPERATURE")
    if oat_raw is None:
        oat_raw = _aq.get("TOTAL AIR TEMPERATURE")
    otv = _f("oat", oat_raw)
    if otv is not None and math.isfinite(otv):
        oat_c = float(otv) - 273.15 if abs(otv) > 120 else float(otv)

    return {
        "ok": True,
        "lat": rep_lat,
        "lon": rep_lon,
        "alt_ft": alt_ft,
        "heading_deg": heading_deg,
        "heading_true_deg": heading_true_deg,
        "mag_var_deg": mag_var_deg,
        "ground_track_deg": ground_track_deg,
        "pitch_deg": pitch_deg,
        "bank_deg": bank_deg,
        "vertical_speed_fpm": vertical_speed_fpm,
        "groundspeed_knots": gs_knots,
        "ias_knots": _f("ias", ias),
        "tas_knots": tas_knots_out,
        "oat_celsius": oat_c,
        "baro_hpa": baro_hpa,
        "wind_direction_deg": wind_dir_deg,
        "wind_speed_knots": wind_vel_knots,
        "ground_elev_ft": ground_elev_ft,
        "radio_height_ft": radio_height_ft,
        "agl_baro_ft": agl_baro_ft,
        "agl_game_ft": agl_game_ft,
        "trail": _trail_payload_for_client(rep_lat, rep_lon),
        "runway": rw_live,
        "runways": rw_list,
    }


class _BridgeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIR), **kw)

    def log_message(self, fmt, *args):
        pass

    def _send_json(self, code: int, obj: dict) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        global _shared_plan, _plan_rev
        path = urlparse(self.path).path
        if path != "/api/plan":
            self.send_error(404)
            return
        try:
            ln = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            ln = 0
        if ln > _PLAN_BODY_MAX:
            self._send_json(413, {"ok": False, "error": "body too large"})
            return
        try:
            body = self.rfile.read(ln) if ln > 0 else b"{}"
            data = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"ok": False, "error": "invalid JSON"})
            return
        if not isinstance(data, dict):
            self._send_json(400, {"ok": False, "error": "expected object"})
            return
        try:
            with _plan_lock:
                if data.get("clear"):
                    _shared_plan = None
                else:
                    _shared_plan = _normalize_shared_plan(data)
                _plan_rev += 1
                rev = _plan_rev
        except ValueError as e:
            self._send_json(400, {"ok": False, "error": str(e)})
            return
        self._send_json(200, {"ok": True, "rev": rev})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/plan":
            self._send_json(200, _get_plan_payload())
            return
        if path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            interval = 1.0 / max(1, TICK_HZ)
            try:
                while True:
                    msg = dict(_read_state())
                    with _plan_lock:
                        msg["plan_rev"] = _plan_rev
                    line = "data: " + json.dumps(msg, ensure_ascii=False) + "\n\n"
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
                    time.sleep(interval)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            return
        return super().do_GET()


class _ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """绕过 HTTPServer.server_bind 里的 getfqdn，避免 Windows 主机名编码导致 UnicodeDecodeError。"""

    daemon_threads = True

    def server_bind(self):
        TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host if isinstance(host, str) else str(host)
        self.server_port = port


def _lan_ipv4_addrs() -> list[str]:
    """本机可用的非回环 IPv4，供手机在同一 Wi‑Fi / 局域网下访问。"""
    found: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                found.add(ip)
    except OSError:
        pass
    # 默认路由网卡（未联网时可能失败，忽略）
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                found.add(ip)
        finally:
            s.close()
    except OSError:
        pass
    return sorted(found)


def _run_runways_builder() -> None:
    """启动 HTTP 桥接前执行 build_runways_cn.py，生成/刷新全国跑道数据；失败不阻止服务。"""
    script = DIR / "build_runways_cn.py"
    if not script.is_file():
        return
    try:
        print("正在执行 build_runways_cn.py（更新 runways_compact.json）…")
        proc = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(DIR),
            timeout=300,
        )
        if proc.returncode != 0:
            print(
                "提示: build_runways_cn.py 退出码",
                proc.returncode,
                "，将沿用已有 runways_compact.json（若有）。",
            )
    except subprocess.TimeoutExpired:
        print("提示: build_runways_cn.py 超时，已跳过（沿用已有跑道数据）。")
    except Exception as e:
        print("提示: 无法执行 build_runways_cn.py:", e)


def main():
    _run_runways_builder()
    bind_all = "0.0.0.0"
    with _ThreadedHTTPServer((bind_all, HTTP_PORT), _BridgeHandler) as httpd:
        print(f"本机打开: http://127.0.0.1:{HTTP_PORT}/index.html")
        lan_ips = _lan_ipv4_addrs()
        for ip in lan_ips:
            print(f"局域网访问（手机/其他设备）: http://{ip}:{HTTP_PORT}/index.html")
        if not lan_ips:
            print("（未检测到局域网 IPv4，手机可稍后在「网络和共享中心」查看本机 IP。）")
        print("实时数据: GET /api/stream；航线同步: GET/POST /api/plan（电脑导入后手机与同局域网页面自动一致）")
        print("请先启动微软模拟飞行并进入飞行；手机须与电脑在同一 Wi‑Fi。")
        print("若手机无法打开，请在 Windows 防火墙中允许此 Python 程序或 TCP 端口", HTTP_PORT, "。")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
