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

Davranış:

- Open-Meteo current, forecast ve raster grid verileri varsayılan olarak 15 dakikada bir tazelenir.
- Open-Meteo dokümanına göre current koşullar 15 dakikalık model verisine dayanır; model güncellemeleri ise modele göre saatlik veya birkaç saatlik gelebilir. Bu nedenle 15 dakikalık cache aralığı seçildi.
- METAR/TAF verisi her 1 dakikada bir yenilenir.
- `preferredSource=hazerfan` seçildiğinde önce `HAZERFAN_URL_TEMPLATE` kullanılır, erişilemezse otomatik NOAA fallback yapılır.
- Varsayılan `HAZERFAN_URL_TEMPLATE`, mevcut frontend'te kullanılan MGM/Rasat sayfasına ayarlanmıştır. Elinizde gerçek Hazerfan endpoint'i varsa `.env` içinde sadece bu adresi değiştirmeniz yeterlidir.

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
