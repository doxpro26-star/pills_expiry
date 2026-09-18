"""
ESP32-CAM Tablet + Expiry predictor (NO YOLO, NO OCR).
Vision: while collecting you give tablet name + expiry date,
after training the model predicts tablet + expiry together.

Flow:
  1. Collect: enter Tablet + Expiry (MM/YYYY) -> Capture from ESP32 -> saved to dataset/Tablet__MM-YYYY/
  2. Train:  python train_tablets.py --data dataset --epochs 20  -> tablet_classifier.pth + classes.json
  3. Check:  Identify button -> fetches http://192.168.4.1/capture -> predicts tablet + expiry + VALID/EXPIRED

Class format: <TabletName>__<MM-YYYY>  e.g. Crocin__12-2025
"""
import base64
import calendar
import io
import json
import os
import re
import threading
import time
from datetime import date
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, render_template_string, request
from PIL import Image

try:
    from flask_cors import CORS
    cors_enabled = True
except ImportError:
    cors_enabled = False

app = Flask(__name__)
if cors_enabled:
    CORS(app, resources={r"/*": {"origins": "*", "allow_headers": "*", "methods": ["GET","POST","OPTIONS"]}})

# FIXED: handle X-Forwarded headers for proxy, add CORP header for mixed content debugging
@app.after_request
def after_request(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Cross-Origin-Embedder-Policy"] = "unsafe-none"
    response.headers["Cross-Origin-Opener-Policy"] = "unsafe-none"
    return response

ESP32_IP = os.environ.get("ESP32_IP", "192.168.4.1")
ESP32_CAPTURE_URL = f"http://{ESP32_IP}/capture"
ESP32_STREAM_URL = f"http://{ESP32_IP}/stream"
IS_CLOUD = bool(os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("RENDER_SERVICE_NAME") or "onrender.com" in (os.environ.get("SELF_URL","") or ""))
# STA candidates for local network (when ESP32 joins home WiFi, AP 192.168.4.1 not reachable from home WiFi)
ESP32_CANDIDATES = [ESP32_IP, "192.168.1.7", "esp32cam.local", "192.168.4.1"]
# dedupe preserve order
_seen=set(); ESP32_CANDIDATES=[x for x in ESP32_CANDIDATES if not (x in _seen or _seen.add(x))]

# --- Anti-Freeze / Keep-Alive Daemon for Render ---
def start_keep_alive():
    """Periodically sends an external HTTP ping every 10 minutes to prevent Render from freezing."""
    external_url = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("SELF_URL") or os.environ.get("KEEP_ALIVE_URL") or "https://pills-expiry.onrender.com"
    if not external_url:
        return

    url = external_url.rstrip("/")

    def loop():
        time.sleep(45)  # Wait for startup
        print(f"[KEEP-ALIVE] Anti-freeze monitor running for: {url}")
        while True:
            try:
                time.sleep(600)  # Ping every 10 minutes (Render sleeps after 15 min idle)
                res = requests.get(f"{url}/ping", timeout=15)
                print(f"[KEEP-ALIVE] Ping sent to {url}/ping -> HTTP {res.status_code} (Server kept warm!)")
            except Exception as e:
                print(f"[KEEP-ALIVE] Ping attempt: {e}")

    t = threading.Thread(target=loop, daemon=True)
    t.start()

start_keep_alive()

BASE_DIR = Path(__file__).parent
DATASET_DIR = BASE_DIR / "dataset"
MODEL_PATH = BASE_DIR / "tablet_classifier.pth"
CLASSES_PATH = BASE_DIR / "classes.json"

# --- classifier (torch, lazy load) ---
model = None
classes = []
device = None
predict_tf = None

try:
    import torch
    import torch.nn.functional as F
    from torchvision import models, transforms
    TORCH_OK = True
except ImportError:
    TORCH_OK = False
    print("[WARN] torch/torchvision not installed - install via requirements.txt")


def load_model():
    global model, classes, device, predict_tf
    if not TORCH_OK:
        return False
    if not MODEL_PATH.exists() or not CLASSES_PATH.exists():
        print("[INFO] No trained model yet - collect images then run train_tablets.py")
        return False
    try:
        with open(CLASSES_PATH) as f:
            classes = json.load(f)["classes"]
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        try:
            weights = models.MobileNet_V2_Weights.IMAGENET1K_V1
            m = models.mobilenet_v2(weights=weights)
        except Exception:
            m = models.mobilenet_v2(pretrained=True)
        import torch.nn as nn
        m.classifier[1] = nn.Linear(m.last_channel, len(classes))
        m.load_state_dict(torch.load(MODEL_PATH, map_location=device))
        m.to(device).eval()
        model = m
        predict_tf = transforms.Compose([
            transforms.Resize((224, 224)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        print(f"[INFO] Loaded tablet model: {len(classes)} classes on {device}")
        return True
    except Exception as e:
        print(f"[ERROR] Model load failed: {e}")
        model = None
        return False


load_model()

# --- helpers ---
EXP_RE = re.compile(r"^(0[1-9]|1[0-2])-(19|20)\d{2}$")


def parse_class_label(label):
    """Crocin__12-2025 -> (tablet=Crocin, month=12, year=2025)"""
    if "__" not in label:
        return label, None, None
    tablet, exp = label.rsplit("__", 1)
    m = EXP_RE.match(exp.strip())
    if not m:
        return tablet, None, None
    mm, yyyy = exp.split("-")
    return tablet, int(mm), int(yyyy)


def expiry_status(month, year):
    if month is None or year is None:
        return None, None, None
    last_day = calendar.monthrange(year, month)[1]
    exp_date = date(year, month, last_day)
    today = date.today()
    days_left = (exp_date - today).days
    return exp_date, exp_date < today, days_left


def safe_folder(tablet, expiry):
    tablet_clean = re.sub(r"[^\w\- ]", "", tablet.strip().replace(" ", "_"))[:40]
    expiry_clean = expiry.strip()
    if not tablet_clean:
        return None, "Tablet name required"
    if not EXP_RE.match(expiry_clean):
        return None, "Expiry must be MM-YYYY (e.g. 12-2025)"
    month, year = map(int, expiry_clean.split("-"))
    if not (1 <= month <= 12 and 2020 <= year <= 2040):
        return None, "Expiry year must be 2020-2040"
    return f"{tablet_clean}__{expiry_clean}", None


def save_image(pil_img, folder_name):
    folder = DATASET_DIR / folder_name
    folder.mkdir(parents=True, exist_ok=True)
    existing = len(list(folder.glob("*.jpg")))
    path = folder / f"img_{existing+1:04d}.jpg"
    pil_img.convert("RGB").save(path, "JPEG", quality=92)
    return path


def preview_b64(pil_img, size=320):
    buf = io.BytesIO()
    img = pil_img.copy()
    img.thumbnail((size, size))
    img.save(buf, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def predict(pil_img):
    if model is None or predict_tf is None:
        return None
    t0 = time.time()
    inp = predict_tf(pil_img.convert("RGB")).unsqueeze(0).to(device)
    with torch.no_grad():
        out = model(inp)
        probs = F.softmax(out[0], dim=0)
        top3_p, top3_i = torch.topk(probs, min(3, len(classes)))
    results = []
    for p, i in zip(top3_p, top3_i):
        idx = int(i)
        label = classes[idx]
        tablet, mm, yyyy = parse_class_label(label)
        exp_date, is_exp, days = expiry_status(mm, yyyy)
        results.append({
            "label": label,
            "tablet": tablet,
            "expiry": f"{mm:02d}/{yyyy}" if mm else None,
            "expiry_date": exp_date.isoformat() if exp_date else None,
            "is_expired": is_exp,
            "days_left": days,
            "conf": float(p),
        })
    ms = int((time.time() - t0) * 1000)
    return results, ms


def fetch_esp32():
    # Try all candidates (STA 192.168.1.7, mDNS, AP) - local PC can reach STA when on same home WiFi
    last_err = None
    for cand in ESP32_CANDIDATES:
        url = f"http://{cand}/capture"
        try:
            r = requests.get(url, timeout=4)
            if r.status_code != 200:
                last_err = f"HTTP {r.status_code} at {url}"
                continue
            return Image.open(io.BytesIO(r.content)).convert("RGB"), None
        except Exception as e:
            last_err = f"{e} at {url}"
            continue
    hint = ""
    if IS_CLOUD:
        hint = " (CLOUD: Render cannot reach local 192.168.x.x - use browser client-side fetch)"
    else:
        hint = f" (LOCAL: tried {ESP32_CANDIDATES} - ensure PC on same WiFi as ESP32 STA 192.168.1.7 or AP 192.168.4.1; set ESP32_IP env to STA IP)"
    return None, f"{last_err}{hint}"


HTML_PAGE = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MediScan — Tablet Expiry Checker</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --primary:       #0891b2;
    --primary-dark:  #0e7490;
    --primary-light: #cffafe;
    --success:       #059669;
    --warning:       #d97706;
    --danger:        #dc2626;
    --bg:            #f0f9ff;
    --surface:       #ffffff;
    --surface2:      #f8fafc;
    --border:        #e0f2fe;
    --text:          #0f172a;
    --text-muted:    #64748b;
    --text-light:    #94a3b8;
    --shadow-sm:     0 1px 3px rgba(8,145,178,.10), 0 1px 2px rgba(0,0,0,.06);
    --shadow-md:     0 4px 16px rgba(8,145,178,.12), 0 2px 6px rgba(0,0,0,.07);
    --radius:        12px;
    --radius-sm:     8px;
    --radius-lg:     16px;
  }

  body {
    font-family: 'Inter', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    text-align: center;
  }

  header {
    background: linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 60%, #06b6d4 100%);
    box-shadow: 0 4px 20px rgba(8,145,178,.30);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header-inner {
    max-width: 900px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    gap: 12px;
  }
  .logo { display: flex; align-items: center; gap: 10px; color: #fff; }
  .logo-icon {
    width: 38px; height: 38px;
    background: rgba(255,255,255,.20);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
  .logo h1 { font-size: 1.25rem; font-weight: 700; letter-spacing: -.3px; }
  .logo p  { font-size: .75rem; font-weight: 400; opacity: .80; margin: 0; }
  .header-badge {
    background: rgba(255,255,255,.18);
    color: #fff;
    font-size: .72rem;
    font-weight: 600;
    padding: 5px 14px;
    border-radius: 99px;
    border: 1px solid rgba(255,255,255,.30);
    white-space: nowrap;
  }

  main { max-width: 900px; margin: 0 auto; padding: 24px 16px 48px; }

  /* Camera */
  .stream-wrap {
    background: var(--surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    border: 1px solid var(--border);
    overflow: hidden;
    margin-bottom: 20px;
  }
  .stream-label {
    background: var(--primary-light);
    color: var(--primary-dark);
    font-size: .72rem;
    font-weight: 700;
    letter-spacing: .6px;
    padding: 6px 16px;
    text-align: left;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pulse-dot {
    width: 8px; height: 8px;
    background: var(--primary);
    border-radius: 50%;
    animation: pulse 1.6s infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%, 100% { opacity:1; transform:scale(1); }
    50%       { opacity:.35; transform:scale(.7); }
  }
  #stream {
    width: 100%; display: block;
    max-height: 440px; object-fit: cover;
    background: #e2e8f0;
    min-height: 220px;
  }

  /* Cards */
  .card {
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--border);
    margin-bottom: 16px;
    text-align: left;
    overflow: hidden;
    transition: box-shadow .2s;
  }
  .card:hover { box-shadow: var(--shadow-md); }
  .card-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 20px;
    background: var(--surface2);
    border-bottom: 1px solid var(--border);
  }
  .step-badge {
    min-width: 28px; height: 28px;
    background: var(--primary);
    color: #fff;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: .78rem; font-weight: 700;
    flex-shrink: 0;
  }
  .card-title { font-size: .93rem; font-weight: 600; color: var(--text); }
  .card-body  { padding: 18px 20px; }

  /* Inputs */
  .input-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .input-wrap { flex: 1; min-width: 170px; }
  .input-wrap label {
    display: block;
    font-size: .72rem; font-weight: 700;
    color: var(--text-muted);
    margin-bottom: 5px;
    text-transform: uppercase; letter-spacing: .5px;
  }
  input[type=text] {
    width: 100%;
    padding: 10px 14px;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: .88rem;
    color: var(--text);
    background: var(--surface);
    outline: none;
    transition: border-color .2s, box-shadow .2s;
  }
  input[type=text]:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(8,145,178,.15);
  }
  input[type=text]::placeholder { color: var(--text-light); }

  /* Buttons */
  .btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .btn {
    padding: 10px 18px;
    font-size: .85rem; font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    transition: transform .14s, box-shadow .14s, background .14s;
    white-space: nowrap;
    text-decoration: none;
  }
  .btn:hover  { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn-primary { background: var(--primary); color:#fff; box-shadow:0 2px 8px rgba(8,145,178,.35); }
  .btn-primary:hover { background: var(--primary-dark); }
  .btn-success { background: var(--success); color:#fff; box-shadow:0 2px 8px rgba(5,150,105,.30); }
  .btn-success:hover { background: #047857; }
  .btn-outline { background: var(--surface); color: var(--primary); border: 1.5px solid var(--primary); }
  .btn-outline:hover { background: var(--primary-light); }
  .btn-ghost   { background: var(--surface2); color: var(--text-muted); border: 1.5px solid var(--border); }
  .btn-ghost:hover { background: #f1f5f9; color: var(--text); }

  /* Messages */
  #collect_msg {
    font-size: .84rem;
    color: var(--primary-dark);
    background: var(--primary-light);
    border-radius: 6px;
    padding: 8px 12px;
    margin-top: 8px;
    display: none;
  }
  #collect_msg.show { display: block; }
  #collect_msg.err  { background:#fee2e2; color:var(--danger); }

  .tip {
    font-size: .78rem;
    color: var(--text-muted);
    margin-top: 10px;
    line-height: 1.6;
  }
  code {
    font-size: .82rem;
    background: #f1f5f9;
    color: var(--primary-dark);
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid var(--border);
    font-family: 'Courier New', monospace;
  }
  .code-block {
    background: #f8fafc;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    text-align: left;
    margin: 8px 0;
    font-family: 'Courier New', monospace;
    font-size: .82rem;
    color: #0e7490;
    line-height: 1.8;
  }

  /* Result Panel */
  #result-panel {
    background: var(--surface2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    padding: 14px 16px;
    margin-top: 12px;
    min-height: 54px;
  }
  #result {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  #details { font-size: .8rem; color: var(--text-muted); }
  #preview  { margin-top: 10px; }
  #preview img {
    max-width: 260px;
    border-radius: 10px;
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--border);
  }

  .status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 14px;
    border-radius: 99px;
    font-size: .82rem; font-weight: 700;
    letter-spacing: .3px;
    text-transform: uppercase;
  }
  .valid   { background:#d1fae5; color:#065f46; }
  .expired { background:#fee2e2; color:#991b1b; }
  .warn    { background:#fef3c7; color:#92400e; }

  /* Status Bar */
  .status-bar {
    display: flex; flex-wrap: wrap; gap: 10px;
    align-items: center; justify-content: space-between;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 16px;
    margin-top: 10px;
    font-size: .78rem;
    color: var(--text-muted);
  }
  .status-item { display: flex; align-items: center; gap: 5px; }
  .dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .dot-online  { background: var(--success); }
  .dot-offline { background: var(--danger); }
  .dot-warn    { background: var(--warning); }

  @media(max-width:600px){
    .header-inner { padding: 12px 14px; }
    .card-body    { padding: 14px; }
    .input-row    { flex-direction: column; }
    .btn-row      { flex-direction: column; }
  }
</style>
</head>
<body>

<header>
  <div class="header-inner">
    <div class="logo">
      <div class="logo-icon">&#128138;</div>
      <div>
        <h1>MediScan</h1>
        <p>Tablet Expiry Intelligence</p>
      </div>
    </div>
    <div class="header-badge">&#9829; Medical Grade AI</div>
  </div>
</header>

<main>

  <div class="stream-wrap">
    <div class="stream-label">
      <span class="pulse-dot"></span> Live Camera &mdash; ESP32-CAM
      <span id="esp32_extra" style="margin-left:auto;font-size:.65rem;color:var(--primary-dark);"></span>
    </div>
    <div id="esp_banner" style="display:none;padding:8px 12px;font-size:.78rem;text-align:left;line-height:1.5;"></div>
    <img id="stream" src="" alt="ESP32 Camera Stream" style="display:none">
    <div id="stream_fallback" style="display:none;padding:30px;color:var(--text-muted);background:#e2e8f0;">
      <div style="font-size:1.1rem;margin-bottom:8px;">📷 Stream unavailable</div>
      <div id="stream_msg" style="font-size:.82rem;line-height:1.6;max-width:600px;margin:0 auto;text-align:left;background:#fff;padding:12px;border-radius:8px;border:1px solid var(--border);"></div>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
        <button class="btn btn-ghost" onclick="loadStream('direct')">Retry Direct</button>
        <button class="btn btn-ghost" onclick="loadStream('proxy')">Try Proxy</button>
        <a class="btn btn-primary" href="http://192.168.4.1/stream" target="_blank">Open Stream (http)</a>
        <a class="btn btn-outline" href="http://192.168.4.1/wifi" target="_blank">📶 WiFi Setup</a>
      </div>
    </div>
  </div>

  <!-- Step 1: Collect -->
  <div class="card">
    <div class="card-header">
      <div class="step-badge">1</div>
      <div class="card-title">Collect &mdash; Capture &amp; Label Training Images</div>
    </div>
    <div class="card-body">
      <div class="input-row">
        <div class="input-wrap">
          <label for="tablet">&#128138; Tablet Name</label>
          <input type="text" id="tablet" placeholder="e.g. Crocin, Paracetamol">
        </div>
        <div class="input-wrap">
          <label for="expiry">&#128197; Expiry Date</label>
          <input type="text" id="expiry" placeholder="MM-YYYY e.g. 12-2025">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-success" onclick="collect('esp32')">&#128247; Capture from ESP32 &amp; Save</button>
        <label class="btn btn-outline" style="cursor:pointer">
          &#128190; Upload &amp; Save
          <input type="file" id="cupload" accept="image/*" style="display:none" onchange="collect('upload')">
        </label>
      </div>
      <div id="collect_msg"></div>
      <p class="tip">&#128161; Capture <strong>30&ndash;50 photos</strong> per tablet+expiry combo (vary angles, use flash). Saved to <code>dataset/Tablet__MM-YYYY/</code></p>
    </div>
  </div>

  <!-- Step 2: Train -->
  <div class="card">
    <div class="card-header">
      <div class="step-badge">2</div>
      <div class="card-title">Train &mdash; Build the AI Classification Model</div>
    </div>
    <div class="card-body">
      <div class="code-block">
        pip install -r requirements.txt<br>
        python train_tablets.py --data dataset --epochs 20
      </div>
      <p class="tip">Generates <code>tablet_classifier.pth</code> + <code>classes.json</code>. Restart the server after training.</p>
      <div class="status-bar">
        <div class="status-item">
          <span id="model_dot" class="dot dot-warn"></span>
          <strong>Model:</strong>&nbsp;<span id="model_status">checking&hellip;</span>
        </div>
        <div class="status-item" id="esp32stat">
          <span class="dot dot-warn"></span> ESP32: checking&hellip;
        </div>
      </div>
    </div>
  </div>

  <!-- Step 3: Identify -->
  <div class="card">
    <div class="card-header">
      <div class="step-badge">3</div>
      <div class="card-title">Identify &mdash; Predict Tablet &amp; Expiry Status</div>
    </div>
    <div class="card-body">
      <div class="btn-row">
        <button class="btn btn-primary" onclick="identify('esp32')">&#128269; Identify from ESP32</button>
        <label class="btn btn-outline" style="cursor:pointer">
          &#128190; Upload &amp; Identify
          <input type="file" id="iupload" accept="image/*" style="display:none" onchange="identify('upload')">
        </label>
        <button class="btn btn-ghost" onclick="flashCtrl('on')">&#9889; Flash ON</button>
        <button class="btn btn-ghost" onclick="flashCtrl('off')">&#9888; Flash OFF</button>
      </div>
      <div id="result-panel">
        <div id="result">Capture 30+ images per class first, train, then identify.</div>
        <div id="details"></div>
        <div id="preview"></div>
      </div>
    </div>
  </div>

</main>

<script>
// ESP32 auto-connect (AP+STA) - check both 192.168.4.1 and esp32cam.local and STA IP
let espBase = localStorage.getItem('esp32_ip') || '192.168.4.1';
let espCandidates = [];
let staIpCache = '';
function getEspBase(){ let ip=localStorage.getItem('esp32_ip')||'192.168.4.1'; return ip.startsWith('http')?ip.replace(/\/$/,''):'http://'+ip; }
function updateCandidates(){
  let base=getEspBase();
  espCandidates=[base];
  if(staIpCache && !espCandidates.includes('http://'+staIpCache)) espCandidates.push('http://'+staIpCache);
  if(base.includes('192.168.4.1') && !espCandidates.includes('http://esp32cam.local')) espCandidates.push('http://esp32cam.local');
  if(base.includes('esp32cam.local') && !espCandidates.includes('http://192.168.4.1')) espCandidates.push('http://192.168.4.1');
}
updateCandidates();
let isHttps = location.protocol==='https:';

window.flashCtrl = function(state){
  let base=getEspBase();
  fetch(base+'/flash?state='+state).catch(()=>fetch('/esp32/flash?state='+state)).catch(()=>{});
};

// Stream loader with HTTPS mixed-content handling
window.loadStream = function(mode){
  updateCandidates();
  let url = mode==='proxy' ? '/proxy/stream' : getEspBase()+'/stream';
  let img=document.getElementById('stream');
  let fb=document.getElementById('stream_fallback');
  img.style.display='none'; fb.style.display='none';
  img.onerror=null; img.onload=null;
  img.onload=()=>{ img.style.display='block'; fb.style.display='none'; document.getElementById('esp32_extra').textContent='✅ Stream OK'; };
  img.onerror=()=>{
    if(mode==='direct' || !mode){
      // try proxy next
      console.warn('Direct stream failed, trying proxy', url);
      if(mode!=='proxy'){ loadStream('proxy'); return; }
    }
    img.style.display='none';
    fb.style.display='block';
    let msg=document.getElementById('stream_msg');
    if(isHttps){
      msg.innerHTML='<b style="color:#d97706">HTTPS blocks HTTP stream (mixed content).</b><br>1) Stay on <code>ESP32-CAM_AP</code> + mobile data ON, or join same home WiFi as ESP32 STA<br>2) <a href="'+getEspBase()+'/stream" target="_blank">Open http stream in new tab</a> always works<br>3) For embedded: 🔒 address bar → Site settings → Insecure content: Allow → Reload → Retry Direct<br>4) Or use STA: <a href="http://192.168.4.1/wifi" target="_blank">http://192.168.4.1/wifi</a> → join home WiFi → no hotspot switch';
    } else {
      msg.innerHTML='Connect to <code>ESP32-CAM_AP</code> or home WiFi with ESP32 STA, then <a href="'+getEspBase()+'/stream" target=_blank>'+getEspBase()+'/stream</a>';
    }
  };
  img.src=url;
  // timeout fallback
  setTimeout(()=>{ if(!img.complete || img.naturalWidth===0){ img.onerror(); } }, 6000);
}
loadStream('direct');

async function fetchEsp32Status(){
  updateCandidates();
  for(let base of espCandidates){
    try{
      let r=await fetch(base+'/status',{cache:'no-store'});
      if(!r.ok) throw new Error(r.status);
      let j=await r.json();
      if(j.sta_ip) staIpCache=j.sta_ip;
      return {online:true, via:'fetch', data:j, base};
    }catch(e){}
  }
  // proxy for HTTPS
  if(isHttps){
    try{
      let r=await fetch('/esp32/status',{cache:'no-store'});
      if(r.ok){ let j=await r.json(); if(j.sta_ip) staIpCache=j.sta_ip; return {online:true, via:'proxy', data:j, base:espCandidates[0]}; }
    }catch(e){}
    // image probe
    for(let base of espCandidates){
      let ok=await new Promise(res=>{
        let im=new Image(); let t=setTimeout(()=>{im.src=''; res(false)},4000);
        im.onload=()=>{clearTimeout(t); res(true)}; im.onerror=()=>{clearTimeout(t); res(false)};
        im.src=base+'/capture?_t='+Date.now();
      });
      if(ok) return {online:true, via:'image', data:{sta_ip:staIpCache}, base};
    }
  }
  return {online:false};
}

async function refreshHealth(){
  try{
    let r=await fetch('/health'); let j=await r.json();
    let dot=document.getElementById('model_dot');
    if(j.model_loaded){
      document.getElementById('model_status').innerText='Loaded: '+j.classes.join(', ');
      dot.className='dot dot-online';
    } else {
      document.getElementById('model_status').innerText='Not trained ('+j.dataset_images+' images collected)';
      dot.className='dot dot-warn';
    }
    // Show STA hint in banner if cloud
    if(j.is_cloud){
      document.getElementById('esp32_extra').textContent='☁️ Cloud - STA recommended';
    }
  }catch(e){}
  let s=await fetchEsp32Status();
  let el=document.getElementById('esp32stat');
  let banner=document.getElementById('esp_banner');
  if(s.online){
    let d=s.data; let staInfo=d.sta_ip?` STA:${d.sta_ip}`:'';
    el.innerHTML='<span class="dot dot-online"></span> ESP32: '+s.base+' via '+s.via+staInfo;
    if(d.sta_ip){
      localStorage.setItem('esp32_sta_ip', d.sta_ip);
      banner.style.display='block';
      banner.style.background='#d1fae5'; banner.style.color='#065f46'; banner.style.border='1px solid #a7f3d0';
      banner.innerHTML='✅ STA Connected: <b>http://'+d.sta_ip+'</b> (esp32cam.local) – <b>No hotspot switching!</b> <a href="http://192.168.4.1/wifi" target="_blank" style="color:#065f46">WiFi Setup</a> | <button class="btn btn-ghost" style="padding:2px 8px;font-size:.75rem" onclick="localStorage.setItem(\'esp32_ip\',\''+d.sta_ip+'\');location.reload()">Use STA IP</button>';
    } else if(s.via==='image'){
      banner.style.display='block'; banner.style.background='#fef3c7'; banner.style.color='#92400e';
      banner.innerHTML='🟡 Stream loads but JS fetch blocked by HTTPS – Allow insecure content for Capture buttons or use STA mode: <a href="http://192.168.4.1/wifi" target="_blank">wifi setup</a>';
    } else { banner.style.display='none'; }
  }else{
    el.innerHTML='<span class="dot dot-offline"></span> ESP32 offline &mdash; join ESP32-CAM_AP or home WiFi (STA)';
    if(isHttps){
      banner.style.display='block'; banner.style.background='#fef3c7'; banner.style.color='#92400e'; banner.style.border='1px solid #fcd34d';
      banner.innerHTML='⚠️ HTTPS blocks HTTP to ESP32 – Allow insecure content (🔒→Site settings→Insecure:Allow) or use <a href="http://192.168.4.1/wifi" target=_blank>STA WiFi</a> or Upload';
    } else { banner.style.display='none'; }
  }
}
setInterval(refreshHealth,5000); refreshHealth();

// Client-side ESP32 fetch for cloud (avoids Render cannot reach 192.168.4.1)
async function fetchEsp32BlobViaImage(url){
  return new Promise((resolve,reject)=>{
    let im=new Image(); im.crossOrigin='anonymous';
    let t=setTimeout(()=>{im.src=''; reject(new Error('Image timeout 12s'))},12000);
    im.onload=()=>{
      clearTimeout(t);
      try{
        let c=document.createElement('canvas'); c.width=im.naturalWidth||im.width; c.height=im.naturalHeight||im.height;
        if(!c.width) throw new Error('zero size');
        c.getContext('2d').drawImage(im,0,0);
        c.toBlob(b=>{
          if(!b) reject(new Error('Canvas taint'));
          else if(b.size<100) reject(new Error('empty'));
          else resolve(b);
        },'image/jpeg',0.92);
      }catch(e){ reject(e); }
    };
    im.onerror=()=>{clearTimeout(t); reject(new Error('Image load failed'));};
    im.src=url+(url.includes('?')?'&':'?')+'_t='+Date.now();
  });
}
async function fetchEsp32Blob(endpoint='/capture'){
  updateCandidates();
  let last=null;
  for(let base of espCandidates){
    let url=base+endpoint;
    try{
      let r=await fetch(url,{cache:'no-store'});
      if(!r.ok) throw new Error(r.status);
      let b=await r.blob(); if(b.size<100) throw new Error('empty');
      localStorage.setItem('esp32_ip', base.replace('http://',''));
      return b;
    }catch(e){
      let msg=String(e);
      let isMixed=isHttps && url.startsWith('http://') && (msg.includes('Failed')||msg.includes('fetch'));
      if(isMixed){
        try{
          let b=await fetchEsp32BlobViaImage(url);
          localStorage.setItem('esp32_ip', base.replace('http://',''));
          return b;
        }catch(ie){ last=ie; continue; }
      }
      last=e;
      if(base!==espCandidates[espCandidates.length-1]) continue;
      throw new Error('Cannot reach ESP32 at '+espCandidates.map(c=>c+endpoint).join(' or ')+'. STA: http://192.168.4.1/wifi');
    }
  }
  throw last;
}

window.getTabletExpiry = function(){
  let t=document.getElementById('tablet').value.trim();
  let e=document.getElementById('expiry').value.trim();
  if(!t||!e){ showMsg('collect_msg','Please enter tablet name + expiry (MM-YYYY) first.',true); return null; }
  return {tablet:t, expiry:e};
};
window.showMsg = function(id,txt,isErr){
  let el=document.getElementById(id);
  el.textContent=txt;
  el.className=isErr?'show err':'show';
};
window.collect = async function(src){
  let info=getTabletExpiry(); if(!info) return;
  showMsg('collect_msg','Saving image...',false);
  try{
    let res;
    if(src==='esp32'){
      // Cloud: browser fetches ESP32 then uploads (Render cannot reach 192.168.4.1)
      let isCloud = location.protocol==='https:';
      if(isCloud || true){
        try{
          let blob=await fetchEsp32Blob('/capture');
          let fd=new FormData(); fd.append('image', new File([blob],'cap.jpg',{type:'image/jpeg'})); fd.append('tablet',info.tablet); fd.append('expiry',info.expiry);
          res=await fetch('/collect_upload',{method:'POST',body:fd});
        }catch(fetchErr){
          // Fallback to backend /collect for local deployments
          if(String(fetchErr).includes('Mixed content') || String(fetchErr).includes('Browser blocked')){
            showMsg('collect_msg','⚠️ '+fetchErr.message+' — Use Upload or Allow insecure content, or STA mode (http://192.168.4.1/wifi)',true); return;
          }
          res=await fetch('/collect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(info)});
        }
      } else {
        res=await fetch('/collect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(info)});
      }
    }
    else{ let f=document.getElementById('cupload').files[0]; if(!f) return; let fd=new FormData(); fd.append('image',f); fd.append('tablet',info.tablet); fd.append('expiry',info.expiry); res=await fetch('/collect_upload',{method:'POST',body:fd}); }
    let d=await res.json();
    if(d.error){ showMsg('collect_msg','Error: '+d.error+' '+(d.details||d.hint||''),true); return; }
    showMsg('collect_msg','✓ Saved: '+d.saved_as+' (class: '+d.count_in_class+' imgs, total: '+d.total_images+' imgs)',false);
    refreshHealth();
  }catch(e){ showMsg('collect_msg','Failed: '+e,true); }
}
window.showResult = function(d,preview){
  let top=d.top1;
  let cls=top.is_expired?'expired':(top.days_left!==null&&top.days_left<90?'warn':'valid');
  let icon=top.is_expired?'❌':(top.days_left!==null&&top.days_left<90?'⚠️':'✅');
  let flag=top.is_expired===null?'':(top.is_expired?'EXPIRED':(top.days_left<90?'EXPIRES SOON':'VALID'));
  document.getElementById('result').innerHTML=
    '<span class="status-badge '+cls+'">'+icon+' '+top.tablet+' &nbsp;│&nbsp; Exp: '+top.expiry+' &nbsp;│&nbsp; '+flag+'</span>'+
    ' <small style="color:var(--text-muted);font-weight:400">'+( top.conf*100).toFixed(1)+'% confidence</small>';
  let html='<strong>Top-3:</strong> '+d.top3.map(x=>'<code>'+x.tablet+' '+x.expiry+'</code> ('+( x.conf*100).toFixed(1)+'%)').join(' · ');
  html+=' &nbsp;•&nbsp; <span style="color:var(--text-light)">Inference: '+d.inference_ms+'ms</span>';
  document.getElementById('details').innerHTML=html;
  document.getElementById('preview').innerHTML='<img src="'+preview+'" alt="Captured tablet">';
};
window.identify = async function(src){
  document.getElementById('result').textContent='⏳ Analysing…';
  document.getElementById('details').innerHTML='';
  document.getElementById('preview').innerHTML='';
  try{
    let res;
    if(src==='esp32'){
      let isCloud = location.protocol==='https:';
      if(isCloud || true){
        try{
          let blob=await fetchEsp32Blob('/capture');
          let fd=new FormData(); fd.append('image', new File([blob],'cap.jpg',{type:'image/jpeg'}));
          res=await fetch('/identify_upload',{method:'POST',body:fd});
        }catch(fetchErr){
          if(String(fetchErr).includes('Mixed content') || String(fetchErr).includes('Browser blocked')){
            document.getElementById('result').textContent='⚠️ '+fetchErr.message;
            return;
          }
          res=await fetch('/identify',{method:'POST'});
        }
      } else {
        res=await fetch('/identify',{method:'POST'});
      }
    }
    else{ let f=document.getElementById('iupload').files[0]; if(!f) return; let fd=new FormData(); fd.append('image',f); res=await fetch('/identify_upload',{method:'POST',body:fd}); }
    let d=await res.json();
    if(d.error){ document.getElementById('result').textContent='❌ '+d.error+' '+(d.details||d.hint||''); return; }
    showResult(d,d.preview);
  }catch(e){ document.getElementById('result').textContent='❌ Failed: '+e; }
}
</script>
</body>
</html>
"""

@app.route("/")
def index():
    return render_template_string(HTML_PAGE)

STUDIO_HTML = """
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Studio - Direct STA 192.168.1.7</title>
<style>
  *{box-sizing:border-box} body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;margin:0}
  header{background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 20px;display:flex;align-items:center;gap:10px;position:sticky;top:0}
  .mark{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#0e7490,#06b6d4);display:grid;place-items:center;color:#fff;font-size:18px}
  main{max-width:900px;margin:0 auto;padding:18px 14px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:16px;margin:14px 0;box-shadow:0 1px 3px rgba(15,23,42,.08)}
  input{padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;width:100%}
  input:focus{outline:none;border-color:#0e7490;box-shadow:0 0 0 4px rgba(14,116,144,.12)}
  .btn{padding:10px 16px;border-radius:999px;border:1px solid transparent;font-weight:600;cursor:pointer}
  .primary{background:#0e7490;color:#fff} .secondary{background:#fff;border-color:#e2e8f0}
  #stream{width:100%;border-radius:12px;background:#000;min-height:340px;object-fit:cover;display:block}
  .small{font-size:.78rem;color:#64748b} code{background:#f1f5f9;padding:2px 6px;border-radius:6px;border:1px solid #e2e8f0}
</style></head><body>
<header><div class="mark">💊</div><div><b>Studio — Direct STA</b><div class="small">Hardcoded 192.168.1.7 · Airtel_priy_0001 · no hotspot switch</div></div>
<a href="/" style="margin-left:auto" class="btn secondary">MediScan</a></header>
<main>
  <div class="card" style="padding:0;overflow:hidden">
    <div style="padding:10px 14px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:8px;font-size:.75rem;font-weight:700;color:#0e7490;letter-spacing:.04em">● LIVE — http://192.168.1.7/stream <span id="ok" style="margin-left:auto;color:#94a3b8">loading…</span></div>
    <img id="stream" src="http://192.168.1.7/stream" alt="ESP32" onload="document.getElementById('ok').textContent='● live';document.getElementById('ok').style.color='#0d9488'" onerror="document.getElementById('ok').textContent='● retrying…'; setTimeout(()=>{document.getElementById('stream').src='http://192.168.1.7/stream?_t='+Date.now()},1500)">
    <div style="padding:10px 14px;display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn secondary" href="http://192.168.1.7/stream" target="_blank">Open direct</a>
      <a class="btn secondary" href="http://192.168.1.7/capture" target="_blank">Test capture</a>
      <a class="btn secondary" href="http://192.168.1.7/wifi" target="_blank">WiFi Setup</a>
      <span class="small" style="align-self:center">If black, PC not on Airtel_priy_0001</span>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 10px">1 — Collect from Studio</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <input id="tablet" placeholder="Tablet e.g. Crocin" style="flex:1">
      <input id="expiry" placeholder="MM-YYYY e.g. 08-2029" style="max-width:160px">
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn primary" onclick="collectStudio()">📷 Capture from 192.168.1.7 & Save</button>
      <label class="btn secondary">📁 Upload & Save <input type="file" id="up" accept="image/*" style="display:none" onchange="upload()"></label>
    </div>
    <div id="msg" class="small" style="margin-top:10px;white-space:pre-wrap"></div>
    <p class="small" style="margin-top:8">Saves to <code>dataset/Tablet__MM-YYYY/</code> · needs 30-50 per batch</p>
  </div>

  <div class="card">
    <h3>2 — Train</h3>
    <pre class="small" style="background:#f8fafc;padding:12px;border-radius:10px;border:1px solid #e2e8f0">pip install -r requirements.txt
python train_tablets.py --data dataset --epochs 20
# creates tablet_classifier.pth + classes.json -> Restart server</pre>
  </div>
</main>
<script>
async function collectStudio(){
  let t=document.getElementById('tablet').value.trim(), e=document.getElementById('expiry').value.trim();
  if(!t||!e){ document.getElementById('msg').textContent='Enter tablet + expiry'; return }
  if(!/^(0[1-9]|1[0-2])-(20\\d{2})$/.test(e)){ document.getElementById('msg').textContent='Expiry MM-YYYY'; return }
  document.getElementById('msg').textContent='⏳ Capturing from http://192.168.1.7/capture …';
  try{
    let r=await fetch('http://192.168.1.7/capture',{cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    let b=await r.blob();
    let fd=new FormData(); fd.append('image', new File([b],'cap.jpg',{type:'image/jpeg'})); fd.append('tablet',t); fd.append('expiry',e);
    let res=await fetch('/collect_upload',{method:'POST',body:fd});
    let j=await res.json();
    if(j.error) throw new Error(j.error);
    document.getElementById('msg').textContent='✅ Saved '+j.saved_as+' · '+j.count_in_class+' in batch · '+j.total_images+' total';
  }catch(err){
    document.getElementById('msg').textContent='❌ '+err.message+' — Try Upload or open http://192.168.1.7/capture in new tab to test';
  }
}
async function upload(){
  let f=document.getElementById('up').files[0]; if(!f) return;
  let t=document.getElementById('tablet').value.trim(), e=document.getElementById('expiry').value.trim();
  if(!t||!e){ document.getElementById('msg').textContent='Enter tablet + expiry'; return }
  let fd=new FormData(); fd.append('image',f); fd.append('tablet',t); fd.append('expiry',e);
  let r=await fetch('/collect_upload',{method:'POST',body:fd}); let j=await r.json();
  document.getElementById('msg').textContent = j.error ? '❌ '+j.error : '✅ Uploaded '+j.saved_as;
}
</script>
</body></html>
"""
@app.route("/studio")
def studio():
    return render_template_string(STUDIO_HTML)


def dataset_stats():
    if not DATASET_DIR.exists():
        return 0, {}
    counts = {}
    total = 0
    for sub in DATASET_DIR.iterdir():
        if sub.is_dir():
            n = len(list(sub.glob("*.jpg"))) + len(list(sub.glob("*.jpeg"))) + len(list(sub.glob("*.png")))
            counts[sub.name] = n
            total += n
    return total, counts


@app.route("/ping")
def ping():
    return jsonify({"status": "alive", "time": time.time()})


@app.route("/health")
def health():
    total, counts = dataset_stats()
    # Probe STA quickly for hint
    sta_hint = "STA 192.168.1.7" if any("192.168.1" in c for c in ESP32_CANDIDATES) else ""
    return jsonify({
        "model_loaded": model is not None,
        "classes": classes,
        "dataset_images": total,
        "dataset_counts": counts,
        "torch": TORCH_OK,
        "esp32": ESP32_IP,
        "esp32_url": ESP32_CAPTURE_URL,
        "esp32_stream": ESP32_STREAM_URL,
        "esp32_candidates": ESP32_CANDIDATES,
        "is_cloud": IS_CLOUD,
        "hint": f"Local: trying {ESP32_CANDIDATES}. STA is http://192.168.1.7 (Airtel). Set ESP32_IP=192.168.1.7 or open http://192.168.1.7/stream. Cloud: use browser fetch http://192.168.1.7/capture." if not IS_CLOUD else "Cloud cannot reach local - browser must fetch directly",
        "today": date.today().isoformat(),
    })


@app.route("/collect", methods=["POST"])
def collect():
    data = request.get_json(force=True, silent=True) or {}
    folder, err = safe_folder(data.get("tablet", ""), data.get("expiry", ""))
    if err:
        return jsonify({"error": err}), 400
    img, ferr = fetch_esp32()
    if ferr:
        return jsonify({"error": "Cannot reach ESP32 from backend",
                        "details": ferr,
                        "hint": "On cloud (Render) backend CAN'T reach 192.168.4.1. Use client-side: fetch http://192.168.4.1/capture in browser (must be on ESP32-CAM_AP WiFi) then POST blob to /collect_upload. Frontend smartCollect does this automatically. Or run server locally: python app.py while PC is on ESP32-CAM_AP",
                        "fix": "Frontend should call POST /collect_upload with image blob instead of POST /collect"
                        }), 500
    path = save_image(img, folder)
    total, counts = dataset_stats()
    return jsonify({"saved_as": str(path.relative_to(BASE_DIR)), "count_in_class": counts.get(folder, 0),
                    "total_images": total, "preview": preview_b64(img)})


@app.route("/collect_upload", methods=["POST"])
def collect_upload():
    if "image" not in request.files:
        return jsonify({"error": "No image"}), 400
    folder, err = safe_folder(request.form.get("tablet", ""), request.form.get("expiry", ""))
    if err:
        return jsonify({"error": err}), 400
    img = Image.open(request.files["image"].stream).convert("RGB")
    path = save_image(img, folder)
    total, counts = dataset_stats()
    return jsonify({"saved_as": str(path.relative_to(BASE_DIR)), "count_in_class": counts.get(folder, 0),
                    "total_images": total})


def run_predict(pil_img):
    if model is None:
        total, _ = dataset_stats()
        return jsonify({"error": "Model not trained yet",
                        "details": f"Collected {total} images. Run: python train_tablets.py --data dataset --epochs 20"}), 400
    out = predict(pil_img)
    if out is None:
        return jsonify({"error": "Prediction failed"}), 500
    top3, ms = out
    return jsonify({"top1": top3[0], "top3": top3, "inference_ms": ms,
                    "preview": preview_b64(pil_img)})


@app.route("/identify", methods=["POST", "GET"])
def identify():
    img, err = fetch_esp32()
    if err:
        return jsonify({"error": "Cannot reach ESP32 from backend", "details": err,
                        "hint": "Cloud backend can't reach local 192.168.4.1. Frontend must fetch http://192.168.4.1/capture client-side then POST to /identify_upload. Or use Upload button.",
                        "fix": "Use /identify_upload with image file instead"}), 500
    return run_predict(img)


@app.route("/identify_upload", methods=["POST"])
def identify_upload():
    if "image" not in request.files:
        return jsonify({"error": "No image"}), 400
    img = Image.open(request.files["image"].stream).convert("RGB")
    return run_predict(img)


@app.route("/reload_model", methods=["POST"])
def reload_model():
    ok = load_model()
    return jsonify({"model_loaded": ok, "classes": classes})


@app.route("/proxy/stream")
def proxy_stream():
    for cand in ESP32_CANDIDATES:
        url = f"http://{cand}/stream"
        try:
            r = requests.get(url, stream=True, timeout=5)
            return Response(r.iter_content(chunk_size=1024), content_type=r.headers.get("Content-Type", "multipart/x-mixed-replace; boundary=frame"),
                            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"})
        except Exception:
            continue
    return jsonify({"error": "ESP32 unreachable from backend", "details": f"tried {ESP32_CANDIDATES}",
                    "hint": "Local backend tried AP and STA (192.168.1.7, esp32cam.local). Ensure PC on same WiFi as ESP32 STA. Set ESP32_IP=192.168.1.7 env if needed. On Render cloud proxy always fails - use direct http://192.168.1.7/stream."}), 502


@app.route("/esp32/<path:subpath>")
def esp32_proxy(subpath):
    last = None
    for cand in ESP32_CANDIDATES:
        url = f"http://{cand}/{subpath}"
        if request.query_string:
            url += "?" + request.query_string.decode()
        try:
            r = requests.get(url, timeout=5)
            resp = Response(r.content, content_type=r.headers.get("Content-Type", "application/octet-stream"), status=r.status_code)
            resp.headers["Access-Control-Allow-Origin"] = "*"
            return resp
        except Exception as e:
            last = str(e)
            continue
    return jsonify({"error": last, "hint": f"Backend tried {ESP32_CANDIDATES} for /{subpath}. On cloud fails - browser fetch directly http://192.168.1.7/{subpath} or esp32cam.local."}), 502

@app.route("/esp32/<path:subpath>", methods=["OPTIONS"])
def esp32_proxy_options(subpath):
    resp = jsonify({"ok": True})
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "*"
    return resp


if __name__ == "__main__":
    print("=" * 60)
    print("Tablet + Expiry Trainer & Checker (no YOLO)")
    print("1. Connect PC to WiFi ESP32-CAM_AP (12345678)")
    print("2. Open http://localhost:5000 -> Step1 Collect with tablet+expiry")
    print("3. python train_tablets.py --data dataset --epochs 20")
    print("4. Restart server -> Step3 Identify predicts tablet + expiry")
    print(f"Model: {'LOADED '+str(classes) if model else 'NOT TRAINED'}")
    print("=" * 60)
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
