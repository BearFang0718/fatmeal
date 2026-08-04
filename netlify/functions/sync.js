// 减脂餐档案云端同步 API v2
// 使用 Netlify Function v2 ESM 格式 + context.blobStore（无需手动配置 Blobs）

// CORS 头
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

// 生成 6 位同步码（大写字母+数字，去除易混淆字符）
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 简单校验同步码格式
function validCode(c) {
  return typeof c === "string" && /^[A-Z2-9]{6}$/.test(c);
}

// 数据大小限制
const MAX_SIZE = 2 * 1024 * 1024;

export default async (req, context) => {
  // 处理 CORS 预检
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

  // 使用 Netlify 自动注入的 blobStore（不需要配置，自动可用）
  let store;
  try {
    store = context.blobStore.get("fatmeal-sync");
  } catch (e) {
    // 兼容旧方式：如果 context.blobStore 不可用，尝试 @netlify/blobs SDK
    try {
      const { getStore } = await import("@netlify/blobs");
      store = getStore("fatmeal-sync", {
        siteID: Netlify.env.get("NETLIFY_SITE_ID") || Netlify.env.get("SITE_ID") || "",
        token: Netlify.env.get("NETLIFY_TOKEN") || ""
      });
    } catch (e2) {
      return json(500, null, "Blobs 未配置: " + (e?.message || e2?.message || "unknown"));
    }
  }

  try {
    // 1. 创建同步码并上传档案
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

    // 2. 关联已有同步码（首次拉取）
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

    // 3. 推送更新（双向同步：以 updatedAt 较新者为准）
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

    // 4. 检查同步码是否存在
    if (action === "check") {
      const code = (body.code || "").toUpperCase().trim();
      if (!validCode(code)) return json(400, null, "同步码格式错误");
      const rec = await store.get(code, { type: "json" });
      return json(200, { exists: !!rec, updatedAt: rec ? rec.updatedAt : null }, rec ? "同步码有效" : "同步码不存在");
    }

    return json(400, null, "未知的 action: " + action);
  } catch (e) {
    console.error("sync error:", e);
    return json(500, null, "服务器错误: " + (e.message || e));
  }
};

// 配置 Function 运行时（Netlify v2）
export const config = {
  runtime: "nodejs20.x"
};
