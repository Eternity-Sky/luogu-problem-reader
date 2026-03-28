const https = require("https");
const http = require("http");

// 全局Cookie存储（在实际生产环境中应该使用数据库或缓存）
let globalCookies = {};

exports.handler = async (event, context) => {
  // 处理CORS预检请求
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, x-luogu-type, x-csrf-token, x-lentille-request",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  // 只允许POST请求
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, x-luogu-type, x-csrf-token, x-lentille-request",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    console.log("🔍 代理函数收到请求:");
    console.log("  - HTTP方法:", event.httpMethod);
    console.log("  - 请求体长度:", event.body ? event.body.length : 0);

    // 简化的JSON解析，增加错误处理
    let requestData;
    try {
      requestData = JSON.parse(event.body || "{}");
    } catch (parseError) {
      console.error("❌ JSON解析失败:", parseError.message);
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Invalid JSON in request body" }),
      };
    }

    console.log("  - 解析后的请求数据:", JSON.stringify(requestData, null, 2));

    const {
      path,
      method = "GET",
      body,
      csrfToken,
      headers: clientHeaders = {},
      sessionId,
    } = requestData;

    if (!path) {
      console.log("❌ 缺少path参数");
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Path is required" }),
      };
    }

    console.log("✅ 请求参数验证通过:", { path, method, sessionId });

    // 构建完整URL
    const url = `https://www.luogu.com.cn${path}`;

    // 获取会话ID
    const clientSessionId =
      sessionId || event.headers["x-forwarded-for"] || "default";

    // 设置请求头
    const requestHeaders = {
      "User-Agent":
        clientHeaders["User-Agent"] ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "identity", // 禁用压缩
      Connection: "keep-alive",
      Referer: "https://www.luogu.com.cn/",
      Origin: "https://www.luogu.com.cn",
      "X-Requested-With": "XMLHttpRequest",
    };

    // 🎯 关键改进：如果 sessionId 是以 session_uid_ 开头的，尝试在全局缓存中寻找具有相同 uid 的其他会话
    if (clientSessionId.startsWith("session_uid_")) {
      const currentUid = clientSessionId.split("_")[2];
      if (!globalCookies[clientSessionId]) {
        const foundSession = Object.keys(globalCookies).find(
          (key) =>
            key.startsWith("session_uid_") && key.includes(`_${currentUid}`),
        );
        if (foundSession) {
          console.log(
            `🔍 [${clientSessionId}] 发现匹配的 uid 会话: ${foundSession}，同步 Cookie`,
          );
          globalCookies[clientSessionId] = globalCookies[foundSession];
        }
      }
    }

    // 对于验证码请求，设置特定的Accept头
    if (path === "/lg4/captcha") {
      requestHeaders["Accept"] =
        "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
    }

    // 添加客户端传递的头部
    Object.assign(requestHeaders, clientHeaders);

    // 检查是否为HTML请求
    const isHtmlRequest =
      (clientHeaders &&
        clientHeaders["Accept"] &&
        clientHeaders["Accept"].includes("text/html")) ||
      requestData.requestType === "html";

    if (isHtmlRequest) {
      // 移除API专用头部，请求HTML页面
      delete requestHeaders["x-lentille-request"];
      delete requestHeaders["X-Requested-With"];
      requestHeaders["Accept"] =
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
      console.log(`🌐 [${clientSessionId}] 请求HTML页面，移除API头部`);
    }

    // 调试：输出最终的请求头
    console.log(
      `🔍 [${clientSessionId}] 最终请求头:`,
      JSON.stringify(requestHeaders, null, 2),
    );

    // 🎯 巧妙的Cookie回传机制：优先使用前端传递的备份Cookie
    let cookieToUse = null;
    let cookieSource = "";

    // 特别处理智能重试会话
    if (clientSessionId === "smart_submit_session") {
      console.log(`🧠 [${clientSessionId}] 检测到智能重试会话`);
      console.log(
        `🔍 [${clientSessionId}] requestData.backupCookies存在:`,
        !!requestData.backupCookies,
      );
      if (requestData.backupCookies) {
        console.log(
          `🔍 [${clientSessionId}] backupCookies长度:`,
          requestData.backupCookies.length,
        );
      }
    }

    // 1. 优先使用前端传递的备份Cookie（解决Netlify Functions重启问题）
    if (requestData.backupCookies) {
      try {
        // 解码 base64 (考虑 UTF-8)
        const decodedCookies = decodeURIComponent(
          escape(atob(requestData.backupCookies)),
        );
        cookieToUse = decodedCookies;
        cookieSource = "前端备份";
        console.log(`🔄 [${clientSessionId}] 使用前端备份Cookie恢复会话`);

        // 同时更新内存中的Cookie（为后续请求准备）
        globalCookies[clientSessionId] = decodedCookies;
      } catch (error) {
        console.log(
          `⚠️ [${clientSessionId}] 前端备份Cookie解码失败:`,
          error.message,
        );
        // 如果 decodeURIComponent 失败，尝试原始 atob
        try {
          cookieToUse = atob(requestData.backupCookies);
          cookieSource = "前端备份(原始)";
        } catch (e) {}
      }
    }

    // 2. 如果没有前端备份，尝试使用内存中的Cookie
    if (!cookieToUse && globalCookies[clientSessionId]) {
      cookieToUse = globalCookies[clientSessionId];
      cookieSource = "内存缓存";
    }

    // 3. 使用找到的Cookie
    if (cookieToUse) {
      // 🎯 规范化 Cookie：映射 uid/client_id 并去重
      const cookieMap = cookieToUse.split("; ").reduce((acc, c) => {
        const parts = c.split("=");
        if (parts.length >= 2) {
          let key = parts[0].trim();
          const value = parts.slice(1).join("=").trim();

          // 自动映射不带下划线的 key
          if (key === "uid") key = "_uid";
          if (key === "client_id") key = "__client_id";

          if (key) acc[key] = value;
        }
        return acc;
      }, {});

      const sanitizedCookie = Object.entries(cookieMap)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");

      requestHeaders["Cookie"] = sanitizedCookie;
      console.log(
        `🍪 [${clientSessionId}] 使用${cookieSource}Cookie (已规范化):`,
        sanitizedCookie,
      );

      // 特别针对代码提交请求，添加详细的Cookie调试信息
      if (path.includes("/fe/api/problem/submit/")) {
        console.log(`🔍 [${clientSessionId}] 代码提交请求Cookie详情:`);
        console.log(`  - Cookie来源: ${cookieSource}`);
        console.log(`  - 包含_uid: ${!!cookieMap["_uid"]}`);
        console.log(`  - 包含__client_id: ${!!cookieMap["__client_id"]}`);
        console.log(
          `  - CSRF Token: ${csrfToken ? csrfToken.substring(0, 10) + "..." : "null"}`,
        );
      }
    } else {
      console.log(
        `❌ [${clientSessionId}] 没有找到任何可用Cookie，当前所有会话:`,
        Object.keys(globalCookies),
      );
      console.log(
        `❌ [${clientSessionId}] 全部Cookie内容:`,
        JSON.stringify(globalCookies, null, 2),
      );

      // 特别检查是否存在相似的sessionId
      const similarSessions = Object.keys(globalCookies).filter(
        (key) => key.startsWith("session_") && key !== clientSessionId,
      );
      if (similarSessions.length > 0) {
        console.log(`🔍 [${clientSessionId}] 发现其他会话:`, similarSessions);
        console.log(
          `🔍 [${clientSessionId}] 最近的会话Cookie:`,
          globalCookies[similarSessions[0]],
        );
      }

      // 如果是代码提交请求且没有Cookie，记录警告但继续处理
      if (path.includes("/fe/api/problem/submit/")) {
        console.log(
          `⚠️ [${clientSessionId}] 代码提交请求但无有效Cookie，继续处理让洛谷服务器决定`,
        );
      }
    }

    // 如果是POST请求，添加必要的头部
    if (method === "POST") {
      requestHeaders["Content-Type"] = "application/json";

      // 智能设置 Referer：如果是代码提交，使用题目详情页作为 Referer
      if (path.includes("/fe/api/problem/submit/")) {
        const pidMatch = path.match(/\/submit\/([A-Za-z0-9_]+)/);
        if (pidMatch) {
          requestHeaders["Referer"] =
            `https://www.luogu.com.cn/problem/${pidMatch[1]}`;
          console.log(
            `🎯 [${clientSessionId}] 代码提交请求，设置 Referer 为题目页`,
          );
        }
      } else {
        requestHeaders["Referer"] = "https://www.luogu.com.cn/auth/login";
      }

      if (csrfToken) {
        requestHeaders["x-csrf-token"] = csrfToken;
      }
    }

    // 发起请求到洛谷API
    const response = await makeRequest(url, {
      method: method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

    console.log("🔍 洛谷API详细响应信息:");
    console.log("  - 请求URL:", url);
    console.log("  - 请求方法:", method);
    console.log("  - 响应状态:", response.statusCode);
    console.log("  - 响应内容类型:", response.headers["content-type"]);
    console.log("  - 响应内容长度:", response.body ? response.body.length : 0);
    console.log("  - 响应头:", JSON.stringify(response.headers, null, 2));

    // 如果是404错误，输出更多调试信息
    if (response.statusCode === 404) {
      console.log("❌ 洛谷API返回404错误:");
      console.log("  - 完整URL:", url);
      console.log("  - 请求头:", JSON.stringify(requestHeaders, null, 2));
      console.log(
        "  - 响应体前500字符:",
        response.body ? response.body.substring(0, 500) : "empty",
      );
    }

    // 保存响应中的Cookie并实现Cookie回传机制
    let currentCookies = globalCookies[clientSessionId] || "";

    if (response.headers["set-cookie"]) {
      const cookies = response.headers["set-cookie"];
      const cookieString = cookies
        .map((cookie) => cookie.split(";")[0])
        .join("; ");

      // 合并新旧 Cookie
      if (currentCookies) {
        const oldCookies = currentCookies.split("; ").reduce((acc, c) => {
          const [k, v] = c.split("=");
          acc[k] = v;
          return acc;
        }, {});
        const newCookies = cookieString.split("; ").reduce((acc, c) => {
          const [k, v] = c.split("=");
          acc[k] = v;
          return acc;
        }, {});

        const merged = { ...oldCookies, ...newCookies };
        currentCookies = Object.entries(merged)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
      } else {
        currentCookies = cookieString;
      }

      globalCookies[clientSessionId] = currentCookies;
      console.log(`🍪 [${clientSessionId}] 更新并合并Cookie:`, currentCookies);
    }

    // 🎯 始终尝试回传当前会话的 Cookie 备份给前端
    if (currentCookies) {
      try {
        const encodedCookies = btoa(
          unescape(encodeURIComponent(currentCookies)),
        );

        const contentType = response.headers["content-type"] || "";
        if (contentType.includes("application/json")) {
          let responseData;
          try {
            responseData = JSON.parse(response.body);
          } catch (e) {
            const jsonMatch = response.body.match(/\{.*\}/s);
            if (jsonMatch) responseData = JSON.parse(jsonMatch[0]);
          }

          if (responseData && typeof responseData === "object") {
            responseData._backupCookies = encodedCookies;
            responseData._proxyInfo = {
              sessionId: clientSessionId,
              timestamp: new Date().toISOString(),
              cookieSource: cookieSource || "existing",
              hasUid: currentCookies.includes("_uid"),
            };
            response.body = JSON.stringify(responseData);
            console.log(
              `✅ [${clientSessionId}] 始终回传Cookie备份 (包含_uid: ${currentCookies.includes("_uid")})`,
            );
          }
        }
      } catch (e) {
        console.log(`ℹ️ [${clientSessionId}] 无法回传Cookie备份:`, e.message);
      }
    }

    // 🎯 特殊处理：如果是题目列表API，尝试从HTML中提取JSON数据
    if (path.includes("/problem/list") && response.statusCode === 200) {
      try {
        console.log(
          `🔍 [${clientSessionId}] 检测到题目列表API，尝试提取JSON数据`,
        );

        // 查找 lentille-context script 标签中的JSON数据
        const scriptMatch = response.body.match(
          /<script id="lentille-context" type="application\/json">(.*?)<\/script>/s,
        );
        if (scriptMatch) {
          const jsonData = JSON.parse(scriptMatch[1]);
          console.log(`✅ [${clientSessionId}] 成功从HTML中提取JSON数据`);
          console.log(
            `📊 [${clientSessionId}] 题目数量:`,
            jsonData.data?.problems?.result?.length || 0,
          );

          // 返回提取的JSON数据
          return {
            statusCode: 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(jsonData),
          };
        } else {
          console.log(`❌ [${clientSessionId}] 未找到lentille-context数据`);
        }
      } catch (error) {
        console.log(`❌ [${clientSessionId}] JSON提取失败:`, error.message);
      }
    }

    // 🎯 特殊处理：如果是题目详情或题解API，也尝试提取JSON数据
    // 但如果明确请求HTML，则返回原始HTML
    if (
      path.includes("/problem/") &&
      !path.includes("/problem/list") &&
      response.statusCode === 200 &&
      !isHtmlRequest
    ) {
      try {
        console.log(
          `🔍 [${clientSessionId}] 检测到题目详情/题解API，尝试提取JSON数据`,
        );

        const scriptMatch = response.body.match(
          /<script id="lentille-context" type="application\/json">(.*?)<\/script>/s,
        );
        if (scriptMatch) {
          const jsonData = JSON.parse(scriptMatch[1]);
          console.log(`✅ [${clientSessionId}] 成功从HTML中提取JSON数据`);

          return {
            statusCode: 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(jsonData),
          };
        }
      } catch (error) {
        console.log(`❌ [${clientSessionId}] JSON提取失败:`, error.message);
      }
    }

    // 如果是HTML请求，直接返回原始HTML内容
    if (isHtmlRequest && response.statusCode === 200) {
      console.log(
        `🌐 [${clientSessionId}] 返回原始HTML内容，长度: ${response.body ? response.body.length : 0}`,
      );
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: response.body }),
      };
    }

    // 返回原始响应
    return {
      statusCode: response.statusCode,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": response.headers["content-type"] || "text/html",
      },
      body: response.body,
      isBase64Encoded: response.isBase64Encoded || false,
    };
  } catch (error) {
    console.error("代理请求失败:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Internal server error",
        message: error.message,
      }),
    };
  }
};

// 辅助函数：发起HTTP请求
function makeRequest(url, options) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === "https:";
    const client = isHttps ? https : http;

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = client.request(requestOptions, (res) => {
      let data = [];
      let isBase64 = false;

      // 检查是否是二进制内容（如图片）
      const contentType = res.headers["content-type"] || "";
      if (contentType.startsWith("image/")) {
        isBase64 = true;
      }

      res.on("data", (chunk) => {
        data.push(chunk);
      });

      res.on("end", () => {
        let body;
        const buffer = Buffer.concat(data);

        if (isBase64) {
          body = buffer.toString("base64");
        } else {
          // 处理压缩编码
          const encoding = res.headers["content-encoding"];
          const zlib = require("zlib");

          try {
            if (encoding === "gzip") {
              body = zlib.gunzipSync(buffer).toString("utf8");
            } else if (encoding === "deflate") {
              body = zlib.inflateSync(buffer).toString("utf8");
            } else if (encoding === "br") {
              body = zlib.brotliDecompressSync(buffer).toString("utf8");
            } else {
              body = buffer.toString("utf8");
            }
          } catch (e) {
            console.error("解压缩失败:", e.message, "编码:", encoding);
            // 如果解压失败，尝试直接解码
            body = buffer.toString("utf8");
          }
        }

        console.log("响应状态码:", res.statusCode);
        console.log("响应头:", res.headers);
        console.log("内容编码:", res.headers["content-encoding"]);
        console.log("响应体长度:", body.length);
        console.log("响应体前200字符:", body.substring(0, 200));

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body,
          isBase64Encoded: isBase64,
        });
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    // 如果有请求体，写入数据
    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}
