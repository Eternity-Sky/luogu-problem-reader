const { handler } = require('./netlify/functions/luogu-proxy');

// 🎯 使用您提供的三个核心 Cookie 进行模拟
const uid = '1967459';
const client_id = '53c42c2472b62bfb69abff17aa068305'; // 模拟补全
const C3VK = '6ec152';

// 编码为 base64 模拟前端 backupCookies
const rawCookies = `_uid=${uid}; __client_id=${client_id}; C3VK=${C3VK}`;
const backupCookies = Buffer.from(rawCookies).toString('base64');

async function testSubmission() {
  console.log('🚀 开始模拟代理提交测试...');
  console.log('🍪 原始 Cookie:', rawCookies);

  // 1. 模拟登录状态检查请求
  const event = {
    httpMethod: 'POST',
    body: JSON.stringify({
      path: '/_lfe/config',
      method: 'GET',
      sessionId: `session_uid_${uid}`,
      backupCookies: backupCookies
    }),
    headers: {
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await handler(event);
    console.log('\n✅ 代理响应状态:', response.statusCode);
    
    const body = JSON.parse(response.body);
    if (body.currentUser) {
      console.log('✅ 洛谷成功识别身份:', body.currentUser.name, `(UID: ${body.currentUser.uid})`);
    } else {
      console.warn('⚠️ 洛谷未识别身份，请检查 Cookie 是否过期');
      console.log('响应内容片段:', response.body.substring(0, 300));
    }

    if (body._backupCookies) {
      console.log('🔄 代理成功返回 Cookie 备份，前端可以持久化存储。');
    }
  } catch (error) {
    console.error('❌ 测试过程中发生错误:', error);
  }
}

testSubmission();
