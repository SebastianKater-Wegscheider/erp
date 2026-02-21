export type GeoPoint = [number, number];

export type RoutePreview = {
  start: GeoPoint;
  destination: GeoPoint;
  polyline: GeoPoint[];
  oneWayMeters: number;
};

type NominatimResult = { lat?: string; lon?: string };

type OsrmRouteResponse = {
  routes?: Array<{
    distance?: number;
    geometry?: {
      coordinates?: Array<[number, number]>;
    };
  }>;
};

export async function geocodeAddress(query: string, options?: { language?: string; signal?: AbortSignal }): Promise<GeoPoint> {
  const endpoint = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      "Accept-Language": options?.language ?? "de",
    },
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new Error(`Geocoding fehlgeschlagen (${response.status})`);
  }
  const rows = (await response.json()) as NominatimResult[];
  const first = rows[0];
  if (!first?.lat || !first?.lon) {
    throw new Error(`Adresse nicht gefunden: ${query}`);
  }

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Ungültige Koordinaten für: ${query}`);
  }
  return [lat, lon];
}

export async function calculateOsrmRoute(
  start: GeoPoint,
  destination: GeoPoint,
  options?: { signal?: AbortSignal },
): Promise<RoutePreview> {
  const endpoint = `https://router.project-osrm.org/route/v1/driving/${start[1]},${start[0]};${destination[1]},${destination[0]}?overview=full&geometries=geojson`;
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new Error(`Routenberechnung fehlgeschlagen (${response.status})`);
  }

  const data = (await response.json()) as OsrmRouteResponse;
  const route = data.routes?.[0];
  const oneWayMeters = Math.round(Number(route?.distance ?? 0));
  const coords = route?.geometry?.coordinates ?? [];
  const polyline = coords.map(([lon, lat]) => [lat, lon] as GeoPoint);

  if (!oneWayMeters || polyline.length < 2) {
    throw new Error("Keine Route gefunden. Bitte Eingabe prüfen.");
  }

  return {
    start,
    destination,
    polyline,
    oneWayMeters,
  };
}

