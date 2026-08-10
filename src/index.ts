import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { HttpError, MeteoService } from './services/meteo.service';
import { DemService } from './services/dem.service';

const app = express();
const meteoService = new MeteoService();
const demService = new DemService();

app.use(cors({ origin: config.allowedOrigin === '*' ? true : config.allowedOrigin }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    service: 'meteo-sunucu',
    status: 'ok',
    port: config.port,
    endpoints: [
      '/health',
      '/meteo/current',
      '/meteo/forecast',
      '/meteo/aviation',
      '/meteo/airgram',
      '/meteo/map/snapshot',
      '/meteo-public/map/tile/:layer/:z/:x/:y.png',
      '/dem/health',
      '/dem/elevation',
      '/dem/elevation/agl-to-msl',
      '/dem/elevation/batch',
      '/dem/ground-collision/analyze',
    ],
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/dem/health', async (_req, res, next) => {
  try {
    await demService.initialize();
    res.json({ status: 'ok', ...demService.status() });
  } catch (error) {
    next(error);
  }
});

app.get('/dem/elevation', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    res.json(await demService.getElevation(lat, lon));
  } catch (error) {
    next(error);
  }
});

app.get('/dem/elevation/agl-to-msl', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const aglFt = Number(req.query.aglFt);
    const roundStepFt = Number(req.query.roundStepFt ?? config.demAglRoundStepFt);
    res.json(await demService.aglToMslRounded(lat, lon, aglFt, roundStepFt));
  } catch (error) {
    next(error);
  }
});

app.post('/dem/elevation/batch', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      points?: Array<{ lat: number; lon: number; aglFt?: number }>;
      roundStepFt?: number;
    };
    res.json(await demService.getElevationBatch(body.points ?? [], body.roundStepFt));
  } catch (error) {
    next(error);
  }
});

app.post('/dem/ground-collision/analyze', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      routePoints?: Array<{ lat: number; lon: number; aircraftAltitudeFt: number }>;
      lateralNm?: number;
      clearanceFt?: number;
      profileStepNm?: number;
    };
    res.json(
      await demService.analyzeGroundCollision({
        routePoints: body.routePoints ?? [],
        lateralNm: body.lateralNm,
        clearanceFt: body.clearanceFt,
        profileStepNm: body.profileStepNm,
      }),
    );
  } catch (error) {
    next(error);
  }
});

app.get('/meteo/stations', (_req, res) => {
  res.json(meteoService.getStations());
});

app.get('/meteo/map/layers', (_req, res) => {
  res.json(meteoService.getMapLayers());
});

app.get('/meteo/current', async (req, res, next) => {
  try {
    res.json(await meteoService.getCurrentByStation(String(req.query.station ?? 'LTFC')));
  } catch (error) {
    next(error);
  }
});

app.get('/meteo/forecast', async (req, res, next) => {
  try {
    res.json(await meteoService.getForecastByStation(String(req.query.station ?? 'LTFC')));
  } catch (error) {
    next(error);
  }
});

app.get('/meteo/aviation', async (req, res, next) => {
  try {
    res.json(
      await meteoService.getAviationWeather(
        String(req.query.station ?? 'LTFC'),
        typeof req.query.preferredSource === 'string' ? req.query.preferredSource : undefined,
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.get('/meteo/profile/surface', async (req, res, next) => {
  try {
    res.json(await meteoService.getStationSurfaceProfile(String(req.query.station ?? 'LTFC')));
  } catch (error) {
    next(error);
  }
});

app.get('/meteo/profile/aloft', async (req, res, next) => {
  try {
    res.json(await meteoService.getStationAloftProfile(String(req.query.station ?? 'LTFC')));
  } catch (error) {
    next(error);
  }
});

app.get('/meteo/route-sample', async (req, res, next) => {
  try {
    const latitude = Number(req.query.lat);
    const longitude = Number(req.query.lon);
    const altitude = String(req.query.altitude ?? 'SFC');
    res.json(await meteoService.getRouteSample(latitude, longitude, altitude));
  } catch (error) {
    next(error);
  }
});

app.get('/meteo/airgram', async (req, res, next) => {
  try {
    const station = String(req.query.station ?? 'LTFC');
    const png = await meteoService.getAirgram(station);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (error) {
    next(error);
  }
});

app.get('/meteo/map/snapshot', async (req, res, next) => {
  try {
    const atIso = typeof req.query.at === 'string' ? req.query.at : undefined;
    res.json(await meteoService.getMapSnapshot(false, atIso));
  } catch (error) {
    next(error);
  }
});

app.get('/meteo-public/map/tile/:layer/:z/:x/:y.png', async (req, res, next) => {
  try {
    const atIso = typeof req.query.at === 'string' ? req.query.at : undefined;
    const buffer = await meteoService.getRasterTile(
      req.params.layer,
      Number(req.params.z),
      Number(req.params.x),
      Number(req.params.y),
      atIso,
    );
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.get('/meteo-public/map/value', async (req, res, next) => {
  try {
    const layer = String(req.query.layer ?? '');
    const latitude = Number(req.query.lat);
    const longitude = Number(req.query.lon);
    const atIso = typeof req.query.at === 'string' ? req.query.at : undefined;
    res.json(await meteoService.getRasterValue(layer, latitude, longitude, atIso));
  } catch (error) {
    next(error);
  }
});

app.get('/meteo-public/map/stats', async (req, res, next) => {
  try {
    const layer = String(req.query.layer ?? '');
    const north = Number(req.query.north);
    const east = Number(req.query.east);
    const south = Number(req.query.south);
    const west = Number(req.query.west);
    const atIso = typeof req.query.at === 'string' ? req.query.at : undefined;
    res.json(await meteoService.getRasterStats(layer, north, east, south, west, atIso));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: true, reason: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : 'Bilinmeyen hata';
  res.status(500).json({ error: true, reason: message });
});

const server = app.listen(config.port, config.host, () => {
  void demService.initialize().catch((error) => {
    console.warn('DEM baslatma uyarisi:', error instanceof Error ? error.message : String(error));
  });
  meteoService.start();
  console.log(`MeteoSunucu listening on http://${config.host}:${config.port}`);
});

const shutdown = () => {
  meteoService.stop();
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);