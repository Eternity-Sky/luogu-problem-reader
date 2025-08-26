const https = require('https');
const http = require('http');

// 全局Cookie存储（在实际生产环境中应该使用数据库或缓存）
let globalCookies = {};

exports.handler = async (event, context) => {
    // 处理CORS预检请求
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    // 只允许POST请求
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        console.log('🔍 代理函数收到请求:');
        console.log('  - HTTP方法:', event.httpMethod);
        console.log('  - 请求体长度:', event.body ? event.body.length : 0);
        
        // 简化的JSON解析，增加错误处理
        let requestData;
        try {
            requestData = JSON.parse(event.body || '{}');
        } catch (parseError) {
            console.error('❌ JSON解析失败:', parseError.message);
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({ error: 'Invalid JSON in request body' })
            };
        }
        
        console.log('  - 解析后的请求数据:', JSON.stringify(requestData, null, 2));
        
        const { path, method = 'GET', body, csrfToken, headers: clientHeaders = {}, sessionId } = requestData;
        
        if (!path) {
            console.log('❌ 缺少path参数');
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({ error: 'Path is required' })
            };
        }
        
        console.log('✅ 请求参数验证通过:', { path, method, sessionId });

        // 构建完整URL
        const url = `https://www.luogu.com.cn${path}`;
        
        // 获取会话ID（使用客户端IP作为简单的会话标识）
        const clientSessionId = sessionId || event.headers['x-forwarded-for'] || 'default';
        
        // 设置请求头
        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity', // 禁用压缩
            'Connection': 'keep-alive',
            'Referer': 'https://www.luogu.com.cn/auth/login',
            'Origin': 'https://www.luogu.com.cn'
        };

        // 对于验证码请求，设置特定的Accept头
        if (path === '/lg4/captcha') {
            requestHeaders['Accept'] = 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
        }

        // 添加客户端传递的头部
        Object.assign(requestHeaders, clientHeaders);
        
        // 调试：输出最终的请求头
        console.log(`🔍 [${clientSessionId}] 最终请求头:`, JSON.stringify(requestHeaders, null, 2));

        // 🎯 巧妙的Cookie回传机制：优先使用前端传递的备份Cookie
        let cookieToUse = null;
        let cookieSource = '';
        
        // 1. 优先使用前端传递的备份Cookie（解决Netlify Functions重启问题）
        if (requestData.backupCookies) {
            try {
                const decryptedCookies = atob(requestData.backupCookies); // 解码base64
                cookieToUse = decryptedCookies;
                cookieSource = '前端备份';
                console.log(`🔄 [${clientSessionId}] 使用前端备份Cookie恢复会话`);
                
                // 同时更新内存中的Cookie（为后续请求准备）
                globalCookies[clientSessionId] = decryptedCookies;
            } catch (error) {
                console.log(`⚠️ [${clientSessionId}] 前端备份Cookie解码失败:`, error.message);
            }
        }
        
        // 2. 如果没有前端备份，尝试使用内存中的Cookie
        if (!cookieToUse && globalCookies[clientSessionId]) {
            cookieToUse = globalCookies[clientSessionId];
            cookieSource = '内存缓存';
        }
        
        // 3. 使用找到的Cookie
        if (cookieToUse) {
            requestHeaders['Cookie'] = cookieToUse;
            console.log(`🍪 [${clientSessionId}] 使用${cookieSource}Cookie:`, cookieToUse);
            
            // 特别针对代码提交请求，添加详细的Cookie调试信息
            if (path.includes('/fe/api/problem/submit/')) {
                console.log(`🔍 [${clientSessionId}] 代码提交请求Cookie详情:`);
                console.log(`  - Cookie来源: ${cookieSource}`);
                console.log(`  - Cookie长度: ${cookieToUse.length}`);
                console.log(`  - Cookie内容: ${cookieToUse}`);
                console.log(`  - 包含_uid: ${cookieToUse.includes('_uid')}`);
                console.log(`  - 包含__client_id: ${cookieToUse.includes('__client_id')}`);
                console.log(`  - CSRF Token: ${csrfToken ? csrfToken.substring(0, 10) + '...' : 'null'}`);
            }
        } else {
            console.log(`❌ [${clientSessionId}] 没有找到任何可用Cookie，当前所有会话:`, Object.keys(globalCookies));
            console.log(`❌ [${clientSessionId}] 全部Cookie内容:`, JSON.stringify(globalCookies, null, 2));
            
            // 特别检查是否存在相似的sessionId
            const similarSessions = Object.keys(globalCookies).filter(key => 
                key.startsWith('session_') && key !== clientSessionId
            );
            if (similarSessions.length > 0) {
                console.log(`🔍 [${clientSessionId}] 发现其他会话:`, similarSessions);
                console.log(`🔍 [${clientSessionId}] 最近的会话Cookie:`, globalCookies[similarSessions[0]]);
            }
            
            // 如果是代码提交请求且没有Cookie，直接返回错误
            if (path.includes('/fe/api/problem/submit/')) {
                console.log(`🚫 [${clientSessionId}] 代码提交请求但无有效Cookie，直接返回403错误`);
                return {
                    statusCode: 403,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type',
                        'Access-Control-Allow-Methods': 'POST, OPTIONS',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        errorType: "SessionExpired",
                        errorCode: 403,
                        status: 403,
                        data: "会话已过期，请重新登录",
                        errorMessage: "会话已过期，请重新登录。可能的原因：1) 登录会话已过期 2) Netlify Functions重启导致Cookie丢失 3) sessionId不匹配",
                        trace: "",
                        customData: {
                            sessionId: clientSessionId,
                            availableSessions: Object.keys(globalCookies),
                            suggestion: "请访问登录页面重新登录"
                        }
                    })
                };
            }
        }

        // 如果是POST请求，添加必要的头部
        if (method === 'POST') {
            requestHeaders['Content-Type'] = 'application/json';
            requestHeaders['Referer'] = 'https://www.luogu.com.cn/auth/login';
            
            if (csrfToken) {
                requestHeaders['x-csrf-token'] = csrfToken;
            }
        }

        // 发起请求到洛谷API
        const response = await makeRequest(url, {
            method: method,
            headers: requestHeaders,
            body: body ? JSON.stringify(body) : undefined
        });

        console.log('🔍 洛谷API详细响应信息:');
        console.log('  - 请求URL:', url);
        console.log('  - 请求方法:', method);
        console.log('  - 响应状态:', response.statusCode);
        console.log('  - 响应内容类型:', response.headers['content-type']);
        console.log('  - 响应内容长度:', response.body ? response.body.length : 0);
        console.log('  - 响应头:', JSON.stringify(response.headers, null, 2));
        
        // 如果是404错误，输出更多调试信息
        if (response.statusCode === 404) {
            console.log('❌ 洛谷API返回404错误:');
            console.log('  - 完整URL:', url);
            console.log('  - 请求头:', JSON.stringify(requestHeaders, null, 2));
            console.log('  - 响应体前500字符:', response.body ? response.body.substring(0, 500) : 'empty');
        }

        // 保存响应中的Cookie并实现Cookie回传机制
        if (response.headers['set-cookie']) {
            const cookies = response.headers['set-cookie'];
            const cookieString = cookies.map(cookie => cookie.split(';')[0]).join('; ');
            globalCookies[clientSessionId] = cookieString;
            console.log(`🍪 [${clientSessionId}] 保存Cookie:`, cookieString);
            
            // 🎯 巧妙机制：将Cookie编码后返回给前端备份
            const encodedCookies = btoa(cookieString); // base64编码
            console.log(`📦 [${clientSessionId}] Cookie已编码准备返回前端备份`);
            
            // 尝试解析响应体并添加Cookie备份（仅对JSON响应）
            try {
                if (response.headers['content-type'] && response.headers['content-type'].includes('application/json')) {
                    const responseData = JSON.parse(response.body);
                    responseData._backupCookies = encodedCookies;
                    response.body = JSON.stringify(responseData);
                    console.log(`✅ [${clientSessionId}] Cookie备份已添加到JSON响应`);
                }
            } catch (e) {
                // 如果不是JSON响应或解析失败，跳过Cookie备份添加
                console.log(`ℹ️ [${clientSessionId}] 非JSON响应，跳过Cookie备份添加`);
            }
        }

        // 🎯 特殊处理：如果是题目列表API，尝试从HTML中提取JSON数据
        if (path.includes('/problem/list') && response.statusCode === 200) {
            try {
                console.log(`🔍 [${clientSessionId}] 检测到题目列表API，尝试提取JSON数据`);
                
                // 查找 lentille-context script 标签中的JSON数据
                const scriptMatch = response.body.match(/<script id="lentille-context" type="application\/json">(.*?)<\/script>/s);
                if (scriptMatch) {
                    const jsonData = JSON.parse(scriptMatch[1]);
                    console.log(`✅ [${clientSessionId}] 成功从HTML中提取JSON数据`);
                    console.log(`📊 [${clientSessionId}] 题目数量:`, jsonData.data?.problems?.result?.length || 0);
                    
                    // 返回提取的JSON数据
                    return {
                        statusCode: 200,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Headers': 'Content-Type',
                            'Access-Control-Allow-Methods': 'POST, OPTIONS',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(jsonData)
                    };
                } else {
                    console.log(`❌ [${clientSessionId}] 未找到lentille-context数据`);
                }
            } catch (error) {
                console.log(`❌ [${clientSessionId}] JSON提取失败:`, error.message);
            }
        }

        // 🎯 特殊处理：如果是题目详情或题解API，也尝试提取JSON数据
        if ((path.includes('/problem/') && !path.includes('/problem/list')) && response.statusCode === 200) {
            try {
                console.log(`🔍 [${clientSessionId}] 检测到题目详情/题解API，尝试提取JSON数据`);
                
                const scriptMatch = response.body.match(/<script id="lentille-context" type="application\/json">(.*?)<\/script>/s);
                if (scriptMatch) {
                    const jsonData = JSON.parse(scriptMatch[1]);
                    console.log(`✅ [${clientSessionId}] 成功从HTML中提取JSON数据`);
                    
                    return {
                        statusCode: 200,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Headers': 'Content-Type',
                            'Access-Control-Allow-Methods': 'POST, OPTIONS',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(jsonData)
                    };
                }
            } catch (error) {
                console.log(`❌ [${clientSessionId}] JSON提取失败:`, error.message);
            }
        }

        // 返回原始响应
        return {
            statusCode: response.statusCode,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Content-Type': response.headers['content-type'] || 'text/html'
            },
            body: response.body,
            isBase64Encoded: response.isBase64Encoded || false
        };

    } catch (error) {
        console.error('代理请求失败:', error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ 
                error: 'Internal server error',
                message: error.message 
            })
        };
    }
};

// 辅助函数：发起HTTP请求
function makeRequest(url, options) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;
        
        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };

        const req = client.request(requestOptions, (res) => {
            let data = [];
            let isBase64 = false;

            // 检查是否是二进制内容（如图片）
            const contentType = res.headers['content-type'] || '';
            if (contentType.startsWith('image/')) {
                isBase64 = true;
            }

            res.on('data', (chunk) => {
                data.push(chunk);
            });

            res.on('end', () => {
                let body;
                const buffer = Buffer.concat(data);
                
                if (isBase64) {
                    body = buffer.toString('base64');
                } else {
                    // 处理压缩编码
                    const encoding = res.headers['content-encoding'];
                    const zlib = require('zlib');
                    
                    try {
                        if (encoding === 'gzip') {
                            body = zlib.gunzipSync(buffer).toString('utf8');
                        } else if (encoding === 'deflate') {
                            body = zlib.inflateSync(buffer).toString('utf8');
                        } else if (encoding === 'br') {
                            body = zlib.brotliDecompressSync(buffer).toString('utf8');
                        } else {
                            body = buffer.toString('utf8');
                        }
                    } catch (e) {
                        console.error('解压缩失败:', e.message, '编码:', encoding);
                        // 如果解压失败，尝试直接解码
                        body = buffer.toString('utf8');
                    }
                }

                console.log('响应状态码:', res.statusCode);
                console.log('响应头:', res.headers);
                console.log('内容编码:', res.headers['content-encoding']);
                console.log('响应体长度:', body.length);
                console.log('响应体前200字符:', body.substring(0, 200));

                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: body,
                    isBase64Encoded: isBase64
                });
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        // 如果有请求体，写入数据
        if (options.body) {
            req.write(options.body);
        }

        req.end();
    });
}
