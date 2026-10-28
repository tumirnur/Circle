/* «Мой день» — хранилище: Supabase (REST) + локальный кэш для офлайна.
   Отдаёт тот же интерфейс, что ждёт планер: window.claude.use("db"). */
(function () {
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} }
  };
  const COLS = ["tasks", "sleep", "debts", "config"];
  let cfg = LS.get("md:cfg", null);          // {url, key}
  let sess = LS.get("md:sess", null);        // {access_token, refresh_token, expires_at, email}
  const cache = {};                          // col -> {id: data}
  COLS.forEach(c => cache[c] = LS.get("md:c:" + c, {}));
  let queue = LS.get("md:q", {});            // "col/id" -> {op:"set"|"del", col, id, data}
  const subs = {};                           // col -> [fn]
  let status = "offline";

  /* ---------- HTTP ---------- */
  const base = () => cfg.url.replace(/\/+$/, "");
  async function authFetch(path, body) {
    const r = await fetch(base() + "/auth/v1/" + path, {
      method: "POST", headers: { apikey: cfg.key, "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.msg || j.message || ("Ошибка " + r.status));
    return j;
  }
  function keepSession(j, email) {
    sess = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, email: email || (j.user && j.user.email) || (sess && sess.email) };
    LS.set("md:sess", sess);
  }
  let refreshing = null;
  async function token() {
    if (!sess) throw new Error("no session");
    if (Date.now() < sess.expires_at - 60000) return sess.access_token;
    if (!refreshing) refreshing = authFetch("token?grant_type=refresh_token", { refresh_token: sess.refresh_token })
      .then(j => { keepSession(j); }).finally(() => { refreshing = null; });
    await refreshing; return sess.access_token;
  }
  async function rest(method, query, body, extra) {
    const t = await token();
    const r = await fetch(base() + "/rest/v1/docs" + query, {
      method, headers: Object.assign({ apikey: cfg.key, Authorization: "Bearer " + t, "Content-Type": "application/json" }, extra || {}),
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401) { throw Object.assign(new Error("auth"), { auth: true }); }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || ("Ошибка " + r.status)); }
    return r.status === 204 ? null : r.json().catch(() => null);
  }
  const upsert = rows => rest("POST", "?on_conflict=owner,col,id", rows, { Prefer: "resolution=merge-duplicates,return=minimal" });
  async function fetchCol(col) {
    const out = {}; let from = 0;
    for (;;) {
      const rows = await rest("GET", `?select=id,data&col=eq.${encodeURIComponent(col)}&order=id&limit=1000&offset=${from}`);
      rows.forEach(r => out[r.id] = r.data || {});
      if (rows.length < 1000) break; from += 1000;
    }
    return out;
  }

  /* ---------- cache + snapshots ---------- */
  function applyQueue(col, obj) {
    for (const k in queue) { const q = queue[k]; if (q.col !== col) continue; if (q.op === "del") delete obj[q.id]; else obj[q.id] = q.data; }
    return obj;
  }
  function emit(col) {
    LS.set("md:c:" + col, cache[col]);
    (subs[col] || []).forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  }
  function colSnap(col) {
    return { docs: Object.keys(cache[col]).map(id => ({ id, data: () => JSON.parse(JSON.stringify(cache[col][id])) })) };
  }
  function setStatus(s) { status = s; const el = document.getElementById("mdSync"); if (el) el.textContent = { ok: "Синхронизировано", sync: "Синхронизация…", offline: "Нет связи — изменения сохранятся и отправятся позже" }[s] || s; }

  let pulling = null;
  async function pull() {
    if (!sess || !navigator.onLine) { setStatus("offline"); return; }
    if (pulling) return pulling;
    pulling = (async () => {
      try {
        await flush();
        for (const col of COLS) {
          const fresh = applyQueue(col, await fetchCol(col));
          if (JSON.stringify(fresh) !== JSON.stringify(cache[col])) { cache[col] = fresh; emit(col); }
        }
        setStatus(Object.keys(queue).length ? "sync" : "ok");
      } catch (e) { if (e.auth) { logout(true); } else setStatus("offline"); }
      finally { pulling = null; }
    })();
    return pulling;
  }
  let flushing = false;
  async function flush() {
    if (flushing || !sess || !navigator.onLine) return;
    const keys = Object.keys(queue); if (!keys.length) return; const snap = Object.assign({}, queue);
    flushing = true; setStatus("sync");
    try {
      const sets = keys.filter(k => snap[k].op === "set").map(k => snap[k]);
      for (let i = 0; i < sets.length; i += 200) await upsert(sets.slice(i, i + 200).map(q => ({ col: q.col, id: q.id, data: q.data })));
      for (const k of keys.filter(k => snap[k].op === "del")) { const q = snap[k]; await rest("DELETE", `?col=eq.${encodeURIComponent(q.col)}&id=eq.${encodeURIComponent(q.id)}`); }
      for (const k of keys) if (queue[k] === snap[k]) delete queue[k];
      LS.set("md:q", queue); setStatus(Object.keys(queue).length ? "sync" : "ok");
    } catch (e) { setStatus("offline"); if (e.auth) logout(true); }
    finally { flushing = false; }
  }
  function write(col, id, data) {
    if (data === null) delete cache[col][id]; else cache[col][id] = data;
    queue[col + "/" + id] = data === null ? { op: "del", col, id } : { op: "set", col, id, data };
    LS.set("md:q", queue); emit(col);
    flush();
    return Promise.resolve();
  }
  const clean = o => JSON.parse(JSON.stringify(o));
  function docRef(col, id) {
    return {
      set: d => write(col, id, clean(d)),
      update: d => write(col, id, Object.assign({}, cache[col][id] || {}, clean(d))),
      delete: () => write(col, id, null),
      onSnapshot(fn) {
        const h = () => { const d = cache[col][id]; fn({ id, exists: !!d, data: () => clean(d || {}) }); };
        (subs[col] = subs[col] || []).push(h); h(); return () => { subs[col] = subs[col].filter(x => x !== h); };
      }
    };
  }
  const db = {
    collection(col) {
      if (!cache[col]) cache[col] = {};
      return {
        doc: id => docRef(col, id),
        onSnapshot(fn) { const h = () => fn(colSnap(col)); (subs[col] = subs[col] || []).push(h); h(); return () => { subs[col] = subs[col].filter(x => x !== h); }; }
      };
    },
    doc(path) { const [c, id] = path.split("/"); if (!cache[c]) cache[c] = {}; return docRef(c, id); }
  };

  /* ---------- import / export ---------- */
  function exportData() {
    const out = { format: "moy-den-v1", exported: new Date().toISOString(), collections: {} };
    COLS.forEach(c => out.collections[c] = cache[c]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: "application/json" }));
    a.download = "moy-den-" + new Date().toISOString().slice(0, 10) + ".json"; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function importData(file) {
    const j = JSON.parse(await file.text());
    const cols = j.collections || j; let n = 0, del = 0;
    for (const c of Object.keys(cols)) {
      if (!COLS.includes(c)) continue;
      for (const [id, d] of Object.entries(cols[c] || {})) {
        if (d === null) { delete cache[c][id]; queue[c + "/" + id] = { op: "del", col: c, id }; del++; }
        else { cache[c][id] = d; queue[c + "/" + id] = { op: "set", col: c, id, data: d }; n++; }
      }
      emit(c);
    }
    LS.set("md:q", queue); await flush();
    return { n, del };
  }

  /* ---------- login screen ---------- */
  function css() {
    const s = document.createElement("style");
    s.textContent = `#mdGate{position:fixed;inset:0;z-index:100;background:var(--bg,#F2F2F7);display:grid;place-items:center;padding:16px;overflow:auto}
#mdGate form{width:100%;max-width:400px;display:grid;gap:14px;background:var(--card,#fff);padding:24px;border-radius:18px;box-shadow:0 10px 40px rgba(0,0,0,.08)}
#mdGate h1{margin:0;font-size:26px}#mdGate p{margin:0;color:var(--dim,#6b6b70);font-size:14px;line-height:1.45}
#mdGate label{display:grid;gap:6px;font-size:13px;color:var(--dim,#6b6b70)}
#mdGate input{font:inherit;font-size:16px;border:1px solid var(--line,#ddd);background:var(--bg,#F2F2F7);color:var(--ink,#000);border-radius:12px;padding:12px 14px;width:100%;box-sizing:border-box}
#mdGate .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
#mdGate button{font:inherit;font-weight:600;font-size:16px;border:0;border-radius:12px;height:46px;cursor:pointer;background:var(--fill,#e9e9ee);color:var(--ink,#000)}
#mdGate button.go{background:var(--accent,#131936);color:var(--on-accent,#fff)}
#mdGate .err{color:#FF3B30;font-size:14px;min-height:1em}
#mdGate details summary{cursor:pointer;font-size:14px;color:var(--dim,#6b6b70)}
.mdData{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.mdData .hint{flex-basis:100%;margin:0}`;
    document.head.appendChild(s);
  }
  function gate() {
    return new Promise(resolve => {
      const g = document.createElement("div"); g.id = "mdGate";
      const needCfg = !cfg;
      g.innerHTML = `<form autocomplete="on">
        <h1>Мой день</h1>
        <p>${needCfg ? "Первый запуск: вставь адрес и ключ своей базы Supabase (Settings → API), потом войди." : "Войди, чтобы увидеть свои дела."}</p>
        <details ${needCfg ? "open" : ""}><summary>База данных</summary>
          <div style="display:grid;gap:12px;margin-top:12px">
            <label>Project URL<input name="url" placeholder="https://xxxx.supabase.co" value="${cfg ? cfg.url : ""}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
            <label>Ключ (anon public или publishable)<input name="key" placeholder="eyJ… или sb_publishable_…" value="${cfg ? cfg.key : ""}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
          </div></details>
        <label>Почта<input name="email" type="email" autocomplete="username" value="${sess && sess.email || ""}" required></label>
        <label>Пароль<input name="pw" type="password" autocomplete="current-password" minlength="6" required></label>
        <div class="err" id="mdErr"></div>
        <div class="row2"><button type="button" id="mdUp">Создать аккаунт</button><button class="go" type="submit">Войти</button></div>
      </form>`;
      document.body.appendChild(g);
      const f = g.querySelector("form"), err = g.querySelector("#mdErr");
      async function go(signup) {
        err.textContent = "";
        const url = f.url.value.trim(), key = f.key.value.trim();
        if (!/^https?:\/\/.+/.test(url) || key.length < 20) { err.textContent = "Заполни адрес и ключ базы"; g.querySelector("details").open = true; return; }
        cfg = { url, key }; LS.set("md:cfg", cfg);
        const email = f.email.value.trim(), password = f.pw.value;
        try {
          if (signup) {
            const j = await authFetch("signup", { email, password });
            if (!j.access_token) { err.textContent = "Аккаунт создан. Подтверди почту по ссылке из письма или отключи подтверждение в Supabase, потом нажми «Войти»."; return; }
            keepSession(j, email);
          } else keepSession(await authFetch("token?grant_type=password", { email, password }), email);
          // switching account: forget the other account's cache
          const who = LS.get("md:who", null);
          if (who && who !== email) { COLS.forEach(c => { cache[c] = {}; LS.del("md:c:" + c); }); queue = {}; LS.set("md:q", queue); }
          LS.set("md:who", email);
          g.remove(); resolve();
        } catch (e) { err.textContent = /Invalid login/i.test(e.message) ? "Неверная почта или пароль" : e.message === "Failed to fetch" ? "Не удаётся связаться с базой — проверь адрес и интернет" : e.message; }
      }
      f.addEventListener("submit", e => { e.preventDefault(); go(false); });
      g.querySelector("#mdUp").onclick = () => { if (f.reportValidity()) go(true); };
    });
  }
  function logout(expired) {
    LS.del("md:sess"); sess = null;
    if (expired) { location.reload(); return; }
    COLS.forEach(c => LS.del("md:c:" + c)); LS.del("md:q"); LS.del("md:who"); location.reload();
  }

  /* ---------- data panel in «Режим дня» ---------- */
  function panel() {
    const sheet = document.getElementById("setSheet"); if (!sheet) return;
    const box = document.createElement("div"); box.className = "field";
    box.innerHTML = `<span class="lbl">Данные</span><div class="mdData">
      <button class="btn" type="button" id="mdExp">Скачать копию</button>
      <button class="btn" type="button" id="mdImp">Загрузить файл</button>
      <button class="btn plain" type="button" id="mdOut">Выйти</button>
      <input type="file" id="mdFile" accept="application/json,.json" hidden>
      <p class="hint" id="mdSync"></p></div>`;
    sheet.appendChild(box);
    box.querySelector("#mdExp").onclick = exportData;
    box.querySelector("#mdImp").onclick = () => box.querySelector("#mdFile").click();
    box.querySelector("#mdFile").onchange = async e => {
      const file = e.target.files[0]; e.target.value = ""; if (!file) return;
      try { const r = await importData(file); alertish(`Загружено: ${r.n}${r.del ? ", удалено: " + r.del : ""}`); }
      catch (_) { alertish("Не получилось прочитать файл"); }
    };
    box.querySelector("#mdOut").onclick = () => { if (confirm("Выйти из аккаунта на этом устройстве?")) logout(false); };
    setStatus(status);
  }
  function alertish(t) { const el = document.getElementById("toast"); if (!el) return alert(t); el.textContent = t; el.hidden = false; clearTimeout(alertish.t); alertish.t = setTimeout(() => el.hidden = true, 2600); }

  /* ---------- boot ---------- */
  let ready = null;
  window.claude = {
    use(cap) {
      if (cap !== "db") return Promise.resolve(null);
      if (!ready) ready = (async () => {
        if (!cfg || !sess) await gate();
        pull();
        setInterval(() => { if (document.visibilityState === "visible") pull(); }, 45000);
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); });
        addEventListener("online", pull); addEventListener("focus", pull);
        return db;
      })();
      return ready;
    }
  };
  document.addEventListener("DOMContentLoaded", () => { css(); panel(); });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
