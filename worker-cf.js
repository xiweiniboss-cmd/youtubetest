/**
 * YouTube 下载站 - 纯 Cloudflare Worker 版（无需任何后端服务器）
 *
 * 原理：
 *  1. Worker 直接调用 YouTube 官方 InnerTube 接口（安卓客户端），获取视频直链
 *  2. /api/file 把 googlevideo 的视频流转发给浏览器，并加上
 *     Content-Disposition: attachment → iOS Safari 弹出下载提示框
 *
 * 限制（Cloudflare 跑不了 yt-dlp/ffmpeg，所以）：
 *  - 视频最高 360p MP4（带声音）；音频为 M4A（无 MP3 转码）
 *  - 想要 1080p / MP3，请用自建后端版（见 ../README.md）
 *
 * 部署：
 *  1. python3 build_worker_cf.py            # 生成 worker-cf.js（含前端页面）
 *  2. npx wrangler deploy --config wrangler-cf.toml
 * 可选：在 Dashboard / wrangler 中设置变量 CLIENT_VERSION（安卓客户端版本，YouTube 更新时可能需要 bump）
 */

// 前端 HTML（index-cf.html）会被 build_worker_cf.py 内嵌到下面的 FRONTEND_HTML 常量中
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>YouTube 无水印视频下载 - 粘贴链接一键解析</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  :root{
    --bg:#0f1222; --card:#1a1f3a; --card2:#232a4d;
    --red:#ff3b5c; --red2:#ff6a3d;
    --text:#f2f4ff; --muted:#9aa3c7; --line:rgba(255,255,255,.08);
  }
  body{
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    background:radial-gradient(1200px 600px at 50% -10%, #232a5e 0%, var(--bg) 55%) fixed, var(--bg);
    color:var(--text); min-height:100vh; padding-bottom:40px;
  }
  .wrap{ max-width:560px; margin:0 auto; padding:0 16px; }
  header{ text-align:center; padding:34px 0 18px; }
  .logo{ font-size:44px; }
  h1{ font-size:22px; font-weight:800; letter-spacing:.5px; margin-top:6px; }
  h1 .hl{ background:linear-gradient(90deg,var(--red),var(--red2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .sub{ color:var(--muted); font-size:13px; margin-top:8px; }
  .badges{ display:flex; gap:8px; justify-content:center; margin-top:12px; flex-wrap:wrap; }
  .badge{ font-size:12px; color:#ffd9e0; background:rgba(255,59,92,.12); border:1px solid rgba(255,59,92,.3);
          padding:4px 12px; border-radius:20px; }
  .card{
    background:linear-gradient(180deg,var(--card2),var(--card));
    border:1px solid var(--line); border-radius:18px; padding:18px; margin-top:16px;
    box-shadow:0 12px 32px rgba(0,0,0,.35);
  }
  .input-row{ display:flex; gap:8px; }
  #url{
    flex:1; background:#10142b; border:1px solid var(--line); color:var(--text);
    border-radius:12px; padding:13px 14px; font-size:15px; outline:none; min-width:0;
  }
  #url:focus{ border-color:var(--red); }
  .btn-paste{
    background:#10142b; border:1px solid var(--line); color:var(--text);
    border-radius:12px; padding:0 16px; font-size:14px; white-space:nowrap;
  }
  .btn-paste:active{ background:#1c2247; }
  .btn-go{
    width:100%; margin-top:14px; padding:15px 0; border:none; border-radius:14px;
    background:linear-gradient(90deg,var(--red),var(--red2)); color:#fff;
    font-size:17px; font-weight:800; letter-spacing:2px; cursor:pointer;
    box-shadow:0 8px 24px rgba(255,59,92,.35);
  }
  .btn-go:active{ transform:scale(.98); }
  .btn-go:disabled{ opacity:.6; }
  .hint{ font-size:12px; color:var(--muted); margin-top:10px; line-height:1.7; }
  .cflimit{ font-size:12px; color:#ffd9a8; background:rgba(255,170,60,.08);
            border:1px solid rgba(255,170,60,.3); border-radius:12px; padding:10px 12px; margin-top:10px; line-height:1.7; }
  #status{ display:none; margin-top:14px; }
  .spin{ display:flex; align-items:center; gap:10px; font-size:14px; color:var(--muted); }
  .loader{ width:20px; height:20px; border:3px solid rgba(255,255,255,.15); border-top-color:var(--red);
           border-radius:50%; animation:sp 1s linear infinite; flex-shrink:0; }
  @keyframes sp{ to{ transform:rotate(360deg);} }
  .err{ background:rgba(255,59,92,.1); border:1px solid rgba(255,59,92,.4); color:#ffb3c1;
        padding:12px 14px; border-radius:12px; font-size:13px; line-height:1.6; }
  #result{ display:none; }
  .vmeta{ display:flex; gap:12px; }
  .vmeta img{ width:120px; height:68px; object-fit:cover; border-radius:10px; background:#000; flex-shrink:0; }
  .vtitle{ font-size:14px; font-weight:700; line-height:1.5; display:-webkit-box; -webkit-line-clamp:2;
           -webkit-box-orient:vertical; overflow:hidden; }
  .vsub{ font-size:12px; color:var(--muted); margin-top:6px; }
  .btn-dl{
    display:block; width:100%; margin-top:12px; padding:15px 0; border:none; border-radius:14px;
    background:linear-gradient(90deg,#1fbf6b,#2fd27d); color:#fff;
    font-size:16px; font-weight:800; letter-spacing:1px; cursor:pointer; text-align:center; text-decoration:none;
    box-shadow:0 8px 24px rgba(47,210,125,.3);
  }
  .btn-dl:active{ transform:scale(.98); }
  .btn-dl.audio{ background:linear-gradient(90deg,#3b82f6,#60a5fa); box-shadow:0 8px 24px rgba(59,130,246,.3); }
  .ios-tip{ display:none; font-size:12px; color:#9fe8c1; background:rgba(47,210,125,.08);
            border:1px solid rgba(47,210,125,.3); border-radius:12px; padding:10px 12px; margin-top:10px; line-height:1.7; }
  .steps{ margin-top:8px; }
  .step{ display:flex; gap:12px; padding:12px 2px; border-bottom:1px solid var(--line); align-items:flex-start; }
  .step:last-child{ border:none; }
  .num{ width:26px; height:26px; border-radius:50%; flex-shrink:0;
        background:linear-gradient(135deg,var(--red),var(--red2)); color:#fff;
        font-size:13px; font-weight:800; display:flex; align-items:center; justify-content:center; }
  .step b{ font-size:14px; display:block; margin-bottom:4px; }
  .step p{ font-size:12.5px; color:var(--muted); line-height:1.7; word-break:break-all; }
  .step code{ color:#ffd9e0; font-size:12px; }
  h2.sec{ font-size:16px; font-weight:800; margin:26px 0 4px; display:flex; align-items:center; gap:8px; }
  h2.sec::before{ content:""; width:4px; height:16px; border-radius:2px;
                  background:linear-gradient(180deg,var(--red),var(--red2)); }
  .feat{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px; }
  .feat div{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 12px; text-align:center; }
  .feat .e{ font-size:24px; }
  .feat b{ font-size:13px; display:block; margin:6px 0 4px; }
  .feat span{ font-size:11.5px; color:var(--muted); line-height:1.6; }
  .faq{ margin-top:8px; }
  .faq details{ background:var(--card); border:1px solid var(--line); border-radius:12px; margin-top:8px; padding:13px 14px; }
  .faq summary{ font-size:14px; font-weight:700; cursor:pointer; list-style:none; }
  .faq summary::-webkit-details-marker{ display:none; }
  .faq p{ font-size:12.5px; color:var(--muted); line-height:1.8; margin-top:8px; }
  footer{ text-align:center; color:var(--muted); font-size:11.5px; margin-top:28px; line-height:1.8; padding:0 20px; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="logo">📺</div>
    <h1>YouTube <span class="hl">无水印</span>视频下载</h1>
    <div class="sub">粘贴分享链接，一键解析下载 · 免服务器 · Cloudflare 驱动</div>
    <div class="badges">
      <span class="badge">🚫 无水印</span>
      <span class="badge">🎬 MP4</span>
      <span class="badge">🎵 M4A 音频</span>
      <span class="badge">🆓 免费</span>
    </div>
  </header>

  <div class="card">
    <div class="input-row">
      <input id="url" type="url" inputmode="url" placeholder="粘贴 YouTube 分享链接，如 https://youtu.be/…" autocomplete="off">
      <button class="btn-paste" id="paste">粘贴</button>
    </div>
    <button class="btn-go" id="go">开 始 解 析</button>
    <div class="hint">支持 watch / youtu.be 短链 / Shorts 短视频链接。YouTube 视频本身无水印，解析即得无水印文件。</div>
    <div class="cflimit">⚡ 纯 Cloudflare 版：无需自己的服务器。视频最高 360p（带声音），音频为 M4A 格式。如需 1080p / MP3，请用自建后端版。</div>

    <div id="status"></div>

    <div id="result">
      <div class="vmeta">
        <img id="thumb" alt="封面">
        <div>
          <div class="vtitle" id="vtitle"></div>
          <div class="vsub" id="vsub"></div>
        </div>
      </div>
      <div id="opts"></div>
      <div class="ios-tip" id="iostip">📱 iPhone 用户：点击下载后，Safari 会弹出下载提示框，点「下载」即可。文件保存在「文件」App → 「下载项」中。</div>
    </div>
  </div>

  <h2 class="sec">📖 使用教程</h2>
  <div class="card steps">
    <div class="step"><div class="num">1</div><div><b>复制视频链接</b><p>打开 YouTube App，点击视频下方的「分享」→「复制链接」；网页端直接复制地址栏网址。</p></div></div>
    <div class="step"><div class="num">2</div><div><b>粘贴到本站</b><p>点击上方「粘贴」按钮，或手动粘贴。支持 <code>youtube.com/watch?v=…</code>、<code>youtu.be/…</code>、<code>/shorts/…</code> 等格式。</p></div></div>
    <div class="step"><div class="num">3</div><div><b>开始解析</b><p>点击「开始解析」，稍等几秒即可看到视频信息。</p></div></div>
    <div class="step"><div class="num">4</div><div><b>下载保存</b><p>点击绿色「下载视频」或蓝色「下载音频」按钮。iPhone 会弹出下载提示框，点下载即可保存到手机。</p></div></div>
  </div>

  <h2 class="sec">✨ 为什么选本站</h2>
  <div class="feat">
    <div><div class="e">🚫</div><b>无水印</b><span>直接获取原视频文件，不带任何水印Logo</span></div>
    <div><div class="e">☁️</div><b>免服务器</b><span>全站跑在 Cloudflare 上，无需自己搭服务器</span></div>
    <div><div class="e">📱</div><b>手机友好</b><span>iOS / 安卓浏览器打开即用，下载有提示</span></div>
    <div><div class="e">🔒</div><b>无需注册</b><span>打开即用，不收集账号信息</span></div>
  </div>

  <h2 class="sec">❓ 常见问题</h2>
  <div class="faq">
    <details><summary>为什么最高只有 360p？</summary><p>纯 Cloudflare 版直接调用 YouTube 官方接口，只能拿到带声音的渐进式流（最高 360p）。如需 1080p/4K，请使用自建后端版（yt-dlp 解析）。</p></details>
    <details><summary>音频是 M4A 而不是 MP3？</summary><p>Cloudflare 上无法运行 ffmpeg 转码，所以直接提供 YouTube 原生 M4A 音频（约 128k）。iPhone / 安卓均可直接播放和保存。</p></details>
    <details><summary>iPhone 下载后文件在哪里？</summary><p>点击下载后 Safari 会弹出提示框，点「下载」。完成后点地址栏左侧的下载图标查看，或打开「文件」App → 「下载项」找到视频。</p></details>
    <details><summary>解析失败怎么办？</summary><p>常见原因：① 视频为私享/会员/年龄限制内容；② 链接复制不完整；③ YouTube 临时限制了请求，稍后重试即可。</p></details>
  </div>

  <footer>
    仅供个人学习与收藏使用，请勿传播受版权保护的内容。<br>
    下载即代表您会尊重原作者权益 · TubeFetch CF
  </footer>
</div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var urlEl=$('url'), goEl=$('go'), statusEl=$('status'), resultEl=$('result');

  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if(isIOS) $('iostip').style.display='block';

  $('paste').addEventListener('click', function(){
    if(navigator.clipboard && navigator.clipboard.readText){
      navigator.clipboard.readText().then(function(t){
        if(t) urlEl.value=t.trim();
      }).catch(function(){ urlEl.focus(); });
    } else { urlEl.focus(); }
  });

  function showStatus(html){ statusEl.style.display='block'; statusEl.innerHTML=html; }

  goEl.addEventListener('click', function(){
    var url=urlEl.value.trim();
    if(!url){ showStatus('<div class="err">请先粘贴 YouTube 视频链接</div>'); return; }
    resultEl.style.display='none';
    goEl.disabled=true; goEl.textContent='解析中…';
    showStatus('<div class="spin"><div class="loader"></div>正在解析视频信息…</div>');

    fetch('/api/parse',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({url:url})})
    .then(function(r){ return r.json(); })
    .then(function(d){
      goEl.disabled=false; goEl.textContent='开 始 解 析';
      if(!d.ok){ showStatus('<div class="err">⚠ '+esc(d.error||'解析失败')+'</div>'); return; }
      statusEl.style.display='none';
      $('thumb').src=d.thumbnail||'';
      $('vtitle').textContent=d.title;
      $('vsub').textContent=(d.uploader?d.uploader+' · ':'')+d.duration;
      var box=$('opts'); box.innerHTML='';
      d.options.forEach(function(o){
        var a=document.createElement('a');
        a.className='btn-dl'+(o.kind==='audio'?' audio':'');
        a.textContent=(o.kind==='audio'?'🎵 下载音频（':'⬇ 下载视频（')+o.label+'）';
        a.href=o.file;
        a.onclick=function(e){
          e.preventDefault();
          window.location.href=o.file; // 触发 iOS 下载提示框
        };
        box.appendChild(a);
      });
      resultEl.style.display='block';
    })
    .catch(function(){
      goEl.disabled=false; goEl.textContent='开 始 解 析';
      showStatus('<div class="err">⚠ 网络错误，无法连接服务器</div>');
    });
  });

  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
})();
</script>
</body>
</html>
`;

const YT_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // YouTube 公开接口 key
const DEFAULT_CLIENT_VERSION = "20.12.34";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function extractVideoId(url) {
  if (!url) return null;
  var m = url.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?[^#]*v=)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

function sanitize(name) {
  return (name || "youtube_video").replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "youtube_video";
}

function fmtDur(sec) {
  sec = parseInt(sec || 0, 10);
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return h > 0 ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
}

function b64urlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

function friendlyPlayability(ps) {
  var reason = ps.reason || "";
  if (ps.status === "LOGIN_REQUIRED") return "该视频需要登录 YouTube 才能观看，无法解析";
  if (/age/i.test(reason)) return "该视频有年龄限制，无法解析";
  if (/private/i.test(reason)) return "这是私享视频，无法解析";
  if (/copyright/i.test(reason)) return "该视频因版权原因无法播放";
  return "YouTube 拒绝了此次解析" + (reason ? "：" + reason.slice(0, 80) : "") + "，请稍后重试";
}

async function fetchPlayer(videoId, env) {
  var clientVersion = (env && env.CLIENT_VERSION) || DEFAULT_CLIENT_VERSION;
  var ua = "com.google.android.youtube/" + clientVersion + " (Linux; U; Android 11) gzip";
  var resp = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + YT_API_KEY + "&prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ua },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: clientVersion, androidSdkVersion: 30, userAgent: ua } },
      videoId: videoId,
    }),
  });
  if (!resp.ok) throw new Error("youtubei http " + resp.status);
  return resp.json();
}

function fileUrl(streamUrl, title, label, ext) {
  var name = sanitize(title + " " + label) + "." + ext;
  return "/api/file?u=" + b64urlEncode(streamUrl) + "&n=" + encodeURIComponent(name) + "&e=" + ext;
}

async function handleParse(request, env) {
  var data;
  try { data = await request.json(); } catch (e) { return json({ ok: false, error: "请求无效" }, 400); }
  var videoId = extractVideoId((data.url || "").trim());
  if (!videoId) return json({ ok: false, error: "仅支持 YouTube 链接（watch / youtu.be / shorts）" });

  var player;
  try {
    player = await fetchPlayer(videoId, env);
  } catch (e) {
    return json({ ok: false, error: "连接 YouTube 失败，请检查网络后重试" }, 502);
  }

  var ps = player.playabilityStatus || {};
  if (ps.status !== "OK") return json({ ok: false, error: friendlyPlayability(ps) });

  var vd = player.videoDetails || {};
  var sd = player.streamingData || {};
  var title = vd.title || "未知标题";

  // 渐进式 mp4（带音频）：优先 itag 22 (720p)，其次 18 (360p)
  var prog = (sd.formats || []).filter(function (f) { return f.url && (f.mimeType || "").indexOf("video/mp4") === 0; });
  prog.sort(function (a, b) { return (b.itag === 22) - (a.itag === 22); });
  var bestProg = prog[0] || null;

  // 音频：优先 itag 140 (m4a ~128k)
  var auds = (sd.adaptiveFormats || []).filter(function (f) { return f.url && (f.mimeType || "").indexOf("audio/mp4") === 0; });
  auds.sort(function (a, b) { return (b.itag === 140) - (a.itag === 140) || (b.bitrate || 0) - (a.bitrate || 0); });
  var bestAudio = auds[0] || null;

  var options = [];
  if (bestProg) {
    var vlabel = (bestProg.qualityLabel || "标清") + " MP4";
    options.push({ kind: "video", label: vlabel, file: fileUrl(bestProg.url, title, bestProg.qualityLabel || "video", "mp4") });
  }
  if (bestAudio) {
    options.push({ kind: "audio", label: "音频 M4A", file: fileUrl(bestAudio.url, title, "音频", "m4a") });
  }
  if (!options.length) return json({ ok: false, error: "未找到可下载的视频流" });

  return json({
    ok: true,
    title: title,
    thumbnail: "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg",
    duration: fmtDur(vd.lengthSeconds),
    uploader: vd.author || "",
    options: options,
  });
}

async function handleFile(url, request) {
  var u = url.searchParams.get("u") || "";
  var n = url.searchParams.get("n") || "video.mp4";
  var e = url.searchParams.get("e") || "mp4";
  var target;
  try {
    target = new URL(b64urlDecode(u));
  } catch (err) {
    return json({ ok: false, error: "下载链接无效，请重新解析" }, 400);
  }
  // 只允许转发 googlevideo（防开放代理被滥用）
  if (!/(^|\.)googlevideo\.com$/.test(target.hostname)) {
    return json({ ok: false, error: "非法下载地址" }, 403);
  }

  var headers = { "User-Agent": "com.google.android.youtube/" + DEFAULT_CLIENT_VERSION + " (Linux; U; Android 11) gzip" };
  var range = request.headers.get("Range");
  if (range) headers["Range"] = range;

  var resp;
  try {
    resp = await fetch(target.toString(), { headers: headers });
  } catch (err) {
    return json({ ok: false, error: "下载失败，请重新解析" }, 502);
  }
  if (resp.status !== 200 && resp.status !== 206) {
    return json({ ok: false, error: "下载地址已失效，请重新解析" }, 502);
  }

  // 关键：attachment 让 iOS Safari 弹出下载提示框，而不是内联播放
  var out = new Headers();
  out.set("Content-Type", e === "m4a" ? "audio/mp4" : "video/mp4");
  out.set("Content-Disposition", "attachment; filename=\"download." + e + "\"; filename*=UTF-8''" + encodeURIComponent(n));
  var cl = resp.headers.get("Content-Length");
  if (cl) out.set("Content-Length", cl);
  var cr = resp.headers.get("Content-Range");
  if (cr) out.set("Content-Range", cr);
  out.set("Accept-Ranges", "bytes");
  out.set("Cache-Control", "no-store");

  return new Response(resp.body, { status: resp.status, headers: out });
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    if (url.pathname === "/api/parse" && request.method === "POST") {
      return handleParse(request, env);
    }
    if (url.pathname === "/api/file" && request.method === "GET") {
      return handleFile(url, request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(FRONTEND_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
};
