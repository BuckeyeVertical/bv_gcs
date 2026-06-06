import { useEffect, useRef } from 'react';
import maplibregl, { Map, Marker } from 'maplibre-gl';
import { useGcsStore } from '../store/useGcsStore';

// CARTO dark-matter — free; MapLibre auto-renders the required OSM+CARTO attribution.
const STYLE_URL =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const droneMarkerRef = useRef<Marker | null>(null);
  const detectionMarkerRef = useRef<Marker | null>(null);

  const fix = useGcsStore((s) => s.droneFix);
  const active = useGcsStore((s) => s.activePending);

  // Initialize map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [0, 0],
      zoom: 2,
      attributionControl: { compact: true },
    });
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Drone marker.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fix) return;
    const el =
      droneMarkerRef.current?.getElement() ?? buildDroneEl();
    if (!droneMarkerRef.current) {
      droneMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([fix.longitude, fix.latitude])
        .addTo(map);
      map.jumpTo({ center: [fix.longitude, fix.latitude], zoom: 18 });
    } else {
      droneMarkerRef.current.setLngLat([fix.longitude, fix.latitude]);
    }
  }, [fix?.latitude, fix?.longitude]);

  // Detection marker — pulses while a pending detection is awaiting decision.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!active) {
      detectionMarkerRef.current?.remove();
      detectionMarkerRef.current = null;
      return;
    }
    if (!detectionMarkerRef.current) {
      detectionMarkerRef.current = new maplibregl.Marker({
        element: buildDetectionEl(),
      })
        .setLngLat([active.longitude, active.latitude])
        .addTo(map);
    } else {
      detectionMarkerRef.current.setLngLat([active.longitude, active.latitude]);
    }
    map.flyTo({
      center: [active.longitude, active.latitude],
      zoom: Math.max(map.getZoom(), 18),
      speed: 1.2,
    });
  }, [active?.detection_id, active?.latitude, active?.longitude]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

function buildDroneEl(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'width:14px;height:14px;border-radius:50%;background:#4a9eff;' +
    'box-shadow:0 0 0 2px #0a0c10,0 0 12px #4a9eff;';
  return el;
}

function buildDetectionEl(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:18px;height:18px;';
  const ring = document.createElement('div');
  ring.className = 'pulse-ring';
  ring.style.cssText =
    'position:absolute;inset:0;border-radius:50%;border:2px solid #f0883e;';
  const core = document.createElement('div');
  core.style.cssText =
    'position:absolute;inset:4px;border-radius:50%;background:#f0883e;' +
    'box-shadow:0 0 0 2px #0a0c10;';
  wrap.appendChild(ring);
  wrap.appendChild(core);
  return wrap;
}
