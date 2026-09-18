#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ESPmDNS.h>

// ====== Hotspot (AP) Configuration - always available as fallback ======
const char* ssid = "ESP32-CAM_AP";
const char* password = "12345678"; // min 8 chars, leave "" for open hotspot

// ====== STA Configuration - ESP32 connects to your home WiFi (auto website access, no hotspot switching) ======
// Option 1: Hardcode your WiFi here (edit before upload) - leave "" to disable STA at first boot
String sta_ssid = ""; // e.g. "MyHomeWiFi"
String sta_pass = ""; // e.g. "mywifipass123"
// Option 2: Leave above empty and configure via http://192.168.4.1/wifi after connecting to ESP32-CAM_AP
// Credentials are saved in NVS and auto-used on next boot

Preferences prefs;
String sta_ip_cache = "";
bool sta_connected = false;

// ====== AI-Thinker ESP32-CAM Pins ======
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define LED_FLASH_PIN      4  // Flash LED

WebServer server(80);

// Load saved STA credentials from NVS
void loadStaCreds() {
  prefs.begin("wifi", true);
  String s = prefs.getString("sta_ssid", "");
  String p = prefs.getString("sta_pass", "");
  prefs.end();
  if (s.length() > 0) { sta_ssid = s; sta_pass = p; }
  Serial.printf("STA creds loaded: ssid='%s' %s\n", sta_ssid.c_str(), sta_ssid.length()?"(from NVS)":"(empty - configure via /wifi)");
}

void saveStaCreds(String s, String p) {
  prefs.begin("wifi", false);
  prefs.putString("sta_ssid", s);
  prefs.putString("sta_pass", p);
  prefs.end();
  Serial.printf("STA creds saved: ssid='%s'\n", s.c_str());
}

// HTML Page for monitoring
const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESP32-CAM Monitor</title>
<style>
 body{font-family:Arial;text-align:center;margin:0;background:#111;color:#fff}
 h2{background:#1a73e8;margin:0;padding:12px}
 #stream{width:100%;max-width:800px;border-radius:8px;margin-top:10px;background:#000}
 .btn{padding:10px 18px;margin:8px;font-size:16px;border:0;border-radius:6px;cursor:pointer}
 .on{background:#1a73e8;color:#fff} .off{background:#333;color:#fff}
 .row{margin:10px}
 small{color:#aaa}
 .status{margin:12px auto;max-width:800px;background:#222;padding:12px;border-radius:8px;text-align:left;font-size:13px;line-height:1.8}
 .ok{color:#4ade80} .warn{color:#facc15} .err{color:#f87171}
 input{padding:8px;margin:4px;border:1px solid #555;border-radius:4px;background:#000;color:#fff;width:220px}
</style>
</head>
<body>
<h2>ESP32-CAM 20+FPS Monitor - AP+STA Auto-Connect</h2>
<img id="stream" src="/stream" />
<div class="row">
  <button class="btn on" onclick="fetch('/flash?state=on')">Flash ON</button>
  <button class="btn off" onclick="fetch('/flash?state=off')">Flash OFF</button>
  <button class="btn on" onclick="window.open('/capture','_blank')">Capture HD Photo (1600x1200)</button>
</div>
<div class="row">
  <button class="btn off" onclick="fetch('/res?val=10')">HD 800x600 (25fps)</button>
  <button class="btn off" onclick="fetch('/res?val=9')">XGA 1024x768 (~18fps)</button>
  <button class="btn off" onclick="fetch('/res?val=13')">UXGA 1600x1200 (~8fps)</button>
</div>
<div id="st" class="status">Loading status...</div>
<script>
fetch('/status').then(r=>r.json()).then(j=>{
  let html = `<b>AP Hotspot:</b> ${j.ap_ssid} | <b>AP IP:</b> ${j.ap_ip} | Clients: ${j.clients}<br>`;
  html += `<b>STA WiFi:</b> ${j.sta_ssid||'(not configured)'} | <b>STA IP:</b> <span class="${j.sta_connected?'ok':'err'}">${j.sta_ip||'disconnected'}</span> ${j.sta_connected?'<span class=ok>● Connected - NO hotspot switching needed!</span>':'<span class=warn>● Not connected - <a style=color:#facc15 href=/wifi>Configure WiFi</a></span>'}<br>`;
  if(j.sta_ip) html += `<b>Access URLs:</b> <a style=color:#8ab4f8 href="http://${j.sta_ip}/">http://${j.sta_ip}/</a> | <a style=color:#8ab4f8 href="http://${j.sta_ip}/stream">/stream</a> | <a style=color:#8ab4f8 href="http://${j.sta_ip}/capture">/capture</a> (use this IP in website) | mDNS: <a style=color:#8ab4f8 href="http://esp32cam.local/">esp32cam.local</a><br>`;
  html += `<b>AP URL (fallback):</b> <a style=color:#8ab4f8 href="http://192.168.4.1/">http://192.168.4.1/</a> | <small>Stream: SVGA | Photo: UXGA | PSRAM: ${j.psram}</small><br>`;
  html += `<a style=color:#facc15 href="/wifi">📶 WiFi Setup</a> - Connect ESP32 to your home WiFi to remove hotspot switching`;
  document.getElementById('st').innerHTML = html;
}).catch(e=>{document.getElementById('st').innerHTML='Status failed: '+e});
</script>
<p><a style="color:#8ab4f8" href="/stream">/stream</a> | <a style="color:#8ab4f8" href="/capture">/capture</a> | <a style="color:#facc15" href="/wifi">/wifi</a></p>
</body>
</html>
)rawliteral";

// WiFi Setup Page
const char wifi_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>WiFi Setup</title><style>body{font-family:Arial;background:#111;color:#fff;text-align:center;margin:0}h2{background:#1a73e8;margin:0;padding:12px}.card{max-width:420px;margin:24px auto;background:#222;padding:20px;border-radius:8px}input{width:90%;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #555;background:#000;color:#fff}button{padding:12px 24px;background:#1a73e8;color:#fff;border:0;border-radius:6px;font-size:16px;cursor:pointer;width:95%}a{color:#8ab4f8}small{color:#aaa}</style></head><body><h2>📶 Connect ESP32 to Home WiFi</h2><div class="card">
<p><b>Remove hotspot switching:</b> Enter your home WiFi. ESP32 will join it and get IP like 192.168.1.x - then website on same WiFi can reach it without connecting to ESP32-CAM_AP.</p>
<p>Current STA: <span id="cur">loading...</span></p>
<form action="/savewifi" method="POST">
<input name="ssid" placeholder="WiFi SSID (e.g. JioFiber_2.4G)" required>
<input name="pass" placeholder="WiFi Password" type="password">
<button type="submit">Save & Connect</button>
</form>
<p><small>After save ESP32 reboots and tries to connect (10s). Keep hotspot ESP32-CAM_AP as fallback - if STA fails it stays accessible at 192.168.4.1.</small></p>
<p><a href="/">← Back to Camera</a> | <a href="/status">Status JSON</a></p>
</div><script>fetch('/status').then(r=>r.json()).then(j=>{document.getElementById('cur').innerText=j.sta_ssid?j.sta_ssid+' ('+(j.sta_connected?'✅ '+j.sta_ip:'❌ disconnected')+')':'(not configured)';});</script></body></html>
)rawliteral";

void handleCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
}

void handleRoot() {
  handleCors();
  server.send_P(200, "text/html", index_html);
}

void handleStatus() {
  handleCors();
  String json = "{";
  json += "\"ap_ssid\":\"" + String(ssid) + "\",";
  json += "\"ap_ip\":\"" + WiFi.softAPIP().toString() + "\",";
  json += "\"clients\":" + String(WiFi.softAPgetStationNum()) + ",";
  // Legacy fields for old frontend
  json += "\"ssid\":\"" + String(ssid) + "\",";
  json += "\"ip\":\"" + (sta_connected ? WiFi.localIP().toString() : WiFi.softAPIP().toString()) + "\",";
  json += "\"sta_ssid\":\"" + sta_ssid + "\",";
  json += "\"sta_ip\":\"" + (sta_connected ? WiFi.localIP().toString() : "") + "\",";
  json += "\"sta_connected\":" + String(sta_connected ? "true" : "false") + ",";
  json += "\"mdns\":\"esp32cam.local\",";
  sensor_t * s = esp_camera_sensor_get();
  framesize_t fs = s ? s->status.framesize : FRAMESIZE_SVGA;
  json += "\"framesize\":" + String((int)fs) + ",";
  json += "\"psram\":" + String(psramFound() ? "true" : "false");
  json += "}";
  server.send(200, "application/json", json);
}

void handleWifiPage() {
  handleCors();
  server.send_P(200, "text/html", wifi_html);
}

void handleSaveWifi() {
  handleCors();
  if (!server.hasArg("ssid")) { server.send(400, "text/plain", "Missing ssid"); return; }
  String s = server.arg("ssid");
  String p = server.arg("pass");
  s.trim(); p.trim();
  if (s.length()==0 || s.length()>32) { server.send(400, "text/plain", "Invalid SSID"); return; }
  saveStaCreds(s, p);
  String resp = "<html><body style='font-family:Arial;background:#111;color:#fff;text-align:center;padding:40px'><h2 style='color:#4ade80'>✅ Saved! Rebooting...</h2><p>SSID: " + s + "</p><p>ESP32 will reboot and join your WiFi in 10s. Then check Serial or <a style=color:#8ab4f8 href='/status'>/status</a> for new STA IP.</p><p>If STA fails, hotspot 192.168.4.1 remains available.</p><p><a style=color:#8ab4f8 href='/'>Back</a></p></body></html>";
  server.send(200, "text/html", resp);
  delay(800);
  ESP.restart();
}

void handleClearWifi() {
  saveStaCreds("", "");
  server.send(200, "text/plain", "Cleared - rebooting");
  delay(500);
  ESP.restart();
}

void handleOptions() {
  handleCors();
  server.send(204, "text/plain", "");
}

void handleCapture() {
  // Handle CORS preflight
  if (server.method() == HTTP_OPTIONS) { handleOptions(); return; }
  handleCors();
  server.sendHeader("Cross-Origin-Resource-Policy", "cross-origin");
  server.sendHeader("Cache-Control", "no-cache, no-store");
  // Take HIGH-RES photo (UXGA) even though stream is SVGA for speed
  sensor_t * s = esp_camera_sensor_get();
  bool switched = false;
  if (s && psramFound()) {
    s->set_framesize(s, FRAMESIZE_UXGA); // switch to 1600x1200 for photo
    delay(300); // let sensor settle
    switched = true;
  }
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    if (switched) { s->set_framesize(s, FRAMESIZE_SVGA); delay(100); }
    server.send(500, "text/plain", "Camera capture failed");
    return;
  }
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Cross-Origin-Resource-Policy", "cross-origin");
  server.sendHeader("Content-Disposition", "inline; filename=capture.jpg");
  server.sendHeader("Cache-Control", "no-cache");
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  WiFiClient client = server.client();
  client.write(fb->buf, fb->len);
  esp_camera_fb_return(fb);
  // Switch back to fast streaming resolution
  if (switched) {
    s->set_framesize(s, FRAMESIZE_SVGA);
    delay(100);
  }
}

void handleStream() {
  WiFiClient client = server.client();
  String response = "HTTP/1.1 200 OK\r\n";
  response += "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n";
  response += "Access-Control-Allow-Origin: *\r\n";
  response += "Access-Control-Allow-Methods: GET, OPTIONS\r\n";
  response += "Cross-Origin-Resource-Policy: cross-origin\r\n";
  response += "Cross-Origin-Embedder-Policy: unsafe-none\r\n\r\n";
  server.sendContent(response);

  while (client.connected()) {
    camera_fb_t * fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Camera capture failed");
      continue;
    }

    response = "--frame\r\n";
    response += "Content-Type: image/jpeg\r\n";
    response += "Content-Length: " + String(fb->len) + "\r\n\r\n";
    server.sendContent(response);
    client.write(fb->buf, fb->len);
    server.sendContent("\r\n");

    esp_camera_fb_return(fb);

    if (!client.connected()) break;
    delay(30); // SVGA optimized for 20-25 fps (use 1-10 for max speed)
  }
}

void handleFlash() {
  handleCors();
  String state = server.arg("state");
  if (state == "on") {
    digitalWrite(LED_FLASH_PIN, HIGH);
    server.send(200, "text/plain", "Flash ON");
  } else {
    digitalWrite(LED_FLASH_PIN, LOW);
    server.send(200, "text/plain", "Flash OFF");
  }
}

void handleResolution() {
  handleCors();
  if (!server.hasArg("val")) {
    server.send(400, "text/plain", "Missing val");
    return;
  }
  int val = server.arg("val").toInt();
  sensor_t * s = esp_camera_sensor_get();
  if (s) {
    // val matches framesize enum: 5=QVGA 6=CIF 8=VGA 9=XGA 10=SVGA 12=SXGA 13=UXGA
    if (s->set_framesize(s, (framesize_t)val) == 0) {
      server.send(200, "text/plain", "Resolution set to " + String(val));
      Serial.printf("Resolution changed to %d\n", val);
      return;
    }
  }
  server.send(500, "text/plain", "Failed");
}

void initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  // BALANCED FOR 20+ FPS: SVGA 800x600 streams at ~25fps, photo still at UXGA 1600x1200
  config.frame_size = FRAMESIZE_SVGA; // 800x600 for 20+ fps
  config.jpeg_quality = 12; // 10=best quality but slower, 12=high quality + fast, 15=fastest
  config.fb_count = 2;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_SVGA; // 800x600 -> 22-25 fps
    // For 20fps with slightly higher res use FRAMESIZE_XGA (1024x768) ~18-22 fps
    // For max quality but low fps use FRAMESIZE_UXGA (1600x1200) ~6-10 fps
    config.jpeg_quality = 12;
    config.fb_count = 2;
    config.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size = FRAMESIZE_VGA; // 640x480 fallback - no PSRAM can't do SVGA at high fps
    config.jpeg_quality = 12;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed 0x%x\n", err);
    delay(1000);
    ESP.restart();
  }

  // Tuning for 20+ FPS
  sensor_t * s = esp_camera_sensor_get();
  if (s) {
    s->set_brightness(s, 0);
    s->set_contrast(s, 0);
    s->set_saturation(s, 0);
    s->set_framesize(s, FRAMESIZE_SVGA); // Stream at SVGA for speed
    // s->set_vflip(s, 1); // uncomment if image is upside down
    // s->set_hmirror(s, 1);
  }
  Serial.printf("Camera initialized: %s | PSRAM: %s | Target 20+ FPS\n", 
    psramFound() ? "SVGA 800x600 (25fps) + UXGA photo" : "VGA 640x480", psramFound() ? "YES" : "NO");
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  pinMode(LED_FLASH_PIN, OUTPUT);
  digitalWrite(LED_FLASH_PIN, LOW);

  initCamera();

  loadStaCreds();

  // Dual mode: AP + STA - remove hotspot switching need
  WiFi.mode(WIFI_AP_STA);
  
  // Always start AP as fallback
  WiFi.softAP(ssid, password, 1, 0, 4); // channel 1, max 4 clients
  IPAddress apIP = WiFi.softAPIP();
  Serial.println("=== WiFi Setup ===");
  Serial.print("Hotspot Created: ");
  Serial.println(ssid);
  Serial.print("AP IP: http://");
  Serial.println(apIP);
  Serial.print("AP Stream: http://");
  Serial.print(apIP);
  Serial.println("/stream");

  // Try STA connection if credentials available
  if (sta_ssid.length() > 0) {
    Serial.printf("Connecting to STA WiFi: '%s' ...\n", sta_ssid.c_str());
    WiFi.begin(sta_ssid.c_str(), sta_pass.c_str());
    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 20) {
      delay(500);
      Serial.print(".");
      tries++;
    }
    if (WiFi.status() == WL_CONNECTED) {
      sta_connected = true;
      sta_ip_cache = WiFi.localIP().toString();
      Serial.println("\n✅ STA Connected!");
      Serial.print("STA IP: http://");
      Serial.println(WiFi.localIP());
      Serial.print("STA Stream: http://");
      Serial.print(WiFi.localIP());
      Serial.println("/stream");
      Serial.print("mDNS: http://esp32cam.local/ (if mDNS supported)\n");
      // mDNS
      if (MDNS.begin("esp32cam")) {
        MDNS.addService("http", "tcp", 80);
        Serial.println("mDNS started: esp32cam.local");
      }
    } else {
      sta_connected = false;
      Serial.println("\n❌ STA Failed - staying on AP only");
      Serial.println("Configure via http://192.168.4.1/wifi while connected to ESP32-CAM_AP");
    }
  } else {
    Serial.println("No STA credentials - AP only mode");
    Serial.println("To remove hotspot switching: connect to ESP32-CAM_AP -> open http://192.168.4.1/wifi -> enter your home WiFi");
  }
  Serial.println("==================");

  server.on("/", handleRoot);
  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/capture", HTTP_OPTIONS, [](){ handleCors(); server.send(204,"text/plain",""); });
  server.on("/stream", HTTP_GET, handleStream);
  server.on("/stream", HTTP_OPTIONS, [](){ handleCors(); server.send(204,"text/plain",""); });
  server.on("/flash", handleFlash);
  server.on("/flash", HTTP_OPTIONS, [](){ handleCors(); server.send(204,"text/plain",""); });
  server.on("/res", handleResolution);
  server.on("/status", handleStatus);
  server.on("/status", HTTP_OPTIONS, [](){ handleCors(); server.send(204,"text/plain",""); });
  server.on("/wifi", HTTP_GET, handleWifiPage);
  server.on("/wifi", HTTP_OPTIONS, [](){ handleCors(); server.send(204,"text/plain",""); });
  server.on("/savewifi", HTTP_POST, handleSaveWifi);
  server.on("/savewifi", HTTP_OPTIONS, [](){ handleCors(); server.send(204,"text/plain",""); });
  server.on("/clearwifi", HTTP_GET, handleClearWifi);
  // CORS preflight catch-all
  server.onNotFound([](){
    if (server.method() == HTTP_OPTIONS) { handleCors(); server.send(204,"text/plain",""); return; }
    handleRoot();
  });

  server.begin();
  Serial.println("HTTP server started");
  if (sta_connected) {
    Serial.printf("✅ AUTO WEBSITE: Use STA IP http://%s/stream in website (same WiFi, no hotspot switching!)\n", WiFi.localIP().toString().c_str());
  }
}

void loop() {
  server.handleClient();
}
