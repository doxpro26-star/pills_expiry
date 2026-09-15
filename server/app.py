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
    CORS(app, resources={r"/*": {"origins": "*"}})

ESP32_IP = os.environ.get("ESP32_IP", "192.168.4.1")
ESP32_CAPTURE_URL = f"http://{ESP32_IP}/capture"
ESP32_STREAM_URL = f"http://{ESP32_IP}/stream"

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
    try:
        r = requests.get(ESP32_CAPTURE_URL, timeout=7)
        if r.status_code != 200:
            return None, f"ESP32 returned {r.status_code}"
        return Image.open(io.BytesIO(r.content)).convert("RGB"), None
    except Exception as e:
        return None, f"{e} - connect to WiFi ESP32-CAM_AP"


HTML_PAGE = """
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tablet + Expiry Trainer & Checker</title>
<style>
body{font-family:Arial;text-align:center;background:#0f172a;color:#fff;margin:0}
h2{background:#0ea5e9;margin:0;padding:14px}
#stream{width:100%;max-width:800px;border-radius:10px;margin-top:12px;background:#000;min-height:300px}
.btn{padding:12px 20px;margin:6px;font-size:15px;border:0;border-radius:8px;cursor:pointer}
.primary{background:#0ea5e9;color:#fff} .green{background:#16a34a;color:#fff} .secondary{background:#334155;color:#fff}
.card{background:#1e293b;max-width:800px;margin:12px auto;padding:16px;border-radius:10px;text-align:left}
input{padding:10px;margin:4px;border-radius:6px;border:1px solid #475569;width:200px}
#result{font-size:20px;font-weight:bold}
small{color:#94a3b8}
.expired{color:#f87171} .valid{color:#4ade80} .warn{color:#facc15}
code{background:#020617;padding:2px 6px;border-radius:4px}
</style>
</head>
<body>
<h2>Tablet + Expiry: Collect, Train, Check (No YOLO)</h2>
<img id="stream" src="http://192.168.4.1/stream" onerror="this.src='/proxy/stream'; this.onerror=null" />
<div class="card">
  <b>Step 1 - Collect (give tablet + expiry while capturing):</b><br>
  <input id="tablet" placeholder="Tablet name e.g. Crocin">
  <input id="expiry" placeholder="Expiry MM-YYYY e.g. 12-2025"><br>
  <button class="btn green" onclick="collect('esp32')">Capture from ESP32 & Save</button>
  <label class="btn secondary" style="display:inline-block">Upload & Save<input type="file" id="cupload" accept="image/*" style="display:none" onchange="collect('upload')"></label>
  <div id="collect_msg" style="margin-top:8px;color:#cbd5e1"></div>
  <small>Tip: capture 30-50 photos per tablet+expiry (different angles, flash on/off). Saved to <code>dataset/Tablet__MM-YYYY/</code></small>
</div>
<div class="card">
  <b>Step 2 - Train (on laptop):</b><br>
  <code>pip install -r requirements.txt</code><br>
  <code>python train_tablets.py --data dataset --epochs 20</code><br>
  <small>Generates <code>tablet_classifier.pth</code> + <code>classes.json</code>, then restart this server. Status: <span id="model_status">checking</span></small>
</div>
<div class="card">
  <b>Step 3 - Check (predict tablet + expiry):</b><br>
  <button class="btn primary" onclick="identify('esp32')">Identify from ESP32</button>
  <label class="btn secondary" style="display:inline-block">Upload & Identify<input type="file" id="iupload" accept="image/*" style="display:none" onchange="identify('upload')"></label>
  <button class="btn secondary" onclick="fetch('http://192.168.4.1/flash?state=on').catch(()=>fetch('/esp32/flash?state=on'))">Flash ON</button>
  <button class="btn secondary" onclick="fetch('http://192.168.4.1/flash?state=off').catch(()=>fetch('/esp32/flash?state=off'))">Flash OFF</button>
  <div id="result" style="margin-top:10px">Capture 30+ images per class first, train, then identify</div>
  <div id="details" style="margin-top:10px;color:#cbd5e1"></div>
  <div id="preview" style="margin-top:10px"></div>
  <div id="esp32stat" style="margin-top:8px"><small>ESP32: checking...</small></div>
</div>
<script>
async function refreshHealth(){
  try{ let r=await fetch('/health'); let j=await r.json();
    document.getElementById('model_status').innerText = j.model_loaded ? ('LOADED: '+j.classes.join(', ')) : 'NOT TRAINED YET ('+j.dataset_images+' images collected)';
  }catch(e){}
  try{ let r=await fetch('/esp32/status'); let j=await r.json(); document.getElementById('esp32stat').innerHTML='<small>ESP32: '+j.ip+' | clients:'+j.clients+'</small>'; }catch(e){ document.getElementById('esp32stat').innerHTML='<small>ESP32 not reachable - join ESP32-CAM_AP</small>'; }
}
setInterval(refreshHealth,3000); refreshHealth();
function getTabletExpiry(){
  let t=document.getElementById('tablet').value.trim();
  let e=document.getElementById('expiry').value.trim();
  if(!t||!e){ document.getElementById('collect_msg').innerText='Enter tablet + expiry MM-YYYY first'; return null; }
  return {tablet:t, expiry:e};
}
async function collect(src){
  let info=getTabletExpiry(); if(!info) return;
  document.getElementById('collect_msg').innerText='Saving...';
  try{
    let res;
    if(src==='esp32'){ res=await fetch('/collect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(info)}); }
    else{ let f=document.getElementById('cupload').files[0]; if(!f) return; let fd=new FormData(); fd.append('image',f); fd.append('tablet',info.tablet); fd.append('expiry',info.expiry); res=await fetch('/collect_upload',{method:'POST',body:fd}); }
    let d=await res.json();
    document.getElementById('collect_msg').innerText = d.error ? ('Error: '+d.error) : ('Saved: '+d.saved_as+' (total in class: '+d.count_in_class+', all images: '+d.total_images+')');
    refreshHealth();
  }catch(e){ document.getElementById('collect_msg').innerText='Failed: '+e; }
}
function showResult(d, preview){
  let top=d.top1;
  let cls = top.is_expired ? 'expired' : (top.days_left!==null && top.days_left<90 ? 'warn' : 'valid');
  let flag = top.is_expired===null ? '' : (top.is_expired ? 'EXPIRED' : (top.days_left<90 ? 'EXPIRES SOON' : 'VALID'));
  document.getElementById('result').innerHTML='<span class='+cls+'>'+top.tablet+' | '+top.expiry+' | '+flag+' ('+(top.conf*100).toFixed(1)+'%)</span>';
  let html='Top-3: '+d.top3.map(x=>x.tablet+' '+x.expiry+' ('+(x.conf*100).toFixed(1)+'%)').join(' | ');
  html+='<br>Time: '+d.inference_ms+'ms';
  document.getElementById('details').innerHTML=html;
  document.getElementById('preview').innerHTML='<img src="'+preview+'" style="max-width:300px;border-radius:8px">';
}
async function identify(src){
  document.getElementById('result').innerText='Predicting...';
  try{
    let res;
    if(src==='esp32'){ res=await fetch('/identify',{method:'POST'}); }
    else{ let f=document.getElementById('iupload').files[0]; if(!f) return; let fd=new FormData(); fd.append('image',f); res=await fetch('/identify_upload',{method:'POST',body:fd}); }
    let d=await res.json();
    if(d.error){ document.getElementById('result').innerText='Error: '+d.error+' '+(d.details||''); return; }
    showResult(d, d.preview);
  }catch(e){ document.getElementById('result').innerText='Failed: '+e; }
}
</script>
</body>
</html>
"""

@app.route("/")
def index():
    return render_template_string(HTML_PAGE)


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
    return jsonify({
        "model_loaded": model is not None,
        "classes": classes,
        "dataset_images": total,
        "dataset_counts": counts,
        "torch": TORCH_OK,
        "esp32": ESP32_IP,
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
        return jsonify({"error": "Cannot reach ESP32", "details": ferr}), 500
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
        return jsonify({"error": "Cannot reach ESP32", "details": err}), 500
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
    try:
        r = requests.get(ESP32_STREAM_URL, stream=True, timeout=5)
        return Response(r.iter_content(chunk_size=1024), content_type=r.headers.get("Content-Type"))
    except Exception as e:
        return f"ESP32 unreachable: {e}", 502


@app.route("/esp32/<path:subpath>")
def esp32_proxy(subpath):
    try:
        url = f"http://{ESP32_IP}/{subpath}"
        if request.query_string:
            url += "?" + request.query_string.decode()
        r = requests.get(url, timeout=5)
        return Response(r.content, content_type=r.headers.get("Content-Type"), status=r.status_code)
    except Exception as e:
        return jsonify({"error": str(e)}), 502


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
