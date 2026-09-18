// API Configuration
export const API_BASE = (import.meta.env.VITE_API_URL || 'https://pills-expiry.onrender.com').replace(/\/$/, '')

// ESP32 Configuration - stored in localStorage for user override
const DEFAULT_ESP32_IP = import.meta.env.VITE_ESP32_IP || '192.168.4.1'

export function getEsp32Ip() {
  try {
    return localStorage.getItem('esp32_ip') || DEFAULT_ESP32_IP
  } catch { return DEFAULT_ESP32_IP }
}
export function setEsp32Ip(ip) {
  try { localStorage.setItem('esp32_ip', ip) } catch {}
}
export function getEsp32Base() {
  const ip = getEsp32Ip()
  // Ensure http:// prefix - ESP32 only supports HTTP, not HTTPS (supports mDNS esp32cam.local)
  if (ip.startsWith('http://') || ip.startsWith('https://')) return ip.replace(/\/$/, '')
  return `http://${ip}`
}

export function getEsp32Candidates() {
  const primary = getEsp32Base()
  const candidates = [primary]
  // Try saved STA IP if available (from previous /status)
  try {
    const sta = localStorage.getItem('esp32_sta_ip')
    if (sta && sta.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      const staUrl = `http://${sta}`
      if (!candidates.includes(staUrl)) candidates.push(staUrl)
    }
  } catch {}
  // mDNS always as fallback
  if (primary.includes('192.168.4.1')) {
    candidates.push('http://esp32cam.local')
  }
  if (primary.includes('esp32cam.local')) candidates.push('http://192.168.4.1')
  return [...new Set(candidates)]
}

// Save STA IP when discovered
export function saveStaIp(ip) {
  try { if (ip && ip.match(/^\d+\.\d+\.\d+\.\d+$/)) localStorage.setItem('esp32_sta_ip', ip) } catch {}
}

// Detect if we are on HTTPS cloud deployment (mixed content will block http:// ESP32 fetch)
export function isHttps() {
  return typeof window !== 'undefined' && window.location.protocol === 'https:'
}
export function isCloudDeployment() {
  // Cloud if API_BASE is not localhost and page is https
  return API_BASE.includes('onrender.com') || API_BASE.includes('workers.dev') || API_BASE.includes('vercel.app') || API_BASE.includes('netlify.app')
}

export async function api(path, options = {}) {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || err.details || `HTTP ${res.status}`)
  }
  return res.json()
}

// ---------- ESP32 Direct Fetch (Client-Side) ----------
// This is the CORRECT way for cloud deployments: browser fetches ESP32 directly
// (when connected to ESP32-CAM_AP) then uploads blob to backend
async function fetchEsp32BlobViaImage(url) {
  // Fallback for HTTPS mixed-content: use <img> passive load + canvas
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const timeout = setTimeout(() => { img.src = ''; reject(new Error('Image load timeout (12s) - ESP32 slow or blocked')) }, 12000)
    img.onload = () => {
      clearTimeout(timeout)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || img.width
        canvas.height = img.naturalHeight || img.height
        if (canvas.width === 0 || canvas.height === 0) throw new Error('Image has zero size')
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((blob) => {
          if (!blob) reject(new Error('Canvas toBlob failed (CORS taint?) - flash ESP32 with new firmware'))
          else if (blob.size < 100) reject(new Error('Empty image from canvas'))
          else resolve(blob)
        }, 'image/jpeg', 0.92)
      } catch (err) {
        reject(new Error('Canvas capture failed: ' + err.message))
      }
    }
    img.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('Image load failed - ESP32 not reachable at ' + url + ' (check WiFi/STA IP)'))
    }
    img.src = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`
  })
}

export async function fetchEsp32Blob(endpoint = '/capture') {
  const candidates = getEsp32Candidates()
  let lastErr = null
  for (const base of candidates) {
    const url = `${base}${endpoint}`
    try {
      const res = await fetch(url, { method: 'GET', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      if (blob.size < 100) throw new Error('Empty image')
      // success - remember working host
      if (base !== getEsp32Base()) try { localStorage.setItem('esp32_ip', base.replace('http://','')) } catch {}
      return blob
    } catch (e) {
      lastErr = e
      const isMixedContent = isHttps() && url.startsWith('http://')
      const msg = e.message || String(e)
      if (isMixedContent && (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed') || msg.includes('fetch'))) {
        try {
          console.warn('Fetch blocked (mixed content), trying <img> fallback for', url)
          const blob = await fetchEsp32BlobViaImage(url)
          console.log('Image fallback succeeded for', url, 'size', blob.size)
          if (base !== getEsp32Base()) try { localStorage.setItem('esp32_ip', base.replace('http://','')) } catch {}
          return blob
        } catch (imgErr) {
          lastErr = new Error(`Mixed content blocked ${url} image fallback: ${imgErr.message}`)
          continue // try next candidate (esp32cam.local)
        }
      }
      // For non-mixed content errors on 192.168.4.1, try next candidate (mDNS)
      if (candidates.length > 1 && base !== candidates[candidates.length-1]) continue
      const isFetchFail = msg.includes('Failed to fetch') || msg.includes('NetworkError')
      if (isFetchFail) {
        throw new Error(`Cannot reach ESP32 at ${candidates.map(c=>c+endpoint).join(' or ')}. STA mode: connect ESP32 to home WiFi via http://192.168.4.1/wifi then use STA IP (no hotspot switch). Current: must be on ${candidates[0].includes('4.1') ? 'ESP32-CAM_AP' : 'home WiFi with ESP32 STA'}. Details: ${msg}`)
      }
      throw new Error(`ESP32 fetch failed (${url}): ${msg}`)
    }
  }
  throw lastErr || new Error('All ESP32 candidates failed')
}

// Client-side collect: fetch from ESP32 in browser, then upload to backend
export async function collectEsp32ClientSide(tablet, expiry) {
  const blob = await fetchEsp32Blob('/capture')
  // Convert blob to File for upload
  const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' })
  return collectUpload(file, tablet, expiry)
}

// Client-side identify: fetch from ESP32 in browser, then upload to backend
export async function identifyEsp32ClientSide() {
  const blob = await fetchEsp32Blob('/capture')
  const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' })
  return identifyUpload(file)
}

// Check ESP32 connectivity from browser - tries fetch, then proxy, then image load for HTTPS mixed-content
async function checkEsp32ViaImage(base) {
  const b = base || getEsp32Base()
  return new Promise((resolve) => {
    const img = new Image()
    const timeout = setTimeout(() => { img.src = ''; resolve(false) }, 8000)
    img.onload = () => { clearTimeout(timeout); resolve(true) }
    img.onerror = () => { clearTimeout(timeout); resolve(false) }
    img.src = `${b}/capture?_t=${Date.now()}`
  })
}

async function fetchStatusFrom(base) {
  const res = await fetch(`${base}/status`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data.sta_ip) saveStaIp(data.sta_ip)
  return { data, base }
}

export async function checkEsp32Status() {
  const candidates = getEsp32Candidates()
  let lastError = null
  // 1) Try direct JS fetch on all candidates (192.168.4.1 and esp32cam.local)
  for (const base of candidates) {
    try {
      const { data } = await fetchStatusFrom(base)
      // Save working base as preferred
      if (base !== getEsp32Base()) {
        try { localStorage.setItem('esp32_ip', base.replace('http://','')) } catch {}
      }
      return { online: true, via: 'fetch', data, base, sta_ip: data.sta_ip, sta_connected: data.sta_connected }
    } catch (e) {
      lastError = e
    }
  }
  const msg = lastError ? (lastError.message || String(lastError)) : 'Unknown'
  const httpsBlocked = isHttps()
  const isFetchBlocked = msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')

  // 2) If HTTPS mixed-content block, try backend proxy (only works if backend is LOCAL - on Render it will also fail)
  if (httpsBlocked && isFetchBlocked) {
    // Try proxy for each candidate's path? proxy is same backend regardless, but try
    try {
      const pr = await fetch(`${API_BASE}/esp32/status`, { cache: 'no-store' })
      if (pr.ok) {
        const data = await pr.json()
        // If proxy returns STA IP, offer to switch
        return { online: true, via: 'proxy', data, base: candidates[0], sta_ip: data.sta_ip, sta_connected: data.sta_connected }
      }
    } catch {}
    // 3) Passive mixed-content check via <img> on all candidates
    for (const base of candidates) {
      const imgOk = await checkEsp32ViaImage(base)
      if (imgOk) {
        // Try to get STA IP via image? can't get JSON, but we know stream works
        return { online: true, via: 'image', streamWorks: true, base, sta_ip: null, warning: 'JS fetch blocked by HTTPS→HTTP (mixed content) but stream image loads - allow insecure content for Capture/Identify JS fetch. STA mode removes need for hotspot.' }
      }
    }
    return { online: false, error: 'Failed to fetch', base: candidates[0], httpsBlocked: true, hint: 'Browser blocks HTTPS→HTTP fetch. Allow insecure content or connect ESP32 to home WiFi via http://192.168.4.1/wifi then use STA IP (no hotspot switch, internet stays). Or use Upload buttons.' }
  }
  // Include STA info if we ever got it via last attempt's error? try to extract
  return { online: false, error: msg, base: candidates[0], httpsBlocked }
}

// Legacy: Backend-mediated fetch (only works when backend is on same network as ESP32, i.e., local dev)
// On Render/cloud, this will always fail because Render cannot reach 192.168.4.1
export const collectEsp32 = (tablet, expiry) =>
  api('/collect', { method: 'POST', body: JSON.stringify({ tablet, expiry }) })

export const collectUpload = (file, tablet, expiry) => {
  const fd = new FormData()
  fd.append('image', file)
  fd.append('tablet', tablet)
  fd.append('expiry', expiry)
  return fetch(`${API_BASE}/collect_upload`, { method: 'POST', body: fd }).then(async r => {
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
    return j
  })
}

// Smart collect: tries client-side first (works on cloud), falls back to backend fetch (works locally)
export async function smartCollectEsp32(tablet, expiry) {
  // If cloud deployment, ALWAYS use client-side (backend can't reach ESP32)
  if (isCloudDeployment() || isHttps()) {
    try {
      return await collectEsp32ClientSide(tablet, expiry)
    } catch (e) {
      // If client-side fails due to mixed content, try backend as last resort (will likely also fail but give clearer error)
      if (e.message.includes('Mixed content')) throw e
      // For other errors, try backend fallback
      console.warn('Client-side ESP32 fetch failed, trying backend proxy:', e.message)
      try {
        return await collectEsp32(tablet, expiry)
      } catch (be) {
        // Prefer original client error which is more helpful
        throw new Error(`${e.message} | Backend fallback also failed: ${be.message}`)
      }
    }
  } else {
    // Local deployment: try backend first (more efficient), fallback to client
    try {
      return await collectEsp32(tablet, expiry)
    } catch (e) {
      console.warn('Backend ESP32 fetch failed, trying client-side:', e.message)
      return await collectEsp32ClientSide(tablet, expiry)
    }
  }
}

export const identifyEsp32 = () => api('/identify', { method: 'POST' })

export const identifyUpload = (file) => {
  const fd = new FormData()
  fd.append('image', file)
  return fetch(`${API_BASE}/identify_upload`, { method: 'POST', body: fd }).then(async r => {
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || j.details || `HTTP ${r.status}`)
    return j
  })
}

// Smart identify: same logic as smartCollect
export async function smartIdentifyEsp32() {
  if (isCloudDeployment() || isHttps()) {
    try {
      return await identifyEsp32ClientSide()
    } catch (e) {
      if (e.message.includes('Mixed content')) throw e
      console.warn('Client-side ESP32 fetch failed, trying backend:', e.message)
      try {
        return await identifyEsp32()
      } catch (be) {
        throw new Error(`${e.message} | Backend fallback also failed: ${be.message}`)
      }
    }
  } else {
    try {
      return await identifyEsp32()
    } catch (e) {
      console.warn('Backend ESP32 fetch failed, trying client-side:', e.message)
      return await identifyEsp32ClientSide()
    }
  }
}

// Health / Model
export const getHealth = () => api('/health')
export const reloadModel = () => api('/reload_model', { method: 'POST' })

// ESP32 URLs for UI
export const esp32Base = () => getEsp32Base()
export const esp32CaptureUrl = () => `${getEsp32Base()}/capture`
export const esp32StatusUrl = () => `${getEsp32Base()}/status`
export const esp32StreamUrl = () => `${getEsp32Base()}/stream`
export const esp32StreamHttpUrl = () => `${getEsp32Base()}/stream`
// Backend proxy (only works when backend is local and can reach ESP32)
export const esp32Proxy = (subpath) => `${API_BASE}/esp32/${subpath}`
export const esp32Stream = () => `${API_BASE}/proxy/stream`
export const proxyStreamUrl = () => `${API_BASE}/proxy/stream`
