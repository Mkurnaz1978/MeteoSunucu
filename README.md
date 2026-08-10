# MeteoSunucu

Bu servis, mevcut backend'teki meteoroloji işlemlerini bağımsız bir sunucuya taşımak için hazırlandı.

Sağlanan yüzeyler:

- `GET /health`
- `GET /meteo/stations`
- `GET /meteo/current?station=LTFC`
- `GET /meteo/forecast?station=LTFC`
- `GET /meteo/aviation?station=LTFC&preferredSource=hazerfan`
- `GET /meteo/profile/surface?station=LTFC`
- `GET /meteo/profile/aloft?station=LTFC`
- `GET /meteo/route-sample?lat=37.855&lon=30.368&altitude=SFC`
- `GET /meteo/map/layers`
- `GET /meteo/map/snapshot`
- `GET /meteo-public/map/tile/:layer/:z/:x/:y.png`
- `GET /meteo-public/map/value`
- `GET /meteo-public/map/stats`
- `GET /dem/health`
- `GET /dem/elevation?lat=37.855&lon=30.368`
- `GET /dem/elevation/agl-to-msl?lat=37.855&lon=30.368&aglFt=1500&roundStepFt=100`
- `POST /dem/elevation/batch`

Davranış:

- Open-Meteo current, forecast ve raster grid verileri varsayılan olarak 15 dakikada bir tazelenir.
- Open-Meteo dokümanına göre current koşullar 15 dakikalık model verisine dayanır; model güncellemeleri ise modele göre saatlik veya birkaç saatlik gelebilir. Bu nedenle 15 dakikalık cache aralığı seçildi.
- METAR/TAF verisi her 1 dakikada bir yenilenir.
- `preferredSource=hazerfan` seçildiğinde önce `HAZERFAN_URL_TEMPLATE` kullanılır, erişilemezse otomatik NOAA fallback yapılır.
- Varsayılan `HAZERFAN_URL_TEMPLATE`, mevcut frontend'te kullanılan MGM/Rasat sayfasına ayarlanmıştır. Elinizde gerçek Hazerfan endpoint'i varsa `.env` içinde sadece bu adresi değiştirmeniz yeterlidir.
- DEM katmanı `DEM_ENABLED=true` olduğunda etkinleşir; `DEM_DATA_PATH` altındaki `.tif/.tiff` dosyalarından yer yüksekliği sunar.
- AGL -> MSL hesapları `aglFt + yer_irtifasi` formuluyle yapilir ve varsayilan olarak bir ust 100 ft seviyesine yuvarlanir (`DEM_AGL_ROUND_STEP_FT`).
- `DEM_RESTRICT_TO_METEO_BBOX=true` ile DEM sorgulari sadece MeteoSunucu'nun aktif BBOX alaninda cevaplanir. BBOX disinda fallback doner.

## DEM kurulumu (Copernicus / GeoTIFF)

1. Copernicus veya benzeri kaynaktan DEM GeoTIFF dosyalarini indirin.
2. Dosyalari sunucuda `DEM_DATA_PATH` dizinine koyun (ornek: `data/dem`).
3. `.env` dosyasinda su ayarlari yapin:

```bash
DEM_ENABLED=true
DEM_DATA_PATH=data/dem
DEM_BATCH_MAX_POINTS=500
DEM_AGL_ROUND_STEP_FT=100
DEM_NODATA_FALLBACK_METERS=0
DEM_RESTRICT_TO_METEO_BBOX=true
```

4. Servisi yeniden baslatin.

Windows gelistirme makinesinden DEM dosyalarini VPS'e yukleyip aktif etmek icin:

```powershell
./deploy/upload_dem_to_vps.ps1 -LocalDemPath "C:\dem\turkiye"
```

Yalnizca MeteoSunucu kapsama alanini tutmak icin (BBOX: west=25.7, south=35.7, east=33.2, north=41.3):

```bash
chmod +x deploy/clip_dem_to_meteo_bbox.sh
./deploy/clip_dem_to_meteo_bbox.sh /opt/meteo-sunucu/data/dem /opt/meteo-sunucu/data/dem_clipped
```

Ardindan `.env` icinde `DEM_DATA_PATH=data/dem_clipped` yapip servisi yeniden baslatin.

Batch ornek istek:

```bash
curl -X POST http://localhost:3001/dem/elevation/batch \
	-H "Content-Type: application/json" \
	-d '{
		"roundStepFt": 100,
		"points": [
			{"lat": 37.855, "lon": 30.368, "aglFt": 1500},
			{"lat": 36.899, "lon": 30.800}
		]
	}'
```

## Geliştirme

```bash
npm install
npm run dev
```

## Üretim

```bash
npm install
npm run build
npm start
```

AIRGRAM endpoint'i (`GET /meteo/airgram`) icin sunucuda Python bagimliliklari gerekli:

```bash
sudo apt-get install -y python3 python3-matplotlib python3-numpy
```

Gerekiyorsa Python binary yolunu override edebilirsiniz:

```bash
export AIRGRAM_PYTHON_BIN=/usr/bin/python3
```

Open-Meteo rate-limit durumunda raster prewarm'i varsayilan kapali birakabilirsiniz
(yeni varsayilan zaten kapali). Acmak icin:

```bash
export ENABLE_RASTER_PREWARM=true
```

Ubuntu kurulumu için [deploy/install-ubuntu.sh](deploy/install-ubuntu.sh) dosyasını kullanın.
