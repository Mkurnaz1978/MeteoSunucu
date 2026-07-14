import dotenv from 'dotenv';

dotenv.config();

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: toInt(process.env.PORT, 3001),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? '*',
  openMeteoRefreshMs: toInt(process.env.OPEN_METEO_REFRESH_MINUTES, 15) * 60 * 1000,
  aviationRefreshMs: toInt(process.env.AVIATION_REFRESH_MINUTES, 1) * 60 * 1000,
  hazerfanUrlTemplate:
    process.env.HAZERFAN_URL_TEMPLATE ??
    'https://rasat.mgm.gov.tr/result?stations={station}&obsType=1&obsType=2&hours=0',
};