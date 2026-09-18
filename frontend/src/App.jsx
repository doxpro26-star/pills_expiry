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
  const [streamOk, setStreamOk] = useState(false)
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

  // Initialize stream: always try direct ESP32 http first (passive mixed content may still load on HTTPS), fallback to proxy
  useEffect(() => {
    // Direct http stream works when on ESP32-CAM_AP; even on HTTPS, <img> passive content may load if browser allows
    setStreamUrl(esp32StreamHttpUrl())
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
    if (ip) { setEsp32Ip(ip); setEsp32IpEdit(ip); setEsp32Status(null); setStreamOk(false); checkEsp32(); setStreamUrl(`http://${ip}/stream`); setStreamError(false) }
  }

  // Derived ESP32 banner state: stream image loading proves ESP32 reachable even when JS fetch blocked by HTTPS
  const isEspFetchOnline = esp32Status?.online && esp32Status?.via !== 'image'
  const isEspStreamOnline = streamOk || esp32Status?.via === 'image' || esp32Status?.streamWorks
  const isEspOnline = esp32Status?.online

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h2>💊 Tablet + Expiry Predictor</h2>

      {/* ESP32 Connection Banner */}
      <div style={{
        background: isEspOnline ? '#0f3d1a' : isEspStreamOnline ? '#422006' : isHttps() ? '#422006' : '#1e293b',
        border: `1px solid ${isEspOnline ? '#16a34a' : isEspStreamOnline ? '#d97706' : isHttps() ? '#d97706' : '#334155'}`,
        borderRadius: 8, padding: '10px 14px', marginBottom: 12, textAlign:'left', fontSize:13, lineHeight:1.5
      }}>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',justifyContent:'space-between'}}>
          <span>
            {isEspOnline ? '🟢' : isEspStreamOnline ? '🟡' : esp32Status === null ? '🟡' : '🔴'} ESP32: {isEspOnline ? `Online at ${esp32Status.base} via ${esp32Status.via}` : isEspStreamOnline ? `Stream Online (JS fetch blocked by HTTPS)` : esp32Status ? `Offline (${esp32Status.error})` : 'Checking...'}
            {isEspStreamOnline && !isEspFetchOnline && <span style={{color:'#fbbf24'}}> — Stream image works, fetch needs insecure allow</span>}
          </span>
          <button className="btn secondary" style={{padding:'4px 10px',fontSize:12}} onClick={checkEsp32}>↻ Test ESP32</button>
        </div>
        {isEspOnline && esp32Status?.via === 'image' && (
          <div style={{marginTop:6,color:'#fde68a',fontSize:11}}>
            🟡 Stream image loads (passive mixed content) – JS fetch for Capture/Identify still blocked. To enable buttons: 🔒 icon → Site settings → Insecure content: Allow → Reload. Or use Upload buttons. Stream proves ESP32 is reachable.
          </div>
        )}
        {isEspStreamOnline && !isEspFetchOnline && esp32Status?.via !== 'image' && (
          <div style={{marginTop:6,color:'#fde68a',fontSize:11}}>
            🟡 Stream OK but status fetch failed – allow insecure content to make Capture buttons work.
          </div>
        )}
        {isHttps() && !isEspOnline && !isEspStreamOnline && (
          <div style={{marginTop:6,color:'#fbbf24',fontSize:11}}>
            ⚠️ Cloud site is HTTPS, ESP32 is HTTP (http://{getEsp32Ip()}). Browsers block mixed content. → Allow insecure content in address bar (🔒 icon → Site settings → Insecure content: Allow) OR use Upload buttons OR run backend locally on http://localhost:5000
          </div>
        )}
        {!isEspOnline && (
          <div style={{marginTop:4,color:'#94a3b8',fontSize:11}}>
            {isEspStreamOnline ? '✅ Stream works! ' : ''}Connect to WiFi <code>ESP32-CAM_AP</code> (pass: 12345678) then test again. Direct: <a href={getEsp32Base()+"/status"} target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>http://{getEsp32Ip()}/status</a> | <a href={getEsp32Base()+"/capture"} target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>/capture</a>
            {esp32Status?.sta_ip && <span> | STA: <a href={`http://${esp32Status.sta_ip}/status`} target="_blank" rel="noreferrer" style={{color:'#4ade80'}}>http://{esp32Status.sta_ip}</a> <button className="btn secondary" style={{padding:'2px 6px',fontSize:10}} onClick={()=>{setEsp32IpEdit(esp32Status.sta_ip); setEsp32Ip(esp32Status.sta_ip); setStreamUrl(`http://${esp32Status.sta_ip}/stream`); setStreamError(false);}}>Use STA IP</button></span>}
          </div>
        )}
        {esp32Status?.sta_connected && esp32Status?.sta_ip && (
          <div style={{marginTop:6,background:'#0f3d1a',padding:6,borderRadius:4,fontSize:11,color:'#4ade80'}}>
            ✅ STA Connected: <b>http://{esp32Status.sta_ip}</b> (mDNS: http://esp32cam.local) – <b>NO hotspot switching needed!</b> Your phone + ESP32 on same home WiFi (internet OK). Click Use STA IP above or Save IP manually. <a href={`http://${esp32Status.sta_ip}/wifi`} target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>WiFi Setup</a>
          </div>
        )}
        {!esp32Status?.sta_connected && (
          <div style={{marginTop:6,background:'#1e293b',padding:6,borderRadius:4,fontSize:11,color:'#fbbf24'}}>
            💡 <b>Remove hotspot switching:</b> Connect phone to <code>ESP32-CAM_AP</code> → open <a href="http://192.168.4.1/wifi" target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>http://192.168.4.1/wifi</a> → enter your home WiFi SSID/pass → ESP32 reboots and joins home WiFi → then website auto-connects via STA IP (no AP switch, internet stays).
          </div>
        )}
        <div style={{display:'flex',gap:6,marginTop:8,alignItems:'center',flexWrap:'wrap'}}>
          <input value={esp32IpEdit} onChange={e=>setEsp32IpEdit(e.target.value)} placeholder="192.168.4.1 or esp32cam.local" style={{maxWidth:180,padding:'6px 8px',fontSize:12}} />
          <button className="btn secondary" style={{padding:'6px 12px',fontSize:12}} onClick={handleSaveEsp32Ip}>Save IP</button>
          <a className="btn secondary" href="http://192.168.4.1/wifi" target="_blank" rel="noreferrer" style={{padding:'6px 10px',fontSize:11,textDecoration:'none'}}>📶 WiFi Setup</a>
          <span className="small" style={{fontSize:10}}>Current: {getEsp32Base()} {isEspStreamOnline ? '| Stream OK' : ''} {isHttps() ? '| HTTPS' : '| HTTP'} {esp32Status?.sta_ip ? '| STA:'+esp32Status.sta_ip : ''}</span>
        </div>
      </div>
      
      {/* Stream */}
      <div style={{ textAlign: 'center', marginBottom: '16px' }}>
        {!streamError ? (
          <img 
            src={streamUrl} 
            alt="ESP32 Stream" 
            className="stream-img"
            onLoad={() => setStreamOk(true)}
            onError={() => {
              // Fallback chain: direct http -> proxy https -> error
              if (streamUrl === esp32StreamHttpUrl()) {
                setStreamUrl(proxyStreamUrl())
              } else if (streamUrl === proxyStreamUrl()) {
                setStreamError(true)
              } else {
                setStreamError(true)
              }
              setStreamOk(false)
            }}
          />
        ) : (
          <div style={{background:'#000',borderRadius:10,padding:40,color:'#94a3b8',minHeight:300,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:10}}>
            <div>📷 Stream unavailable</div>
            <div className="small" style={{maxWidth:520,lineHeight:1.6,textAlign:'left',background:'#1e293b',padding:12,borderRadius:8}}>
              {isHttps() ? (
                <>
                  <b style={{color:'#fbbf24'}}>HTTPS blocks HTTP stream to ESP32 (mixed content).</b><br/>
                  1) Connect to WiFi <code>ESP32-CAM_AP</code> (pass: 12345678) – you need internet + WiFi at same time (phone mobile data ON works).<br/>
                  2) Click <a href={esp32StreamHttpUrl()} target="_blank" rel="noreferrer" style={{color:'#7dd3fc',fontWeight:600}}>Open http://192.168.4.1/stream in new tab</a> – this <b>always works</b> (no mixed content in new http tab).<br/>
                  3) To make it work <b>embedded here</b>: click 🔒 icon in address bar → Site settings → <b>Insecure content: Allow</b> → Reload page → then <b>Retry Direct</b>.<br/>
                  4) Or use fully HTTP: run backend locally <code>python server/app.py</code> and open <code>http://localhost:5000</code> or <code>http://192.168.4.2:5000</code> – then no block.<br/>
                </>
              ) : (
                <>Connect to WiFi <code>ESP32-CAM_AP</code> then <a href={esp32StreamHttpUrl()} target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>{esp32StreamHttpUrl()}</a></>
              )}
              <br/><br/>Proxy: <a href={proxyStreamUrl()} target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>{proxyStreamUrl()}</a> (only works if backend is LOCAL on ESP32 WiFi, fails on Render cloud – expected).
            </div>
            <div className="row">
              <button className="btn secondary" style={{marginTop:4}} onClick={()=>{setStreamError(false); setStreamOk(false); setStreamUrl(esp32StreamHttpUrl())}}>Retry Direct</button>
              <button className="btn secondary" onClick={()=>{setStreamError(false); setStreamOk(false); setStreamUrl(proxyStreamUrl())}}>Try Proxy</button>
              <a className="btn primary" href={esp32StreamHttpUrl()} target="_blank" rel="noreferrer">Open Stream (http, no block)</a>
            </div>
          </div>
        )}
        <p className="small">Live stream from ESP32-CAM (connect to ESP32-CAM_AP WiFi) — Direct: {esp32StreamHttpUrl()} | Proxy: {proxyStreamUrl()} {streamOk ? '✅ Stream loaded' : ''}</p>
        <div className="row" style={{justifyContent:'center'}}>
          <button className="btn secondary" style={{fontSize:12,padding:'6px 10px'}} onClick={()=>{setStreamError(false); setStreamOk(false); setStreamUrl(esp32StreamHttpUrl())}}>Direct Stream</button>
          <button className="btn secondary" style={{fontSize:12,padding:'6px 10px'}} onClick={()=>{setStreamError(false); setStreamOk(false); setStreamUrl(proxyStreamUrl())}}>Proxy Stream</button>
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