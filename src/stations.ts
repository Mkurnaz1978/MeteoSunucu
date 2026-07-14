import { MeteoMapLayerDefinition, MeteoStation } from './types';

export const STATIONS: MeteoStation[] = [
  { code: 'LTFC', name: 'Isparta', lat: 37.855, lon: 30.368 },
  { code: 'LTAI', name: 'Antalya', lat: 36.899, lon: 30.8 },
  { code: 'LTAY', name: 'Cardak', lat: 37.785, lon: 29.701 },
  { code: 'LTBZ', name: 'Zafer', lat: 39.113, lon: 30.127 },
  { code: 'LTBO', name: 'Usak', lat: 38.682, lon: 29.47 },
  { code: 'LTBS', name: 'Dalaman', lat: 36.713, lon: 28.792 },
  { code: 'LTFD', name: 'Edremit', lat: 39.554, lon: 27.014 },
  { code: 'LTFE', name: 'Milas', lat: 37.25, lon: 27.664 },
  { code: 'LTFJ', name: 'Yenisehir', lat: 40.255, lon: 29.562 },
];

export const FORECAST_HOURLY_FIELDS = [
  'temperature_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'visibility',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_base',
  'precipitation_probability',
  'precipitation',
  'weather_code',
  'freezing_level_height',
  'cape',
  'lifted_index',
].join(',');

export const METEO_MAP_LAYERS: MeteoMapLayerDefinition[] = [
  { id: 'om_cloud_cover', label: 'Open-Meteo Bulutluluk', field: 'cloud_cover', unit: '%', source: 'open-meteo' },
  { id: 'om_wind_speed', label: 'Open-Meteo Ruzgar Hizi', field: 'wind_speed_10m', unit: 'km/h', source: 'open-meteo' },
  { id: 'om_wind_gust', label: 'Open-Meteo Ruzgar Hamlesi', field: 'wind_gusts_10m', unit: 'km/h', source: 'open-meteo' },
  { id: 'om_precipitation', label: 'Open-Meteo Yagis', field: 'precipitation', unit: 'mm', source: 'open-meteo' },
  { id: 'om_temperature', label: 'Open-Meteo Sicaklik', field: 'temperature_2m', unit: 'C', source: 'open-meteo' },
  { id: 'om_depression', label: 'Open-Meteo Depresyon (Basinc)', field: 'surface_pressure', unit: 'hPa', source: 'open-meteo' },
  { id: 'om_turbulence', label: 'Open-Meteo Turbulans (CAPE)', field: 'cape', unit: 'J/kg', source: 'open-meteo' },
  { id: 'om_flight_risk', label: 'Ucus Risk Indeksi', field: 'flight_risk_index', unit: 'risk', source: 'open-meteo' },
  { id: 'om_flight_suitability', label: 'Ucusa Elveris Skoru', field: 'flight_suitability_index', unit: 'puan', source: 'open-meteo' },
  { id: 'om_low_cloud_cover', label: 'Alcak Seviye Bulut Orani', field: 'cloud_cover_low', unit: '%', source: 'open-meteo' },
];

export const RASTER_BBOX = {
  north: 41.3,
  east: 33.2,
  south: 35.7,
  west: 25.7,
};

export const RASTER_GRID_STEP_DEG = 0.4;
export const RASTER_TILE_SIZE = 256;

export const PRESSURE_LEVEL_BY_ALTITUDE: Record<string, string> = {
  '5000': '850',
  '6000': '800',
  '7000': '775',
  '8000': '750',
  '9000': '725',
  '10000': '700',
};