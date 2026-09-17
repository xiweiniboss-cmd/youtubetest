/**
 * 原管 OrigTube · Cloudflare Worker
 * 手机部署：粘贴到 dash.cloudflare.com → Workers → 编辑代码
 */
const INSTANCES = [
  "https://invidious.f5.si",
  "https://yt.chocolatemoo53.com",
  "https://invidious.tiekoetter.com",
];
const PIPED = [
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
];
const PLAYER_URL =
  "https://www.youtube.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w&prettyPrint=false";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ID_RE = /^[A-Za-z0-9_-]{11}$/;



function extractYoutubeId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (ID_RE.test(raw)) return raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    try {
      parsed = new URL(`https://${raw}`);
    } catch {
      return null;
    }
  }
  const host = parsed.hostname.replace(/^www\./i, "").replace(/^m\./i, "").toLowerCase();
  if (host === "youtu.be" || host === "youtube.googleapis.com") {
    const id = parsed.pathname.split("/").filter(Boolean)[0]?.slice(0, 11);
    return id && ID_RE.test(id) ? id : null;
  }
  const isYt =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com") ||
    host === "music.youtube.com";
  if (!isYt) return null;
  const v = parsed.searchParams.get("v");
  if (v && ID_RE.test(v.slice(0, 11))) return v.slice(0, 11);
  const parts = parsed.pathname.split("/").filter(Boolean);
  for (const key of ["shorts", "embed", "live", "v", "e"]) {
    const idx = parts.indexOf(key);
    if (idx >= 0 && parts[idx + 1] && ID_RE.test(parts[idx + 1].slice(0, 11))) {
      return parts[idx + 1].slice(0, 11);
    }
  }
  return null;
}

async function fetchText(url, timeoutMs = 18000) {
  const res = await fetch(url, {
    headers: { Accept: "*/*", "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { url: res.url, text: await res.text() };
}

function decodeXml(value) {
  return value
    .replaceAll("\u0026amp;", "&")
    .replaceAll("\u0026lt;", "<")
    .replaceAll("\u0026gt;", ">")
    .replaceAll("\u0026quot;", '"')
    .replaceAll("\u0026apos;", "'");
}

function parseDashUrls(xml, mpdUrl) {
  const map = new Map();
  const re = /<Representation id="(\d+)"[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/g;
  let match;
  while ((match = re.exec(xml))) {
    const itag = Number(match[1]);
    if (!itag || map.has(itag)) continue;
    try {
      map.set(itag, new URL(decodeXml(match[2]), mpdUrl).href);
    } catch {
      /* skip */
    }
  }
  return map;
}

function codecsOf(mime) {
  return String(mime || "").match(/codecs="([^"]+)"/)?.[1] ?? "";
}

function toFormat(f, url) {
  const mime = f.type || "";
  return {
    itag: Number(f.itag),
    url,
    mime,
    codecs: codecsOf(mime),
    qualityLabel: f.qualityLabel || f.quality || "",
    contentLength: Number(f.clen || f.contentLength || 0) || undefined,
    isAudio: mime.startsWith("audio/"),
    isVideo: mime.startsWith("video/"),
    height: f.qualityLabel ? Number.parseInt(f.qualityLabel, 10) || 0 : 0,
  };
}

async function resolveVideo(input) {
  const id = extractYoutubeId(input);
  if (!id) throw new Error("请粘贴有效的 YouTube / youtu.be 链接");
  let last = "镜像线路暂时不可用";
  for (const origin of INSTANCES) {
    try {
      const api = await fetchText(`${origin}/api/v1/videos/${encodeURIComponent(id)}`);
      if (api.text.trimStart().startsWith("<")) {
        last = "镜像被拦截";
        continue;
      }
      const json = JSON.parse(api.text);
      if (json.error) {
        last = json.error;
        continue;
      }
      if (!json.title) {
        last = "没有找到视频信息";
        continue;
      }
      if (json.liveNow && !json.lengthSeconds) throw new Error("直播进行中，无法下载");

      const dash = await fetchText(
        `${origin}/api/manifest/dash/id/${encodeURIComponent(id)}?local=true`,
      );
      const dashUrls =
        dash.text.includes("<MPD") || dash.text.includes("<mpd")
          ? parseDashUrls(dash.text, dash.url)
          : new Map();

      const all = [...(json.formatStreams || []), ...(json.adaptiveFormats || [])];
      const formats = [];
      for (const f of all) {
        const itag = Number(f.itag);
        if (!itag) continue;
        const url =
          dashUrls.get(itag) ||
          `${origin}/latest_version?id=${encodeURIComponent(id)}&itag=${itag}`;
        formats.push(toFormat(f, url));
      }

      const muxed = formats
        .filter((f) => f.isVideo && f.codecs.includes("avc1") && f.codecs.includes("mp4a"))
        .sort((a, b) => b.height - a.height)[0];
      const progressive = formats
        .filter((f) => (f.itag === 18 || f.itag === 22) && f.url)
        .sort((a, b) => b.itag - a.itag)[0];
      const audio =
        formats.find((f) => f.isAudio && f.codecs.includes("mp4a")) ||
        formats.find((f) => f.itag === 140) ||
        formats.find((f) => f.isAudio);

      const options = [];
      const video360 = muxed || progressive;
      if (video360) {
        options.push({
          id: "360",
          label: video360.height >= 480 ? `${video360.height}p 有声` : "360p 有声",
          note: "MP4 · 含音轨 · 推荐",
          ext: "mp4",
          recommended: true,
          approxBytes: video360.contentLength,
        });
      }
      if (audio) {
        options.push({
          id: "audio",
          label: "音频 M4A",
          note: "AAC · 适合听歌",
          ext: "m4a",
          approxBytes: audio.contentLength,
        });
      }
      if (!options.length) {
        last = "没有可下载的有声格式";
        continue;
      }

      return {
        info: {
          id,
          title: json.title,
          author: json.author || "",
          duration: Number(json.lengthSeconds || 0),
          views: Number(json.viewCount || 0),
          thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          formats: options,
        },
        sources: {
          "360": video360 || null,
          audio: audio || null,
        },
      };
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  try {
    return await resolveFromInnertube(id);
  } catch (error) {
    last = error instanceof Error ? error.message : last;
  }
  try {
    return await resolveFromOembed(id);
  } catch (error) {
    last = error instanceof Error ? error.message : last;
  }
  throw new Error("解析没有成功，请过几分钟再试");
}

function latestVersionUrl(id, itag) {
  return `https://invidious.f5.si/latest_version?id=${encodeURIComponent(id)}&itag=${itag}`;
}

async function resolveFromOembed(id) {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}&format=json`,
    { signal: AbortSignal.timeout(12000) },
  );
  if (!res.ok) throw new Error("没有找到这个视频");
  const meta = await res.json();
  if (!meta || !meta.title) throw new Error("没有找到这个视频");
  return {
    info: {
      id,
      title: meta.title,
      author: meta.author_name || "",
      duration: 0,
      views: 0,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      formats: [
        {
          id: "360",
          label: "360p 有声",
          note: "MP4 · 含音轨 · 推荐",
          ext: "mp4",
          recommended: true,
        },
        { id: "audio", label: "音频 M4A", note: "AAC · 适合听歌", ext: "m4a" },
      ],
    },
    sources: {
      "360": { url: latestVersionUrl(id, 18), itag: 18 },
      audio: { url: latestVersionUrl(id, 140), itag: 140 },
    },
  };
}

async function resolveFromInnertube(id) {
  const clients = [
    {
      clientName: "ANDROID",
      clientVersion: "21.26.364",
      androidSdkVersion: 30,
      osName: "Android",
      osVersion: "11",
      userAgent: "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
    },
    {
      clientName: "IOS",
      clientVersion: "21.26.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      userAgent: "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    },
  ];
  let last = "油管解析失败";
  for (const client of clients) {
    const res = await fetch(PLAYER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": client.userAgent || UA },
      body: JSON.stringify({
        context: { client: { hl: "zh-CN", gl: "US", ...client } },
        videoId: id,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      last = `油管接口返回 ${res.status}`;
      continue;
    }
    const json = await res.json();
    const status = json.playabilityStatus?.status;
    const reason = json.playabilityStatus?.reason || "";
    if (status !== "OK" || !json.streamingData) {
      last = reason || status || "油管解析失败";
      continue;
    }
    const details = json.videoDetails || {};
    const raw = [...(json.streamingData.formats || []), ...(json.streamingData.adaptiveFormats || [])];
    const formats = raw
      .filter((f) => f.itag && f.url)
      .map((f) =>
        toFormat(
          {
            itag: f.itag,
            type: f.mimeType,
            qualityLabel: f.qualityLabel,
            clen: f.contentLength,
          },
          f.url,
        ),
      );
    const muxed = formats
      .filter((f) => f.isVideo && f.codecs.includes("avc1") && f.codecs.includes("mp4a"))
      .sort((a, b) => b.height - a.height)[0];
    const progressive = formats.find((f) => f.itag === 18 || f.itag === 22);
    const audio = formats.find((f) => f.isAudio && f.codecs.includes("mp4a")) || formats.find((f) => f.isAudio);
    const video360 = muxed || progressive;
    const options = [];
    if (video360) {
      options.push({
        id: "360",
        label: "360p 有声",
        note: "MP4 · 含音轨 · 推荐",
        ext: "mp4",
        recommended: true,
        approxBytes: video360.contentLength,
      });
    }
    if (audio) {
      options.push({
        id: "audio",
        label: "音频 M4A",
        note: "AAC · 适合听歌",
        ext: "m4a",
        approxBytes: audio.contentLength,
      });
    }
    if (!options.length) {
      last = "没有可下载的有声格式";
      continue;
    }
    return {
      info: {
        id,
        title: details.title,
        author: details.author || "",
        duration: Number(details.lengthSeconds || 0),
        views: Number(details.viewCount || 0),
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        formats: options,
      },
      sources: { "360": video360 || null, audio: audio || null },
    };
  }
  throw new Error(last);
}

function safeFilename(title, ext) {
  const cleaned = String(title || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  return `${(ascii || cleaned || "youtube").slice(0, 72)}.${ext}`;
}


const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>原管 OrigTube</title>
  <meta name="theme-color" content="#F3EEE4" />
  <!-- OrigTube export 2026-09-17-2 -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600&family=Noto+Serif+SC:wght@500;600&family=Outfit:wght@400;500;600&display=swap" />
  <style>
    :root {
      --bg:#f3eee4; --surface:#fffbf4; --inset:#ebe4d6; --ink:#1a1612;
      --muted:#6e675c; --subtle:#8a8276; --accent:#c44536; --accent-fg:#fffbf4;
      --border:color-mix(in oklab, var(--ink) 12%, transparent);
      --font-display:"Fraunces","Noto Serif SC",serif;
      --font-sans:"Outfit","Noto Sans SC","PingFang SC",system-ui,sans-serif;
      --font-mono:"IBM Plex Mono",ui-monospace,monospace;
    }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--font-sans); line-height:1.5; }
    button,a { cursor:pointer; } button { font-family:inherit; }
    h1,h2 { font-family:var(--font-display); font-weight:500; }
    a { color:inherit; text-decoration:none; }
    .wrap { width:min(768px,100%); margin:0 auto; min-height:100dvh; padding:24px 20px 64px; display:flex; flex-direction:column; }
    header.top { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    .brand { display:flex; align-items:center; gap:10px; }
    .brand p { margin:0; line-height:1.15; }
    .ghost { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:0 14px; border-radius:8px; border:1px solid var(--border); background:var(--surface); font-size:14px; font-weight:500; }
    .kicker { margin:40px 0 0; font-size:12px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }
    h1.hero { margin:12px 0 0; font-size:clamp(2rem,6vw,2.6rem); max-width:16ch; }
    .lead { margin:16px 0 0; color:var(--muted); }
    .panel { margin-top:32px; padding:12px; border:1px solid var(--border); background:var(--surface); border-radius:16px; }
    .row { display:flex; flex-direction:column; gap:12px; }
    .field { position:relative; }
    input,textarea { width:100%; border:0; background:var(--inset); color:var(--ink); border-radius:8px; min-height:48px; padding:12px 44px 12px 14px; font:16px/1.4 var(--font-sans); }
    textarea { min-height:96px; padding:12px; resize:none; }
    .actions { display:flex; gap:8px; }
    .actions .ghost,.actions .primary { flex:1; }
    .primary { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:44px; padding:0 16px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg); font-size:14px; font-weight:500; }
    .primary:disabled { opacity:.45; }
    .hint { margin:12px 4px 4px; font-size:12px; color:var(--subtle); }
    .err { margin:12px 4px 4px; font-size:14px; color:var(--accent); }
    .status { margin:12px 4px 4px; font-size:14px; }
    .card { margin-top:24px; overflow:hidden; border:1px solid var(--border); background:var(--surface); border-radius:16px; }
    .thumb { aspect-ratio:16/9; width:100%; object-fit:cover; background:var(--inset); display:block; }
    .meta { padding:20px; }
    .meta h2 { margin:0; font-size:20px; }
    .sub { margin:8px 0 0; color:var(--muted); font-size:14px; }
    .formats { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:16px; }
    .fmt { display:flex; flex-direction:column; align-items:flex-start; gap:4px; min-height:72px; padding:12px; border-radius:12px; border:1px solid var(--border); background:var(--bg); text-align:left; color:var(--ink); font:14px var(--font-sans); }
    .fmt span { font-size:12px; color:var(--muted); }
    .fmt.rec { border-color:var(--ink); background:var(--ink); color:var(--accent-fg); }
    .fmt.rec span { color:color-mix(in oklab, var(--accent-fg) 70%, transparent); }
    .step { display:grid; grid-template-columns:48px 1fr; gap:12px; padding:16px 0; border-top:1px solid var(--border); }
    .n { font-family:var(--font-mono); font-size:12px; color:var(--subtle); }
    footer.site { margin-top:auto; padding-top:24px; border-top:1px solid var(--border); font-size:12px; color:var(--subtle); }
    .about-card { margin-top:24px; padding:20px 24px; border:1px solid var(--border); background:var(--surface); border-radius:16px; }
    .about-card p { margin:12px 0 0; color:var(--muted); }
    .contact { margin-top:20px; padding-top:20px; border-top:1px solid var(--border); }
    .contact dt { font-size:12px; color:var(--subtle); }
    .contact dd { margin:6px 0 16px; }
    .contact a { text-decoration:underline; text-underline-offset:4px; }
    .overlay { position:fixed; inset:0; background:color-mix(in oklab, var(--ink) 40%, transparent); display:flex; align-items:flex-end; justify-content:center; padding:16px; z-index:30; }
    .sheet { width:min(512px,100%); background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:16px; }
    .clear { border:0; background:transparent; color:var(--muted); width:32px; height:32px; }
    @media (min-width:640px){ .row{flex-direction:row;align-items:center;} .actions{width:auto;} .actions .primary{flex:none;min-width:112px;} .overlay{align-items:center;} }
  </style>
</head>
<body>
<div class="wrap" id="app"></div>
<script>
(function(){
  var state = { view: location.hash==="#about"?"about":"home", url:"", info:null, loading:false, error:null, hint:null, pasteOpen:false };
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s).replace(/&/g,"\\u0026amp;").replace(/</g,"\\u0026lt;").replace(/>/g,"\\u0026gt;").replace(/"/g,"\\u0026quot;"); }
  function extractId(input){
    var raw=String(input||"").trim();
    if(/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    var u; try{ u=new URL(raw); }catch(e){ try{ u=new URL("https://"+raw);}catch(e2){ return null; } }
    var host=u.hostname.replace(/^www\\./i,"").replace(/^m\\./i,"").toLowerCase();
    if(host==="youtu.be"){ var id=(u.pathname.split("/").filter(Boolean)[0]||"").slice(0,11); return /^[A-Za-z0-9_-]{11}$/.test(id)?id:null; }
    if(host==="youtube.com"||host.endsWith(".youtube.com")){
      var v=u.searchParams.get("v"); if(v&&/^[A-Za-z0-9_-]{11}$/.test(v.slice(0,11))) return v.slice(0,11);
      var parts=u.pathname.split("/").filter(Boolean);
      for(var k of ["shorts","embed","live","v"]){ var i=parts.indexOf(k); if(i>=0&&parts[i+1]&&/^[A-Za-z0-9_-]{11}$/.test(parts[i+1].slice(0,11))) return parts[i+1].slice(0,11); }
    }
    return null;
  }
  function human(m){
    m=String(m||"");
    if(/load failed|failed to fetch|networkerror|abort/i.test(m)) return "解析没有成功，请再点一次";
    if(/bot|机器人|登录|sign in/i.test(m)) return "油管暂时限制了解析，请稍后再试";
    return m||"解析失败";
  }
  function bytes(n){ if(!n) return ""; if(n>=1e6) return (n/1e6).toFixed(1)+" MB"; if(n>=1e3) return Math.round(n/1e3)+" KB"; return n+" B"; }
  function dur(t){ if(!t) return ""; var m=Math.floor(t/60), s=t%60; return (t>=3600?Math.floor(t/3600)+":"+String(m%60).padStart(2,"0"):m)+":"+String(s).padStart(2,"0"); }
  function mark(){ return '<svg viewBox="0 0 32 32" width="32" height="32"><rect x="3.5" y="3.5" width="25" height="25" rx="4" fill="none" stroke="#1A1612" stroke-width="1.6"/><path d="M13.2 11.4v9.2L21.4 16 13.2 11.4Z" fill="#C44536"/></svg>'; }
  function header(){
    return '<header class="top"><a class="brand" href="#home" data-go="home">'+mark()+'<div><p style="font-family:var(--font-display);font-size:18px">原管</p><p style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)">OrigTube</p></div></a><a class="ghost" href="#about" data-go="about">关于本站</a></header>';
  }
  function render(){
    var root=$("app");
    if(state.view==="about"){
      root.innerHTML=header()+'<p class="kicker">About</p><h1 class="hero">关于本站</h1><p class="lead">使用须知、版权声明，以及侵权与问题反馈的联系方式。</p>'
        +'<section class="about-card"><p class="n">01</p><h2>声明</h2><p>本站仅为技术学习参考使用。请尊重原创作者版权。将本站用于非法用途的，本站不承认任何法律责任，后果自负。</p></section>'
        +'<section class="about-card"><p class="n">02</p><h2>联系</h2><p>如有侵权及问题反馈，请及时联系我们。</p><dl class="contact"><dt>电子邮箱</dt><dd><a href="mailto:jepgmf1@outlook.com">jepgmf1@outlook.com</a></dd><dt>X（推特）</dt><dd><a href="https://x.com/makekelegreat" target="_blank" rel="noreferrer">@makekelegreat</a></dd></dl></section>'
        +'<p style="margin-top:40px"><a href="#home" data-go="home" style="color:var(--accent);font-weight:500">返回下载</a></p>'
        +'<footer class="site"><p>OrigTube · 原管 · export 2026-09-17-2</p></footer>';
      bind(); return;
    }
    var result="";
    if(state.loading && !state.info) result='<div class="card"><div class="thumb"></div><div class="meta"><p class="sub">正在解析…</p></div></div>';
    if(state.info){
      var fmts=state.info.formats.map(function(f){
        return '<a class="fmt'+(f.recommended?" rec":"")+'" href="/api/download?v='+encodeURIComponent(state.info.id)+'&q='+encodeURIComponent(f.id)+'" download="origtube.'+esc(f.ext)+'"><b>'+esc(f.label)+(f.recommended?" · 推荐":"")+"</b><span>"+esc(f.note)+(f.approxBytes?" · "+bytes(f.approxBytes):"")+"</span></a>";
      }).join("");
      result='<article class="card">'+(state.info.thumbnail?'<img class="thumb" alt="" src="'+esc(state.info.thumbnail)+'" referrerpolicy="no-referrer"/>':"")
        +'<div class="meta"><h2>'+esc(state.info.title)+'</h2><p class="sub">'+esc([state.info.author,dur(state.info.duration)].filter(Boolean).join(" · "))+"</p>"
        +'<p class="sub">'+(ios?"点下方按钮后，在系统弹窗里选择「下载」":"点下方按钮开始下载无水印原片")+"</p>"
        +'<div class="formats">'+fmts+"</div></div></article>";
    }
    root.innerHTML=header()
      +'<p class="kicker">YouTube original</p><h1 class="hero">粘贴链接，下载油管原片</h1>'
      +'<p class="lead">'+(ios?"iPhone 点击下载后，系统会弹出确认框。点「下载」，视频进「文件」。":"支持 youtube.com / youtu.be / Shorts。")+"</p>"
      +'<div class="panel"><div class="row"><div class="field"><input id="yt-url" type="url" inputmode="url" enterkeyhint="go" autocomplete="off" placeholder="粘贴 youtube.com 或 youtu.be 分享链接" value="'+esc(state.url)+'"/>'
      +(state.url?'<button class="clear" type="button" id="clear-url" style="position:absolute;right:8px;top:8px">×</button>':"")
      +'</div><div class="actions"><button class="ghost" type="button" id="btn-paste">粘贴</button>'
      +'<button class="primary" type="button" id="btn-parse"'+(state.loading?" disabled":"")+">"+(state.loading?"解析中":"解析")+"</button></div></div>"
      +(state.error?'<p class="err">'+esc(state.error)+"</p>":state.hint?'<p class="status">'+esc(state.hint)+"</p>":'<p class="hint">iPhone 请点「粘贴」，再长按空白处选粘贴。点解析不会刷新页面。</p>')
      +"</div>"+result
      +'<section style="margin-top:48px"><h2>三步保存</h2><div class="step"><div class="n">01</div><div><b>复制分享链接</b><p class="sub">打开 YouTube，点分享，复制链接。</p></div></div><div class="step"><div class="n">02</div><div><b>在这里解析</b><p class="sub">粘贴后点解析，选带「有声」的画质。</p></div></div><div class="step"><div class="n">03</div><div><b>系统弹窗里点下载</b><p class="sub">iPhone 点「下载」，到「文件」里找。</p></div></div></section>'
      +'<footer class="site"><p>仅供保存你有权使用的内容。原管与 YouTube、Google 没有关联。</p><p>OrigTube · 原管 · export 2026-09-17-2</p></footer>'
      +(state.pasteOpen?'<div class="overlay" id="paste-mask"><div class="sheet"><h3>粘贴链接</h3><p class="sub">长按下面的框，选择「粘贴」。</p><textarea id="paste-area" placeholder="长按这里，点粘贴">'+esc(state.url)+'</textarea><div class="actions" style="margin-top:12px"><button class="ghost" type="button" id="paste-cancel">取消</button><button class="primary" type="button" id="paste-go">解析</button></div></div></div>':"");
    bind();
  }
  function bind(){
    document.querySelectorAll("[data-go]").forEach(function(n){ n.onclick=function(e){ e.preventDefault(); go(n.getAttribute("data-go")); }; });
    var input=$("yt-url");
    if(input){
      input.oninput=function(){ state.url=input.value; state.error=null; };
      input.onkeydown=function(e){ if(e.key==="Enter"){ e.preventDefault(); onParse(); } };
      input.onpaste=function(e){ var t=e.clipboardData&&e.clipboardData.getData("text"); if(t&&extractId(t)){ state.url=t.trim(); setTimeout(function(){ runParse(t); },0); } };
    }
    if($("btn-paste")) $("btn-paste").onclick=onPaste;
    if($("btn-parse")) $("btn-parse").onclick=function(e){ e.preventDefault(); onParse(); };
    if($("clear-url")) $("clear-url").onclick=function(){ state.url=""; state.info=null; state.error=null; render(); };
    if($("paste-mask")){
      $("paste-cancel").onclick=function(){ state.pasteOpen=false; render(); };
      var area=$("paste-area");
      area.oninput=function(){ state.url=area.value; };
      $("paste-go").onclick=function(){ state.pasteOpen=false; onParse(); };
      setTimeout(function(){ area.focus(); },40);
    }
  }
  function go(view){ state.view=view; location.hash=view==="about"?"about":"home"; render(); window.scrollTo(0,0); }
  function onPaste(){
    state.pasteOpen=true; state.hint="长按下方空白处，选「粘贴」"; render();
    if(navigator.clipboard&&navigator.clipboard.readText){
      navigator.clipboard.readText().then(function(t){ t=(t||"").trim(); if(!t) return; state.url=t; if(extractId(t)){ state.pasteOpen=false; runParse(t);} else { state.hint="已读到剪贴板，确认是油管链接后再解析"; render(); } }).catch(function(){});
    }
  }
  function onParse(){
    var input=$("yt-url"); if(input&&input.value.trim()) state.url=input.value.trim();
    if(state.url.trim()) runParse(state.url); else { state.pasteOpen=true; state.error="请先粘贴链接"; render(); }
  }
  function parseFetch(raw){
    return fetch("/api/parse?url="+encodeURIComponent(raw),{headers:{Accept:"application/json"}}).then(function(res){
      return res.json().then(function(data){
        if(!res.ok||!data||!data.id) throw new Error((data&&data.error)||"解析失败");
        return data;
      });
    });
  }
  function parseIframe(raw){
    return new Promise(function(resolve,reject){
      var frame=document.createElement("iframe");
      frame.style.cssText="position:absolute;width:0;height:0;border:0;visibility:hidden";
      var t=setTimeout(function(){ frame.remove(); reject(new Error("解析超时，请再点一次")); },45000);
      frame.onload=function(){
        clearTimeout(t);
        try{
          var text=(frame.contentDocument&&(frame.contentDocument.body.innerText||frame.contentDocument.documentElement.textContent))||"";
          var data=JSON.parse(text);
          frame.remove();
          if(!data||!data.id) throw new Error((data&&data.error)||"解析失败");
          resolve(data);
        }catch(e){ frame.remove(); reject(e); }
      };
      frame.onerror=function(){ clearTimeout(t); frame.remove(); reject(new Error("解析没有成功，请再点一次")); };
      document.body.appendChild(frame);
      frame.src="/api/parse?url="+encodeURIComponent(raw);
    });
  }
  function runParse(raw){
    raw=String(raw||"").trim();
    if(!extractId(raw)){ state.error="这不像 YouTube 链接。请复制分享按钮里的地址。"; render(); return; }
    state.loading=true; state.error=null; state.info=null; state.pasteOpen=false; state.url=raw; render();
    parseFetch(raw).catch(function(err){
      var m=err&&err.message||"";
      if(!/load failed|failed to fetch|networkerror/i.test(m)) throw err;
      return parseIframe(raw);
    }).then(function(info){ state.info=info; }).catch(function(err){ state.error=human(err&&err.message); }).then(function(){ state.loading=false; render(); });
  }
  window.addEventListener("hashchange", function(){ var n=location.hash==="#about"?"about":"home"; if(n!==state.view) go(n); });
  render();
})();
</script>
</body>
</html>
`;

const FETCH_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function handleParse(request) {
  const incoming = new URL(request.url);
  let url = incoming.searchParams.get("url") || incoming.searchParams.get("u") || "";
  if (!url && request.method !== "GET") {
    const body = await request.json().catch(() => null);
    if (body && typeof body.url === "string") url = body.url;
  }
  url = url.trim();
  if (!url) return Response.json({ error: "请粘贴 YouTube 链接" }, { status: 400 });
  try {
    const { info } = await resolveVideo(url);
    return Response.json(info, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "解析失败";
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

async function handleDownload(request) {
  const incoming = new URL(request.url);
  const videoId = incoming.searchParams.get("v") || "";
  const quality = incoming.searchParams.get("q") || "360";
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return new Response("无效的视频", { status: 400 });
  }
  try {
    const { info, sources } = await resolveVideo(videoId);
    const source = quality === "audio" ? sources.audio : sources["360"];
    if (!source?.url) return new Response("该清晰度暂不可用，请换 360p 有声", { status: 404 });
    const ext = quality === "audio" ? "m4a" : "mp4";
    const filename = safeFilename(info.title, ext);
    const utf8Name = `${info.title}.${ext}`;
    const itag = quality === "audio" ? 140 : 18;
    const mirrors = [
      source.url,
      latestVersionUrl(videoId, itag),
      `https://yt.chocolatemoo53.com/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}`,
    ].filter(Boolean);
    for (const mediaUrl of mirrors) {
      try {
        const upstream = await fetch(mediaUrl, {
          headers: { Accept: "*/*", "User-Agent": FETCH_UA, "Accept-Encoding": "identity" },
          redirect: "follow",
        });
        const type = (upstream.headers.get("content-type") || "").toLowerCase();
        if (!upstream.ok || !upstream.body || type.includes("text/html") || type.includes("json")) {
          continue;
        }
        const headers = new Headers();
        headers.set("Content-Type", "application/octet-stream");
        headers.set(
          "Content-Disposition",
          `attachment; filename="${filename.replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`,
        );
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        const len = upstream.headers.get("content-length");
        if (len) headers.set("Content-Length", len);
        return new Response(upstream.body, { status: 200, headers });
      } catch {
        /* try next */
      }
    }
    return Response.redirect(latestVersionUrl(videoId, itag), 302);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "下载失败", { status: 502 });
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/parse") return handleParse(request);
    if (url.pathname === "/api/download") return handleDownload(request);
    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};


