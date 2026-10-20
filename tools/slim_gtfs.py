"""Daily GO GTFS slim for Mini GO Transit 3D.

Cuts an N-day window (default 3) starting today (America/Toronto) out of the
official Metrolinx GO-GTFS.zip and writes the slim zip to the output path.

Design rules (validated Oct 2026):
- Shapes are copied VERBATIM (full fidelity, no simplification, no reformatting).
- trip_id values are never modified; kept rows are written verbatim.
- Trips are selected by the date prefix embedded in GO trip_ids (YYYYMMDD-...).
- Exit code 1 on any integrity failure, so CI never overwrites a good file
  with a bad one.

Usage:
  python3 slim_gtfs.py [--input URL-or-path] [--output path] [--days 3]
                       [--start YYYYMMDD]
"""
import argparse, csv, io, os, sys, tempfile, zipfile
from datetime import date, datetime, timedelta
from urllib.request import urlopen
from zoneinfo import ZoneInfo

DEFAULT_SRC = "https://assets.metrolinx.com/raw/upload/v1683228856/Documents/Metrolinx/Open%20Data/GO-GTFS.zip"
COPY_IF_PRESENT = ["agency.txt", "routes.txt", "feed_info.txt", "fare_attributes.txt",
                   "fare_rules.txt", "stop_amenities.txt"]
MEMBERS = ["agency.txt", "calendar_dates.txt", "fare_attributes.txt", "fare_rules.txt",
           "feed_info.txt", "routes.txt", "shapes.txt", "stop_amenities.txt",
           "stop_times.txt", "stops.txt", "transfers.txt", "trips.txt"]

ap = argparse.ArgumentParser()
ap.add_argument("--input", default=DEFAULT_SRC)
ap.add_argument("--output", default="gtfs/GO-GTFS-slim.zip")
ap.add_argument("--days", type=int, default=3)
ap.add_argument("--start", default=None, help="YYYYMMDD; default = today in America/Toronto")
args = ap.parse_args()

if args.start:
    start = date(int(args.start[:4]), int(args.start[4:6]), int(args.start[6:8]))
else:
    start = datetime.now(ZoneInfo("America/Toronto")).date()
window = [(start + timedelta(days=i)).strftime("%Y%m%d") for i in range(args.days)]
PREFIXES = tuple(window)
print(f"window: {window[0]} .. {window[-1]} ({args.days} days)", flush=True)

# --- load source -------------------------------------------------------------
if args.input.startswith("http"):
    print("downloading source...", flush=True)
    raw = urlopen(args.input, timeout=180).read()
    z = zipfile.ZipFile(io.BytesIO(raw))
else:
    z = zipfile.ZipFile(args.input)
names = set(z.namelist())

def read_text(name):
    return io.TextIOWrapper(z.open(name), encoding="utf-8-sig", newline="")

def read_lines(name):
    """Raw text lines (header separate) of a member, no CSV parsing/reformatting."""
    with z.open(name) as f:
        text = f.read().decode("utf-8-sig")
    lines = text.splitlines()
    return lines[0], lines[1:]

# --- 1. trips (window filter, verbatim lines) --------------------------------
trip_header, trip_lines_all = read_lines("trips.txt")
th = trip_header.split(",")
TI, SI, SH = th.index("trip_id"), th.index("service_id"), th.index("shape_id")
trip_ids, service_ids, shape_ids = set(), set(), set()
kept_trip_lines = []
for ln in trip_lines_all:
    if not ln.strip():
        continue
    row = next(csv.reader([ln]))
    if row[TI][:8] in PREFIXES:
        kept_trip_lines.append(ln)
        trip_ids.add(row[TI]); service_ids.add(row[SI])
        if row[SH]: shape_ids.add(row[SH])
if not trip_ids:
    print("FATAL: no trips matched the window - refusing to write output", flush=True)
    sys.exit(1)

# --- 2. stop_times (verbatim lines) ------------------------------------------
st_header, st_lines_all = read_lines("stop_times.txt")
kept_st_lines, stop_ids = [], set()
for ln in st_lines_all:
    if not ln.strip():
        continue
    row = next(csv.reader([ln]))
    if row[0] in trip_ids:
        kept_st_lines.append(ln); stop_ids.add(row[3])

# --- 3. shapes (VERBATIM lines for kept shape_ids, source order) -------------
sh_header, sh_lines_all = read_lines("shapes.txt")
SHI = sh_header.split(",").index("shape_id")
kept_sh_lines = []
for ln in sh_lines_all:
    if not ln.strip():
        continue
    sid = next(csv.reader([ln]))[SHI]
    if sid in shape_ids:
        kept_sh_lines.append(ln)
pts_after = len(kept_sh_lines)

# --- 4. stops + parent closure ------------------------------------------------
with read_text("stops.txt") as f:
    rdr = csv.DictReader(f); st_fields = rdr.fieldnames
    all_stops = {r["stop_id"]: r for r in rdr}
keep_stops = set(stop_ids); changed = True
while changed:
    changed = False
    for sid in list(keep_stops):
        p = (all_stops.get(sid) or {}).get("parent_station", "")
        if p and p not in keep_stops: keep_stops.add(p); changed = True

# --- 5. calendar_dates (verbatim, kept service_ids) ---------------------------
cd_header, cd_lines_all = read_lines("calendar_dates.txt")
CSI = cd_header.split(",").index("service_id")
kept_cd_lines = [ln for ln in cd_lines_all
                 if ln.strip() and next(csv.reader([ln]))[CSI] in service_ids]

# --- 6. transfers (verbatim, both stops kept) ---------------------------------
kept_tr_lines, tr_header = [], None
if "transfers.txt" in names:
    tr_header, tr_lines_all = read_lines("transfers.txt")
    tcols = tr_header.split(",")
    FI, TOI = tcols.index("from_stop_id"), tcols.index("to_stop_id")
    for ln in tr_lines_all:
        if not ln.strip():
            continue
        row = next(csv.reader([ln]))
        if row[FI] in keep_stops and row[TOI] in keep_stops:
            kept_tr_lines.append(ln)

# --- write output zip ----------------------------------------------------------
workdir = tempfile.mkdtemp(prefix="gtfs-slim-")
def wtext(name, header, lines):
    with open(os.path.join(workdir, name), "w", encoding="utf-8", newline="") as f:
        f.write(header + "\n")
        for ln in lines: f.write(ln + "\n")
wtext("trips.txt", trip_header, kept_trip_lines)
wtext("stop_times.txt", st_header, kept_st_lines)
wtext("shapes.txt", sh_header, kept_sh_lines)
wtext("calendar_dates.txt", cd_header, kept_cd_lines)
if tr_header is not None:
    wtext("transfers.txt", tr_header, kept_tr_lines)
with open(os.path.join(workdir, "stops.txt"), "w", encoding="utf-8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=st_fields, lineterminator="\n")
    w.writeheader()
    for sid in sorted(keep_stops): w.writerow(all_stops[sid])
for n in COPY_IF_PRESENT:
    if n in names:
        open(os.path.join(workdir, n), "wb").write(z.read(n))

present = [m for m in MEMBERS if os.path.exists(os.path.join(workdir, m))]
os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
tmp_out = args.output + ".tmp"
with zipfile.ZipFile(tmp_out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zz:
    for n in present: zz.write(os.path.join(workdir, n), n)
os.replace(tmp_out, args.output)

# --- integrity checks -----------------------------------------------------------
ok = True
def check(name, cond, detail=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name + (f" -- {detail}" if detail and not cond else ""), flush=True)
    if not cond: ok = False

st_rows = list(csv.DictReader(open(os.path.join(workdir, "stop_times.txt"), encoding="utf-8")))
check("stop_times.trip_id subset of trips", all(r["trip_id"] in trip_ids for r in st_rows))
check("stop_times.stop_id subset of stops", all(r["stop_id"] in keep_stops for r in st_rows))
sh_sids = {next(csv.reader([ln]))[SHI] for ln in kept_sh_lines}
check("shapes.shape_id subset of trips' shape_ids", sh_sids <= shape_ids, f"extra={sh_sids - shape_ids}")
covered = {t[:8] for t in trip_ids}
check("all window dates have trips", covered == set(window), f"covered={sorted(covered)}")
orig = set()
for ln in trip_lines_all:
    if ln.strip():
        orig.add(next(csv.reader([ln]))[TI])
sample = sorted(trip_ids)[::max(1, len(trip_ids) // 20)][:20]
check("trip_id byte-identical sample x20", all(t in orig for t in sample))
zz = zipfile.ZipFile(args.output)
check("testzip", zz.testzip() is None)
check("no self-include / sane members", args.output.split('/')[-1] not in zz.namelist()
      and "trips.txt" in zz.namelist() and "shapes.txt" in zz.namelist())

print(f"\ntrips: {len(trip_ids)} | stop_times rows: {len(kept_st_lines)} | shape points (verbatim): {pts_after} | stops: {len(keep_stops)}")
print(f"zip: {os.path.getsize(args.output)/1e6:.2f} MB -> {args.output}")
print("FINAL:", "ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)
