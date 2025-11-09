import React, { useEffect, useState } from 'react'
export default function WeatherBadge(){
  const [temp, setTemp] = useState(7)
  const [icon] = useState('☁️')
  useEffect(()=>{ setTemp(7) },[])
  return (
    <div className="weather">
      <div style={{fontSize: 22}}>{icon}</div>
      <div style={{lineHeight: 1.1}}>
        <div style={{fontWeight:700}}>NYC</div>
        <div style={{fontSize:12, opacity:.8}}>{temp}°C</div>
      </div>
    </div>
  )
}
