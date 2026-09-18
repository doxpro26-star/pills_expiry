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
  // Ensure http:// prefix - ESP32 only supports HTTP, not HTTPS
  if (ip.startsWith('http://') || ip.startsWith('https://')) return ip.replace(/\/$/, '')
  return `http://${ip}`
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
  // Fallback for HTTPS mixed-content: use <img> passive load + canvas (works even when fetch blocked if ESP32 sends CORS *)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    const timeout = setTimeout(() => { img.src = ''; reject(new Error('Image load timeout (4s)')) }, 6000)
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
          if (!blob) reject(new Error('Canvas toBlob failed (CORS taint?)'))
          else if (blob.size < 100) reject(new Error('Empty image from canvas'))
          else resolve(blob)
        }, 'image/jpeg', 0.92)
      } catch (err) {
        reject(new Error('Canvas capture failed: ' + err.message))
      }
    }
    img.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('Image load failed - ensure ESP32 is reachable and CORS enabled'))
    }
    img.src = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`
  })
}

export async function fetchEsp32Blob(endpoint = '/capture') {
  const base = getEsp32Base()
  const url = `${base}${endpoint}`
  
  // Try direct fetch with CORS first
  try {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`ESP32 returned HTTP ${res.status}`)
    const blob = await res.blob()
    if (blob.size < 100) throw new Error('ESP32 returned empty image')
    return blob
  } catch (e) {
    const isMixedContent = isHttps() && url.startsWith('http://')
    const msg = e.message || String(e)
    
    // On HTTPS mixed-content block, try <img> fallback (passive content may still load)
    if (isMixedContent && (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed') || msg.includes('fetch'))) {
      try {
        console.warn('Fetch blocked (mixed content), trying <img> fallback for', url)
        const blob = await fetchEsp32BlobViaImage(url)
        console.log('Image fallback succeeded for', url, 'size', blob.size)
        return blob
      } catch (imgErr) {
        throw new Error(
          `Mixed content blocked (HTTPS→HTTP): ${url} – Browser blocks fetch to local IP. Image fallback also failed: ${imgErr.message}. ` +
          `Solutions: (1) Allow insecure content: click 🔒 in address bar → Site settings → Insecure content: Allow → Reload, ` +
          `(2) Use Upload button, or (3) Run backend locally at http://localhost:5000. ` +
          `You must be on WiFi ESP32-CAM_AP (12345678). Your stream image may still show – that's passive content, but JS capture needs insecure allow or fallback.`
        )
      }
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      throw new Error(
        `Cannot reach ESP32 at ${url}. Check: (1) Connected to WiFi ESP32-CAM_AP (pass: 12345678), ` +
        `(2) ESP32 IP is ${getEsp32Ip()} (try http://${getEsp32Ip()}/status in browser), ` +
        `(3) ESP32 is powered on. Details: ${msg}`
      )
    }
    throw new Error(`ESP32 fetch failed (${url}): ${msg}`)
  }
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
async function checkEsp32ViaImage() {
  const base = getEsp32Base()
  return new Promise((resolve) => {
    const img = new Image()
    const timeout = setTimeout(() => { img.src = ''; resolve(false) }, 4000)
    img.onload = () => { clearTimeout(timeout); resolve(true) }
    img.onerror = () => { clearTimeout(timeout); resolve(false) }
    // Use /capture with cache-bust as test image - ESP32 returns JPEG
    img.src = `${base}/capture?_t=${Date.now()}`
  })
}

export async function checkEsp32Status() {
  const base = getEsp32Base()
  // 1) Try direct JS fetch (works on http:// local or when mixed-content allowed)
  try {
    const res = await fetch(`${base}/status`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return { online: true, via: 'fetch', data, base }
  } catch (e) {
    const msg = e.message || String(e)
    const httpsBlocked = isHttps()
    const isFetchBlocked = msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')

    // 2) If HTTPS mixed-content block, try backend proxy (only works if backend is LOCAL - on Render it will also fail)
    if (httpsBlocked && isFetchBlocked) {
      try {
        const pr = await fetch(`${API_BASE}/esp32/status`, { cache: 'no-store' })
        if (pr.ok) {
          const data = await pr.json()
          return { online: true, via: 'proxy', data, base }
        }
      } catch {}
      // 3) Passive mixed-content check via <img> - browsers allow <img http> on https as passive content even when fetch is blocked
      const imgOk = await checkEsp32ViaImage()
      if (imgOk) {
        return { online: true, via: 'image', streamWorks: true, base, warning: 'JS fetch blocked by HTTPS→HTTP (mixed content) but stream image loads - allow insecure content for Capture/Identify JS fetch' }
      }
      return { online: false, error: 'Failed to fetch', base, httpsBlocked: true, imgCheck: imgOk, hint: 'Browser blocks HTTPS→HTTP fetch. Allow insecure content or use http://localhost:5000 or Upload buttons.' }
    }
    return { online: false, error: msg, base, httpsBlocked }
  }
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
