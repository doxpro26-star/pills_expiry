import { useState } from 'react'

export default function CollectPanel({ onCollect, loading, error }) {
  const [tablet, setTablet] = useState('')
  const [expiry, setExpiry] = useState('')
  const [msg, setMsg] = useState('')

  const validate = () => {
    if (!tablet.trim() || !expiry.trim()) return 'Enter tablet name and expiry (MM-YYYY)'
    if (!/^(0[1-9]|1[0-2])-(20\d{2})$/.test(expiry.trim())) return 'Expiry must be MM-YYYY (e.g. 12-2025)'
    return null
  }

  const handleEsp32 = async () => {
    const err = validate()
    if (err) return setMsg(err)
    setMsg('⏳ Capturing from ESP32 (client-side fetch)...')
    try {
      const res = await onCollect('esp32', { tablet: tablet.trim(), expiry: expiry.trim() })
      setMsg(`✅ Saved: ${res.saved_as} (class: ${res.count_in_class}, total: ${res.total_images})`)
    } catch (e) {
      const msg = e.message || String(e)
      const isMixed = msg.includes('Mixed content') || msg.includes('HTTPS→HTTP') || msg.includes('Insecure')
      if (isMixed) {
        setMsg(`⚠️ BROWSER SECURITY: HTTPS site cannot fetch HTTP ESP32 at ${msg.includes('192.168.4.1')?'192.168.4.1':''} — FIX: 1) Click 🔒 → Site settings → Insecure content: Allow → Reload → Retry, OR 2) Use 📁 Upload & Save (phone camera works same), OR 3) Run local http://localhost:5000 or use ESP32 STA IP (http://192.168.4.1/wifi → join home WiFi → no hotspot switch).`)
      } else if (msg.includes('Cannot reach ESP32')) {
        setMsg(`❌ ${msg} — Ensure WiFi: ESP32-CAM_AP (12345678) OR home WiFi if STA configured (http://192.168.4.1/wifi). Save correct IP above.`)
      } else {
        setMsg(`❌ ${msg}`)
      }
    }
  }

  const handleUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const err = validate()
    if (err) return setMsg(err)
    onCollect('upload', { tablet: tablet.trim(), expiry: expiry.trim() }, file)
      .then(res => setMsg(`✅ Uploaded: ${res.saved_as} (class: ${res.count_in_class})`))
      .catch(e => setMsg(`❌ ${e.message}`))
      .finally(() => { e.target.value = '' })
  }

  return (
    <div className="card">
      <h3>Step 1: Collect Images (tablet + expiry)</h3>
      <div className="row">
        <input placeholder="Tablet name (e.g. Crocin)" value={tablet} onChange={e => setTablet(e.target.value)} />
        <input placeholder="Expiry MM-YYYY (e.g. 12-2025)" value={expiry} onChange={e => setExpiry(e.target.value)} />
      </div>
      <div className="row">
        <button className="btn green" onClick={handleEsp32} disabled={loading}>
          {loading ? 'Saving...' : '📸 Capture from ESP32 & Save'}
        </button>
        <label className="btn secondary">
          📁 Upload & Save
          <input type="file" accept="image/*" style={{display:'none'}} onChange={handleUpload} />
        </label>
      </div>
      {msg && <div style={{marginTop:8, color: msg.includes('✅') ? '#4ade80' : msg.includes('⚠️') ? '#fbbf24' : msg.includes('⏳') ? '#facc15' : '#f87171', whiteSpace:'pre-wrap', wordBreak:'break-word', fontSize:12, background: msg.includes('⚠️') ? '#422006' : msg.includes('❌') ? '#450a0a' : msg.includes('✅') ? '#052e16' : '#1e293b', padding:8, borderRadius:6, border: msg.includes('⚠️') ? '1px solid #d97706' : 'none'}}>{msg}</div>}
      {msg && msg.includes('⚠️') && <div className="row" style={{marginTop:6}}>
        <a className="btn secondary" href="http://192.168.4.1/capture" target="_blank" rel="noreferrer" style={{fontSize:11,padding:'6px 10px',textDecoration:'none'}}>Open ESP32 Capture (http)</a>
        <label className="btn primary" style={{fontSize:11,padding:'6px 10px',cursor:'pointer'}}>📱 Use Phone Camera<input type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={handleUpload} /></label>
      </div>}
      <p className="small">Capture 30-50 photos per tablet+expiry combo. Saved to <code>dataset/Tablet__MM-YYYY/</code><br/>
        Cloud (https://): Use <b>Allow insecure content</b> or <b>Upload / Phone Camera</b>. STA mode (home WiFi): ESP32 joins home WiFi via <a href="http://192.168.4.1/wifi" target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>http://192.168.4.1/wifi</a> → no hotspot switch.</p>
    </div>
  )
}