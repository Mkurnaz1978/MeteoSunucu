export interface MeteoStation {
  code: string;
  name: string;
  lat: number;
  lon: number;
}

export interface MeteoCurrentPayload {
  station: MeteoStation;
  updatedAt: string;
  current: Record<string, unknown>;
  currentUnits?: Record<string, unknown> | null;
  daily?: Record<string, unknown> | null;
  dailyUnits?: Record<string, unknown> | null;
  forecast?: MeteoForecastPayload | null;
  elevation?: number | null;
  latitude?: number;
  longitude?: number;
}

export interface MeteoForecastPayload {
  station: MeteoStation;
  updatedAt: string;
  hourly: Record<string, unknown>;
  meteogram?: MeteogramPayload | null;
  hourlyUnits?: Record<string, unknown> | null;
  elevation?: number | null;
  latitude?: number;
  longitude?: number;
}

export interface MeteogramPoint {
  time: string;
  temperatureC: number | null;
  windSpeedKt: number | null;
  windGustKt: number | null;
  cloudCoverPct: number | null;
  lowCloudPct: number | null;
  visibilityKm: number | null;
  precipitationMm: number | null;
  freezingLevelFt: number | null;
  riskIndex: number | null;
  suitabilityScore: number | null;
}

export interface MeteogramPayload {
  stationCode: string;
  generatedAt: string;
  points: MeteogramPoint[];
}

export interface AviationWeatherPayload {
  station: MeteoStation;
  updatedAt: string;
  source: 'hazerfan' | 'noaa';
  metar: string | null;
  taf: string | null;
  fallbackUsed: boolean;
}

export interface MeteoMapLayerDefinition {
  id: string;
  label: string;
  field: string;
  unit: string;
  source: 'open-meteo';
}

export interface MeteoMapPoint {
  station: MeteoStation;
  updatedAt: string;
  latitude: number;
  longitude: number;
  values: Record<string, number | null>;
}

export interface MeteoMapSnapshotPayload {
  generatedAt: string;
  layers: MeteoMapLayerDefinition[];
  points: MeteoMapPoint[];
}

export interface MeteoRasterGridPoint {
  latitude: number;
  longitude: number;
  values: Record<string, number | null>;
}

export interface MeteoRasterGridPayload {
  generatedAt: string;
  hourIso: string;
  bbox: {
    north: number;
    east: number;
    south: number;
    west: number;
  };
  stepDegrees: number;
  latitudes: number[];
  longitudes: number[];
  points: MeteoRasterGridPoint[];
}

export interface MeteoRasterValuePayload {
  layerId: string;
  field: string;
  unit: string;
  hourIso: string;
  query: {
    latitude: number;
    longitude: number;
  };
  sample: {
    latitude: number;
    longitude: number;
    value: number | null;
  };
}

export interface MeteoRasterStatsPayload {
  layerId: string;
  field: string;
  unit: string;
  hourIso: string;
  bbox: {
    north: number;
    east: number;
    south: number;
    west: number;
  };
  min: number | null;
  max: number | null;
  mean: number | null;
  sampleCount: number;
}

export interface RouteSamplePayload {
  latitude: number;
  longitude: number;
  altitude: string;
  elevation: number;
  temperature: number;
  humidity: number;
  windSpeed: number;
  windDirection: number;
  precipitation: number | null;
  cloudCover: number | null;
}