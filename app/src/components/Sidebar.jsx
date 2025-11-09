import React, { useEffect, useRef, useState } from 'react'
import debounce from 'lodash.debounce'

// Mapbox Geocoding v5 (supports POIs)
const MAPBOX_GEOCODE = 'https://api.mapbox.com/geocoding/v5/mapbox.places'
const FALLBACK_CENTER = [-73.985130, 40.758896] // Times Square

// Helper to map backend sender (0/1) to frontend role ('user'/'assistant')
const getRole = (sender) => (sender === 0 ? 'user' : 'assistant')

export default function Sidebar() {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [recents, setRecents] = useState([])

  const inputRef = useRef(null)
  const suppressRef = useRef(false)
  const messagesEndRef = useRef(null) // for auto-scrolling

  const [chatOpen, setChatOpen] = useState(true) // Default open for immediate use
  const [chatInput, setChatInput] = useState('')
  // chatMessages stores objects with keys: role ('user'/'assistant'), text, and id
  const [chatMessages, setChatMessages] = useState([])
  const [isSending, setIsSending] = useState(false) // to disable button while waiting

  const token = import.meta.env.VITE_MAPBOX_TOKEN || 'YOUR_MAPBOX_TOKEN_HERE'
  const backendUrl = import.meta.env.VITE_BACKEND_URL || ''

  // 🚩 TEMP FLAG: Replace this with your actual state/prop for Hackopoly Mode
  const HACKOPOLY_MODE_ACTIVE = false;
  // If set to 'true', assistant bubbles will be white/black. If 'false', they'll be grey/white.

  // --- Utility Functions ---

  /**
   * Converts simple Markdown (bold, lists) to a clean HTML string.
   */
  const convertMarkdownToHtml = (markdown) => {
    if (!markdown) return '';

    // 1. Convert bold (**text**) to <strong>text</strong>
    let html = markdown.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // 2. Convert * list items (when followed by a space) to bullet points (•)
    html = html.replace(/(\n|^)\*\s/g, '<br/>&bull; ');

    // 3. Convert explicit newlines (\n) not part of a list structure to <br>
    html = html.replace(/\n/g, '<br/>');

    // 4. Clean up any leading <br/>
    if (html.startsWith('<br/>')) {
        html = html.substring(5);
    }

    return html;
  }

  // Component to safely render the converted text
  const MarkdownText = ({ text }) => {
    const htmlContent = convertMarkdownToHtml(text);
    return (
        <span dangerouslySetInnerHTML={{ __html: htmlContent }} />
    );
  }

  const getCenter = () => {
    try {
      const map = window.__ss_map
      if (map) { const c = map.getCenter(); return [c.lng, c.lat] }
    } catch {}
    return FALLBACK_CENTER
  }


  // --- Chat History Logic ---

  const fetchChatHistory = async () => {
    if (!backendUrl) return;
    try {
      const res = await fetch(backendUrl + '/api/chat');
      if (!res.ok) throw new Error('Failed to fetch chat history');
      const data = await res.json();

      // FIX: Backend model uses 'message', map it to 'text' for frontend state
      setChatMessages(data.map(m => ({
        role: getRole(m.sender),
        text: m.message, // CRITICAL: Use m.message
        id: m.id
      })));

    } catch (e) {
      console.error('Error fetching chat history:', e);
      if (!chatMessages.some(m => m.role === 'system')) {
        setChatMessages(prev => [...prev, { role: 'system', text: "Error loading chat history or backend is offline.", id: Date.now() }]);
      }
    }
  }

  // 1. Initial Load: Fetch history
  useEffect(() => {
    fetchChatHistory();
  }, []);

  // 2. Scroll to bottom when messages change
  useEffect(() => {
    if (chatOpen) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    }
  }, [chatMessages, chatOpen]);


  // --- handleSend Logic ---

  const handleSend = async () => {
    const text = (chatInput || '').trim();
    if (!text || isSending) return;

    setIsSending(true);
    setChatInput('');

    // 1. Locally add the user message immediately for a snappy UI
    const tempMessage = { role: 'user', text, temp: true, id: Date.now() };
    setChatMessages(prev => [...prev, tempMessage]);

    // 2. Post message to the backend
    try {
      const res = await fetch(backendUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });

      if (!res.ok) {
        throw new Error('Chat API failed to process message. Status: ' + res.status);
      }

      // 3. On success, fetch the full history to get the persisted messages
      await fetchChatHistory();

    } catch (e) {
      console.error('Error sending message:', e);
      // 4. On failure, replace the temporary user message with an assistant error
      setChatMessages(prev => {
          const newMessages = prev.filter(m => m.id !== tempMessage.id);
          return [...newMessages, { role: 'assistant', text: `Sorry, I ran into an error: ${e.message}`, id: Date.now() }];
      });
    } finally {
      setIsSending(false);
    }
  };


  // --- Existing Search Logic (Omitted for brevity, assumed unchanged) ---

  const fetchSuggestions = async (q) => {
    if (suppressRef.current) {
      setSuggestions([]);
      try{ inputRef.current && inputRef.current.blur(); }catch(_){};
      return;
    }

    if (!q || q.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    const text = q.trim();
    const [lng, lat] = getCenter();

    const typeList = 'poi,poi.landmark,address,neighborhood,locality,place,region,postcode';
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
      const local = collectVisibleLabels(text);

      let json = await geocodeRequest({ bbox:true, types:true, proximity:true });
      let feats = json?.features || [];

      if (!feats.length) { json = await geocodeRequest({ bbox:false, types:true, proximity:true }); feats = json?.features || []; }
      if (!feats.length) { json = await geocodeRequest({ bbox:false, types:true, proximity:false }); feats = json?.features || []; }
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

      const [cx, cy] = [lng, lat];

      const merged = [...local, ...geocoderItems];
      const final = [];
      const dupe = new Set();
      for (const it of merged){
        const k = `${it.name}|${Math.round((it.coords[0]||0)*1e5)}|${Math.round((it.coords[1]||0)*1e5)}`;
        if (dupe.has(k)) continue;
        dupe.add(k);
        final.push(it);
      }

      function weight(item){
        const t = item.types || item.place_type || [];
        let w = 10;
        if (t && t.indexOf('poi')>=0) w = Math.min(w, 1);
        if (t && t.indexOf('neighborhood')>=0) w = Math.min(w, 2);
        if (t && t.indexOf('locality')>=0) w = Math.min(w, 3);
        if (t && t.indexOf('place')>=0) w = Math.min(w, 4);
        if ((item.id || '').startsWith('poi.landmark')) w = 0;
        return w;
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
  };
  const debouncedFetch = useRef(debounce(fetchSuggestions, 250)).current
  useEffect(()=>{ debouncedFetch(query) }, [query])

  const pickSuggestion = async (sug) => {
    suppressRef.current = true
    setQuery(sug.name)
    setSuggestions([]);

    try{ inputRef.current && inputRef.current.blur(); }catch(_){}

    setRecents(prev => [sug, ...prev.slice(0,7)])

    const [destLon, destLat] = sug.coords;
    const [originLon, originLat] = FALLBACK_CENTER;

    try {
      window.dispatchEvent(new CustomEvent('app:set-destination', { detail: { lng: destLon, lat: destLat } }));
      window.dispatchEvent(new CustomEvent('app:fit-route-points', {
        detail: {
          origin: { lng: originLon, lat: originLat },
          destination: { lng: destLon, lat: destLat }
        }
      }));

    } catch (e) {
      console.error('Failed to dispatch map events', e);
    }

    const fromCoords = FALLBACK_CENTER;
    const toCoords = [destLon, destLat];

    let routes
    try {
      if (backendUrl){
        const res = await fetch(backendUrl + '/route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: fromCoords, to: toCoords })
        })
        routes = await res.json()
      } else {
        throw new Error('No backend configured')
      }
    } catch (e){
      const origin = fromCoords;
      const dest = toCoords;
      const mockPath = [
          [origin[1], origin[0]],
          [(origin[1]+dest[1])/2, (origin[0]+dest[0])/2],
          [dest[1], dest[0]]
      ];
      routes = { shortest_path: mockPath, safest_path: mockPath, weighted_path: mockPath }
      console.warn('Backend route request failed, using mock data in backend format:', e.message);
    }

    if (window.__drawRoutesFromBackend){
        window.__drawRoutesFromBackend(routes);
    } else {
        console.error('Map drawing function not ready. Data:', routes);
    }
  }


  // --- Render ---

  return (
    <aside className="sidebar">
      <div className="search-wrap">
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 21l-4.3-4.3"/><circle cx="11" cy="11" r="7"/></svg>
        <input
          className="input"
          placeholder="Search places"
          ref={inputRef}
          value={query}
          onChange={e=>{suppressRef.current=false; setQuery(e.target.value);}}
          onKeyDown={e => {
            if (e.key === ' ') e.stopPropagation();
          }}
        />
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

      <div className={"chatbox" + (chatOpen ? " open" : "")}
           style={{display:'flex', flexDirection:'column', maxHeight: chatOpen ? 360 : 88,
                   transition:'max-height .25s ease', overflow:'hidden'}}
           onClick={() => setChatOpen(true)} // Always open chat on click if not already open
      >
        <div className="section-title" style={{marginBottom: chatOpen ? 0 : 4}}>Assistant</div>
        {chatOpen && (
          <div className="chat-messages" style={{flex:1, minHeight: chatOpen ? 140 : 0, maxHeight: 260, overflowY:'auto', marginTop:8, borderRadius:10, border:'1px solid #ffffff22', padding:8}}>
            {chatMessages.length === 0 && <div style={{opacity:.6, fontSize:12}}>Start the conversation…</div>}
            {chatMessages.map((m, i) => {
                const isAssistant = m.role === 'assistant';
                const isSystem = m.role === 'system';

                let bgColor, textColor, borderColor;

                if (m.role === 'user') {
                    // User Style
                    bgColor = '#3b82f6';
                    textColor = '#fff';
                    borderColor = 'none';
                } else if (isSystem) {
                    // System Style (Error/Info)
                    bgColor = '#ef4444';
                    textColor = '#fff';
                    borderColor = 'none';
                } else if (isAssistant) {
                    if (HACKOPOLY_MODE_ACTIVE) {
                        // Hackopoly Style (White/Black)
                        bgColor = '#fff';
                        textColor = '#000';
                        borderColor = '1px solid #000';
                    } else {
                        // Normal Style (Solid Grey/White Text)
                        // This uses a solid grey (like a darker zinc or neutral-700)
                        bgColor = '#3f3f46';
                        textColor = '#e5e7eb';
                        borderColor = '1px solid rgba(255,255,255,0.18)';
                    }
                }

                return (
                  <div key={m.id || i} style={{display:'flex', justifyContent: m.role==='user'?'flex-end':'flex-start', margin:'6px 0'}}>
                    <div style={{
                        maxWidth:'85%', padding:'8px 12px', borderRadius:16, fontSize:13, lineHeight:1.35,
                        background: bgColor,
                        color: textColor,
                        border: borderColor,
                        opacity: m.temp ? 0.7 : 1
                    }}>
                      <MarkdownText text={m.text} />
                    </div>
                  </div>
                );
            })}
            <div ref={messagesEndRef} />
            {isSending && (
                <div style={{margin:'6px 0', opacity: 0.8, fontSize:13, color:'rgba(255,255,255,0.7)'}}>
                    <span role="img" aria-label="thinking">... Thinking</span>
                </div>
            )}
          </div>
        )}
        <div className="chat-input-row" style={{display:'flex', gap:8, paddingRight:2, paddingBottom: 0, marginTop: chatOpen ? 8 : 4}}>
          <input
            className="chat-input"
            placeholder={isSending ? "Waiting for response..." : "Ask AI about safer routes…"}
            value={chatInput}
            onChange={e=>setChatInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter' && !isSending){ e.preventDefault(); handleSend(); } }}
            disabled={isSending}
            style={{flex:1, marginTop: 2, marginBottom: 2}}
          />
          <button
            className="chat-send"
            aria-label="Send"
            onClick={handleSend}
            disabled={isSending || !chatInput.trim()}
            style={{
                display:'inline-flex', alignItems:'center', justifyContent:'center', width:42, height:42, borderRadius:12,
                border:'1px solid rgba(255,255,255,0.25)', background: isSending ? '#60a5fa' : '#3b82f6',
                boxShadow:'0 2px 8px rgba(0,0,0,0.35)', cursor: isSending ? 'not-allowed' : 'pointer'
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2L11 13"></path>
              <path d="M22 2l-7 20-4-9-9-4 20-7z"></path>
            </svg>
          </button>
        </div>
      </div>
    </aside>
  )
}