import dotenv from 'dotenv';

dotenv.config();

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: toInt(process.env.PORT, 3001),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? '*',
  openMeteoRefreshMs: toInt(process.env.OPEN_METEO_REFRESH_MINUTES, 15) * 60 * 1000,
  aviationRefreshMs: toInt(process.env.AVIATION_REFRESH_MINUTES, 1) * 60 * 1000,
  demEnabled: toBool(process.env.DEM_ENABLED, false),
  demDataPath: process.env.DEM_DATA_PATH ?? 'data/dem',
  demBatchMaxPoints: toInt(process.env.DEM_BATCH_MAX_POINTS, 500),
  demAglRoundStepFt: toInt(process.env.DEM_AGL_ROUND_STEP_FT, 100),
  demNoDataFallbackMeters: toFloat(process.env.DEM_NODATA_FALLBACK_METERS, 0),
  demRestrictToMeteoBbox: toBool(process.env.DEM_RESTRICT_TO_METEO_BBOX, true),
  hazerfanUrlTemplate:
    process.env.HAZERFAN_URL_TEMPLATE ??
    'https://rasat.mgm.gov.tr/result?stations={station}&obsType=1&obsType=2&hours=0',
};