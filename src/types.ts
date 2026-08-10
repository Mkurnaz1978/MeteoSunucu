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

export interface DemServiceStatusPayload {
  enabled: boolean;
  loaded: boolean;
  rasterCount: number;
  dataPath: string;
}

export interface DemElevationPayload {
  latitude: number;
  longitude: number;
  elevationMeters: number | null;
  elevationFeet: number | null;
  source: string;
}

export interface DemAglToMslPayload {
  latitude: number;
  longitude: number;
  aglFeet: number;
  roundStepFeet: number;
  groundElevationFeet: number;
  mslFeetRoundedUp: number;
}

export interface DemElevationBatchPoint {
  lat: number;
  lon: number;
  aglFt?: number;
}

export interface DemElevationBatchPayload {
  count: number;
  results: Array<
    DemElevationPayload & {
      aglFeet?: number;
      mslFeetRoundedUp?: number;
      roundStepFeet?: number;
    }
  >;
}

export interface DemGroundCollisionRoutePoint {
  lat: number;
  lon: number;
  aircraftAltitudeFt: number;
}

export interface DemGroundCollisionAnalyzeRequest {
  routePoints: DemGroundCollisionRoutePoint[];
  lateralNm?: number;
  clearanceFt?: number;
  profileStepNm?: number;
}

export interface DemGroundCollisionAnalyzeSegment {
  index: number;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  leftFrom: { lat: number; lon: number };
  leftTo: { lat: number; lon: number };
  rightFrom: { lat: number; lon: number };
  rightTo: { lat: number; lon: number };
  minClearanceFt: number;
  severity: 'danger' | 'warning' | 'safe';
}

export interface DemGroundCollisionAnalyzeProfilePoint {
  distanceNm: number;
  lat: number;
  lon: number;
  terrainFt: number;
  aircraftAltitudeFt: number;
  clearanceFt: number;
  severity: 'danger' | 'warning' | 'safe';
}

export interface DemGroundCollisionAnalyzePayload {
  generatedAt: string;
  lateralNm: number;
  clearanceFt: number;
  totalDistanceNm: number;
  minClearanceFt: number;
  segments: DemGroundCollisionAnalyzeSegment[];
  profile: DemGroundCollisionAnalyzeProfilePoint[];
}