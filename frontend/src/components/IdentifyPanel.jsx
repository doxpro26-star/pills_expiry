import { useState } from 'react'

export default function IdentifyPanel({ onIdentify, loading, error }) {
  const [result, setResult] = useState(null)

  const handleEsp32 = async () => {
    setResult({ loading: true })
    try {
      const res = await onIdentify('esp32')
      setResult(res)
    } catch (e) {
      const isMixed = e.message.includes('Mixed content')
      const hint = isMixed
        ? ' Browser blocks HTTPS→HTTP. Allow insecure content or use Upload, or run backend locally.'
        : e.message.includes('Cannot reach')
          ? ' Ensure WiFi ESP32-CAM_AP connected and ESP32 online at http://192.168.4.1/status'
          : ''
      setResult({ error: e.message + hint })
    }
  }

  const handleUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    onIdentify('upload', file)
      .then(setResult)
      .catch(e => setResult({ error: e.message }))
      .finally(() => { e.target.value = '' })
  }

  if (!result) {
    return (
      <div className="card">
        <h3>Step 3: Identify Tablet + Expiry</h3>
        <div className="row">
          <button className="btn primary" onClick={handleEsp32} disabled={loading}>
            {loading ? '🔄 Predicting...' : '🔍 Identify from ESP32'}
          </button>
          <label className="btn secondary">
            📁 Upload & Identify
            <input type="file" accept="image/*" style={{display:'none'}} onChange={handleUpload} />
          </label>
        </div>
        <p className="small">Model must be trained first (see Train panel)<br/>ESP32 mode: browser fetches http://192.168.4.1/capture → uploads to backend for inference. Needs ESP32-CAM_AP WiFi.</p>
      </div>
    )
  }

  if (result.loading) {
    return (
      <div className="card">
        <h3>Result</h3>
        <div style={{color:'#facc15'}}>⏳ Capturing from ESP32 & analysing...</div>
        <div className="small">Fetching http://192.168.4.1/capture in browser, then sending to backend.</div>
      </div>
    )
  }

  if (result.error) {
    return (
      <div className="card">
        <h3>Result</h3>
        <div style={{color:'#f87171', whiteSpace:'pre-wrap', wordBreak:'break-word', background:'#450a0a', padding:10, borderRadius:6, fontSize:13}}>❌ Error: {result.error}</div>
        <div style={{marginTop:8}} className="small">Try: (1) Connect to ESP32-CAM_AP, (2) Open <a href="http://192.168.4.1/capture" target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>http://192.168.4.1/capture</a> to test, (3) Use Upload button instead, (4) On HTTPS cloud site, allow insecure content.</div>
        <button className="btn secondary" onClick={() => setResult(null)}>Try Again</button>
      </div>
    )
  }

  const top = result.top1
  const cls = top.is_expired === true ? 'expired' : (top.days_left !== null && top.days_left < 90 ? 'warn' : 'valid')
  const flag = top.is_expired === null ? '' : (top.is_expired ? 'EXPIRED' : (top.days_left < 90 ? 'EXPIRES SOON' : 'VALID'))

  return (
    <div className="card">
      <h3>Result</h3>
      <div className={cls} style={{fontSize: '20px', fontWeight: 'bold', marginBottom: '12px'}}>
        {top.tablet} | {top.expiry} | {flag} ({(top.conf * 100).toFixed(1)}%)
      </div>
      <div className="grid">
        {result.top3.map((p, i) => (
          <div key={i} className="stat">
            <div className="stat-value">{p.tablet}</div>
            <div className="stat-label">{p.expiry} · {(p.conf * 100).toFixed(1)}%</div>
          </div>
        ))}
      </div>
      <div style={{marginTop: '12px', color: '#94a3b8', fontSize: '13px'}}>
        Inference: {result.inference_ms}ms | Days left: {top.days_left ?? 'N/A'}
      </div>
      {result.preview && <img src={result.preview} alt="preview" className="preview-img" />}
      <div className="row" style={{marginTop: '16px'}}>
        <button className="btn secondary" onClick={() => setResult(null)}>🔄 Check Another</button>
      </div>
    </div>
  )
}