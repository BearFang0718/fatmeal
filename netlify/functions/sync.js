// 减脂餐档案云端同步 API
// 使用 @netlify/blobs SDK（已在 package.json 中声明）
// 在 Netlify Functions 中调用 getStore(name) 无需手动传 siteID/token，Netlify 自动注入

import { getStore } from "@netlify/blobs";

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

  const action = body.action;
  let store;
  try {
    // 关键：在 Functions 中不传 siteID/token，Netlify 自动注入
    store = getStore("fatmeal-sync");
  } catch (e) {
    return json(500, null, "Blobs 初始化失败: " + (e?.message || "unknown"));
  }

  try {
    if (action === "create") {
      const data = body.data;
      if (!data) return json(400, null, "缺少 data 字段");
      const payload = JSON.stringify(data);
      if (payload.length > MAX_SIZE) return json(413, null, "数据过大");

      let code, tries = 0;
      do {
        code = genCode();
        tries++;
        const exist = await store.get(code);
        if (!exist) {
          await store.setJSON(code, {
            data,
            updatedAt: Date.now(),
            createdFrom: body.deviceTag || "unknown"
          });
          return json(200, { code }, "同步码已创建");
        }
      } while (tries < 5);
      return json(500, null, "生成同步码失败，请重试");
    }

    if (action === "pull") {
      const code = (body.code || "").toUpperCase().trim();
      if (!validCode(code)) return json(400, null, "同步码格式错误");
      const rec = await store.get(code, { type: "json" });
      if (!rec) return json(404, null, "同步码不存在，请检查");
      return json(200, {
        data: rec.data,
        updatedAt: rec.updatedAt,
        code
      }, "拉取成功");
    }

    if (action === "push") {
      const code = (body.code || "").toUpperCase().trim();
      if (!validCode(code)) return json(400, null, "同步码格式错误");
      const data = body.data;
      if (!data) return json(400, null, "缺少 data 字段");
      const payload = JSON.stringify(data);
      if (payload.length > MAX_SIZE) return json(413, null, "数据过大");

      const rec = await store.get(code, { type: "json" });
      if (!rec) return json(404, null, "同步码不存在，请先创建");

      const clientTime = body.clientTime || Date.now();
      if (rec.updatedAt && clientTime < rec.updatedAt - 5000) {
        return json(409, {
          data: rec.data,
          updatedAt: rec.updatedAt,
          serverNewer: true
        }, "云端有更新的数据，请合并");
      }

      await store.setJSON(code, {
        data,
        updatedAt: Date.now(),
        createdFrom: rec.createdFrom
      });
      return json(200, { updatedAt: Date.now() }, "推送成功");
    }

    if (action === "check") {
      const code = (body.code || "").toUpperCase().trim();
      if (!validCode(code)) return json(400, null, "同步码格式错误");
      const raw = await store.get(code);
      // 如果没取到直接返回不存在；否则尝试解析取 updatedAt
      if (!raw) return json(200, { exists: false, updatedAt: null }, "同步码不存在");
      let updatedAt = null;
      try {
        const rec = typeof raw === "string" ? JSON.parse(raw) : raw;
        updatedAt = rec?.updatedAt || null;
      } catch { /* ignore parse error */ }
      return json(200, { exists: true, updatedAt }, "同步码有效");
    }

    return json(400, null, "未知的 action: " + action);
  } catch (e) {
    console.error("sync error:", e);
    return json(500, null, "服务器错误: " + (e.message || e));
  }
};

export const config = {
  runtime: "nodejs20.x"
};
