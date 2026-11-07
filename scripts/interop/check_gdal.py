"""GDAL reads WebSfM's raster exports (scripts/interop/README.md).

Run in GDAL's image:  python3 check_gdal.py <outDir>
Checks every GeoTIFF of expected.json: GDAL's own COG validator (full check) where the
file is a COG, the CRS (EPSG), the geotransform, nodata, and the values at known cells.
Exit 1 on any failure, with every failure listed.
"""
import json
import math
import sys
from pathlib import Path

from osgeo import gdal, osr
from osgeo_utils.samples.validate_cloud_optimized_geotiff import validate

gdal.UseExceptions()
out = Path(sys.argv[1])
exp = json.loads((out / "expected.json").read_text())
fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


def epsg_of(ds):
    srs = osr.SpatialReference(wkt=ds.GetProjection())
    srs.AutoIdentifyEPSG()
    code = srs.GetAuthorityCode(None)
    return int(code) if code else None


def common(name, ds, e):
    check(epsg_of(ds) == e["epsg"], f"{name}: EPSG {epsg_of(ds)}, expected {e['epsg']}")
    check((ds.RasterXSize, ds.RasterYSize) == (e["width"], e["height"]), f"{name}: size {ds.RasterXSize}x{ds.RasterYSize}")
    gt = ds.GetGeoTransform()
    check(all(abs(a - b) < 1e-6 for a, b in zip(gt, e["geotransform"])), f"{name}: geotransform {gt}")


def cog(name, path):
    warnings, errors, _ = validate(str(path), full_check=True)
    check(not errors, f"{name}: not a valid COG: {errors}")
    if warnings:
        print(f"  {name}: COG warnings {warnings}")


# DEM
d = exp["dem"]
for name, f in d["files"].items():
    path = out / name
    ds = gdal.Open(str(path))
    common(name, ds, d)
    if f["cog"]:
        cog(name, path)
        check(ds.GetRasterBand(1).GetOverviewCount() >= 1, f"{name}: no overviews")
    band = ds.GetRasterBand(1)
    nd = band.GetNoDataValue()
    if f["nodata"] == "nan":
        check(nd is not None and math.isnan(nd), f"{name}: nodata {nd}, expected nan")
    else:
        check(nd == f["nodata"], f"{name}: nodata {nd}, expected {f['nodata']}")
    a = band.ReadAsArray()
    for s in d["samples"]:
        v = float(a[s["row"], s["col"]])
        check(abs(v - s["z"]) < 1e-4, f"{name}: ({s['col']},{s['row']}) = {v}, expected {s['z']}")
    h = float(a[d["hole"]["row"], d["hole"]["col"]])
    check((math.isnan(h) if f["nodata"] == "nan" else h == f["nodata"]), f"{name}: hole cell = {h}, expected nodata")
    print(f"  {name}: read by GDAL {gdal.__version__}")

# Ortho
o = exp["ortho"]
ds = gdal.Open(str(out / o["file"]))
common(o["file"], ds, o)
check(ds.RasterCount == o["bands"], f"{o['file']}: {ds.RasterCount} bands, expected {o['bands']}")
check(
    ds.GetRasterBand(4).GetColorInterpretation() == gdal.GCI_AlphaBand,
    f"{o['file']}: band 4 is not alpha ({gdal.GetColorInterpretationName(ds.GetRasterBand(4).GetColorInterpretation())})",
)
arr = ds.ReadAsArray()
for s in o["samples"]:
    got = [int(arr[b, s["row"], s["col"]]) for b in range(4)]
    check(got == s["rgba"], f"{o['file']}: ({s['col']},{s['row']}) = {got}, expected {s['rgba']}")
print(f"  {o['file']}: read by GDAL")

if fails:
    print("GDAL check FAILED:\n  " + "\n  ".join(fails))
    sys.exit(1)
print("GDAL check passed")
