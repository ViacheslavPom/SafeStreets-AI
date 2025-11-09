import React from 'react'
import MapView from './components/MapView'
import Sidebar from './components/Sidebar'
import TopRightControls from './components/TopRightControls'
import WeatherBadge from './components/WeatherBadge'

export default function App(){
  return (
    <div className="app">
      <MapView />
      <div id="ui-root">
        <Sidebar />
        <TopRightControls />
        <WeatherBadge />
      </div>
    </div>
  )
}
