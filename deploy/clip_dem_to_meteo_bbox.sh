#!/usr/bin/env bash
set -euo pipefail

# Clips DEM GeoTIFF files to MeteoSunucu bbox from src/stations.ts
# BBOX: west=25.7 south=35.7 east=33.2 north=41.3
# NOTE: Tek tek dosyalari bbox'a kirpmak her dosyada ayni extenti olusturur.
# Bu script once mozaik VRT olusturur, sonra tek bir clipped DEM uretir.

SRC_DIR="${1:-/opt/meteo-sunucu/data/dem}"
OUT_DIR="${2:-/opt/meteo-sunucu/data/dem_clipped}"

WEST="25.7"
SOUTH="35.7"
EAST="33.2"
NORTH="41.3"

if ! command -v gdalwarp >/dev/null 2>&1; then
  echo "gdalwarp bulunamadi. Lutfen once gdal-bin kurun." >&2
  exit 1
fi

if ! command -v gdalbuildvrt >/dev/null 2>&1; then
  echo "gdalbuildvrt bulunamadi. Lutfen once gdal-bin kurun." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

mapfile -t tif_files < <(find "$SRC_DIR" -maxdepth 2 -type f \( -iname "*.tif" -o -iname "*.tiff" \))

if [ "${#tif_files[@]}" -eq 0 ]; then
  echo "Kaynak DEM dosyasi bulunamadi: $SRC_DIR" >&2
  exit 1
fi

tmp_vrt="$OUT_DIR/dem_mosaic_tmp.vrt"
out_file="$OUT_DIR/meteo_bbox_dem.tif"

rm -f "$tmp_vrt" "$out_file"

echo "DEM mozaik VRT olusturuluyor (${#tif_files[@]} dosya)..."
gdalbuildvrt "$tmp_vrt" "${tif_files[@]}"

echo "BBOX kirpma yapiliyor: $out_file"
gdalwarp \
  -te "$WEST" "$SOUTH" "$EAST" "$NORTH" \
  -te_srs EPSG:4326 \
  -t_srs EPSG:4326 \
  -dstnodata -9999 \
  -multi -wo NUM_THREADS=ALL_CPUS \
  -co COMPRESS=DEFLATE -co TILED=YES \
  "$tmp_vrt" "$out_file"

rm -f "$tmp_vrt"

echo "DEM kirpma tamamlandi: $OUT_DIR"
