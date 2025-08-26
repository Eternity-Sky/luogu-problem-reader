const https = require('https');
const http = require('http');

// 全局Cookie存储（与luogu-proxy.js共享）
let globalCookies = {};

exports.handler = async (event, context) => {
    console.log('🚀 代码提交函数启动');

    // 设置CORS头部
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // 处理OPTIONS请求（预检请求）
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ''
        };
    }

    // 只允许POST请求
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: corsHeaders,
            body: JSON.stringify({ 
                success: false, 
                error: 'Method not allowed. Only POST is supported.' 
            })
        };
    }

    try {
        console.log('🚀 代码提交函数收到请求');
        
        // 解析请求体
        let requestData;
        try {
            requestData = JSON.parse(event.body || '{}');
        } catch (parseError) {
            console.error('❌ JSON解析失败:', parseError.message);
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ 
                    success: false, 
                    error: 'Invalid JSON in request body' 
                })
            };
        }

        const { problemId, code, language, sessionId, contestId } = requestData;

        // 验证必需参数
        if (!problemId || !code || !language) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ 
                    success: false, 
                    error: 'Missing required parameters: problemId, code, language' 
                })
            };
        }
        
        // 验证会话ID
        if (!sessionId) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ 
                    success: false, 
                    error: 'User not logged in. Session ID is required.' 
                })
            };
        }

        console.log('📝 提交参数:', {
            problemId,
            language,
            codeLength: code.length,
            sessionId: sessionId,
            contestId: contestId || 'none'
        });

        // 步骤1: 获取题目页面的CSRF令牌
        console.log('🔍 步骤1: 获取题目页面CSRF令牌...');
        const csrfToken = await getProblemCsrfToken(problemId, sessionId);
        
        if (!csrfToken) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ 
                    success: false, 
                    error: 'Failed to get CSRF token from problem page' 
                })
            };
        }

        // 步骤2: 提交代码到洛谷
        console.log('🚀 步骤2: 提交代码到洛谷...');
        const submitResult = await submitCodeToLuogu(problemId, code, language, csrfToken, sessionId, contestId);

        if (submitResult.success) {
            console.log('✅ 代码提交成功:', submitResult.data);
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    success: true,
                    data: {
                        rid: submitResult.data.rid,
                        problemId: problemId,
                        language: language,
                        submitTime: new Date().toISOString(),
                        recordUrl: `https://www.luogu.com.cn/record/${submitResult.data.rid}`
                    }
                })
            };
        } else {
            console.error('❌ 代码提交失败:', submitResult.error);
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ 
                    success: false, 
                    error: submitResult.error 
                })
            };
        }

    } catch (error) {
        console.error('❌ 代码提交函数异常:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ 
                success: false, 
                error: 'Internal server error: ' + error.message 
            })
        };
    }
};

// 获取题目页面的CSRF令牌
async function getProblemCsrfToken(problemId, sessionId) {
    try {
        console.log('🔍 获取题目页面CSRF令牌:', problemId, 'sessionId:', sessionId);
        
        // 确保题目ID为大写格式
        const upperProblemId = problemId.toUpperCase();
        
        const options = {
            hostname: 'www.luogu.com.cn',
            port: 443,
            path: `/problem/${upperProblemId}`,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'identity',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        };

        // 从全局Cookie存储中获取对应会话的Cookie
        if (globalCookies[sessionId]) {
            options.headers['Cookie'] = globalCookies[sessionId];
            console.log(`🍪 [${sessionId}] 使用保存的Cookie:`, globalCookies[sessionId]);
        } else {
            console.log(`❌ [${sessionId}] 没有找到保存的Cookie，当前所有会话:`, Object.keys(globalCookies));
        }

        const response = await makeRequest(`https://www.luogu.com.cn/problem/${upperProblemId}`, options);
        
        if (response.statusCode === 200) {
            const html = response.body;
            console.log('📄 题目页面HTML长度:', html.length);
            
            // 从HTML中提取CSRF令牌
            const csrfMatch = html.match(/window\._feInjection\s*=\s*JSON\.parse\("([^"]+)"\)/);
            if (csrfMatch) {
                try {
                    const feInjection = JSON.parse(csrfMatch[1].replace(/\\"/g, '"'));
                    const token = feInjection.csrfToken;
                    console.log('✅ 成功提取题目页面CSRF令牌:', token ? token.substring(0, 10) + '...' : 'null');
                    return token;
                } catch (e) {
                    console.error('❌ 解析feInjection失败:', e);
                }
            }
            
            // 备用方案：查找meta标签中的CSRF令牌
            const metaMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
            if (metaMatch) {
                console.log('✅ 从meta标签提取CSRF令牌:', metaMatch[1].substring(0, 10) + '...');
                return metaMatch[1];
            }
            
            console.warn('⚠️ 未找到CSRF令牌');
            return null;
        } else {
            console.error('❌ 获取题目页面失败:', response.statusCode);
            return null;
        }
    } catch (error) {
        console.error('❌ 获取题目页面CSRF令牌异常:', error);
        return null;
    }
}

// 提交代码到洛谷
async function submitCodeToLuogu(problemId, code, language, csrfToken, sessionId, contestId) {
    try {
        console.log('📤 提交代码到洛谷:', {
            problemId,
            language,
            codeLength: code.length,
            hasToken: !!csrfToken,
            contestId: contestId || 'none'
        });

        // 确保题目ID为大写格式
        const upperProblemId = problemId.toUpperCase();
        
        // 构建提交数据
        const submitData = {
            code: code,
            lang: language
        };

        // 如果有竞赛ID，添加到URL参数中
        let submitPath = `/fe/api/problem/submit/${upperProblemId}`;
        if (contestId) {
            submitPath += `?contestId=${contestId}`;
        }

        const postData = JSON.stringify(submitData);
        
        const options = {
            hostname: 'www.luogu.com.cn',
            port: 443,
            path: submitPath,
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'identity',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'x-csrf-token': csrfToken,
                'x-luogu-type': 'content-only',
                'Referer': `https://www.luogu.com.cn/problem/${upperProblemId}`,
                'Origin': 'https://www.luogu.com.cn',
                'Connection': 'keep-alive'
            }
        };

        // 从全局Cookie存储中获取对应会话的Cookie
        if (globalCookies[sessionId]) {
            options.headers['Cookie'] = globalCookies[sessionId];
            console.log(`🍪 [${sessionId}] 使用保存的Cookie进行提交:`, globalCookies[sessionId]);
        } else {
            console.log(`❌ [${sessionId}] 没有找到保存的Cookie，无法提交代码`);
            return { success: false, error: '用户未登录或会话已过期' };
        }

        const response = await makeRequest(`https://www.luogu.com.cn${submitPath}`, options, postData);
        
        console.log('📊 提交响应状态:', response.statusCode);
        
        if (response.statusCode === 200) {
            try {
                const result = JSON.parse(response.body);
                console.log('📊 提交响应数据:', result);
                
                if (result && result.rid) {
                    return {
                        success: true,
                        data: { rid: result.rid }
                    };
                } else {
                    return {
                        success: false,
                        error: '提交响应格式错误: ' + JSON.stringify(result)
                    };
                }
            } catch (parseError) {
                console.error('❌ 解析提交响应失败:', parseError);
                return {
                    success: false,
                    error: '提交响应解析失败: ' + parseError.message
                };
            }
        } else {
            let errorMsg = `提交失败 (${response.statusCode})`;
            try {
                const errorData = JSON.parse(response.body);
                if (errorData.error) {
                    errorMsg = errorData.error;
                }
            } catch (e) {
                // 忽略解析错误，使用默认错误消息
            }
            
            return {
                success: false,
                error: errorMsg
            };
        }
    } catch (error) {
        console.error('❌ 提交代码异常:', error);
        return {
            success: false,
            error: '提交代码异常: ' + error.message
        };
    }
}

// HTTP请求工具函数（重用luogu-proxy.js的逻辑）
function makeRequest(url, options, postData = null) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const req = protocol.request(url, options, (res) => {
            let body = '';
            let isBase64Encoded = false;
            
            // 检查内容类型
            const contentType = res.headers['content-type'] || '';
            if (contentType.includes('image/') || contentType.includes('application/octet-stream')) {
                isBase64Encoded = true;
                const chunks = [];
                res.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    body = buffer.toString('base64');
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: body,
                        isBase64Encoded: isBase64Encoded
                    });
                });
            } else {
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: body,
                        isBase64Encoded: isBase64Encoded
                    });
                });
            }
        });
        
        req.on('error', (error) => {
            console.error('❌ HTTP请求错误:', error);
            reject(error);
        });
        
        if (postData) {
            req.write(postData);
        }
        
        req.end();
    });
}
