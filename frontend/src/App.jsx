import { useState, useEffect, useCallback } from 'react'
import {
  smartCollectEsp32, collectUpload, smartIdentifyEsp32, identifyUpload,
  getHealth, reloadModel, proxyStreamUrl, esp32StreamHttpUrl,
  getEsp32Ip, setEsp32Ip, checkEsp32Status, isHttps, getEsp32Base
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
    try { const data = await getHealth(); setHealth(data) } catch {}
  }, [])

  const checkEsp32 = useCallback(async () => {
    const s = await checkEsp32Status(); setEsp32Status(s); return s
  }, [])

  useEffect(() => {
    fetchHealth(); checkEsp32()
    const i=setInterval(fetchHealth,5000); const e=setInterval(checkEsp32,8000)
    return ()=>{clearInterval(i); clearInterval(e)}
  }, [fetchHealth, checkEsp32])

  useEffect(()=>{ setStreamUrl(esp32StreamHttpUrl()) }, [])

  const handleIdentify = async (mode, file) => {
    setLoading(true); setError('')
    try { return mode==='esp32' ? await smartIdentifyEsp32() : await identifyUpload(file) }
    catch(e){ setError(e.message); throw e } finally{ setLoading(false) }
  }
  const handleCollect = async (mode, data, file) => {
    setLoading(true); setError('')
    try { return mode==='esp32' ? await smartCollectEsp32(data.tablet, data.expiry) : await collectUpload(file, data.tablet, data.expiry) }
    catch(e){ setError(e.message); throw e } finally{ setLoading(false) }
  }
  const handleSaveEsp32Ip = () => {
    const ip=esp32IpEdit.trim().replace(/^https?:\/\//,'').replace(/\/.*$/,'')
    if(ip){ setEsp32Ip(ip); setEsp32IpEdit(ip); setEsp32Status(null); setStreamOk(false); checkEsp32(); setStreamUrl(`http://${ip}/stream`); setStreamError(false) }
  }

  const isEspOnline = esp32Status?.online
  const isEspStreamOnline = streamOk || esp32Status?.via==='image' || esp32Status?.streamWorks
  const isEspFetchOnline = isEspOnline && esp32Status?.via!=='image'

  return (
    <div className="app-shell">
      {/* Header - humanic white */}
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            <div className="brand-mark">💊</div>
            <div>
              <h1>Tablet & Expiry — Studio</h1>
              <p>Handcrafted vision for pharmacists • ESP32-CAM + MobileNet</p>
            </div>
          </div>
          <div className="header-actions">
            <span style={{fontSize:'.75rem',color:'var(--muted)',display:'none'}} className="hide-mobile">Medical grade • on-device</span>
            <a href="http://192.168.4.1/wifi" target="_blank" rel="noreferrer" className="btn secondary" style={{fontSize:'.82rem',padding:'8px 14px'}}>📶 WiFi Setup</a>
          </div>
        </div>
      </header>

      <div style={{maxWidth:960, margin:'0 auto', padding:'18px 0 8px'}}>
        {/* Hero - humanic editorial */}
        <div className="hero">
          <div style={{flex:1,minWidth:260}}>
            <h2>Your tablet, its expiry — captured honestly.</h2>
            <p>Point the ESP32, collect 30–50 real photos per batch, train, then identify. No cloud magic, just your light and lens.</p>
          </div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <span className="banner banner-info" style={{padding:'6px 10px',fontSize:'.75rem',borderRadius:999}}>White studio • soft daylight</span>
            <span className="banner banner-neutral" style={{padding:'6px 10px',fontSize:'.75rem',borderRadius:999}}>Works offline on `ESP32-CAM_AP`</span>
          </div>
        </div>

        {/* ESP32 Banner - humanic white, not scary dark */}
        <div className={`banner ${isEspOnline ? 'banner-success' : isEspStreamOnline ? 'banner-warn' : isHttps() ? 'banner-warn' : 'banner-neutral'}`} style={{marginTop:14}}>
          <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',justifyContent:'space-between'}}>
            <div style={{display:'flex',gap:10,alignItems:'center'}}>
              <span style={{width:10,height:10,borderRadius:'50%',background:isEspOnline?'#0d9488':isEspStreamOnline?'#d97706':'#64748b',boxShadow:isEspOnline?'0 0 0 6px #ccfbf1':isEspStreamOnline?'0 0 0 6px #fef3c7':'none',flexShrink:0}} />
              <strong style={{fontFamily:'Plus Jakarta Sans',fontSize:'.88rem'}}>
                {isEspOnline ? `ESP32 live at ${esp32Status.base}` : isEspStreamOnline ? 'Stream live — capture needs permission' : esp32Status ? `${esp32Status.error}` : 'Looking for ESP32…'}
                <span style={{fontWeight:400,color:'var(--muted)',marginLeft:6}}>{isEspOnline ? `via ${esp32Status.via}` : ''}</span>
              </strong>
              {isEspStreamOnline && !isEspFetchOnline && <span style={{fontSize:'.75rem',color:'#92400e'}}>— image shows, button needs allow</span>}
            </div>
            <button className="btn secondary" style={{padding:'7px 12px',fontSize:'.82rem'}} onClick={checkEsp32}>↻ Test camera</button>
          </div>

          {isEspOnline && esp32Status?.via==='image' && (
            <div className="hint" style={{marginTop:10}}>Stream image proves reachability, but browser still blocks the <b>Capture</b> fetch. Tap <b>Allow insecure content</b> (🔒 → Site settings) and reload, or use <b>Phone Camera</b> below.</div>
          )}
          {isHttps() && !isEspOnline && !isEspStreamOnline && (
            <div style={{marginTop:8,fontSize:'.82rem',color:'#92400e'}}>Your site is <b>https</b>, ESP32 is <b>http</b>. Browsers gate this. Use <b>Phone Camera</b> or open <code>http://localhost:5000</code> for one-tap capture.</div>
          )}
          <div style={{marginTop:10,display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',fontSize:'.82rem'}}>
            <code style={{background:'#fff',border:'1px solid #e2e8f0',padding:'6px 10px',borderRadius:8}}>{getEsp32Base()}  {isEspStreamOnline?'· Stream OK':''} {isHttps()?'· https':''} {esp32Status?.sta_ip?`· STA ${esp32Status.sta_ip}`:''}</code>
            <a href={`${getEsp32Base()}/status`} target="_blank" rel="noreferrer" style={{fontSize:'.82rem'}}>status</a>
            <a href={`${getEsp32Base()}/capture`} target="_blank" rel="noreferrer" style={{fontSize:'.82rem'}}>capture</a>
            {esp32Status?.sta_ip && <><span>· STA: <a href={`http://${esp32Status.sta_ip}/status`} target="_blank" rel="noreferrer">{esp32Status.sta_ip}</a></span><button className="btn secondary" style={{padding:'4px 10px',fontSize:'.78rem'}} onClick={()=>{setEsp32IpEdit(esp32Status.sta_ip); setEsp32Ip(esp32Status.sta_ip); setStreamUrl(`http://${esp32Status.sta_ip}/stream`); setStreamError(false)}}>Use STA</button></>}
          </div>
          {esp32Status?.sta_connected && esp32Status?.sta_ip && (
            <div className="banner banner-success" style={{marginTop:10,fontSize:'.82rem'}}>✅ STA joined <b>http://{esp32Status.sta_ip}</b> (esp32cam.local) — phone + ESP32 on same home WiFi, <b>no hotspot switch</b>. Good light, internet stays.</div>
          )}
          {!esp32Status?.sta_connected && (
            <div style={{marginTop:8,fontSize:'.82rem',color:'var(--muted)'}}>Tip: to remove hotspot dance — connect to <code>ESP32-CAM_AP</code> → <a href="http://192.168.4.1/wifi" target="_blank" rel="noreferrer">wifi setup</a> → enter home WiFi → ESP32 reboots on home net.</div>
          )}
          <div style={{display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}}>
            <input value={esp32IpEdit} onChange={e=>setEsp32IpEdit(e.target.value)} placeholder="192.168.4.1 or esp32cam.local" style={{maxWidth:200}}/>
            <button className="btn secondary" onClick={handleSaveEsp32Ip}>Save</button>
            <span style={{fontSize:'.75rem',color:'var(--faint)',alignSelf:'center'}}>Try `esp32cam.local` if mDNS works</span>
          </div>
        </div>

        {/* Stream - white card */}
        <div className="stream-card" style={{marginTop:16}}>
          <div className="stream-head">
            <span className="pulse" /> Live studio — ESP32-CAM <span style={{marginLeft:'auto',color:'var(--faint)',textTransform:'none',letterSpacing:0,fontWeight:500,fontSize:'.78rem'}}>{isEspStreamOnline?'Live':'Idle'} · {getEsp32Base()}/stream</span>
          </div>
          {!streamError ? (
            <img src={streamUrl} alt="ESP32 Stream" className="stream-img" style={{borderRadius:0,border:0,boxShadow:'none'}}
              onLoad={()=>setStreamOk(true)}
              onError={()=>{
                if(streamUrl===esp32StreamHttpUrl()) setStreamUrl(proxyStreamUrl())
                else if(streamUrl===proxyStreamUrl()) setStreamError(true)
                else setStreamError(true)
                setStreamOk(false)
              }} />
          ) : (
            <div style={{padding:28,textAlign:'center',background:'#f8fafc'}}>
              <div style={{fontSize:'1.05rem',fontWeight:700,color:'var(--text)',fontFamily:'Plus Jakarta Sans'}}>Studio is dark — no stream yet</div>
              <div style={{maxWidth:560,margin:'10px auto 0',textAlign:'left'}} className="banner banner-warn">
                {isHttps() ? (
                  <>
                    <b>On this https site, the http stream is gated.</b><br/>
                    <span style={{color:'#92400e'}}>Open <a href={esp32StreamHttpUrl()} target="_blank" rel="noreferrer">http stream in new tab</a> — always works. For embedded, allow insecure content (🔒 → Site settings → Insecure: Allow → Reload) → Retry. Or run <code>python server/app.py</code> and use <code>http://localhost:5000</code>.</span>
                  </>
                ) : <>Join <code>ESP32-CAM_AP</code> or home WiFi with STA, then retry.</>}
              </div>
              <div className="row" style={{justifyContent:'center',marginTop:14}}>
                <button className="btn secondary" onClick={()=>{setStreamError(false); setStreamOk(false); setStreamUrl(esp32StreamHttpUrl())}}>Retry direct</button>
                <button className="btn secondary" onClick={()=>{setStreamError(false); setStreamOk(false); setStreamUrl(proxyStreamUrl())}}>Try proxy</button>
                <a className="btn primary" href={esp32StreamHttpUrl()} target="_blank" rel="noreferrer">Open stream</a>
              </div>
            </div>
          )}
          <div style={{padding:'10px 14px',display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',background:'#fff',borderTop:'1px solid var(--border)'}}>
            <span className="small" style={{color:'var(--faint)'}}>Tip: soft daylight, 30cm distance, flash on for glossy strips.</span>
            <span style={{marginLeft:'auto',display:'flex',gap:6}}>
              <button className="btn secondary" style={{padding:'6px 10px',fontSize:'.78rem'}} onClick={()=>{setStreamError(false); setStreamOk(false); setStreamUrl(esp32StreamHttpUrl())}}>Direct</button>
              <button className="btn secondary" style={{padding:'6px 10px',fontSize:'.78rem'}} onClick={()=>{setStreamError(false); setStreamOk(false); setStreamUrl(proxyStreamUrl())}}>Proxy</button>
            </span>
          </div>
        </div>

        <StatusPanel health={health} onReload={reloadModel} />
        <CollectPanel onCollect={handleCollect} loading={loading} error={error} />
        <TrainPanel health={health} />
        <IdentifyPanel onIdentify={handleIdentify} loading={loading} error={error} />

        <div style={{textAlign:'center',marginTop:18}} className="small">
          Made for counters, not clouds — images stay on your device until you upload. White studio, human hands.
        </div>
      </div>
    </div>
  )
}

export default App
