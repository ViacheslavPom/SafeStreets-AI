import React, {useEffect, useRef} from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || 'YOUR_MAPBOX_TOKEN_HERE'

const initialCenter = [-73.985130, 40.758896]
const initialZoom = 12.2

/** ---------- Heatmap styling (reapplied after any style change) ---------- */
const HEAT_LAYER_ID = 'risk-heat'
const HEAT_SOURCE_ID = 'risk-points'

/* ===== Heatmap data cache + helper ===== */
let __HEAT_GEO_CACHE = null;
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
    __HEAT_GEO_CACHE = buildHeatGeoJSON(Array.isArray(data) ? data : []);
    return __HEAT_GEO_CACHE;
})().catch(err => {
    console.error('Failed to load /heatmap', err);
    __HEAT_GEO_CACHE = {type: 'FeatureCollection', features: []};
    return __HEAT_GEO_CACHE;
});

function buildHeatGeoJSON(list) {
    // backend returns { coordinates:[lat,lon], risk_score:number in [0,1] }
    const feats = [];
    for (const p of list || []) {
        if (!p || !p.coordinates || p.coordinates.length < 2) continue;
        const lat = +p.coordinates[0];
        const lon = +p.coordinates[1];
        const r = Math.max(0, Math.min(1, +p.risk_score || 0));
        // GeoJSON requires [lon, lat]
        feats.push({
            type: 'Feature',
            properties: {mag: r, risk: r},
            geometry: {type: 'Point', coordinates: [lon, lat]}
        });
    }
    return {type: 'FeatureCollection', features: feats};
}


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

// ensure source exists
const ensureHeatSource = (map) => {
    const base = import.meta.env.VITE_BACKEND_URL || window.location.origin;
    const url = base.replace(/\/$/, '') + '/heatmap';

    if (map.getSource(HEAT_SOURCE_ID)) return;

    // Add empty source first to avoid race with style changes
    map.addSource(HEAT_SOURCE_ID, {type: 'geojson', data: {type: 'FeatureCollection', features: []}});

    // If cached, set immediately
    if (__HEAT_GEO_CACHE) {
        try {
            map.getSource(HEAT_SOURCE_ID).setData(__HEAT_GEO_CACHE)
        } catch (_) {
        }
        return;
    }

    // Kick off a single fetch once
    if (!__HEAT_GEO_LOADING) {

        __HEAT_GEO_LOADING = fetch(url, {cache: 'no-store'})
            .then(r => r.json())
            .then(list => {
                __HEAT_GEO_CACHE = buildHeatGeoJSON(list || []);
                return __HEAT_GEO_CACHE;
            })
            .catch(err => {
                console.error('Failed to load /heatmap', err);
                __HEAT_GEO_CACHE = {type: 'FeatureCollection', features: []};
                return __HEAT_GEO_CACHE;
            });
    }

    __HEAT_GEO_LOADING.then(geo => {
        try {
            const s = map.getSource(HEAT_SOURCE_ID);
            if (s) s.setData(geo);
        } catch (_) {
        }
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
        const map = new mapboxgl.Map({
            container: mapEl.current,
            style: 'mapbox://styles/mapbox/streets-v12',
            center: initialCenter,
            zoom: initialZoom
        })
        mapRef.current = map
        // Remember initial heat state (default is false)
        map.__heatOn = heatRef.current

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

        return () => map.remove()
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
        }

        // Route drawing (unchanged)
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

        window.addEventListener('app:toggle-style', onToggleStyle, opts)
        window.addEventListener('app:toggle-heat', onToggleHeat, opts)
        window.addEventListener('app:draw-routes', onDrawRoutes, opts)

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

        window.addEventListener('app:zoom-in', onZoomIn, opts)
        window.addEventListener('app:zoom-out', onZoomOut, opts)
        window.addEventListener('app:geolocate', onGeolocate, opts)

        return () => ctrl.abort()
    }, [])

    return <div id="map" ref={mapEl}/>
}