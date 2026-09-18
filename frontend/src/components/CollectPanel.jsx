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
      const isMixed = e.message.includes('Mixed content')
      const detail = isMixed
        ? ' — Browser blocked HTTPS→HTTP. Use Upload button or allow insecure content (🔒 icon → Site settings → Insecure content: Allow), or connect via http://localhost:5000'
        : e.message.includes('Cannot reach ESP32')
          ? ' — Ensure WiFi ESP32-CAM_AP (pass: 12345678) is connected and open http://192.168.4.1/status to verify'
          : ''
      setMsg(`❌ ${e.message}${detail}`)
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
      {msg && <div style={{marginTop:8, color: msg.includes('✅') ? '#4ade80' : msg.includes('⏳') ? '#facc15' : '#f87171', whiteSpace:'pre-wrap', wordBreak:'break-word', fontSize:12, background: msg.includes('❌') ? '#450a0a' : msg.includes('✅') ? '#052e16' : '#1e293b', padding:8, borderRadius:6}}>{msg}</div>}
      <p className="small">Capture 30-50 photos per tablet+expiry combo. Saved to <code>dataset/Tablet__MM-YYYY/</code><br/>
        Cloud mode: browser fetches <code>http://192.168.4.1/capture</code> then uploads to backend — must be on ESP32-CAM_AP WiFi. If blocked, use Upload.</p>
    </div>
  )
}