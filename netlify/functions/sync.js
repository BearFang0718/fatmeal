// 减脂餐档案云端同步 API
// 基于 Netlify Blobs 键值存储，免费、无需第三方服务
const { getStore } = require("@netlify/blobs");

// CORS 头
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

function json(code, data, msg) {
  return {
    statusCode: code,
    headers: CORS,
    body: JSON.stringify({ ok: code < 400, code, msg, data })
  };
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

// 数据大小限制（Netlify Blobs 单值上限 10MB，这里保守 2MB）
const MAX_SIZE = 2 * 1024 * 1024;

exports.handler = async (event) => {
  // 处理 CORS 预检
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, null, "仅支持 POST 请求");
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, null, "请求体格式错误"); }

  const action = body.action;
  const store = getStore("fatmeal-sync");

  try {
    // 1. 创建同步码并上传档案
    if (action === "create") {
      const data = body.data;
      if (!data) return json(400, null, "缺少 data 字段");
      const payload = JSON.stringify(data);
      if (payload.length > MAX_SIZE) return json(413, null, "数据过大");

      // 重试避免同步码冲突
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

      // 客户端时间戳作为冲突解决依据（较新者胜出）
      const clientTime = body.clientTime || Date.now();
      if (rec.updatedAt && clientTime < rec.updatedAt - 5000) {
        // 云端比客户端新 5 秒以上，返回云端版本让客户端合并
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
