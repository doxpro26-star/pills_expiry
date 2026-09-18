import { useState } from 'react'

export default function IdentifyPanel({ onIdentify, loading, error }) {
  const [result, setResult] = useState(null)

  const handleEsp32 = async () => {
    setResult({ loading: true })
    try { const res = await onIdentify('esp32'); setResult(res) }
    catch (e) {
      const m=e.message||String(e)
      const hint = m.includes('Mixed') ? ' — allow once (🔒 → Insecure: Allow) or tap Upload / Phone Camera.' : m.includes('Cannot reach') ? ' — check WiFi / STA IP.' : ''
      setResult({ error: m + hint })
    }
  }
  const handleUpload = (e) => {
    const file = e.target.files[0]; if (!file) return
    onIdentify('upload', file).then(setResult).catch(e=>setResult({error:e.message})).finally(()=>{e.target.value=''})
  }

  if (!result) {
    return (
      <div className="card">
        <h3><span className="step">3</span> Identify — read the date, decide <span className="meta">valid · soon · expired</span></h3>
        <div className="row">
          <button className="btn primary" onClick={handleEsp32} disabled={loading}>
            {loading ? 'Reading…' : '◉ Identify from studio'}
          </button>
          <label className="btn secondary">
            📁 Upload & identify
            <input type="file" accept="image/*" style={{display:'none'}} onChange={handleUpload} />
          </label>
          <label className="btn secondary">
            📱 Phone camera
            <input type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={handleUpload} />
          </label>
        </div>
        <p className="small">Studio or phone — same model, same light. Keep strip flat, no tilt.</p>
      </div>
    )
  }

  if (result.loading) {
    return (
      <div className="card">
        <h3><span className="step">3</span> Reading…</h3>
        <div className="banner banner-neutral">Framing, then asking the model — a breath.</div>
      </div>
    )
  }

  if (result.error) {
    return (
      <div className="card">
        <h3><span className="step">3</span> Not yet</h3>
        <div className="banner banner-warn" style={{whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{result.error}</div>
        <p className="small" style={{marginTop:8}}>Try: <a href="http://192.168.4.1/capture" target="_blank" rel="noreferrer">studio capture</a> in new tab, or Upload. On https, allow once.</p>
        <button className="btn secondary" onClick={() => setResult(null)}>Try again</button>
      </div>
    )
  }

  const top = result.top1
  const cls = top.is_expired === true ? 'expired' : (top.days_left !== null && top.days_left < 90 ? 'warn' : 'valid')
  const flag = top.is_expired === null ? '' : (top.is_expired ? 'Expired' : (top.days_left < 90 ? 'Due soon' : 'Valid'))

  return (
    <div className="card" style={{borderColor: cls==='expired'?'#fecaca':cls==='warn'?'#fde68a':'#a7f3d0'}}>
      <h3><span className="step" style={{background: cls==='expired'?'#dc2626':cls==='warn'?'#d97706':'#0d9488'}}>{cls==='expired'?'!':cls==='warn'?'~':'✓'}</span> Result — handwritten, not guessed</h3>
      <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'center'}}>
        <div className={`banner ${cls==='expired'?'':'banner-success'}`} style={{flex:1, fontSize:'1.05rem', fontWeight:700, background: cls==='expired'?'#fef2f2':cls==='warn'?'#fffbeb':'#ecfdf5', borderColor:cls==='expired'?'#fecaca':cls==='warn'?'#fde68a':'#a7f3d0'}}>
          <span className={cls} style={{fontFamily:'Plus Jakarta Sans'}}>{top.tablet}</span> <span style={{color:'var(--muted)',fontWeight:400}}>·</span> {top.expiry} <span style={{color:'var(--muted)',fontWeight:400}}>·</span> <span className={cls}>{flag}</span> <span style={{fontWeight:500,color:'var(--muted)',fontSize:'.9rem'}}>· {(top.conf*100).toFixed(1)}%</span>
        </div>
      </div>
      <div className="grid" style={{marginTop:12}}>
        {result.top3.map((p, i) => (
          <div key={i} className="stat" style={{opacity: i===0?1:.88}}>
            <div className="stat-value" style={{fontSize:'1.05rem'}}>{p.tablet}</div>
            <div className="stat-label">{p.expiry} · {(p.conf*100).toFixed(1)}%</div>
          </div>
        ))}
      </div>
      <div className="small" style={{marginTop:10}}>Inference {result.inference_ms}ms · {top.days_left!==null ? `${top.days_left} days left` : 'date parsed'} · tilts and glare lower the score — retake if &lt;70%.</div>
      {result.preview && <img src={result.preview} alt="preview" className="preview-img" />}
      <div className="row" style={{marginTop:14}}>
        <button className="btn secondary" onClick={() => setResult(null)}>↻ Check another</button>
      </div>
    </div>
  )
}
