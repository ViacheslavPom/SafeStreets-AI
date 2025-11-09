import React, {useEffect, useRef} from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css';

// Ensure this token is correctly set in your environment variables
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || 'YOUR_MAPBOX_TOKEN_HERE'

const initialCenter = [-73.985130, 40.758896]
const initialZoom = 12.2

// Convert backend path array [[lat, lon], ...] to GeoJSON LineString
function pathArrayToGeoJSON(path) {
    if (!Array.isArray(path) || path.length < 2) {
        return undefined;
    }
    // IMPORTANT: Backend format is [lat, lon]; GeoJSON LineString requires [lon, lat]
    const coordinates = path.map(([lat, lon]) => [+lon, +lat]);
    return {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: coordinates
        }
    };
}

/** ---------- Heatmap data loading and styling ---------- */
const HEAT_LAYER_ID = 'risk-heat'
const HEAT_SOURCE_ID = 'risk-points'

/* ===== Heatmap data cache + helper ===== */
let __HEAT_RAW_CACHE = null;     // raw edges from backend
let __HEAT_GEO_CACHE = null;     // sampled GeoJSON for current zoom bucket
let __HEAT_LAST_ZBUCKET = null;  // remember last zoom bucket we rendered

// Decide spacing (meters) based on zoom
const spacingForZoom = (zoom) => {
    // console.log(zoom);
    if (zoom >= 16) return 8;     // ~10 m
    if (zoom >= 15) return 30;     // ~20 m
    if (zoom >= 14) return 60;     // ~20 m
    if (zoom >= 12) return 200;     // ~50 m
    if (zoom >= 10) return 300;    // ~100 m
    return Infinity;               // single midpoint only
}

// Bucket zoom into stable bands to reduce resampling churn
const zoomBucket = (zoom) => {
    if (zoom >= 16) return 'z16+';
    if (zoom >= 15) return 'z15';
    if (zoom >= 14) return 'z14';
    if (zoom >= 12) return 'z12-13';
    if (zoom >= 10) return 'z10-11';
    return 'z<10';
}

// Build GeoJSON points from backend edges for a given zoom
function buildHeatGeoJSON(list, zoom) {
    const feats = [];

    // quick haversine in meters
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const haversine = (lat1, lon1, lat2, lon2) => {
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
        return 2 * R * Math.asin(Math.sqrt(a));
    };

    const step = spacingForZoom(zoom);

    for (const seg of list || []) {
        if (!seg || !seg.from || !seg.to || seg.from.length < 2 || seg.to.length < 2) continue;

        // incoming order is [lat, lon]; convert + coerce to numbers
        const fromLat = +seg.from[0], fromLon = +seg.from[1];
        const toLat   = +seg.to[0],   toLon   = +seg.to[1];
        if (!isFinite(fromLat) || !isFinite(fromLon) || !isFinite(toLat) || !isFinite(toLon)) continue;

        const risk = Math.max(0, Math.min(1, +seg.risk_score || 0));

        // If zoomed out: single midpoint
        if (!isFinite(step)) {
            const midLat = (fromLat + toLat) / 2;
            const midLon = (fromLon + toLon) / 2;
            feats.push({
                type: 'Feature',
                properties: {mag: risk, risk: risk},
                geometry: {type: 'Point', coordinates: [midLon, midLat]}
            });
            continue;
        }

        // else sample along the segment based on step
        let dist = 0;
        try { dist = haversine(fromLat, fromLon, toLat, toLon) } catch {}
        let n = Math.max(1, Math.floor(dist / step)); // number of interior points
        // distribute points along (avoid endpoints to reduce duplicates with neighbors)
        for (let i = 1; i <= n; i++) {
            const t = i / (n + 1);
            const lat = fromLat + (toLat - fromLat) * t;
            const lon = fromLon + (toLon - fromLon) * t;
            feats.push({
                type: 'Feature',
                properties: {mag: risk, risk: risk},
                geometry: {type: 'Point', coordinates: [lon, lat]} // [lon,lat]
            });
        }

        // Edge shorter than step → still ensure one midpoint
        if (n === 0) {
            const midLat = (fromLat + toLat) / 2;
            const midLon = (fromLon + toLon) / 2;
            feats.push({
                type: 'Feature',
                properties: {mag: risk, risk: risk},
                geometry: {type: 'Point', coordinates: [midLon, midLat]}
            });
        }
    }

    return {type: 'FeatureCollection', features: feats};
}

let __HEAT_GEO_LOADING = (async () => {
    const base = import.meta.env.VITE_BACKEND_URL || window.location.origin;
    const url = base.replace(/\/$/, '') + '/heatmap';
    const res = await fetch(url, {cache: 'no-store', mode: 'cors'});
    if (!res || !('ok' in res)) {
        throw new Error('No Response object from fetch');
    }
    if (!res.ok) {
        const text = await (res.text?.() || Promise.resolve(''));
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    // Try JSON first; some servers send text/plain
    let data;
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (ct.includes('application/json')) {
        data = await res.json();
    } else {
        const raw = await res.text();
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error('Heatmap response is not valid JSON');
        }
    }
    // Store RAW edges and defer sampling to current zoom
    __HEAT_RAW_CACHE = Array.isArray(data) ? data : [];
    return __HEAT_RAW_CACHE;
})().catch(err => {
    console.error('Failed to load /heatmap', err);
    __HEAT_RAW_CACHE = [];
    return __HEAT_RAW_CACHE;
});

// Strong, explicit heat style so it never “disappears” after style switches
const HEAT_PAINT = {
    // radius grows with zoom so it’s visible in city scale and streets scale
    'heatmap-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, 10,
        12, 18,
        14, 26,
        16, 34
    ],
    // a decent, noticeable opacity
    'heatmap-opacity': 0.85,
    // weight from feature property, default to 1
    'heatmap-weight': ['coalesce', ['to-number', ['get', 'mag']], 1],
    // brighten a bit as you zoom in
    'heatmap-intensity': [
        'interpolate', ['linear'], ['zoom'],
        10, 0.7,
        14, 1.2
    ],
    // explicit gradient so defaults don’t neuter the layer
    'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0.0, 'rgba(0,0,0,0)',
        0.1, '#2c7fb8',
        0.3, '#41b6c4',
        0.5, '#7fcdbb',
        0.7, '#c7e9b4',
        0.85, '#fed976',
        1.0, '#f03b20'
    ],
}

// ensure source exists, and (re)sample for current zoom bucket
const ensureHeatSource = (map) => {
    if (map.getSource(HEAT_SOURCE_ID)) return;

    // Add empty source first to avoid race with style changes
    map.addSource(HEAT_SOURCE_ID, {type: 'geojson', data: {type: 'FeatureCollection', features: []}});

    // If we already have RAW edges, sample for current zoom
    if (__HEAT_RAW_CACHE) {
        try {
            const zb = zoomBucket(map.getZoom());
            __HEAT_GEO_CACHE = buildHeatGeoJSON(__HEAT_RAW_CACHE, map.getZoom());
            __HEAT_LAST_ZBUCKET = zb;
            map.getSource(HEAT_SOURCE_ID).setData(__HEAT_GEO_CACHE)
        } catch (_) {}
        return;
    }

    // Otherwise wait for the fetch to complete, then sample for current zoom
    __HEAT_GEO_LOADING?.then(() => {
        try {
            const s = map.getSource(HEAT_SOURCE_ID);
            if (!s) return;
            const zb = zoomBucket(map.getZoom());
            __HEAT_GEO_CACHE = buildHeatGeoJSON(__HEAT_RAW_CACHE, map.getZoom());
            __HEAT_LAST_ZBUCKET = zb;
            s.setData(__HEAT_GEO_CACHE);
        } catch (_) {}
    });
}

// (re)create or update heat layer, force paint + ordering
const upsertHeatLayer = (map, visible) => {
    ensureHeatSource(map)

    if (!map.getLayer(HEAT_LAYER_ID)) {
        map.addLayer({
            id: HEAT_LAYER_ID,
            type: 'heatmap',
            source: HEAT_SOURCE_ID,
            layout: {visibility: visible ? 'visible' : 'none'},
            paint: HEAT_PAINT
        })
    } else {
        // re-apply paint in case defaults wiped it
        Object.entries(HEAT_PAINT).forEach(([k, v]) => {
            try {
                map.setPaintProperty(HEAT_LAYER_ID, k, v)
            } catch {
            }
        })
        map.setLayoutProperty(HEAT_LAYER_ID, 'visibility', visible ? 'visible' : 'none')
    }

    // Make sure heat is drawn ABOVE land/roads but BELOW labels
    const layers = map.getStyle()?.layers || []
    const firstSymbol = layers.find(l => l.type === 'symbol' && l.layout?.['text-field'])
    if (firstSymbol) {
        try {
            map.moveLayer(HEAT_LAYER_ID, firstSymbol.id)
        } catch {
        }
    }
}

// Resample heat points when zoom bucket changes
const resampleHeatIfNeeded = (map) => {
    if (!map || !map.getSource(HEAT_SOURCE_ID) || !__HEAT_RAW_CACHE) return;
    const zb = zoomBucket(map.getZoom());
    if (zb === __HEAT_LAST_ZBUCKET && __HEAT_GEO_CACHE) return; // same bucket, keep
    try {
        __HEAT_GEO_CACHE = buildHeatGeoJSON(__HEAT_RAW_CACHE, map.getZoom());
        __HEAT_LAST_ZBUCKET = zb;
        map.getSource(HEAT_SOURCE_ID).setData(__HEAT_GEO_CACHE);
    } catch (_) {}
}

const setHeatVisibility = (map, on) => upsertHeatLayer(map, !!on)

/** ---------- Recreate our custom layers after any setStyle ---------- */
const recreateCustomLayers = (map, heatOn) => {
    if (!map) return
    // If we are *recreating* the style, we must recreate all custom layers.
    // This is only called on initial load and if the base style changes outside of theme functions.
    upsertHeatLayer(map, !!heatOn)

    ;['fastest', 'safest', 'weighted'].forEach(name => {
        const sid = name + '-src', lid = name + '-line'
        // check for existence before adding source/layer after a style reset
        if (!map.getSource(sid)) map.addSource(sid, {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
        if (!map.getLayer(lid)) {
            map.addLayer({
                id: lid,
                type: 'line',
                source: sid,
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-width': 5, 'line-opacity': 0.9}
            })
        }
    })
}

/** ---------- Hackopoly theme (never touches heat) ---------- */
function applyHackopolyTheme(map) {
    try {
        if (map.__hackopolyApplied) return
        map.__hackopolyApplied = true

        // Save the original style layers if they haven't been saved yet
        if (!map.__originalStyleLayers) {
            map.__originalStyleLayers = map.getStyle().layers.map(l => ({...l}))
        }
        // Save current camera for restoration
        if (!map.__originalCamera) map.__originalCamera = {bearing: map.getBearing(), pitch: map.getPitch()}

        const colors = {
            background: "#d5f4e6", water: "#7ec8e3", park: "#7fc97f", parkOutline: "#2d5016",
            building: "#f4e8d0", buildingOutline: "#D62828",
            buildingExtrusion: "rgba(77, 139, 49, 0.6)",
            buildingHotelExtrusion: "rgba(214, 40, 40, 0.6)",
            road: "#555555", text: "#000000", textHalo: "#ffffff",
            font: ["DIN Pro Bold", "Arial Unicode MS Bold"]
        }

        const patchTheme = () => {
            const layers = map.getStyle()?.layers || []

            try {
                map.setFog(null)
                map.setFog({
                    range: [0.1, 1],
                    color: '#ffffff',
                    horizonBlend: 0.05,
                    highColor: '#f0f8ff',
                    spaceColor: '#f0f8ff',
                    starIntensity: 0
                })
            } catch (_) {
            }

            layers.filter(l => /sky|fog/i.test(l.id)).forEach(l => {
                try {
                    map.setLayoutProperty(l.id, 'visibility', 'none')
                } catch (_) {
                }
            })

            // Set fixed 3D camera
            map.flyTo({pitch: 60, bearing: -20, duration: 1000})

            // FIX: Enable map rotation and pitch controls in hackopoly mode (Unrestricted)
            map.dragRotate.enable();
            map.touchZoomRotate.enable();

            layers.forEach(layer => {
                const id = layer.id.toLowerCase()
                try {
                    if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', colors.background)
                    if (id.includes('water') && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', colors.water)
                    if ((/park|landuse|pitch|grass/.test(id)) && layer.type === 'fill') {
                        map.setPaintProperty(layer.id, 'fill-color', colors.park)
                        map.setPaintProperty(layer.id, 'fill-outline-color', colors.parkOutline)
                    }
                    if (id.includes('building') && layer.type === 'fill') {
                        map.setPaintProperty(layer.id, 'fill-color', colors.building)
                        map.setPaintProperty(layer.id, 'fill-outline-color', colors.buildingOutline)
                    }
                    if ((/road|street|highway|tunnel|bridge/.test(id)) && layer.type === 'line') {
                        map.setPaintProperty(layer.id, 'line-color', colors.road)
                    }
                    if (layer.type === 'symbol') {
                        map.setPaintProperty(layer.id, 'text-color', colors.text)
                        map.setPaintProperty(layer.id, 'text-halo-color', colors.textHalo)
                        map.setLayoutProperty(layer.id, 'text-font', colors.font)
                    }
                } catch (_) {
                }
            })

            // keep buildings eye-candy
            const labelLayer = layers.find(l => l.type === 'symbol' && l.layout?.['text-field'])
            const labelLayerId = labelLayer ? labelLayer.id : undefined
            if (!map.getLayer('add-hackopoly-buildings')) {
                map.addLayer({
                    id: 'add-hackopoly-buildings',
                    source: 'composite', 'source-layer': 'building',
                    filter: ['==', 'extrude', 'true'],
                    type: 'fill-extrusion', minzoom: 15,
                    paint: {
                        'fill-extrusion-color': ['case', ['>=', ['get', 'height'], 50], colors.buildingHotelExtrusion, colors.buildingExtrusion],
                        'fill-extrusion-opacity': 1.0,
                        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['get', 'height']],
                        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['get', 'min_height']]
                    }
                }, labelLayerId)
            }

            // Heat layer is persistent, just ensure its order is correct
            upsertHeatLayer(map, map.__heatOn ?? false)
        }

        if (map.isStyleLoaded()) patchTheme()
        else map.once('style.load', patchTheme)

        const el = map.getContainer()
        if (el && !el.classList.contains('hackopoly')) el.classList.add('hackopoly')
        if (!document.getElementById('hackopoly-style')) {
            const styleTag = document.createElement('style')
            styleTag.id = 'hackopoly-style'
            document.head.appendChild(styleTag)
        }
    } catch (err) {
        console.warn('[Hackopoly] theme failed:', err)
    }
}

function removeHackopolyTheme(map) {
    try {
        map.__hackopolyApplied = false

        // 1. Manually remove the custom "hackopoly" buildings layer
        if (map.getLayer('add-hackopoly-buildings')) map.removeLayer('add-hackopoly-buildings')

        // 2. REVERT STYLE: Iterate through the original layers and restore their paint/layout properties.
        if (map.__originalStyleLayers) {
            const currentLayers = map.getStyle()?.layers || []
            const originalLayersMap = map.__originalStyleLayers.reduce((acc, l) => {
                acc[l.id] = l
                return acc
            }, {})

            currentLayers.forEach(layer => {
                const originalLayer = originalLayersMap[layer.id]
                if (!originalLayer) return // Only restore layers that were part of the original style

                // Restore paint properties
                if (originalLayer.paint) {
                    Object.entries(originalLayer.paint).forEach(([key, value]) => {
                        try {
                            map.setPaintProperty(layer.id, key, value)
                        } catch {
                        }
                    })
                }
                // Restore layout properties (e.g., text-font)
                if (originalLayer.layout) {
                    Object.entries(originalLayer.layout).forEach(([key, value]) => {
                        try {
                            map.setLayoutProperty(layer.id, key, value)
                        } catch {
                        }
                    })
                }
            })
            delete map.__originalStyleLayers
        }

        // 3. Restore camera to its original state (2D view, north-up)
        if (map.__originalCamera) {
            // This restores the pitch and bearing to allow full rotation/tilt.
            map.flyTo({pitch: map.__originalCamera.pitch, bearing: map.__originalCamera.bearing, duration: 1000})
            delete map.__originalCamera
        }

        // FIX: Disable map rotation and pitch controls in normal mode (Restricted)
        map.dragRotate.disable();
        map.touchZoomRotate.disable();

        // 4. Heatmap is persistent, just ensure it's still visible and ordered correctly.
        upsertHeatLayer(map, map.__heatOn ?? false)


        const el = map.getContainer()
        if (el) el.classList.remove('hackopoly')
        const tag = document.getElementById('hackopoly-style')
        if (tag) tag.remove()
    } catch (err) {
        console.warn('[Hackopoly] remove failed:', err)
        // Fallback: If manual style restore fails, use setStyle as a last resort
        if (map.getStyle().layers.length > 50) { // Check if style is loaded
            map.setStyle('mapbox://styles/mapbox/streets-v12')
            map.once('style.load', () => upsertHeatLayer(map, map.__heatOn ?? false))
        }
    }
}

/** -------------------- Component -------------------- */
export default function MapView() {
    const mapRef = useRef(null)
    const mapEl = useRef(null)
    const heatRef = useRef(false) // OFF by default (your requirement)

    useEffect(() => {
        if (mapRef.current) return

        // This initialization may fail if VITE_MAPBOX_TOKEN is missing or invalid
        const map = new mapboxgl.Map({
            container: mapEl.current,
            style: 'mapbox://styles/mapbox/streets-v12',
            center: initialCenter,
            zoom: initialZoom
        })
        mapRef.current = map
        // Remember initial heat state (default is false)
        map.__heatOn = heatRef.current

        // Expose map instance globally for Sidebar to access bounds
        window.__ss_map = map;

        // --- NEW: Expose API for drawing backend routes (lists of [lat, lon]) ---
        // This is the function that is called from Sidebar.js
        window.__drawRoutesFromBackend = (data) => {
            console.log('Backend Data Received:', data); // LOG 1: Raw data from server
            if (!data) return
            // Map shortest_path to 'fastest', safest_path to 'safest', etc.
            const { shortest_path, safest_path, weighted_path, active } = data

            // pathArrayToGeoJSON expects paths in the backend format: [[lat, lon], ...]
            const fastestGeoJSON = shortest_path ? pathArrayToGeoJSON(shortest_path) : undefined;
            const safestGeoJSON = safest_path ? pathArrayToGeoJSON(safest_path) : undefined;
            const weightedGeoJSON = weighted_path ? pathArrayToGeoJSON(weighted_path) : undefined;

            const eventDetail = {
                // Converted GeoJSON objects
                fastest: fastestGeoJSON,
                safest: safestGeoJSON,
                weighted: weightedGeoJSON,
                active: active || 'weighted' // Default to weighted if no active is specified
            }

            console.log('GeoJSON Dispatched:', eventDetail); // LOG 2: Converted data

            // This dispatch triggers the existing onDrawRoutes handler in the second useEffect
            window.dispatchEvent(new CustomEvent('app:draw-routes', { detail: eventDetail }))
        }
        // --------------------------------------------------------------------------

        // FIX: Disable rotation controls on map initialization (for default mode)
        map.dragRotate.disable();
        map.touchZoomRotate.disable();

        const onInitialLoad = () => {
            new mapboxgl.Marker({color: '#22d3ee'})
                .setLngLat(initialCenter)
                .setPopup(new mapboxgl.Popup().setText('Manhattan, NYC'))
                .addTo(map)

            // build layers with current heatRef state and enforce paint/order
            recreateCustomLayers(map, heatRef.current)

            // if external toggle is already ON, apply theme (heat is independent)
            if (window.__mapStyleAlt) applyHackopolyTheme(map)
        }

        map.on('load', onInitialLoad)

        // This listener is now primarily a safety net, as theme functions handle style load internally
        map.on('style.load', () => {
            recreateCustomLayers(map, map.__heatOn ?? heatRef.current)
        })

        // RESAMPLE HEAT WHEN ZOOM BUCKET CHANGES
        const onZoomEnd = () => resampleHeatIfNeeded(map);
        map.on('zoomend', onZoomEnd);

        try {
            map.addControl(new mapboxgl.AttributionControl({compact: false}), 'bottom-right');
            map.addControl(new mapboxgl.LogoControl({}), 'bottom-left');
        } catch (_) {
        }

        if (!document.getElementById('ss-mapbox-fixes')) {
            const style = document.createElement('style');
            style.id = 'ss-mapbox-fixes';
            style.textContent = `
#map .mapboxgl-ctrl-logo, 
#map .mapboxgl-ctrl-attrib {
  background: transparent !important;
  border-radius: 4px !important;
  box-shadow: none !important;
  padding: 0 4px !important;
  margin: 0 4px 4px 4px !important;
}
#map .mapboxgl-ctrl-attrib {
  font-size: 11px !important;
  color: #d1d5db !important;
}
#map .mapboxgl-ctrl-attrib a { color: #9ec5ff !important; text-decoration: none; }
#map .mapboxgl-ctrl-attrib a:hover { text-decoration: underline; }
`;
            document.head.appendChild(style);
        }

        return () => {
            map.off('zoomend', onZoomEnd);
            map.remove();
            // --- NEW: Cleanup the global function ---
            delete window.__drawRoutesFromBackend;
            delete window.__ss_map;
        }
    }, [])

    useEffect(() => {
        const map = () => mapRef.current
        const ctrl = new AbortController()
        const opts = {signal: ctrl.signal}

        // Theme toggle
        const onToggleStyle = () => {
            const m = map();
            if (!m) return
            // Snapshot the current heat state for the theme functions to use.
            m.__heatOn = heatRef.current

            if (window.__mapStyleAlt) applyHackopolyTheme(m)
            else removeHackopolyTheme(m)
        }

        // Heat toggle — only place that changes heatRef and the map layer
        const onToggleHeat = () => {
            const m = map();
            if (!m) return
            heatRef.current = !heatRef.current
            // remember on map for any theme-side reassert
            m.__heatOn = heatRef.current
            upsertHeatLayer(m, heatRef.current)
            // When turning heat on, make sure data matches current zoom bucket
            if (heatRef.current) resampleHeatIfNeeded(m);
        }

        // Route drawing (triggered by app:draw-routes from __drawRoutesFromBackend)
        const onDrawRoutes = (e) => {
            const m = map();
            if (!m) return
            const d = e.detail || {}
            const {fastest, safest, weighted, active} = d
            const upd = (n, data) => {
                try {
                    const s = m.getSource(n + '-src');
                    if (s && data) s.setData(data);
                } catch (_) {
                }
            }
            upd('fastest', fastest);
            upd('safest', safest);
            upd('weighted', weighted);
            const chosenName = active || (weighted ? 'weighted' : (safest ? 'safest' : 'fastest'));
            const chosen = chosenName === 'weighted' ? weighted : (chosenName === 'safest' ? safest : fastest);

            const getLineCoords = (geo) => {
                if (!geo) return [];
                const g = geo.type === 'Feature' ? geo.geometry : geo;
                if (!g) return [];
                if (g.type === 'LineString') return [g.coordinates];
                if (g.type === 'MultiLineString') return g.coordinates;
                if (geo.type === 'FeatureCollection') {
                    let acc = [];
                    for (const f of geo.features || []) {
                        const gg = f.geometry;
                        if (gg?.type === 'LineString') acc.push(gg.coordinates);
                        else if (gg?.type === 'MultiLineString') acc = acc.concat(gg.coordinates);
                    }
                    return acc;
                }
                return [];
            }
            const computeBounds = (lines) => {
                let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
                for (const line of lines) {
                    for (const [lng, lat] of line) {
                        if (lng < w) w = lng;
                        if (lat < s) s = lat;
                        if (lng > e) e = lng;
                        if (lat > n) n = lat;
                    }
                }
                if (!isFinite(w)) return null;
                return [[w, s], [e, n]];
            }
            const getLineEnd = (lines) => {
                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i];
                    if (line && line.length) {
                        return line[line.length - 1];
                    }
                }
                return null;
            }

            const lines = getLineCoords(chosen);
            if (lines.length) {
                const b = computeBounds(lines);
                if (b) {
                    try {
                        // The fitBounds for routes is usually more zoomed in than the start/end points alone
                        m.fitBounds(b, {padding: 60, maxZoom: 16, duration: 500});
                    } catch (_) {
                    }
                }
                const end = getLineEnd(lines);
                if (end) {
                    if (!m.__routeEndMarker) {
                        m.__routeEndMarker = new mapboxgl.Marker().setLngLat(end).addTo(m);
                    } else {
                        m.__routeEndMarker.setLngLat(end);
                    }
                }
            }
        }

        // NEW: Event handler to fit both the origin and destination points
        const onFitRoutePoints = (e) => {
            const m = map();
            if (!m) return
            const d = e.detail || {};
            const { origin, destination } = d; // {lng, lat} objects

            if (!origin || !destination) return;

            // Mapbox requires [[west, south], [east, north]] coordinates
            // Longitude (lng) is X, Latitude (lat) is Y
            const coords = [
                [origin.lng, origin.lat],
                [destination.lng, destination.lat]
            ];

            // Create a LngLatBounds object from the coordinates
            const bounds = coords.reduce((bounds, coord) => {
                return bounds.extend(coord);
            }, new mapboxgl.LngLatBounds(coords[0], coords[0]));

            try {
                m.fitBounds(bounds, {
                    padding: 80, // Add some margin around the points
                    duration: 1000,
                    maxZoom: 14 // Don't zoom in too close
                });
            } catch (error) {
                console.error("Failed to fit bounds to route points:", error);
            }
        }


        window.addEventListener('app:toggle-style', onToggleStyle, opts)
        window.addEventListener('app:toggle-heat', onToggleHeat, opts)
        window.addEventListener('app:draw-routes', onDrawRoutes, opts)
        window.addEventListener('app:fit-route-points', onFitRoutePoints, opts) // NEW LISTENER

        // NEW: basic camera controls from TopRightControls
        const onZoomIn = () => {
            try {
                const m = map();
                if (!m) return;
                m.zoomTo(Math.min(m.getZoom() + 1, 20), {duration: 250})
            } catch (_) {
            }
        }
        const onZoomOut = () => {
            try {
                const m = map();
                if (!m) return;
                m.zoomTo(Math.max(m.getZoom() - 1, 1), {duration: 250})
            } catch (_) {
            }
        }
        const onGeolocate = () => {
            try {
                const m = map();
                if (!m) return;
                const center = window.__SS_HARDCODED_CENTER || [-73.985130, 40.758896];
                m.flyTo({center, zoom: Math.max(m.getZoom(), 14), essential: true})
            } catch (_) {
            }
        }

        const onSetDestination = (e) => {
            const m = map();
            if (!m) return
            const { lng, lat } = e.detail;

            if (!m.__destinationMarker) {
                // Use a different color/style to distinguish from the route end marker
                m.__destinationMarker = new mapboxgl.Marker({ color: '#f87171' })
                    .setLngLat([lng, lat])
                    .addTo(m);
            } else {
                m.__destinationMarker.setLngLat([lng, lat]);
            }
        }
        window.addEventListener('app:set-destination', onSetDestination, opts);

        window.addEventListener('app:zoom-in', onZoomIn, opts)
        window.addEventListener('app:zoom-out', onZoomOut, opts)
        window.addEventListener('app:geolocate', onGeolocate, opts)

        return () => ctrl.abort()
    }, [])

    return <div id="map" ref={mapEl}/>
}