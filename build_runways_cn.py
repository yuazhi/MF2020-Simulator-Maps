# -*- coding: utf-8 -*-
"""
从中国（OurAirports 中 iso_country=CN 的机场）生成 runways_compact.json。
关联键：runways.airport_ref → airports.id。
缺坐标的跑道：用机场中心 + 跑道号/真航向 + 长度 合成两端（大圆近似）。
数据来源：https://ourairports.com/data/ （公共领域）
用法:
  python build_runways_cn.py
需联网首次下载；同目录已有 CSV 且大于 10KB 时跳过下载。
启动 msfs_bridge.py 时会自动先执行本脚本；也可单独手动运行以更新数据。
"""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path

DIR = Path(__file__).resolve().parent
OUT = DIR / "runways_compact.json"
AIRPORT_CSV = DIR / "airports.csv"
RUNWAY_CSV = DIR / "runways.csv"
BASE = "https://ourairports.com/data/"


def download_if_needed() -> None:
    import urllib.request

    for name in ("airports.csv", "runways.csv"):
        dest = DIR / name
        if dest.is_file() and dest.stat().st_size > 10000:
            continue
        url = BASE + name
        print("下载", url)
        urllib.request.urlretrieve(url, dest)


def dest_latlon(lat_deg: float, lon_deg: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    """从一点沿真方位 bearing（顺时针从北）前进 dist_m（米）。"""
    R = 6371000.0
    lat1 = math.radians(lat_deg)
    lon1 = math.radians(lon_deg)
    br = math.radians(bearing_deg)
    dr = dist_m / R
    lat2 = math.asin(math.sin(lat1) * math.cos(dr) + math.cos(lat1) * math.sin(dr) * math.cos(br))
    lon2 = lon1 + math.atan2(
        math.sin(br) * math.sin(dr) * math.cos(lat1),
        math.cos(dr) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)


def heading_from_rwy_id(rid: str) -> float | None:
    """跑道名如 06L / 18 → 真方向约 60° / 180°（常见标注×10）。"""
    rid = (rid or "").strip().upper()
    num = ""
    for c in rid:
        if c.isdigit():
            num += c
        elif num:
            break
    if len(num) >= 2:
        return float((int(num[:2]) * 10
                      ) % 360)
    if len(num) == 1:
        return float((int(num) * 10) % 360)
    return None


def main() -> None:
    download_if_needed()
    if not AIRPORT_CSV.is_file() or not RUNWAY_CSV.is_file():
        print("缺少 airports.csv / runways.csv，请检查网络后重试。")
        return

    cn_airport_ids: set[int] = set()
    cn_centers: dict[int, tuple[float, float]] = {}
    id_to_ident: dict[int, str] = {}
    airport_elev: dict[int, float | None] = {}
    with AIRPORT_CSV.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if (row.get("iso_country") or "").strip() != "CN":
                continue
            try:
                aid = int(row["id"])
            except ValueError:
                continue
            cn_airport_ids.add(aid)
            try:
                cn_centers[aid] = (float(row["latitude_deg"]), float(row["longitude_deg"]))
            except (KeyError, ValueError):
                pass
            ident = (
                row.get("gps_code")
                or row.get("icao_code")
                or row.get("ident")
                or ""
            ).strip()
            id_to_ident[aid] = ident or "CN-?"
            el = row.get("elevation_ft")
            try:
                airport_elev[aid] = float(el) if el not in (None, "") else None
            except ValueError:
                airport_elev[aid] = None

    out: list[dict] = []
    with RUNWAY_CSV.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if (row.get("closed") or "").strip() == "1":
                continue
            try:
                aid = int(row["airport_ref"])
            except ValueError:
                continue
            if aid not in cn_airport_ids:
                continue

            le_id = (row.get("le_ident") or "").strip()
            he_id = (row.get("he_ident") or "").strip()
            rw_lbl = f"{le_id}/{he_id}".strip("/") if (le_id and he_id) else (le_id or he_id or "—")
            icao = id_to_ident.get(aid, (row.get("airport_ident") or "").strip() or "CN-?")

            la1 = lo1 = la2 = lo2 = None
            try:
                v1 = float(row["le_latitude_deg"])
                w1 = float(row["le_longitude_deg"])
                v2 = float(row["he_latitude_deg"])
                w2 = float(row["he_longitude_deg"])
                if all(map(math.isfinite, (v1, w1, v2, w2))):
                    la1, lo1, la2, lo2 = v1, w1, v2, w2
            except (KeyError, ValueError, TypeError):
                pass

            if la1 is None:
                center = cn_centers.get(aid)
                if not center:
                    continue
                alat, alon = center
                hdg = None
                for key in ("le_heading_degT", "he_heading_degT"):
                    s = (row.get(key) or "").strip()
                    if s:
                        try:
                            hdg = float(s)
                            break
                        except ValueError:
                            pass
                if hdg is None:
                    hdg = heading_from_rwy_id(le_id)
                if hdg is None and he_id:
                    h2 = heading_from_rwy_id(he_id)
                    if h2 is not None:
                        hdg = (h2 + 180.0) % 360.0
                if hdg is None:
                    continue
                try:
                    lf = float(row.get("length_ft") or 0)
                except ValueError:
                    continue
                if lf < 350:
                    continue
                lm = lf * 0.3048
                la1, lo1 = dest_latlon(alat, alon, (hdg + 180.0) % 360.0, lm / 2.0)
                la2, lo2 = dest_latlon(alat, alon, hdg, lm / 2.0)

            w_ft = (row.get("width_ft") or "").strip()
            try:
                w_m = max(15.0, float(w_ft) * 0.3048) if w_ft else 45.0
            except ValueError:
                w_m = 45.0
            elv_raw = (row.get("le_elevation_ft") or "").strip()
            try:
                elev = float(elv_raw)
            except ValueError:
                elev = airport_elev.get(aid)
            if elev is None or not math.isfinite(elev):
                elev = 0.0

            if la1 is None or lo1 is None or la2 is None or lo2 is None:
                continue
            out.append(
                {
                    "icao": icao,
                    "rw": rw_lbl,
                    "lat_thr": round(float(la1), 6),
                    "lon_thr": round(float(lo1), 6),
                    "lat_end": round(float(la2), 6),
                    "lon_end": round(float(lo2), 6),
                    "width_m": round(w_m, 1),
                    "elev_ft": round(float(elev), 1),
                }
            )

    OUT.write_text(
        json.dumps({"runways": out}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"已写入 {OUT.name}，共 {len(out)} 条跑道（中国大陆 iso_country=CN）。")


if __name__ == "__main__":
    main()
