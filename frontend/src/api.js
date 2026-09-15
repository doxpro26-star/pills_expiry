// API Configuration
// Set VITE_API_URL in Vercel/Netlify environment variables
// For local dev, uses Vite proxy to http://localhost:5000

export const API_BASE = import.meta.env.VITE_API_URL || ''

export async function api(path, options = {}) {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// Collect
export const collectEsp32 = (tablet, expiry) =>
  api('/collect', { method: 'POST', body: JSON.stringify({ tablet, expiry }) })

export const collectUpload = (file, tablet, expiry) => {
  const fd = new FormData()
  fd.append('image', file)
  fd.append('tablet', tablet)
  fd.append('expiry', expiry)
  return fetch(`${API_BASE}/collect_upload`, { method: 'POST', body: fd }).then(r => r.json())
}

// Identify
export const identifyEsp32 = () => api('/identify', { method: 'POST' })

export const identifyUpload = (file) => {
  const fd = new FormData()
  fd.append('image', file)
  return fetch(`${API_BASE}/identify_upload`, { method: 'POST', body: fd }).then(r => r.json())
}

// Health / Model
export const getHealth = () => api('/health')
export const reloadModel = () => api('/reload_model', { method: 'POST' })

// ESP32 proxy
export const esp32Proxy = (subpath) => `${API_BASE}/esp32/${subpath}`
export const esp32Stream = () => `${API_BASE}/proxy/stream`