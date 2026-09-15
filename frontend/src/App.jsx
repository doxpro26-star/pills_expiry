import { useState, useEffect, useCallback } from 'react'
import {
  collectEsp32, collectUpload, identifyEsp32, identifyUpload,
  getHealth, reloadModel, esp32Stream
} from './api'
import CollectPanel from './components/CollectPanel'
import IdentifyPanel from './components/IdentifyPanel'
import StatusPanel from './components/StatusPanel'
import TrainPanel from './components/TrainPanel'

function App() {
  const [health, setHealth] = useState(null)
  const [streamUrl, setStreamUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetchHealth = useCallback(async () => {
    try {
      const data = await getHealth()
      setHealth(data)
      if (!streamUrl && data.esp32) {
        setStreamUrl(`${data.esp32}/stream`) // direct if on same network
      }
    } catch (e) {
      // ignore - backend might not be reachable
    }
  }, [streamUrl])

  useEffect(() => {
    fetchHealth()
    const interval = setInterval(fetchHealth, 5000)
    return () => clearInterval(interval)
  }, [fetchHealth])

  const handleIdentify = async (mode, file) => {
    setLoading(true); setError('')
    try {
      const result = mode === 'esp32' ? await identifyEsp32() : await identifyUpload(file)
      return result
    } catch (e) {
      setError(e.message)
      throw e
    } finally {
      setLoading(false)
    }
  }

  const handleCollect = async (mode, data, file) => {
    setLoading(true); setError('')
    try {
      if (mode === 'esp32') {
        return await collectEsp32(data.tablet, data.expiry)
      } else {
        return await collectUpload(file, data.tablet, data.expiry)
      }
    } catch (e) {
      setError(e.message)
      throw e
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h2>💊 Tablet + Expiry Predictor</h2>
      
      {/* Stream */}
      <div style={{ textAlign: 'center', marginBottom: '16px' }}>
        <img 
          src={streamUrl || esp32Stream()} 
          alt="ESP32 Stream" 
          className="stream-img"
          onError={(e) => { e.target.src = esp32Stream(); }}
        />
        <p className="small">Live stream from ESP32-CAM (connect to ESP32-CAM_AP WiFi)</p>
      </div>

      {/* Status */}
      <StatusPanel health={health} onReload={reloadModel} />

      {/* Collect */}
      <CollectPanel onCollect={handleCollect} loading={loading} error={error} />

      {/* Train info */}
      <TrainPanel health={health} />

      {/* Identify */}
      <IdentifyPanel onIdentify={handleIdentify} loading={loading} error={error} />
    </div>
  )
}

export default App