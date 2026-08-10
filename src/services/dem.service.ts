import fs from 'fs';
import path from 'path';
import { fromFile, GeoTIFFImage } from 'geotiff';
import { config } from '../config';
import { RASTER_BBOX } from '../stations';
import {
  DemAglToMslPayload,
  DemElevationBatchPayload,
  DemElevationPayload,
  DemGroundCollisionAnalyzePayload,
  DemGroundCollisionAnalyzeRequest,
  DemGroundCollisionRoutePoint,
  DemGroundCollisionAnalyzeSegment,
  DemGroundCollisionAnalyzeProfilePoint,
  DemServiceStatusPayload,
} from '../types';
import { HttpError } from './meteo.service';

type DemRaster = {
  filePath: string;
  sourceName: string;
  image: GeoTIFFImage;
  originLon: number;
  originLat: number;
  resolutionLon: number;
  resolutionLat: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  width: number;
  height: number;
  noData: number | null;
};

type CoveringRaster = DemRaster & {
  distanceToCenter: number;
};

export class DemService {
  private rasters: DemRaster[] = [];
  private loadError: string | null = null;
  private isLoaded = false;
  private loadPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (!config.demEnabled) {
      this.isLoaded = true;
      return;
    }

    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = this.loadRasters();
    await this.loadPromise;
  }

  status(): DemServiceStatusPayload {
    return {
      enabled: config.demEnabled,
      loaded: this.isLoaded,
      rasterCount: this.rasters.length,
      dataPath: config.demDataPath,
    };
  }

  async getElevation(lat: number, lon: number): Promise<DemElevationPayload> {
    this.validateCoordinate(lat, lon);
    await this.initialize();

    if (config.demRestrictToMeteoBbox && !this.isInsideMeteoBbox(lat, lon)) {
      return {
        latitude: lat,
        longitude: lon,
        elevationMeters: config.demNoDataFallbackMeters,
        elevationFeet: this.toFeet(config.demNoDataFallbackMeters),
        source: 'dem-outside-meteo-bbox-fallback',
      };
    }

    if (!config.demEnabled) {
      return {
        latitude: lat,
        longitude: lon,
        elevationMeters: config.demNoDataFallbackMeters,
        elevationFeet: this.toFeet(config.demNoDataFallbackMeters),
        source: 'dem-disabled-fallback',
      };
    }

    if (!this.rasters.length) {
      throw new HttpError(503, this.loadError ?? 'DEM raster verisi bulunamadi');
    }

    const raster = this.pickRaster(lat, lon);
    if (!raster) {
      return {
        latitude: lat,
        longitude: lon,
        elevationMeters: config.demNoDataFallbackMeters,
        elevationFeet: this.toFeet(config.demNoDataFallbackMeters),
        source: 'dem-outside-coverage-fallback',
      };
    }

    const elevationMeters = await this.sampleElevationMeters(raster, lat, lon);
    if (elevationMeters == null) {
      return {
        latitude: lat,
        longitude: lon,
        elevationMeters: config.demNoDataFallbackMeters,
        elevationFeet: this.toFeet(config.demNoDataFallbackMeters),
        source: `dem-nodata-fallback:${raster.sourceName}`,
      };
    }

    return {
      latitude: lat,
      longitude: lon,
      elevationMeters,
      elevationFeet: this.toFeet(elevationMeters),
      source: `dem:${raster.sourceName}`,
    };
  }

  async aglToMslRounded(
    lat: number,
    lon: number,
    aglFeet: number,
    roundStepFeet = config.demAglRoundStepFt,
  ): Promise<DemAglToMslPayload> {
    if (!Number.isFinite(aglFeet) || aglFeet < 0) {
      throw new HttpError(400, 'aglFt negatif olamaz');
    }

    const roundStep = Number.isFinite(roundStepFeet) && roundStepFeet > 0 ? roundStepFeet : 100;
    const elevation = await this.getElevation(lat, lon);
    const groundFt = elevation.elevationFeet ?? 0;
    const rawMslFt = groundFt + aglFeet;
    const roundedUp = Math.ceil(rawMslFt / roundStep) * roundStep;

    return {
      latitude: lat,
      longitude: lon,
      aglFeet,
      roundStepFeet: roundStep,
      groundElevationFeet: groundFt,
      mslFeetRoundedUp: Math.max(0, roundedUp),
    };
  }

  async getElevationBatch(
    points: Array<{ lat: number; lon: number; aglFt?: number }>,
    defaultRoundStepFeet?: number,
  ): Promise<DemElevationBatchPayload> {
    if (!Array.isArray(points) || points.length === 0) {
      throw new HttpError(400, 'points bos olamaz');
    }

    if (points.length > config.demBatchMaxPoints) {
      throw new HttpError(
        400,
        `points limiti asildi. En fazla ${config.demBatchMaxPoints} nokta gonderilebilir`,
      );
    }

    const roundStep = Number.isFinite(defaultRoundStepFeet)
      ? Number(defaultRoundStepFeet)
      : config.demAglRoundStepFt;

    const results = await Promise.all(
      points.map(async (point) => {
        const base = await this.getElevation(point.lat, point.lon);
        if (!Number.isFinite(point.aglFt)) {
          return base;
        }

        const aglResult = await this.aglToMslRounded(point.lat, point.lon, Number(point.aglFt), roundStep);
        return {
          ...base,
          aglFeet: aglResult.aglFeet,
          roundStepFeet: aglResult.roundStepFeet,
          mslFeetRoundedUp: aglResult.mslFeetRoundedUp,
        };
      }),
    );

    return {
      count: results.length,
      results,
    };
  }

  async analyzeGroundCollision(
    request: DemGroundCollisionAnalyzeRequest,
  ): Promise<DemGroundCollisionAnalyzePayload> {
    const routePoints = Array.isArray(request.routePoints) ? request.routePoints : [];
    if (routePoints.length < 2) {
      throw new HttpError(400, 'routePoints en az 2 nokta icermelidir');
    }

    const normalizedPoints = routePoints.map((point) => this.normalizeRoutePoint(point));
    const lateralNm = Number.isFinite(request.lateralNm) && Number(request.lateralNm) > 0
      ? Number(request.lateralNm)
      : 1.0;
    const clearanceFt = Number.isFinite(request.clearanceFt) && Number(request.clearanceFt) >= 0
      ? Number(request.clearanceFt)
      : 500;
    const profileStepNm = Number.isFinite(request.profileStepNm) && Number(request.profileStepNm) > 0
      ? Number(request.profileStepNm)
      : 1.0;

    const profile = this.buildProfilePoints(normalizedPoints, profileStepNm);
    const segmentSamples = this.buildSegmentSamples(normalizedPoints, lateralNm);

    const samplePoints = profile.map((p) => ({ lat: p.lat, lon: p.lon }));
    const elevationResults = await this.getElevationBatchChunked(samplePoints);

    const terrainByKey = new Map<string, number>();
    for (const row of elevationResults) {
      terrainByKey.set(this.pointKey(row.latitude, row.longitude), row.elevationFeet ?? 0);
    }

    const profileRows: DemGroundCollisionAnalyzeProfilePoint[] = profile.map((p) => {
      const terrainFt = terrainByKey.get(this.pointKey(p.lat, p.lon)) ?? 0;
      const clearance = p.aircraftAltitudeFt - terrainFt;
      return {
        distanceNm: p.distanceNm,
        lat: p.lat,
        lon: p.lon,
        terrainFt,
        aircraftAltitudeFt: p.aircraftAltitudeFt,
        clearanceFt: clearance,
        severity: this.severityFromClearance(clearance, clearanceFt),
      };
    });

    const minBySegment = new Map<number, number>();
    for (let i = 0; i < profileRows.length; i++) {
      const owner = profile[i]?.segmentIndex ?? -1;
      if (owner < 0) continue;
      const currentMin = minBySegment.get(owner);
      const currentClearance = profileRows[i].clearanceFt;
      if (currentMin == null || currentClearance < currentMin) {
        minBySegment.set(owner, currentClearance);
      }
    }

    const segments: DemGroundCollisionAnalyzeSegment[] = segmentSamples.map((segment) => {
      const minClearanceFt = minBySegment.get(segment.index) ?? Number.POSITIVE_INFINITY;
      return {
        index: segment.index,
        from: segment.from,
        to: segment.to,
        leftFrom: segment.leftFrom,
        leftTo: segment.leftTo,
        rightFrom: segment.rightFrom,
        rightTo: segment.rightTo,
        minClearanceFt,
        severity: this.severityFromClearance(minClearanceFt, clearanceFt),
      };
    });

    const finiteClearances = profileRows
      .map((row) => row.clearanceFt)
      .filter((value) => Number.isFinite(value));
    const minClearanceFt = finiteClearances.length
      ? finiteClearances.reduce((a, b) => Math.min(a, b))
      : 0;

    const totalDistanceNm = profileRows.length
      ? profileRows[profileRows.length - 1].distanceNm
      : 0;

    return {
      generatedAt: new Date().toISOString(),
      lateralNm,
      clearanceFt,
      totalDistanceNm,
      minClearanceFt,
      segments,
      profile: profileRows,
    };
  }

  private normalizeRoutePoint(point: DemGroundCollisionRoutePoint): DemGroundCollisionRoutePoint {
    const lat = Number(point.lat);
    const lon = Number(point.lon);
    const aircraftAltitudeFt = Number(point.aircraftAltitudeFt);
    this.validateCoordinate(lat, lon);
    if (!Number.isFinite(aircraftAltitudeFt)) {
      throw new HttpError(400, 'routePoints[].aircraftAltitudeFt sayisal olmalidir');
    }
    return { lat, lon, aircraftAltitudeFt };
  }

  private pointKey(lat: number, lon: number): string {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  private severityFromClearance(
    clearanceFt: number,
    thresholdFt: number,
  ): 'danger' | 'warning' | 'safe' {
    if (!Number.isFinite(clearanceFt)) return 'danger';
    if (clearanceFt < thresholdFt) return 'danger';
    if (clearanceFt < thresholdFt * 1.5) return 'warning';
    return 'safe';
  }

  private buildSegmentSamples(
    routePoints: DemGroundCollisionRoutePoint[],
    lateralNm: number,
  ): Array<
    Omit<DemGroundCollisionAnalyzeSegment, 'minClearanceFt' | 'severity'>
  > {
    const out: Array<Omit<DemGroundCollisionAnalyzeSegment, 'minClearanceFt' | 'severity'>> = [];
    for (let i = 0; i < routePoints.length - 1; i++) {
      const from = routePoints[i];
      const to = routePoints[i + 1];
      const course = this.bearingDegrees(from.lat, from.lon, to.lat, to.lon);
      out.push({
        index: i,
        from: { lat: from.lat, lon: from.lon },
        to: { lat: to.lat, lon: to.lon },
        leftFrom: this.offsetPointByNm(from.lat, from.lon, course, lateralNm, true),
        leftTo: this.offsetPointByNm(to.lat, to.lon, course, lateralNm, true),
        rightFrom: this.offsetPointByNm(from.lat, from.lon, course, lateralNm, false),
        rightTo: this.offsetPointByNm(to.lat, to.lon, course, lateralNm, false),
      });
    }
    return out;
  }

  private buildProfilePoints(
    routePoints: DemGroundCollisionRoutePoint[],
    stepNm: number,
  ): Array<{
    segmentIndex: number;
    distanceNm: number;
    lat: number;
    lon: number;
    aircraftAltitudeFt: number;
  }> {
    const out: Array<{
      segmentIndex: number;
      distanceNm: number;
      lat: number;
      lon: number;
      aircraftAltitudeFt: number;
    }> = [];

    let cumulativeNm = 0;
    out.push({
      segmentIndex: 0,
      distanceNm: 0,
      lat: routePoints[0].lat,
      lon: routePoints[0].lon,
      aircraftAltitudeFt: routePoints[0].aircraftAltitudeFt,
    });

    for (let i = 0; i < routePoints.length - 1; i++) {
      const from = routePoints[i];
      const to = routePoints[i + 1];
      const segmentNm = this.distanceNmBetween(from.lat, from.lon, to.lat, to.lon);
      if (!Number.isFinite(segmentNm) || segmentNm <= 0) continue;

      const steps = Math.max(1, Math.ceil(segmentNm / stepNm));
      for (let step = 1; step <= steps; step++) {
        const ratio = step / steps;
        const lat = from.lat + ((to.lat - from.lat) * ratio);
        const lon = from.lon + ((to.lon - from.lon) * ratio);
        const aircraftAltitudeFt = from.aircraftAltitudeFt + ((to.aircraftAltitudeFt - from.aircraftAltitudeFt) * ratio);
        out.push({
          segmentIndex: i,
          distanceNm: cumulativeNm + (segmentNm * ratio),
          lat,
          lon,
          aircraftAltitudeFt,
        });
      }
      cumulativeNm += segmentNm;
    }

    return out;
  }

  private async getElevationBatchChunked(
    points: Array<{ lat: number; lon: number }>,
  ): Promise<DemElevationPayload[]> {
    if (!points.length) return [];

    const chunkSize = Math.max(1, config.demBatchMaxPoints);
    const allResults: DemElevationPayload[] = [];
    for (let i = 0; i < points.length; i += chunkSize) {
      const chunk = points.slice(i, i + chunkSize);
      const response = await this.getElevationBatch(chunk);
      allResults.push(...response.results.map((row) => ({
        latitude: row.latitude,
        longitude: row.longitude,
        elevationMeters: row.elevationMeters,
        elevationFeet: row.elevationFeet,
        source: row.source,
      })));
    }
    return allResults;
  }

  private offsetPointByNm(
    lat: number,
    lon: number,
    courseDeg: number,
    offsetNm: number,
    left: boolean,
  ): { lat: number; lon: number } {
    const km = offsetNm * 1.852;
    const angleDeg = left ? (courseDeg - 90) : (courseDeg + 90);
    const angleRad = this.toRad(angleDeg);
    const dLat = (km / 111) * Math.cos(angleRad);
    const lonFactor = Math.max(Math.abs(Math.cos(this.toRad(lat))), 0.01);
    const dLon = (km / (111 * lonFactor)) * Math.sin(angleRad);
    return {
      lat: lat + dLat,
      lon: lon + dLon,
    };
  }

  private bearingDegrees(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const phi1 = this.toRad(lat1);
    const phi2 = this.toRad(lat2);
    const deltaLambda = this.toRad(lon2 - lon1);
    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
    const bearing = this.toDeg(Math.atan2(y, x));
    return (bearing + 360) % 360;
  }

  private distanceNmBetween(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const rKm = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceKm = rKm * c;
    return distanceKm / 1.852;
  }

  private toRad(value: number): number {
    return (value * Math.PI) / 180;
  }

  private toDeg(value: number): number {
    return (value * 180) / Math.PI;
  }

  private async loadRasters(): Promise<void> {
    try {
      const demPath = path.isAbsolute(config.demDataPath)
        ? config.demDataPath
        : path.resolve(process.cwd(), config.demDataPath);

      const tiffFiles = this.collectTiffFiles(demPath);
      if (!tiffFiles.length) {
        this.rasters = [];
        this.loadError = `DEM dizininde GeoTIFF bulunamadi: ${demPath}`;
        this.isLoaded = true;
        return;
      }

      const rasters = await Promise.all(
        tiffFiles.map(async (filePath) => {
          const tiff = await fromFile(filePath);
          const image = await tiff.getImage();
          const bbox = image.getBoundingBox();
          const [bboxA, bboxB, bboxC, bboxD] = bbox;
          const minLon = Math.min(bboxA, bboxC);
          const maxLon = Math.max(bboxA, bboxC);
          const minLat = Math.min(bboxB, bboxD);
          const maxLat = Math.max(bboxB, bboxD);
          const origin = image.getOrigin();
          const resolution = image.getResolution();
          const originLon = Number(origin?.[0]);
          const originLat = Number(origin?.[1]);
          const resolutionLon = Number(resolution?.[0]);
          const resolutionLat = Number(resolution?.[1]);
          const sourceName = path.basename(filePath);
          const noDataRaw = image.getGDALNoData();
          const noData = Number.isFinite(noDataRaw) ? Number(noDataRaw) : null;

          const raster: DemRaster = {
            filePath,
            sourceName,
            image,
            originLon,
            originLat,
            resolutionLon,
            resolutionLat,
            minLon,
            minLat,
            maxLon,
            maxLat,
            width: image.getWidth(),
            height: image.getHeight(),
            noData,
          };
          return raster;
        }),
      );

      this.rasters = rasters;
      this.loadError = null;
      this.isLoaded = true;
      console.log(`DEM yuklendi: ${rasters.length} raster`);
    } catch (error) {
      this.rasters = [];
      this.loadError = error instanceof Error ? error.message : String(error);
      this.isLoaded = true;
      throw new HttpError(500, `DEM yukleme hatasi: ${this.loadError}`);
    }
  }

  private collectTiffFiles(targetPath: string): string[] {
    if (!fs.existsSync(targetPath)) return [];

    const stats = fs.statSync(targetPath);
    if (stats.isFile()) {
      return /\.tiff?$/i.test(targetPath) ? [targetPath] : [];
    }

    const files: string[] = [];
    const stack = [targetPath];

    while (stack.length) {
      const current = stack.pop();
      if (!current) continue;

      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        if (entry.isFile() && /\.tiff?$/i.test(entry.name)) {
          files.push(absolute);
        }
      }
    }

    return files;
  }

  private pickRaster(lat: number, lon: number): CoveringRaster | null {
    const candidates = this.rasters
      .filter(
        (raster) =>
          lon >= raster.minLon &&
          lon <= raster.maxLon &&
          lat >= raster.minLat &&
          lat <= raster.maxLat,
      )
      .map((raster) => {
        const centerLat = (raster.minLat + raster.maxLat) / 2;
        const centerLon = (raster.minLon + raster.maxLon) / 2;
        const distanceToCenter = Math.hypot(lat - centerLat, lon - centerLon);
        return { ...raster, distanceToCenter };
      })
      .sort((a, b) => a.distanceToCenter - b.distanceToCenter);

    return candidates[0] ?? null;
  }

  private async sampleElevationMeters(
    raster: DemRaster,
    lat: number,
    lon: number,
  ): Promise<number | null> {
    const hasGeoTransform =
      Number.isFinite(raster.originLon) &&
      Number.isFinite(raster.originLat) &&
      Number.isFinite(raster.resolutionLon) &&
      Number.isFinite(raster.resolutionLat) &&
      Math.abs(raster.resolutionLon) > 0 &&
      Math.abs(raster.resolutionLat) > 0;

    let px: number;
    let py: number;

    if (hasGeoTransform) {
      const xPixel = (lon - raster.originLon) / raster.resolutionLon;
      const yPixel = (lat - raster.originLat) / raster.resolutionLat;
      if (!Number.isFinite(xPixel) || !Number.isFinite(yPixel)) return null;
      px = Math.round(xPixel);
      py = Math.round(yPixel);
    } else {
      const lonRange = raster.maxLon - raster.minLon;
      const latRange = raster.maxLat - raster.minLat;
      if (lonRange <= 0 || latRange <= 0) return null;

      const xRatio = (lon - raster.minLon) / lonRange;
      const yRatio = (raster.maxLat - lat) / latRange;
      if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return null;

      px = Math.round(xRatio * (raster.width - 1));
      py = Math.round(yRatio * (raster.height - 1));
    }

    px = Math.max(0, Math.min(raster.width - 1, px));
    py = Math.max(0, Math.min(raster.height - 1, py));

    const rasterWindow = await raster.image.readRasters({
      interleave: true,
      samples: [0],
      window: [px, py, px + 1, py + 1],
    });

    const valueRaw = Number((rasterWindow as ArrayLike<number>)[0]);
    if (!Number.isFinite(valueRaw)) return null;
    if (raster.noData != null && Math.abs(valueRaw - raster.noData) < 1e-6) return null;

    return valueRaw;
  }

  private validateCoordinate(lat: number, lon: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new HttpError(400, 'lat/lon zorunlu ve sayisal olmalidir');
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new HttpError(400, 'lat/lon araligi gecersiz');
    }
  }

  private isInsideMeteoBbox(lat: number, lon: number): boolean {
    return (
      lat <= RASTER_BBOX.north &&
      lat >= RASTER_BBOX.south &&
      lon <= RASTER_BBOX.east &&
      lon >= RASTER_BBOX.west
    );
  }

  private toFeet(meters: number | null): number | null {
    if (meters == null || !Number.isFinite(meters)) return null;
    return Math.round(meters * 3.28084);
  }
}
