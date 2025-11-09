import React, { useEffect, useRef, useState } from 'react'
import debounce from 'lodash.debounce'

// Mapbox Geocoding v5 (supports POIs)
const MAPBOX_GEOCODE = 'https://api.mapbox.com/geocoding/v5/mapbox.places'
const FALLBACK_CENTER = [-73.985130, 40.758896] // Times Square

export default function Sidebar() {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [recents, setRecents] = useState([])

  const token = import.meta.env.VITE_MAPBOX_TOKEN || 'YOUR_MAPBOX_TOKEN_HERE'
  const backendUrl = import.meta.env.VITE_BACKEND_URL || ''

  const getCenter = () => {
    try {
      const map = window.__ss_map
      if (map) { const c = map.getCenter(); return [c.lng, c.lat] }
    } catch {}
    return FALLBACK_CENTER
  }

  const fetchSuggestions = async (q) => {
    if (!q || q.trim().length < 2) { setSuggestions([]); return; }
    const text = q.trim();
    const [lng, lat] = getCenter();

    const typeList = 'poi,address,place,neighborhood,locality,region,postcode,country';
    const endpoint = (t) => `${MAPBOX_GEOCODE}/${encodeURIComponent(text)}.json`;

    function padBBox(b) {
      const west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth();
      const cx = (west + east) / 2, cy = (south + north) / 2;
      const dx = (east - west), dy = (north - south);
      const padX = dx, padY = dy; // 2x box
      return [cx - (dx/2 + padX/2), cy - (dy/2 + padY/2), cx + (dx/2 + padX/2), cy + (dy/2 + padY/2)];
    }

    async function geocodeRequest({ bbox=true, types=true, proximity=true }){
      const url = new URL(endpoint(text));
      url.searchParams.set('limit', '10');
      url.searchParams.set('language', 'en');
      if (proximity) url.searchParams.set('proximity', `${lng},${lat}`);
      if (bbox){
        try {
          const map = window.__ss_map;
          if (map) {
            const b = map.getBounds();
            const [w,s,e,n] = padBBox(b);
            url.searchParams.set('bbox', `${w},${s},${e},${n}`);
          }
        } catch {}
      }
      if (types) url.searchParams.set('types', typeList);
      url.searchParams.set('autocomplete', 'true');
      url.searchParams.set('access_token', token);
      const res = await fetch(url.toString());
      return res.json();
    }

    function collectVisibleLabels(queryText){
      const q = queryText.toLowerCase();
      try {
        const map = window.__ss_map;
        if (!map) return [];
        const layers = ['poi-label','place-label','settlement-label','neighborhood-label','airport-label'];
        const feats = map.queryRenderedFeatures({ layers }).filter(f => !!f.properties);
        const items = [];
        const seen = new Set();
        for (const f of feats){
          const name = f.properties.name_en || f.properties.name || f.properties['name:en'] || f.properties.label || f.properties.text;
          if (!name) continue;
          if (!name.toLowerCase().includes(q)) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          const g = f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : (f.center || null);
          if (!g) continue;
          items.push({ id: 'local-' + name, name, full: name, coords: g, source: 'local' });
        }
        return items;
      } catch { return []; }
    }

    try {
      // 0) visible on-map labels that match the text
      const local = collectVisibleLabels(text);

      // 1) bbox+proximity+types
      let json = await geocodeRequest({ bbox:true, types:true, proximity:true });
      let feats = json?.features || [];

      // 2) proximity+types (no bbox)
      if (!feats.length) { json = await geocodeRequest({ bbox:false, types:true, proximity:true }); feats = json?.features || []; }

      // 3) global+types
      if (!feats.length) { json = await geocodeRequest({ bbox:false, types:true, proximity:false }); feats = json?.features || []; }

      // 4) global no types
      if (!feats.length) { json = await geocodeRequest({ bbox:false, types:false, proximity:false }); feats = json?.features || []; }

      const geocoderItems = [];
      const seen = new Set();
      for (const f of feats){
        const coords = f.center || f.geometry?.coordinates;
        const name = f.text || f.properties?.name || 'Untitled';
        const full = f.place_name || f.properties?.full_address || name;
        if (!coords) continue;
        const key = `${name}|${full}|${coords[0]},${coords[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        geocoderItems.push({ id: f.id, name, full, coords, source: 'geocoder', fType: (f.place_type&&f.place_type[0]) || 'other' });
      }

      // Merge local + geocoder and rank: local first, then POIs/addresses, then by proximity
      const [cx, cy] = [lng, lat];
      const weight = (item) => {
        if (item.source === 'local') return -1;
        switch (item.fType){
          case 'poi': return 0;
          case 'address': return 1;
          case 'place': return 2;
          case 'neighborhood': return 3;
          case 'locality': return 4;
          case 'region': return 5;
          case 'postcode': return 6;
          case 'country': return 7;
          default: return 8;
        }
      };

      const merged = [...local, ...geocoderItems];
      // de-dupe by (name + near-same coord)
      const final = [];
      const dupe = new Set();
      for (const it of merged){
        const k = `${it.name}|${Math.round((it.coords[0]||0)*1e5)}|${Math.round((it.coords[1]||0)*1e5)}`;
        if (dupe.has(k)) continue;
        dupe.add(k);
        final.push(it);
      }
      final.sort((a,b)=>{
        const wt = weight(a) - weight(b);
        if (wt !== 0) return wt;
        const ax = (a.coords[0]-cx), ay = (a.coords[1]-cy);
        const bx = (b.coords[0]-cx), by = (b.coords[1]-cy);
        return (ax*ax+ay*ay) - (bx*bx+by*by);
      });

      setSuggestions(final.slice(0, 10));
    } catch (e) {
      console.error(e);
      setSuggestions([]);
    }
  }; // end fetchSuggestions}; // end fetchSuggestions}; // end fetchSuggestions

  const debouncedFetch = useRef(debounce(fetchSuggestions, 250)).current

  useEffect(()=>{ debouncedFetch(query) }, [query])

  const pickSuggestion = async (sug) => {
    setQuery(sug.name)
    setSuggestions([])
    setRecents(prev => [sug, ...prev.slice(0,7)])

    let routes
    try {
      if (backendUrl){
        const res = await fetch(backendUrl + '/route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destination: { lng: sug.coords[0], lat: sug.coords[1] } })
        })
        routes = await res.json()
      } else {
        throw new Error('No backend configured')
      }
    } catch (e){
      const origin = [-73.985130, 40.758896]
      const dest = sug.coords
      const mk = (offset=0) => ({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [origin, [(origin[0]+dest[0])/2+offset*0.01, (origin[1]+dest[1])/2], dest] }
        }]
      })
      routes = { fastest: mk(0.02), safest: mk(-0.02), weighted: mk(0) }
    }

    window.dispatchEvent(new CustomEvent('app:draw-routes', { detail: routes }))
  }

  return (
    <aside className="sidebar">
      <div className="search-wrap">
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 21l-4.3-4.3"/><circle cx="11" cy="11" r="7"/></svg>
        <input className="input" placeholder="Search places" value={query} onChange={e=>setQuery(e.target.value)} />
        {suggestions.length>0 && (
          <div className="suggestions">
            {suggestions.map(s => (
              <div className="suggestion" key={s.id} onClick={()=>pickSuggestion(s)}>
                <div className="sugg-title">{s.name}</div>
                <div className="sugg-sub">{s.full}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="section-title">Saved</div>
        <div className="list">
          <div className="list-item"><span className="badge">Home</span> 123 Main St</div>
          <div className="list-item"><span className="badge">Work</span> 1 Liberty Plaza</div>
        </div>
      </div>

      <div>
        <div className="section-title">Recents</div>
        <div className="list">
          {recents.length===0 && <div className="list-item" style={{opacity:.7}}>No recent searches</div>}
          {recents.map((r,i)=>(
            <div className="list-item" key={r.id + i}>{r.full || r.name}</div>
          ))}
        </div>
      </div>

      <div className="chatbox">
        <div className="section-title">Assistant</div>
        <input className="chat-input" placeholder="Ask AI about safer routes…" />
      </div>
    </aside>
  )
}
