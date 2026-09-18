import { useState } from 'react'

export default function CollectPanel({ onCollect, loading, error }) {
  const [tablet, setTablet] = useState('')
  const [expiry, setExpiry] = useState('')
  const [msg, setMsg] = useState('')

  const validate = () => {
    if (!tablet.trim() || !expiry.trim()) return 'Tablet name + expiry needed'
    if (!/^(0[1-9]|1[0-2])-(20\d{2})$/.test(expiry.trim())) return 'Expiry must be MM-YYYY (e.g. 08-2029)'
    return null
  }

  const handleEsp32 = async () => {
    const err = validate(); if (err) return setMsg(err)
    setMsg('⏳ Framing from studio…')
    try {
      const res = await onCollect('esp32', { tablet: tablet.trim(), expiry: expiry.trim() })
      setMsg(`✅ Saved — ${res.saved_as} · ${res.count_in_class} in this batch · ${res.total_images} total`)
    } catch (e) {
      const m = e.message || String(e)
      if (m.includes('Mixed') || m.includes('HTTPS') || m.includes('Insecure')) {
        setMsg(`⚠️ Your browser guards https → http. The studio is http (local). Fix: allow once (🔒 → Site settings → Insecure content: Allow → Reload) or use Upload / Phone Camera — same print, same model.`)
      } else if (m.includes('Cannot reach')) {
        setMsg(`Cannot reach studio at ESP32. Check WiFi: ESP32-CAM_AP (12345678) or home WiFi via Sta (see banner).`)
      } else setMsg(`Note: ${m}`)
    }
  }

  const handleUpload = (e) => {
    const file = e.target.files[0]; if (!file) return
    const err = validate(); if (err) return setMsg(err)
    onCollect('upload', { tablet: tablet.trim(), expiry: expiry.trim() }, file)
      .then(res => setMsg(`✅ Uploaded — ${res.saved_as} · ${res.count_in_class} in batch`))
      .catch(e => setMsg(`Note: ${e.message}`))
      .finally(() => { e.target.value = '' })
  }

  return (
    <div className="card">
      <h3><span className="step">1</span> Collect — name the tablet, frame its date <span className="meta">30–50 photos · vary light</span></h3>
      <div className="row">
        <input placeholder="Tablet (e.g. Crocin 250)" value={tablet} onChange={e => setTablet(e.target.value)} style={{flex:1}}/>
        <input placeholder="Expiry MM-YYYY" value={expiry} onChange={e => setExpiry(e.target.value)} style={{maxWidth:180}}/>
      </div>
      <div className="row">
        <button className="btn green" onClick={handleEsp32} disabled={loading}>
          {loading ? 'Saving…' : '📷 Capture from studio'}
        </button>
        <label className="btn secondary">
          📁 Upload from files
          <input type="file" accept="image/*" style={{display:'none'}} onChange={handleUpload} />
        </label>
        <label className="btn secondary">
          📱 Phone camera
          <input type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={handleUpload} />
        </label>
      </div>
      {msg && <div className={`banner ${msg.includes('✅')?'banner-success':msg.includes('⚠️')?'banner-warn':msg.includes('⏳')?'banner-neutral':'banner'} `} style={{marginTop:10, fontSize:'.86rem', whiteSpace:'pre-wrap', wordBreak:'break-word'}}>{msg}</div>}
      {msg && msg.includes('⚠️') && (
        <div className="row" style={{marginTop:8}}>
          <a className="btn secondary" href="http://192.168.4.1/capture" target="_blank" rel="noreferrer">Open studio capture (http)</a>
          <span className="small">Same image — phone camera uploads to same dataset.</span>
        </div>
      )}
      <div className="divider" />
      <p className="small">Saves to <code>dataset/Tablet__MM-YYYY/</code> · Human tip: hold 25–35cm, slight angle, avoid glare. On this <b>https</b> site, allow once for one-tap; otherwise Upload is identical. STA join via <a href="http://192.168.4.1/wifi" target="_blank" rel="noreferrer">wifi setup</a> removes hotspot hop.</p>
    </div>
  )
}
