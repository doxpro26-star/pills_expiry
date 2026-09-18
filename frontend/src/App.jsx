import { useState, useEffect, useCallback } from 'react'
import {
  smartCollectEsp32, collectUpload, smartIdentifyEsp32, identifyUpload,
  getHealth, reloadModel, proxyStreamUrl, esp32StreamHttpUrl,
  getEsp32Ip, setEsp32Ip, checkEsp32Status, isHttps, isCloudDeployment, getEsp32Base
} from './api'
import CollectPanel from './components/CollectPanel'
import IdentifyPanel from './components/IdentifyPanel'
import StatusPanel from './components/StatusPanel'
import TrainPanel from './components/TrainPanel'

function App() {
  const [health, setHealth] = useState(null)
  const [streamUrl, setStreamUrl] = useState('')
  const [streamError, setStreamError] = useState(false)
  const [esp32Status, setEsp32Status] = useState(null)
  const [esp32IpEdit, setEsp32IpEdit] = useState(getEsp32Ip())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetchHealth = useCallback(async () => {
    try {
      const data = await getHealth()
      setHealth(data)
    } catch (e) {
      // ignore - backend might not be reachable
    }
  }, [])

  const checkEsp32 = useCallback(async () => {
    const s = await checkEsp32Status()
    setEsp32Status(s)
    return s
  }, [])

  useEffect(() => {
    fetchHealth()
    checkEsp32()
    const interval = setInterval(fetchHealth, 5000)
    const espInterval = setInterval(checkEsp32, 8000)
    return () => { clearInterval(interval); clearInterval(espInterval) }
  }, [fetchHealth, checkEsp32])

  // Initialize stream: try direct ESP32 http first, fallback to proxy
  useEffect(() => {
    // Direct http stream is preferred when browser can reach ESP32
    // On HTTPS cloud sites, http stream will be blocked -> use proxy
    if (isHttps()) {
      setStreamUrl(proxyStreamUrl())
    } else {
      setStreamUrl(esp32StreamHttpUrl())
    }
  }, [])

  const handleIdentify = async (mode, file) => {
    setLoading(true); setError('')
    try {
      const result = mode === 'esp32' ? await smartIdentifyEsp32() : await identifyUpload(file)
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
        return await smartCollectEsp32(data.tablet, data.expiry)
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

  const handleSaveEsp32Ip = () => {
    const ip = esp32IpEdit.trim().replace(/^https?:\/\//,'').replace(/\/.*$/,'')
    if (ip) { setEsp32Ip(ip); setEsp32IpEdit(ip); setEsp32Status(null); checkEsp32(); setStreamUrl(`http://${ip}/stream`); setStreamError(false) }
  }

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h2>💊 Tablet + Expiry Predictor</h2>

      {/* ESP32 Connection Banner */}
      <div style={{
        background: esp32Status?.online ? '#0f3d1a' : isHttps() ? '#422006' : '#1e293b',
        border: `1px solid ${esp32Status?.online ? '#16a34a' : isHttps() ? '#d97706' : '#334155'}`,
        borderRadius: 8, padding: '10px 14px', marginBottom: 12, textAlign:'left', fontSize:13, lineHeight:1.5
      }}>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',justifyContent:'space-between'}}>
          <span>
            {esp32Status?.online ? '🟢' : esp32Status === null ? '🟡' : '🔴'} ESP32: {esp32Status?.online ? `Online at ${esp32Status.base}` : esp32Status ? `Offline (${esp32Status.error})` : 'Checking...'}
            {esp32Status?.httpsBlocked && !esp32Status?.online && <span style={{color:'#fbbf24'}}> — HTTPS blocks HTTP to local IP</span>}
          </span>
          <button className="btn secondary" style={{padding:'4px 10px',fontSize:12}} onClick={checkEsp32}>↻ Test ESP32</button>
        </div>
        {isHttps() && (
          <div style={{marginTop:6,color:'#fbbf24',fontSize:11}}>
            ⚠️ Cloud site is HTTPS, ESP32 is HTTP (http://{getEsp32Ip()}). Browsers block mixed content. → Allow insecure content in address bar (🔒 icon → Site settings → Insecure content: Allow) OR use Upload buttons OR run backend locally on http://localhost:5000
          </div>
        )}
        {!esp32Status?.online && (
          <div style={{marginTop:4,color:'#94a3b8',fontSize:11}}>
            Connect to WiFi <code>ESP32-CAM_AP</code> (pass: 12345678) then test again. Direct: <a href={getEsp32Base()+"/status"} target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>http://{getEsp32Ip()}/status</a>
          </div>
        )}
        <div style={{display:'flex',gap:6,marginTop:8,alignItems:'center',flexWrap:'wrap'}}>
          <input value={esp32IpEdit} onChange={e=>setEsp32IpEdit(e.target.value)} placeholder="192.168.4.1" style={{maxWidth:160,padding:'6px 8px',fontSize:12}} />
          <button className="btn secondary" style={{padding:'6px 12px',fontSize:12}} onClick={handleSaveEsp32Ip}>Save IP</button>
          <span className="small" style={{fontSize:10}}>Current: {getEsp32Base()}</span>
        </div>
      </div>
      
      {/* Stream */}
      <div style={{ textAlign: 'center', marginBottom: '16px' }}>
        {!streamError ? (
          <img 
            src={streamUrl} 
            alt="ESP32 Stream" 
            className="stream-img"
            onError={() => {
              // Fallback chain: if direct fails, try proxy; if proxy fails, show error
              if (streamUrl === esp32StreamHttpUrl() && !isHttps()) {
                setStreamUrl(proxyStreamUrl())
              } else if (streamUrl === proxyStreamUrl() && !isHttps()) {
                setStreamUrl(esp32StreamHttpUrl())
              } else {
                setStreamError(true)
              }
            }}
          />
        ) : (
          <div style={{background:'#000',borderRadius:10,padding:40,color:'#94a3b8',minHeight:200,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:8}}>
            <div>📷 Stream unavailable</div>
            <div className="small" style={{maxWidth:400}}>
              {isHttps() ? 'HTTPS blocks HTTP stream to ESP32. Allow insecure content or view stream at' : 'Connect to ESP32-CAM_AP WiFi and view stream at'} <a href={esp32StreamHttpUrl()} target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>{esp32StreamHttpUrl()}</a>
              <br/>Proxy: <a href={proxyStreamUrl()} target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>{proxyStreamUrl()}</a> (works only if backend is local)
            </div>
            <button className="btn secondary" style={{marginTop:8}} onClick={()=>{setStreamError(false); setStreamUrl(esp32StreamHttpUrl())}}>Retry Direct</button>
            <button className="btn secondary" onClick={()=>{setStreamError(false); setStreamUrl(proxyStreamUrl())}}>Try Proxy</button>
          </div>
        )}
        <p className="small">Live stream from ESP32-CAM (connect to ESP32-CAM_AP WiFi) — Direct: {esp32StreamHttpUrl()} | Proxy: {proxyStreamUrl()}</p>
        <div className="row" style={{justifyContent:'center'}}>
          <button className="btn secondary" style={{fontSize:12,padding:'6px 10px'}} onClick={()=>{setStreamError(false); setStreamUrl(esp32StreamHttpUrl())}}>Direct Stream</button>
          <button className="btn secondary" style={{fontSize:12,padding:'6px 10px'}} onClick={()=>{setStreamError(false); setStreamUrl(proxyStreamUrl())}}>Proxy Stream</button>
          <a className="btn secondary" style={{fontSize:12,padding:'6px 10px',textDecoration:'none'}} href={esp32StreamHttpUrl()} target="_blank" rel="noreferrer">Open ESP32 Stream</a>
        </div>
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