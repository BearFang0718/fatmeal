// 减脂餐档案云端同步 API
// 使用 @netlify/blobs SDK，全部走 set/get 文本 + JSON.parse
// 避免 setJSON / get({type:"json"}) 导致的版本兼容问题
//
// 在 Netlify Functions 中 getStore("fatmeal-sync") 不传 siteID/token
// —— Netlify 会自动从运行时注入环境变量 NETLIFY_SITE_ID / NETLIFY_TOKEN

import { getStore, getDeployStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

function json(code, data, msg) {
  return new Response(JSON.stringify({ ok: code < 400, code, msg, data }), {
    status: code,
    headers: CORS
  });
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function validCode(c) {
  return typeof c === "string" && /^[A-Z2-9]{6}$/.test(c);
}

const MAX_SIZE = 2 * 1024 * 1024;
const STORE_NAME = "fatmeal-sync";

// 包装 Blobs 读写字节 → 纯文本（site-wide store）
async function blobGet(store, key) {
  try {
    const v = await store.get(key, { consistency: "strong" });
    // v 可能是 null / 字符串 / ArrayBuffer
    if (v == null) return null;
    if (typeof v === "string") return v;
    // ArrayBuffer / Uint8Array → utf8 解码
    if (typeof globalThis.TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(v);
    }
    return Buffer.from(v).toString("utf8");
  } catch (e) {
    console.error("[blobs get] error key=" + key + ":", e?.message || e);
    throw e;
  }
}

async function blobSet(store, key, value) {
  return await store.set(key, value);
}

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json(405, null, "仅支持 POST 请求");
  }

  let body;
  try { body = await req.json(); }
  catch { return json(400, null, "请求体格式错误"); }

  const action = body.action || "";
  console.log("[sync] action=" + action + " code=" + ((body.code || "").toUpperCase().trim().slice(0, 12)));

  // 站点级 store（跨 deploy 持久）
  let store;
  try {
    store = getStore(STORE_NAME);
    console.log("[sync] got site-wide store, name=" + STORE_NAME);
  } catch (e) {
    console.error("[sync] getStore failed:", e?.message || e);
    // 最后兜底：用 deploy store（仅同一 deploy 共享，至少保证当次部署可用）
    try {
      store = getDeployStore(STORE_NAME);
      console.log("[sync] fallback to getDeployStore");
    } catch (e2) {
      return json(500, null, "Blobs 初始化失败: " + (e?.message || e2?.message || "unknown"));
    }
  }

  try {
    // ========== 1. create: 生成同步码并写入 ==========
    if (action === "create") {
      const data = body.data;
      if (!data) return json(400, null, "缺少 data 字段");
      const serialized = JSON.stringify(data);
      if (serialized.length > MAX_SIZE) return json(413, null, "数据过大");

      let code, tries = 0;
      do {
        code = genCode();
        tries++;
        const existRaw = await blobGet(store, code);
        console.log("[create] try code=" + code + " exist?=" + (!!existRaw) + " (tries=" + tries + ")");
        if (!existRaw) {
          const wrapper = JSON.stringify({
            data,
            updatedAt: Date.now(),
            createdFrom: body.deviceTag || "unknown"
          });
          await blobSet(store, code, wrapper);
          // 写入后回读验证（关键，防止写入了 deploy store 但读不到）
          const verify = await blobGet(store, code);
          const ok = !!verify && verify.length === wrapper.length;
          console.log("[create] written len=" + wrapper.length + " verifyLen=" + (verify ? verify.length : "null") + " ok=" + ok);
          return json(200, { code, verified: ok }, "同步码已创建");
        }
      } while (tries < 5);
      return json(500, null, "生成同步码失败，请重试");
    }

    // ========== 2. pull: 通过同步码拉取 ==========
    if (action === "pull") {
      const code = (body.code || "").toUpperCase().trim();
      if (!validCode(code)) return json(400, null, "同步码格式错误");
      const raw = await blobGet(store, code);
      console.log("[pull] code=" + code + " rawLen=" + (raw ? raw.length : "null"));
      if (!raw) return json(404, null, "同步码不存在，请检查");
      let rec;
      try { rec = JSON.parse(raw); }
      catch (e) { return json(500, null, "云端数据损坏: " + (e?.message || e)); }
      return json(200, {
        data: rec.data,
        updatedAt: rec.updatedAt,
        code
      }, "拉取成功");
    }

    // ========== 3. push: 更新已有同步码 ==========
    if (action === "push") {
      const code = (body.code || "").toUpperCase().trim();
      if (!validCode(code)) return json(400, null, "同步码格式错误");
      const data = body.data;
      if (!data) return json(400, null, "缺少 data 字段");
      const serialized = JSON.stringify(data);
      if (serialized.length > MAX_SIZE) return json(413, null, "数据过大");

      const oldRaw = await blobGet(store, code);
      console.log("[push] code=" + code + " oldLen=" + (oldRaw ? oldRaw.length : "null"));
      if (!oldRaw) return json(404, null, "同步码不存在，请先创建");
      let oldRec;
      try { oldRec = JSON.parse(oldRaw); }
      catch { oldRec = {}; }

      const clientTime = body.clientTime || Date.now();
      if (oldRec.updatedAt && clientTime < oldRec.updatedAt - 5000) {
        return json(409, {
          data: oldRec.data,
          updatedAt: oldRec.updatedAt,
          serverNewer: true
        }, "云端有更新的数据，请合并");
      }

      const wrapper = JSON.stringify({
        data,
        updatedAt: Date.now(),
        createdFrom: oldRec.createdFrom || body.deviceTag || "unknown"
      });
      await blobSet(store, code, wrapper);
      const verify = await blobGet(store, code);
      console.log("[push] written len=" + wrapper.length + " verifyLen=" + (verify ? verify.length : "null"));
      return json(200, { updatedAt: Date.now(), verified: !!verify && verify.length === wrapper.length }, "推送成功");
    }

    // ========== 4. check: 检查同步码是否存在 ==========
    if (action === "check") {
      const code = (body.code || "").toUpperCase().trim();
      if (!validCode(code)) return json(400, null, "同步码格式错误");
      const raw = await blobGet(store, code);
      console.log("[check] code=" + code + " rawLen=" + (raw ? raw.length : "null"));
      if (!raw) return json(200, { exists: false, updatedAt: null }, "同步码不存在");
      let updatedAt = null;
      try {
        const rec = JSON.parse(raw);
        updatedAt = rec?.updatedAt || null;
      } catch { /* ignore */ }
      return json(200, { exists: true, updatedAt }, "同步码有效");
    }

    return json(400, null, "未知的 action: " + action);
  } catch (e) {
    console.error("[sync] unhandled error:", e?.stack || e);
    return json(500, null, "服务器错误: " + (e?.message || String(e)));
  }
};

export const config = {
  runtime: "nodejs20.x"
};
