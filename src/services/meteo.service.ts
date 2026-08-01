import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { parse } from 'node-html-parser';
import { PNG } from 'pngjs';
import { config } from '../config';
import {
  FORECAST_HOURLY_FIELDS,
  METEO_MAP_LAYERS,
  PRESSURE_LEVEL_BY_ALTITUDE,
  RASTER_BBOX,
  RASTER_GRID_STEP_DEG,
  RASTER_TILE_SIZE,
  STATIONS,
} from '../stations';
import {
  AviationWeatherPayload,
  MeteoCurrentPayload,
  MeteoForecastPayload,
  MeteoMapLayerDefinition,
  MeteoMapPoint,
  MeteoMapSnapshotPayload,
  MeteoRasterGridPayload,
  MeteoRasterGridPoint,
  MeteoRasterStatsPayload,
  MeteoRasterValuePayload,
  MeteogramPayload,
  MeteogramPoint,
  MeteoStation,
  RouteSamplePayload,
} from '../types';

type CachedEntry<T> = {
  updatedAt: string;
  data: T;
};

type AviationSource = 'hazerfan' | 'noaa';

type AviationCacheEntry = {
  updatedAt: string;
  bySource: Partial<Record<AviationSource, AviationWeatherPayload>>;
};

type EnhancedRasterField = {
  width: number;
  height: number;
  values01: Float32Array;
};

const FLIGHT_RISK_LAYER_ID = 'om_flight_risk';
const FLIGHT_RISK_FIELD = 'flight_risk_index';
const FLIGHT_SUITABILITY_LAYER_ID = 'om_flight_suitability';
const FLIGHT_SUITABILITY_FIELD = 'flight_suitability_index';
const LOW_CLOUD_LAYER_ID = 'om_low_cloud_cover';
const LOW_CLOUD_FIELD = 'cloud_cover_low';
const FLIGHT_RISK_REQUIRED_FIELDS = [
  'wind_speed_10m',
  'wind_gusts_10m',
  'visibility',
  'cape',
  'lifted_index',
  'precipitation',
  'cloud_base',
] as const;
const KNOTS_TO_KMH = 1.852;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class MeteoService {
  private openMeteoTimer?: NodeJS.Timeout;
  private aviationTimer?: NodeJS.Timeout;
  private readonly currentCache = new Map<string, MeteoCurrentPayload>();
  private readonly forecastCache = new Map<string, MeteoForecastPayload>();
  private readonly aviationCache = new Map<string, AviationCacheEntry>();
  private readonly surfaceProfileCache = new Map<string, CachedEntry<Record<string, unknown>>>();
  private readonly aloftProfileCache = new Map<string, CachedEntry<Record<string, unknown>>>();
  private readonly routeSampleCache = new Map<string, CachedEntry<RouteSamplePayload>>();
  private readonly airgramCache = new Map<string, CachedEntry<Buffer>>();
  private mapSnapshotCache?: MeteoMapSnapshotPayload;
  private readonly rasterGridInFlight = new Map<string, Promise<MeteoRasterGridPayload>>();
  private readonly rasterGridByHour = new Map<string, MeteoRasterGridPayload>();
  private readonly enhancedFieldCache = new Map<string, EnhancedRasterField>();
  private latestRasterHour?: string;
  private readonly tileCache = new Map<string, Buffer>();
  private static readonly TILE_CACHE_MAX = 6000;
  private emptyTilePngBuffer: Buffer | null = null;
  private turboColorLut: Array<[number, number, number]> | null = null;
  private rasterWarmTimer?: NodeJS.Timeout;
  // Uygulamadaki "saat animasyonu" secenekleriyle ayni (map_page.dart
  // dropdown'u): bu ofsetleri arka planda onceden isitarak, kullanici
  // ileri bir saat sectiginde Open-Meteo'ya canli/agir bir cok-noktali
  // istek beklemek zorunda kalmiyor.
  private static readonly RASTER_WARM_OFFSET_HOURS = [0, 1, 2, 3, 4, 5, 6, 12, 24];

  start(): void {
    void this.refreshAllStations();
    void this.refreshAllAviation();

    this.openMeteoTimer = setInterval(() => {
      void this.refreshAllStations();
    }, config.openMeteoRefreshMs);
    this.openMeteoTimer.unref?.();

    this.aviationTimer = setInterval(() => {
      void this.refreshAllAviation();
    }, config.aviationRefreshMs);
    this.aviationTimer.unref?.();

    if (process.env.ENABLE_RASTER_PREWARM === 'true') {
      this.rasterWarmTimer = setInterval(() => {
        void this.prewarmRasterGrids();
      }, 20 * 60 * 1000);
      this.rasterWarmTimer.unref?.();
    }
  }

  // Open-Meteo'nun cok-noktali istekleri agir/rate-limitli sayabildigi
  // gozlemlendiginden, offsetleri seri (paralel degil) ve aralarinda kisa
  // bir bekleme ile isitiyoruz; tek bir offset basarisiz olsa da digerlerini
  // engellemez.
  private async prewarmRasterGrids(): Promise<void> {
    const base = this.roundedUtcHourNow();
    for (const offsetHours of MeteoService.RASTER_WARM_OFFSET_HOURS) {
      const hourIso = new Date(base.getTime() + offsetHours * 60 * 60 * 1000).toISOString();
      try {
        await this.refreshRasterGrid(hourIso);
      } catch (error) {
        console.warn(`Raster grid on-isitma basarisiz (+${offsetHours}h):`, error instanceof Error ? error.message : error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  private roundedUtcHourNow(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  }

  stop(): void {
    if (this.openMeteoTimer) {
      clearInterval(this.openMeteoTimer);
      this.openMeteoTimer = undefined;
    }
    if (this.aviationTimer) {
      clearInterval(this.aviationTimer);
      this.aviationTimer = undefined;
    }
    if (this.rasterWarmTimer) {
      clearInterval(this.rasterWarmTimer);
      this.rasterWarmTimer = undefined;
    }
  }

  getStations(): MeteoStation[] {
    return STATIONS;
  }

  getMapLayers(): MeteoMapLayerDefinition[] {
    return METEO_MAP_LAYERS;
  }

  getStation(code: string): MeteoStation | undefined {
    return STATIONS.find((station) => station.code.toUpperCase() === code.toUpperCase());
  }

  private isFresh(updatedAt: string | undefined, ttlMs: number): boolean {
    if (!updatedAt) return false;
    const timestamp = Date.parse(updatedAt);
    if (Number.isNaN(timestamp)) return false;
    return Date.now() - timestamp < ttlMs;
  }

  private parseNumeric(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private isSyntheticField(field: string): boolean {
    return field === FLIGHT_RISK_FIELD || field === FLIGHT_SUITABILITY_FIELD;
  }

  private rasterRequestFields(): string[] {
    const fields = new Set<string>();
    for (const layer of METEO_MAP_LAYERS) {
      if (!this.isSyntheticField(layer.field)) {
        fields.add(layer.field);
      }
    }
    for (const field of FLIGHT_RISK_REQUIRED_FIELDS) {
      fields.add(field);
    }
    fields.add(LOW_CLOUD_FIELD);
    return Array.from(fields);
  }

  private scoreWindKt(windKts: number): number {
    if (windKts < 10) return 0;
    if (windKts < 15) return 1;
    if (windKts < 20) return 2;
    if (windKts < 25) return 4;
    return 7;
  }

  private scoreVisibilityKm(visibilityKm: number): number {
    if (visibilityKm > 10) return 0;
    if (visibilityKm >= 5) return 2;
    if (visibilityKm >= 3) return 5;
    return 8;
  }

  private scoreCape(cape: number): number {
    if (cape < 100) return 0;
    if (cape < 500) return 1;
    if (cape < 1000) return 2;
    return 5;
  }

  private scoreLiftedIndex(li: number): number {
    if (li > 2) return 0;
    if (li >= 0) return 1;
    if (li >= -2) return 3;
    return 6;
  }

  private scorePrecipitationMmPerHour(precip: number): number {
    return precip > 1 ? 4 : 0;
  }

  private scoreCloudBaseFt(cloudBaseFt: number): number {
    if (cloudBaseFt < 1000) return 7;
    if (cloudBaseFt < 2000) return 5;
    if (cloudBaseFt < 3000) return 2;
    return 0;
  }

  private flightSuitabilityCapFromLowCloud(cloudCoverLow: number): number {
    if (cloudCoverLow >= 80) return 0;
    if (cloudCoverLow >= 60) return 4;
    if (cloudCoverLow >= 40) return 8;
    if (cloudCoverLow >= 20) return 12;
    return 20;
  }

  private scoreFlightSuitability(riskScore: number, cloudCoverLow: number): number {
    const baseSuitability = Math.max(0, 20 - riskScore);
    const lowCloudCap = this.flightSuitabilityCapFromLowCloud(cloudCoverLow);
    return Math.max(0, Math.min(baseSuitability, lowCloudCap));
  }

  private flightRiskColor(value: number): [number, number, number] {
    if (value <= 5) return [46, 125, 50];
    if (value <= 10) return [249, 168, 37];
    if (value <= 15) return [239, 108, 0];
    if (value <= 20) return [198, 40, 40];
    return [33, 33, 33];
  }

  private flightSuitabilityColor(value: number): [number, number, number] {
    if (value >= 16) return [46, 125, 50];
    if (value >= 11) return [249, 168, 37];
    if (value >= 6) return [239, 108, 0];
    if (value >= 1) return [198, 40, 40];
    return [33, 33, 33];
  }

  private lowCloudColor(value: number): [number, number, number] {
    if (value >= 80) return [198, 40, 40];
    if (value >= 60) return [239, 108, 0];
    if (value >= 40) return [249, 168, 37];
    if (value >= 20) return [46, 125, 50];
    return [33, 150, 243];
  }

  private computeFlightRiskScoreFromInputs(inputs: {
    windSpeedKmh: number | null;
    windGustKmh: number | null;
    visibilityMeters: number | null;
    cape: number | null;
    liftedIndex: number | null;
    precipitationMmPerHour: number | null;
    cloudBaseMeters: number | null;
  }): number {
    const windKts = (inputs.windSpeedKmh ?? 0) * 0.5399568;
    const gustKts = (inputs.windGustKmh ?? 0) * 0.5399568;
    const visibilityKm = Math.max(0, (inputs.visibilityMeters ?? 20000) / 1000);
    const cape = Math.max(0, inputs.cape ?? 0);
    const liftedIndex = inputs.liftedIndex ?? 3;
    const precipitation = Math.max(0, inputs.precipitationMmPerHour ?? 0);
    const cloudBaseFt = Math.max(0, (inputs.cloudBaseMeters ?? 10000) * 3.28084);

    let score = 0;
    score += this.scoreWindKt(windKts);
    if (gustKts > windKts + 8) score += 3;
    score += this.scoreVisibilityKm(visibilityKm);
    score += this.scoreCape(cape);
    score += this.scoreLiftedIndex(liftedIndex);
    score += this.scorePrecipitationMmPerHour(precipitation);
    score += this.scoreCloudBaseFt(cloudBaseFt);
    return score;
  }

  private computeFlightRiskScoreFromPointValues(values: Record<string, number | null>): number {
    return this.computeFlightRiskScoreFromInputs({
      windSpeedKmh: this.parseNumeric(values.wind_speed_10m),
      windGustKmh: this.parseNumeric(values.wind_gusts_10m),
      visibilityMeters: this.parseNumeric(values.visibility),
      cape: this.parseNumeric(values.cape),
      liftedIndex: this.parseNumeric(values.lifted_index),
      precipitationMmPerHour: this.parseNumeric(values.precipitation),
      cloudBaseMeters: this.parseNumeric(values.cloud_base),
    });
  }

  private computeFlightSuitabilityScoreFromPointValues(values: Record<string, number | null>): number {
    const riskScore = this.computeFlightRiskScoreFromPointValues(values);
    const cloudCoverLow = this.computeLowCloudCoverFromInputs({
      cloud_cover: this.parseNumeric(values.cloud_cover),
      cloud_base: this.parseNumeric(values.cloud_base),
    });
    return this.scoreFlightSuitability(riskScore, cloudCoverLow);
  }

  private computeLowCloudCoverFromInputs(values: Record<string, number | null>): number {
    const cloudCover = Math.max(0, Math.min(100, this.parseNumeric(values.cloud_cover) ?? 0));
    const cloudBaseMeters = Math.max(0, this.parseNumeric(values.cloud_base) ?? 0);
    const lowCloudFactor = cloudBaseMeters <= 1000 ? 1 : cloudBaseMeters <= 2000 ? 0.6 : cloudBaseMeters <= 3000 ? 0.3 : 0.1;
    return Math.round(cloudCover * lowCloudFactor);
  }

  private buildMeteogram(stationCode: string, hourly: Record<string, unknown>): MeteogramPayload {
    const times = (hourly.time as unknown[]) ?? [];
    const tempSeries = (hourly.temperature_2m as unknown[]) ?? [];
    const windSeries = (hourly.wind_speed_10m as unknown[]) ?? [];
    const gustSeries = (hourly.wind_gusts_10m as unknown[]) ?? [];
    const cloudSeries = (hourly.cloud_cover as unknown[]) ?? [];
    const lowCloudSeries = (hourly.cloud_cover_low as unknown[]) ?? [];
    const visibilitySeries = (hourly.visibility as unknown[]) ?? [];
    const precipitationSeries = (hourly.precipitation as unknown[]) ?? [];
    const freezingSeries = (hourly.freezing_level_height as unknown[]) ?? [];
    const capeSeries = (hourly.cape as unknown[]) ?? [];
    const liftedSeries = (hourly.lifted_index as unknown[]) ?? [];

    const points: MeteogramPoint[] = [];
    for (let i = 0; i < times.length; i += 1) {
      const time = String(times[i] ?? '');
      if (!time) continue;

      const temperatureC = this.parseNumeric(tempSeries[i]);
      const windSpeedKt = this.parseNumeric(windSeries[i]);
      const windGustKt = this.parseNumeric(gustSeries[i]);
      const cloudCoverPct = this.parseNumeric(cloudSeries[i]);
      const lowCloudPctRaw = this.parseNumeric(lowCloudSeries[i]);
      const visibilityMeters = this.parseNumeric(visibilitySeries[i]);
      const visibilityKm = visibilityMeters != null ? Math.max(0, visibilityMeters / 1000) : null;
      const precipitationMm = this.parseNumeric(precipitationSeries[i]);
      const freezingLevelM = this.parseNumeric(freezingSeries[i]);
      const freezingLevelFt = freezingLevelM != null ? freezingLevelM * 3.28084 : null;

      const cloudBaseMeters = freezingLevelM != null ? Math.max(0, freezingLevelM * 0.35) : null;
      const lowCloudPct = lowCloudPctRaw != null
        ? Math.max(0, Math.min(100, lowCloudPctRaw))
        : this.computeLowCloudCoverFromInputs({
            cloud_cover: cloudCoverPct,
            cloud_base: cloudBaseMeters,
          });

      const riskIndex = this.computeFlightRiskScoreFromInputs({
        windSpeedKmh: windSpeedKt != null ? windSpeedKt / 0.5399568 : null,
        windGustKmh: windGustKt != null ? windGustKt / 0.5399568 : null,
        visibilityMeters,
        cape: this.parseNumeric(capeSeries[i]),
        liftedIndex: this.parseNumeric(liftedSeries[i]),
        precipitationMmPerHour: precipitationMm,
        cloudBaseMeters,
      });

      const suitabilityScore = this.scoreFlightSuitability(riskIndex, lowCloudPct);

      points.push({
        time,
        temperatureC,
        windSpeedKt,
        windGustKt,
        cloudCoverPct,
        lowCloudPct,
        visibilityKm,
        precipitationMm,
        freezingLevelFt,
        riskIndex,
        suitabilityScore,
      });
    }

    return {
      stationCode,
      generatedAt: new Date().toISOString(),
      points,
    };
  }

  private fixedScaleForLayer(layerId: string): { min: number; max: number } | null {
    switch (layerId) {
      case FLIGHT_RISK_LAYER_ID:
        return { min: 0, max: 25 };
      case FLIGHT_SUITABILITY_LAYER_ID:
        return { min: 0, max: 20 };
      case LOW_CLOUD_LAYER_ID:
        return { min: 0, max: 100 };
      case 'om_wind_speed':
      case 'om_wind_gust':
        // Sabit renklendirme: 0-30 knot (alan verisi km/h olarak tutuluyor).
        return { min: 0, max: 30 * KNOTS_TO_KMH };
      case 'om_temperature':
        // Sabit renklendirme: -10C ile 40C arasi.
        return { min: -10, max: 40 };
      case 'om_precipitation':
        // Sabit renklendirme: 0-20 mm/saat (hafiften siddetli yagmura kadar).
        return { min: 0, max: 20 };
      default:
        return null;
    }
  }

  private computeFlightRiskAtPointValues(values: Record<string, number | null>): number {
    return this.computeFlightRiskScoreFromInputs({
      windSpeedKmh: this.parseNumeric(values.wind_speed_10m),
      windGustKmh: this.parseNumeric(values.wind_gusts_10m),
      visibilityMeters: this.parseNumeric(values.visibility),
      cape: this.parseNumeric(values.cape),
      liftedIndex: this.parseNumeric(values.lifted_index),
      precipitationMmPerHour: this.parseNumeric(values.precipitation),
      cloudBaseMeters: this.parseNumeric(values.cloud_base),
    });
  }

  private normalizeAviationSource(preferredSource?: string): {
    source: AviationSource;
    explicitlySelected: boolean;
  } {
    if (preferredSource === 'noaa') {
      return { source: 'noaa', explicitlySelected: true };
    }
    if (preferredSource === 'hazerfan') {
      return { source: 'hazerfan', explicitlySelected: true };
    }
    return { source: 'hazerfan', explicitlySelected: false };
  }

  private getFreshAviationFromCache(
    cacheEntry: AviationCacheEntry | undefined,
    source: AviationSource,
  ): AviationWeatherPayload | null {
    if (!cacheEntry) return null;
    const payload = cacheEntry.bySource[source];
    if (!payload) return null;
    if (!this.isFresh(payload.updatedAt, config.aviationRefreshMs)) return null;
    return { ...payload, fallbackUsed: false };
  }

  private ensureStation(stationCode: string): MeteoStation {
    const station = this.getStation(stationCode);
    if (!station) {
      throw new HttpError(400, `Gecersiz istasyon: ${stationCode}`);
    }
    return station;
  }

  async getCurrentByStation(stationCode: string): Promise<MeteoCurrentPayload> {
    const station = this.ensureStation(stationCode);
    const cached = this.currentCache.get(station.code);
    if (cached && this.isFresh(cached.updatedAt, config.openMeteoRefreshMs)) {
      return {
        ...cached,
        forecast: await this.getCachedForecastByStation(station.code),
      };
    }

    return this.refreshStation(station.code);
  }

  async getForecastByStation(stationCode: string): Promise<MeteoForecastPayload> {
    const station = this.ensureStation(stationCode);
    const cached = this.forecastCache.get(station.code);
    if (cached && this.isFresh(cached.updatedAt, config.openMeteoRefreshMs)) {
      return cached;
    }
    return this.refreshForecastStation(station.code);
  }

  private async getCachedForecastByStation(stationCode: string): Promise<MeteoForecastPayload | null> {
    const cached = this.forecastCache.get(stationCode.toUpperCase());
    if (cached && this.isFresh(cached.updatedAt, config.openMeteoRefreshMs)) {
      return cached;
    }
    try {
      return await this.refreshForecastStation(stationCode);
    } catch {
      return cached ?? null;
    }
  }

  async refreshAllStations(): Promise<void> {
    for (const station of STATIONS) {
      await this.refreshStation(station.code).catch(() => null);
      await this.refreshForecastStation(station.code).catch(() => null);
      // Open-Meteo 429 riskini azaltmak icin istekleri yavaslat.
      await this.delay(250);
    }

    await Promise.allSettled([this.refreshMapSnapshot(), this.refreshRasterGrid()]);
  }

  async refreshAllAviation(): Promise<void> {
    await Promise.allSettled(STATIONS.map((station) => this.refreshAviationWeather(station.code)));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async refreshStation(stationCode: string): Promise<MeteoCurrentPayload> {
    const station = this.ensureStation(stationCode);
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${station.lat}` +
      `&longitude=${station.lon}` +
      '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,cloud_cover,cloud_cover_low,cloud_base,weather_code,surface_pressure,dew_point_2m,relative_humidity_2m,precipitation' +
      '&daily=sunrise,sunset,daylight_duration' +
      '&timezone=UTC' +
      '&forecast_days=1';

    try {
      const response = await axios.get(url, { timeout: 15000 });
      const data = response.data ?? {};

      const payload: MeteoCurrentPayload = {
        station,
        updatedAt: new Date().toISOString(),
        current: data.current ?? {},
        currentUnits: data.current_units ?? null,
        daily: data.daily ?? null,
        dailyUnits: data.daily_units ?? null,
        forecast: await this.getCachedForecastByStation(station.code),
        elevation: this.parseNumeric(data.elevation),
        latitude: this.parseNumeric(data.latitude) ?? undefined,
        longitude: this.parseNumeric(data.longitude) ?? undefined,
      };

      this.currentCache.set(station.code, payload);
      return payload;
    } catch (error) {
      const cached = this.currentCache.get(station.code);
      if (cached) return cached;
      throw this.toOpenMeteoHttpError(error, `Open-Meteo current verisi alinamadi: ${station.code}`);
    }
  }

  async refreshForecastStation(stationCode: string): Promise<MeteoForecastPayload> {
    const station = this.ensureStation(stationCode);
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${station.lat}` +
      `&longitude=${station.lon}` +
      `&hourly=${FORECAST_HOURLY_FIELDS}` +
      '&forecast_hours=168' +
      '&temperature_unit=celsius' +
      '&wind_speed_unit=kn' +
      '&precipitation_unit=mm' +
      '&timezone=Europe%2FIstanbul';

    try {
      const response = await axios.get(url, { timeout: 15000 });
      const data = response.data ?? {};

      const payload: MeteoForecastPayload = {
        station,
        updatedAt: new Date().toISOString(),
        hourly: data.hourly ?? {},
        meteogram: this.buildMeteogram(station.code, (data.hourly ?? {}) as Record<string, unknown>),
        hourlyUnits: data.hourly_units ?? null,
        elevation: this.parseNumeric(data.elevation),
        latitude: this.parseNumeric(data.latitude) ?? undefined,
        longitude: this.parseNumeric(data.longitude) ?? undefined,
      };

      this.forecastCache.set(station.code, payload);
      const current = this.currentCache.get(station.code);
      if (current) {
        this.currentCache.set(station.code, { ...current, forecast: payload });
      }
      return payload;
    } catch (error) {
      const cached = this.forecastCache.get(station.code);
      if (cached) return cached;
      throw this.toOpenMeteoHttpError(error, `Open-Meteo forecast verisi alinamadi: ${station.code}`);
    }
  }

  async getAviationWeather(stationCode: string, preferredSource?: string): Promise<AviationWeatherPayload> {
    const station = this.ensureStation(stationCode);
    const { source, explicitlySelected } = this.normalizeAviationSource(preferredSource);
    const cachedEntry = this.aviationCache.get(station.code);
    const selectedFresh = this.getFreshAviationFromCache(cachedEntry, source);
    if (selectedFresh) {
      return selectedFresh;
    }

    if (!explicitlySelected && cachedEntry) {
      const alternateSource: AviationSource = source === 'hazerfan' ? 'noaa' : 'hazerfan';
      const alternateFresh = this.getFreshAviationFromCache(cachedEntry, alternateSource);
      if (alternateFresh) {
        return { ...alternateFresh, fallbackUsed: true };
      }
    }

    return this.refreshAviationWeather(station.code, preferredSource);
  }

  async refreshAviationWeather(stationCode: string, preferredSource?: string): Promise<AviationWeatherPayload> {
    const station = this.ensureStation(stationCode);
    const { source, explicitlySelected } = this.normalizeAviationSource(preferredSource);
    const previousCache = this.aviationCache.get(station.code);
    const nextBySource: Partial<Record<AviationSource, AviationWeatherPayload>> = {
      ...(previousCache?.bySource ?? {}),
    };
    const errors: string[] = [];

    const results = await Promise.allSettled([
      this.fetchHazerfanLikeWeather(station),
      this.fetchNoaaWeather(station),
    ]);

    const [hazerfanResult, noaaResult] = results;

    if (hazerfanResult.status === 'fulfilled') {
      nextBySource.hazerfan = { ...hazerfanResult.value, fallbackUsed: false };
    } else {
      errors.push(`hazerfan: ${hazerfanResult.reason instanceof Error ? hazerfanResult.reason.message : String(hazerfanResult.reason)}`);
    }

    if (noaaResult.status === 'fulfilled') {
      nextBySource.noaa = { ...noaaResult.value, fallbackUsed: false };
    } else {
      errors.push(`noaa: ${noaaResult.reason instanceof Error ? noaaResult.reason.message : String(noaaResult.reason)}`);
    }

    const cacheEntry: AviationCacheEntry = {
      updatedAt: new Date().toISOString(),
      bySource: nextBySource,
    };
    this.aviationCache.set(station.code, cacheEntry);

    const selectedPayload = cacheEntry.bySource[source];
    if (selectedPayload) {
      return { ...selectedPayload, fallbackUsed: false };
    }

    if (!explicitlySelected) {
      const alternateSource: AviationSource = source === 'hazerfan' ? 'noaa' : 'hazerfan';
      const alternatePayload = cacheEntry.bySource[alternateSource];
      if (alternatePayload) {
        return { ...alternatePayload, fallbackUsed: true };
      }
    }

    throw new HttpError(
      503,
      `Secilen kaynakta METAR/TAF verisi alinamadi (${source}): ${errors.join(' | ')}`,
    );
  }

  private async fetchHazerfanLikeWeather(station: MeteoStation): Promise<AviationWeatherPayload> {
    const url = config.hazerfanUrlTemplate.replace('{station}', encodeURIComponent(station.code));
    const response = await axios.get<string>(url, { timeout: 15000, responseType: 'text' });
    const root = parse(response.data);
    const pageText = root.innerText;
    const metar = this.extractSection(pageText, 'METAR', 'TAF');
    const taf = this.extractSection(pageText, 'TAF');

    if (!metar && !taf) {
      throw new Error('Birincil kaynakta METAR/TAF bulunamadi');
    }

    return {
      station,
      updatedAt: new Date().toISOString(),
      source: 'hazerfan',
      metar,
      taf,
      fallbackUsed: false,
    };
  }

  private extractSection(text: string, startToken: string, endToken?: string): string | null {
    const startIndex = text.indexOf(startToken);
    if (startIndex === -1) return null;

    const afterStart = text.substring(startIndex);
    const copyrightIndex = afterStart.indexOf('©');
    const endIndex = endToken ? afterStart.indexOf(endToken) : -1;

    let cutIndex = afterStart.length > 500 ? 500 : afterStart.length;
    if (endIndex !== -1) {
      cutIndex = endIndex;
    } else if (copyrightIndex !== -1) {
      cutIndex = copyrightIndex;
    }

    return afterStart.substring(0, cutIndex).replace(/\s+/g, ' ').trim();
  }

  private async fetchNoaaWeather(station: MeteoStation): Promise<AviationWeatherPayload> {
    const metarUrl = `https://aviationweather.gov/api/data/metar?ids=${station.code}&format=json`;
    const tafUrl = `https://aviationweather.gov/api/data/taf?ids=${station.code}&format=json`;

    const [metarResponse, tafResponse] = await Promise.all([
      axios.get<Array<Record<string, unknown>>>(metarUrl, { timeout: 15000 }),
      axios.get<Array<Record<string, unknown>>>(tafUrl, { timeout: 15000 }),
    ]);

    const metar = metarResponse.data?.[0]?.rawOb;
    const taf = tafResponse.data?.[0]?.rawTAF;

    if (!metar && !taf) {
      throw new Error('NOAA kaynagi bos dondu');
    }

    return {
      station,
      updatedAt: new Date().toISOString(),
      source: 'noaa',
      metar: typeof metar === 'string' ? metar : null,
      taf: typeof taf === 'string' ? taf : null,
      fallbackUsed: false,
    };
  }

  async getStationSurfaceProfile(stationCode: string): Promise<Record<string, unknown>> {
    const station = this.ensureStation(stationCode);
    const cacheKey = station.code;
    const cached = this.surfaceProfileCache.get(cacheKey);
    if (cached && this.isFresh(cached.updatedAt, config.openMeteoRefreshMs)) {
      return cached.data;
    }

    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${station.lat}` +
      `&longitude=${station.lon}` +
      '&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m' +
      '&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m' +
      '&timezone=Europe%2FIstanbul' +
      '&forecast_days=3';

    const response = await axios.get<Record<string, unknown>>(url, { timeout: 15000 });
    const entry = { updatedAt: new Date().toISOString(), data: response.data };
    this.surfaceProfileCache.set(cacheKey, entry);
    return entry.data;
  }

  async getStationAloftProfile(stationCode: string): Promise<Record<string, unknown>> {
    const station = this.ensureStation(stationCode);
    const cacheKey = station.code;
    const cached = this.aloftProfileCache.get(cacheKey);
    if (cached && this.isFresh(cached.updatedAt, config.openMeteoRefreshMs)) {
      return cached.data;
    }

    const hourly = [
      'temperature_925hPa',
      'temperature_850hPa',
      'temperature_800hPa',
      'temperature_775hPa',
      'temperature_750hPa',
      'temperature_725hPa',
      'temperature_700hPa',
      'wind_speed_925hPa',
      'wind_speed_850hPa',
      'wind_speed_800hPa',
      'wind_speed_775hPa',
      'wind_speed_750hPa',
      'wind_speed_725hPa',
      'wind_speed_700hPa',
      'wind_direction_925hPa',
      'wind_direction_850hPa',
      'wind_direction_800hPa',
      'wind_direction_775hPa',
      'wind_direction_750hPa',
      'wind_direction_725hPa',
      'wind_direction_700hPa',
      'relative_humidity_925hPa',
      'relative_humidity_850hPa',
      'relative_humidity_800hPa',
      'relative_humidity_775hPa',
      'relative_humidity_750hPa',
      'relative_humidity_725hPa',
      'relative_humidity_700hPa',
      'cape',
      'lifted_index',
    ].join(',');

    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${station.lat}` +
      `&longitude=${station.lon}` +
      '&current=temperature_2m,surface_pressure' +
      `&hourly=${hourly}` +
      '&timezone=Europe%2FIstanbul' +
      '&forecast_days=1';

    const response = await axios.get<Record<string, unknown>>(url, { timeout: 15000 });
    const entry = { updatedAt: new Date().toISOString(), data: response.data };
    this.aloftProfileCache.set(cacheKey, entry);
    return entry.data;
  }

  async getRouteSample(latitude: number, longitude: number, altitude: string): Promise<RouteSamplePayload> {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new HttpError(400, 'Gecersiz koordinat');
    }

    const normalizedAltitude = altitude || 'SFC';
    const cacheKey = `${latitude.toFixed(3)}:${longitude.toFixed(3)}:${normalizedAltitude}`;
    const cached = this.routeSampleCache.get(cacheKey);
    if (cached && this.isFresh(cached.updatedAt, config.openMeteoRefreshMs)) {
      return cached.data;
    }

    let url: string;
    if (normalizedAltitude === 'SFC') {
      url =
        'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${latitude}` +
        `&longitude=${longitude}` +
        '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,cloud_cover_low' +
        '&timezone=Europe%2FIstanbul';
    } else {
      const pressureLevel = PRESSURE_LEVEL_BY_ALTITUDE[normalizedAltitude];
      if (!pressureLevel) {
        throw new HttpError(400, `Desteklenmeyen altitude: ${normalizedAltitude}`);
      }
      url =
        'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${latitude}` +
        `&longitude=${longitude}` +
        '&current=precipitation,cloud_cover,cloud_cover_low' +
        `&hourly=temperature_${pressureLevel}hPa,relative_humidity_${pressureLevel}hPa,wind_speed_${pressureLevel}hPa,wind_direction_${pressureLevel}hPa` +
        '&forecast_hours=1' +
        '&timezone=Europe%2FIstanbul';
    }

    const response = await axios.get<Record<string, unknown>>(url, { timeout: 15000 });
    const data = response.data;
    const current = (data.current as Record<string, unknown> | undefined) ?? {};
    const hourly = (data.hourly as Record<string, unknown> | undefined) ?? {};

    let temperature = 0;
    let humidity = 0;
    let windSpeed = 0;
    let windDirection = 0;

    if (normalizedAltitude === 'SFC') {
      temperature = this.parseNumeric(current.temperature_2m) ?? 0;
      humidity = this.parseNumeric(current.relative_humidity_2m) ?? 0;
      windSpeed = this.parseNumeric(current.wind_speed_10m) ?? 0;
      windDirection = this.parseNumeric(current.wind_direction_10m) ?? 0;
    } else {
      const pressureLevel = PRESSURE_LEVEL_BY_ALTITUDE[normalizedAltitude];
      const temperatureSeries = hourly[`temperature_${pressureLevel}hPa`];
      const humiditySeries = hourly[`relative_humidity_${pressureLevel}hPa`];
      const windSpeedSeries = hourly[`wind_speed_${pressureLevel}hPa`];
      const windDirectionSeries = hourly[`wind_direction_${pressureLevel}hPa`];

      temperature = Array.isArray(temperatureSeries) ? this.parseNumeric(temperatureSeries[0]) ?? 0 : 0;
      humidity = Array.isArray(humiditySeries) ? this.parseNumeric(humiditySeries[0]) ?? 0 : 0;
      windSpeed = Array.isArray(windSpeedSeries) ? this.parseNumeric(windSpeedSeries[0]) ?? 0 : 0;
      windDirection = Array.isArray(windDirectionSeries) ? this.parseNumeric(windDirectionSeries[0]) ?? 0 : 0;
    }

    const payload: RouteSamplePayload = {
      latitude,
      longitude,
      altitude: normalizedAltitude,
      elevation: this.parseNumeric(data.elevation) ?? 0,
      temperature,
      humidity,
      windSpeed,
      windDirection,
      precipitation: this.parseNumeric(current.precipitation),
      cloudCover: this.parseNumeric(current.cloud_cover),
    };

    this.routeSampleCache.set(cacheKey, {
      updatedAt: new Date().toISOString(),
      data: payload,
    });

    return payload;
  }

  // -----------------------------------------------------------------------
  // AIRGRAM – server-side PNG generation via Python/matplotlib
  // -----------------------------------------------------------------------

  async getAirgram(stationCode: string): Promise<Buffer> {
    const station = this.ensureStation(stationCode);
    const AIRGRAM_TTL_MS = 60 * 60 * 1000; // 1 hour

    const cached = this.airgramCache.get(station.code);
    if (cached && this.isFresh(cached.updatedAt, AIRGRAM_TTL_MS)) {
      return cached.data;
    }

    const inputData = await this.fetchAirgramInputData(station);
    const png = await this.runAirgramGenerator(inputData);

    this.airgramCache.set(station.code, {
      updatedAt: new Date().toISOString(),
      data: png,
    });

    return png;
  }

  private async fetchAirgramInputData(station: MeteoStation): Promise<object> {
    const surfaceFields = [
      'temperature_2m',
      'dew_point_2m',
      'wind_speed_10m',
      'wind_direction_10m',
      'surface_pressure',
      'precipitation',
      'cloud_cover',
    ].join(',');

    const aloftFields = [
      'temperature_925hPa', 'temperature_850hPa', 'temperature_700hPa',
      'temperature_500hPa', 'temperature_400hPa', 'temperature_300hPa',
      'wind_speed_925hPa',  'wind_speed_850hPa',  'wind_speed_700hPa',
      'wind_speed_500hPa',  'wind_speed_400hPa',  'wind_speed_300hPa',
      'wind_direction_925hPa', 'wind_direction_850hPa', 'wind_direction_700hPa',
      'wind_direction_500hPa', 'wind_direction_400hPa', 'wind_direction_300hPa',
    ].join(',');

    const cachedForecast = await this.getCachedForecastByStation(station.code);
    const cachedHourly = (cachedForecast?.hourly ?? null) as Record<string, unknown> | null;
    if (cachedHourly && this.hasRequiredAirgramHourlyFields(cachedHourly)) {
      return this.buildAirgramInputFromHourly(station, cachedHourly);
    }

    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${station.lat}` +
      `&longitude=${station.lon}` +
      `&hourly=${surfaceFields},${aloftFields}` +
      '&forecast_hours=72' +
      '&wind_speed_unit=kn' +
      '&timezone=Europe%2FIstanbul';

    try {
      const response = await axios.get<Record<string, unknown>>(url, { timeout: 30000 });
      const h = (response.data?.hourly ?? {}) as Record<string, unknown>;
      return this.buildAirgramInputFromHourly(station, h);
    } catch (error) {
      throw this.toOpenMeteoHttpError(error, 'Airgram verisi alinamadi');
    }
  }

  private hasRequiredAirgramHourlyFields(hourly: Record<string, unknown>): boolean {
    const requiredFields = [
      'time',
      'temperature_2m',
      'dew_point_2m',
      'wind_speed_10m',
      'wind_direction_10m',
      'surface_pressure',
      'precipitation',
      'cloud_cover',
      'temperature_925hPa',
      'temperature_850hPa',
      'temperature_700hPa',
      'temperature_500hPa',
      'temperature_400hPa',
      'temperature_300hPa',
      'wind_speed_925hPa',
      'wind_speed_850hPa',
      'wind_speed_700hPa',
      'wind_speed_500hPa',
      'wind_speed_400hPa',
      'wind_speed_300hPa',
      'wind_direction_925hPa',
      'wind_direction_850hPa',
      'wind_direction_700hPa',
      'wind_direction_500hPa',
      'wind_direction_400hPa',
      'wind_direction_300hPa',
    ];

    return requiredFields.every((field) => Array.isArray(hourly[field]));
  }

  private buildAirgramInputFromHourly(station: MeteoStation, h: Record<string, unknown>): object {
    return {
      station: station.code,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      surface: {
        time: h.time ?? [],
        temperature_2m: h.temperature_2m ?? [],
        dew_point_2m: h.dew_point_2m ?? [],
        wind_speed_10m: h.wind_speed_10m ?? [],
        wind_direction_10m: h.wind_direction_10m ?? [],
        surface_pressure: h.surface_pressure ?? [],
        precipitation: h.precipitation ?? [],
        cloud_cover: h.cloud_cover ?? [],
      },
      aloft: {
        temperature_925hPa: h.temperature_925hPa ?? [],
        temperature_850hPa: h.temperature_850hPa ?? [],
        temperature_700hPa: h.temperature_700hPa ?? [],
        temperature_500hPa: h.temperature_500hPa ?? [],
        temperature_400hPa: h.temperature_400hPa ?? [],
        temperature_300hPa: h.temperature_300hPa ?? [],
        wind_speed_925hPa: h.wind_speed_925hPa ?? [],
        wind_speed_850hPa: h.wind_speed_850hPa ?? [],
        wind_speed_700hPa: h.wind_speed_700hPa ?? [],
        wind_speed_500hPa: h.wind_speed_500hPa ?? [],
        wind_speed_400hPa: h.wind_speed_400hPa ?? [],
        wind_speed_300hPa: h.wind_speed_300hPa ?? [],
        wind_direction_925hPa: h.wind_direction_925hPa ?? [],
        wind_direction_850hPa: h.wind_direction_850hPa ?? [],
        wind_direction_700hPa: h.wind_direction_700hPa ?? [],
        wind_direction_500hPa: h.wind_direction_500hPa ?? [],
        wind_direction_400hPa: h.wind_direction_400hPa ?? [],
        wind_direction_300hPa: h.wind_direction_300hPa ?? [],
      },
    };
  }

  private runAirgramGenerator(inputData: object): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const scriptPath = this.resolveAirgramScriptPath();
      const pythonBins = this.getAirgramPythonCandidates();

      const spawnWithCandidate = (index: number): void => {
        if (index >= pythonBins.length) {
          reject(
            new HttpError(
              503,
              'Airgram: python calistirilamadi. Python3 ve matplotlib kurulu olmali (ornek: sudo apt-get install -y python3 python3-matplotlib python3-numpy).',
            ),
          );
          return;
        }

        const pythonBin = pythonBins[index];
        const py = spawn(pythonBin, [scriptPath], {
          timeout: 90_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        py.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        py.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

        py.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            spawnWithCandidate(index + 1);
            return;
          }
          reject(new HttpError(503, `Airgram: ${pythonBin} calistirilamadi: ${err.message}`));
        });

        py.on('close', (code: number | null) => {
          const stderr = Buffer.concat(errChunks).toString('utf8').trim();
          if (stderr) console.warn(`[airgram_gen.py][${pythonBin}]`, stderr);

          if ((code !== 0 && code !== null) || chunks.length === 0) {
            if (/No module named .*matplotlib/i.test(stderr)) {
              reject(
                new HttpError(
                  503,
                  'Airgram: matplotlib kurulu degil. Kurulum: sudo apt-get install -y python3-matplotlib python3-numpy',
                ),
              );
              return;
            }
            reject(
              new HttpError(
                503,
                `Airgram: ${pythonBin} hata kodu ${code}. ${stderr.slice(0, 220)}`,
              ),
            );
            return;
          }

          resolve(Buffer.concat(chunks));
        });

        try {
          py.stdin.write(JSON.stringify(inputData), 'utf8');
          py.stdin.end();
        } catch (writeErr) {
          reject(writeErr);
        }
      };

      spawnWithCandidate(0);
    });
  }

  private resolveAirgramScriptPath(): string {
    const candidates = [
      path.join(__dirname, '..', 'airgram_gen.py'),
      path.join(__dirname, '..', '..', 'src', 'airgram_gen.py'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    throw new HttpError(
      503,
      `Airgram: airgram_gen.py bulunamadi. Beklenen yollar: ${candidates.join(', ')}`,
    );
  }

  private getAirgramPythonCandidates(): string[] {
    const envBin = process.env.AIRGRAM_PYTHON_BIN?.trim();
    const values = [envBin, 'python3', 'python'];
    return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.length > 0))));
  }

  private toOpenMeteoHttpError(error: unknown, fallbackMessage: string): HttpError {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data as { reason?: string } | undefined;
      const reason = typeof data?.reason === 'string' ? data.reason : undefined;

      if (status === 429) {
        return new HttpError(
          429,
          reason ??
            'Open-Meteo kota limiti asildi. Gunluk limit sifirlandiginda tekrar deneyin veya API anahtariyla customer endpoint kullanin.',
        );
      }

      if (reason && reason.trim().length > 0) {
        return new HttpError(503, `${fallbackMessage}: ${reason}`);
      }
    }

    return new HttpError(503, fallbackMessage);
  }

  async getMapSnapshot(forceRefresh = false, atIso?: string): Promise<MeteoMapSnapshotPayload> {
    if (atIso && atIso.trim().length > 0) {
      return this.buildTemporalMapSnapshot(atIso);
    }

    if (!forceRefresh && this.mapSnapshotCache && this.isFresh(this.mapSnapshotCache.generatedAt, config.openMeteoRefreshMs)) {
      return this.mapSnapshotCache;
    }

    return this.refreshMapSnapshot();
  }

  async refreshMapSnapshot(): Promise<MeteoMapSnapshotPayload> {
    const points: MeteoMapPoint[] = [];

    for (const station of STATIONS) {
      let current = this.currentCache.get(station.code);
      if (!current || !this.isFresh(current.updatedAt, config.openMeteoRefreshMs)) {
        try {
          current = await this.refreshStation(station.code);
        } catch {
          current = this.currentCache.get(station.code);
        }
      }

      if (!current) continue;

      const values: Record<string, number | null> = {};
      for (const layer of METEO_MAP_LAYERS) {
        if (layer.id === FLIGHT_RISK_LAYER_ID) {
          values[layer.field] = this.computeFlightRiskScoreFromInputs({
            windSpeedKmh: this.parseNumeric(current.current.wind_speed_10m),
            windGustKmh: this.parseNumeric(current.current.wind_gusts_10m),
            visibilityMeters: this.parseNumeric(current.current.visibility),
            cape: this.parseNumeric(current.current.cape),
            liftedIndex: this.parseNumeric(current.current.lifted_index),
            precipitationMmPerHour: this.parseNumeric(current.current.precipitation),
            cloudBaseMeters: this.parseNumeric(current.current.cloud_base),
          });
        } else if (layer.id === FLIGHT_SUITABILITY_LAYER_ID) {
          values[layer.field] = this.scoreFlightSuitability(
            this.computeFlightRiskScoreFromInputs({
              windSpeedKmh: this.parseNumeric(current.current.wind_speed_10m),
              windGustKmh: this.parseNumeric(current.current.wind_gusts_10m),
              visibilityMeters: this.parseNumeric(current.current.visibility),
              cape: this.parseNumeric(current.current.cape),
              liftedIndex: this.parseNumeric(current.current.lifted_index),
              precipitationMmPerHour: this.parseNumeric(current.current.precipitation),
              cloudBaseMeters: this.parseNumeric(current.current.cloud_base),
            }),
            this.computeLowCloudCoverFromInputs({
              cloud_cover: this.parseNumeric(current.current.cloud_cover),
              cloud_base: this.parseNumeric(current.current.cloud_base),
            }),
          );
        } else if (layer.id === LOW_CLOUD_LAYER_ID) {
          values[layer.field] = this.computeLowCloudCoverFromInputs({
            cloud_cover: this.parseNumeric(current.current.cloud_cover),
            cloud_base: this.parseNumeric(current.current.cloud_base),
          });
        } else {
          values[layer.field] = this.parseNumeric(current.current[layer.field]);
        }
      }

      points.push({
        station,
        updatedAt: current.updatedAt,
        latitude: station.lat,
        longitude: station.lon,
        values,
      });
    }

    this.mapSnapshotCache = {
      generatedAt: new Date().toISOString(),
      layers: METEO_MAP_LAYERS,
      points,
    };

    return this.mapSnapshotCache;
  }

  private buildRange(start: number, end: number, step: number): number[] {
    const values: number[] = [];
    for (let value = start; value <= end + 1e-9; value += step) {
      values.push(Number(value.toFixed(4)));
    }
    return values;
  }

  private toHourIso(value: string | Date): string {
    const date = typeof value === 'string' ? new Date(value) : new Date(value.getTime());
    date.setUTCMinutes(0, 0, 0);
    return date.toISOString();
  }

  async refreshRasterGrid(hour?: string): Promise<MeteoRasterGridPayload> {
    const targetHourIso = this.toHourIso(hour ?? new Date());
    const existing = this.rasterGridByHour.get(targetHourIso);
    if (existing) {
      this.latestRasterHour = targetHourIso;
      return existing;
    }

    const inFlight = this.rasterGridInFlight.get(targetHourIso);
    if (inFlight) return inFlight;

    const refreshPromise = (async (): Promise<MeteoRasterGridPayload> => {
      const latitudes = this.buildRange(RASTER_BBOX.south, RASTER_BBOX.north, RASTER_GRID_STEP_DEG);
      const longitudes = this.buildRange(RASTER_BBOX.west, RASTER_BBOX.east, RASTER_GRID_STEP_DEG);

      const latList: number[] = [];
      const lonList: number[] = [];
      for (const lat of latitudes) {
        for (const lon of longitudes) {
          latList.push(lat);
          lonList.push(lon);
        }
      }

      const requestFields = this.rasterRequestFields();
      const params = new URLSearchParams({
        latitude: latList.join(','),
        longitude: lonList.join(','),
        hourly: requestFields.join(','),
        timezone: 'UTC',
      });

      if (hour) {
        // Open-Meteo start_hour/end_hour expects 'YYYY-MM-DDTHH:mm' (no seconds/millis/Z);
        // a full ISO string is rejected with "Invalid date format".
        const hourParam = targetHourIso.slice(0, 16);
        params.set('start_hour', hourParam);
        params.set('end_hour', hourParam);
      } else {
        params.set('forecast_hours', '1');
      }

      const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
      const response = await axios.get(url, { timeout: 30000 });
      const payloads = Array.isArray(response.data) ? response.data : [response.data];

      const points: MeteoRasterGridPoint[] = payloads.map((entry) => {
        const hourly = (entry?.hourly ?? {}) as Record<string, unknown>;
        const values: Record<string, number | null> = {};
        for (const field of requestFields) {
          const series = hourly[field];
          values[field] = Array.isArray(series) && series.length > 0 ? this.parseNumeric(series[0]) : null;
        }
        return {
          latitude: this.parseNumeric(entry?.latitude) ?? 0,
          longitude: this.parseNumeric(entry?.longitude) ?? 0,
          values,
        };
      });

      const payload: MeteoRasterGridPayload = {
        generatedAt: new Date().toISOString(),
        hourIso: targetHourIso,
        bbox: RASTER_BBOX,
        stepDegrees: RASTER_GRID_STEP_DEG,
        latitudes,
        longitudes,
        points,
      };

      this.rasterGridByHour.set(targetHourIso, payload);
      const cachePrefix = `${targetHourIso}:`;
      for (const key of Array.from(this.enhancedFieldCache.keys())) {
        if (key.startsWith(cachePrefix)) {
          this.enhancedFieldCache.delete(key);
        }
      }
      this.latestRasterHour = targetHourIso;
      return payload;
    })();

    this.rasterGridInFlight.set(targetHourIso, refreshPromise);
    try {
      return await refreshPromise;
    } catch (error) {
      if (this.latestRasterHour) {
        const fallback = this.rasterGridByHour.get(this.latestRasterHour);
        if (fallback) return fallback;
      }
      throw new HttpError(503, 'Open-Meteo raster grid verisi alinamadi');
    } finally {
      this.rasterGridInFlight.delete(targetHourIso);
    }
  }

  async getRasterGridLatest(): Promise<MeteoRasterGridPayload> {
    if (this.latestRasterHour) {
      const existing = this.rasterGridByHour.get(this.latestRasterHour);
      if (existing) return existing;
    }
    return this.refreshRasterGrid();
  }

  private toDateOrThrow(atIso?: string): Date {
    if (!atIso || atIso.trim().length === 0) return new Date();
    const date = new Date(atIso);
    if (Number.isNaN(date.getTime())) {
      throw new HttpError(400, 'at gecersiz tarih formatinda');
    }
    return date;
  }

  private async resolveTemporalContext(atIso?: string): Promise<{
    gridA: MeteoRasterGridPayload;
    gridB: MeteoRasterGridPayload | null;
    blend: number;
    hourIso: string;
  }> {
    if (!atIso || atIso.trim().length === 0) {
      const grid = await this.getRasterGridLatest();
      return { gridA: grid, gridB: null, blend: 0, hourIso: grid.hourIso };
    }

    const target = this.toDateOrThrow(atIso);
    const hourStart = new Date(target.getTime());
    hourStart.setUTCMinutes(0, 0, 0);
    const nextHour = new Date(hourStart.getTime() + 60 * 60 * 1000);
    const blend = Math.max(0, Math.min(1, (target.getUTCMinutes() * 60 + target.getUTCSeconds()) / 3600));

    const gridA = await this.refreshRasterGrid(hourStart.toISOString());
    if (blend <= 0.001) {
      return { gridA, gridB: null, blend: 0, hourIso: gridA.hourIso };
    }

    const gridB = await this.refreshRasterGrid(nextHour.toISOString());
    return { gridA, gridB, blend, hourIso: gridA.hourIso };
  }

  private gridValue(grid: MeteoRasterGridPayload, field: string, latIdx: number, lonIdx: number): number | null {
    const lonCount = grid.longitudes.length;
    const pointIdx = latIdx * lonCount + lonIdx;
    return this.parseNumeric(grid.points[pointIdx]?.values[field]);
  }

  private bilinearSample(grid: MeteoRasterGridPayload, field: string, latitude: number, longitude: number): number | null {
    const lonCount = grid.longitudes.length;
    const latCount = grid.latitudes.length;
    if (!lonCount || !latCount) return null;

    const fx = (longitude - RASTER_BBOX.west) / grid.stepDegrees;
    const fy = (latitude - RASTER_BBOX.south) / grid.stepDegrees;

    const x0 = Math.max(0, Math.min(lonCount - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(latCount - 1, Math.floor(fy)));
    const x1 = Math.max(0, Math.min(lonCount - 1, x0 + 1));
    const y1 = Math.max(0, Math.min(latCount - 1, y0 + 1));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));

    const v00 = this.gridValue(grid, field, y0, x0);
    const v10 = this.gridValue(grid, field, y0, x1);
    const v01 = this.gridValue(grid, field, y1, x0);
    const v11 = this.gridValue(grid, field, y1, x1);

    const weighted: Array<{ value: number; weight: number }> = [];
    if (v00 != null) weighted.push({ value: v00, weight: (1 - tx) * (1 - ty) });
    if (v10 != null) weighted.push({ value: v10, weight: tx * (1 - ty) });
    if (v01 != null) weighted.push({ value: v01, weight: (1 - tx) * ty });
    if (v11 != null) weighted.push({ value: v11, weight: tx * ty });

    if (weighted.length === 0) return null;
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) return weighted[0].value;
    return weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  }

  private blendValues(a: number | null, b: number | null, t: number): number | null {
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    return a * (1 - t) + b * t;
  }

  private sampleTemporalValue(
    field: string,
    latitude: number,
    longitude: number,
    context: { gridA: MeteoRasterGridPayload; gridB: MeteoRasterGridPayload | null; blend: number },
  ): number | null {
    const a = this.bilinearSample(context.gridA, field, latitude, longitude);
    if (!context.gridB || context.blend <= 0.001) return a;
    const b = this.bilinearSample(context.gridB, field, latitude, longitude);
    return this.blendValues(a, b, context.blend);
  }

  private buildTemporalMapSnapshot = async (atIso: string): Promise<MeteoMapSnapshotPayload> => {
    const temporalContext = await this.resolveTemporalContext(atIso);
    const points: MeteoMapPoint[] = STATIONS.map((station) => {
      const values: Record<string, number | null> = {};
      for (const layer of METEO_MAP_LAYERS) {
        if (layer.id === FLIGHT_RISK_LAYER_ID) {
          values[layer.field] = this.computeFlightRiskScoreFromInputs({
            windSpeedKmh: this.sampleTemporalValue('wind_speed_10m', station.lat, station.lon, temporalContext),
            windGustKmh: this.sampleTemporalValue('wind_gusts_10m', station.lat, station.lon, temporalContext),
            visibilityMeters: this.sampleTemporalValue('visibility', station.lat, station.lon, temporalContext),
            cape: this.sampleTemporalValue('cape', station.lat, station.lon, temporalContext),
            liftedIndex: this.sampleTemporalValue('lifted_index', station.lat, station.lon, temporalContext),
            precipitationMmPerHour: this.sampleTemporalValue('precipitation', station.lat, station.lon, temporalContext),
            cloudBaseMeters: this.sampleTemporalValue('cloud_base', station.lat, station.lon, temporalContext),
          });
        } else if (layer.id === FLIGHT_SUITABILITY_LAYER_ID) {
          values[layer.field] = this.scoreFlightSuitability(
            this.computeFlightRiskScoreFromInputs({
              windSpeedKmh: this.sampleTemporalValue('wind_speed_10m', station.lat, station.lon, temporalContext),
              windGustKmh: this.sampleTemporalValue('wind_gusts_10m', station.lat, station.lon, temporalContext),
              visibilityMeters: this.sampleTemporalValue('visibility', station.lat, station.lon, temporalContext),
              cape: this.sampleTemporalValue('cape', station.lat, station.lon, temporalContext),
              liftedIndex: this.sampleTemporalValue('lifted_index', station.lat, station.lon, temporalContext),
              precipitationMmPerHour: this.sampleTemporalValue('precipitation', station.lat, station.lon, temporalContext),
              cloudBaseMeters: this.sampleTemporalValue('cloud_base', station.lat, station.lon, temporalContext),
            }),
            this.computeLowCloudCoverFromInputs({
              cloud_cover: this.sampleTemporalValue('cloud_cover', station.lat, station.lon, temporalContext),
              cloud_base: this.sampleTemporalValue('cloud_base', station.lat, station.lon, temporalContext),
            }),
          );
        } else if (layer.id === LOW_CLOUD_LAYER_ID) {
          values[layer.field] = this.computeLowCloudCoverFromInputs({
            cloud_cover: this.sampleTemporalValue('cloud_cover', station.lat, station.lon, temporalContext),
            cloud_base: this.sampleTemporalValue('cloud_base', station.lat, station.lon, temporalContext),
          });
        } else {
          values[layer.field] = this.sampleTemporalValue(layer.field, station.lat, station.lon, temporalContext);
        }
      }

      return {
        station,
        updatedAt: temporalContext.hourIso,
        latitude: station.lat,
        longitude: station.lon,
        values,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      layers: METEO_MAP_LAYERS,
      points,
    };
  };

  private lonToTileX(lon: number, z: number): number {
    return ((lon + 180) / 360) * Math.pow(2, z);
  }

  private latToTileY(lat: number, z: number): number {
    const rad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
  }

  private tileLon(x: number, z: number): number {
    return (x / Math.pow(2, z)) * 360 - 180;
  }

  private tileLat(y: number, z: number): number {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  private gaussianKernel1d(sigma = 1.1, radius = 2): number[] {
    const size = radius * 2 + 1;
    const kernel = new Array<number>(size);
    const sigma2 = sigma * sigma;
    let sum = 0;

    for (let i = -radius; i <= radius; i += 1) {
      const value = Math.exp(-(i * i) / (2 * sigma2));
      kernel[i + radius] = value;
      sum += value;
    }

    if (sum <= 0) return kernel.map(() => 1 / size);
    return kernel.map((v) => v / sum);
  }

  private gaussianBlurMasked(values: Float32Array, width: number, height: number, sigma = 1.1, radius = 2): Float32Array {
    const kernel = this.gaussianKernel1d(sigma, radius);
    const temp = new Float32Array(values.length);
    const output = new Float32Array(values.length);
    temp.fill(Number.NaN);
    output.fill(Number.NaN);

    // Horizontal pass
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let weightedSum = 0;
        let totalWeight = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const nx = x + k;
          if (nx < 0 || nx >= width) continue;
          const idx = y * width + nx;
          const value = values[idx];
          if (!Number.isFinite(value)) continue;
          const weight = kernel[k + radius];
          weightedSum += value * weight;
          totalWeight += weight;
        }
        if (totalWeight > 0) {
          temp[y * width + x] = weightedSum / totalWeight;
        }
      }
    }

    // Vertical pass
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let weightedSum = 0;
        let totalWeight = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const ny = y + k;
          if (ny < 0 || ny >= height) continue;
          const idx = ny * width + x;
          const value = temp[idx];
          if (!Number.isFinite(value)) continue;
          const weight = kernel[k + radius];
          weightedSum += value * weight;
          totalWeight += weight;
        }
        if (totalWeight > 0) {
          output[y * width + x] = weightedSum / totalWeight;
        }
      }
    }

    return output;
  }

  private percentileFromSorted(sorted: number[], q: number): number {
    if (sorted.length === 0) return Number.NaN;
    const qq = this.clamp01(q);
    const idx = qq * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(sorted.length - 1, lo + 1);
    const t = idx - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
  }

  private buildClaheLutForTile(
    values01: Float32Array,
    width: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    bins = 256,
    clipLimit = 2.0,
  ): Float32Array {
    const hist = new Uint32Array(bins);
    let count = 0;

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const value = values01[y * width + x];
        if (!Number.isFinite(value)) continue;
        const bin = Math.max(0, Math.min(bins - 1, Math.round(this.clamp01(value) * (bins - 1))));
        hist[bin] += 1;
        count += 1;
      }
    }

    const lut = new Float32Array(bins);
    if (count === 0) return lut;

    const tileArea = Math.max(1, (x1 - x0) * (y1 - y0));
    const baseLimit = Math.max(1, Math.round((clipLimit * count) / bins));
    const hardLimit = Math.max(1, Math.round((clipLimit * tileArea) / bins));
    const limit = Math.max(baseLimit, hardLimit);

    let clipped = 0;
    for (let i = 0; i < bins; i += 1) {
      if (hist[i] > limit) {
        clipped += hist[i] - limit;
        hist[i] = limit;
      }
    }

    if (clipped > 0) {
      const step = Math.floor(clipped / bins);
      const rem = clipped % bins;
      for (let i = 0; i < bins; i += 1) {
        hist[i] += step + (i < rem ? 1 : 0);
      }
    }

    const total = hist.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return lut;

    let cumulative = 0;
    let cdfMin = -1;
    for (let i = 0; i < bins; i += 1) {
      cumulative += hist[i];
      const cdf = cumulative / total;
      lut[i] = cdf;
      if (cdfMin < 0 && hist[i] > 0) {
        cdfMin = cdf;
      }
    }

    if (cdfMin > 0 && cdfMin < 1) {
      for (let i = 0; i < bins; i += 1) {
        lut[i] = this.clamp01((lut[i] - cdfMin) / (1 - cdfMin));
      }
    }

    return lut;
  }

  private adaptiveHistogramEqualization(
    values01: Float32Array,
    width: number,
    height: number,
    tileCountX = 8,
    tileCountY = 8,
    bins = 256,
    clipLimit = 2.0,
  ): Float32Array {
    const out = new Float32Array(values01.length);
    out.fill(Number.NaN);

    const tilesX = Math.max(2, tileCountX);
    const tilesY = Math.max(2, tileCountY);
    const tileWidth = Math.ceil(width / tilesX);
    const tileHeight = Math.ceil(height / tilesY);

    const luts: Float32Array[][] = Array.from({ length: tilesY }, () =>
      Array.from({ length: tilesX }, () => new Float32Array(bins)),
    );

    for (let ty = 0; ty < tilesY; ty += 1) {
      const y0 = ty * tileHeight;
      const y1 = Math.min(height, y0 + tileHeight);
      for (let tx = 0; tx < tilesX; tx += 1) {
        const x0 = tx * tileWidth;
        const x1 = Math.min(width, x0 + tileWidth);
        luts[ty][tx] = this.buildClaheLutForTile(values01, width, x0, y0, x1, y1, bins, clipLimit);
      }
    }

    for (let y = 0; y < height; y += 1) {
      const fy = y / tileHeight;
      const ty0 = Math.max(0, Math.min(tilesY - 1, Math.floor(fy)));
      const ty1 = Math.max(0, Math.min(tilesY - 1, ty0 + 1));
      const wy = this.clamp01(fy - ty0);

      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;
        const value = values01[idx];
        if (!Number.isFinite(value)) continue;

        const fx = x / tileWidth;
        const tx0 = Math.max(0, Math.min(tilesX - 1, Math.floor(fx)));
        const tx1 = Math.max(0, Math.min(tilesX - 1, tx0 + 1));
        const wx = this.clamp01(fx - tx0);

        const bin = Math.max(0, Math.min(bins - 1, Math.round(this.clamp01(value) * (bins - 1))));

        const v00 = luts[ty0][tx0][bin];
        const v10 = luts[ty0][tx1][bin];
        const v01 = luts[ty1][tx0][bin];
        const v11 = luts[ty1][tx1][bin];

        const top = v00 * (1 - wx) + v10 * wx;
        const bottom = v01 * (1 - wx) + v11 * wx;
        out[idx] = this.clamp01(top * (1 - wy) + bottom * wy);
      }
    }

    return out;
  }

  private sigmoidEnhancement(value01: number, strength = 8): number {
    const x = this.clamp01(value01);
    const s = 1 / (1 + Math.exp(-strength * (x - 0.5)));
    const s0 = 1 / (1 + Math.exp(strength * 0.5));
    const s1 = 1 / (1 + Math.exp(-strength * 0.5));
    return this.clamp01((s - s0) / (s1 - s0));
  }

  private computeTurboColor(value01: number): [number, number, number] {
    const x = this.clamp01(value01);
    const x2 = x * x;
    const x3 = x2 * x;
    const x4 = x3 * x;
    const x5 = x4 * x;

    const r = 0.13572138 + 4.61539260 * x - 42.66032258 * x2 + 132.13108234 * x3 - 152.94239396 * x4 + 59.28637943 * x5;
    const g = 0.09140261 + 2.19418839 * x - 4.84296658 * x2 + 14.18503333 * x3 - 14.18503333 * x4 + 4.27729857 * x5;
    const b = 0.10667330 + 12.64194608 * x - 60.58204836 * x2 + 110.36276771 * x3 - 89.90310912 * x4 + 27.34824973 * x5;

    return [
      Math.round(this.clamp01(r) * 255),
      Math.round(this.clamp01(g) * 255),
      Math.round(this.clamp01(b) * 255),
    ];
  }

  // Turbo renk paleti sabit bir gradyan olduğundan, polinomu piksel başına
  // yeniden hesaplamak yerine bir kez 256 girişlik tabloya çözüp indeksliyoruz.
  private turboColor(value01: number): [number, number, number] {
    if (!this.turboColorLut) {
      const size = 256;
      const lut = new Array<[number, number, number]>(size);
      for (let i = 0; i < size; i += 1) {
        lut[i] = this.computeTurboColor(i / (size - 1));
      }
      this.turboColorLut = lut;
    }
    const idx = Math.round(this.clamp01(value01) * (this.turboColorLut.length - 1));
    return this.turboColorLut[idx];
  }

  private layerEnhancementParams(layerId: string): {
    gaussianSigma: number;
    gaussianRadius: number;
    percentileLow: number;
    percentileHigh: number;
    claheTilesX: number;
    claheTilesY: number;
    claheClipLimit: number;
    sigmoidStrength: number;
    alpha: number;
  } {
    switch (layerId) {
      case 'om_cloud_cover':
        return {
          gaussianSigma: 1.0,
          gaussianRadius: 2,
          percentileLow: 0.01,
          percentileHigh: 0.99,
          claheTilesX: 8,
          claheTilesY: 8,
          claheClipLimit: 1.8,
          sigmoidStrength: 7.0,
          alpha: 165,
        };
      case 'om_wind_speed':
      case 'om_wind_gust':
        return {
          gaussianSigma: 1.1,
          gaussianRadius: 2,
          percentileLow: 0.03,
          percentileHigh: 0.97,
          claheTilesX: 8,
          claheTilesY: 8,
          claheClipLimit: 2.2,
          sigmoidStrength: 8.0,
          alpha: 165,
        };
      case 'om_precipitation':
        return {
          gaussianSigma: 0.8,
          gaussianRadius: 2,
          percentileLow: 0.005,
          percentileHigh: 0.995,
          claheTilesX: 10,
          claheTilesY: 10,
          claheClipLimit: 2.8,
          sigmoidStrength: 10.0,
          alpha: 170,
        };
      case 'om_temperature':
        return {
          gaussianSigma: 1.2,
          gaussianRadius: 2,
          percentileLow: 0.02,
          percentileHigh: 0.98,
          claheTilesX: 8,
          claheTilesY: 8,
          claheClipLimit: 1.6,
          sigmoidStrength: 6.0,
          alpha: 165,
        };
      case 'om_depression':
        return {
          gaussianSigma: 1.3,
          gaussianRadius: 2,
          percentileLow: 0.03,
          percentileHigh: 0.97,
          claheTilesX: 8,
          claheTilesY: 8,
          claheClipLimit: 1.7,
          sigmoidStrength: 7.0,
          alpha: 165,
        };
      case 'om_turbulence':
        return {
          gaussianSigma: 0.9,
          gaussianRadius: 2,
          percentileLow: 0.01,
          percentileHigh: 0.99,
          claheTilesX: 10,
          claheTilesY: 10,
          claheClipLimit: 2.6,
          sigmoidStrength: 9.0,
          alpha: 170,
        };
      case FLIGHT_RISK_LAYER_ID:
        return {
          gaussianSigma: 1.0,
          gaussianRadius: 2,
          percentileLow: 0,
          percentileHigh: 1,
          claheTilesX: 8,
          claheTilesY: 8,
          claheClipLimit: 1.0,
          sigmoidStrength: 1.0,
          alpha: 175,
        };
      case FLIGHT_SUITABILITY_LAYER_ID:
        return {
          gaussianSigma: 1.0,
          gaussianRadius: 2,
          percentileLow: 0,
          percentileHigh: 1,
          claheTilesX: 8,
          claheTilesY: 8,
          claheClipLimit: 1.0,
          sigmoidStrength: 1.0,
          alpha: 175,
        };
      case LOW_CLOUD_LAYER_ID:
        return {
          gaussianSigma: 1.0,
          gaussianRadius: 2,
          percentileLow: 0,
          percentileHigh: 1,
          claheTilesX: 8,
          claheTilesY: 8,
          claheClipLimit: 1.0,
          sigmoidStrength: 1.0,
          alpha: 170,
        };
      default:
        return {
          gaussianSigma: 1.1,
          gaussianRadius: 2,
          percentileLow: 0.02,
          percentileHigh: 0.98,
          claheTilesX: 8,
          claheTilesY: 8,
          claheClipLimit: 2.0,
          sigmoidStrength: 8.0,
          alpha: 165,
        };
    }
  }

  private fieldMatrixFromGrid(grid: MeteoRasterGridPayload, field: string): EnhancedRasterField {
    const width = grid.longitudes.length;
    const height = grid.latitudes.length;
    const values01 = new Float32Array(width * height);
    values01.fill(Number.NaN);

    for (let latIdx = 0; latIdx < height; latIdx += 1) {
      for (let lonIdx = 0; lonIdx < width; lonIdx += 1) {
        const idx = latIdx * width + lonIdx;
        const point = grid.points[idx];
        const value = field === FLIGHT_RISK_FIELD
          ? this.computeFlightRiskAtPointValues(point?.values ?? {})
          : this.parseNumeric(point?.values[field]);
        if (value != null && Number.isFinite(value)) {
          values01[idx] = value;
        }
      }
    }

    return { width, height, values01 };
  }

  private enhanceFieldValues(
    source: EnhancedRasterField,
    layerId: string,
  ): EnhancedRasterField {
    const enhancement = this.layerEnhancementParams(layerId);
    const { width, height } = source;

    const blurred = this.gaussianBlurMasked(
      source.values01,
      width,
      height,
      enhancement.gaussianSigma,
      enhancement.gaussianRadius,
    );

    const finiteValues: number[] = [];
    for (let i = 0; i < blurred.length; i += 1) {
      const v = blurred[i];
      if (Number.isFinite(v)) finiteValues.push(v);
    }

    const normalized = new Float32Array(width * height);
    normalized.fill(Number.NaN);
    if (finiteValues.length === 0) {
      return { width, height, values01: normalized };
    }

    finiteValues.sort((a, b) => a - b);
    let p2 = this.percentileFromSorted(finiteValues, enhancement.percentileLow);
    let p98 = this.percentileFromSorted(finiteValues, enhancement.percentileHigh);
    if (!Number.isFinite(p2) || !Number.isFinite(p98) || p98 <= p2) {
      p2 = finiteValues[0];
      p98 = finiteValues[finiteValues.length - 1];
    }

    const span = p98 - p2;
    if (span > 1e-12) {
      for (let i = 0; i < blurred.length; i += 1) {
        const v = blurred[i];
        if (!Number.isFinite(v)) continue;
        normalized[i] = this.clamp01((v - p2) / span);
      }
    } else {
      for (let i = 0; i < blurred.length; i += 1) {
        if (Number.isFinite(blurred[i])) normalized[i] = 0.5;
      }
    }

    const equalized = this.adaptiveHistogramEqualization(
      normalized,
      width,
      height,
      enhancement.claheTilesX,
      enhancement.claheTilesY,
      256,
      enhancement.claheClipLimit,
    );

    const enhanced = new Float32Array(width * height);
    enhanced.fill(Number.NaN);
    for (let i = 0; i < equalized.length; i += 1) {
      const v = equalized[i];
      if (!Number.isFinite(v)) continue;
      enhanced[i] = this.sigmoidEnhancement(v, enhancement.sigmoidStrength);
    }

    return { width, height, values01: enhanced };
  }

  private getEnhancedField(grid: MeteoRasterGridPayload, layerId: string, field: string): EnhancedRasterField {
    const cacheKey = `${grid.hourIso}:${layerId}`;
    const cached = this.enhancedFieldCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const matrix = this.fieldMatrixFromGrid(grid, field);
    const enhanced = this.enhanceFieldValues(matrix, layerId);
    this.enhancedFieldCache.set(cacheKey, enhanced);

    if (this.enhancedFieldCache.size > 64) {
      const oldestKey = this.enhancedFieldCache.keys().next().value;
      if (oldestKey) this.enhancedFieldCache.delete(oldestKey);
    }

    return enhanced;
  }

  private bilinearSampleEnhancedField(
    field: EnhancedRasterField,
    latitude: number,
    longitude: number,
    stepDegrees: number,
  ): number | null {
    const lonCount = field.width;
    const latCount = field.height;
    if (!lonCount || !latCount) return null;

    const fx = (longitude - RASTER_BBOX.west) / stepDegrees;
    const fy = (latitude - RASTER_BBOX.south) / stepDegrees;

    const x0 = Math.max(0, Math.min(lonCount - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(latCount - 1, Math.floor(fy)));
    const x1 = Math.max(0, Math.min(lonCount - 1, x0 + 1));
    const y1 = Math.max(0, Math.min(latCount - 1, y0 + 1));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));

    const idx00 = y0 * lonCount + x0;
    const idx10 = y0 * lonCount + x1;
    const idx01 = y1 * lonCount + x0;
    const idx11 = y1 * lonCount + x1;

    const v00 = field.values01[idx00];
    const v10 = field.values01[idx10];
    const v01 = field.values01[idx01];
    const v11 = field.values01[idx11];

    const weighted: Array<{ value: number; weight: number }> = [];
    if (Number.isFinite(v00)) weighted.push({ value: v00, weight: (1 - tx) * (1 - ty) });
    if (Number.isFinite(v10)) weighted.push({ value: v10, weight: tx * (1 - ty) });
    if (Number.isFinite(v01)) weighted.push({ value: v01, weight: (1 - tx) * ty });
    if (Number.isFinite(v11)) weighted.push({ value: v11, weight: tx * ty });

    if (weighted.length === 0) return null;
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) return weighted[0].value;
    return weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  }

  private sampleEnhancedTemporalValue(
    layerId: string,
    field: string,
    latitude: number,
    longitude: number,
    context: { gridA: MeteoRasterGridPayload; gridB: MeteoRasterGridPayload | null; blend: number },
  ): number | null {
    if (layerId === FLIGHT_RISK_LAYER_ID || layerId === FLIGHT_SUITABILITY_LAYER_ID || layerId === LOW_CLOUD_LAYER_ID) {
      const risk = this.computeFlightRiskScoreFromInputs({
        windSpeedKmh: this.sampleTemporalValue('wind_speed_10m', latitude, longitude, context),
        windGustKmh: this.sampleTemporalValue('wind_gusts_10m', latitude, longitude, context),
        visibilityMeters: this.sampleTemporalValue('visibility', latitude, longitude, context),
        cape: this.sampleTemporalValue('cape', latitude, longitude, context),
        liftedIndex: this.sampleTemporalValue('lifted_index', latitude, longitude, context),
        precipitationMmPerHour: this.sampleTemporalValue('precipitation', latitude, longitude, context),
        cloudBaseMeters: this.sampleTemporalValue('cloud_base', latitude, longitude, context),
      });

      const lowCloud = this.computeLowCloudCoverFromInputs({
        cloud_cover: this.sampleTemporalValue('cloud_cover', latitude, longitude, context),
        cloud_base: this.sampleTemporalValue('cloud_base', latitude, longitude, context),
      });

      if (layerId === FLIGHT_RISK_LAYER_ID) return risk;
      if (layerId === LOW_CLOUD_LAYER_ID) return lowCloud;
      return this.scoreFlightSuitability(risk, lowCloud);
    }

    // Ruzgar/sicaklik/yagis: dinamik percentile+CLAHE zenginlestirmesi yerine
    // sabit fiziksel araliga gore dogrudan orantilanmis renklendirme.
    const fixedScale = this.fixedScaleForLayer(layerId);
    if (fixedScale) {
      const raw = this.sampleTemporalValue(field, latitude, longitude, context);
      if (raw == null || !Number.isFinite(raw)) return null;
      const span = fixedScale.max - fixedScale.min;
      if (span <= 0) return null;
      return this.clamp01((raw - fixedScale.min) / span);
    }

    const enhancedA = this.getEnhancedField(context.gridA, layerId, field);
    const a = this.bilinearSampleEnhancedField(enhancedA, latitude, longitude, context.gridA.stepDegrees);
    if (!context.gridB || context.blend <= 0.001) return a;

    const enhancedB = this.getEnhancedField(context.gridB, layerId, field);
    const b = this.bilinearSampleEnhancedField(enhancedB, latitude, longitude, context.gridB.stepDegrees);
    return this.blendValues(a, b, context.blend);
  }

  private emptyTilePng(): Buffer {
    if (!this.emptyTilePngBuffer) {
      const empty = new PNG({ width: RASTER_TILE_SIZE, height: RASTER_TILE_SIZE });
      this.emptyTilePngBuffer = PNG.sync.write(empty);
    }
    return this.emptyTilePngBuffer;
  }

  private cacheTileBuffer(cacheKey: string, buffer: Buffer): void {
    this.tileCache.set(cacheKey, buffer);
    if (this.tileCache.size > MeteoService.TILE_CACHE_MAX) {
      const oldestKey = this.tileCache.keys().next().value;
      if (oldestKey) this.tileCache.delete(oldestKey);
    }
  }

  async getRasterTile(layerId: string, z: number, x: number, y: number, atIso?: string): Promise<Buffer> {
    const layer = METEO_MAP_LAYERS.find((entry) => entry.id === layerId);
    if (!layer) {
      throw new HttpError(400, `Gecersiz katman: ${layerId}`);
    }

    // Tile, veri bbox'inin tamamen disindaysa zaman dilimini cozmeye/aga
    // gitmeye bile gerek yok - sabit bos tile'i hemen don.
    const westTile = this.tileLon(x, z);
    const eastTile = this.tileLon(x + 1, z);
    const northTile = this.tileLat(y, z);
    const southTile = this.tileLat(y + 1, z);

    if (
      eastTile < RASTER_BBOX.west ||
      westTile > RASTER_BBOX.east ||
      northTile < RASTER_BBOX.south ||
      southTile > RASTER_BBOX.north
    ) {
      return this.emptyTilePng();
    }

    let temporalContext: Awaited<ReturnType<MeteoService['resolveTemporalContext']>>;
    try {
      temporalContext = await this.resolveTemporalContext(atIso);
    } catch {
      return this.emptyTilePng();
    }

    // Ayni katman/saat/tile daha once render edildiyse (pan/zoom tekrari,
    // birden fazla istemci ayni bolgeyi izliyor vb.) piksel piksel yeniden
    // hesaplamak yerine onbellekten don.
    const blendBucket = Math.round(temporalContext.blend * 20);
    const cacheKey = `${layerId}:${z}:${x}:${y}:${temporalContext.hourIso}:${blendBucket}`;
    const cached = this.tileCache.get(cacheKey);
    if (cached) return cached;

    const width = RASTER_TILE_SIZE;
    const height = RASTER_TILE_SIZE;
    const png = new PNG({ width, height });
    const alpha = this.layerEnhancementParams(layerId).alpha;

    // Full selected raster extent is enhanced once (per hour/layer) and
    // tiles only sample from that shared enhanced field.
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const worldX = x + px / width;
        const worldY = y + py / height;
        const lon = this.tileLon(worldX, z);
        const lat = this.tileLat(worldY, z);
        const pngIdx = (py * width + px) * 4;

        if (lon < RASTER_BBOX.west || lon > RASTER_BBOX.east || lat < RASTER_BBOX.south || lat > RASTER_BBOX.north) {
          png.data[pngIdx + 3] = 0;
          continue;
        }

        const enhancedValue = this.sampleEnhancedTemporalValue(layerId, layer.field, lat, lon, temporalContext);
        if (enhancedValue == null || !Number.isFinite(enhancedValue)) {
          png.data[pngIdx + 3] = 0;
          continue;
        }

        const [r, g, b] = layerId === FLIGHT_RISK_LAYER_ID
          ? this.flightRiskColor(enhancedValue)
          : layerId === FLIGHT_SUITABILITY_LAYER_ID
            ? this.flightSuitabilityColor(enhancedValue)
            : layerId === LOW_CLOUD_LAYER_ID
              ? this.lowCloudColor(enhancedValue)
              : this.turboColor(enhancedValue);

        png.data[pngIdx] = r;
        png.data[pngIdx + 1] = g;
        png.data[pngIdx + 2] = b;
        png.data[pngIdx + 3] = alpha;
      }
    }

    const buffer = PNG.sync.write(png);
    this.cacheTileBuffer(cacheKey, buffer);
    return buffer;
  }

  async getRasterValue(layerId: string, latitude: number, longitude: number, atIso?: string): Promise<MeteoRasterValuePayload> {
    const layer = METEO_MAP_LAYERS.find((entry) => entry.id === layerId);
    if (!layer) {
      throw new HttpError(400, `Gecersiz katman: ${layerId}`);
    }

    const temporalContext = await this.resolveTemporalContext(atIso);
    const value = layerId === FLIGHT_RISK_LAYER_ID
      ? this.computeFlightRiskScoreFromInputs({
          windSpeedKmh: this.sampleTemporalValue('wind_speed_10m', latitude, longitude, temporalContext),
          windGustKmh: this.sampleTemporalValue('wind_gusts_10m', latitude, longitude, temporalContext),
          visibilityMeters: this.sampleTemporalValue('visibility', latitude, longitude, temporalContext),
          cape: this.sampleTemporalValue('cape', latitude, longitude, temporalContext),
          liftedIndex: this.sampleTemporalValue('lifted_index', latitude, longitude, temporalContext),
          precipitationMmPerHour: this.sampleTemporalValue('precipitation', latitude, longitude, temporalContext),
          cloudBaseMeters: this.sampleTemporalValue('cloud_base', latitude, longitude, temporalContext),
        })
      : layerId === FLIGHT_SUITABILITY_LAYER_ID
      ? this.scoreFlightSuitability(
          this.computeFlightRiskScoreFromInputs({
            windSpeedKmh: this.sampleTemporalValue('wind_speed_10m', latitude, longitude, temporalContext),
            windGustKmh: this.sampleTemporalValue('wind_gusts_10m', latitude, longitude, temporalContext),
            visibilityMeters: this.sampleTemporalValue('visibility', latitude, longitude, temporalContext),
            cape: this.sampleTemporalValue('cape', latitude, longitude, temporalContext),
            liftedIndex: this.sampleTemporalValue('lifted_index', latitude, longitude, temporalContext),
            precipitationMmPerHour: this.sampleTemporalValue('precipitation', latitude, longitude, temporalContext),
            cloudBaseMeters: this.sampleTemporalValue('cloud_base', latitude, longitude, temporalContext),
          }),
          this.computeLowCloudCoverFromInputs({
            cloud_cover: this.sampleTemporalValue('cloud_cover', latitude, longitude, temporalContext),
            cloud_base: this.sampleTemporalValue('cloud_base', latitude, longitude, temporalContext),
          }),
        )
      : layerId === LOW_CLOUD_LAYER_ID
      ? this.computeLowCloudCoverFromInputs({
          cloud_cover: this.sampleTemporalValue('cloud_cover', latitude, longitude, temporalContext),
          cloud_base: this.sampleTemporalValue('cloud_base', latitude, longitude, temporalContext),
        })
      : this.sampleTemporalValue(layer.field, latitude, longitude, temporalContext);

    return {
      layerId,
      field: layer.field,
      unit: layer.unit,
      hourIso: temporalContext.hourIso,
      query: { latitude, longitude },
      sample: {
        latitude,
        longitude,
        value,
      },
    };
  }

  async getRasterStats(
    layerId: string,
    north: number,
    east: number,
    south: number,
    west: number,
    atIso?: string,
  ): Promise<MeteoRasterStatsPayload> {
    const layer = METEO_MAP_LAYERS.find((entry) => entry.id === layerId);
    if (!layer) {
      throw new HttpError(400, `Gecersiz katman: ${layerId}`);
    }

    const temporalContext = await this.resolveTemporalContext(atIso);
    const grid = temporalContext.gridA;
    const n = Math.max(north, south);
    const s = Math.min(north, south);
    const e = Math.max(east, west);
    const w = Math.min(east, west);

    const fixedScale = this.fixedScaleForLayer(layerId);
    if (fixedScale) {
      return {
        layerId,
        field: layer.field,
        unit: layer.unit,
        hourIso: temporalContext.hourIso,
        bbox: { north: n, east: e, south: s, west: w },
        min: fixedScale.min,
        max: fixedScale.max,
        mean: null,
        sampleCount: grid.points.length,
      };
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let sampleCount = 0;

    for (const point of grid.points) {
      if (point.latitude > n || point.latitude < s || point.longitude > e || point.longitude < w) {
        continue;
      }

      const value = layerId === FLIGHT_RISK_LAYER_ID
        ? this.computeFlightRiskAtPointValues(point.values)
        : layerId === FLIGHT_SUITABILITY_LAYER_ID
        ? this.computeFlightSuitabilityScoreFromPointValues(point.values)
        : layerId === LOW_CLOUD_LAYER_ID
        ? this.computeLowCloudCoverFromInputs(point.values)
        : this.sampleTemporalValue(layer.field, point.latitude, point.longitude, temporalContext);
      if (value == null || !Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
      sampleCount += 1;
    }

    return {
      layerId,
      field: layer.field,
      unit: layer.unit,
      hourIso: temporalContext.hourIso,
      bbox: { north: n, east: e, south: s, west: w },
      min: sampleCount > 0 ? min : null,
      max: sampleCount > 0 ? max : null,
      mean: sampleCount > 0 ? sum / sampleCount : null,
      sampleCount,
    };
  }
}