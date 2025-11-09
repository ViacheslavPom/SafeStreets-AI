import React from 'react'
import { applyHackopolyUI, removeHackopolyUI } from '../hackopolyUI'

export default function TopRightControls(){
const emit = (name) => window.dispatchEvent(new CustomEvent(name))
  const toggleHeat = () => window.dispatchEvent(new CustomEvent('app:toggle-heat'))
  const switchStyle = () => {
    const next = (window.__mapStyleAlt = !window.__mapStyleAlt)
    const id = next ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/streets-v12'
    window.dispatchEvent(new CustomEvent('app:toggle-style', { detail: id }))
    // Toggle UI theme (separate from map code)
    if(next){ applyHackopolyUI(); } else { removeHackopolyUI(); }
  }

  return (
    <div className="top-right">
      <div className="avatar">SS</div>

      {/* Map controls column in reference order: Locate → Zoom group (+ −) → Compass */}
      <div className="stack-col">
        <div className="ctrl-group">
          <div className="ctrl-btn" title="Show my position" onClick={()=>emit('app:geolocate')}>📍</div>
        </div>

        <div className="ctrl-group">
          <div className="ctrl-btn" title="Zoom in" onClick={()=>emit('app:zoom-in')}>＋</div>
          <div className="ctrl-btn" title="Zoom out" onClick={()=>emit('app:zoom-out')}>－</div>
        </div>

        
      </div>

      <div className="ctrl-group">
        <div className="ctrl-btn" title="Heatmap" onClick={toggleHeat}>🔥</div>
        <div className="ctrl-btn" title="Hackopoly" onClick={switchStyle}>🎲</div>
      </div>
    </div>
  )
}
